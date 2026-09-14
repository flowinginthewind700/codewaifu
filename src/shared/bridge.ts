import { IPC } from './ipcChannels'

/**
 * Shape of `window.codewaifu`, declared in `shared` so both sides typecheck
 * against one definition: the preload implements it, the renderer consumes it.
 */
export interface CodeWaifuApi {
  /** Renderer -> main. Rejects for any channel outside the allow-list. */
  invoke(channel: string, payload?: unknown): Promise<unknown>
  /** Main -> renderer. Returns an unsubscribe function; no-op if not allowed. */
  on(channel: string, listener: (payload: unknown) => void): () => void
  /** Channel names, so the renderer never hardcodes a string. */
  channels: typeof IPC
  platform: string
  versions: { electron: string; chrome: string; node: string }
}
