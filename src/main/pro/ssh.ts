/**
 * The SSH roster: what the connect palette can reach, and how it knows.
 *
 * This service owns four reads and two writes, and nothing else:
 *
 * - read `~/.ssh/config` (the user's own aliases, parsed read-only),
 * - read `machines.json` (the machines pinned in the Bench - the only file we
 *   write, and we write it the same crash-proof way the task registry does),
 * - ask herdr for machines it already knows (best-effort, via an injected
 *   provider, because herdr's machine list is a separate subsystem),
 * - read the OS keychain (`SecretStoreLike`, injected - `secrets.ts` holds the
 *   policy and `main/keychain.ts` the Electron behind it) for the passwords
 *   those rows can carry, and write it when the edit form saves one,
 * - run a non-interactive `ssh` probe to answer "can I get in?" - once with a
 *   key, and a second time with a saved password when the first says the box
 *   wants one.
 *
 * Every rule about *what a machine is* and *what to type* lives in
 * `shared/ssh.ts`; this file is the impure edge - disk, child processes, the
 * platform - and it is built so a test can inject all three and never touch a
 * real `ssh` or a real `~/.ssh`.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  classifyProbe,
  dedupeMachines,
  expandHome,
  isMachine,
  baseName,
  joinFor,
  keygenLine,
  makeMachine,
  editMachine,
  filterHidden,
  machineKey,
  normalizeHidden,
  parseSshConfig,
  parseTarget,
  passwordProbeArgv,
  probeArgv,
  rankMachines,
  setupLines,
  sshLine,
  type MachineEdit,
  type MachineInput,
  type ProbeStatus,
  type HiddenMachine,
  type SshMachine
} from '../../shared/ssh'
import { Askpass } from './askpass'
import { runSsh, type ChildRunner, type SshRunResult } from './child'
import { proDir, readJson, writeJsonAtomic } from './env'

/** Pinned machines live beside the task registry; same ownership, same writer. */
export const machinesFile = path.join(proDir, 'machines.json')

const MACHINES_VERSION = 1

export interface MachinesFile {
  version: number
  updatedAt: number
  machines: SshMachine[]
  /**
   * Identities (`machineKey` strings) the human dismissed from the palette.
   * Only rows we do not own land here - a `~/.ssh/config` alias or a herdr
   * report - because there is nothing of ours to delete and rewriting their
   * file was never asked for. Restoring is one list away.
   */
  hidden?: string[]
}

/**
 * What `save` accepts: a roster row (a whole `SshMachine`), a partial one, or
 * just the string the human typed. Every field is optional because the sources
 * are meant to be merged, and "neither carried a host" is an answer the service
 * gives rather than a type error the caller has to prevent.
 */
export interface SaveMachineInput extends Partial<MachineInput> {
  target?: string
}

export interface ProbeResult {
  status: ProbeStatus
  /** A short human line for the palette tooltip; '' when there is nothing to add. */
  detail: string
}

/**
 * Where passwords live. Structural, so the store can be faked in a test and so
 * this service never has to know that Electron's `safeStorage` exists.
 */
export interface SecretStoreLike {
  /** False when this machine has no keychain, which the edit form has to say. */
  available(): boolean
  has(id: string): boolean
  get(id: string): string | null
  set(id: string, secret: string): boolean
  remove(id: string): boolean
}

/**
 * Runs an ssh child with a password available to it and to nothing else. The
 * real one is `Askpass` (`./askpass.ts`), which wires `SSH_ASKPASS`; a test
 * hands back a canned result and keeps the argv it was given.
 */
export interface PasswordRunner {
  run(
    argv: readonly string[],
    password: string,
    timeoutMs: number
  ): Promise<SshRunResult>
}

/** The store that holds nothing and can hold nothing: no keychain on this box. */
const NO_SECRETS: SecretStoreLike = {
  available: () => false,
  has: () => false,
  get: () => null,
  set: () => false,
  remove: () => false
}

/**
 * What a probe says when the second pass settled the question either way. The
 * refused line leads the detail rather than replacing ssh's own, because
 * "Permission denied" reads as a key problem to somebody who just stored a
 * password - and the key is what pass 1 was already about.
 */
export const PASSWORD_ACCEPTED_DETAIL = 'saved password accepted'
export const PASSWORD_REFUSED_DETAIL = 'saved password refused'

export interface SshDeps {
  file?: string
  home?: string
  /** Defaults to `<home>/.ssh/config`. */
  sshConfigPath?: string
  platform?: 'posix' | 'windows'
  /** Injectable child runner; the real one is `execFile`. `env` is added to the parent's. */
  run?: (
    cmd: string,
    args: readonly string[],
    timeoutMs: number,
    env?: Record<string, string>
  ) => Promise<SshRunResult>
  readFile?: (file: string) => string | null
  listDir?: (dir: string) => string[]
  read?: (file: string) => MachinesFile | null
  write?: (file: string, value: unknown) => boolean
  now?: () => number
  newId?: () => string
  /** herdr's own machines, mapped into our model. Defaults to none. */
  herdrMachines?: () => Promise<SshMachine[]>
  probeTimeoutMs?: number
  /** The keychain. Defaults to "none available", never to plaintext on disk. */
  secrets?: SecretStoreLike | null
  /** How a password reaches ssh. Defaults to the real askpass runner. */
  askpass?: PasswordRunner | null
}

const DEFAULT_PROBE_TIMEOUT = 8000

/** `m` + base36 time + 4 hex: sortable, file-safe, unique enough. Mirrors newTaskId. */
export function newMachineId(now = Date.now()): string {
  const rand = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0')
  return `m${now.toString(36)}${rand}`
}

export class SshService {
  private readonly file: string
  private readonly home: string
  private readonly sshConfigPath: string
  private readonly platform: 'posix' | 'windows'
  private readonly run: ChildRunner
  private readonly readFile: (file: string) => string | null
  private readonly listDir: (dir: string) => string[]
  private readonly read: (file: string) => MachinesFile | null
  private readonly write: (file: string, value: unknown) => boolean
  private readonly now: () => number
  private readonly newId: () => string
  private readonly herdrMachines: () => Promise<SshMachine[]>
  private readonly probeTimeoutMs: number
  private readonly secrets: SecretStoreLike
  private readonly askpass: PasswordRunner | null

  constructor(deps: SshDeps = {}) {
    this.file = deps.file ?? machinesFile
    this.home = deps.home ?? ''
    this.platform = deps.platform ?? 'posix'
    // After `platform`: the config path is joined with that platform's
    // separator, so reading it first would bake in the wrong one.
    this.sshConfigPath =
      deps.sshConfigPath ?? (this.home ? joinFor(this.platform, this.home, '.ssh', 'config') : '')
    this.run = deps.run ?? runSsh
    this.readFile =
      deps.readFile ??
      ((file) => {
        try {
          return fs.readFileSync(file, 'utf8')
        } catch {
          return null
        }
      })
    this.listDir =
      deps.listDir ??
      ((dir) => {
        try {
          return fs.readdirSync(dir)
        } catch {
          return []
        }
      })
    this.read = deps.read ?? ((file) => readJson<MachinesFile>(file))
    this.write =
      deps.write ??
      ((file, value) => {
        try {
          writeJsonAtomic(file, value)
          return true
        } catch {
          return false
        }
      })
    this.now = deps.now ?? (() => Date.now())
    this.newId = deps.newId ?? newMachineId
    this.herdrMachines = deps.herdrMachines ?? (() => Promise.resolve([]))
    this.probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT
    this.secrets = deps.secrets ?? NO_SECRETS
    // `undefined` means "pick the real one", an explicit `null` means "no
    // password support here" (a test, or a box with no keychain). The askpass
    // helper is only worth writing when there is a secret to hand it.
    this.askpass =
      deps.askpass !== undefined
        ? deps.askpass
        : this.secrets.available()
          ? new Askpass({ platform: this.platform })
          : null
  }

  /* ---------------------------------------------------------------- *
  * Roster
  * ---------------------------------------------------------------- */

  /** The pinned machines, exactly as stored. Never throws. */
  saved(): SshMachine[] {
    const raw = this.read(this.file)
    const list = Array.isArray(raw?.machines) ? raw.machines : []
    return list.filter(isMachine).map((machine) => ({ ...machine, source: 'saved' }))
  }

  /** Hosts parsed out of `~/.ssh/config`. Empty when there is no config. */
  config(): SshMachine[] {
    if (!this.sshConfigPath) return []
    const text = this.readFile(this.sshConfigPath)
    return text ? parseSshConfig(text) : []
  }

  /**
   * The config file this roster reads, so the palette can offer "open it"
   * instead of only offering to work around it. Empty when there is no home to
   * build a path from.
   */
  configFile(): string {
    return this.sshConfigPath
  }

  /** The home an empty `~` resolves against; '' when this service has none. */
  homeDir(): string {
    return this.home
  }
  /**
   * The merged, deduped, ranked roster the palette shows. `query` filters it the
   * way the palette's input does, so the renderer never re-implements ranking.
   */
  async roster(query = ''): Promise<SshMachine[]> {
    const herdr = await this.herdrMachines().catch(() => [] as SshMachine[])
    const merged = filterHidden(
      dedupeMachines([...this.saved(), ...this.config(), ...herdr]),
      this.hidden()
    )
    return rankMachines(merged.map((machine) => this.withPasswordMark(machine)), query)
  }

  /**
   * The keychain badge, computed on the way out rather than stored. Adding the
   * key only when it is true keeps a row without a password byte-identical to
   * the rows this service produced before passwords existed.
   */
  private withPasswordMark(machine: SshMachine): SshMachine {
    return this.secrets.has(machine.id) ? { ...machine, hasPassword: true } : machine
  }

  /** The dismissed identities, as stored. Never throws. */
  hidden(): string[] {
    return normalizeHidden(this.read(this.file)?.hidden ?? [])
  }

  /** Every hidden identity resolved back to a row, for the restore list. */
  async hiddenMachines(): Promise<HiddenMachine[]> {
    const keys = this.hidden()
    if (!keys.length) return []
    const herdr = await this.herdrMachines().catch(() => [] as SshMachine[])
    const wanted = new Set(keys.map((key) => key.toLowerCase()))
    const rows: HiddenMachine[] = []
    const seen = new Set<string>()
    for (const machine of [...this.config(), ...herdr]) {
      const key = machineKey(machine).toLowerCase()
      if (!wanted.has(key) || seen.has(key)) continue
      seen.add(key)
      rows.push({ key, machine, stale: false })
    }
    // An identity no source reports any more (the `Host` block was deleted, or
    // herdr stopped knowing the box) still has to be droppable, so it gets a
    // placeholder row rather than disappearing with no way back.
    for (const key of keys) {
      const lower = key.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      rows.push({
        key: lower,
        machine: makeMachine({ id: `hidden:${lower}`, host: lower, label: lower, source: 'config' }),
        stale: true
      })
    }
    return rows.sort((a, b) => a.machine.label.localeCompare(b.machine.label))
  }

  /* ---------------------------------------------------------------- *
  * Save / edit / remove / hide
  * ---------------------------------------------------------------- */

  /**
   * Pin a machine. Accepts either a free-form `target` (`user@host:port`) or an
   * explicit partial machine, merges them, assigns a durable id when the caller
   * did not bring one, and upserts by id. Returns the stored machine, or null
   * when there was nothing connectable to store.
   */
  save(input: SaveMachineInput): SshMachine | null {
    const fromTarget = input.target ? parseTarget(input.target) : null
    const host = String(input.host || fromTarget?.host || '').trim()
    if (!host) return null
    const machine = makeMachine({
      ...input,
      host,
      user: input.user || fromTarget?.user || '',
      port: input.port ?? fromTarget?.port ?? 0,
      source: 'saved'
    })
    const id = machine.id && /^m[A-Za-z0-9]+/.test(machine.id) ? machine.id : this.newId()
    const stored: SshMachine = { ...machine, id }
    const list = this.saved().filter((entry) => entry.id !== id)
    list.push(stored)
    // Pinning is an explicit decision made after any hide of the same box, so it
    // wins: leaving the key hidden would make the pin button look broken.
    const file: MachinesFile = {
      version: MACHINES_VERSION,
      updatedAt: this.now(),
      machines: list,
      hidden: this.hidden().filter((key) => key !== machineKey(stored).toLowerCase())
    }
    if (!this.write(this.file, file)) return null
    // A row that was not ours gets a fresh id when it is pinned, and a password
    // is keyed by id - so the secret follows the row. Without this, pinning a
    // `~/.ssh/config` alias would quietly cost the human the login they had
    // already saved for it, and would leave that secret in the keychain with no
    // row left able to name it.
    if (id !== machine.id) this.moveSecret(machine.id, id)
    return stored
  }

  /**
   * Edit a roster row, which for anything we do not own means *fork* it: the
   * stored copy is ours, the `~/.ssh/config` block stays exactly as it was.
   * The original identity is hidden when the fork is meant to replace it, so
   * the palette does not grow a second row for one box.
   */
  edit(machine: SshMachine, patch: MachineEdit): SshMachine | null {
    const next = editMachine(machine, patch)
    if (!next.host && !next.alias) return null
    const stored = this.save(next)
    if (!stored) return null
    const from = machineKey(machine).toLowerCase()
    const to = machineKey(stored).toLowerCase()
    if (machine.source !== 'saved' && from !== to) this.hide(machine)
    return stored
  }

  /** Unpin a machine. Config and herdr entries are not ours to remove. */
  remove(id: string): boolean {
    const list = this.saved()
    const next = list.filter((entry) => entry.id !== id)
    if (next.length === list.length) return false
    const file: MachinesFile = {
      version: MACHINES_VERSION,
      updatedAt: this.now(),
      machines: next,
      hidden: this.hidden()
    }
    if (!this.write(this.file, file)) return false
    // The row is gone, so the secret that only it could use is gone too. Left
    // behind it would sit in the keychain with nothing to name it, and a later
    // machine reusing the id would inherit somebody else's password.
    this.secrets.remove(id)
    return true
  }

  /**
   * Dismiss a row we do not own. Returns false when there was nothing to do -
   * an unknown machine, or one already hidden - so the caller can say "already
   * hidden" instead of pretending to have changed something.
   */
  hide(machine: SshMachine): boolean {
    if (machine.source === 'saved') return this.remove(machine.id)
    const key = machineKey(machine).toLowerCase()
    const hidden = this.hidden()
    if (hidden.includes(key)) return false
    return this.writeHidden([...hidden, key])
  }

  /** Bring a dismissed row back. `key` may be a `machineKey` or a machine id. */
  unhide(key: string): boolean {
    const wanted = String(key || '').trim().toLowerCase()
    if (!wanted) return false
    const hidden = this.hidden()
    const next = hidden.filter((entry) => entry !== wanted)
    if (next.length === hidden.length) return false
    return this.writeHidden(next)
  }

  /** The only writer of the hidden list, so machines are never dropped by it. */
  private writeHidden(hidden: readonly string[]): boolean {
    const file: MachinesFile = {
      version: MACHINES_VERSION,
      updatedAt: this.now(),
      machines: this.saved(),
      hidden: normalizeHidden(hidden)
    }
    return this.write(this.file, file)
  }

  /* ---------------------------------------------------------------- *
  * Passwords
  * ---------------------------------------------------------------- */

  /** Can this machine keep a secret at all? The edit form says so in words. */
  keychainAvailable(): boolean {
    return this.secrets.available()
  }

  /** Whether a password is stored for `id`. Never the password. */
  hasPassword(id: string): boolean {
    return this.secrets.has(String(id ?? '').trim())
  }

  /**
   * The plaintext, or null. Deliberately the only method here that returns
   * bytes, and it has exactly two callers: the probe's second pass, and typing
   * the answer into a prompt the human just opened.
   */
  passwordFor(id: string): string | null {
    return this.secrets.get(String(id ?? '').trim())
  }

  /**
   * Store or clear a password. Empty and `null` both mean *clear*, so the edit
   * form needs one verb: an emptied field empties the keychain. False when
   * nothing changed - no keychain on this box, or a write that failed.
   */
  setPassword(id: string, secret: string | null): boolean {
    const key = String(id ?? '').trim()
    if (!key) return false
    if (!secret) return this.secrets.remove(key)
    return this.secrets.set(key, secret)
  }

  /**
   * Follow a row's password to its new id, dropping the old entry. Called by
   * `save`, which is the only place an id is ever reassigned. Best-effort: a
   * keychain that will not take the copy leaves the original alone rather than
   * deleting a password it failed to move.
   */
  private moveSecret(from: string, to: string): void {
    const source = String(from ?? '').trim()
    const target = String(to ?? '').trim()
    if (!source || !target || source === target) return
    const secret = this.secrets.get(source)
    if (!secret) return
    if (this.secrets.set(target, secret)) this.secrets.remove(source)
  }

  /* ---------------------------------------------------------------- *
  * Probe
  * ---------------------------------------------------------------- */

  /**
   * Can we get in?
   *
   * Two passes, because the question has two parts and only the first is free:
   *
   * 1. the key probe (`probeArgv`, BatchMode) - the honest answer to "can I get
   *    in without asking anybody anything", and the only one that runs when
   *    there is no saved password;
   * 2. only when pass 1 concluded `auth` *and* we hold a password for this row,
   *    the password probe (`passwordProbeArgv` + askpass). Accepted is a second
   *    green - `password` - because the box is reachable, but it is a different
   *    green: it says "one `setup` away from never typing this again".
   *
   * Pass 2 never upgrades a verdict pass 1 already settled: a timeout, an
   * unknown host key or a missing `ssh` is reported as what it was, since the
   * second pass proved nothing about it. Never throws.
   */
  async probe(machine: SshMachine): Promise<ProbeResult> {
    const timeoutSec = Math.ceil(this.probeTimeoutMs / 1000)
    const argv = probeArgv(machine, { home: this.home, timeoutSec })
    const [cmd, ...args] = argv
    let first: SshRunResult
    try {
      first = await this.run(cmd, args, this.probeTimeoutMs)
    } catch (error) {
      return { status: 'error', detail: String(error) }
    }
    const status = classifyProbe(first.code, first.stderr, first.timedOut)
    if (status !== 'auth') return { status, detail: firstLine(first.stderr) }

    const password = this.passwordFor(machine.id)
    if (!password || !this.askpass) return { status, detail: firstLine(first.stderr) }
    try {
      const second = await this.askpass.run(
        passwordProbeArgv(machine, { home: this.home, timeoutSec }),
        password,
        this.probeTimeoutMs
      )
      const verdict = classifyProbe(second.code, second.stderr, second.timedOut)
      if (verdict === 'ok') return { status: 'password', detail: PASSWORD_ACCEPTED_DETAIL }
      if (verdict === 'auth') {
        const why = firstLine(second.stderr)
        return {
          status: 'auth',
          detail: why ? `${PASSWORD_REFUSED_DETAIL}: ${why}` : PASSWORD_REFUSED_DETAIL
        }
      }
      if (verdict === 'timeout') return { status: 'timeout', detail: firstLine(second.stderr) }
    } catch {
      // Fall through to the verdict pass 1 already proved: a second pass that
      // could not even be classified has nothing to add to it.
    }
    return { status, detail: firstLine(first.stderr) }
  }

  /* ---------------------------------------------------------------- *
  * Keys + passwordless setup
  * ---------------------------------------------------------------- */

  /** Absolute paths of the public keys in `~/.ssh`, conventional ones first. */
  keys(): string[] {
    if (!this.home) return []
    const dir = joinFor(this.platform, this.home, '.ssh')
    const pubs = this.listDir(dir)
      .filter((name) => name.endsWith('.pub'))
      .map((name) => joinFor(this.platform, dir, name))
    const order = ['id_ed25519.pub', 'id_ecdsa.pub', 'id_rsa.pub']
    return pubs.sort((a, b) => rankKey(a, order) - rankKey(b, order))
  }

  /** The conventional default public key, or '' when there is none. */
  defaultKey(): string {
    return this.keys()[0] ?? ''
  }

  /** The shell line(s) that would make `machine` passwordless. */
  setup(machine: SshMachine, pubKey = ''): string[] {
    return setupLines(machine, {
      platform: this.platform,
      home: this.home,
      pubKey: pubKey || this.defaultKey()
    })
  }

  /**
   * The keypair-creation line for this platform. Only worth typing when
   * `keys()` is empty; the caller decides that, because it is the caller that
   * knows whether the human asked for a key or for a connection.
   */
  keygen(): string {
    return keygenLine(this.platform)
  }

  /** The interactive connect line for a machine (what gets typed into a pane). */
  connectLine(machine: SshMachine): string {
    return sshLine(machine, { home: this.home })
  }

  /** Expand a `~`-relative path against this service's home. */
  expand(value: string): string {
    return expandHome(value, this.home)
  }
}

function rankKey(file: string, order: readonly string[]): number {
  const base = baseName(file)
  const at = order.indexOf(base)
  return at < 0 ? order.length : at
}

function firstLine(stderr: string): string {
  const line = String(stderr || '')
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .pop()
  return (line ?? '').slice(0, 200)
}
