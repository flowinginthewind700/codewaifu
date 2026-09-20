/**
 * Interface zoom: the "make everything bigger" knob, as one ladder.
 *
 * Everything here is pure and shared by both windows (the widget and the bench)
 * plus main, so the three cannot drift into three ideas of what 130% means.
 *
 * A ladder rather than a multiplier on purpose. Repeatedly multiplying by 1.1
 * accumulates float dust (1.1 * 1.1 * 1.1 is 1.3310000000000004) and, worse,
 * zooming in five steps and back out five steps lands you somewhere that is
 * not where you started. Snapping to the nearest rung means Ctrl+- is always
 * the exact inverse of Ctrl+=, and Ctrl+0 is always the same 100%.
 */

/** Rungs, ascending. `1` is in the middle so in/out feel symmetric. */
export const ZOOM_STEPS: readonly number[] = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6]

export const ZOOM_MIN = ZOOM_STEPS[0]
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]
export const ZOOM_DEFAULT = 1

/**
 * Half a rung counts as a tie, and ties round up - like every other number the
 * human has ever rounded, so `1.25` means `1.3`.
 *
 * The rungs are decimal tenths, which binary cannot represent exactly, so
 * `Math.abs(1.1 - 1.15)` comes out *smaller* than `Math.abs(1.2 - 1.15)` by two
 * bits of noise. Without a tolerance, which rung a hand-edited `1.15` snaps to
 * is decided by that noise rather than by a rule anybody can state.
 */
const TIE_EPSILON = 1e-9

/**
 * Coerce anything read from disk into a rung we can actually apply. A value
 * between rungs (hand-edited config, an older build's range) snaps to the
 * nearest one instead of being clamped to an end, so `1.16` reads back as the
 * `1.2` the human probably meant rather than jumping to `0.7`.
 */
export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return ZOOM_DEFAULT
  if (value <= ZOOM_MIN) return ZOOM_MIN
  if (value >= ZOOM_MAX) return ZOOM_MAX
  let best = ZOOM_DEFAULT
  let bestDistance = Number.POSITIVE_INFINITY
  for (const step of ZOOM_STEPS) {
    const distance = Math.abs(step - value)
    const clearWin = distance < bestDistance - TIE_EPSILON
    const tie = Math.abs(distance - bestDistance) <= TIE_EPSILON
    const tieRoundsUp = tie && step > best
    if (clearWin || tieRoundsUp) {
      bestDistance = distance
      best = step
    }
  }
  return best
}

/** One rung further in (`dir > 0`) or out (`dir < 0`); the ends stay put. */
export function nextZoom(current: number, dir: number): number {
  const from = clampZoom(current)
  const at = ZOOM_STEPS.indexOf(from)
  // `indexOf` cannot miss after clamping, but a lookup failure must still be a
  // no-op rather than `NaN` reaching setZoomFactor.
  if (at < 0) return from
  const step = dir > 0 ? 1 : -1
  const next = at + step
  if (next < 0) return ZOOM_STEPS[0]
  if (next >= ZOOM_STEPS.length) return ZOOM_STEPS[ZOOM_STEPS.length - 1]
  return ZOOM_STEPS[next]
}

/** What the HUD says: whole percent, no float tail. */
export function zoomPercent(value: number): string {
  return `${Math.round(clampZoom(value) * 100)}%`
}

export type ZoomCommand = 'in' | 'out' | 'reset'

/**
 * Where a command lands from where you are now. One rung at a time, and `reset`
 * goes to 100% exactly rather than "back to wherever it started".
 *
 * Every caller (the menu item, the keystroke, a future settings row) goes
 * through this, so there is one answer to "what does zooming in from 1.25 do".
 */
export function zoomForCommand(current: number, command: ZoomCommand): number {
  if (command === 'reset') return ZOOM_DEFAULT
  return nextZoom(current, command === 'in' ? 1 : -1)
}

/**
 * Read a keystroke as a zoom command, or `null` when it is not one.
 *
 * Ctrl/Cmd + `=`/`+`/`-`/`_`/`0`, plus the numpad's own `Add`/`Subtract`.
 * `+` and `_` only exist while Shift is held on most layouts, and some layouts
 * put `=` where `+` is, so all four spellings of "bigger"/"smaller" are
 * accepted: the human does not have to know which one their keyboard produced.
 *
 * Deliberately *not* checking `shiftKey` as a disqualifier — Shift+= is exactly
 * how you type `+` on a US layout.
 */
export function zoomCommand(
  event: { key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }
): ZoomCommand | null {
  const key = String(event.key || '')
  const code = String(event.code || '')
  // Alt+digit is a layout switcher on several platforms; leave it alone.
  if (event.altKey) return null
  if (!(event.ctrlKey || event.metaKey)) return null
  switch (key) {
    case '=':
    case '+':
    case 'Add':
      return 'in'
    case '-':
    case '_':
    case 'Subtract':
      return 'out'
    case '0':
      // Numpad 0 reports key '0' too; `code` keeps the two apart if that ever
      // matters, but both mean "back to normal" here.
      return 'reset'
    default:
      break
  }
  if (code === 'NumpadAdd') return 'in'
  if (code === 'NumpadSubtract') return 'out'
  if (code === 'Numpad0') return 'reset'
  return null
}
