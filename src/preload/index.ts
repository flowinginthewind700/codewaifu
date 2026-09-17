import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { INVOKE_CHANNELS, IPC, PUSH_CHANNELS } from '../shared/ipcChannels'
import type { CodeWaifuApi } from '../shared/bridge'

type Listener = (payload: unknown) => void

const invokeAllowed = new Set<string>(INVOKE_CHANNELS)
const pushAllowed = new Set<string>(PUSH_CHANNELS)

/**
 * The only bridge between the widget and the main process. Two rules: channels
 * are allow-listed (a compromised renderer cannot reach an arbitrary handler),
 * and nothing but plain data crosses - no `ipcRenderer`, no Node globals.
 */
const api: CodeWaifuApi = {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (!invokeAllowed.has(channel)) {
      return Promise.reject(new Error(`blocked ipc channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload) as Promise<unknown>
  },
  /** Subscribe to a main -> renderer push. Returns the unsubscribe function. */
  on(channel: string, listener: Listener): () => void {
    if (!pushAllowed.has(channel)) return () => undefined
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
      try {
        listener(payload)
      } catch {
        /* a throwing renderer listener must not break the bridge */
      }
    }
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
  /** Channel names, so the renderer never hardcodes a string. */
  channels: IPC,
  /**
   * `webUtils.getPathForFile` throws on anything that is not a File carrying a
   * path, and a drag can carry plenty that are not: dragged text, a selection
   * from a browser, an image lifted off the clipboard. Those are '' rather than
   * an exception, because the caller's next move - "then it was not a file
   * drop" - depends on the empty answer.
   */
  pathForFile(file: unknown): string {
    try {
      return webUtils.getPathForFile(file as File) || ''
    } catch {
      return ''
    }
  },
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? ''
  }
}

contextBridge.exposeInMainWorld('codewaifu', api)
