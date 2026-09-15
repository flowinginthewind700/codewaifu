import { describe, expect, it } from 'vitest'
import {
  APP_USER_MODEL_ID,
  MAX_REGION_RECTS,
  MIN_SHAPE_SIDE,
  NO_SANDBOX_MARKER,
  USERNS_SYSCTLS,
  chromiumSwitches,
  coerceRegionRects,
  desktopAssumesCompositor,
  displayServer,
  envFlag,
  isSetuidRootHelper,
  logSandboxState,
  needsNoSandbox,
  parseCompositorProbe,
  parseSandboxProbe,
  parseStatusNotifier,
  parseUsernsSysctls,
  sandboxAdvice,
  sandboxDecision,
  sandboxState,
  sessionInfo,
  sameRegion,
  shapeForRegion,
  trayAdvice,
  unionRect,
  windowSurface,
  type SandboxFacts
} from '../src/shared/linuxRuntime'

/** The facts a healthy desktop install with a working sandbox reports. */
function facts(overrides: Partial<SandboxFacts> = {}): SandboxFacts {
  return { uid: 1000, setuidHelper: true, usernsBlocked: false, marker: false, ...overrides }
}

describe('displayServer', () => {
  it('trusts XDG_SESSION_TYPE when it names a real session', () => {
    expect(displayServer({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':1' })).toBe('wayland')
    expect(displayServer({ XDG_SESSION_TYPE: 'x11' })).toBe('x11')
  })

  it('falls back to the display variables', () => {
    expect(displayServer({ WAYLAND_DISPLAY: 'wayland-0' })).toBe('wayland')
    expect(displayServer({ DISPLAY: ':0' })).toBe('x11')
    expect(displayServer({})).toBe('none')
    expect(displayServer({ DISPLAY: '   ' })).toBe('none')
  })

  it('treats a tty with an X server as x11, because that is what Electron drives', () => {
    expect(displayServer({ XDG_SESSION_TYPE: 'tty', DISPLAY: ':1' })).toBe('x11')
    expect(displayServer({ XDG_SESSION_TYPE: 'tty' })).toBe('none')
  })

  it('reports x11 whenever DISPLAY is reachable, including under XWayland', () => {
    // The normal Ubuntu desktop: a Wayland session with XWayland running. We want
    // the X11 backend here, because positioning and global shortcuts need it.
    expect(sessionInfo({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' })).toEqual({
      display: 'wayland',
      desktop: '',
      x11: true
    })
    expect(sessionInfo({ XDG_SESSION_TYPE: 'wayland' }).x11).toBe(false)
  })

  it('picks the token that names a desktop, not merely the first one', () => {
    // Stock Ubuntu reports ubuntu:GNOME and the classic session reports
    // GNOME-Classic:GNOME. Everything we decide from this value -- does the
    // desktop composite, which tray fix to suggest -- is about the family, so
    // taking the first token files a stock Ubuntu desktop under "unknown".
    expect(sessionInfo({ XDG_CURRENT_DESKTOP: 'GNOME:GNOME' }).desktop).toBe('gnome')
    expect(sessionInfo({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }).desktop).toBe('gnome')
    expect(sessionInfo({ XDG_CURRENT_DESKTOP: 'GNOME-Classic:GNOME' }).desktop).toBe('gnome-classic')
    expect(sessionInfo({ XDG_CURRENT_DESKTOP: 'XFCE' }).desktop).toBe('xfce')
    expect(sessionInfo({ XDG_CURRENT_DESKTOP: 'somewm' }).desktop).toBe('somewm')
    expect(sessionInfo({}).desktop).toBe('')
  })
})

describe('chromiumSwitches', () => {
  it('adds the ozone hint only for a Wayland session with no XWayland', () => {
    expect(chromiumSwitches({ WAYLAND_DISPLAY: 'wayland-0' })).toEqual(['ozone-platform-hint=auto'])
    expect(chromiumSwitches({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })).toEqual([])
    expect(chromiumSwitches({ DISPLAY: ':0' })).toEqual([])
  })

  it('never adds no-sandbox: Chromium aborts before main is loaded, so only a launcher can', () => {
    // Measured on Ubuntu 24.04 with apparmor_restrict_unprivileged_userns=1:
    // appendSwitch from JS is dead code for this failure. The launcher decides.
    for (const env of [{}, { CODEWAIFU_NO_SANDBOX: '1' }, { ELECTRON_DISABLE_SANDBOX: '1' }]) {
      expect(chromiumSwitches(env), JSON.stringify(env)).not.toContain('no-sandbox')
    }
    // Nor when the uid says root: the launcher's job, not ours.
    expect(chromiumSwitches({ CODEWAIFU_SANDBOX: '' })).toEqual([])
  })
})

describe('sandboxDecision', () => {
  it('leaves the sandbox on for an ordinary desktop install', () => {
    expect(sandboxDecision({}, facts())).toEqual({ noSandbox: false, reason: 'sandbox-available' })
  })

  it('turns it off for root, which has no sandbox to run', () => {
    const decision = sandboxDecision({}, facts({ uid: 0 }))
    expect(decision.noSandbox).toBe(true)
    expect(decision.reason).toBe('running-as-root')
  })

  it('turns it off when userns is blocked and the helper is not setuid root', () => {
    // The Ubuntu 24.04 user-space case: apparmor_restrict_unprivileged_userns=1
    // plus a chrome-sandbox owned by the user, whose setuid bit the kernel
    // ignores. Measured: exit 133, "SUID sandbox helper ... not configured
    // correctly".
    const decision = sandboxDecision({}, facts({ setuidHelper: false, usernsBlocked: true }))
    expect(decision.noSandbox).toBe(true)
    expect(decision.reason).toBe('userns-restricted-no-setuid-helper')
  })

  it('keeps the sandbox when userns is blocked but a setuid root helper exists', () => {
    // What the deb's postinst produces: chmod 4755 on a root-owned helper.
    expect(sandboxDecision({}, facts({ setuidHelper: true, usernsBlocked: true })).noSandbox).toBe(false)
  })

  it('keeps the sandbox when the helper is fine and userns is merely unknown', () => {
    expect(sandboxDecision({}, facts({ usernsBlocked: null })).noSandbox).toBe(false)
  })

  it('trusts the installer probe above every guess', () => {
    const decision = sandboxDecision({}, facts({ marker: true, setuidHelper: true }))
    expect(decision.noSandbox).toBe(true)
    expect(decision.reason).toContain('installer-probe')
  })

  it('lets an explicit operator choice win over the measurement', () => {
    expect(sandboxDecision({ CODEWAIFU_SANDBOX: '1' }, facts({ uid: 0, marker: true }))).toEqual({
      noSandbox: false,
      reason: 'env-override:CODEWAIFU_SANDBOX'
    })
    expect(sandboxDecision({ CODEWAIFU_NO_SANDBOX: 'yes' }, facts()).noSandbox).toBe(true)
    expect(sandboxDecision({ ELECTRON_DISABLE_SANDBOX: '1' }, facts()).noSandbox).toBe(true)
  })

  it('names a reason for every answer it gives', () => {
    for (const decision of [
      sandboxDecision({}, facts()),
      sandboxDecision({}, facts({ uid: 0 })),
      sandboxDecision({}, facts({ marker: true })),
      sandboxDecision({}, facts({ setuidHelper: false, usernsBlocked: true }))
    ]) {
      expect(decision.reason.length).toBeGreaterThan(3)
    }
  })

  it('agrees with the env-only shorthand it supersedes', () => {
    expect(needsNoSandbox({}, 0)).toBe(true)
    expect(needsNoSandbox({ CODEWAIFU_SANDBOX: '1' }, 0)).toBe(false)
    expect(needsNoSandbox({ CODEWAIFU_NO_SANDBOX: '1' }, 1000)).toBe(true)
    expect(needsNoSandbox({}, 1000)).toBe(false)
  })
})

describe('envFlag', () => {
  it('accepts the usual truthy spellings and nothing else', () => {
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(envFlag({ X: value }, 'X'), value).toBe(true)
    }
    for (const value of ['', '0', 'false', 'no', 'off', 'enabled', undefined]) {
      expect(envFlag({ X: value }, 'X'), String(value)).toBe(false)
    }
  })
})

describe('isSetuidRootHelper', () => {
  it('needs both the setuid bit and root ownership', () => {
    // A user-owned 4755 file looks like a sandbox helper and does nothing: the
    // kernel ignores setuid on a file the caller already owns. That is the exact
    // state of an AppImage extracted into ~/.local/share.
    expect(isSetuidRootHelper({ mode: 0o4755, uid: 0 })).toBe(true)
    expect(isSetuidRootHelper({ mode: 0o4755, uid: 1000 })).toBe(false)
    expect(isSetuidRootHelper({ mode: 0o755, uid: 0 })).toBe(false)
    expect(isSetuidRootHelper(null)).toBe(false)
    expect(isSetuidRootHelper(undefined)).toBe(false)
    expect(isSetuidRootHelper({ mode: NaN, uid: 0 })).toBe(false)
  })
})

describe('parseUsernsSysctls', () => {
  it('reads the two sysctls that gate unprivileged user namespaces', () => {
    expect(USERNS_SYSCTLS).toContain('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
    expect(parseUsernsSysctls({})).toBeNull()
    expect(
      parseUsernsSysctls({
        '/proc/sys/kernel/unprivileged_userns_clone': '1',
        '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1'
      })
    ).toBe(true)
    expect(parseUsernsSysctls({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0' })).toBe(false)
    expect(parseUsernsSysctls({ '/proc/sys/kernel/unprivileged_userns_clone': '0' })).toBe(true)
    expect(parseUsernsSysctls({ '/proc/sys/kernel/unprivileged_userns_clone': '1' })).toBe(false)
    expect(parseUsernsSysctls({ '/proc/sys/kernel/unprivileged_userns_clone': ' 1\n' })).toBe(false)
  })
})

describe('parseSandboxProbe', () => {
  const abort =
    '[1565747:0915/094606.705595:FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:166] ' +
    'The SUID sandbox helper binary was found, but is not configured correctly. ' +
    "Rather than run without sandboxing I'm aborting now."

  it('recognises the real Ubuntu 24.04 abort, which is the whole point of the probe', () => {
    expect(parseSandboxProbe({ status: 133, output: abort })).toEqual({
      aborted: true,
      reason: 'sandbox-abort'
    })
  })

  it('recognises the other ways Chromium refuses a sandbox', () => {
    for (const output of [
      'FATAL: No usable sandbox!',
      'FATAL: namespace sandbox not enabled',
      'Failed to move to new namespace: PID namespaces supported',
      'Running as root without --no-sandbox is not allowed'
    ]) {
      expect(parseSandboxProbe({ status: 1, output }).aborted, output).toBe(true)
    }
  })

  it('calls a clean exit a pass', () => {
    expect(parseSandboxProbe({ status: 0, output: 'CodeWaifu CLI\n\nUsage:' })).toEqual({
      aborted: false,
      reason: 'probe-ok'
    })
  })

  it('refuses to read a sandbox verdict into an unrelated failure', () => {
    // A missing libgtk or a headless box is not evidence about the sandbox, and
    // guessing here would disable it permanently for a fixable problem.
    const result = parseSandboxProbe({
      status: 127,
      output: 'error while loading shared libraries: libgtk-3.so.0'
    })
    expect(result.aborted).toBe(false)
    expect(result.reason).toContain('inconclusive')
  })
})

describe('sandboxState', () => {
  it('reports what argv actually carried, not what we would have preferred', () => {
    expect(sandboxState(['codewaifu'])).toEqual({ enabled: true, source: 'chromium-default' })
    expect(sandboxState(['codewaifu', '--cli', 'status', '--no-sandbox'])).toEqual({
      enabled: false,
      source: 'argv:--no-sandbox'
    })
    expect(sandboxState(['codewaifu'], { ELECTRON_DISABLE_SANDBOX: '1' }).enabled).toBe(false)
  })

  it('reads as a sentence in the log', () => {
    expect(logSandboxState(['codewaifu'])).toBe('enabled')
    expect(logSandboxState(['codewaifu', '--no-sandbox'])).toBe('disabled (argv:--no-sandbox)')
  })
})

describe('sandboxAdvice', () => {
  it('points at the two real cures for a restricted kernel', () => {
    const advice = sandboxAdvice('userns-restricted-no-setuid-helper')
    expect(advice).toContain('.deb')
    expect(advice).toContain('apparmor_restrict_unprivileged_userns')
    expect(advice).toContain(NO_SANDBOX_MARKER)
  })

  it('tells root to stop being root instead of suggesting a sysctl', () => {
    expect(sandboxAdvice('running-as-root')).toContain('normal user account')
  })
})

describe('windowSurface', () => {
  const gnome = sessionInfo({ XDG_CURRENT_DESKTOP: 'GNOME', DISPLAY: ':0' })
  const openbox = sessionInfo({ XDG_CURRENT_DESKTOP: 'Openbox', DISPLAY: ':0' })

  it('keeps transparency when a compositor is running', () => {
    expect(windowSurface({}, gnome, 'present')).toEqual({
      transparent: true,
      backgroundColor: '#00000000',
      reason: 'composited'
    })
  })

  it('goes opaque rather than painting the companion black', () => {
    const surface = windowSurface({}, openbox, 'absent')
    expect(surface.transparent).toBe(false)
    expect(surface.reason).toBe('no-compositor')
    expect(surface.backgroundColor).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('trusts a desktop that always composites when the probe is inconclusive', () => {
    expect(desktopAssumesCompositor('gnome')).toBe(true)
    expect(desktopAssumesCompositor('KDE')).toBe(true)
    expect(desktopAssumesCompositor('openbox')).toBe(false)
    expect(windowSurface({}, gnome, 'absent').transparent).toBe(true)
    expect(windowSurface({}, gnome, 'unknown').reason).toBe('compositor-unknown')
  })

  it('treats a GNOME flavour as GNOME, which is what Ubuntu Classic reports', () => {
    expect(desktopAssumesCompositor('gnome-classic')).toBe(true)
    expect(desktopAssumesCompositor('GNOME-Flashback')).toBe(true)
    expect(desktopAssumesCompositor('plasma')).toBe(true)
    // A shared prefix is not a family.
    expect(desktopAssumesCompositor('gnometweaks')).toBe(false)
  })

  it('honours CODEWAIFU_OPAQUE above every probe', () => {
    expect(windowSurface({ CODEWAIFU_OPAQUE: '1' }, gnome, 'present').reason).toBe('env-override')
  })
})

describe('parseCompositorProbe', () => {
  it('reads the _NET_WM_CM_S0 selection ownership', () => {
    expect(parseCompositorProbe({ ok: true, stdout: '_NET_WM_CM_S0(WINDOW): window id # 0x1c00006' })).toBe(
      'present'
    )
    expect(parseCompositorProbe({ ok: false, stdout: '', stderr: 'xprop: error: not found' })).toBe('absent')
    expect(parseCompositorProbe({ ok: true, stdout: 'xprop: property not found' })).toBe('absent')
    expect(parseCompositorProbe({ ok: false, stdout: '', stderr: 'xprop: unable to open display' })).toBe(
      'unknown'
    )
  })
})

describe('trayAdvice', () => {
  it('stays quiet when a StatusNotifier host owns the bus name', () => {
    expect(parseStatusNotifier({ ok: true, stdout: "(':1.53',)" })).toBe(true)
    expect(trayAdvice(true, 'gnome')).toBeNull()
  })

  it('names the extension GNOME needs, because the tray fails silently', () => {
    expect(parseStatusNotifier({ ok: false, stdout: '' })).toBe(false)
    expect(parseStatusNotifier({ ok: true, stdout: 'Error: name has no owner' })).toBe(false)
    expect(trayAdvice(false, 'gnome')).toContain('gnome-shell-extension-appindicator')
    expect(trayAdvice(false, '')).toContain('gnome-shell-extension-appindicator')
    expect(trayAdvice(false, 'xfce')).toContain('libayatana-appindicator3-1')
    // Found on the machine this support was built on: GNOME-Classic:GNOME was
    // being told to install the ayatana library, which GNOME does not use.
    expect(trayAdvice(false, 'gnome-classic')).toContain('gnome-shell-extension-appindicator')
  })
})

describe('unionRect', () => {
  it('bounds the boxes it is given', () => {
    expect(
      unionRect([
        { x: 10, y: 20, width: 30, height: 40 },
        { x: 0, y: 0, width: 5, height: 5 }
      ])
    ).toEqual({ x: 0, y: 0, width: 40, height: 60 })
  })

  it('ignores degenerate boxes and returns null for nothing usable', () => {
    expect(unionRect([])).toBeNull()
    expect(unionRect([{ x: 0, y: 0, width: 0, height: 10 }])).toBeNull()
    expect(unionRect([{ x: NaN, y: 0, width: 10, height: 10 }])).toBeNull()
    expect(
      unionRect([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 0, y: 0, width: 0, height: 0 }
      ])
    ).toEqual({ x: 0, y: 0, width: 10, height: 10 })
  })
})

describe('shapeForRegion', () => {
  const bounds = { x: 0, y: 0, width: 320, height: 480 }

  it('clamps to the window frame and rounds to whole pixels', () => {
    expect(shapeForRegion({ x: -20.4, y: 0.6, width: 900, height: 100 }, bounds)).toEqual({
      x: 0,
      y: 1,
      width: 320,
      height: 100
    })
  })

  it('grows a tiny region up to MIN_SHAPE_SIDE instead of shaping the window away', () => {
    expect(shapeForRegion({ x: 0, y: 0, width: 4, height: 4 }, bounds)).toEqual({
      x: 0,
      y: 0,
      width: MIN_SHAPE_SIDE,
      height: MIN_SHAPE_SIDE
    })
  })

  it('returns null when there is no region or no usable bounds', () => {
    // The bug this guards: setShape([]) on Linux is not "reset to the whole
    // window", it is a shape with no area. Nothing can ever click the companion
    // again, and the window is still there taking up the screen.
    expect(shapeForRegion(null, bounds)).toBeNull()
    expect(shapeForRegion({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 0, height: 0 })).toBeNull()
    expect(
      shapeForRegion({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: NaN, height: 100 })
    ).toBeNull()
  })

  it('keeps at least MIN_SHAPE_SIDE of the region inside the frame', () => {
    const shaped = shapeForRegion({ x: 318, y: 478, width: 100, height: 100 }, bounds)
    expect(shaped).not.toBeNull()
    expect(shaped!.x).toBeLessThanOrEqual(bounds.width - MIN_SHAPE_SIDE)
    expect(shaped!.width).toBeGreaterThanOrEqual(MIN_SHAPE_SIDE)
    expect(shaped!.x + shaped!.width).toBeLessThanOrEqual(bounds.width)
  })

  it('treats sub-pixel drift as the same region so the shape does not thrash', () => {
    expect(
      sameRegion({ x: 0, y: 0, width: 100, height: 100 }, { x: 1, y: 1, width: 101, height: 101 })
    ).toBe(true)
    expect(
      sameRegion({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 9, width: 100, height: 100 })
    ).toBe(false)
    expect(sameRegion(null, null)).toBe(true)
    expect(sameRegion(null, { x: 0, y: 0, width: 1, height: 1 })).toBe(false)
  })
})

describe('coerceRegionRects', () => {
  it('drops anything that is not a finite positive box', () => {
    expect(
      coerceRegionRects([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 0, y: 0, width: -1, height: 10 },
        { x: 0, y: 0, width: NaN, height: 10 },
        { x: 0, y: 0 },
        null,
        'nope',
        42
      ])
    ).toEqual([{ x: 0, y: 0, width: 10, height: 10 }])
  })

  it('coerces numeric strings, because getBoundingClientRect is not the only caller', () => {
    expect(coerceRegionRects([{ x: '1', y: '2', width: '3', height: '4' }])).toEqual([
      { x: 1, y: 2, width: 3, height: 4 }
    ])
  })

  it('caps the payload instead of trusting a page to send a sane one', () => {
    const many = Array.from({ length: MAX_REGION_RECTS + 500 }, (_, i) => ({
      x: i,
      y: 0,
      width: 1,
      height: 1
    }))
    expect(coerceRegionRects(many)).toHaveLength(MAX_REGION_RECTS)
    expect(coerceRegionRects(many, 3)).toHaveLength(3)
    expect(coerceRegionRects('not an array')).toEqual([])
    expect(coerceRegionRects(undefined)).toEqual([])
  })
})

describe('APP_USER_MODEL_ID', () => {
  it('is the electron-builder appId, or GNOME files notifications under a generic icon', () => {
    expect(APP_USER_MODEL_ID).toBe('top.robotworld.codewaifu')
  })
})
