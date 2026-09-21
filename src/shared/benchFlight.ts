/**
 * The Bench window's flight path, as plain numbers.
 *
 * The stage's bench button is a switch, and a switch that snaps a 1600px window
 * in and out of existence reads as a glitch rather than as the same object
 * leaving and returning. So the window darts: it slides toward the widget that
 * summoned it and fades, and comes back the same way.
 *
 * Two rules shape the numbers here, and both are reasons this is a module of its
 * own rather than a loop inside the window code:
 *
 * 1. **The frame moves, the frame never resizes.** A bounds tween is what makes
 *    a window feel squeezed, but every size change reflows the xterm instances
 *    inside it and each reflow is a PTY resize that redraws an agent's whole
 *    screen. Position changes fire neither, so the flight is a translate plus an
 *    opacity ramp and the window keeps its exact size from first frame to last.
 * 2. **Travel is capped.** The widget sits wherever the human dragged it, which
 *    can be a screen away from the bench. Crossing all of that in 200ms is a pan
 *    over the desktop, not a dart, so the path is the direction to the anchor
 *    with a maximum length.
 *
 * Pure, because the alternative is testing a window animation by looking at it.
 */

/** A point in screen DIPs. */
export interface FlightPoint {
  x: number
  y: number
}

/**
 * How far the window travels, at most. Past roughly this the motion stops
 * reading as "this window moved" and starts reading as "something is wrong".
 */
export const FLIGHT_MAX_TRAVEL = 360

/** One frame of the flight: where the window is, and how opaque it is. */
export interface FlightFrame {
  x: number
  y: number
  /** 0..1. Linux ignores it; see `main/pro/benchWindow.ts`. */
  opacity: number
}

export interface FlightInput {
  /** Where the window rests: its top-left corner, in screen DIPs. */
  rest: FlightPoint
  /**
   * The point it flies from and to - the widget's centre. `null` means the
   * widget is not up, so there is nowhere to dart to and the flight is a fade in
   * place.
   */
  anchor: FlightPoint | null
  /** Cap on the travel; see `FLIGHT_MAX_TRAVEL`. */
  maxTravel?: number
}

/**
 * The offset from rest to the far end of the path: the direction of the anchor,
 * clamped to `maxTravel` and rounded to whole DIPs, because a fractional window
 * position is a fractional pixel the compositor has to guess at.
 */
export function flightOffset(input: FlightInput): FlightPoint {
  const { rest, anchor } = input
  const maxTravel = Math.max(0, input.maxTravel ?? FLIGHT_MAX_TRAVEL)
  if (!anchor) return { x: 0, y: 0 }
  const dx = anchor.x - rest.x
  const dy = anchor.y - rest.y
  const distance = Math.hypot(dx, dy)
  if (!Number.isFinite(distance) || distance < 1) return { x: 0, y: 0 }
  const travel = Math.min(distance, maxTravel)
  return { x: Math.round((dx / distance) * travel), y: Math.round((dy / distance) * travel) }
}

/** Ease-out cubic: launched hard, landed soft. The curve the window arrives on. */
export function easeOut(t: number): number {
  const x = clamp01(t)
  return 1 - Math.pow(1 - x, 3)
}

/** Ease-in cubic: slow to let go, then pulled. The curve the window leaves on. */
export function easeIn(t: number): number {
  const x = clamp01(t)
  return x * x * x
}

function clamp01(t: number): number {
  if (!Number.isFinite(t)) return 0
  return Math.min(1, Math.max(0, t))
}

/**
 * One frame.
 *
 * `out` runs rest -> offset and 1 -> 0; `in` is the same path backwards. Both
 * end exactly on the resting corner rather than within a pixel of it: the last
 * thing a flight should leave behind is a window that moved by accident.
 */
export function flightFrame(input: FlightInput, t: number, direction: 'in' | 'out'): FlightFrame {
  const offset = flightOffset(input)
  const progress = clamp01(t)
  const k = direction === 'out' ? easeIn(progress) : easeOut(progress)
  const along = direction === 'out' ? k : 1 - k
  return {
    x: Math.round(input.rest.x + offset.x * along),
    y: Math.round(input.rest.y + offset.y * along),
    // Opacity follows the position, so the window is never transparent while it
    // is sitting at the corner the human expects it at.
    opacity: direction === 'out' ? 1 - k : k
  }
}
