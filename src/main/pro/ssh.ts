/**
 * The SSH roster: what the connect palette can reach, and how it knows.
 *
 * This service owns three reads and one write, and nothing else:
 *
 * - read `~/.ssh/config` (the user's own aliases, parsed read-only),
 * - read `machines.json` (the machines pinned in the Bench - the only file we
 *   write, and we write it the same crash-proof way the task registry does),
 * - ask herdr for machines it already knows (best-effort, via an injected
 *   provider, because herdr's machine list is a separate subsystem),
 * - run a non-interactive `ssh` probe to answer "can I get in without a
 *   password?".
 *
 * Every rule about *what a machine is* and *what to type* lives in
 * `shared/ssh.ts`; this file is the impure edge - disk, child processes, the
 * platform - and it is built so a test can inject all three and never touch a
 * real `ssh` or a real `~/.ssh`.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  classifyProbe,
  dedupeMachines,
  expandHome,
  isMachine,
  keygenLine,
  makeMachine,
  parseSshConfig,
  parseTarget,
  probeArgv,
  rankMachines,
  setupLines,
  sshLine,
  type MachineInput,
  type ProbeStatus,
  type SshMachine
} from '../../shared/ssh'
import { proDir, readJson, writeJsonAtomic } from './env'

/** Pinned machines live beside the task registry; same ownership, same writer. */
export const machinesFile = path.join(proDir, 'machines.json')

const MACHINES_VERSION = 1

export interface MachinesFile {
  version: number
  updatedAt: number
  machines: SshMachine[]
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

export interface SshRunResult {
  code: number
  stdout: string
  stderr: string
  /** True when we killed the child for exceeding the timeout. */
  timedOut: boolean
}

export interface ProbeResult {
  status: ProbeStatus
  /** A short human line for the palette tooltip; '' when there is nothing to add. */
  detail: string
}

export interface SshDeps {
  file?: string
  home?: string
  /** Defaults to `<home>/.ssh/config`. */
  sshConfigPath?: string
  platform?: 'posix' | 'windows'
  /** Injectable child runner; the real one is `execFile`. */
  run?: (cmd: string, args: readonly string[], timeoutMs: number) => Promise<SshRunResult>
  readFile?: (file: string) => string | null
  listDir?: (dir: string) => string[]
  read?: (file: string) => MachinesFile | null
  write?: (file: string, value: unknown) => boolean
  now?: () => number
  newId?: () => string
  /** herdr's own machines, mapped into our model. Defaults to none. */
  herdrMachines?: () => Promise<SshMachine[]>
  probeTimeoutMs?: number
}

const DEFAULT_PROBE_TIMEOUT = 8000

/** `m` + base36 time + 4 hex: sortable, file-safe, unique enough. Mirrors newTaskId. */
export function newMachineId(now = Date.now()): string {
  // Lazy require keeps the import list honest without pulling crypto at module
  // scope into the renderer's reach (this file is main-only anyway).
  const rand = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0')
  return `m${now.toString(36)}${rand}`
}

/**
 * The real child runner. `execFile` reports a timeout as a killed child and a
 * spawn failure (no `ssh` on PATH) as a string `code`, so both are folded into
 * the one `SshRunResult` shape `classifyProbe` understands: a timeout sets
 * `timedOut`, a spawn failure becomes exit 127 ("command not found").
 */
export function runSsh(
  cmd: string,
  args: readonly string[],
  timeoutMs: number
): Promise<SshRunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      [...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : ''
        const err = typeof stderr === 'string' ? stderr : ''
        if (!error) {
          resolve({ code: 0, stdout: out, stderr: err, timedOut: false })
          return
        }
        const e = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }
        if (e.killed || e.signal === 'SIGTERM' || e.signal === 'SIGKILL') {
          resolve({
            code: typeof e.code === 'number' ? e.code : 255,
            stdout: out,
            stderr: err,
            timedOut: true
          })
          return
        }
        if (typeof e.code === 'number') {
          resolve({ code: e.code, stdout: out, stderr: err, timedOut: false })
          return
        }
        resolve({ code: 127, stdout: out, stderr: err || String(error.message || error), timedOut: false })
      }
    )
  })
}

export class SshService {
  private readonly file: string
  private readonly home: string
  private readonly sshConfigPath: string
  private readonly platform: 'posix' | 'windows'
  private readonly run: (cmd: string, args: readonly string[], timeoutMs: number) => Promise<SshRunResult>
  private readonly readFile: (file: string) => string | null
  private readonly listDir: (dir: string) => string[]
  private readonly read: (file: string) => MachinesFile | null
  private readonly write: (file: string, value: unknown) => boolean
  private readonly now: () => number
  private readonly newId: () => string
  private readonly herdrMachines: () => Promise<SshMachine[]>
  private readonly probeTimeoutMs: number

  constructor(deps: SshDeps = {}) {
    this.file = deps.file ?? machinesFile
    this.home = deps.home ?? ''
    this.sshConfigPath = deps.sshConfigPath ?? (this.home ? path.join(this.home, '.ssh', 'config') : '')
    this.platform = deps.platform ?? 'posix'
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
   * The merged, deduped, ranked roster the palette shows. `query` filters it the
   * way the palette's input does, so the renderer never re-implements ranking.
   */
  async roster(query = ''): Promise<SshMachine[]> {
    const herdr = await this.herdrMachines().catch(() => [] as SshMachine[])
    const merged = dedupeMachines([...this.saved(), ...this.config(), ...herdr])
    return rankMachines(merged, query)
  }

  /* ---------------------------------------------------------------- *
  * Save / remove
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
    const file: MachinesFile = { version: MACHINES_VERSION, updatedAt: this.now(), machines: list }
    return this.write(this.file, file) ? stored : null
  }

  /** Unpin a machine. Config and herdr entries are not ours to remove. */
  remove(id: string): boolean {
    const list = this.saved()
    const next = list.filter((entry) => entry.id !== id)
    if (next.length === list.length) return false
    const file: MachinesFile = { version: MACHINES_VERSION, updatedAt: this.now(), machines: next }
    return this.write(this.file, file)
  }

  /* ---------------------------------------------------------------- *
  * Probe
  * ---------------------------------------------------------------- */

  /**
   * Can we get in without a password? Runs the real `ssh` in BatchMode, so a
   * key-auth host is `ok` and a password-only host is `auth` - the cue to offer
   * passwordless setup. Never throws: a missing `ssh` is `no-ssh`, not a crash.
   */
  async probe(machine: SshMachine): Promise<ProbeResult> {
    const argv = probeArgv(machine, { home: this.home, timeoutSec: Math.ceil(this.probeTimeoutMs / 1000) })
    const [cmd, ...args] = argv
    try {
      const result = await this.run(cmd, args, this.probeTimeoutMs)
      const status = classifyProbe(result.code, result.stderr, result.timedOut)
      return { status, detail: firstLine(result.stderr) }
    } catch (error) {
      return { status: 'error', detail: String(error) }
    }
  }

  /* ---------------------------------------------------------------- *
  * Keys + passwordless setup
  * ---------------------------------------------------------------- */

  /** Absolute paths of the public keys in `~/.ssh`, conventional ones first. */
  keys(): string[] {
    if (!this.home) return []
    const dir = path.join(this.home, '.ssh')
    const pubs = this.listDir(dir)
      .filter((name) => name.endsWith('.pub'))
      .map((name) => path.join(dir, name))
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
  const base = path.basename(file)
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
