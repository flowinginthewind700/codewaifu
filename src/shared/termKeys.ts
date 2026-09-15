/**
 * Terminal chords: pure decisions, no DOM.
 *
 * xterm offers every keystroke to `attachCustomKeyEventHandler` first, and the
 * return value is a claim: `false` means "I took this one, do not send it to
 * the PTY". Getting that backwards is not cosmetic. A handler that claims plain
 * Ctrl+C means the human can no longer interrupt a runaway agent, which is the
 * one control that still has to work after everything else has gone wrong. So
 * the decision table lives here, where a test can pin every chord that must
 * fall through, instead of inline in a component nobody can unit test.
 */

export type TermClipAction = 'copy' | 'paste' | 'ignore'

/** The fields the decision reads; a DOM KeyboardEvent satisfies this. */
export interface TermKeyEvent {
  type: string
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/**
 * What this keydown should do to the system clipboard.
 *
 * `ignore` is the answer for everything that is not an explicit copy or paste
 * chord, and it is the default on purpose: SIGINT, EOF, suspend, and a TUI's
 * own Ctrl+C ("clear this field") all depend on keys reaching the PTY untouched.
 *
 * The platform split follows what each OS leaves free. macOS gets Cmd, the one
 * modifier no terminal app binds. Everywhere else gets Ctrl+Shift, because plain
 * Ctrl belongs to the terminal; the console-style Ctrl+Insert and Shift+Insert
 * are accepted as well, since that is where Linux and Windows muscle memory
 * reaches first.
 *
 * A copy with nothing selected is also `ignore`. There is no text to move, and
 * swallowing the chord would only take a key away from the terminal for nothing.
 */
export function clipboardAction(
  platform: string,
  event: TermKeyEvent,
  hasSelection: boolean
): TermClipAction {
  if (event.type !== 'keydown') return 'ignore'
  const key = event.key.toLowerCase()

  if (platform === 'darwin') {
    // Ctrl+Cmd+C is a system chord rather than a copy, so Cmd must arrive
    // without Ctrl. Shift is deliberately not checked: a terminal program never
    // sees a Cmd chord, so there is no SIGINT to protect by refusing it.
    if (!event.metaKey || event.ctrlKey) return 'ignore'
    if (key === 'c') return hasSelection ? 'copy' : 'ignore'
    if (key === 'v') return 'paste'
    return 'ignore'
  }

  // Handled before the Ctrl guard: Shift+Insert pastes with no Ctrl held.
  if (key === 'insert') {
    if (event.shiftKey && !event.ctrlKey) return 'paste'
    if (event.ctrlKey && !event.shiftKey) return hasSelection ? 'copy' : 'ignore'
    return 'ignore'
  }

  if (!event.ctrlKey || !event.shiftKey) return 'ignore'
  if (key === 'c') return hasSelection ? 'copy' : 'ignore'
  if (key === 'v') return 'paste'
  return 'ignore'
}

/** What this keydown should do about the pane's scrollback search. */
export type TermSearchAction = 'open' | 'ignore'

/**
 * Whether this keydown opens search.
 *
 * macOS gets Cmd+F, which reaches no terminal program. Everywhere else the
 * chord has to be Ctrl+Shift+F, because plain Ctrl+F is a working key at a
 * prompt: readline's forward-char, vim's page-down, less's next page. Claiming
 * it is the same class of bug as claiming Ctrl+C, only quieter - nothing errors,
 * the cursor just stops advancing one character and nobody can say why.
 *
 * Shift is not checked on the mac side for the reason given in
 * `clipboardAction`: a Cmd chord never reaches the PTY, so there is no control
 * character to protect by refusing the combination.
 */
export function searchAction(platform: string, event: TermKeyEvent): TermSearchAction {
  if (event.type !== 'keydown') return 'ignore'
  if (event.key.toLowerCase() !== 'f') return 'ignore'
  if (platform === 'darwin') return event.metaKey && !event.ctrlKey ? 'open' : 'ignore'
  return event.ctrlKey && event.shiftKey ? 'open' : 'ignore'
}
