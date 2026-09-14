import { app, Notification } from 'electron'
import crypto from 'node:crypto'
import type { EventPlan } from '../shared/protocol'
import type { BubbleMessage } from '../shared/ui'
import { runCli } from './cli'
import { Core } from './core'
import { isMac } from './env'
import { IPC, registerIpc, send } from './ipc'
import { closeLog, log } from './log'
import { getMediaState, platformSupportsMedia } from './media'
import { effectivePath } from './shellPath'
import { createWindow, type WindowHandle } from './window'

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

let core: Core | null = null
let handle: WindowHandle | null = null
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

function uiLang(): 'zh' | 'en' {
  const lang = core?.config.lang
  return lang === 'zh' || lang === 'en' ? lang : 'zh'
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

  // Warm the repaired PATH before anything shells out to codex/claude/curl.
  void effectivePath().catch(() => undefined)

  const relay = await instance.start()
  log('info', 'relay ready', { port: relay.port, reason: relay.reason, boot: relay.boot })

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
    setClickThrough: (through) => handle?.setClickThrough(through),
    applyConfig: (config) => handle?.applyConfig(config),
    hide: () => handle?.hide(),
    quit: () => app.quit()
  })

  instance.onShow(() => {
    handle?.show(false)
    handle?.setExpanded(true)
  })

  instance.addEventListener((plan: EventPlan) => {
    send(handle?.win ?? null, IPC.pushEvent, plan)
  })

  instance.addStateListener((speaking, queueLength) => {
    send(handle?.win ?? null, IPC.pushSpeaking, { speaking, queueLength })
  })

  handle.win.webContents.on('did-finish-load', () => {
    reportRelay()
    if (greeted) return
    greeted = true
    const greeting = instance.greet()
    if (greeting) bubble(greeting.text, greeting.lang, 'greeting')
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
    handle?.setExpanded(true)
  })

  app.on('window-all-closed', () => {
    // The tray keeps us alive; only Windows/Linux quit when the widget is closed.
    if (!isMac) app.quit()
  })

  app.on('activate', () => handle?.show(true))

  app.on('before-quit', () => {
    if (mediaTimer) clearInterval(mediaTimer)
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
