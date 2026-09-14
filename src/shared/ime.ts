// ============================================================
// IME-safe Enter handling.
//
// The composer is a plain textarea, so a bare `key === 'Enter'` check sends the
// draft while a Chinese/Japanese/Korean IME is still composing: the user hits
// Enter to *commit a candidate* and half-typed pinyin goes to the agent as a
// steer message. Chromium marks those keys two ways — `isComposing` on the
// native event, and the legacy `keyCode === 229` — and neither alone is
// reliable (some Windows IMEs clear `isComposing` before the keydown reaches
// the page; `keyCode` is deprecated but still the only signal they leave). So
// the predicate takes both plus a flag the caller tracks from
// compositionstart/compositionend, and any one of the three stands the
// shortcut down.
//
// ⛔ Keep this module free of react/electron imports — it is unit tested and
//    shared by the renderer's global key handlers and its composer.
// ============================================================

/** The few fields the predicate reads; DOM and React synthetic events both fit. */
export interface ImeKeyLike {
  key?: string
  shiftKey?: boolean
  keyCode?: number
  isComposing?: boolean
}

/** Legacy code Chromium reports for every key an IME swallowed. */
export const IME_KEYCODE = 229

/**
 * Grace window after `compositionend` in which a bare Enter is still treated
 * as the IME's commit key, in ms.
 *
 * macOS dispatches the commit Enter *after* `compositionend` for some input
 * methods, so by the time the keydown lands all three direct signals
 * (`isComposing`, `keyCode === 229`, the caller's composition flag) are already
 * clean and the Enter looks like a real submit. The commit keydown follows the
 * compositionend within a few milliseconds (same task), while a human pressing
 * Enter again to actually send needs an order of magnitude longer, so a short
 * window separates the two without eating deliberate sends.
 */
export const COMPOSITION_END_GRACE_MS = 50

/**
 * True when this keydown belongs to an ongoing composition rather than to the
 * user. Global shortcuts (Esc to close, `/` to filter, arrows to walk a list)
 * must all stand down here, or typing Chinese would fire them mid-word.
 */
export function isImeKey(event: ImeKeyLike, composing = false): boolean {
  return composing || event.isComposing === true || event.keyCode === IME_KEYCODE
}

/**
 * True when this keydown is a real submit: bare Enter, outside a composition.
 * Shift+Enter stays a newline in the composer.
 *
 * `msSinceCompositionEnd` is the elapsed time since the caller's last
 * `compositionend`, or `null` when no composition has ended yet; inside
 * {@link COMPOSITION_END_GRACE_MS} the Enter belongs to the IME.
 */
export function isSubmitEnter(
  event: ImeKeyLike,
  composing = false,
  msSinceCompositionEnd: number | null = null
): boolean {
  if (event.key !== 'Enter' || event.shiftKey) return false
  if (isImeKey(event, composing)) return false
  if (msSinceCompositionEnd !== null && msSinceCompositionEnd < COMPOSITION_END_GRACE_MS) return false
  return true
}
