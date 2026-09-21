import { describe, expect, it } from 'vitest'
import {
  FLIGHT_MAX_TRAVEL,
  easeIn,
  easeOut,
  flightFrame,
  flightOffset
} from '../src/shared/benchFlight'

/**
 * The bench's flight is 200ms of window positions, which is exactly the kind of
 * thing nobody can review by watching. So the numbers are pure and the contract
 * is written down here instead: never resize, never overshoot the cap, and land
 * back on the resting corner to the DIP.
 */
const rest = { x: 400, y: 300 }

describe('flightOffset', () => {
  it('has nowhere to go when the widget is not on screen', () => {
    expect(flightOffset({ rest, anchor: null })).toEqual({ x: 0, y: 0 })
  })

  it('has nowhere to go when the anchor is already the resting corner', () => {
    expect(flightOffset({ rest, anchor: { ...rest } })).toEqual({ x: 0, y: 0 })
  })

  it('points at the anchor, not merely in its general direction', () => {
    const offset = flightOffset({ rest, anchor: { x: 400 + 300, y: 300 } })
    expect(offset).toEqual({ x: 300, y: 0 })
    const up = flightOffset({ rest, anchor: { x: 400, y: 300 - 120 } })
    expect(up).toEqual({ x: 0, y: -120 })
  })

  it('preserves the direction of a diagonal anchor while capping the length', () => {
    const offset = flightOffset({ rest, anchor: { x: 400 + 4000, y: 300 + 4000 } })
    expect(offset.x).toBe(offset.y)
    expect(Math.hypot(offset.x, offset.y)).toBeLessThanOrEqual(FLIGHT_MAX_TRAVEL + 1)
    expect(offset.x).toBeGreaterThan(0)
  })

  it('caps travel at the documented maximum', () => {
    const far = flightOffset({ rest, anchor: { x: 400 + 9000, y: 300 } })
    expect(far).toEqual({ x: FLIGHT_MAX_TRAVEL, y: 0 })
  })

  it('honours a caller-supplied cap', () => {
    const capped = flightOffset({ rest, anchor: { x: 400 + 500, y: 300 }, maxTravel: 40 })
    expect(capped).toEqual({ x: 40, y: 0 })
  })

  it('treats a zero or negative cap as no travel', () => {
    expect(flightOffset({ rest, anchor: { x: 900, y: 900 }, maxTravel: 0 })).toEqual({ x: 0, y: 0 })
    expect(flightOffset({ rest, anchor: { x: 900, y: 900 }, maxTravel: -50 })).toEqual({
      x: 0,
      y: 0
    })
  })

  it('emits whole DIPs, since a fractional window position is a guessed pixel', () => {
    const offset = flightOffset({ rest, anchor: { x: 400 + 7, y: 300 + 11 } })
    expect(Number.isInteger(offset.x)).toBe(true)
    expect(Number.isInteger(offset.y)).toBe(true)
  })

  it('ignores a non-finite anchor', () => {
    expect(flightOffset({ rest, anchor: { x: Number.NaN, y: 300 } })).toEqual({ x: 0, y: 0 })
  })
})

describe('flight easing', () => {
  it('runs 0 to 1 and stays inside it', () => {
    for (const ease of [easeIn, easeOut]) {
      expect(ease(0)).toBe(0)
      expect(ease(1)).toBe(1)
      expect(ease(0.5)).toBeGreaterThan(0)
      expect(ease(0.5)).toBeLessThan(1)
    }
  })

  it('clamps instead of extrapolating past the ends', () => {
    expect(easeIn(-3)).toBe(0)
    expect(easeOut(-3)).toBe(0)
    expect(easeIn(4)).toBe(1)
    expect(easeOut(4)).toBe(1)
  })

  it('leaves slow and arrives soft', () => {
    // ease-in cubic lags the midpoint, ease-out cubic leads it: the departure
    // hangs on and the arrival decelerates.
    expect(easeIn(0.5)).toBeLessThan(0.5)
    expect(easeOut(0.5)).toBeGreaterThan(0.5)
  })

  it('is monotonic, so the window never doubles back', () => {
    for (const ease of [easeIn, easeOut]) {
      let previous = -1
      for (let i = 0; i <= 100; i += 1) {
        const value = ease(i / 100)
        expect(value).toBeGreaterThanOrEqual(previous)
        previous = value
      }
    }
  })

  it('does not invent a number out of NaN', () => {
    expect(easeIn(Number.NaN)).toBe(0)
    expect(easeOut(Number.NaN)).toBe(0)
  })
})

describe('flightFrame', () => {
  const anchor = { x: 400 + 300, y: 300 }
  const input = { rest, anchor }

  it('departs from the resting corner, opaque', () => {
    expect(flightFrame(input, 0, 'out')).toEqual({ x: rest.x, y: rest.y, opacity: 1 })
  })

  it('arrives from the far end, transparent', () => {
    const frame = flightFrame(input, 0, 'in')
    expect(frame.x).toBe(rest.x + 300)
    expect(frame.y).toBe(rest.y)
    expect(frame.opacity).toBe(0)
  })

  it('ends exactly on the resting corner at full opacity, both ways', () => {
    expect(flightFrame(input, 1, 'out')).toEqual({ x: rest.x + 300, y: rest.y, opacity: 0 })
    expect(flightFrame(input, 1, 'in')).toEqual({ x: rest.x, y: rest.y, opacity: 1 })
  })

  it('travels only along the path to the anchor', () => {
    for (let i = 0; i <= 20; i += 1) {
      const frame = flightFrame(input, i / 20, 'in')
      expect(frame.x).toBeGreaterThanOrEqual(rest.x)
      expect(frame.x).toBeLessThanOrEqual(rest.x + 300)
    }
  })

  it('never drifts off its own axis', () => {
    for (let i = 0; i <= 50; i += 1) {
      expect(flightFrame(input, i / 50, 'out').y).toBe(rest.y)
      expect(flightFrame(input, i / 50, 'in').y).toBe(rest.y)
    }
  })

  it('keeps opacity inside 0..1 and moving toward the right end', () => {
    let previous = -1
    for (let i = 0; i <= 100; i += 1) {
      const frame = flightFrame(input, i / 100, 'in')
      expect(frame.opacity).toBeGreaterThanOrEqual(0)
      expect(frame.opacity).toBeLessThanOrEqual(1)
      expect(frame.opacity).toBeGreaterThanOrEqual(previous)
      previous = frame.opacity
    }
    let next = 2
    for (let i = 0; i <= 100; i += 1) {
      const frame = flightFrame(input, i / 100, 'out')
      expect(frame.opacity).toBeLessThanOrEqual(next)
      next = frame.opacity
    }
  })

  it('is a fade in place when the widget is gone', () => {
    const alone = { rest, anchor: null }
    for (let i = 0; i <= 20; i += 1) {
      const frame = flightFrame(alone, i / 20, 'out')
      expect(frame.x).toBe(rest.x)
      expect(frame.y).toBe(rest.y)
    }
  })

  it('clamps time, so a stalled timer cannot throw the window across the screen', () => {
    expect(flightFrame(input, 99, 'out')).toEqual(flightFrame(input, 1, 'out'))
    expect(flightFrame(input, -99, 'in')).toEqual(flightFrame(input, 0, 'in'))
  })

  it('emits whole DIP positions throughout', () => {
    for (let i = 0; i <= 100; i += 1) {
      for (const direction of ['in', 'out'] as const) {
        const frame = flightFrame({ rest: { x: 10.4, y: 20.6 }, anchor }, i / 100, direction)
        expect(Number.isInteger(frame.x)).toBe(true)
        expect(Number.isInteger(frame.y)).toBe(true)
      }
    }
  })
})
