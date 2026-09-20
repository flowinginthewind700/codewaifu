/**
 * The interface-zoom keystroke, owned by main.
 *
 * Not by the renderer, for three reasons:
 *
 * 1. **The default application menu already claims `Cmd/Ctrl+=`, `-` and `0`**
 *    (View → Zoom In / Zoom Out / Actual Size, roles `zoomin`/`zoomout`/
 *    `resetzoom`). Those roles scale the page themselves, which would leave the
 *    frame the size it was: the widget measures its card in CSS pixels and main
 *    converts them, so a zoom nobody told main about clips her. Preventing the
 *    event here is what keeps the role from firing, so there is one ladder.
 * 2. **The keystroke has to work while a terminal has focus.** The bench's panes
 *    are xterm instances with their own keyboard handling; `before-input-event`
 *    fires on the webContents before the page sees anything, so a Ctrl+- typed
 *    with a vim split focused still zooms the app.
 * 3. **Both windows share one rung.** One persisted `uiZoom`, applied to the
 *    widget and the bench together, so zooming in one place cannot leave the
 *    other at 100%.
 *
 * Nothing here imports Electron at runtime - only types - so the command
 * extraction is testable in plain node.
 */
import type { Input, WebContents } from 'electron'
import { zoomCommand, type ZoomCommand } from '../shared/zoom'

/**
 * Read a main-process input event as a zoom command.
 *
 * `Input` is the shape `before-input-event` hands over: the same `key`/`code` a
 * `KeyboardEvent` carries, but with the modifiers spelled `control`/`meta`/
 * `alt`. Shift is deliberately not a disqualifier - Shift+= is how `+` is typed
 * on a US layout, and every spelling of "bigger" should mean bigger.
 *
 * Auto-repeat is accepted rather than filtered: holding the key walks the
 * ladder, which is what every other app does, and the ladder has ends.
 */
export function zoomKeyCommand(
  input: Pick<Input, 'type' | 'key' | 'code' | 'control' | 'meta' | 'alt'>
): ZoomCommand | null {
  if (input.type !== 'keyDown') return null
  return zoomCommand({
    key: input.key,
    code: input.code,
    ctrlKey: input.control,
    metaKey: input.meta,
    altKey: input.alt
  })
}

/**
 * Claim the zoom chords on one window's contents.
 *
 * Returns the detach function so a destroyed window leaves no listener behind.
 * The command is handed up rather than applied here: main's index owns the rung,
 * because it has to persist it and apply it to *every* window, and a module
 * that applied it locally would be a second authority on the same preference.
 */
export function attachZoomKeys(
  contents: WebContents,
  onCommand: (command: ZoomCommand) => void
): () => void {
  const listener = (event: Electron.Event, input: Input): void => {
    const command = zoomKeyCommand(input)
    if (!command) return
    // Swallow it before the page and before the menu accelerator see it: main
    // is about to apply the rung, and a second handler would mean a second idea
    // of what the same keystroke does.
    event.preventDefault()
    onCommand(command)
  }
  contents.on('before-input-event', listener)
  return () => {
    if (!contents.isDestroyed()) contents.removeListener('before-input-event', listener)
  }
}
