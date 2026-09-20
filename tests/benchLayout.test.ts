import { describe, expect, it } from 'vitest'
import {
  COLUMN_RANGE,
  COLUMN_SAVE_DELAY,
  RAIL_DEFAULT,
  RAIL_MAX,
  RAIL_MIN,
  RIGHT_DEFAULT,
  RIGHT_MAX,
  RIGHT_MIN,
  SPLIT_STEP,
  clampColumnWidth,
  columnVar,
  columnVarValue,
  draggedColumnWidth
} from '../src/shared/benchLayout'

/**
 * The splitter's limits are read by the drag handler, by `parseConfig` and by
 * the CSS, so a width that one of them allows and another refuses is a column
 * that jumps back when the config lands. The range is tested as one contract.
 */
describe('bench column widths', () => {
  it('keeps the shipped widths inside their own range', () => {
    expect(clampColumnWidth('rail', RAIL_DEFAULT)).toBe(RAIL_DEFAULT)
    expect(clampColumnWidth('right', RIGHT_DEFAULT)).toBe(RIGHT_DEFAULT)
    expect(RAIL_MIN).toBeLessThan(RAIL_DEFAULT)
    expect(RAIL_MAX).toBeGreaterThan(RAIL_DEFAULT)
    expect(RIGHT_MIN).toBeLessThan(RIGHT_DEFAULT)
    expect(RIGHT_MAX).toBeGreaterThan(RIGHT_DEFAULT)
  })

  it('clamps to the ends and truncates to whole pixels', () => {
    expect(clampColumnWidth('rail', 40)).toBe(RAIL_MIN)
    expect(clampColumnWidth('rail', 9000)).toBe(RAIL_MAX)
    expect(clampColumnWidth('right', 0)).toBe(RIGHT_MIN)
    expect(clampColumnWidth('right', 10_000)).toBe(RIGHT_MAX)
    expect(clampColumnWidth('rail', 264.8)).toBe(264)
  })

  it('falls back to the default rather than to a bound when the value is not a number', () => {
    expect(clampColumnWidth('rail', Number.NaN)).toBe(RAIL_DEFAULT)
    expect(clampColumnWidth('right', Number.POSITIVE_INFINITY)).toBe(RIGHT_DEFAULT)
  })

  it('grows the rail to the right and the right panel to the left', () => {
    // The rail is on the left: dragging its handle right makes it wider.
    expect(draggedColumnWidth('rail', RAIL_DEFAULT, 40, 1)).toBe(RAIL_DEFAULT + 40)
    expect(draggedColumnWidth('rail', RAIL_DEFAULT, -40, 1)).toBe(RAIL_DEFAULT - 40)
    // The right panel is on the right: the same drag makes it narrower.
    expect(draggedColumnWidth('right', RIGHT_DEFAULT, 40, -1)).toBe(RIGHT_DEFAULT - 40)
    expect(draggedColumnWidth('right', RIGHT_DEFAULT, -40, -1)).toBe(RIGHT_DEFAULT + 40)
  })

  it('stops at the ends instead of overshooting', () => {
    expect(draggedColumnWidth('rail', RAIL_DEFAULT, 10_000, 1)).toBe(RAIL_MAX)
    expect(draggedColumnWidth('rail', RAIL_DEFAULT, -10_000, 1)).toBe(RAIL_MIN)
    expect(draggedColumnWidth('right', RIGHT_DEFAULT, -10_000, -1)).toBe(RIGHT_MAX)
  })

  it('starts a drag from a value that is already legal', () => {
    expect(draggedColumnWidth('rail', RAIL_MAX + 90, 0, 1)).toBe(RAIL_MAX)
  })

  it('names one CSS variable per column, and one pixel string', () => {
    expect(columnVar('rail')).toBe('--rail-w')
    expect(columnVar('right')).toBe('--right-w')
    expect(columnVarValue(264.9)).toBe('264px')
  })

  it('lists both columns in the range table', () => {
    expect(Object.keys(COLUMN_RANGE).sort()).toEqual(['rail', 'right'])
  })

  /**
   * The keyboard path is the one nobody exercises by hand, so its numbers are
   * pinned here: a step large enough to overshoot the width you were aiming at is
   * worse than no keyboard resize at all, and a save delay of zero is a disk
   * write per keypress for as long as a key is held down.
   */
  it('steps by a distance the ends cannot overshoot', () => {
    expect(SPLIT_STEP).toBeGreaterThan(0)
    expect(SPLIT_STEP).toBeLessThanOrEqual(16)
    for (const column of ['rail', 'right'] as const) {
      const { min, max } = COLUMN_RANGE[column]
      expect(draggedColumnWidth(column, max, SPLIT_STEP, 1)).toBe(max)
      expect(draggedColumnWidth(column, min, -SPLIT_STEP, 1)).toBe(min)
    }
  })

  it('coalesces the durable write instead of writing once per keypress', () => {
    expect(COLUMN_SAVE_DELAY).toBeGreaterThanOrEqual(150)
    expect(COLUMN_SAVE_DELAY).toBeLessThanOrEqual(1000)
  })
})
