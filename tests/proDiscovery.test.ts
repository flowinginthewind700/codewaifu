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
  fsPathExists,
  normalizeSession,
  sessionDataDir,
  socketCandidates,
  type ExistsFn,
  type HerdrTarget
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

  it('uses the macOS and Windows conventions, since the Mac build is next', () => {
    expect(configDirCandidates({ platform: 'darwin', home: '/Users/u' })[0]).toBe(
      '/Users/u/Library/Application Support/herdr'
    )
    expect(configDirCandidates({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\App' } })[0]).toBe(
      'C:\\Users\\u\\App\\herdr'
    )
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

describe('the real probe', () => {
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
    deps: { session?: string; socketPath?: string } = {}
  ): HerdrTarget {
    return discoverHerdr({ ...LINUX, home: '/home/u', env: {}, exists: probeFor(...present), ...deps })
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
describe('resolving a real herdr on a real disk', () => {
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

    const target = discoverHerdr({ ...LINUX, home, env: { HOME: home, PATH: bin }, exists: fsPathExists })

    expect(target.socketPath).toBeNull()
    expect(target.found).toBe(false)
    // The binary is right there, so the card must not say "install herdr".
    expect(target.reason).toBe('no-socket')
    expect(target.binaryPath).toBe(binary)
  })

  it('finds the default session with no session named anywhere', async () => {
    const home = root()
    const sock = await listen(path.join(home, '.config', 'herdr', 'herdr.sock'))
    const target = discoverHerdr({ ...LINUX, home, env: { HOME: home }, exists: fsPathExists })
    expect(target.socketPath).toBe(sock)
    expect(target.session).toBe('')
  })

  it('falls to the debug-build directory when that is where the socket lives', async () => {
    const home = root()
    const sock = await listen(path.join(home, '.config', 'herdr-dev', 'herdr.sock'))
    const target = discoverHerdr({ ...LINUX, home, env: { HOME: home }, exists: fsPathExists })
    expect(target.socketPath).toBe(sock)
  })

  it('does not resolve a directory on PATH as the binary', () => {
    const { home, bin } = installedHome()
    fs.rmSync(path.join(bin, 'herdr'))
    fs.mkdirSync(path.join(bin, 'herdr'))
    const target = discoverHerdr({ ...LINUX, home, env: { HOME: home, PATH: bin }, exists: fsPathExists })
    expect(target.triedBinaries[0]).toBe(path.join(bin, 'herdr'))
    expect(target.binaryPath).not.toBe(path.join(bin, 'herdr'))
  })

  it('reports an empty machine as empty, with the paths it tried for the card', () => {
    const { home, bin } = installedHome()
    fs.rmSync(path.join(bin, 'herdr'))
    const target = discoverHerdr({ ...LINUX, home, env: { HOME: home, PATH: bin }, exists: fsPathExists })
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
    triedBinaries: []
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
