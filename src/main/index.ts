import { app, dialog, globalShortcut, Notification, shell } from 'electron'
import type { WebContents } from 'electron'
import crypto from 'node:crypto'
import os from 'node:os'
import type { EventPlan, Lang } from '../shared/protocol'
import type { BubbleMessage } from '../shared/ui'
import { systemLangFromLocales } from '../shared/lang'
import { prewarmUrls } from '../shared/live2dCatalog'
import { prewarmAssets, registerAssetProtocol, registerAssetScheme } from './assets'
import { cliArgsFrom, runCli } from './cli'
import { binDirOnPath, ensureCliLauncher, pathHint } from './cliLauncher'
import { Core } from './core'
import { isLinux, isMac } from './env'
import { IPC, registerIpc, send } from './ipc'
import { safeStorageCipher } from './keychain'
import { closeLog, log } from './log'
import { getMediaState, platformSupportsMedia } from './media'
import * as neuralTts from './neuralTts'
import { createBenchWindow, type BenchHandle } from './pro/benchWindow'
import type { FlightPoint } from '../shared/benchFlight'
import { narrowLogLevel, proAudience } from './pro/host'
import { registerProIpc } from './pro/ipc'
import { ProService, type ProHost } from './pro/service'
import { effectivePath } from './shellPath'
import { RendererVoice } from './voiceBridge'
import { createWindow, type WindowHandle } from './window'
import { attachZoomKeys } from './zoom'
import { clampZoom, ZOOM_DEFAULT, zoomForCommand, type ZoomCommand } from '../shared/zoom'
import {
  APP_USER_MODEL_ID,
  chromiumSwitches,
  logSandboxState,
  x11RelaunchArgs
} from '../shared/linuxRuntime'

/**
 * One binary, two entry points. `CodeWaifu --cli install` is what `install.sh`
 * calls, so all hook-merging lives in tested TypeScript instead of being
 * reimplemented in shell; `codewaifu pro <verb>` drives the bench and needs no
 * flag at all. Anything else boots the companion window.
 */
const cli = cliArgsFrom(process.argv)
const cliMode = cli.cli
const cliArgs = cli.args

const MEDIA_POLL_MS = 4000

/**
 * How long the launch greeting waits for a voice before it speaks anyway.
 * Both bounds are generous but finite: a companion that never says hello is
 * worse than one that says it in the fallback voice.
 */
const GREET_VOICE_MS = 6000
/** Loading Matcha is ~1.6s from disk, minutes on a first run that downloads it. */
const GREET_NEURAL_MS = 30000

// Privileged schemes have to be declared before `app.ready`; Electron rejects
// them afterwards. This is what lets the widget load Live2D models from
// ~/.codewaifu/assets through `cw-asset://` instead of the network.
registerAssetScheme()

// A dev run has to be able to sit next to an installed companion. Both would
// share the default userData directory, and the single-instance lock below is
// keyed on it - so `npm run dev` logs "second instance exiting", quits, and
// pulls focus to the app that is already running. The Bench never appears and
// nothing reports an error, which reads as a broken dev script. Suffixing the
// directory gives dev its own lock and its own Chromium cache. The app's real
// state lives in ~/.codewaifu and stays shared, so a dev run still sees the
// same config, tasks and ledgers; only the relay port moves, because two
// listeners cannot hold 36801 and `pinPort` is off by default. Packaged builds
// keep the stock path, so no installed user's data moves.
if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-dev`)
}

/*
 * Linux desktop plumbing, all of it pre-ready because Chromium reads these
 * switches once at startup:
 *
 * - `chromiumSwitches()` adds the ozone hint for a Wayland session with no
 *   XWayland, where Electron would otherwise refuse to start. It deliberately
 *   does NOT add `no-sandbox`: on Ubuntu 24.04+ Chromium aborts before this
 *   file is even loaded, so that flag has to come from the launcher (AppRun,
 *   the install shim or bin/codewaifu.mjs). `logSandboxState` records what we
 *   ended up with so an unsandboxed session is never a mystery.
 * - The AppUserModelID has to match the `.desktop` file's identity or GNOME
 *   files our notifications under a generic icon.
 */
if (isLinux) {
  for (const entry of chromiumSwitches()) {
    const at = entry.indexOf('=')
    if (at < 0) app.commandLine.appendSwitch(entry)
    else app.commandLine.appendSwitch(entry.slice(0, at), entry.slice(at + 1))
    log('info', 'chromium switch', entry)
  }
  log('info', 'sandbox', logSandboxState(process.argv))
  try {
    app.setAppUserModelId(APP_USER_MODEL_ID)
  } catch (error) {
    log('warn', 'setAppUserModelId failed', String(error))
  }
}

let core: Core | null = null
let handle: WindowHandle | null = null
let rendererVoice: RendererVoice | null = null
let mediaTimer: NodeJS.Timeout | null = null
let lastMediaJson = ''
let greeted = false

function bubble(text: string, lang: 'zh' | 'en', kind = 'notice'): void {
  if (!text) return
  const message: BubbleMessage = {
    id: `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    text,
    lang,
    agent: 'codewaifu',
    kind,
    at: Date.now()
  }
  send(handle?.win ?? null, IPC.pushBubble, message)
}

function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
  } catch (error) {
    log('warn', 'notification failed', String(error))
  }
}

/**
 * Her first line is the proof that the voice works, so it does not get spent
 * before there is one. On launch the renderer attaches its Web Audio player
 * after the window paints and Matcha loads after that; greeting on
 * `did-finish-load` found no transport and fell back to the OS voice — the one
 * voice this app is not. Both waits are bounded, so the greeting always lands.
 */
async function greetWhenAudible(instance: Core): Promise<void> {
  const cfg = instance.config
  const started = Date.now()
  const waits: Array<Promise<unknown>> = [
    rendererVoice?.waitUntilAvailable(GREET_VOICE_MS) ?? Promise.resolve(false)
  ]
  if (cfg.enabled && cfg.speak && cfg.voice.engine === 'matcha') {
    waits.push(neuralTts.warm(GREET_NEURAL_MS))
  }
  await Promise.all(waits)
  log('info', 'greeting', {
    waitedMs: Date.now() - started,
    neural: neuralTts.available(),
    renderer: Boolean(rendererVoice?.available?.())
  })
  const greeting = instance.greet()
  if (greeting) bubble(greeting.text, greeting.lang, 'greeting')
}

function uiLang(): 'zh' | 'en' {
  // Port-conflict notices are about the window, so they follow the interface
  // language rather than the language notices happen to be spoken in.
  return core?.uiLang() ?? 'zh'
}

/** Explain a port that moved instead of letting the user wonder about it. */
function reportRelay(): void {
  const state = core?.relayStatus()
  if (!state) return
  send(handle?.win ?? null, IPC.pushRelay, state)
  if (state.duplicateOf) {
    const text =
      uiLang() === 'zh'
        ? `另一个 CodeWaifu (pid ${state.duplicateOf}) 已经在运行，本次不会抢占它的端口`
        : `Another CodeWaifu (pid ${state.duplicateOf}) is already running; this instance will not take over its port`
    bubble(text, uiLang(), 'alert')
    notify('CodeWaifu', text)
    return
  }
  if (!state.conflict) return
  const lang = uiLang()
  const text =
    lang === 'zh'
      ? `端口 ${state.conflict.port} 被占用，已自动改用 ${state.port}`
      : `port ${state.conflict.port} was busy, moved to ${state.port}`
  bubble(text, lang, 'alert')
  log('warn', 'relay port moved', state.conflict.hint)
}

async function pollMedia(): Promise<void> {
  if (!handle || !handle.isVisible() || !platformSupportsMedia()) return
  try {
    const media = await getMediaState()
    const json = JSON.stringify(media)
    if (json === lastMediaJson) return
    lastMediaJson = json
    send(handle.win, IPC.pushMedia, media)
  } catch (error) {
    log('warn', 'media poll failed', String(error))
  }
}

/* ------------------------------------------------------------------ *
 * Pro: the Bench window, and the host the Bench talks to the app through
 * ------------------------------------------------------------------ */

let pro: ProService | null = null
let bench: BenchHandle | null = null
/** Mirrored from Core's speaker, so the bridge can tell "she is talking". */
let voiceBusy = false

/** The Bench window when it exists; a destroyed one is forgotten, not reused. */
function benchAlive(): BenchHandle | null {
  if (bench?.win.isDestroyed()) bench = null
  return bench
}

/**
 * Interface zoom, owned here.
 *
 * `core.config.uiZoom` is the persisted rung; this closure is the only thing
 * that moves it, so the widget and the Bench cannot end up on two rungs. The
 * write is debounced because holding `Ctrl+=` walks the ladder at key-repeat
 * speed and every step would otherwise be a config write - and a config write
 * re-merges the agents' hook files. What the human sees is not debounced: the
 * rung is applied and pushed to the HUD at once, and the file catches up.
 */
let zoomRung = ZOOM_DEFAULT
let zoomWriteTimer: NodeJS.Timeout | null = null
const ZOOM_WRITE_MS = 400

function pushZoomHud(rung: number): void {
  send(handle?.win ?? null, IPC.pushZoom, rung)
  benchAlive()?.send(IPC.pushZoom, rung)
}

function flushZoom(): void {
  if (zoomWriteTimer) {
    clearTimeout(zoomWriteTimer)
    zoomWriteTimer = null
  }
  const instance = core
  if (!instance || instance.config.uiZoom === zoomRung) return
  // `updateConfig` persists and wakes the config listeners, but it does not
  // call `ui.applyConfig` - that is the IPC handler's job, and this path did
  // not come through IPC. The rung was already applied, so what is left here is
  // bringing the persisted copy into step.
  void instance.updateConfig({ uiZoom: zoomRung }).catch((error) => {
    log('warn', 'zoom persist failed', String(error))
  })
}

/** Apply one rung everywhere it has to be true, then schedule the write. */
function applyZoomRung(next: number): void {
  const rung = clampZoom(next)
  const changed = rung !== zoomRung || core?.config.uiZoom !== rung
  zoomRung = rung
  if (changed) {
    const instance = core
    if (instance) {
      // Drives `webContents.setZoomFactor` *and* the frame geometry: the widget
      // measures itself in CSS pixels, so a bigger page needs a bigger frame or
      // she is clipped.
      handle?.applyConfig({ ...instance.config, uiZoom: rung })
    }
    benchAlive()?.setZoom()
    if (zoomWriteTimer) clearTimeout(zoomWriteTimer)
    zoomWriteTimer = setTimeout(flushZoom, ZOOM_WRITE_MS)
    zoomWriteTimer.unref?.()
  }
  // Pushed even when nothing moved: a second Ctrl+0 at 100% should still say
  // "100%" rather than look like the keystroke did nothing.
  pushZoomHud(rung)
}

/** One zoom command, whether it came from a keystroke or a settings row. */
function applyZoomCommand(command: ZoomCommand): void {
  applyZoomRung(zoomForCommand(zoomRung, command))
}

/** A zoom chord typed in either window moves the one shared rung. */
function attachZoomTo(contents: WebContents): void {
  attachZoomKeys(contents, (command) => applyZoomCommand(command))
}

/**
 * Where the Bench's flight comes from and goes to: the centre of the stage
 * widget, or `null` when she is not on screen. The dart is the whole point of
 * the animation - a window that leaves toward nothing merely slid sideways.
 *
 * Read per flight, not captured: the widget is dragged around constantly, and
 * an anchor frozen at creation time would send the bench toward a corner she
 * left minutes ago.
 */
function widgetAnchor(): FlightPoint | null {
  const win = handle?.win
  if (!win || win.isDestroyed() || !win.isVisible()) return null
  try {
    const bounds = win.getBounds()
    return {
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2)
    }
  } catch (error) {
    log('warn', 'widget anchor read failed', String(error))
    return null
  }
}

/**
 * Create the Bench on first open, then keep it. A cockpit that re-spawns on
 * every bubble click loses the terminal scrollback the human was reading, so
 * closing it hides it and only quitting destroys it.
 *
 * Creation does not show the window: both doors (`openBench` and the tray item)
 * show it themselves, so the first open flies once rather than twice.
 */
function ensureBench(): BenchHandle | null {
  const existing = benchAlive()
  if (existing) return existing
  const instance = core
  if (!instance) return null
  try {
    bench = createBenchWindow({
      geometry: () => instance.config.pro.bench,
      // Straight to the config file rather than through `updateConfig`: a
      // resize must not re-merge the agents' hook files or wake Pro's diff.
      saveGeometry: (geometry) => instance.setBenchGeometry(geometry),
      zoom: () => zoomRung,
      anchor: widgetAnchor,
      onFocusChange: () => pro?.refreshCompanion(),
      // The stage's bench button is a switch, and window visibility is its
      // state. Refresh on every change rather than relying on focus, which a
      // hidden window does not always give up in a way we are told about.
      onVisibility: () => pro?.refreshCompanion(),
      onLoaded: () => pro?.replayFocus(),
      onClosed: () => {
        bench = null
        pro?.refreshCompanion()
      }
    })
  } catch (error) {
    log('error', 'bench window failed to open', String(error))
    bench = null
    return null
  }
  attachZoomTo(bench.win.webContents)
  return bench
}

async function pickDirectory(): Promise<string> {
  try {
    const options = { properties: ['openDirectory' as const] }
    const win = handle?.win ?? null
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return ''
    return result.filePaths[0]
  } catch (error) {
    log('warn', 'directory picker failed', String(error))
    return ''
  }
}

/**
 * Open what the Bench pointed at. `shell.openPath` resolves with an error string
 * instead of rejecting, and "nothing is registered to open this" still has a
 * useful fallback: show it in the file manager instead.
 */
async function revealPath(target: string): Promise<void> {
  const clean = String(target || '').trim()
  if (!clean) return
  try {
    const error = await shell.openPath(clean)
    if (error) {
      log('warn', `could not open ${clean}`, error)
      shell.showItemInFolder(clean)
    }
  } catch (error) {
    log('warn', `could not open ${clean}`, String(error))
  }
}

/**
 * Pro's whole authority over the app, in one object. Every callback closes over
 * module state instead of storing a reference, so a window that is recreated -
 * or never created - cannot leave the service holding a dead handle.
 */
function proHost(instance: Core): ProHost {
  return {
    config: () => instance.config,
    updateConfig: (patch) => instance.updateConfig(patch),
    // Speech follows the interface when `lang` is auto, as the greeting does.
    lang: (): Lang => (instance.config.lang === 'auto' ? instance.uiLang() : instance.config.lang),
    emit: (channel, payload) => {
      if (proAudience(channel) === 'widget') {
        send(handle?.win ?? null, channel, payload)
        return
      }
      // `benchAlive`, never `ensureBench`: a projection push while the Bench is
      // closed is redundant, because opening it re-reads the whole projection
      // through the `proState` invoke. Creating a window per push would spawn a
      // hidden renderer for everyone who never opens the Bench.
      benchAlive()?.send(channel, payload)
    },
    bubble: (message) => send(handle?.win ?? null, IPC.pushBubble, message),
    // `say`, never `force`: a muted companion stays muted, and one hook that
    // fires twice says one line.
    speak: (text, lang) => instance.speaker.say(text, lang),
    speaking: () => voiceBusy,
    // Appear without taking the keyboard: stealing focus from a terminal in
    // order to say "a terminal needs you" is worse than not appearing.
    setWidget: (visible) => (visible ? handle?.show(false) : handle?.hide()),
    widgetVisible: () => handle?.isVisible() ?? false,
    benchFocused: () => benchAlive()?.isFocused() ?? false,
    setBadge: (count) => handle?.setBadge(count),
    bubbleMs: () => instance.config.bubbleMs,
    openBench: () => {
      void ensureBench()?.showAnimated()
    },
    benchOpen: () => benchAlive()?.isVisible() ?? false,
    // The other half of the stage's switch: the bench is sucked back in.
    closeBench: () => {
      const alive = benchAlive()
      if (!alive) return
      void alive.hideAnimated()
    },
    // One app, two modes: the Bench hides (it is kept alive, so its terminal
    // scrollback survives the trip back) and the stage window comes forward
    // with focus, because a human just clicked "take me back".
    openStage: () => {
      handle?.show(true)
      benchAlive()?.hide()
    },
    // The sessions the companion already tracks on this machine. Read-only:
    // the bench offers them for import, it never writes to the tracker.
    listThreads: () => instance.threads(),
    // The conversation of one session, and the way to answer it. Both are the
    // core's own implementations - the stage's chat view reads and steers
    // through the same two - so an imported session says the same thing in
    // either mode and there is one delivery path, not two.
    readTranscript: (agent, threadId, options) => instance.transcript(agent, threadId, options),
    steerThread: (agent, threadId, message) => instance.steer(agent, threadId, message),
    pickDir: () => pickDirectory(),
    openPath: (target) => {
      void revealPath(target)
    },
    // `openExternal`, never `openPath`: a URL is not a file, and `openPath` on
    // one would fall through to `showItemInFolder` and open a file manager.
    openExternal: (url) => {
      shell.openExternal(url).catch((error) => log('warn', 'could not open link', String(error)))
    },
    log: (level, message, extra) => log(narrowLogLevel(level), message, extra)
  }
}

/**
 * Put `codewaifu` on PATH, and keep it pointing at the app that is running.
 *
 * Called on every boot because the thing that changes is not our code but the
 * app's address: a reinstall into ~/Applications, or a dmg mounted from
 * somewhere else, leaves a launcher that dials a binary which is no longer
 * there. Idempotent, ours-only, and never fatal - a missing launcher costs a
 * convenience, not a companion.
 */
function installCliLauncher(): void {
  const outcome = ensureCliLauncher({
    packaged: app.isPackaged,
    platform: process.platform,
    appBinary: process.execPath,
    home: os.homedir()
  })
  switch (outcome.action) {
    case 'written':
      log('info', 'cli launcher written', {
        path: outcome.path,
        // The GUI process inherits launchd's PATH, so this reads the shell's own
        // idea of PATH back rather than guessing from process.env.
        onPath: binDirOnPath(outcome.path, process.env.PATH),
        hint: pathHint(outcome.path)
      })
      break
    case 'skipped-foreign':
      log('warn', 'cli launcher is not ours; left alone', { path: outcome.path })
      break
    case 'failed':
      log('warn', 'cli launcher write failed', { path: outcome.path, error: outcome.error })
      break
    default:
      break
  }
}

async function boot(): Promise<void> {
  if (isMac) {
    // Background accessory: no Dock icon, the tray is the chrome.
    app.setActivationPolicy('accessory')
  }

  const instance = core ?? new Core(app.getVersion())
  core = instance

  // Read the OS language before the first runtimeState() so `uiLang: 'auto'`
  // has something to resolve against on the very first paint.
  try {
    const locales = app.getPreferredSystemLanguages?.() ?? [app.getLocale()]
    instance.systemLang = systemLangFromLocales(locales)
  } catch (error) {
    log('warn', 'system language detection failed', String(error))
  }
  log('info', 'ui language', { system: instance.systemLang, pref: instance.config.uiLang })

  // Warm the repaired PATH before anything shells out to codex/claude/curl.
  void effectivePath().catch(() => undefined)

  // The short path to the bench (`codewaifu pro ssh box`) only exists if
  // something put `codewaifu` on PATH; a dmg install puts nothing there.
  installCliLauncher()

  const relay = await instance.start()
  log('info', 'relay ready', { port: relay.port, reason: relay.reason, boot: relay.boot })

  // Pro is constructed before the widget exists so a hook that arrives during
  // startup still has a claimant. `start()` waits for the end of boot, when
  // there is a window for its first announcement to land in.
  // The keychain is handed in rather than reached for: `pro/service.ts` keeps
  // itself free of Electron so its policies stay testable, and this is the one
  // line where the two meet. Null on a box with no keyring, which the SSH
  // roster reports as "cannot save a password here" instead of storing one in
  // plaintext.
  const service = new ProService({ host: proHost(instance), cipher: safeStorageCipher() })
  pro = service
  registerProIpc(service)
  // One authority, three surfaces: the bench window, the widget and `/pro/*`
  // all read and act through this same object.
  instance.setProApi(service)
  instance.setEventClaim((event) => {
    // Fed in either way: the ledger and the stall timers read plain activity,
    // and a hook Pro only logged still has to land there. The claim decides who
    // announces it, and for the kinds triage models as a need, declining is a
    // verdict - the task is closed, the pane is parked, the same prompt was
    // just raised - not an abstention. Handing those back made the legacy
    // companion speak its own "done" over a task the human had already closed.
    service.onHook(event)
    return service.claimsEvent(event)
  })
  instance.addConfigListener(() => {
    void service.syncConfig()
    // The Bench keeps its own copy of the config for the settings it renders,
    // and nothing pushed it here before: a change made from the widget - or a
    // hand-edited file - left the cockpit showing the old one until reopened.
    benchAlive()?.send(IPC.pushConfig, { ...instance.config, token: '***' })
    // A config that did not come from a keystroke (the widget's settings row,
    // the HTTP relay, a hand-edited file) still has to move the rung main
    // serves to windows created later, or reopening the Bench would come back
    // at the old size.
    const rung = clampZoom(instance.config.uiZoom)
    if (rung !== zoomRung) {
      zoomRung = rung
      benchAlive()?.setZoom()
    }
  })

  registerAssetProtocol()
  // Warm the avatar cache in the background: the first paint then reads from
  // disk, and an offline launch still shows a companion once cached.
  // Only the character she actually wears: the bundle grew to eight faces and
  // warming all of them would spend ~8MB of somebody's bandwidth on faces they
  // may never pick (the picker fetches any other one on demand).
  prewarmAssets(prewarmUrls(instance.config.avatar.character))

  // The rung main serves to any window created from here on. Clamped because a
  // hand-edited config can hold anything, and `setZoomFactor` on a non-rung
  // value is the one way the two windows could disagree about what 1.15 means.
  zoomRung = clampZoom(instance.config.uiZoom)

  handle = createWindow(instance.config, {
    onExpanded: (expanded) => send(handle?.win ?? null, IPC.pushExpanded, expanded),
    onMoved: (position) => instance.setWindowPosition(position),
    onQuit: () => app.quit(),
    isMuted: () => !instance.config.speak,
    // The tray's copy follows the interface language, not the voice language:
    // a Chinese UI speaking English lines is the combination the setting exists
    // for, and the menu is UI.
    lang: () => instance.uiLang(),
    onToggleMute: () => {
      const speak = !instance.config.speak
      void instance.updateConfig({ speak }).then(() => {
        send(handle?.win ?? null, IPC.pushConfig, { ...instance.config, token: '***' })
        // On Linux the menu is published, not built on open, so the row that
        // just changed meaning has to be re-published or it keeps saying the
        // opposite of what it will do.
        handle?.refreshTray()
        if (speak) {
          const lang = instance.config.lang === 'en' ? 'en' : 'zh'
          instance.say(lang === 'zh' ? '我回来了' : 'I am back', lang)
        }
      })
    },
    onReinstallHooks: () => {
      const report = instance.reinstallHooks()
      const ok = report.codex.installed || report.claude.installed
      notify('CodeWaifu', ok ? 'Agent hooks repaired' : `Hook repair failed: ${report.warnings[0] || 'unknown'}`)
    },
    // The Bench reads widget visibility to decide whether an attention item may
    // pull her onto the screen, so a change has to reach it as it happens.
    onVisibility: () => pro?.refreshCompanion(),
    // The tray is the Bench's door. Without it the cockpit is reachable only
    // through `pro.openBenchOnLaunch` or by clicking a bubble that carries no
    // task, which means a fleet with nothing blocked cannot be opened at all.
    onOpenBench: () => {
      // Same arrival as the stage's switch: one way the bench comes forward, so
      // the two doors do not feel like two different windows.
      void ensureBench()?.showAnimated()
    },
    // `view()` is null while Pro is off: the same contract `/pro/*` answers 503
    // on, so the item disappears with the feature instead of dying on click.
    benchAvailable: () => pro?.view() !== null
  })

  // Claim the zoom chords before the page and before the default menu's own
  // zoom roles do, so `Ctrl+=` moves the one ladder this app has.
  attachZoomTo(handle.win.webContents)

  registerIpc(instance, () => handle?.win ?? null, {
    setExpanded: (expanded) => handle?.setExpanded(expanded),
    setChatMode: (on) => handle?.setChatMode(on),
    setClickThrough: (through) => handle?.setClickThrough(through),
    applyConfig: (config) => handle?.applyConfig(config),
    fitHeight: (height) => handle?.fitHeight(height),
    setSolidRegion: (rects) => handle?.setSolidRegion(rects),
    moveWindow: (dx, dy) => handle?.moveBy(dx, dy),
    voiceReady: (ready) => rendererVoice?.setReady(ready),
    speechAck: (id, ok, error) => rendererVoice?.ack(id, ok, error),
    setInputActive: (active) => handle?.setInputActive(active),
    hide: () => handle?.hide(),
    quit: () => app.quit()
  })

  // The widget owns the audible path: its Web Audio graph is the only place an
  // analyser can sit, and the analyser is what moves her mouth.
  const voice = new RendererVoice(() => handle?.win ?? null)
  rendererVoice = voice
  instance.speaker.setTransport(voice)

  instance.onShow(() => {
    handle?.show(false)
    // "/show" means "bring her back": the simple stage, not the panel.
    // The panel stays one explicit click away (stage tool or tray menu).
    handle?.setExpanded(false)
  })

  instance.addEventListener((plan: EventPlan) => {
    send(handle?.win ?? null, IPC.pushEvent, plan)
  })

  instance.addStateListener((speaking, queueLength) => {
    voiceBusy = speaking
    send(handle?.win ?? null, IPC.pushSpeaking, { speaking, queueLength })
  })

  instance.addNeuralListener((neural) => {
    send(handle?.win ?? null, IPC.pushNeural, neural)
  })

  handle.win.webContents.on('did-finish-load', () => {
    // She lives on the desktop: appear on the simple stage as soon as the
    // renderer is up, instead of waiting for a tray click or a hook event.
    handle?.show(false)
    reportRelay()
    if (greeted) return
    greeted = true
    void greetWhenAudible(instance)
  })

  if (platformSupportsMedia()) {
    mediaTimer = setInterval(() => void pollMedia(), MEDIA_POLL_MS)
    mediaTimer.unref?.()
  }

  // A hook that fires before the renderer is up still deserves a bubble.
  reportRelay()

  // A missing herdr is not a failed boot. Pro degrades to an install card and
  // she keeps doing the job she did before there was a Bench, so this is the one
  // startup step whose failure is logged rather than shown to the user.
  try {
    await service.start()
    const target = service.herdrTarget
    log('info', 'pro ready', {
      online: service.online(),
      herdr: target.binaryPath ?? 'missing',
      reason: target.reason
    })
  } catch (error) {
    log('error', 'pro failed to start', String(error))
  }
}

async function main(): Promise<void> {
  if (cliMode) {
    if (isMac) app.dock?.hide()
    // The CLI prints and exits; there is no window to accelerate, and on a
    // headless box (CI, ssh, a container) initialising GL is the difference
    // between `codewaifu status` working and it hanging.
    app.disableHardwareAcceleration()
    let code = 0
    try {
      code = await runCli(cliArgs)
    } catch (error) {
      log('error', 'cli crashed', String(error))
      code = 1
    }
    closeLog()
    app.exit(code)
    return
  }

  /*
   * Electron 38+ defaults to native Wayland even when XWayland is available,
   * and on native Wayland the compositor forbids client-side `setPosition` —
   * which is exactly what dragging the avatar calls. The ozone platform is
   * chosen before any app JavaScript runs, so the only way onto XWayland is a
   * fresh process with the real argv switch. One bounce on GUI start buys back
   * the drag, always-on-top and global shortcuts; the CLI skips it because it
   * opens no window.
   */
  if (isLinux) {
    const args = x11RelaunchArgs(process.argv, process.env)
    if (args) {
      log('info', 'relaunching on XWayland for window drag', { display: process.env.DISPLAY })
      app.relaunch({ args })
      app.quit()
      return
    }
  }

  // The CLI deliberately skips this: `codewaifu status` must work while the app runs.
  if (!app.requestSingleInstanceLock()) {
    log('info', 'second instance exiting; focusing the running companion')
    app.quit()
    return
  }

  app.on('second-instance', () => {
    handle?.show(true)
    // Focus whatever view is already up; never yank the user into the panel.
  })

  app.on('window-all-closed', () => {
    // macOS stays up as a background accessory. On Linux a window manager can
    // close our frame behind our back (Alt+F4, "close all"), and with a tray
    // icon up that must not kill the companion: the tray click brings her back.
    // Where there is no tray there is nothing left to click, so we do quit.
    if (isMac) return
    if (isLinux && handle?.tray) return
    app.quit()
  })

  app.on('activate', () => handle?.show(true))

  app.on('before-quit', () => {
    globalShortcut.unregisterAll()
    if (mediaTimer) clearInterval(mediaTimer)
    rendererVoice?.shutdown()
    // Quitting inside the write debounce must still land the rung, or the app
    // comes back at the size the human last saw instead of the one they set.
    // `updateConfig` writes the file before its first await, so this is in time
    // even though nothing awaits it here.
    flushZoom()
    // Pro goes first: it dismisses the bubbles it issued, and a bubble offering
    // "approve" for a pane that is already gone is a lie with a click target.
    pro?.shutdown()
    pro = null
    core?.setProApi(null)
    bench?.destroy()
    bench = null
    core?.shutdown()
    closeLog()
  })

  await app.whenReady()
  try {
    await boot()
  } catch (error) {
    log('error', 'boot failed', String(error))
    notify('CodeWaifu failed to start', String(error))
  }
}

void main()
