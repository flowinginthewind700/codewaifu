import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const LIB = fileURLToPath(new URL('../scripts/lib/assets.sh', import.meta.url))
const INSTALLER = fileURLToPath(new URL('../scripts/install.sh', import.meta.url))

/** Skip rather than fail where the runner has no POSIX shell (a bare Windows box). */
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0

function run(script: string, args: string[] = [], input = ''): { status: number | null; stdout: string } {
  const result = spawnSync('bash', ['-c', `. "$0"; ${script}`, LIB, ...args], { input, encoding: 'utf8' })
  return { status: result.status, stdout: String(result.stdout ?? '').trim() }
}

function pickAsset(os: string, arch: string, exts: string[], names: string[]): string | null {
  const { status, stdout } = run('pick_asset "$@"', [os, arch, ...exts], names.join('\n') + '\n')
  return status === 0 && stdout ? stdout : null
}

function source(path: string): string {
  return String(spawnSync('cat', [path], { encoding: 'utf8' }).stdout ?? '')
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
})
