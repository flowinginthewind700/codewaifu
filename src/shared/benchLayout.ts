/**
 * The bench's two side columns: how wide they are, and how far a drag may take
 * them.
 *
 * Pure and shared so the renderer, `parseConfig` and the tests all agree on one
 * answer to "what is a sane rail width". The CSS owns the pixels (`--rail-w` /
 * `--right-w` on `.bench`); this file owns the range, so a hand-edited
 * config.json or a drag that overshoots cannot leave a column too narrow to read
 * or wide enough to squeeze the terminal out of the window.
 */

/** The shipped widths, in CSS pixels. Also what a reset goes back to. */
export const RAIL_DEFAULT = 264
export const RIGHT_DEFAULT = 344

/**
 * Lower bound is "the narrowest a column is still worth its screen space":
 * the rail has to fit a task name and a status tag, the right panel a queue row
 * with its verb buttons.
 */
export const RAIL_MIN = 180
export const RIGHT_MIN = 260

/**
 * Upper bound is generous but finite. Both columns live beside `minmax(0, 1fr)`,
 * so an enormous value does not break the layout - it just starves the terminal.
 * The 760px window minimum means anything past ~520px leaves no room at all.
 */
export const RAIL_MAX = 420
export const RIGHT_MAX = 520

/** Which column a splitter drag is moving. */
export type BenchColumn = 'rail' | 'right'

/**
 * The breakpoints at which a column stops being furniture and becomes a drawer,
 * in CSS pixels. These mirror the media queries in `bench.css`, and the renderer
 * reads them through `isDrawerColumn` instead of re-spelling the numbers: a
 * click that closes a permanent column because it thought the window was narrow
 * is a panel that vanished for no visible reason.
 */
export const RAIL_DRAWER_MAX = 720
export const RIGHT_DRAWER_MAX = 980

/**
 * Whether a column is an overlay drawer at this viewport width.
 *
 * Only a drawer closes when you open a task. On a wide window the two columns
 * are part of the layout, and snapping them shut on every row click would make
 * the bench forget its own shape.
 */
export function isDrawerColumn(column: BenchColumn, viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth)) return false
  return viewportWidth <= (column === 'rail' ? RAIL_DRAWER_MAX : RIGHT_DRAWER_MAX)
}

/** The two limits, by column, so a drag handler needs no switch. */
export const COLUMN_RANGE: Record<BenchColumn, { min: number; max: number; fallback: number }> = {
  rail: { min: RAIL_MIN, max: RAIL_MAX, fallback: RAIL_DEFAULT },
  right: { min: RIGHT_MIN, max: RIGHT_MAX, fallback: RIGHT_DEFAULT }
}

/**
 * How far one arrow press moves a seam, in CSS pixels.
 *
 * A splitter is a real control, so it has to be usable without a pointer, and
 * the step has to be small enough to land where you meant: eight presses across
 * a typical drag's worth of travel, and `Enter` undoes the whole thing anyway.
 */
export const SPLIT_STEP = 8

/**
 * How long a burst of arrow presses may run before the width is written to disk.
 *
 * The column moves on every press, so the resize itself is immediate; only the
 * durable write waits. Half a second covers key repeat at any OS rate while
 * still landing inside the moment the user believes they stopped.
 */
export const COLUMN_SAVE_DELAY = 500

/**
 * Coerce anything - a drag position, a config value, a hand-typed number - into
 * an integer pixel width this column may actually use.
 *
 * A non-finite or missing value falls back to the default rather than to the
 * nearest bound: "I do not know" should mean "ship it as designed", not "make it
 * as small as the rules allow".
 */
export function clampColumnWidth(column: BenchColumn, value: number): number {
  const { min, max, fallback } = COLUMN_RANGE[column]
  if (!Number.isFinite(value)) return fallback
  return Math.trunc(Math.min(max, Math.max(min, value)))
}

/**
 * Where a splitter drag lands.
 *
 * The two columns grow in opposite directions: the rail is on the left, so
 * dragging its handle right makes it wider, while the right panel is on the
 * right, so dragging *its* handle right makes it narrower. `sign` is the caller
 * saying which of the two it is dragging, so this function stays the one place
 * that knows the limits.
 */
export function draggedColumnWidth(
  column: BenchColumn,
  startWidth: number,
  deltaX: number,
  sign: 1 | -1
): number {
  return clampColumnWidth(column, startWidth + sign * deltaX)
}

/**
 * The CSS custom property a column's width is written to, and the inline style
 * value for it. Kept here because the drag handler, the initial mount and the
 * tests all have to name the same two variables.
 */
export function columnVar(column: BenchColumn): '--rail-w' | '--right-w' {
  return column === 'rail' ? '--rail-w' : '--right-w'
}

export function columnVarValue(width: number): string {
  return `${Math.trunc(width)}px`
}
