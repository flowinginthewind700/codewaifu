import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import type { Core } from './core'
import { log } from './log'
import type { Agent } from '../shared/protocol'
import type { MediaCommand } from '../shared/media'
import type { AppConfig } from '../shared/config'
import { IPC } from '../shared/ipcChannels'

export { IPC }

export interface UiHooks {
  setExpanded: (expanded: boolean) => void
  setClickThrough: (through: boolean) => void
  /** Push window-level config (opacity, alwaysOnTop) that only main can apply. */
  applyConfig: (config: AppConfig) => void
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

  handle(IPC.steer, async (payload) => {
    const body = (payload || {}) as { agent?: Agent; threadId?: string; message?: string }
    const agent: Agent = body.agent === 'codex' || body.agent === 'claude' ? body.agent : 'unknown'
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
}
