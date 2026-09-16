/**
 * The `codewaifu` launcher the app writes for itself.
 *
 * Pinned here because every failure mode is silent: a launcher that dials a
 * binary which moved, one that clobbers a wrapper an operator wrote, or one
 * that a shell cannot see. None of them throw - the command just does not work.
 *
 * The suite is split by what it depends on, and the split is the point. The
 * launcher is a `/bin/sh` script in `~/.local/bin` on a mac, so its *contract*
 * is a POSIX contract that has to read the same on every machine that runs
 * these tests - a Windows runner included, which is where `path.delimiter` is
 * `;` and a host-dependent implementation quietly answers a different question.
 * So: everything runs everywhere, and the three assertions that ask the *host*
 * for POSIX semantics are gated on exactly what they need - an execute bit the
 * host reports, a symlink the host lets us make, a `/bin/sh` the host has.
 * A blanket `skipIf(win32)` over the file would be easier and worse: it would
 * leave the Windows build with no coverage of the branch that actually runs
 * there, which is "do nothing, an installer owns the launcher".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  LAUNCHER_MARKER,
  PATH_DELIMITER,
  binDirOnPath,
  ensureCliLauncher,
  isOurs,
  launcherPath,
  launcherScript,
  pathHint,
  shellEscape
} from '../src/main/cliLauncher'

const APP = '/Applications/CodeWaifu.app/Contents/MacOS/CodeWaifu'

let home = ''

/** The host's own path semantics, used only where the test is about the host. */
const isWindows = process.platform === 'win32'

/** `sh -n` needs a POSIX shell; the Windows runners do not have `/bin/sh`. */
const hasSh = spawnSync('/bin/sh', ['-c', 'exit 0']).status === 0

/**
 * Symlinks on Windows need a privilege a CI runner does not have. Probed with
 * the host's `path` on purpose: this asks what *this* filesystem can do.
 */
const canSymlink = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-symlink-probe-'))
  try {
    const real = path.join(dir, 'real')
    fs.writeFileSync(real, 'x')
    fs.symlinkSync(real, path.join(dir, 'link'))
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})()

function request(overrides: Partial<Parameters<typeof ensureCliLauncher>[0]> = {}) {
  return ensureCliLauncher({
    packaged: true,
    platform: 'darwin',
    appBinary: APP,
    home,
    ...overrides
  })
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-launcher-'))
})

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('launcherScript', () => {
  it('routes a bare subcommand through --cli and passes a flag through untouched', () => {
    const script = launcherScript(APP)
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain(LAUNCHER_MARKER)
    expect(script).toContain(`APP="${APP}"`)
    // `codewaifu pro ssh` -> `CodeWaifu --cli pro ssh`
    expect(script).toContain('exec "$APP" --cli "$@"')
    // `codewaifu --cli status` and any future --flag stay verbatim
    expect(script).toContain('--*|-*) exec "$APP" "$@" ;;')
    // no arguments at all still starts the companion
    expect(script).toContain('if [ "$#" -eq 0 ]; then exec "$APP"; fi')
  })

  it('reports a missing binary in words instead of exec failing quietly', () => {
    expect(launcherScript(APP)).toContain('is gone; reinstall CodeWaifu')
  })

  it('escapes the path so a space, a quote or a $ cannot break the launcher', () => {
    const awkward = '/Users/a b/Applications/Code"Wifu.app/Contents/MacOS/$CodeWaifu'
    const script = launcherScript(awkward)
    expect(script).toContain('APP="/Users/a b/Applications/Code\\"Wifu.app/Contents/MacOS/\\$CodeWaifu"')
  })

  it.skipIf(!hasSh)('is valid POSIX sh', () => {
    const file = path.join(home, 'codewaifu')
    fs.writeFileSync(file, launcherScript(APP), { mode: 0o755 })
    // `sh -n` parses without running: a quoting mistake shows up here rather
    // than as a broken command on somebody's PATH.
    const result = spawnSync('/bin/sh', ['-n', file], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })
})

describe('shellEscape', () => {
  it('leaves an ordinary path alone and escapes the four dangerous characters', () => {
    expect(shellEscape('/Applications/CodeWaifu.app')).toBe('/Applications/CodeWaifu.app')
    expect(shellEscape('a"b')).toBe('a\\"b')
    expect(shellEscape('a$b')).toBe('a\\$b')
    expect(shellEscape('a`b')).toBe('a\\`b')
    expect(shellEscape('a\\b')).toBe('a\\\\b')
    expect(shellEscape('a b')).toBe('a b')
  })
})

describe('launcherPath', () => {
  it('defaults to ~/.local/bin, the directory herdr and install.sh use', () => {
    expect(launcherPath('/Users/tester')).toBe('/Users/tester/.local/bin/codewaifu')
    expect(launcherPath('/Users/tester', '/opt/bin')).toBe('/opt/bin/codewaifu')
  })
})

/**
 * The branches that answer before any disk access. These run on every platform
 * because they are precisely the branches a non-mac host takes: on Linux
 * install.sh owns `~/.local/bin/codewaifu` (and its copy carries the
 * `.no-sandbox` marker probe Chromium needs before any of our code runs), on
 * Windows install.ps1 owns a `.cmd`. Overwriting either would break a thing
 * this module did not write and cannot restore.
 */
describe('ensureCliLauncher, the decisions it makes before touching disk', () => {
  it('does nothing in a dev run, where execPath is an electron binary', () => {
    const outcome = request({ packaged: false })
    expect(outcome).toEqual({ action: 'skipped-dev' })
    expect(fs.existsSync(launcherPath(home))).toBe(false)
  })

  it('does nothing on linux or windows, where an installer owns the launcher', () => {
    const binDir = path.join(home, 'bin')
    const target = path.join(binDir, 'codewaifu')
    fs.mkdirSync(binDir, { recursive: true })
    const installerOwned =
      '#!/bin/sh\n# Generated by codewaifu/scripts/install.sh\nAPP="/opt/CodeWaifu/AppRun"\n'
    fs.writeFileSync(target, installerOwned, { mode: 0o755 })
    for (const platform of ['linux', 'win32'] as const) {
      expect(request({ platform, binDir })).toEqual({ action: 'skipped-platform', platform })
    }
    // Not rewritten, not truncated: the platform check is the first thing that
    // happens, so the file is never opened for writing at all.
    expect(fs.readFileSync(target, 'utf8')).toBe(installerOwned)
  })

  it('says so when there is no binary to point at', () => {
    expect(request({ appBinary: null })).toEqual({ action: 'skipped-no-binary' })
  })
})

describe('ensureCliLauncher, on disk', () => {
  it('writes an executable launcher on first boot', () => {
    const target = launcherPath(home)
    const outcome = request()
    expect(outcome).toEqual({ action: 'written', path: target })
    const written = fs.readFileSync(target, 'utf8')
    expect(written).toBe(launcherScript(APP))
    // 0o755, not 0o644: a launcher that is not executable reads as a missing
    // command, and `sh: permission denied` says nothing about why.
    // Windows has no execute bit for Node to report - `chmod` there only flips
    // read-only, and `mode` comes back 0o666 - so the mode is asserted where a
    // mode means something. The `chmodSync` call itself still runs everywhere.
    if (!isWindows) expect(fs.statSync(target).mode & 0o777).toBe(0o755)
  })

  it('creates the bin directory when nothing has put one there', () => {
    const binDir = path.join(home, 'deep', 'nested', 'bin')
    const outcome = request({ binDir })
    expect(outcome.action).toBe('written')
    expect(fs.existsSync(path.join(binDir, 'codewaifu'))).toBe(true)
  })

  it('is idempotent: a second boot writes nothing', () => {
    const target = launcherPath(home)
    request()
    const before = fs.statSync(target)
    const second = request()
    expect(second).toEqual({ action: 'current', path: target })
    const after = fs.statSync(target)
    // Same bytes and same mtime: a launch must not churn a file on PATH.
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('repoints a launcher of ours after the app moves', () => {
    const target = launcherPath(home)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, launcherScript('/Applications/Old/CodeWaifu.app/Contents/MacOS/CodeWaifu'), {
      mode: 0o755
    })
    const outcome = request()
    expect(outcome.action).toBe('written')
    expect(fs.readFileSync(target, 'utf8')).toBe(launcherScript(APP))
  })

  it('leaves a launcher it did not write alone', () => {
    const target = launcherPath(home)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const foreign = '#!/bin/sh\n# an operator wrapper\nexec /usr/local/bin/codewaifu "$@"\n'
    fs.writeFileSync(target, foreign, { mode: 0o755 })
    const outcome = request()
    expect(outcome).toEqual({ action: 'skipped-foreign', path: target })
    expect(fs.readFileSync(target, 'utf8')).toBe(foreign)
  })

  it.skipIf(!canSymlink)('does not follow a symlink, even one whose target looks like ours', () => {
    const real = path.join(home, 'elsewhere.sh')
    fs.writeFileSync(real, launcherScript(APP))
    const binDir = path.join(home, '.local', 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    fs.symlinkSync(real, path.join(binDir, 'codewaifu'))
    const outcome = request()
    expect(outcome.action).toBe('skipped-foreign')
    // The link still points where it did; nothing was rewritten through it.
    expect(fs.readlinkSync(path.join(binDir, 'codewaifu'))).toBe(real)
  })

  it('reports a failure instead of throwing into boot', () => {
    // A file where the bin directory has to go: mkdir cannot succeed.
    const blocker = path.join(home, 'blocker')
    fs.writeFileSync(blocker, 'not a directory')
    const outcome = request({ binDir: path.join(blocker, 'bin') })
    expect(outcome.action).toBe('failed')
    if (outcome.action === 'failed') expect(outcome.error).toContain('ENOTDIR')
    // No half-written launcher left behind.
    expect(fs.existsSync(path.join(blocker, 'bin', 'codewaifu'))).toBe(false)
  })
})

describe('isOurs', () => {
  it('reads the marker in the first lines only', () => {
    const probe = path.join(home, 'probe')
    fs.writeFileSync(probe, 'x')
    const stats = fs.lstatSync(probe)
    expect(isOurs(stats, `#!/bin/sh\n${LAUNCHER_MARKER}; rewritten\nAPP="x"\n`)).toBe(true)
    expect(isOurs(stats, `#!/bin/sh\nAPP="x"\n${LAUNCHER_MARKER}\n`)).toBe(false)
    expect(isOurs(stats, '')).toBe(false)
  })

  it.skipIf(!canSymlink)('refuses a symlink whatever it points at', () => {
    const real = path.join(home, 'real.sh')
    fs.writeFileSync(real, launcherScript(APP))
    const link = path.join(home, 'link')
    fs.symlinkSync(real, link)
    expect(isOurs(fs.lstatSync(link), launcherScript(APP))).toBe(false)
  })
})

describe('binDirOnPath', () => {
  it('reads the POSIX separator whatever host asks, because the launcher only exists on one', () => {
    // The regression this pins: `path.delimiter` is `;` on Windows, so a
    // host-dependent split turned a real PATH into one unmatched entry and
    // answered "not on PATH" about a launcher that plainly is. The separator
    // belongs to the artifact - a `/bin/sh` script on a mac - not to the
    // machine running the check.
    expect(PATH_DELIMITER).toBe(':')
    const target = '/Users/tester/.local/bin/codewaifu'
    expect(binDirOnPath(target, '/usr/bin:/Users/tester/.local/bin')).toBe(true)
    // A `;`-joined PATH is a Windows PATH, and this launcher is never on one.
    expect(binDirOnPath(target, 'C:\\bin;/Users/tester/.local/bin')).toBe(false)
  })

  it('matches the directory, tolerates a trailing slash, and says no otherwise', () => {
    const target = '/Users/tester/.local/bin/codewaifu'
    expect(binDirOnPath(target, '/usr/bin:/Users/tester/.local/bin')).toBe(true)
    expect(binDirOnPath(target, '/Users/tester/.local/bin/')).toBe(true)
    expect(binDirOnPath(target, '/usr/bin:/bin')).toBe(false)
    expect(binDirOnPath(target, undefined)).toBe(false)
    // A GUI app inherits launchd's PATH, which is the whole reason this is a
    // warning and not an error: the shell may well see what the app does not.
    expect(binDirOnPath(target, '/usr/bin:/bin:/usr/sbin:/sbin')).toBe(false)
  })
})

describe('pathHint', () => {
  it('is the one line an operator can paste', () => {
    expect(pathHint('/Users/tester/.local/bin/codewaifu')).toBe(
      'export PATH="/Users/tester/.local/bin:$PATH"'
    )
  })
})
