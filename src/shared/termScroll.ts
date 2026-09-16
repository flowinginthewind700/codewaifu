/**
 * Terminal scrollback: pure decisions, no DOM.
 *
 * The pane in Pro is not a local PTY. herdr keeps the scrollback for a pane on
 * its side and repaints whatever window it is showing, so "scroll up" is a
 * message, not a property of xterm's buffer. That has two consequences this
 * file exists to keep honest:
 *
 * 1. xterm's own viewport cannot be trusted to answer the wheel. Its buffer
 *    only holds bytes that arrived since we attached, so wheeling over a codex
 *    session that had been running for an hour would scroll a nearly empty
 *    buffer while the history the user wants sits in herdr. The wheel is
 *    therefore taken away from xterm entirely and translated into a request.
 * 2. The translation is lossy in ways that matter. A trackpad delivers
 *    fractional pixel deltas and a mouse wheel delivers chunky ones, and herdr
 *    only understands whole lines; accumulating the remainder is the difference
 *    between a trackpad that scrolls and one that appears dead on the first
 *    gentle flick.
 *
 * Everything here is synchronous and side-effect free so a test can pin the
 * gesture-to-lines mapping without a renderer.
 */
import { TERMINAL_SCROLL_LINES_MAX } from './herdr'

/**
 * Line height of the pane terminal: 12.5px font at 1.22 line height, which is
 * what `Pane.tsx` hands xterm. The number only has to be close - it converts a
 * pixel delta into "how many lines did the user mean" - but it has to be the
 * same number, or a wheel notch scrolls a different distance than it looks like
 * it should.
 */
export const PX_PER_LINE = 15

/** DOM `WheelEvent.deltaMode` values, named because 0/1/2 read as noise. */
export const DELTA_MODE_PIXEL = 0
export const DELTA_MODE_LINE = 1
export const DELTA_MODE_PAGE = 2

/**
 * The fields a scroll decision reads; a DOM `WheelEvent` satisfies this.
 */
export interface WheelDelta {
  deltaY: number
  deltaMode: number
}

/**
 * How many lines this wheel event asks for, signed: negative scrolls up into
 * history, positive scrolls down towards the live edge. Returns a float on
 * purpose - the caller accumulates and flushes whole lines, because a trackpad
 * emits a long run of sub-line deltas that each round to zero.
 *
 * `deltaMode` is honoured rather than assumed. Firefox on Linux reports lines,
 * and a page-mode delta (rare, but real on some mice and every browser's
 * synthesized keyboard wheel) means "move a viewport", so multiplying it by the
 * pixel line height would fling the pane several thousand lines.
 */
export function wheelLines(event: WheelDelta, rows: number, pxPerLine = PX_PER_LINE): number {
  const delta = Number.isFinite(event.deltaY) ? event.deltaY : 0
  if (!delta) return 0
  switch (event.deltaMode) {
    case DELTA_MODE_LINE:
      return delta
    case DELTA_MODE_PAGE:
      // One page minus the line the eye is already reading, which is what every
      // pager does: a full viewport step loses the sentence you were on.
      return delta * Math.max(1, rows - 1)
    case DELTA_MODE_PIXEL:
    default:
      return delta / Math.max(1, pxPerLine)
  }
}

/**
 * Turn an accumulated float into whole lines to send, keeping the remainder for
 * the next event.
 *
 * The remainder is what makes a trackpad work. A gentle flick arrives as a long
 * run of sub-line deltas; sending a whole line for each one would scroll sixty
 * lines in response to six lines of intent, which feels like the pane is running
 * away. Waiting for a whole line instead is what makes a terminal feel dead on
 * the first flick. So the fraction is carried, signed, and only becomes a line
 * once it has actually earned one - which also means a very slow flick that
 * never reaches a line never scrolls, correctly, because the user never asked
 * for a line.
 *
 * The one exception is the *first* movement of a gesture. `kick` says "nothing
 * has been sent yet", and there the function sends a single line in the
 * direction of travel so the pane answers immediately; the debt is recorded in
 * the returned remainder and paid back out of the following events.
 */
export function flushLines(pending: number, kick = false): { lines: number; rest: number } {
  if (!Number.isFinite(pending) || !pending) return { lines: 0, rest: 0 }
  const whole = Math.trunc(pending)
  const rest = pending - whole
  if (whole) return { lines: whole, rest }
  if (!kick) return { lines: 0, rest: pending }
  // Borrow one line against the accumulator: the remainder is now one line
  // further from zero in the opposite direction, so the following events pay it
  // back before the pane moves again.
  const direction = pending > 0 ? 1 : -1
  return { lines: direction, rest: pending - direction }
}

export type ScrollDirection = 'up' | 'down'

export interface ScrollRequest {
  direction: ScrollDirection
  lines: number
  source: 'wheel' | 'page_key'
}

/**
 * Shift+PageUp / Shift+PageDown, the pair every terminal user reaches for and
 * the only keyboard path to history here. Plain PageUp/PageDown are left alone:
 * they belong to whatever is running in the pane, and a `less` session or a
 * TUI's own pager needs them.
 *
 * `rows` is the pane's viewport height in cells, so one press moves exactly one
 * screenful minus the overlap line, matching what a pager does.
 */
export function pageScroll(
  event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  rows: number
): ScrollRequest | null {
  if (!event.shiftKey) return null
  // Ctrl/Meta/Alt are left for the terminal and for the OS.
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  const direction: ScrollDirection | null =
    event.key === 'PageUp' ? 'up' : event.key === 'PageDown' ? 'down' : null
  if (!direction) return null
  return { direction, lines: pageLines(rows), source: 'page_key' }
}

/** One screenful minus the line you are already reading. */
export function pageLines(rows: number): number {
  return clampLines(Math.max(1, Math.trunc(rows) - 1))
}

/**
 * Relative distance from "here" to the live edge, for the panes that want to
 * express the jump as a scroll rather than an absolute offset. herdr's `lines`
 * is a `u16`, so this saturates rather than overflowing: a pane with more
 * history than that needs the absolute `pane.scroll` call, and the caller that
 * uses this one has already accepted the ceiling.
 */
export function jumpLines(scroll: { offsetFromBottom: number }): number {
  return clampLines(scroll.offsetFromBottom)
}

/** Clamp into the range herdr will actually accept, never below one line. */
export function clampLines(lines: number): number {
  if (!Number.isFinite(lines)) return 1
  return Math.min(TERMINAL_SCROLL_LINES_MAX, Math.max(1, Math.trunc(lines)))
}

/**
 * What a wheel gesture should send, or null when it should send nothing.
 *
 * A downward scroll that is already at the live edge is dropped: herdr would
 * answer with a repaint of the same viewport, and the pane is showing output
 * that is still arriving, so the round trip is pure noise. Upward scroll is
 * never dropped on a guess about how much history exists - `maxOffsetFromBottom`
 * is only as fresh as the last event, and stopping a legitimate scroll because
 * of a stale zero is worse than one wasted request.
 */
export function wheelRequest(
  lines: number,
  scroll: { offsetFromBottom: number } | null
): ScrollRequest | null {
  if (!Number.isFinite(lines) || !lines) return null
  const direction: ScrollDirection = lines > 0 ? 'down' : 'up'
  if (direction === 'down' && (scroll?.offsetFromBottom ?? 0) <= 0) return null
  return { direction, lines: clampLines(Math.abs(lines)), source: 'wheel' }
}
