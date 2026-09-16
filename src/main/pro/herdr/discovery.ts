/**
 * Finding herdr: the binary to spawn bridges with, and the socket to talk to.
 *
 * The rules are herdr's own, mirrored from its `session.rs` / `config/io.rs`
 * rather than guessed, because a bench pointed at the wrong socket is
 * indistinguishable from a bench with nothing running:
 *
 *   config dir = $XDG_CONFIG_HOME/herdr        (or the platform default)
 *              | %APPDATA%\herdr               (Windows)
 *              | ~/Library/Application Support/herdr  (macOS)
 *   session    = $HERDR_SESSION, where "default" means *no* session subdir
 *   socket     = <config>/sessions/<name>/herdr.sock   (named session)
 *              | <config>/herdr.sock                  (default session)
 *   override   = $HERDR_SOCKET_PATH wins over both
 *
 * Debug builds of herdr use `herdr-dev` as the directory name, so both spellings
 * are probed. The candidate lists below stay pure - they compute paths without
 * touching the filesystem, which is what makes them unit-testable. Resolving them
 * is the impure half, so `discoverHerdr` *requires* an `exists` probe: a caller
 * that forgets it fails to compile instead of reporting "no herdr" on a machine
 * where herdr is running. `fsPathExists` is the real probe.
 */
import fs from 'node:fs'

export type PlatformName = 'linux' | 'darwin' | 'win32'

export interface DiscoveryDeps {
  env?: Record<string, string | undefined>
  platform?: PlatformName
  home?: string
  exists?: (path: string) => boolean
  /** ProConfig.herdrPath: an explicit binary chosen in settings. */
  binaryPath?: string
  /** ProConfig.socketPath: an explicit socket chosen in settings. */
  socketPath?: string
  /** ProConfig.herdrSession: an explicit session name chosen in settings. */
  session?: string
}

/** The filesystem probe discovery resolves its candidate lists with. */
export type ExistsFn = (path: string) => boolean

/** Reads one directory. Injected for the same reason `exists` is. */
export type ListDirFn = (dir: string) => string[]

/**
 * What resolving needs: the candidate deps plus the two filesystem verbs. Both
 * are required, so a caller that forgets one fails to compile instead of
 * reporting an empty machine.
 */
export interface ResolveDeps extends DiscoveryDeps {
  exists: ExistsFn
  listDir: ListDirFn
}

/** Both the release and the debug-build directory names, in probe order. */
export const APP_DIR_NAMES: readonly string[] = ['herdr', 'herdr-dev']

export const SOCKET_ENV_VAR = 'HERDR_SOCKET_PATH'
export const SESSION_ENV_VAR = 'HERDR_SESSION'
export const DEFAULT_SESSION_NAME = 'default'

function join(...parts: string[]): string {
  const cleaned = parts.filter((part) => part !== '')
  if (cleaned.length === 0) return ''
  const isWin = /^[a-zA-Z]:[\\/]/.test(cleaned[0]) || cleaned[0].startsWith('\\\\')
  const separator = isWin ? '\\' : '/'
  return cleaned
    .map((part, index) => (index === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
    .filter((part) => part !== '')
    .join(separator)
}

export function normalizePlatform(value: unknown): PlatformName {
  return value === 'win32' || value === 'darwin' ? value : 'linux'
}

function homeOf(deps: DiscoveryDeps): string {
  const env = deps.env ?? {}
  if (deps.home) return deps.home
  const fromEnv = env.USERPROFILE || env.HOME
  return fromEnv || (deps.platform === 'win32' ? 'C:\\Users\\unknown' : '/home/unknown')
}

/**
 * herdr honours `XDG_CONFIG_HOME` on every platform when it is set, then falls
 * back to the platform convention. One entry per app-dir spelling.
 */
export function configDirCandidates(deps: DiscoveryDeps = {}): string[] {
  const env = deps.env ?? {}
  const platform = normalizePlatform(deps.platform)
  const home = homeOf(deps)
  const out: string[] = []
  for (const name of APP_DIR_NAMES) {
    if (env.XDG_CONFIG_HOME) out.push(join(env.XDG_CONFIG_HOME, name))
    if (platform === 'win32') {
      const appData = env.APPDATA || join(home, 'AppData', 'Roaming')
      out.push(join(appData, name))
    } else if (platform === 'darwin') {
      out.push(join(home, 'Library', 'Application Support', name))
    } else {
      out.push(join(home, '.config', name))
    }
  }
  return dedupe(out)
}

/** `default` is not a directory: it means the config dir itself. */
export function normalizeSession(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw || raw.toLowerCase() === DEFAULT_SESSION_NAME) return ''
  return raw
}


/**
 * Which session was asked for. `??` is the wrong operator here: the app always
 * passes `pro.herdrSession`, whose default is the empty string, and an empty
 * string counts as a decision to `??` - so `HERDR_SESSION` would never reach
 * discovery from a real boot, only from a test that omitted the key. Config wins
 * when it names something; otherwise the environment does.
 */
function sessionOf(deps: DiscoveryDeps): string {
  const env = deps.env ?? {}
  const configured = typeof deps.session === 'string' ? deps.session.trim() : ''
  return normalizeSession(configured || env[SESSION_ENV_VAR])
}


/** Where a session keeps its state, without assuming the socket exists. */
export function sessionDataDir(configDir: string, session: string): string {
  return session ? join(configDir, 'sessions', session) : configDir
}

/**
 * herdr writes its server log next to the socket it was going to take, and the
 * install card quotes that path to a human, so it has to be a path that exists.
 *
 * The arithmetic is local rather than `node:path`: `dirname` and `join` follow
 * the host platform, so the same socket string resolves to two different log
 * paths depending on where the app runs - on Windows `dirname('/tmp/x.sock')`
 * is `\tmp`, and the card ends up quoting `\tmp/herdr-server.log`. Everything
 * else in this module means the same path on every platform; this is the one
 * that gets read aloud, so it is held to the same rule.
 */
export function logPathForSocket(socket: string): string {
  const target = String(socket || '').trim()
  if (!target) return ''
  const cut = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  if (cut < 0) return 'herdr-server.log'
  const separator = target[cut]
  const dir = target.slice(0, cut)
  // Cut at index 0 is the POSIX root, which has to survive: dropping it would
  // turn an absolute hint into a relative one pointing somewhere else.
  const base = dir === '' ? (separator === '\\' ? '' : '/') : dir + separator
  return base + 'herdr-server.log'
}

/**
 * Sockets to try, best first. An explicit override short-circuits the list the
 * same way it does inside herdr; otherwise every config-dir spelling is tried
 * for the named session and then for the default one, because a user who ran
 * `herdr` once without `HERDR_SESSION` has the default socket and nothing else.
 */
export function socketCandidates(deps: DiscoveryDeps = {}): string[] {
  const env = deps.env ?? {}
  const explicit = (deps.socketPath || env[SOCKET_ENV_VAR] || '').trim()
  if (explicit) return [explicit]
  const session = sessionOf(deps)
  const out: string[] = []
  for (const configDir of configDirCandidates(deps)) {
    if (session) out.push(join(sessionDataDir(configDir, session), 'herdr.sock'))
  }
  for (const configDir of configDirCandidates(deps)) {
    out.push(join(sessionDataDir(configDir, ''), 'herdr.sock'))
  }
  if (session) {
    // A session the user asked for by name is worth one more look under the
    // other app-dir spelling before we give up.
    for (const configDir of configDirCandidates(deps)) {
      out.push(join(configDir, 'sessions', session, 'herdr.sock'))
    }
  }
  return dedupe(out)
}

/** Binaries to try, best first. `~/.local/bin` is where herdr installs itself. */
export function binaryCandidates(deps: DiscoveryDeps = {}): string[] {
  const env = deps.env ?? {}
  const platform = normalizePlatform(deps.platform)
  const home = homeOf(deps)
  const exe = platform === 'win32' ? 'herdr.exe' : 'herdr'
  const out: string[] = []
  if (deps.binaryPath) out.push(deps.binaryPath)
  if (env.HERDR_BIN_PATH) out.push(env.HERDR_BIN_PATH)
  for (const dir of (env.PATH || '').split(platform === 'win32' ? ';' : ':')) {
    if (dir) out.push(join(dir, exe))
  }
  out.push(join(home, '.local', 'bin', exe))
  out.push(join(home, '.cargo', 'bin', exe))
  if (platform === 'darwin') out.push('/opt/homebrew/bin/herdr', '/usr/local/bin/herdr')
  if (platform === 'linux') out.push('/usr/local/bin/herdr', '/usr/bin/herdr')
  return dedupe(out)
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export interface HerdrTarget {
  /** Resolved binary, or null when herdr is not installed anywhere we looked. */
  binaryPath: string | null
  /** Resolved socket, or null when no server appears to be running. */
  socketPath: string | null
  /** Normalized session name; '' means the default session. */
  session: string
  /** Env to give spawned children so they reach the same server we do. */
  childEnv: Record<string, string>
  found: boolean
  /** Human-readable reason for the empty state; bilingual at the call site. */
  reason: 'ok' | 'no-binary' | 'no-socket' | 'no-server'
  triedSockets: string[]
  triedBinaries: string[]
  /**
   * Named sessions whose socket is on disk, looked up only when resolution came
   * up empty. Never a candidate: the bench will not attach to a session nobody
   * asked for, but it can say "cwfix is right there, point me at it".
   */
  sessionsFound: string[]
}

/**
 * The real probe. Discovery looks for exactly two kinds of thing - an executable
 * and a unix socket - so both count and a directory does not. That last part is
 * not decoration: `binaryCandidates` walks every entry in `PATH`, and a directory
 * that happens to be named `herdr` would otherwise resolve as the binary and fail
 * much later, at spawn time, with an error pointing nowhere near here. A dangling
 * symlink throws inside `statSync` and reads as absent, which is the same answer
 * herdr itself would get.
 */
export function fsPathExists(target: string): boolean {
  const candidate = String(target || '').trim()
  if (!candidate) return false
  try {
    const stat = fs.statSync(candidate)
    return stat.isFile() || stat.isSocket()
  } catch {
    return false
  }
}

/**
 * The real directory read. Empty on any failure: a config dir that cannot be
 * listed and a machine with no herdr on it want the same answer.
 */
export function fsListDir(dir: string): string[] {
  const target = String(dir || '')
  if (!target) return []
  try {
    return fs.readdirSync(target)
  } catch {
    return []
  }
}

/**
 * Named sessions that look live, meaning their socket file is on disk. Reading
 * the directory is not attaching to it and never produces a candidate: guessing
 * a session would put the bench on terminals nobody asked it to drive, which is
 * worse than an empty state. This list only ever reaches that empty state's text.
 */
function liveSessions(deps: ResolveDeps): string[] {
  const out: string[] = []
  for (const configDir of configDirCandidates(deps)) {
    for (const name of deps.listDir(join(configDir, 'sessions'))) {
      if (!name || name === DEFAULT_SESSION_NAME || out.includes(name)) continue
      if (deps.exists(join(sessionDataDir(configDir, name), 'herdr.sock'))) out.push(name)
    }
  }
  return out.sort()
}

/**
 * Resolve both halves of "where is herdr". A missing binary is not fatal for
 * reading state (the socket is enough), and a missing socket is not fatal for
 * spawning bridges (the binary is enough), so each is resolved independently
 * and `reason` names whichever is missing.
 */
export function discoverHerdr(deps: ResolveDeps): HerdrTarget {
  const exists = deps.exists
  const session = sessionOf(deps)
  const triedSockets = socketCandidates(deps)
  const socketPath = triedSockets.find((candidate) => exists(candidate)) ?? null
  const triedBinaries = binaryCandidates(deps)
  const binaryPath = triedBinaries.find((candidate) => exists(candidate)) ?? null
  // A readdir only on the way to an empty state. On the happy path it could
  // only repeat what resolution just found, and discovery runs on a timer.
  const sessionsFound = socketPath ? [] : liveSessions(deps)

  const childEnv: Record<string, string> = {}
  if (socketPath) childEnv[SOCKET_ENV_VAR] = socketPath
  if (session) childEnv[SESSION_ENV_VAR] = session

  const reason: HerdrTarget['reason'] = !binaryPath && !socketPath
    ? 'no-server'
    : !socketPath
      ? 'no-socket'
      : !binaryPath
        ? 'no-binary'
        : 'ok'

  return {
    binaryPath,
    socketPath,
    session,
    childEnv,
    found: Boolean(socketPath),
    reason,
    triedSockets,
    triedBinaries,
    sessionsFound
  }
}

/**
 * The text the install card shows when nothing was found. Deliberately specific:
 * "herdr is not running" and "herdr is not installed" have different fixes, and
 * a bench that cannot tell them apart sends the user to the wrong one.
 * A named session sitting on disk is a third case with a third fix, and the one
 * that reads most like a bug - herdr *is* running, the bench is simply pointed
 * at the default session - so the sentence carries the setting to change.
 */
export function describeDiscovery(target: HerdrTarget, lang: 'zh' | 'en'): string {
  if (target.reason === 'ok') return ''
  const names = target.sessionsFound ?? []
  if (lang === 'zh') {
    if (names.length) {
      return `找到了 herdr 命名会话 ${names.join('、')}，但工作台指向的是默认会话：把 pro.herdrSession 设为 ${names[0]}，或用 HERDR_SESSION=${names[0]} 启动 herdr`
    }
    if (target.reason === 'no-binary') return '找到了 herdr 会话，但没有找到 herdr 可执行文件'
    if (target.reason === 'no-socket') return '已安装 herdr，但没有正在运行的会话'
    return '没有找到 herdr：它托管终端，工作台只是它的控制面板'
  }
  if (names.length) {
    return `found herdr session ${names.join(', ')} but the bench is pointed at the default one: set pro.herdrSession to ${names[0]}, or start herdr with HERDR_SESSION=${names[0]}`
  }
  if (target.reason === 'no-binary') return 'a herdr session is running but the herdr binary was not found'
  if (target.reason === 'no-socket') return 'herdr is installed but no session is running'
  return 'herdr was not found: it owns the terminals, the bench is only its control plane'
}
