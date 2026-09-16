/**
 * SSH and local terminals, as pure data.
 */

/** Where a roster entry came from. */
export type MachineSource = 'saved' | 'config' | 'herdr'

/**
 * One connectable machine. Every field but `id`/`label`/`host`/`source` is
 * optional in practice: a config alias carries its own Port/User/IdentityFile,
 * so for those we connect by alias and leave the rest blank rather than
 * guessing. `port: 0` means "ssh's default" (22), not "no port".
 */
export interface SshMachine {
  id: string
  label: string
  host: string
  port: number
  user: string
  identityFile: string
  proxyJump: string
  source: MachineSource
  /**
   * The `~/.ssh/config` Host alias, when this machine came from one. When set it
   * wins: `ssh <alias>` resolves HostName/Port/User/IdentityFile from config.
   */
  alias: string
}

/** What a reachability/auth probe concluded. `ok` is the only green. */
export type ProbeStatus =
  | 'unknown'
  | 'ok'
  | 'auth'
  | 'host-key'
  | 'timeout'
  | 'unreachable'
  | 'no-ssh'
  | 'error'

export const PROBE_STATUSES: readonly ProbeStatus[] = [
  'unknown',
  'ok',
  'auth',
  'host-key',
  'timeout',
  'unreachable',
  'no-ssh',
  'error'
]

/* ------------------------------------------------------------------ *
 * Small shared helpers
 * ------------------------------------------------------------------ */

/** Clamp to a real TCP port; anything else (including '' and NaN) is 0=default. */
export function clampPort(value: unknown): number {
  const n = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  const port = Math.trunc(n)
  return port >= 1 && port <= 65535 ? port : 0
}

/** Expand a leading `~` against `home`. Only `~` and `~/`: `~user` stays put. */
export function expandHome(value: string, home: string): string {
  const raw = String(value || '')
  const base = String(home || '').replace(/[\\/]+$/, '')
  if (!base) return raw
  if (raw === '~') return base
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    const rest = raw.slice(2).replace(/^[\\/]+/, '')
    const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
    const tail = separator === '\\' ? rest.replace(/\//g, '\\') : rest
    return tail ? `${base}${separator}${tail}` : base
  }
  return raw
}

/**
 * Join with the separator the *named* platform uses, not the one this process
 * happens to be running on.
 *
 * `node:path` picks its separator at load time, so a service told
 * `platform: 'posix'` and `home: '/home/tester'` would still emit
 * `\home\tester\.ssh\id_rsa.pub` on a Windows host. That is not a production
 * bug - production always passes the real platform with the real home - but it
 * makes every faked-world test assert one thing on Linux and another on
 * Windows, and this project's rule is that path arithmetic is asserted on every
 * platform. Empty parts are dropped, and a leading `~` is expanded against the
 * first part so `joinFor(p, home, '~/.ssh')` does what it reads like.
 */
export function joinFor(platform: 'posix' | 'windows', ...parts: readonly string[]): string {
  const sep = platform === 'windows' ? '\\' : '/'
  const kept = parts
    .map((part) => String(part ?? ''))
    .filter((part) => part !== '')
  if (kept.length === 0) return ''
  const [head, ...rest] = kept
  const tail = rest
    .map((part) => part.replace(/^[\\/]+/, '').replace(/[\\/]+$/, ''))
    .filter((part) => part !== '')
    .join(sep)
  const normalizedHead = head.replace(/[\\/]+$/, '')
  return tail ? `${normalizedHead}${sep}${tail}` : normalizedHead || head
}

/**
 * The last segment of a path, split on either separator.
 *
 * `path.basename` only knows the host's separator, so on Linux it returns
 * `C:\Users\x\.ssh\id_rsa.pub` whole. Key ranking compares conventional
 * filenames, and a Windows path that fails to reduce to one silently loses its
 * rank instead of failing loudly.
 */
export function baseName(value: string): string {
  const raw = String(value ?? '').replace(/[\\/]+$/, '')
  const at = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  return at < 0 ? raw : raw.slice(at + 1)
}
/**
 * POSIX single-quote an argument, but only when it needs it. A connect line is
 * typed into a real shell, so a path with a space must survive; a plain `host`
 * must not grow quotes that look like noise.
 */
export function shellQuote(arg: string): string {
  const value = String(arg ?? '')
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

/** A file-safe, case-folded slug for ids. Never empty: falls back to `machine`. */
export function machineSlug(...parts: readonly (string | number)[]): string {
  const joined = parts
    .map((part) => String(part ?? ''))
    .filter((part) => part !== '' && part !== '0')
    .join('-')
    .toLowerCase()
  const slug = joined
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'machine'
}

/* ------------------------------------------------------------------ *
 * Construction / normalisation
 * ------------------------------------------------------------------ */

export interface MachineInput {
  id?: string
  label?: string
  host: string
  port?: number | string
  user?: string
  identityFile?: string
  proxyJump?: string
  source?: MachineSource
  alias?: string
}

/**
 * The one place an `SshMachine` is born, so a hand-typed target, a config line
 * and a saved record all end up with the same trimming, port clamping and label
 * fallback. `id` is provisional here (the service assigns a durable one on
 * save); everything else is final.
 */
export function makeMachine(input: MachineInput): SshMachine {
  const host = String(input.host || '').trim()
  const user = String(input.user || '').trim()
  const port = clampPort(input.port)
  const alias = String(input.alias || '').trim()
  const source: MachineSource =
    input.source === 'config' || input.source === 'herdr' ? input.source : 'saved'
  const label = String(input.label || '').trim() || (user ? `${user}@${host}` : host)
  const id = String(input.id || '').trim() || `${source}:${machineSlug(host, port, user)}`
  return {
    id,
    label,
    host,
    port,
    user,
    identityFile: String(input.identityFile || '').trim(),
    proxyJump: String(input.proxyJump || '').trim(),
    source,
    alias
  }
}

/** Narrow an untrusted blob to a machine, or false. Used when reading our JSON. */
export function isMachine(value: unknown): value is SshMachine {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return typeof m.id === 'string' && typeof m.host === 'string' && m.host.trim() !== ''
}

/* ------------------------------------------------------------------ *
 * ~/.ssh/config
 * ------------------------------------------------------------------ */

/** Drop a trailing `# comment` (ssh only treats `#` as a comment at a token). */
function stripComment(line: string): string {
  return line.replace(/(^|\s)#.*$/, '').trimEnd()
}

/** `Key Value` or `Key=Value`; ssh accepts both, so split on whichever came first. */
function splitKeyValue(line: string): { key: string; value: string } {
  const eq = line.indexOf('=')
  const sp = line.search(/\s/)
  if (eq > 0 && (sp < 0 || eq < sp)) {
    return { key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() }
  }
  const match = /^(\S+)\s+(.*)$/.exec(line)
  return match ? { key: match[1], value: match[2].trim() } : { key: line.trim(), value: '' }
}

/** A Host pattern that names one real machine (not `*`, `?`, or a `!negation`). */
function isLiteralPattern(pattern: string): boolean {
  return pattern !== '' && !pattern.startsWith('!') && !/[*?]/.test(pattern)
}

/**
 * Parse `~/.ssh/config` into the connectable machines it describes.
 *
 * Deliberately conservative, because a wrong machine in the palette is worse
 * than a missing one:
 *
 * - Only `Host` blocks with at least one *literal* alias become machines. A
 *   `Host *` catch-all or a `Host !bad *` exclusion describes policy, not a
 *   place you can `ssh` to, so the whole block is skipped.
 * - `Match` blocks are skipped: their condition (`host`, `exec`, `user`) cannot
 *   be resolved without running ssh, and guessing would invent a machine.
 * - `Include` is not followed. Recursing pulls in arbitrary files and a cycle
 *   waiting to happen; the user's top-level config is enough for a palette.
 * - First value wins per key, matching ssh's own "the first obtained value is
 *   used" rule, so a later duplicate does not silently override.
 */
export function parseSshConfig(text: string): SshMachine[] {
  const machines: SshMachine[] = []
  let aliases: string[] = []
  let fields: Record<string, string> = {}
  let inBlock = false
  let skipped = false

  const flush = (): void => {
    if (inBlock && !skipped) {
      const alias = aliases.find(isLiteralPattern) ?? ''
      if (alias) {
        machines.push(
          makeMachine({
            id: `config:${machineSlug(alias)}`,
            label: alias,
            alias,
            host: fields.hostname || alias,
            port: fields.port,
            user: fields.user,
            identityFile: fields.identityfile,
            proxyJump: fields.proxyjump,
            source: 'config'
          })
        )
      }
    }
    aliases = []
    fields = {}
    inBlock = false
    skipped = false
  }

  for (const rawLine of String(text || '').split('\n')) {
    const line = stripComment(rawLine.replace(/\r$/, '')).trim()
    if (!line) continue
    const { key, value } = splitKeyValue(line)
    const lower = key.toLowerCase()

    if (lower === 'host') {
      flush()
      aliases = value.split(/\s+/).filter(Boolean)
      inBlock = true
      // Connectable only if some literal alias survives; otherwise skip the block.
      skipped = !aliases.some(isLiteralPattern)
      continue
    }
    if (lower === 'match') {
      flush()
      inBlock = true
      skipped = true
      continue
    }
    if (lower === 'include') continue
    if (!inBlock || skipped) continue
    // First value wins; ignore keys we do not model.
    if (!(lower in fields)) fields[lower] = value
  }
  flush()
  return machines
}

/* ------------------------------------------------------------------ *
 * Free-form targets
 * ------------------------------------------------------------------ */

function stripBrackets(host: string): string {
  const value = String(host || '').trim()
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

/**
 * Parse whatever the user typed into the palette's target field:
 *
 *   host            user@host        user@host:port      host:port
 *   ssh://user@host:port             [::1]:2222          ssh://[::1]
 *
 * A colon is only a port when what follows is all digits, so an scp-style
 * `host:path` is left alone (ssh will reject it, which is the honest answer)
 * rather than mis-read as port `path`. A string with a space in it is not a
 * bare target, so it is tried as a whole command line instead; anything that is
 * neither returns null, and the palette shows "not a target" rather than
 * connecting nowhere.
 */
export function parseTarget(raw: string): SshMachine | null {
  const text = String(raw || '').trim()
  if (!text) return null
  if (/\s/.test(text)) return parseSshCommand(text)

  const url = /^ssh:\/\/(?:([^@/]+)@)?(\[[^\]]+\]|[^/:]+)(?::(\d+))?\/?$/i.exec(text)
  if (url) {
    const host = stripBrackets(url[2])
    if (!host) return null
    return makeMachine({ user: url[1] || '', host, port: url[3], source: 'saved' })
  }

  const dest = parseDestination(text)
  return dest ? makeMachine({ ...dest, source: 'saved' }) : null
}

/** `[user@]host[:port]` as one token, split into its three parts. */
function parseDestination(text: string): { user: string; host: string; port: string } | null {
  // Split the user on the last '@', then peel a trailing ':<digits>' as the
  // port. A colon whose suffix is not all digits (an scp-style host:path) stays
  // part of the host, and ssh will reject it - the honest answer rather than
  // silently mis-reading the path as a port.
  const at = text.lastIndexOf('@')
  const user = at >= 0 ? text.slice(0, at) : ''
  const hostPort = at >= 0 ? text.slice(at + 1) : text
  const colon = hostPort.lastIndexOf(':')
  let host = hostPort
  let port = ''
  if (colon >= 0 && /^\d+$/.test(hostPort.slice(colon + 1))) {
    host = hostPort.slice(0, colon)
    port = hostPort.slice(colon + 1)
  }
  host = stripBrackets(host)
  if (!host) return null
  return { user, host, port }
}

/**
 * Short flags that consume the next token, as ssh(1) lists them. Everything
 * else (`-t`, `-N`, `-q`, `-v`, `-4`) is a switch, and a cluster of switches
 * (`-vvp 2222`) is walked character by character so the value still lands on
 * the flag that asked for it. ssh has no long options, so `--port` is not
 * invented here; `-o Port=22` is the real spelling and it is read below.
 */
const SSH_VALUE_FLAGS = new Set(['b', 'c', 'D', 'e', 'E', 'F', 'i', 'I', 'J', 'l', 'L', 'm', 'o', 'O', 'p', 'Q', 'R', 'S', 'W', 'w'])

/** What a destination token may be made of. An allow-list, not a deny-list. */
const DESTINATION_CHARS = /^[A-Za-z0-9._@:%[\]-]+$/

/**
 * A pasted `ssh` command line, which is how people actually carry a machine
 * around: `ssh wanlian@172.18.29.206 -p 2222`, copied out of a README, a chat
 * message or their own shell history. Refusing it would mean refusing the one
 * string we know for certain names a machine.
 *
 * It is read as tokens, never as a shell, and two rules keep it that way:
 *
 * - Any shell metacharacter anywhere in the line (`;`, `|`, `&`, `$`, quotes,
 *   redirects) disqualifies the whole string. We are going to *rebuild* a line
 *   and type it into a pane, so a paste carrying more than a connection would
 *   quietly lose the rest of what the human meant - and `host; rm -rf ~` is the
 *   shape an injection attempt takes. Refusing is the honest answer to both.
 * - The destination must be built only of hostname characters. A path, a glob
 *   or a quoted phrase is not a host.
 *
 * Only the flags that say *where to go* are kept (`-p`, `-l`, `-i`, `-J`, and
 * `-o` Port/User/IdentityFile/ProxyJump). The rest are dropped on purpose: the
 * palette opens an interactive shell, so re-typing somebody's remote command or
 * tunnel into it would be a surprise, and a dropped `-t` still connects.
 */
export function parseSshCommand(raw: string): SshMachine | null {
  const text = String(raw || '').trim()
  if (!text || /[;|&$<>()`'"\\]/.test(text)) return null

  const tokens = text.split(/\s+/)
  const sawSsh = tokens[0]?.toLowerCase() === 'ssh'
  if (sawSsh) tokens.shift()

  let user = ''
  let port = ''
  let identityFile = ''
  let proxyJump = ''
  let sawFlag = false
  const positionals: string[] = []

  const applyOption = (flag: string, value: string): void => {
    if (flag === 'p') {
      if (/^\d+$/.test(value)) port = port || value
      return
    }
    if (flag === 'l') {
      user = user || value
      return
    }
    if (flag === 'i') {
      identityFile = identityFile || value
      return
    }
    if (flag === 'J') {
      proxyJump = proxyJump || value
      return
    }
    if (flag !== 'o') return
    const eq = value.indexOf('=')
    if (eq <= 0) return
    const key = value.slice(0, eq).trim().toLowerCase()
    const arg = value.slice(eq + 1).trim()
    if (key === 'port' && /^\d+$/.test(arg)) port = port || arg
    else if (key === 'user') user = user || arg
    else if (key === 'identityfile') identityFile = identityFile || arg
    else if (key === 'proxyjump') proxyJump = proxyJump || arg
  }

  for (let cursor = 0; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor]
    if (!token) continue
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token)
      continue
    }
    sawFlag = true
    let at = 1
    while (at < token.length) {
      const flag = token[at]
      if (!SSH_VALUE_FLAGS.has(flag)) {
        at += 1
        continue
      }
      const rest = token.slice(at + 1)
      const value = rest || tokens[++cursor] || ''
      applyOption(flag, value)
      at = token.length
    }
  }

  const destination = positionals[0] ?? ''
  if (!destination || !DESTINATION_CHARS.test(destination)) return null
  // More than one positional is a remote command after the host, which we drop.
  // But with no `ssh` and no flag in sight it is just two words, and guessing
  // that the first one was a hostname would connect somewhere nobody named.
  if (positionals.length > 1 && !sawSsh && !sawFlag) return null

  const dest = parseDestination(destination)
  if (!dest) return null
  return makeMachine({
    user: user || dest.user,
    host: dest.host,
    port: port || dest.port,
    identityFile,
    proxyJump,
    source: 'saved'
  })
}

/* ------------------------------------------------------------------ *
 * argv / connect lines
 * ------------------------------------------------------------------ */

/** The destination token: `user@host`, or just `host` when no user is known. */
function destination(machine: SshMachine): string {
  return machine.user ? `${machine.user}@${machine.host}` : machine.host
}

/**
 * The interactive connect argv. A config alias short-circuits everything:
 * `ssh <alias>` is what the user would have typed, and config already carries
 * the port, user and key, so re-passing them could only contradict it.
 */
export function sshArgv(machine: SshMachine, opts: { home?: string } = {}): string[] {
  if (machine.alias) return ['ssh', machine.alias]
  const argv = ['ssh']
  if (machine.port) argv.push('-p', String(machine.port))
  if (machine.identityFile) argv.push('-i', expandHome(machine.identityFile, opts.home ?? ''))
  if (machine.proxyJump) argv.push('-J', machine.proxyJump)
  argv.push(destination(machine))
  return argv
}

/** The connect argv as one shell-quoted line, ready to type into a pane. */
export function sshLine(machine: SshMachine, opts: { home?: string } = {}): string {
  return sshArgv(machine, opts)
    .map(shellQuote)
    .join(' ')
}

/**
 * A non-interactive reachability + auth probe.
 *
 * `BatchMode=yes` is the point: it forbids every password prompt, so the probe
 * answers exactly the question the user cares about - "can I get in *without*
 * typing a password?" A key-auth host exits 0 (`ok`); a password-only host fails
 * with `permission denied` (`auth`), which is the cue to offer passwordless
 * setup. `accept-new` trusts a *new* host key (never a changed one) so the first
 * probe of a fresh box does not wedge on the TOFU prompt, and `exit` gives the
 * remote something trivial to run.
 */
export function probeArgv(
  machine: SshMachine,
  opts: { home?: string; timeoutSec?: number } = {}
): string[] {
  const timeout = Math.max(1, Math.min(60, Math.trunc(opts.timeoutSec ?? 6)))
  const argv = [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${timeout}`,
    '-o',
    'StrictHostKeyChecking=accept-new'
  ]
  if (machine.alias) {
    argv.push(machine.alias, 'exit')
    return argv
  }
  if (machine.port) argv.push('-p', String(machine.port))
  if (machine.identityFile) argv.push('-i', expandHome(machine.identityFile, opts.home ?? ''))
  if (machine.proxyJump) argv.push('-J', machine.proxyJump)
  argv.push(destination(machine), 'exit')
  return argv
}

/**
 * Turn a probe's exit code + stderr into one status. Order matters: a host-key
 * rejection also prints "Permission denied", so it is tested first, and a
 * missing `ssh` binary (exit 127, "command not found") short-circuits the rest.
 */
export function classifyProbe(code: number, stderr: string, timedOut = false): ProbeStatus {
  if (timedOut) return 'timeout'
  const text = String(stderr || '')
  if (code === 0) return 'ok'
  if (
    code === 127 ||
    /command not found|not recognized as|program not found|no such file or directory/i.test(text)
  ) {
    return 'no-ssh'
  }
  if (/host key verification failed|authenticity of host|host key .*changed|known_hosts/i.test(text)) {
    return 'host-key'
  }
  if (
    /permission denied|publickey|too many authentication|authentication failed|password/i.test(text)
  ) {
    return 'auth'
  }
  if (/timed out|timeout/i.test(text)) return 'timeout'
  if (
    /connection refused|no route to host|could not resolve|network is unreachable|name or service not known|temporary failure in name resolution|connection closed/i.test(
      text
    )
  ) {
    return 'unreachable'
  }
  return 'error'
}

/* ------------------------------------------------------------------ *
 * Roster presentation
 * ------------------------------------------------------------------ */

const SOURCE_ORDER: Record<MachineSource, number> = { saved: 0, config: 1, herdr: 2 }

/**
 * Filter by a palette query and sort into the order a human scans: their own
 * saved machines first, then the aliases already in their ssh config, then
 * anything herdr reported; alphabetical within a tier. The query matches label,
 * host, user and alias, so typing "prod" finds `prod-box`, `user@prod.internal`
 * and a config `Host prod` alike.
 */
export function rankMachines(list: readonly SshMachine[], query: string): SshMachine[] {
  const q = String(query || '').trim().toLowerCase()
  const filtered = q
    ? list.filter((machine) =>
        `${machine.label} ${machine.host} ${machine.user} ${machine.alias}`
          .toLowerCase()
          .includes(q)
      )
    : list.slice()
  return filtered.sort((a, b) => {
    const tier = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]
    if (tier !== 0) return tier
    return a.label.localeCompare(b.label)
  })
}

/**
 * The identity two machines must share to be the same place you can connect to.
 *
 * An alias is its own identity: `Host prod` resolves through config, so a roster
 * row built from it and a typed `prod` are the same box even though one has a
 * hostname and the other does not. Without an alias the tuple is host+port+user,
 * which is exactly what ssh itself would dial.
 *
 * Exported because two callers need the same answer: `dedupeMachines` when it
 * merges the three sources, and the connect palette when it decides whether the
 * target the human just typed is already sitting in the list above the input.
 */
export function machineKey(machine: SshMachine): string {
  return machine.alias
    ? `alias:${machine.alias.toLowerCase()}`
    : `host:${machine.host.toLowerCase()}:${machine.port}:${machine.user.toLowerCase()}`
}

/** Dedupe a merged roster by connect identity, keeping the higher-precedence source. */
export function dedupeMachines(list: readonly SshMachine[]): SshMachine[] {
  const seen = new Map<string, SshMachine>()
  for (const machine of list) {
    const key = machineKey(machine)
    const existing = seen.get(key)
    if (!existing || SOURCE_ORDER[machine.source] < SOURCE_ORDER[existing.source]) {
      seen.set(key, machine)
    }
  }
  return [...seen.values()]
}

/* ------------------------------------------------------------------ *
 * Editing
 * ------------------------------------------------------------------ */

/**
 * The fields an edit form owns. Every one is optional, and `undefined` means
 * "leave it alone" while `''` (or `0` for the port) means "clear it" - the
 * difference between not touching ProxyJump and saying this box has none.
 */
export interface MachineEdit {
  label?: string
  host?: string
  port?: number | string
  user?: string
  identityFile?: string
  proxyJump?: string
  alias?: string
}

/** True when a patch changes anything ssh would dial differently. */
export function changesConnection(machine: SshMachine, patch: MachineEdit): boolean {
  if (patch.host !== undefined && patch.host.trim() !== machine.host) return true
  if (patch.user !== undefined && patch.user.trim() !== machine.user) return true
  if (patch.identityFile !== undefined && patch.identityFile.trim() !== machine.identityFile) {
    return true
  }
  if (patch.proxyJump !== undefined && patch.proxyJump.trim() !== machine.proxyJump) return true
  if (patch.port !== undefined && clampPort(patch.port) !== machine.port) return true
  return false
}

/**
 * Apply an edit, and return the machine that should be stored.
 *
 * Two rules carry the weight here:
 *
 * - **The result is always `saved`.** An edit is ours to own: `~/.ssh/config` is
 *   a file we were asked to read, and rewriting a block in somebody's ssh
 *   config from a desktop app is not a surprise worth springing. So editing a
 *   config alias *forks* it into our own roster; the original stays on disk
 *   untouched and can be hidden from the palette if the fork is meant to
 *   replace it.
 * - **Editing the connection drops the alias.** `sshArgv` short-circuits on
 *   `alias` (`ssh <alias>` and nothing else), so keeping it while the human
 *   retypes the port would silently throw the port away - a form that accepts
 *   your input and then does not use it. Only a label-only edit keeps the
 *   alias, because there the config block is still the truth.
 *
 * The id is kept when it is a durable one (the service's `m...` ids), so an edit
 * upserts the row instead of leaving the old one behind beside the new one.
 */
export function editMachine(machine: SshMachine, patch: MachineEdit): SshMachine {
  const keep = machine.alias && !changesConnection(machine, patch)
  const alias = patch.alias !== undefined ? patch.alias.trim() : keep ? machine.alias : ''
  return makeMachine({
    id: machine.id,
    label: patch.label !== undefined ? patch.label : machine.label,
    host: patch.host !== undefined ? patch.host : machine.host,
    port: patch.port !== undefined ? patch.port : machine.port,
    user: patch.user !== undefined ? patch.user : machine.user,
    identityFile:
      patch.identityFile !== undefined ? patch.identityFile : machine.identityFile,
    proxyJump: patch.proxyJump !== undefined ? patch.proxyJump : machine.proxyJump,
    alias,
    source: 'saved'
  })
}

/**
 * What an edit form starts from: the machine's own values, so the fields are
 * pre-filled rather than empty, plus the private-key path the roster knows
 * (`identityFile` is the private key; `keys()` lists the public ones).
 */
export function machineEditOf(machine: SshMachine): Required<MachineEdit> {
  return {
    label: machine.label,
    host: machine.host,
    port: machine.port,
    user: machine.user,
    identityFile: machine.identityFile,
    proxyJump: machine.proxyJump,
    alias: machine.alias
  }
}

/**
 * Whether hiding is the right verb for this row.
 *
 * A `saved` machine is ours, so removing it deletes the record. A config or
 * herdr row is *reported* to us from somewhere we do not own: there is nothing
 * to delete, and pretending otherwise would either lie or edit the user's
 * files. Hiding is the honest dismissal - it stops the row appearing, keeps the
 * source intact, and can be undone from one list.
 */
export function isHiddenRemoval(machine: SshMachine): boolean {
  return machine.source !== 'saved'
}

/**
 * Filter a deduped roster by the hidden keys, and keep the list a UI can
 * restore from.
 *
 * Hiding only ever applies to rows we do not own. A `saved` machine with the
 * same identity is an explicit decision made after the hide, and dropping it
 * would mean the pin button appears to do nothing - so `save()` unhides, and
 * this filter is the second half of that rule.
 */
export function filterHidden(
  list: readonly SshMachine[],
  hidden: readonly string[]
): SshMachine[] {
  if (!hidden.length) return list.slice()
  const keys = new Set(hidden.map((key) => String(key).toLowerCase()))
  return list.filter(
    (machine) => machine.source === 'saved' || !keys.has(machineKey(machine).toLowerCase())
  )
}

/** Dedupe + normalise a stored hidden list: lowercased, non-empty, in order. */
export function normalizeHidden(list: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of list) {
    const key = String(entry ?? '').trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/**
 * One dismissed row, as the restore list shows it.
 *
 * The key travels beside the machine rather than being recomputed from it: a
 * hidden identity can outlive the thing it named (the `Host` block gets deleted
 * from `~/.ssh/config`), and the list still has to offer a way to drop it.
 * Recomputing `machineKey` from a placeholder row would produce a different
 * string and make that entry unrestorable - stuck in the list forever.
 */
export interface HiddenMachine {
  key: string
  machine: SshMachine
  /** True when no source reports this identity any more. */
  stale: boolean
}
/* ------------------------------------------------------------------ *
 * Passwordless setup
 * ------------------------------------------------------------------ */

/**
 * The shell line(s) that make a machine passwordless by appending our public
 * key to its `authorized_keys`.
 *
 * POSIX has `ssh-copy-id`, which also fixes the remote permissions, so we use it
 * and let it prompt for the password once. Windows OpenSSH ships no
 * `ssh-copy-id`, so the equivalent is piping the public key through `ssh` into a
 * remote append - the canonical recipe from Microsoft's own docs. The *remote*
 * command is POSIX either way (the target is an ssh server, almost always
 * Linux); only the local half differs (`type` vs an identity flag). `pubKey` is
 * the path to the *public* key; when blank we fall back to the conventional
 * `id_ed25519.pub` and let the shell expand `~` / `$env:USERPROFILE`.
 */
export function setupLines(
  machine: SshMachine,
  opts: { platform: 'posix' | 'windows'; home?: string; pubKey?: string }
): string[] {
  const pubKey = String(opts.pubKey || '').trim()
  if (opts.platform === 'windows') {
    const key = pubKey || '$env:USERPROFILE\\.ssh\\id_ed25519.pub'
    const target = machine.alias
      ? machine.alias
      : `${machine.port ? `-p ${machine.port} ` : ''}${destination(machine)}`
    const remote =
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
    return [`type ${key} | ssh ${target} ${shellQuote(remote)}`]
  }
  const argv = ['ssh-copy-id']
  if (pubKey) argv.push('-i', pubKey)
  if (machine.alias) {
    argv.push(machine.alias)
  } else {
    if (machine.port) argv.push('-p', String(machine.port))
    if (machine.identityFile) {
      argv.push('-o', `IdentityFile=${expandHome(machine.identityFile, opts.home ?? '')}`)
    }
    argv.push(destination(machine))
  }
  return [argv.map(shellQuote).join(' ')]
}

/**
 * The line that creates a keypair when `~/.ssh` has none, so "make this
 * passwordless" works on a fresh install instead of failing with
 * `ssh-copy-id: ERROR: failed to open ... id_ed25519.pub`.
 *
 * `-N ''` means no passphrase: the whole point is that the human stops typing
 * secrets at every connect, and an interactive passphrase prompt would just
 * move the typing somewhere else. The path is left to each platform's own
 * convention (`~` on POSIX, `$env:USERPROFILE` on Windows) because the line is
 * typed into a real shell, which is the only thing that knows them.
 */
export function keygenLine(platform: 'posix' | 'windows' = 'posix'): string {
  const target =
    platform === 'windows'
      ? '$env:USERPROFILE\\.ssh\\id_ed25519'
      : '~/.ssh/id_ed25519'
  return platform === 'windows'
    ? `ssh-keygen -t ed25519 -f ${target}`
    : ['ssh-keygen', '-t', 'ed25519', '-N', '', '-f', target].map(shellQuote).join(' ')
}
