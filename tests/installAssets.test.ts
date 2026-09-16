import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const LIB = fileURLToPath(new URL('../scripts/lib/assets.sh', import.meta.url))
const INSTALLER = fileURLToPath(new URL('../scripts/install.sh', import.meta.url))

/** Skip rather than fail where the runner has no POSIX shell (a bare Windows box). */
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0

/**
 * A Windows runner does have bash (Git Bash), but `uname -s` there answers
 * MINGW64_NT-10.0-26100 and install.sh now refuses that on purpose: it places a
 * .app or an AppImage, and Windows gets install.ps1. So the tests that drive the
 * macOS/Linux install path skip there, while the guard itself is asserted on
 * every platform by stubbing uname.
 */
const isWindows = process.platform === 'win32'
const itPosix = isWindows ? it.skip : it

function run(script: string, args: string[] = [], input = ''): { status: number | null; stdout: string } {
  const result = spawnSync('bash', ['-c', `. "$0"; ${script}`, LIB, ...args], { input, encoding: 'utf8' })
  return { status: result.status, stdout: String(result.stdout ?? '').trim() }
}

function pickAsset(os: string, arch: string, exts: string[], names: string[]): string | null {
  const { status, stdout } = run('pick_asset "$@"', [os, arch, ...exts], names.join('\n') + '\n')
  return status === 0 && stdout ? stdout : null
}

/**
 * Read a script as text. `spawnSync('cat', ...)` was the same thing with two
 * extra failure modes: no `cat` on a bare Windows runner, and an empty string
 * that reads exactly like "the needle is not in the file" - so the assertion
 * failed for a reason that had nothing to do with the installer.
 *
 * Line endings are normalised on the way in, for the same reason: a Windows
 * checkout with `core.autocrlf=true` turns every `\n` this file searches for
 * into `\r\n`, and `indexOf('\ninstall_herdr\n')` answers -1 on a script whose
 * ordering is exactly right. `.gitattributes` pins `*.sh` to LF so the shipped
 * installer is never CRLF; this keeps the assertions about the script's logic
 * rather than about the reader's git config.
 */
function source(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

/**
 * Run install.sh against a curl that fails the way GitHub fails a repo with no
 * public release (exit 22), inside a throwaway HOME so nothing real is touched.
 */
function runInstallerOffline(
  args: string[] = [],
  fakeUname?: string
): { status: number | null; stderr: string; root: string } {
  const sandbox = mkdtempSync(join(tmpdir(), 'cw-install-'))
  const stubDir = join(sandbox, 'stub')
  mkdirSync(stubDir)
  const stub = join(stubDir, 'curl')
  writeFileSync(stub, '#!/bin/sh\nexit 22\n')
  chmodSync(stub, 0o755)
  if (fakeUname) {
    // install.sh asks uname for exactly two things, so answering both lets a test
    // be any platform without needing a runner that is that platform.
    const uname = join(stubDir, 'uname')
    writeFileSync(
      uname,
      `#!/bin/sh\ncase "$1" in\n  -m) echo x86_64 ;;\n  *) echo ${fakeUname} ;;\nesac\n`
    )
    chmodSync(uname, 0o755)
  }
  const root = join(sandbox, 'share/CodeWaifu')
  const result = spawnSync('bash', [INSTALLER, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH ?? ''}`,
      HOME: sandbox,
      XDG_DATA_HOME: join(sandbox, 'share'),
      CODEWAIFU_LINUX_ROOT: root,
      CODEWAIFU_LINUX_BIN: join(sandbox, 'bin')
    }
  })
  return { status: result.status, stderr: String(result.stderr ?? ''), root }
}

/** Every name our own electron-builder.yml can emit, plus the noise around it. */
const RELEASE = [
  'CodeWaifu-0.3.0-linux-x86_64.AppImage',
  'CodeWaifu-0.3.0-linux-x86_64.AppImage.blockmap',
  'CodeWaifu-0.3.0-linux-x86_64.AppImage.sig',
  'CodeWaifu-0.3.0-linux-amd64.deb',
  'CodeWaifu-0.3.0-linux-arm64.AppImage',
  'CodeWaifu-0.3.0-linux-arm64.deb',
  'CodeWaifu-0.3.0-mac-arm64.zip',
  'CodeWaifu-0.3.0-mac-x64.zip',
  'CodeWaifu-0.3.0-mac-arm64.dmg',
  'CodeWaifu-0.3.0-mac-arm64.dmg.blockmap',
  'CodeWaifu-0.3.0-win-x64-setup.exe',
  'CodeWaifu-0.3.0-win-x64-portable.exe',
  'latest-linux.yml',
  'latest-mac.yml',
  'builder-debug.yml'
]

describe.skipIf(!hasBash)('pick_asset', () => {
  it('takes the AppImage on x64 Linux, whose ${arch} expands to x86_64', () => {
    // The trap this exists for: the AppImage is named x86_64 and the deb amd64,
    // so an installer that hardcodes one spelling silently stops matching the
    // first time a target changes.
    expect(pickAsset('Linux', 'x64', ['AppImage', 'deb'], RELEASE)).toBe(
      'CodeWaifu-0.3.0-linux-x86_64.AppImage'
    )
  })

  it('honours the caller preference order, so deb-first really means deb', () => {
    expect(pickAsset('Linux', 'x64', ['deb', 'AppImage'], RELEASE)).toBe('CodeWaifu-0.3.0-linux-amd64.deb')
  })

  it('falls back to the next extension when the preferred one is absent', () => {
    const debOnly = ['CodeWaifu-0.3.0-linux-amd64.deb', 'latest-linux.yml']
    expect(pickAsset('Linux', 'x64', ['AppImage', 'deb'], debOnly)).toBe('CodeWaifu-0.3.0-linux-amd64.deb')
  })

  it('picks the arm64 Linux build on an arm64 machine', () => {
    expect(pickAsset('Linux', 'arm64', ['AppImage', 'deb'], RELEASE)).toBe('CodeWaifu-0.3.0-linux-arm64.AppImage')
  })

  it('never crosses platforms', () => {
    expect(pickAsset('Darwin', 'arm64', ['zip', 'dmg'], RELEASE)).toBe('CodeWaifu-0.3.0-mac-arm64.zip')
    expect(pickAsset('Darwin', 'x64', ['zip'], RELEASE)).toBe('CodeWaifu-0.3.0-mac-x64.zip')
    expect(pickAsset('Windows_NT', 'x64', ['exe'], RELEASE)).toMatch(/-win-x64-.*\.exe$/)
    expect(pickAsset('Linux', 'x64', ['exe'], RELEASE)).toBeNull()
  })

  it('rejects a foreign architecture outright instead of scoring it low', () => {
    // Installing an arm64 build on x64 would fail much later, with an
    // exec-format error pointing nowhere near the installer.
    expect(pickAsset('Linux', 'i386', ['AppImage'], ['CodeWaifu-0.3.0-linux-x86_64.AppImage'])).toBeNull()
    expect(pickAsset('Linux', 'x64', ['AppImage'], ['CodeWaifu-0.3.0-linux-arm64.AppImage'])).toBeNull()
  })

  it('ignores sidecars, which are tiny and download instantly', () => {
    expect(pickAsset('Linux', 'x64', ['AppImage'], ['CodeWaifu-0.3.0-linux-x86_64.AppImage.blockmap'])).toBeNull()
    expect(pickAsset('Linux', 'x64', ['yml'], ['latest-linux.yml'])).toBeNull()
    expect(
      pickAsset('Linux', 'x64', ['AppImage'], [
        'CodeWaifu-0.3.0-linux-x86_64.AppImage.sig',
        'CodeWaifu-0.3.0-linux-x86_64.AppImage'
      ])
    ).toBe('CodeWaifu-0.3.0-linux-x86_64.AppImage')
  })

  it('tolerates full URLs, paths and blank lines', () => {
    expect(
      pickAsset('Linux', 'x64', ['AppImage'], [
        '',
        '   ',
        'https://github.com/flowinginthewind700/codewaifu/releases/download/v0.3.0/CodeWaifu-0.3.0-linux-x86_64.AppImage',
        '/tmp/build/CodeWaifu-0.3.0-linux-x86_64.AppImage'
      ])
    ).toBe('CodeWaifu-0.3.0-linux-x86_64.AppImage')
  })

  it('accepts a hand-built artifact with no arch token, but ranks it last', () => {
    expect(pickAsset('Linux', 'x64', ['AppImage'], ['CodeWaifu-0.3.0.AppImage'])).toBe('CodeWaifu-0.3.0.AppImage')
    expect(
      pickAsset('Linux', 'x64', ['AppImage'], [
        'CodeWaifu-0.3.0.AppImage',
        'CodeWaifu-0.3.0-linux-x86_64.AppImage'
      ])
    ).toBe('CodeWaifu-0.3.0-linux-x86_64.AppImage')
  })

  it('breaks ties deterministically, so mirror ordering cannot change what ships', () => {
    const names = ['CodeWaifu-0.3.0-win-x64-setup.exe', 'CodeWaifu-0.3.0-win-x64-portable.exe']
    expect(pickAsset('Windows_NT', 'x64', ['exe'], names)).toBe(
      pickAsset('Windows_NT', 'x64', ['exe'], [...names].reverse())
    )
  })

  it('gives up cleanly on an empty list or no extensions', () => {
    expect(pickAsset('Linux', 'x64', ['AppImage'], [])).toBeNull()
    expect(run('pick_asset "$@"', ['Linux', 'x64']).status).not.toBe(0)
  })
})

describe.skipIf(!hasBash)('assets.sh helpers', () => {
  it('matches tokens on - and . boundaries only, never inside x86_64', () => {
    // If `_` counted as a separator, `x86` would match `x86_64` and an i386
    // asset would be accepted for an x64 machine.
    const name = 'CodeWaifu-0.3.0-linux-x86_64.AppImage'
    expect(run('has_token "$1" "$2" && echo yes', [name, 'x86_64']).stdout).toBe('yes')
    expect(run('has_token "$1" "$2" && echo yes', [name, 'linux']).stdout).toBe('yes')
    expect(run('has_token "$1" "$2" && echo yes', [name, 'x86']).stdout).toBe('')
    expect(run('has_token "$1" "$2" && echo yes', [name, 'x64']).stdout).toBe('')
    expect(run('has_token "$1" "$2" && echo yes', [name, '']).stdout).toBe('')
  })

  it('reports the single arch token a name carries', () => {
    expect(run('carried_arch "$1"', ['CodeWaifu-0.3.0-linux-x86_64.AppImage']).stdout).toBe('x86_64')
    expect(run('carried_arch "$1"', ['CodeWaifu-0.3.0-linux-amd64.deb']).stdout).toBe('amd64')
    expect(run('carried_arch "$1"', ['CodeWaifu-0.3.0-linux-arm64.deb']).stdout).toBe('arm64')
    expect(run('carried_arch "$1" || echo none', ['CodeWaifu-0.3.0.AppImage']).stdout).toBe('none')
  })

  it('reports the os token a name carries, so a foreign one can be rejected', () => {
    expect(run('carried_os "$1"', ['CodeWaifu-0.3.0-linux-x86_64.AppImage']).stdout).toBe('linux')
    expect(run('carried_os "$1"', ['CodeWaifu-0.3.0-win-x64-setup.exe']).stdout).toBe('win')
    expect(run('carried_os "$1"', ['CodeWaifu-0.3.0-mac-arm64.zip']).stdout).toBe('mac')
    expect(run('carried_os "$1" || echo none', ['CodeWaifu-0.3.0.AppImage']).stdout).toBe('none')
  })

  it('knows every spelling of our two shipped architectures', () => {
    expect(run('arch_aliases x64').stdout.split('\n')).toEqual(['x64', 'x86_64', 'amd64'])
    expect(run('arch_aliases arm64').stdout.split('\n')).toEqual(['arm64', 'aarch64'])
  })

  it('maps uname -s onto the os token each target uses', () => {
    expect(run('os_tokens Darwin').stdout.split('\n')).toContain('mac')
    expect(run('os_tokens Linux').stdout.split('\n')).toEqual(['linux'])
    expect(run('os_tokens Windows_NT').stdout.split('\n')).toContain('win')
  })

  it('strips the v a tag carries, because asset names do not have one', () => {
    expect(run('version_of_tag v0.3.0').stdout).toBe('0.3.0')
    expect(run('version_of_tag 0.3.0').stdout).toBe('0.3.0')
    expect(run('version_of_tag v0.3.0-rc.1').stdout).toBe('0.3.0-rc.1')
  })
})

describe.skipIf(!hasBash)('install.sh', () => {
  it('parses, which is the cheapest way to catch a broken heredoc', () => {
    for (const script of [LIB, INSTALLER]) {
      const result = spawnSync('bash', ['-n', script], { encoding: 'utf8' })
      expect(result.status, `${script}: ${result.stderr}`).toBe(0)
    }
  })

  it('defers to AppRun instead of running its own userns guess twice', () => {
    const body = source(INSTALLER).slice(source(INSTALLER).indexOf('linux_probe_sandbox() {'))
    const probe = body.slice(0, body.indexOf('\n}'))
    expect(probe).toContain('AppRun')
    expect(probe).toMatch(/\[ -x "\$LINUX_ROOT\/AppRun" \] && return 0/)
  })

  it('only ever passes --no-sandbox behind a marker the probe wrote', () => {
    // An unconditional --no-sandbox in the installer would quietly unsandbox
    // every Linux user whose kernel is perfectly capable of sandboxing.
    const src = source(INSTALLER)
    const mentions = src
      .split('\n')
      .filter((line) => line.includes('--no-sandbox'))
      .filter((line) => !line.trim().startsWith('#'))
    for (const line of mentions) {
      // The wrapper line sits inside a heredoc, so the `$` it carries is escaped.
      expect(line, line).toMatch(/warn |say |flags\+=\(--no-sandbox\)|set -- "\\\$@" --no-sandbox/)
    }
    // And the one place that appends it is gated on the marker file.
    expect(src).toMatch(/\.no-sandbox" \]; then\s*\n\s*flags\+=\(--no-sandbox\)/)
    // The generated launcher is gated the same way: a deb unpacked into $HOME
    // has no AppRun, so without this the wrapper inherits the FATAL abort.
    expect(src).toMatch(
      /if \[ -f "\\\$\(dirname "\\\$APP"\)\/\.no-sandbox" \]; then set -- "\\\$@" --no-sandbox; fi/
    )
  })

  it('installs into the user home, so no sudo is part of the default path', () => {
    const src = source(INSTALLER)
    expect(src).toMatch(/LINUX_ROOT="\$\{CODEWAIFU_LINUX_ROOT:-\$HOME\/\.local\/share\/CodeWaifu\}"/)
    expect(src).toMatch(/LINUX_BIN="\$\{CODEWAIFU_LINUX_BIN:-\$HOME\/\.local\/bin\}"/)
    // sudo appears only inside advice text, never as a command we run.
    for (const line of src.split('\n').filter((l) => l.includes('sudo '))) {
      expect(line.trim().startsWith('#') || /warn |say |  sudo /.test(line), line).toBe(true)
    }
  })

  it('sends a Git Bash user to install.ps1 instead of reporting an unknown uname', () => {
    // What a Windows user sees after pasting the macOS/Linux one-liner into Git
    // Bash. The guard must fire before anything is downloaded or written, and it
    // must name the installer that does work -- "unsupported platform:
    // MINGW64_NT-10.0-26100" is what this replaced.
    const { status, stderr, root } = runInstallerOffline([], 'MINGW64_NT-10.0-26100')
    expect(status).toBe(1)
    expect(stderr).toContain('install.ps1')
    expect(stderr).toContain('PowerShell')
    expect(stderr).not.toContain('unsupported platform')
    expect(existsSync(root)).toBe(false)
  })

  itPosix('explains a repo with no public release instead of dying on a raw curl 404', () => {
    // `set -euo pipefail` used to win the race: a failing curl inside the tag
    // lookup aborted the installer with `curl: (22) ... 404` and nothing else,
    // which reads like a broken network rather than "there is no release yet".
    const { status, stderr, root } = runInstallerOffline()
    expect(status).toBe(1)
    expect(stderr).toContain('could not resolve a release tag')
    expect(stderr).toContain('--from')
    expect(stderr).not.toMatch(/curl: \(22\)/)
    // And it gave up before writing anything into the install root.
    expect(existsSync(root)).toBe(false)
  })

  itPosix('reports a pinned tag it cannot read, rather than an empty asset list', () => {
    const { status, stderr } = runInstallerOffline(['--version', 'v9.9.9'])
    expect(status).toBe(1)
    // Linux resolves a pinned tag through the release asset list, macOS spells
    // the asset name and goes straight at the download. Both must end in a
    // sentence of their own, never in a bare curl diagnostic.
    const explained =
      stderr.includes('could not list the assets of v9.9.9') || stderr.includes('download failed:')
    expect(explained, stderr).toBe(true)
    expect(stderr.includes('curl: (22)')).toBe(false)
  })
})

/**
 * The herdr step, run for real against stubs. `curl` and `sh` are scripts in a
 * throwaway PATH and HOME is the sandbox, so a test cannot reach the network or
 * touch the machine's own herdr. The stub `sh` is what "herdr's installer ran"
 * looks like from inside install.sh, and it only creates a binary when it was
 * handed a body -- which is how a failed download stays a failed download
 * instead of turning into a phantom install.
 */
function runHerdrStep(
  args: string[],
  opts: { curlFails?: boolean; env?: Record<string, string>; setup?: (sandbox: string) => void } = {}
): {
  status: number | null
  stdout: string
  stderr: string
  calls: string[]
  herdr: string
} {
  const sandbox = mkdtempSync(join(tmpdir(), 'cw-herdr-'))
  const stubDir = join(sandbox, 'stub')
  const calls = join(sandbox, 'calls.log')
  mkdirSync(stubDir)
  writeFileSync(
    join(stubDir, 'curl'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "$CALLS"`,
      opts.curlFails ? 'exit 22' : `printf '%s\\n' 'curl -fsSL https://herdr.dev/install.sh | sh'`,
      ''
    ].join('\n')
  )
  writeFileSync(
    join(stubDir, 'sh'),
    [
      '#!/bin/sh',
      'body="$(cat)"',
      '[ -n "$body" ] || exit 0',
      'mkdir -p "$HOME/.local/bin"',
      `printf '%s\\n' '#!/bin/sh' 'exit 0' > "$HOME/.local/bin/herdr"`,
      'chmod +x "$HOME/.local/bin/herdr"',
      ''
    ].join('\n')
  )
  chmodSync(join(stubDir, 'curl'), 0o755)
  chmodSync(join(stubDir, 'sh'), 0o755)
  opts.setup?.(sandbox)
  const result = spawnSync('bash', [INSTALLER, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // A minimal PATH on purpose: the real one may contain a herdr the user
      // installed, and then "installs herdr" would silently test nothing.
      PATH: `${stubDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: sandbox,
      CALLS: calls,
      ...(opts.env ?? {})
    }
  })
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    calls: existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [],
    herdr: join(sandbox, '.local', 'bin', 'herdr')
  }
}

describe.skipIf(!hasBash)('install.sh herdr step', () => {
  /**
   * The two absolute prefixes are probed by path, not through PATH, so a runner
   * that really has herdr there has nothing to install and these cases would
   * assert a lie. GitHub's images do not ship herdr; a developer machine might.
   */
  const systemHerdr = ['/opt/homebrew/bin/herdr', '/usr/local/bin/herdr', '/usr/bin/herdr'].filter(
    (path) => existsSync(path)
  )
  /**
   * Git Bash is a real bash, so `hasBash` is true on a Windows runner and these
   * cases would run - and fail to run anything at all. `runHerdrStep` hands the
   * child a deliberately minimal POSIX PATH, because the host PATH may hold a
   * herdr the developer installed and then "installs herdr" passes vacuously;
   * that same PATH cannot resolve `bash.exe`, so Node never starts the child and
   * every status comes back null. This is the macOS/Linux installer - Windows
   * gets install.ps1, which `installWindows.test.ts` drives on a Windows runner.
   */
  const itRuns = isWindows || systemHerdr.length > 0 ? it.skip : it

  itRuns('installs herdr on the way, and says where it landed', () => {
    const run = runHerdrStep(['--herdr-only'])
    expect(run.status, run.stderr).toBe(0)
    expect(run.calls.some((line) => line.includes('https://herdr.dev/install.sh'))).toBe(true)
    expect(existsSync(run.herdr)).toBe(true)
    expect(run.stdout).toContain(`herdr installed: ${run.herdr}`)
    // The thing a user would otherwise try to do by hand: start the server.
    expect(run.stdout).toContain('the Bench starts herdr')
  })

  itRuns('an unreachable herdr installer warns and still exits 0', () => {
    // herdr is Pro's dependency, not the companion's. A blocked download here
    // must not take the app install down with it, and it must leave behind the
    // command that does work instead of a bare curl diagnostic.
    const run = runHerdrStep(['--herdr-only'], { curlFails: true })
    expect(run.status, run.stderr).toBe(0)
    expect(existsSync(run.herdr)).toBe(false)
    expect(run.stderr).toContain('herdr did not install')
    expect(run.stderr).toContain('https://herdr.dev/install.sh')
    expect(run.stderr).not.toContain('curl: (22)')
  })

  itRuns('leaves an existing herdr alone, which is what idempotent means', () => {
    const run = runHerdrStep(['--herdr-only'], {
      setup: (sandbox) => {
        mkdirSync(join(sandbox, '.local', 'bin'), { recursive: true })
        writeFileSync(join(sandbox, '.local', 'bin', 'herdr'), '#!/bin/sh\nexit 0\n')
        chmodSync(join(sandbox, '.local', 'bin', 'herdr'), 0o755)
      }
    })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('herdr is already installed')
    expect(run.calls).toEqual([])
  })

  itRuns('honours pro.herdrPath, so a custom prefix is not reinstalled over', () => {
    const run = runHerdrStep(['--herdr-only'], {
      setup: (sandbox) => {
        const custom = join(sandbox, 'custom', 'herdr')
        mkdirSync(join(sandbox, 'custom'), { recursive: true })
        writeFileSync(custom, '#!/bin/sh\nexit 0\n')
        chmodSync(custom, 0o755)
        mkdirSync(join(sandbox, '.codewaifu'), { recursive: true })
        writeFileSync(
          join(sandbox, '.codewaifu', 'config.json'),
          `${JSON.stringify({ pro: { herdrPath: custom } }, null, 2)}\n`
        )
      }
    })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('herdr is already installed')
    expect(run.calls).toEqual([])
  })

  itRuns('can be told to skip, and a test sandbox skips without being told', () => {
    // Last flag wins, which is the only sane reading of a contradictory pair.
    const off = runHerdrStep(['--herdr-only', '--no-herdr'])
    expect(off.status, off.stderr).toBe(0)
    expect(off.stdout).toContain('skipping herdr (--no-herdr)')
    expect(off.calls).toEqual([])
    // CODEWAIFU_LINUX_ROOT marks a run as a test; it must never reach for the
    // real herdr, including the network call that would fetch it.
    const sandboxed = runHerdrStep(['--herdr-only'], { env: { CODEWAIFU_LINUX_ROOT: '/tmp/unused' } })
    expect(sandboxed.status, sandboxed.stderr).toBe(0)
    expect(sandboxed.stdout).toContain('skipping herdr (installer sandbox)')
    expect(sandboxed.calls).toEqual([])
  })

  it('merges our hooks after herdr, because both write the same two files', () => {
    // herdr's installer adds its own entries to ~/.codex/hooks.json and
    // ~/.claude/settings.json. Our merge is the half of that pair with a
    // regression test for preserving a foreign writer, so it has to go last.
    const src = source(INSTALLER)
    const herdr = src.indexOf('\ninstall_herdr\n')
    const hooks = src.indexOf('registering agent hooks')
    expect(herdr).toBeGreaterThan(0)
    expect(hooks).toBeGreaterThan(herdr)
  })

  it('probes the places the app probes, so "installed" means the same to both', () => {
    // The failure this pins is silent: a herdr the app would find, but that the
    // installer does not look for, gets reinstalled on every re-run.
    const src = source(INSTALLER)
    for (const needle of [
      'HERDR_BIN_PATH',
      '.local/bin/herdr',
      '.cargo/bin/herdr',
      '/opt/homebrew/bin/herdr',
      '/usr/local/bin/herdr',
      'herdrPath'
    ]) {
      expect(src, needle).toContain(needle)
    }
  })
})
