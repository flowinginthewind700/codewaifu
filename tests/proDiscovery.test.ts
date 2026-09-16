/**
 * Finding herdr, which is the precondition for every other F: a bench that
 * cannot resolve the socket is indistinguishable from a bench with nothing
 * running, and it says so with the same empty state.
 *
 * Two halves, pinned separately because they fail differently. The candidate
 * lists are pure path arithmetic, so they get exact-order assertions against a
 * fake probe. Resolution is the impure half, and that is where the bug this file
 * exists for lived: `discoverHerdr` defaulted `exists` to "nothing is there", so
 * a caller that forgot to pass a real probe reported `no-server` on a machine
 * with herdr running - and every test still passed, because every test injected
 * its own fake. The requirement now lives in the type (`ResolveDeps.exists`),
 * which turns that omission into a typecheck failure, and the real-disk section
 * exercises the shipped probe so the default cannot rot again.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_DIR_NAMES,
  DEFAULT_SESSION_NAME,
  SESSION_ENV_VAR,
  SOCKET_ENV_VAR,
  binaryCandidates,
  configDirCandidates,
  describeDiscovery,
  discoverHerdr,
  fsListDir,
  fsPathExists,
  normalizeSession,
  sessionDataDir,
  socketCandidates,
  type ExistsFn,
  type HerdrTarget,
  type ListDirFn
} from '../src/main/pro/herdr/discovery'

/** Temp roots this file made, so cleanup never touches anything else. */
const roots: string[] = []
/** Listening unix sockets, which have to be closed before their dir goes. */
const servers: net.Server[] = []

function root(prefix = 'cw-disc-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const dir of roots.splice(0)) {
    if (dir.startsWith(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** A real unix socket, because `isSocket()` is only meaningful against one. */
async function listen(file: string): Promise<string> {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(file, () => resolve())
  })
  servers.push(server)
  return file
}

/** A probe that only answers for paths the test declared present. */
function probeFor(...present: string[]): ExistsFn {
  const set = new Set(present)
  return (candidate) => set.has(candidate)
}

/** A directory read that only knows the directories the test declared. */
function dirsFor(entries: Record<string, string[]>): ListDirFn {
  return (dir) => entries[dir] ?? []
}

/**
 * The blocks below lay a simulated home on the runner's real filesystem and put
 * a real unix socket in it. On Windows that simulation cannot be honest: Node's
 * `net` treats a string path as a named pipe there, so `listen()` on
 * `C:\...\herdr.sock` answers EACCES instead of opening an AF_UNIX socket, and a
 * POSIX `PATH` split at the drive colon turns `C:\...\bin` into `C/herdr`. The
 * win32 discovery logic itself stays covered on every platform by the fake-deps
 * matrix above, which never touches the host filesystem.
 */
const describeUnix = process.platform === 'win32' ? describe.skip : describe

const LINUX = { platform: 'linux' } as const

describe('the config dir, per platform and per spelling', () => {
  it('probes both app-dir names, because a debug herdr writes to the other one', () => {
    expect(APP_DIR_NAMES).toEqual(['herdr', 'herdr-dev'])
    expect(configDirCandidates({ ...LINUX, home: '/home/u' })).toEqual([
      '/home/u/.config/herdr',
      '/home/u/.config/herdr-dev'
    ])
  })

  it('honours XDG_CONFIG_HOME and still keeps the platform default behind it', () => {
    expect(configDirCandidates({ ...LINUX, env: { XDG_CONFIG_HOME: '/xdg' } })).toEqual([
      '/xdg/herdr',
      '/home/unknown/.config/herdr',
      '/xdg/herdr-dev',
      '/home/unknown/.config/herdr-dev'
    ])
  })

  it('probes ~/.config first on macOS, which is where herdr really writes', () => {
    // `herdr status` on a Mac with no XDG_CONFIG_HOME reports
    // socket: ~/.config/herdr/herdr.sock, and never creates Application Support.
    expect(configDirCandidates({ platform: 'darwin', home: '/Users/u' })).toEqual([
      '/Users/u/.config/herdr',
      '/Users/u/Library/Application Support/herdr',
      '/Users/u/.config/herdr-dev',
      '/Users/u/Library/Application Support/herdr-dev'
    ])
    expect(configDirCandidates({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\App' } })[0]).toBe(
      'C:\\Users\\u\\App\\herdr'
    )
  })

  it('still lets XDG_CONFIG_HOME win on macOS, the way it does inside herdr', () => {
    expect(
      configDirCandidates({ platform: 'darwin', home: '/Users/u', env: { XDG_CONFIG_HOME: '/xdg' } }).slice(0, 2)
    ).toEqual(['/xdg/herdr', '/Users/u/.config/herdr'])
  })
})

describe('session names', () => {
  it('reads "default" as no session subdir, the way herdr does', () => {
    expect(DEFAULT_SESSION_NAME).toBe('default')
    for (const raw of ['', '   ', 'default', 'DEFAULT', ' Default ']) {
      expect(normalizeSession(raw)).toBe('')
    }
    expect(normalizeSession('cwfix')).toBe('cwfix')
    expect(normalizeSession(42)).toBe('')
  })

  it('puts a named session under sessions/ and the default in the config dir', () => {
    expect(sessionDataDir('/cfg/herdr', 'cwfix')).toBe('/cfg/herdr/sessions/cwfix')
    expect(sessionDataDir('/cfg/herdr', '')).toBe('/cfg/herdr')
  })
})

describe('socket candidates', () => {
  it('lets an explicit override win outright, so a wrong socket is a choice', () => {
    expect(socketCandidates({ ...LINUX, socketPath: '/tmp/mine.sock', session: 'cwfix' })).toEqual([
      '/tmp/mine.sock'
    ])
    expect(socketCandidates({ ...LINUX, env: { [SOCKET_ENV_VAR]: '/tmp/env.sock' } })).toEqual([
      '/tmp/env.sock'
    ])
  })

  it('tries the named session first, then the default, for every spelling', () => {
    expect(socketCandidates({ ...LINUX, home: '/home/u', session: 'cwfix' })).toEqual([
      '/home/u/.config/herdr/sessions/cwfix/herdr.sock',
      '/home/u/.config/herdr-dev/sessions/cwfix/herdr.sock',
      '/home/u/.config/herdr/herdr.sock',
      '/home/u/.config/herdr-dev/herdr.sock'
    ])
  })

  it('never invents a session name: nothing wildcards sessions/', () => {
    const tried = socketCandidates({ ...LINUX, home: '/home/u' })
    expect(tried.some((candidate) => candidate.includes('/sessions/'))).toBe(false)
    expect(tried).toEqual(['/home/u/.config/herdr/herdr.sock', '/home/u/.config/herdr-dev/herdr.sock'])
  })

  it('finds a running Mac herdr, the socket the install card used to miss', () => {
    // The regression this pins: discovery looked only at Application Support on
    // darwin, so a Mac with herdr installed *and serving* reported `no-socket`
    // and the Bench showed the install card over a working runtime.
    const tried = socketCandidates({ platform: 'darwin', home: '/Users/u', env: {} })
    expect(tried[0]).toBe('/Users/u/.config/herdr/herdr.sock')
    expect(tried).toContain('/Users/u/Library/Application Support/herdr/herdr.sock')
  })

  it('reads the session from the environment when config did not name one', () => {
    const tried = socketCandidates({ ...LINUX, home: '/home/u', env: { [SESSION_ENV_VAR]: 'cwfix' } })
    expect(tried[0]).toBe('/home/u/.config/herdr/sessions/cwfix/herdr.sock')
  })

  it('dedupes, because the same session can arrive from config and from env', () => {
    const tried = socketCandidates({
      ...LINUX,
      home: '/home/u',
      session: 'cwfix',
      env: { [SESSION_ENV_VAR]: 'cwfix' }
    })
    expect(new Set(tried).size).toBe(tried.length)
  })
})

describe('binary candidates', () => {
  it('orders settings, then env, then PATH, then the two install locations', () => {
    const tried = binaryCandidates({
      ...LINUX,
      home: '/home/u',
      binaryPath: '/opt/herdr',
      env: { HERDR_BIN_PATH: '/env/herdr', PATH: '/a:/b' }
    })
    expect(tried.slice(0, 4)).toEqual(['/opt/herdr', '/env/herdr', '/a/herdr', '/b/herdr'])
    expect(tried).toContain('/home/u/.local/bin/herdr')
    expect(tried).toContain('/home/u/.cargo/bin/herdr')
  })

  it('asks for herdr.exe on Windows and skips empty PATH segments', () => {
    const tried = binaryCandidates({ platform: 'win32', env: { PATH: 'C:\\bin;;D:\\other' } })
    expect(tried[0]).toBe('C:\\bin\\herdr.exe')
    expect(tried).toContain('D:\\other\\herdr.exe')
    expect(tried.some((candidate) => candidate.startsWith('herdr'))).toBe(false)
  })

  it('adds the Homebrew paths on macOS, where ~/.local/bin is not the norm', () => {
    const tried = binaryCandidates({ platform: 'darwin', home: '/Users/u', env: {} })
    expect(tried).toContain('/opt/homebrew/bin/herdr')
    expect(tried).toContain('/usr/local/bin/herdr')
  })
})

describeUnix('the real probe', () => {
  it('accepts a file and a socket, the only two things discovery looks for', async () => {
    const dir = root()
    const file = path.join(dir, 'herdr')
    fs.writeFileSync(file, '#!/bin/sh\n', 'utf8')
    const sock = await listen(path.join(dir, 'herdr.sock'))
    expect(fsPathExists(file)).toBe(true)
    expect(fsPathExists(sock)).toBe(true)
  })

  it('refuses a directory: one named herdr on PATH would resolve as the binary and fail at spawn', () => {
    const dir = root()
    const asDir = path.join(dir, 'herdr')
    fs.mkdirSync(asDir)
    expect(fsPathExists(asDir)).toBe(false)
  })

  it('refuses what is missing, empty or a dangling symlink', () => {
    const dir = root()
    const target = path.join(dir, 'gone')
    fs.symlinkSync(target, path.join(dir, 'link'))
    expect(fsPathExists(target)).toBe(false)
    expect(fsPathExists(path.join(dir, 'link'))).toBe(false)
    expect(fsPathExists('')).toBe(false)
    expect(fsPathExists(undefined as unknown as string)).toBe(false)
  })
})

describe('reason, so the empty state can tell "not installed" from "not running"', () => {
  const BIN = '/home/u/.local/bin/herdr'
  const SOCK = '/home/u/.config/herdr/herdr.sock'

  /** Resolve against paths that exist only inside the test. */
  function resolve(
    present: string[],
    deps: { session?: string; socketPath?: string; listDir?: ListDirFn } = {}
  ): HerdrTarget {
    return discoverHerdr({
      ...LINUX,
      home: '/home/u',
      env: {},
      exists: probeFor(...present),
      listDir: () => [],
      ...deps
    })
  }

  it('names whichever half is missing, and ok only when both are there', () => {
    expect(resolve([]).reason).toBe('no-server')
    expect(resolve([BIN]).reason).toBe('no-socket')
    expect(resolve([SOCK]).reason).toBe('no-binary')
    const both = resolve([BIN, SOCK])
    expect(both.reason).toBe('ok')
    expect(both.found).toBe(true)
    expect(both.binaryPath).toBe(BIN)
    expect(both.socketPath).toBe(SOCK)
  })

  it('reports found only on a socket, since a binary alone cannot be talked to', () => {
    expect(resolve([BIN]).found).toBe(false)
  })

  it('hands children the socket and the session, so a bridge reaches the same server', () => {
    const named = '/home/u/.config/herdr/sessions/cwfix/herdr.sock'
    const target = resolve([named, BIN], { session: 'cwfix' })
    expect(target.childEnv).toEqual({ [SOCKET_ENV_VAR]: named, [SESSION_ENV_VAR]: 'cwfix' })
    expect(target.session).toBe('cwfix')
  })

  it('leaves the session out of childEnv for the default session, where it means nothing', () => {
    expect(resolve([SOCK]).childEnv).toEqual({ [SOCKET_ENV_VAR]: SOCK })
  })

  it('keeps an explicit socket that does not exist, and reports what it tried', () => {
    const target = resolve([], { socketPath: '/tmp/typo.sock' })
    expect(target.triedSockets).toEqual(['/tmp/typo.sock'])
    expect(target.socketPath).toBeNull()
  })
})

/*
 * The section that would have caught the shipped bug. Everything above can pass
 * against a fake probe; only these put the real one on a real socket, which is
 * what the app does at boot.
 */
describeUnix('resolving a real herdr on a real disk', () => {
  /** A home with an executable herdr on PATH, laid out the way the installer does. */
  function installedHome(): { home: string; bin: string; binary: string } {
    const home = root()
    const bin = path.join(home, 'bin')
    fs.mkdirSync(bin)
    const binary = path.join(bin, 'herdr')
    fs.writeFileSync(binary, '#!/bin/sh\n', 'utf8')
    fs.chmodSync(binary, 0o755)
    return { home, bin, binary }
  }

  it('finds a named session and its binary', async () => {
    const { home, bin, binary } = installedHome()
    const sock = await listen(path.join(home, '.config', 'herdr', 'sessions', 'cwfix', 'herdr.sock'))

    const target = discoverHerdr({
      ...LINUX,
      home,
      env: { HOME: home, PATH: bin },
      exists: fsPathExists,
      listDir: fsListDir,
      session: 'cwfix'
    })

    expect(target.reason).toBe('ok')
    expect(target.socketPath).toBe(sock)
    expect(target.binaryPath).toBe(binary)
    expect(target.childEnv[SESSION_ENV_VAR]).toBe('cwfix')
  })

  it('does not guess a session nobody named, and calls that "not running"', async () => {
    const { home, bin, binary } = installedHome()
    await listen(path.join(home, '.config', 'herdr', 'sessions', 'cwfix', 'herdr.sock'))

    const target = discoverHerdr({
      ...LINUX,
      home,
      env: { HOME: home, PATH: bin },
      exists: fsPathExists,
      listDir: fsListDir
    })

    expect(target.socketPath).toBeNull()
    expect(target.found).toBe(false)
    // The binary is right there, so the card must not say "install herdr".
    expect(target.reason).toBe('no-socket')
    expect(target.binaryPath).toBe(binary)
  })

  it('finds the default session with no session named anywhere', async () => {
    const home = root()
    const sock = await listen(path.join(home, '.config', 'herdr', 'herdr.sock'))
    const target = discoverHerdr({
      ...LINUX,
      home,
      env: { HOME: home },
      exists: fsPathExists,
      listDir: fsListDir
    })
    expect(target.socketPath).toBe(sock)
    expect(target.session).toBe('')
  })

  it('falls to the debug-build directory when that is where the socket lives', async () => {
    const home = root()
    const sock = await listen(path.join(home, '.config', 'herdr-dev', 'herdr.sock'))
    const target = discoverHerdr({
      ...LINUX,
      home,
      env: { HOME: home },
      exists: fsPathExists,
      listDir: fsListDir
    })
    expect(target.socketPath).toBe(sock)
  })

  it('does not resolve a directory on PATH as the binary', () => {
    const { home, bin } = installedHome()
    fs.rmSync(path.join(bin, 'herdr'))
    fs.mkdirSync(path.join(bin, 'herdr'))
    const target = discoverHerdr({
      ...LINUX,
      home,
      env: { HOME: home, PATH: bin },
      exists: fsPathExists,
      listDir: fsListDir
    })
    expect(target.triedBinaries[0]).toBe(path.join(bin, 'herdr'))
    expect(target.binaryPath).not.toBe(path.join(bin, 'herdr'))
  })

  it('reports an empty machine as empty, with the paths it tried for the card', () => {
    const { home, bin } = installedHome()
    fs.rmSync(path.join(bin, 'herdr'))
    const target = discoverHerdr({
      ...LINUX,
      home,
      env: { HOME: home, PATH: bin },
      exists: fsPathExists,
      listDir: fsListDir
    })
    expect(target.found).toBe(false)
    expect(target.socketPath).toBeNull()
    expect(target.triedSockets).toContain(path.join(home, '.config', 'herdr', 'herdr.sock'))
  })
})

describe('the install card text', () => {
  const target = (reason: HerdrTarget['reason']): HerdrTarget => ({
    binaryPath: null,
    socketPath: null,
    session: '',
    childEnv: {},
    found: false,
    reason,
    triedSockets: [],
    triedBinaries: [],
    sessionsFound: []
  })

  it('says nothing when herdr was found', () => {
    expect(describeDiscovery(target('ok'), 'en')).toBe('')
    expect(describeDiscovery(target('ok'), 'zh')).toBe('')
  })

  it('gives each missing half its own sentence, in both languages', () => {
    for (const lang of ['zh', 'en'] as const) {
      const texts = (['no-binary', 'no-socket', 'no-server'] as const).map((reason) =>
        describeDiscovery(target(reason), lang)
      )
      expect(texts.every((text) => text.length > 0)).toBe(true)
      expect(new Set(texts).size).toBe(3)
    }
  })

  it('names herdr, because the card has to say what is missing', () => {
    for (const lang of ['zh', 'en'] as const) {
      for (const reason of ['no-binary', 'no-socket', 'no-server'] as const) {
        expect(describeDiscovery(target(reason), lang)).toContain('herdr')
      }
    }
  })
})

describe('sessions the bench is not pointed at', () => {
  const BIN = '/home/u/.local/bin/herdr'
  const SOCK = '/home/u/.config/herdr/herdr.sock'
  const CW = '/home/u/.config/herdr/sessions/cwfix/herdr.sock'

  /** Resolve with both verbs faked, the way the reason table above does. */
  function resolveWith(
    present: string[],
    deps: { session?: string; socketPath?: string; listDir?: ListDirFn } = {}
  ): HerdrTarget {
    return discoverHerdr({
      ...LINUX,
      home: '/home/u',
      env: {},
      exists: probeFor(...present),
      listDir: () => [],
      ...deps
    })
  }

  /** The two `sessions` dirs, one per app-dir spelling, holding `names`. */
  function sessionsOnDisk(names: string[]): ListDirFn {
    return dirsFor({
      '/home/u/.config/herdr/sessions': names,
      '/home/u/.config/herdr-dev/sessions': names
    })
  }

  it('names a session that is running instead of leaving a dead end', () => {
    const target = resolveWith([BIN, CW], { listDir: sessionsOnDisk(['cwfix']) })
    expect(target.socketPath).toBeNull()
    expect(target.sessionsFound).toEqual(['cwfix'])
    // The binary is there, so this must not read as "install herdr".
    expect(target.reason).toBe('no-socket')
  })

  it('puts the session name and the setting to change in the card text', () => {
    const target = resolveWith([BIN, CW], { listDir: sessionsOnDisk(['cwfix']) })
    for (const lang of ['zh', 'en'] as const) {
      const text = describeDiscovery(target, lang)
      expect(text).toContain('cwfix')
      expect(text).toContain('pro.herdrSession')
      expect(text).toContain('HERDR_SESSION=cwfix')
    }
  })

  it('keeps the plain sentences when there is nothing to point at', () => {
    const target = resolveWith([BIN], { listDir: sessionsOnDisk([]) })
    expect(target.sessionsFound).toEqual([])
    expect(describeDiscovery(target, 'en')).toBe('herdr is installed but no session is running')
    expect(describeDiscovery(target, 'zh')).toBe('已安装 herdr，但没有正在运行的会话')
  })

  it('ignores a session directory whose socket is gone, which is a crash, not a session', () => {
    const target = resolveWith([BIN], { listDir: sessionsOnDisk(['old']) })
    expect(target.sessionsFound).toEqual([])
  })

  it('ignores a directory called default, since that name means no subdir at all', () => {
    const target = resolveWith([BIN], { listDir: sessionsOnDisk(['default']) })
    expect(target.sessionsFound).toEqual([])
  })

  it('dedupes a session both spellings report, and sorts what is left', () => {
    const target = resolveWith(
      [
        BIN,
        '/home/u/.config/herdr/sessions/cwfix/herdr.sock',
        '/home/u/.config/herdr-dev/sessions/cwfix/herdr.sock',
        '/home/u/.config/herdr-dev/sessions/alpha/herdr.sock'
      ],
      {
        listDir: dirsFor({
          '/home/u/.config/herdr/sessions': ['cwfix'],
          '/home/u/.config/herdr-dev/sessions': ['cwfix', 'alpha']
        })
      }
    )
    // Sorted, so the sentence the card builds is the same on every boot.
    expect(target.sessionsFound).toEqual(['alpha', 'cwfix'])
  })

  it('lists every live session, and suggests the first', () => {
    const target = resolveWith(
      [
        BIN,
        '/home/u/.config/herdr/sessions/zeta/herdr.sock',
        '/home/u/.config/herdr/sessions/cwfix/herdr.sock'
      ],
      { listDir: sessionsOnDisk(['zeta', 'cwfix']) }
    )
    expect(target.sessionsFound).toEqual(['cwfix', 'zeta'])
    expect(describeDiscovery(target, 'en')).toContain('cwfix, zeta')
    expect(describeDiscovery(target, 'en')).toContain('pro.herdrSession to cwfix')
  })

  it('says nothing about sessions once one resolved, and reads no directory to find out', () => {
    let reads = 0
    const target = resolveWith([BIN, SOCK], {
      listDir: (dir) => {
        reads += 1
        return sessionsOnDisk(['cwfix'])(dir)
      }
    })
    expect(target.reason).toBe('ok')
    expect(target.sessionsFound).toEqual([])
    expect(reads).toBe(0)
  })

  it('still resolves the session the user did name, and does not go looking', () => {
    let reads = 0
    const target = resolveWith([BIN, CW], {
      session: 'cwfix',
      listDir: () => {
        reads += 1
        return []
      }
    })
    expect(target.reason).toBe('ok')
    expect(target.socketPath).toBe(CW)
    expect(reads).toBe(0)
  })
})

describeUnix('the real directory read', () => {
  it('lists what is there and treats everything else as empty', () => {
    const dir = root()
    fs.mkdirSync(path.join(dir, 'sessions', 'cwfix'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'stray.txt'), 'x', 'utf8')
    expect(fsListDir(path.join(dir, 'sessions'))).toEqual(['cwfix'])
    expect(fsListDir(path.join(dir, 'nope'))).toEqual([])
    expect(fsListDir(path.join(dir, 'stray.txt'))).toEqual([])
    expect(fsListDir('')).toEqual([])
  })

  it('names a real session on disk, which is the state this machine is in', async () => {
    const home = root()
    const sessions = path.join(home, '.config', 'herdr', 'sessions')
    await listen(path.join(sessions, 'cwfix', 'herdr.sock'))

    const target = discoverHerdr({
      ...LINUX,
      home,
      env: { HOME: home },
      exists: fsPathExists,
      listDir: fsListDir
    })

    expect(target.socketPath).toBeNull()
    expect(target.sessionsFound).toEqual(['cwfix'])
    expect(describeDiscovery(target, 'en')).toContain('cwfix')
  })
})

/*
 * Which session was asked for. The app always passes `pro.herdrSession`, whose
 * default is the empty string, so `deps.session ?? env[...]` read that empty
 * string as a decision and `HERDR_SESSION` could only ever reach discovery from
 * a test that omitted the key - which is every test in this file. Each case
 * below passes the session explicitly, the way a real boot does.
 */
describeUnix('config versus HERDR_SESSION', () => {
  const NAMED = '/home/u/.config/herdr/sessions/cwfix/herdr.sock'
  const BIN = '/home/u/.local/bin/herdr'

  it('lets the environment name the session when config left it empty', () => {
    const tried = socketCandidates({
      ...LINUX,
      home: '/home/u',
      session: '',
      env: { [SESSION_ENV_VAR]: 'cwfix' }
    })
    expect(tried[0]).toBe(NAMED)
  })

  it('treats whitespace and "default" in config as no decision and as a decision, respectively', () => {
    // Whitespace is an unset field, so the environment still speaks.
    expect(
      socketCandidates({ ...LINUX, home: '/home/u', session: '   ', env: { [SESSION_ENV_VAR]: 'cwfix' } })[0]
    ).toBe(NAMED)
    // "default" is a session the user typed, so the environment does not overrule it.
    const typed = socketCandidates({
      ...LINUX,
      home: '/home/u',
      session: DEFAULT_SESSION_NAME,
      env: { [SESSION_ENV_VAR]: 'cwfix' }
    })
    expect(typed.some((candidate) => candidate.includes('/sessions/'))).toBe(false)
  })

  it('reads HERDR_SESSION=default as the default session, not as a directory', () => {
    const tried = socketCandidates({
      ...LINUX,
      home: '/home/u',
      session: '',
      env: { [SESSION_ENV_VAR]: 'default' }
    })
    expect(tried).toEqual(['/home/u/.config/herdr/herdr.sock', '/home/u/.config/herdr-dev/herdr.sock'])
  })

  it('keeps config in front when both name a session, so settings are not a suggestion', () => {
    const tried = socketCandidates({
      ...LINUX,
      home: '/home/u',
      session: 'cwfix',
      env: { [SESSION_ENV_VAR]: 'other' }
    })
    expect(tried[0]).toBe(NAMED)
    expect(tried.some((candidate) => candidate.includes('/other/'))).toBe(false)
  })

  it('resolves the environment session end to end, and hands it to children', () => {
    const target = discoverHerdr({
      ...LINUX,
      home: '/home/u',
      session: '',
      env: { [SESSION_ENV_VAR]: 'cwfix' },
      exists: probeFor(BIN, NAMED),
      listDir: () => []
    })
    expect(target.reason).toBe('ok')
    expect(target.socketPath).toBe(NAMED)
    expect(target.session).toBe('cwfix')
    expect(target.childEnv).toEqual({ [SOCKET_ENV_VAR]: NAMED, [SESSION_ENV_VAR]: 'cwfix' })
    expect(target.sessionsFound).toEqual([])
  })

  it('does it on a real disk too, where the empty config value comes from the shipped default', async () => {
    const home = root()
    const sock = await listen(path.join(home, '.config', 'herdr', 'sessions', 'cwfix', 'herdr.sock'))
    const target = discoverHerdr({
      ...LINUX,
      home,
      session: '',
      env: { HOME: home, [SESSION_ENV_VAR]: 'cwfix' },
      exists: fsPathExists,
      listDir: fsListDir
    })
    expect(target.socketPath).toBe(sock)
    expect(target.session).toBe('cwfix')
  })
})
