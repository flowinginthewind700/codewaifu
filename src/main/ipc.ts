import { clipboard, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import { readClipboardPayload, savePastedImage, sweepDue } from './attach'
import type { Core } from './core'
import { log } from './log'
import { asAgent, type Agent } from '../shared/protocol'
import type { MediaCommand } from '../shared/media'
import type { AppConfig } from '../shared/config'
import { IPC } from '../shared/ipcChannels'
import { coerceRegionRects, type RegionRect } from '../shared/linuxRuntime'

export { IPC }

export interface UiHooks {
  setExpanded: (expanded: boolean) => void
  setChatMode: (on: boolean) => void
  setClickThrough: (through: boolean) => void
  /** Push window-level config (opacity, alwaysOnTop) that only main can apply. */
  applyConfig: (config: AppConfig) => void
  /** The renderer measured its card; resize the frame to exactly that height. */
  fitHeight: (height: number) => void
  /**
   * Linux only: the measured solid boxes that become the window's input shape.
   * Ignored on the platforms where mouse-event forwarding already works.
   */
  setSolidRegion: (rects: readonly RegionRect[]) => void
  /** Drag the frame by a screen-space delta (JS drag over the Live2D canvas). */
  moveWindow: (dx: number, dy: number) => void
  /** The renderer's Web Audio player mounted (true) or went away (false). */
  voiceReady: (ready: boolean) => void
  /** One line of speech finished playing in the renderer. */
  speechAck: (id: string, ok: boolean, error?: string) => void
  /** A non-empty input gained/lost focus in our window (hotkey guard). */
  setInputActive: (active: boolean) => void
  hide: () => void
  quit: () => void
}

function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  return { ...config, token: typeof config.token === 'string' && config.token ? '***' : '' }
}

function redact(core: Core): Record<string, unknown> {
  // The renderer never needs the relay token; hooks read it from endpoint.env.
  return redactConfig({ ...core.config } as unknown as Record<string, unknown>)
}

export function send(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

export function registerIpc(core: Core, getWin: () => BrowserWindow | null, ui: UiHooks): void {
  const handle = (channel: string, fn: (payload: unknown) => Promise<unknown> | unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, payload) => {
      try {
        return Promise.resolve(fn(payload)).catch((error) => {
          log('error', `ipc ${channel} failed`, String(error))
          return { ok: false, error: String(error) }
        })
      } catch (error) {
        log('error', `ipc ${channel} threw`, String(error))
        return { ok: false, error: String(error) }
      }
    })
  }

  handle(IPC.getState, async () => ({
    config: redact(core),
    runtime: core.runtimeState(),
    events: core.recentEvents(60),
    media: await core.mediaState()
  }))

  handle(IPC.setConfig, async (patch) => {
    // Awaited because a port change re-binds the relay before we report back.
    const config = await core.updateConfig(patch)
    ui.applyConfig(config)
    send(getWin(), IPC.pushConfig, redact(core))
    return { ok: true, config: redact(core), relay: core.relayStatus() }
  })

  handle(IPC.threads, async () => ({ ok: true, threads: await core.threads() }))

  handle(IPC.transcript, (payload) => {
    const body = (payload || {}) as { agent?: Agent; threadId?: string; limit?: number; fresh?: boolean }
    // `asAgent` accepts every agent we can name; the transcript reader itself
    // only has readers for codex, claude and zcode, so it returns null for the
    // rest.
    const agent: Agent = asAgent(body.agent)
    if (agent === 'unknown') return { ok: false, transcript: null, error: 'unknown agent' }
    const limit = Number(body.limit) || undefined
    const transcript = core.transcript(agent, String(body.threadId || ''), { limit, fresh: Boolean(body.fresh) })
    return { ok: Boolean(transcript), transcript }
  })

  handle(IPC.chatMode, (payload) => {
    ui.setChatMode(Boolean(payload))
    return { ok: true }
  })

  handle(IPC.inputActive, (payload) => {
    ui.setInputActive(Boolean(payload))
    return { ok: true }
  })

  handle(IPC.steer, async (payload) => {
    const body = (payload || {}) as { agent?: Agent; threadId?: string; message?: string }
    const agent: Agent = asAgent(body.agent)
    return core.steer(agent, String(body.threadId || ''), String(body.message || ''))
  })

  handle(IPC.say, (payload) => {
    const body = (payload || {}) as { text?: string; lang?: 'zh' | 'en' }
    core.say(String(body.text || ''), body.lang)
    return { ok: true }
  })

  handle(IPC.mediaState, async () => ({ ok: true, media: await core.mediaState() }))

  handle(IPC.mediaCommand, async (payload) => {
    const command = String((payload || {}) as string) as MediaCommand
    return { ok: true, media: await core.mediaCommand(command) }
  })

  handle(IPC.hooksInstall, () => ({ ok: true, report: core.reinstallHooks() }))
  handle(IPC.hooksUninstall, () => ({ ok: true, report: core.removeHooks() }))
  handle(IPC.voices, async () => ({ ok: true, voices: await core.voices() }))

  handle(IPC.neuralRetry, () => ({ ok: true, neural: core.retryNeural() }))

  handle(IPC.fitHeight, (payload) => {
    ui.fitHeight(Number(payload))
    return { ok: true }
  })

  handle(IPC.solidRegion, (payload) => {
    // Validated here, not in the window: `setShape` hands these numbers straight
    // to the X server, and one NaN would cost us the shape we already have.
    ui.setSolidRegion(coerceRegionRects(payload))
    return { ok: true }
  })

  handle(IPC.moveWindow, (payload) => {
    const body = (payload || {}) as { dx?: number; dy?: number }
    ui.moveWindow(Number(body.dx) || 0, Number(body.dy) || 0)
    return { ok: true }
  })

  handle(IPC.voiceReady, (payload) => {
    ui.voiceReady(Boolean(payload))
    return { ok: true }
  })

  handle(IPC.speechAck, (payload) => {
    const body = (payload || {}) as { id?: string; ok?: boolean; error?: string }
    const id = String(body.id || '')
    if (id) ui.speechAck(id, Boolean(body.ok), body.error)
    return { ok: true }
  })

  handle(IPC.expanded, (payload) => {
    ui.setExpanded(Boolean(payload))
    return { ok: true }
  })

  handle(IPC.clickThrough, (payload) => {
    ui.setClickThrough(Boolean(payload))
    return { ok: true }
  })

  handle(IPC.hide, () => {
    ui.hide()
    return { ok: true }
  })

  handle(IPC.quit, () => {
    ui.quit()
    return { ok: true }
  })

  handle(IPC.pickImage, async () => {
    const win = getWin()
    if (!win) return { ok: false, error: 'no window' }
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose an avatar image',
      buttonLabel: 'Use image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
    const file = result.filePaths[0]
    if (!fs.existsSync(file)) return { ok: false, error: 'file not found' }
    return { ok: true, path: file }
  })

  handle(IPC.openPath, (payload) => {
    const target = String(payload || '')
    if (!target) return { ok: false }
    void shell.openPath(target)
    return { ok: true }
  })

  /**
   * "What can I attach from the clipboard?" Files first, then an image, and
   * never both, because a paste means one of them: what main saw on the clipboard
   * is either files somebody copied or a picture somebody took. The answer is a
   * list of paths and nothing else - no bytes cross this bridge, because the
   * renderer's next move is to type a path into a terminal.
   */
  handle(IPC.clipboardAttach, async () => {
    const payload = await readClipboardPayload(clipboard)
    if (payload.paths.length) return { ok: true, paths: payload.paths }
    if (!payload.png) return { ok: false, empty: true }
    const saved = savePastedImage(payload.png)
    if (!saved) return { ok: false, error: 'the pasted image could not be saved' }
    // Opportunistic and throttled: a paste is the moment the directory is
    // certainly there and certainly being looked at.
    sweepDue()
    return { ok: true, paths: [saved] }
  })
}
