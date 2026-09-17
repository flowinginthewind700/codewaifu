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
  /**
   * The absolute path behind a dropped or pasted `File`, and '' when it has
   * none. Electron 32 removed `File.path`, and its replacement
   * (`webUtils.getPathForFile`) is preload-only, so this is the single door -
   * a renderer that wants to know where a dragged file lives has to ask.
   *
   * Typed `unknown` because `shared` compiles without the DOM lib, and because
   * the honest argument is "a real File from a real event": a plain object with
   * a `name` answers '' rather than guessing a path from a filename.
   */
  pathForFile(file: unknown): string
  /** Channel names, so the renderer never hardcodes a string. */
  channels: typeof IPC
  platform: string
  versions: { electron: string; chrome: string; node: string }
}
