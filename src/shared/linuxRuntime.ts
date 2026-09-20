/**
 * Linux desktop plumbing.
 *
 * Everything here is pure so it can be unit tested without a display server,
 * and so `main` never has to reason about environment variables inline. Four
 * things really do differ from macOS and Windows:
 *
 * 1. **Input shape.** `setIgnoreMouseEvents(through, { forward: true })` — the
 *    trick that lets the widget pass clicks through its empty margins while
 *    still noticing the pointer come back — documents `forward` as
 *    `@platform darwin,win32`. On Linux the window goes click-through and never
 *    hears another mousemove, so the companion would be unclickable until a
 *    restart. Linux therefore drives `setShape()` instead: pixels and pointer
 *    events outside the region fall through to whatever is underneath, and the
 *    region itself stays fully interactive.
 * 2. **Transparency needs a compositor.** Without one `transparent: true`
 *    paints the window black, so the policy degrades to an opaque surface
 *    rather than shipping a companion that looks broken.
 * 3. **The tray needs a StatusNotifier host.** GNOME Shell does not provide one
 *    out of the box; Ubuntu does (gnome-shell-extension-appindicator). When the
 *    bus name is missing the icon silently never appears, so we probe for it and
 *    log the one-line fix instead of leaving the user guessing.
 * 4. **The sandbox.** Chromium refuses to start its setuid sandbox as root, and
 *    Ubuntu 24.04+ refuses unprivileged user namespaces to any binary that is
 *    not covered by an AppArmor profile. Both cases end in the same FATAL
 *    abort, and neither can be fixed from JavaScript — see `sandboxDecision`.
 */

import fs from 'node:fs'

export type DisplayServer = 'x11' | 'wayland' | 'none'

/** Anything env-shaped; `process.env` satisfies it. */
export interface EnvLike {
  [key: string]: string | undefined
}

/**
 * Must match `appId` in electron-builder.yml: the `.desktop` file, the D-Bus
 * notification identity and `app.setAppUserModelId()` all have to agree or GNOME
 * shows notifications under a generic icon.
 */
export const APP_USER_MODEL_ID = 'top.robotworld.codewaifu'

/** Truthy spellings accepted in env flags. Anything else means off. */
export function envFlag(env: EnvLike, name: string): boolean {
  const raw = String(env[name] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * What the session runs. `XDG_SESSION_TYPE` is authoritative when present;
 * the display variables are the fallback for sessions that do not export it.
 *
 * Note that a Wayland session usually *also* exports `DISPLAY`, because
 * XWayland is running. That combination is the normal Ubuntu desktop, and it is
 * the one Electron's default X11 backend drives.
 */
export function displayServer(env: EnvLike = process.env): DisplayServer {
  const declared = String(env.XDG_SESSION_TYPE ?? '').trim().toLowerCase()
  if (declared === 'wayland' || declared === 'x11' || declared === 'tty') {
    if (declared === 'tty') return Boolean(env.DISPLAY) ? 'x11' : 'none'
    return declared
  }
  if (String(env.WAYLAND_DISPLAY ?? '').trim()) return 'wayland'
  if (String(env.DISPLAY ?? '').trim()) return 'x11'
  return 'none'
}

/**
 * The `XDG_CURRENT_DESKTOP` token worth deciding on, lowercased.
 *
 * It is a colon list and the first entry is not always the informative one:
 * stock Ubuntu reports `ubuntu:GNOME`, the classic session reports
 * `GNOME-Classic:GNOME`. Every decision below is about the desktop *family*, so
 * prefer the first token that names one we recognise (`gnome`) and fall back to
 * the first token (`ubuntu` on its own is still useful in a log line).
 */
export function desktopOf(env: EnvLike = process.env): string {
  const tokens = String(env.XDG_CURRENT_DESKTOP ?? '')
    .split(/[:;]/)
    .map((token) => token.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
    .filter(Boolean)
  if (!tokens.length) return ''
  return tokens.find((token) => inFamily(token, KNOWN_DESKTOP_FAMILIES)) ?? tokens[0]
}

export interface LinuxSession {
  display: DisplayServer
  desktop: string
  /**
   * True when Electron will reach an X server, directly or through XWayland.
   * Drag, always-on-top, the global hotkey and input shapes all need this; on a
   * pure Wayland backend none of them work, which is why such a session is the
   * only one that gets the ozone hint.
   */
  x11: boolean
}

export function sessionInfo(env: EnvLike = process.env): LinuxSession {
  const display = displayServer(env)
  return { display, desktop: desktopOf(env), x11: Boolean(String(env.DISPLAY ?? '').trim()) }
}

/**
 * Chromium switches to append before `app.ready`.
 *
 * `ozone-platform-hint=auto` is deliberately narrow: it is only for a Wayland
 * session with no XWayland `DISPLAY`, where Electron would otherwise die with
 * "Missing X server or $DISPLAY". Everywhere else we *want* the X11 backend,
 * because it is the only one where window positioning, always-on-top and
 * global shortcuts behave.
 *
 * ⛔ `no-sandbox` is NOT in this list and must never be added here. Measured on
 * Ubuntu 24.04 (`apparmor_restrict_unprivileged_userns=1`): the packaged binary
 * aborts with "The SUID sandbox helper is not configured correctly" before the
 * Node main bundle is even loaded, so `app.commandLine.appendSwitch` runs too
 * late to matter. Only a real `--no-sandbox` argv flag or
 * `ELECTRON_DISABLE_SANDBOX=1` in the environment gets through, which makes the
 * launcher (install shim / `bin/codewaifu.mjs`) the only place that can decide.
 * `sandboxDecision` below is the shared rule so every launcher agrees.
 */
export function chromiumSwitches(
  env: EnvLike = process.env
): string[] {
  const switches: string[] = []
  if (!String(env.DISPLAY ?? '').trim() && String(env.WAYLAND_DISPLAY ?? '').trim()) {
    switches.push('ozone-platform-hint=auto')
  }
  return switches
}

// ---------------------------------------------------------------------------
// XWayland relaunch
// ---------------------------------------------------------------------------

/**
 * The Chromium switch that puts a Wayland session back on XWayland. Electron
 * 38 removed `ELECTRON_OZONE_PLATFORM_HINT` and made native Wayland the
 * default, where the compositor forbids `setPosition` and the avatar cannot be
 * dragged. `app.commandLine.appendSwitch` is too late for this decision, so
 * the flag has to be in the real argv of a fresh process.
 */
export const X11_OZONE_SWITCH = '--ozone-platform=x11'

/** The X server socket a `DISPLAY` value maps to, or null when it is not local. */
export function x11SocketPath(display: string): string | null {
  const match = /^(?:[A-Za-z0-9._-]*):([0-9]+)(?:\.[0-9]+)?$/.exec(display.trim())
  return match ? `/tmp/.X11-unix/X${match[1]}` : null
}

/**
 * Args for a one-time relaunch onto XWayland, or null when it is not wanted.
 *
 * Electron 38+ prefers native Wayland whenever the session is Wayland, even
 * with XWayland's `DISPLAY` sitting right there. Native Wayland breaks
 * `setPosition` (the avatar drag), always-on-top and global shortcuts, so a GUI
 * start on a Wayland session with a reachable X server re-execs once with the
 * X11 ozone switch.
 *
 * Two ways out, and both are load-bearing:
 *
 * - An explicit `--ozone-platform=<anything>` in argv. The operator asked, and
 *   the relaunch would only fight them. It is also what a test harness or any
 *   other process supervisor has to pass, because `app.relaunch` + `app.quit`
 *   replaces this process with one nobody is watching: Playwright's
 *   `electron.launch` times out on a child that quits before it paints, and the
 *   relaunched app is left running as an orphan on the user's desktop.
 * - A session that is not Wayland. On X11 Electron already picks the X11
 *   backend, so the bounce buys nothing and costs a window that never appears
 *   under the process the user started. Measured on a plain Xorg desktop
 *   (`loginctl show-session` reports `Type=x11`): `DISPLAY` is set and
 *   `/tmp/.X11-unix/X<n>` exists, so a rule that only looked at those two
 *   relaunched anyway.
 */
export function x11RelaunchArgs(
  argv: readonly string[],
  env: EnvLike,
  exists: (path: string) => boolean = fs.existsSync
): string[] | null {
  if (argv.some((arg) => arg.startsWith('--ozone-platform='))) return null
  // Positive evidence of Wayland, not merely the absence of evidence against
  // it: `displayServer` reports `x11` for a `DISPLAY` with no session type,
  // which is what a headless Xvfb looks like, and there is nothing to escape.
  if (displayServer(env) !== 'wayland') return null
  const display = String(env.DISPLAY ?? '').trim()
  if (!display) return null
  const socket = x11SocketPath(display)
  if (!socket || !exists(socket)) {
    return null
  }
  return [...argv.slice(1), X11_OZONE_SWITCH]
}

/**
 * Env-only half of the sandbox rule, kept for callers that have not stat'ed the
 * install directory yet. `sandboxDecision` is the complete one.
 */
export function needsNoSandbox(env: EnvLike = process.env, uid: number | null = null): boolean {
  if (envFlag(env, 'CODEWAIFU_SANDBOX')) return false
  if (envFlag(env, 'CODEWAIFU_NO_SANDBOX')) return true
  return uid === 0
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

/*
 * Who actually decides, in order of preference:
 *
 * 1. `AppRun`, the launcher electron-builder puts in every AppImage/AppDir. It
 *    runs `unshare -Ur true` on each start and adds `--no-sandbox` when that
 *    fails, which is exactly the Ubuntu 24.04+ case. Launching through it costs
 *    nothing and inherits a rule maintained upstream. Measured: on Ubuntu 24.04
 *    with `kernel.apparmor_restrict_unprivileged_userns=1` the probe fails with
 *    "write failed /proc/self/uid_map: Operation not permitted", and both
 *    `./CodeWaifu-*.AppImage --cli help` and `./squashfs-root/AppRun --cli help`
 *    exit 0.
 * 2. A root-installed .deb: its postinst installs `/etc/apparmor.d/codewaifu`
 *    (granting userns) and chmods `chrome-sandbox` 4755 when `unshare --user`
 *    fails. That is the only fully sandboxed user-space path, and why the
 *    installer points people at it.
 * 3. A bare build directory (`linux-unpacked/`, no AppRun, no profile). Here
 *    the raw binary FATAL-aborts -- measured exit 133 with "The SUID sandbox
 *    helper binary was found, but is not configured correctly" -- so the
 *    installer probes it once and leaves the marker below.
 */

/**
 * Marker the installer drops next to the binary after an empirical launch probe
 * failed. It is the authoritative answer: it was produced by *this* binary on
 * *this* kernel, not by a rule that guesses.
 */
export const NO_SANDBOX_MARKER = '.no-sandbox'

/** Sysctls that decide whether an unprivileged process may create a userns. */
export const USERNS_SYSCTLS = [
  '/proc/sys/kernel/unprivileged_userns_clone', // Debian/Ubuntu knob
  '/proc/sys/kernel/apparmor_restrict_unprivileged_userns' // Ubuntu 23.10+
] as const

export interface SandboxFacts {
  /** `process.getuid()`, or null where the platform has no uid. */
  uid: number | null
  /**
   * The `chrome-sandbox` helper beside the binary is setuid **and owned by
   * root**. Both halves matter: the kernel ignores the setuid bit on a
   * user-owned file, which is exactly the state of an AppImage extracted into
   * `~/.local/share` — it looks like a sandbox helper and does nothing.
   */
  setuidHelper: boolean
  /** Kernel/AppArmor refuse unprivileged user namespaces. Null: cannot tell. */
  usernsBlocked: boolean | null
  /** The installer's launch probe wrote `NO_SANDBOX_MARKER`. */
  marker: boolean
}

export interface SandboxDecision {
  noSandbox: boolean
  /** Always populated: every refusal to run sandboxed has to say why. */
  reason: string
}

/**
 * Decide whether a launcher must pass `--no-sandbox`. Pure, so the npm CLI, the
 * generated install shim and the tests all run the same rule.
 *
 * Order is the order of confidence: an explicit operator choice beats a
 * measurement of this machine, which beats a guess from sysctls.
 */
export function sandboxDecision(env: EnvLike = process.env, facts: SandboxFacts): SandboxDecision {
  if (envFlag(env, 'CODEWAIFU_SANDBOX')) {
    return { noSandbox: false, reason: 'env-override:CODEWAIFU_SANDBOX' }
  }
  if (envFlag(env, 'CODEWAIFU_NO_SANDBOX')) {
    return { noSandbox: true, reason: 'env-override:CODEWAIFU_NO_SANDBOX' }
  }
  if (envFlag(env, 'ELECTRON_DISABLE_SANDBOX')) {
    return { noSandbox: true, reason: 'env:ELECTRON_DISABLE_SANDBOX' }
  }
  if (facts.marker) return { noSandbox: true, reason: `installer-probe:${NO_SANDBOX_MARKER}` }
  if (facts.uid === 0) return { noSandbox: true, reason: 'running-as-root' }
  if (facts.usernsBlocked && !facts.setuidHelper) {
    return { noSandbox: true, reason: 'userns-restricted-no-setuid-helper' }
  }
  return { noSandbox: false, reason: 'sandbox-available' }
}

/** `stat()` of the helper -> is it a real setuid-root sandbox? */
export function isSetuidRootHelper(stat: { mode: number; uid: number } | null | undefined): boolean {
  if (!stat) return false
  const mode = Number(stat.mode)
  if (!Number.isFinite(mode)) return false
  return (mode & 0o4000) !== 0 && Number(stat.uid) === 0
}

/**
 * Read the userns sysctls. `unprivileged_userns_clone=0` is a hard no;
 * `apparmor_restrict_unprivileged_userns=1` means "only profiled binaries may",
 * which for an unpacked AppImage is also a no. No file present -> null, i.e.
 * "this kernel does not gate userns, so do not touch the sandbox".
 */
export function parseUsernsSysctls(reads: Record<string, string | null | undefined>): boolean | null {
  let seen = false
  for (const path of USERNS_SYSCTLS) {
    const raw = reads[path]
    if (raw == null) continue
    seen = true
    const value = String(raw).trim()
    if (!value) continue
    if (path.endsWith('apparmor_restrict_unprivileged_userns')) {
      if (value !== '0') return true
    } else if (value === '0') {
      return true
    }
  }
  return seen ? false : null
}

/** The two lines Chromium prints when it gives up on the sandbox. */
const SANDBOX_ABORT =
  /suid sandbox helper|no usable sandbox|namespace sandbox|Failed to move to new namespace|running as root without --no-sandbox/i

/**
 * Classify a headless `$BIN --cli help` probe. The CLI path never opens a
 * window, so it is the cheapest way to find out whether *this* binary can start
 * on *this* kernel — and it works over SSH with no display at all.
 */
export function parseSandboxProbe(result: {
  status: number | null
  output: string
}): { aborted: boolean; reason: string } {
  const output = String(result.output ?? '')
  if (SANDBOX_ABORT.test(output)) {
    return { aborted: true, reason: 'sandbox-abort' }
  }
  if (result.status === 0) return { aborted: false, reason: 'probe-ok' }
  // Any other failure (missing lib, no display for a GUI-only build) is not
  // evidence about the sandbox, and guessing here would disable it for good.
  return { aborted: false, reason: `probe-inconclusive:status=${result.status}` }
}

/**
 * What sandbox state this process actually got, read from argv because that is
 * what Chromium itself looked at. A flag injected by AppRun, by the install
 * shim, by `bin/codewaifu.mjs` or by a user all show up identically here, so the
 * log line answers "why is my companion unsandboxed?" without any guessing.
 */
export function sandboxState(
  argv: readonly string[] = process.argv,
  env: EnvLike = process.env
): { enabled: boolean; source: string } {
  if (argv.some((arg) => arg === '--no-sandbox')) return { enabled: false, source: 'argv:--no-sandbox' }
  if (envFlag(env, 'ELECTRON_DISABLE_SANDBOX')) {
    return { enabled: false, source: 'env:ELECTRON_DISABLE_SANDBOX' }
  }
  return { enabled: true, source: 'chromium-default' }
}

/**
 * One boot-time log payload for the sandbox. Kept separate from
 * `sandboxDecision` because the two answer different questions: the decision is
 * what a *launcher* should pass, the state is what *we* were given.
 */
export function logSandboxState(
  argv: readonly string[] = process.argv,
  env: EnvLike = process.env
): string {
  const state = sandboxState(argv, env)
  return state.enabled ? 'enabled' : `disabled (${state.source})`
}

/**
 * How to get the sandbox back. Printed by the installer whenever it has to fall
 * back to `--no-sandbox`, so the tradeoff is on the record instead of buried.
 */
export function sandboxAdvice(reason: string): string {
  if (reason === 'running-as-root') {
    return 'running as root: Chromium has no sandbox for that, so use a normal user account'
  }
  return (
    'Chromium will run unsandboxed here. To get the sandbox back, either ' +
    'sudo apt install ./CodeWaifu-*-linux-amd64.deb (its postinst installs an AppArmor profile ' +
    'that grants user namespaces and chmods chrome-sandbox 4755), or ' +
    'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0. ' +
    'Then delete the .no-sandbox marker in the install directory.'
  )
}

// ---------------------------------------------------------------------------
// Window surface
// ---------------------------------------------------------------------------

export type CompositorProbe = 'present' | 'absent' | 'unknown'

/**
 * The compositing manager announces itself by owning the `_NET_WM_CM_S0`
 * selection on the root window. `xprop` exits non-zero and says "not found"
 * when nobody owns it, which is the signal we want.
 */
export function compositorProbeCommand(): { cmd: string; args: string[] } {
  return { cmd: 'xprop', args: ['-root', '-notype', '_NET_WM_CM_S0'] }
}

export function parseCompositorProbe(result: {
  ok: boolean
  stdout: string
  stderr?: string
}): CompositorProbe {
  const out = String(result.stdout ?? '')
  if (/_NET_WM_CM_S0/.test(out)) return 'present'
  const text = `${out} ${String(result.stderr ?? '')}`.toLowerCase()
  if (result.ok && /not found/.test(text)) return 'absent'
  if (!result.ok && /not found|no such|invalid/i.test(text)) return 'absent'
  return 'unknown'
}

/** Desktops that always composite, so an inconclusive probe is still safe. */
const COMPOSITED_FAMILIES = [
  'gnome',
  'kde',
  'plasma',
  'unity',
  'budgie',
  'cinnamon',
  'deepin',
  'dde',
  'pantheon',
  'enlightenment'
] as const

/** Everything we can name, composited or not; used to pick the useful token. */
const KNOWN_DESKTOP_FAMILIES = [
  ...COMPOSITED_FAMILIES,
  'xfce',
  'lxde',
  'lxqt',
  'mate',
  'ukui',
  'cosmic',
  'hyprland',
  'sway',
  'i3',
  'openbox'
] as const

/**
 * Family match, so a flavour counts as its desktop: `gnome-classic` is GNOME and
 * composites exactly as reliably. Equality alone would send Ubuntu's classic
 * session down the "we have no idea what this is" path.
 */
function inFamily(name: string, families: readonly string[]): boolean {
  return families.some((family) => name === family || name.startsWith(`${family}-`))
}

export function desktopAssumesCompositor(desktop: string): boolean {
  return inFamily(String(desktop || '').trim().toLowerCase(), COMPOSITED_FAMILIES)
}

export interface WindowSurface {
  transparent: boolean
  backgroundColor: string
  /** Recorded in the log; every refusal has to say why. */
  reason: string
}

/**
 * Transparency, or the honest reason it was refused. `CODEWAIFU_OPAQUE=1` is the
 * escape hatch for a window manager we cannot detect and for screen sharing
 * setups that render alpha as black.
 */
export function windowSurface(
  env: EnvLike = process.env,
  session: LinuxSession = sessionInfo(env),
  compositor: CompositorProbe = 'unknown'
): WindowSurface {
  if (envFlag(env, 'CODEWAIFU_OPAQUE')) {
    return { transparent: false, backgroundColor: OPAQUE_BACKGROUND, reason: 'env-override' }
  }
  if (compositor === 'absent' && !desktopAssumesCompositor(session.desktop)) {
    return { transparent: false, backgroundColor: OPAQUE_BACKGROUND, reason: 'no-compositor' }
  }
  const reason =
    compositor === 'present'
      ? 'composited'
      : compositor === 'absent' // only reachable for a desktop that always composites
        ? 'desktop-composites'
        : 'compositor-unknown'
  return { transparent: true, backgroundColor: '#00000000', reason }
}

/** One shade under the card's own sheet, so an opaque window still looks intentional. */
export const OPAQUE_BACKGROUND = '#111214'

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

export const STATUS_NOTIFIER_WATCHER = 'org.kde.StatusNotifierWatcher'

/**
 * Ask the session bus who owns the StatusNotifier watcher. `gdbus` ships with
 * glib and is on every Ubuntu desktop; a missing owner comes back as an error
 * exit, which is exactly the answer we want.
 */
export function statusNotifierProbe(): { cmd: string; args: string[] } {
  return {
    cmd: 'gdbus',
    args: [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.DBus',
      '--object-path',
      '/org/freedesktop/DBus',
      '--method',
      'org.freedesktop.DBus.GetNameOwner',
      STATUS_NOTIFIER_WATCHER
    ]
  }
}

/** A successful call prints `('owner-name',)`; a missing owner exits non-zero. */
export function parseStatusNotifier(result: { ok: boolean; stdout: string }): boolean {
  if (!result.ok) return false
  return /\(\s*'[^']+'\s*,?\s*\)/.test(String(result.stdout ?? ''))
}

/** Desktops whose tray is a GNOME Shell extension rather than a library. */
const GNOME_SHELL_FAMILIES = ['gnome', 'unity', 'budgie'] as const

/**
 * What to tell a user whose tray icon never showed up. Null when there is
 * nothing to fix. GNOME needs the AppIndicator extension (Ubuntu ships it, so a
 * plain GNOME or a tiling WM is the usual case); other desktops just need the
 * ayatana library.
 */
export function trayAdvice(watcherPresent: boolean, desktop: string): string | null {
  if (watcherPresent) return null
  const name = String(desktop || '').trim().toLowerCase()
  if (!name || inFamily(name, GNOME_SHELL_FAMILIES)) {
    return (
      'no StatusNotifier host on the session bus, so the tray icon cannot appear: ' +
      'sudo apt install gnome-shell-extension-appindicator, then log out and back in'
    )
  }
  return (
    `no StatusNotifier host on the session bus (desktop: ${name}), so the tray icon cannot appear: ` +
    'install libayatana-appindicator3-1 (or your desktop\'s tray applet) and restart the session'
  )
}

// ---------------------------------------------------------------------------
// Input shape (the Linux stand-in for click-through)
// ---------------------------------------------------------------------------

export interface RegionRect {
  x: number
  y: number
  width: number
  height: number
}

/** Smallest region worth shaping; anything smaller is a measurement glitch. */
export const MIN_SHAPE_SIDE = 16

/** Bounding box of the given rects, or null when there is nothing to bound. */
export function unionRect(rects: readonly RegionRect[]): RegionRect | null {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const rect of rects) {
    const width = Number(rect.width)
    const height = Number(rect.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue
    const x = Number(rect.x)
    const y = Number(rect.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    left = Math.min(left, x)
    top = Math.min(top, y)
    right = Math.max(right, x + width)
    bottom = Math.max(bottom, y + height)
  }
  if (!Number.isFinite(left) || right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * The rect to hand `BrowserWindow.setShape()`, or null when the caller must not
 * call it at all.
 *
 * ⛔ Never pass an empty array to `setShape`: on Linux that is not "reset to the
 * whole window", it is a shape with no area, i.e. an invisible window that
 * swallows nothing and can never be clicked again. A measurement we do not
 * trust has to leave the previous shape in place instead.
 */
export function shapeForRegion(region: RegionRect | null, bounds: RegionRect): RegionRect | null {
  if (!region) return null
  const width = Number(bounds.width)
  const height = Number(bounds.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  // Window-relative DIP, clamped to the frame and rounded to whole pixels: the
  // renderer measures sub-pixel boxes and a fractional shape flickers.
  const x = Math.max(0, Math.min(Math.round(region.x), Math.round(width) - MIN_SHAPE_SIDE))
  const y = Math.max(0, Math.min(Math.round(region.y), Math.round(height) - MIN_SHAPE_SIDE))
  const right = Math.max(x + MIN_SHAPE_SIDE, Math.min(Math.round(region.x + region.width), Math.round(width)))
  const bottom = Math.max(y + MIN_SHAPE_SIDE, Math.min(Math.round(region.y + region.height), Math.round(height)))
  const shaped = { x, y, width: right - x, height: bottom - y }
  if (shaped.width < MIN_SHAPE_SIDE || shaped.height < MIN_SHAPE_SIDE) return null
  return shaped
}

/** Two regions are the same when they differ by less than a pixel of wobble. */
export function sameRegion(a: RegionRect | null, b: RegionRect | null, tolerance = 2): boolean {
  if (!a || !b) return a === b
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  )
}

/**
 * Cap on how many boxes one measurement may carry. The renderer has a dozen
 * `[data-solid]` elements; a payload bigger than that is not a measurement, it
 * is a confused or compromised page, and we would rather drop it than spend the
 * main thread clamping thousands of rects.
 */
export const MAX_REGION_RECTS = 64

/**
 * Turn an IPC payload into rects we trust. Anything that is not a finite,
 * positive box is dropped rather than coerced, because `setShape` gets the raw
 * numbers: a NaN in there is a shape the X server rejects, and the window keeps
 * whatever shape it had before.
 */
export function coerceRegionRects(payload: unknown, limit = MAX_REGION_RECTS): RegionRect[] {
  if (!Array.isArray(payload)) return []
  const rects: RegionRect[] = []
  for (const item of payload.slice(0, limit)) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const x = Number(raw.x)
    const y = Number(raw.y)
    const width = Number(raw.width)
    const height = Number(raw.height)
    if (![x, y, width, height].every(Number.isFinite)) continue
    if (width <= 0 || height <= 0) continue
    rects.push({ x, y, width, height })
  }
  return rects
}
