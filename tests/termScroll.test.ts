/**
 * Gesture to lines, without a renderer.
 *
 * The mapping is worth pinning because it is the whole reason scrollback works
 * in a Pro pane: herdr owns the history, so a wheel event has to become a
 * request, and every one of these numbers is a judgement about how far the user
 * meant to move. Getting `deltaMode` wrong does not throw - it scrolls three
 * lines where the user asked for three screens, or nothing at all.
 */
import { describe, expect, it } from 'vitest'
import {
  DELTA_MODE_LINE,
  DELTA_MODE_PAGE,
  DELTA_MODE_PIXEL,
  PX_PER_LINE,
  clampLines,
  flushLines,
  jumpLines,
  pageLines,
  pageScroll,
  wheelLines,
  wheelRequest,
  type WheelDelta
} from '../src/shared/termScroll'
import { TERMINAL_SCROLL_LINES_MAX } from '../src/shared/herdr'

const px = (deltaY: number): WheelDelta => ({ deltaY, deltaMode: DELTA_MODE_PIXEL })
const line = (deltaY: number): WheelDelta => ({ deltaY, deltaMode: DELTA_MODE_LINE })
const page = (deltaY: number): WheelDelta => ({ deltaY, deltaMode: DELTA_MODE_PAGE })

const key = (
  key: string,
  mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}
): { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean } => ({
  key,
  shiftKey: mods.shiftKey ?? false,
  ctrlKey: mods.ctrlKey ?? false,
  metaKey: mods.metaKey ?? false,
  altKey: mods.altKey ?? false
})

describe('wheelLines', () => {
  it('converts a pixel delta at the pane line height', () => {
    // One notch of an ordinary mouse wheel is 100px in Chromium, and at 15px a
    // line that is six and two thirds lines - the fraction is kept, because the
    // caller accumulates it and the next notch finishes the line.
    expect(wheelLines(px(-100), 24)).toBeCloseTo(-100 / PX_PER_LINE)
    expect(wheelLines(px(150), 24)).toBeCloseTo(10)
  })

  it('takes a line-mode delta at face value', () => {
    // Firefox on Linux reports lines, and multiplying those by a pixel height
    // would fling the pane hundreds of rows on one notch.
    expect(wheelLines(line(-3), 24)).toBe(-3)
    expect(wheelLines(line(7), 24)).toBe(7)
  })

  it('reads a page-mode delta as one viewport minus the overlap line', () => {
    expect(wheelLines(page(-1), 24)).toBe(-23)
    expect(wheelLines(page(2), 24)).toBe(46)
  })

  it('survives a one-row pane instead of asking herdr for zero lines', () => {
    expect(wheelLines(page(-1), 1)).toBe(-1)
    expect(wheelLines(page(-1), 0)).toBe(-1)
  })

  it('is zero for no movement and for a delta that is not a number', () => {
    expect(wheelLines(px(0), 24)).toBe(0)
    expect(wheelLines({ deltaY: Number.NaN, deltaMode: DELTA_MODE_PIXEL }, 24)).toBe(0)
  })

  it('honours an explicit line height, so a pane that changes font follows', () => {
    expect(wheelLines(px(-30), 24, 10)).toBe(-3)
  })
})

describe('flushLines', () => {
  it('sends whole lines and keeps the remainder signed', () => {
    expect(flushLines(-6.75)).toEqual({ lines: -6, rest: -0.75 })
    expect(flushLines(2.5)).toEqual({ lines: 2, rest: 0.5 })
  })

  it('still moves one line on a sub-line trackpad flick', () => {
    // A gentle flick arrives as a run of deltas that each truncate to zero. If
    // the first one waited for company, the pane would not move at all and the
    // gesture would read as a dead terminal - which is the bug this file exists
    // to prevent, so the first flush of a gesture is allowed to borrow a line.
    // The remainder records the debt, signed away from zero, so the following
    // events pay it back instead of compounding it.
    const up = flushLines(-0.4, true)
    expect(up.lines).toBe(-1)
    expect(up.rest).toBeCloseTo(0.6)
    const down = flushLines(0.9, true)
    expect(down.lines).toBe(1)
    expect(down.rest).toBeCloseTo(-0.1)
  })

  it('waits for a whole line once a gesture is already under way', () => {
    // Without the kick, a sub-line remainder is just savings towards the next
    // line. Sending one anyway would scroll a line per event on a trackpad,
    // which is the pane running away from the gesture rather than following it.
    expect(flushLines(-0.4)).toMatchObject({ lines: 0 })
    expect(flushLines(-0.9)).toMatchObject({ lines: 0 })
    const earned = flushLines(-1.2)
    expect(earned.lines).toBe(-1)
    expect(earned.rest).toBeCloseTo(-0.2)
  })

  it('does the nothing on nothing', () => {
    expect(flushLines(0)).toEqual({ lines: 0, rest: 0 })
    expect(flushLines(Number.NaN)).toEqual({ lines: 0, rest: 0 })
    expect(flushLines(Number.POSITIVE_INFINITY)).toEqual({ lines: 0, rest: 0 })
  })

  it('scrolls the distance a trackpad flick asked for, not one line per event', () => {
    let pending = 0
    const sent: number[] = []
    // Sixty events of -1.5px each: 0.1 lines of intent per event, six lines in
    // total. The first flush borrows a line so the pane answers at once; the
    // rest of the run is that debt being repaid and the earned lines arriving.
    for (let i = 0; i < 60; i += 1) {
      pending += wheelLines(px(-1.5), 24)
      const { lines, rest } = flushLines(pending, sent.length === 0)
      pending = rest
      if (lines) sent.push(lines)
    }
    const travelled = sent.reduce((total, lines) => total + lines, 0)
    // Six lines asked for, five moved and one still owed through `pending`:
    // the borrowed first line is paid back out of the run rather than added to
    // it. Sixty - one per event - is the failure this guards against.
    expect(travelled + pending).toBeCloseTo(-6)
    expect(sent.length, 'a flick is a few requests, not one per event').toBeLessThan(10)
    expect(Math.abs(pending)).toBeLessThan(1)
  })
})

describe('pageScroll', () => {
  it('claims Shift+PageUp and Shift+PageDown only', () => {
    expect(pageScroll(key('PageUp', { shiftKey: true }), 24)).toEqual({
      direction: 'up',
      lines: 23,
      source: 'page_key'
    })
    expect(pageScroll(key('PageDown', { shiftKey: true }), 24)).toEqual({
      direction: 'down',
      lines: 23,
      source: 'page_key'
    })
  })

  it('leaves plain PageUp/PageDown to whatever is running in the pane', () => {
    // `less`, a TUI pager, and an agent's own fullscreen view all bind these.
    // Taking them would break the one program the user opened on purpose.
    expect(pageScroll(key('PageUp'), 24)).toBeNull()
    expect(pageScroll(key('PageDown'), 24)).toBeNull()
  })

  it('leaves the chord alone when another modifier is held', () => {
    expect(pageScroll(key('PageUp', { shiftKey: true, ctrlKey: true }), 24)).toBeNull()
    expect(pageScroll(key('PageUp', { shiftKey: true, metaKey: true }), 24)).toBeNull()
    expect(pageScroll(key('PageUp', { shiftKey: true, altKey: true }), 24)).toBeNull()
  })

  it('ignores every other key, including the ones that look similar', () => {
    for (const other of ['Home', 'End', 'ArrowUp', 'p', 'PageUp '.trim() + 'x']) {
      expect(pageScroll(key(other, { shiftKey: true }), 24)).toBeNull()
    }
  })
})

describe('pageLines', () => {
  it('is one screenful minus the line already on screen', () => {
    expect(pageLines(24)).toBe(23)
    expect(pageLines(1)).toBe(1)
    expect(pageLines(0)).toBe(1)
  })
})

describe('clampLines', () => {
  it('saturates at the u16 herdr deserializes rather than overflowing it', () => {
    expect(clampLines(TERMINAL_SCROLL_LINES_MAX + 1)).toBe(TERMINAL_SCROLL_LINES_MAX)
    expect(clampLines(Number.MAX_SAFE_INTEGER)).toBe(TERMINAL_SCROLL_LINES_MAX)
    expect(clampLines(0)).toBe(1)
    expect(clampLines(-50)).toBe(1)
    expect(clampLines(12.9)).toBe(12)
    expect(clampLines(Number.NaN)).toBe(1)
  })
})

describe('jumpLines', () => {
  it('is the distance back to the live edge, clamped', () => {
    expect(jumpLines({ offsetFromBottom: 1296 })).toBe(1296)
    expect(jumpLines({ offsetFromBottom: TERMINAL_SCROLL_LINES_MAX * 2 })).toBe(
      TERMINAL_SCROLL_LINES_MAX
    )
    expect(jumpLines({ offsetFromBottom: 0 })).toBe(1)
  })
})

describe('wheelRequest', () => {
  it('scrolls up from anywhere, including a pane that reports no history yet', () => {
    // `maxOffsetFromBottom` is only as fresh as the last event. Refusing an
    // upward scroll because a stale zero said "nothing back there" would be the
    // exact failure this whole feature is fixing, so up always goes through.
    expect(wheelRequest(-6, { offsetFromBottom: 0 })).toEqual({
      direction: 'up',
      lines: 6,
      source: 'wheel'
    })
    expect(wheelRequest(-6, null)).toMatchObject({ direction: 'up', lines: 6 })
  })

  it('scrolls down while there is history below the viewport', () => {
    expect(wheelRequest(4, { offsetFromBottom: 90 })).toEqual({
      direction: 'down',
      lines: 4,
      source: 'wheel'
    })
  })

  it('drops a downward scroll that is already at the live edge', () => {
    // herdr would answer with a repaint of the same viewport. On a pane that is
    // still printing, that is a round trip per wheel notch for nothing.
    expect(wheelRequest(4, { offsetFromBottom: 0 })).toBeNull()
    expect(wheelRequest(4, null)).toBeNull()
  })

  it('asks for nothing when the gesture said nothing', () => {
    expect(wheelRequest(0, { offsetFromBottom: 90 })).toBeNull()
    expect(wheelRequest(Number.NaN, { offsetFromBottom: 90 })).toBeNull()
  })

  it('clamps an absurd gesture instead of forwarding it to a u16 field', () => {
    expect(wheelRequest(1e9, { offsetFromBottom: 1e9 })?.lines).toBe(TERMINAL_SCROLL_LINES_MAX)
  })
})
