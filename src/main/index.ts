import { app, Notification, globalShortcut } from 'electron'
import crypto from 'node:crypto'
import type { EventPlan } from '../shared/protocol'
import type { BubbleMessage } from '../shared/ui'
import { systemLangFromLocales } from '../shared/lang'
import { LIVE2D_KEEP_URLS } from '../shared/live2dCatalog'
import { prewarmAssets, registerAssetProtocol, registerAssetScheme } from './assets'
import { runCli } from './cli'
import { Core } from './core'
import { isLinux, isMac } from './env'
import { IPC, registerIpc, send } from './ipc'
import { closeLog, log } from './log'
import { getMediaState, platformSupportsMedia } from './media'
import * as neuralTts from './neuralTts'
import { effectivePath } from './shellPath'
import { RendererVoice } from './voiceBridge'
import { createWindow, type WindowHandle } from './window'
import { APP_USER_MODEL_ID, chromiumSwitches, logSandboxState } from '../shared/linuxRuntime'

/**
 * One binary, two entry points. `CodeWaifu --cli install` is what `install.sh`
 * calls, so all hook-merging lives in tested TypeScript instead of being
 * reimplemented in shell; without the flag we boot the companion window.
 */
const CLI_FLAG = '--cli'
const cliAt = process.argv.indexOf(CLI_FLAG)
const cliMode = cliAt >= 0
const cliArgs = cliAt >= 0 ? process.argv.slice(cliAt + 1) : []

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

  const relay = await instance.start()
  log('info', 'relay ready', { port: relay.port, reason: relay.reason, boot: relay.boot })

  registerAssetProtocol()
  // Warm the avatar cache in the background: the first paint then reads from
  // disk, and an offline launch still shows a companion once cached.
  prewarmAssets(LIVE2D_KEEP_URLS)

  handle = createWindow(instance.config, {
    onExpanded: (expanded) => send(handle?.win ?? null, IPC.pushExpanded, expanded),
    onMoved: (position) => instance.setWindowPosition(position),
    onQuit: () => app.quit(),
    isMuted: () => !instance.config.speak,
    onToggleMute: () => {
      const speak = !instance.config.speak
      void instance.updateConfig({ speak }).then(() => {
        send(handle?.win ?? null, IPC.pushConfig, { ...instance.config, token: '***' })
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
    }
  })

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
