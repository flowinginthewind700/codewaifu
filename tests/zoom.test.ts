import { describe, expect, it } from 'vitest'
import {
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEPS,
  clampZoom,
  nextZoom,
  zoomCommand,
  zoomForCommand,
  zoomPercent
} from '../src/shared/zoom'

/**
 * Both windows and main read these numbers, so a rung that is not exactly its
 * own inverse, or a keystroke that silently means "reset to 70%", is a bug the
 * human cannot see coming. The ladder contract is tested as a whole.
 */
describe('zoom ladder', () => {
  it('has 100% as a rung, not as an accident of arithmetic', () => {
    expect(ZOOM_STEPS).toContain(ZOOM_DEFAULT)
    expect(ZOOM_MIN).toBeLessThan(ZOOM_DEFAULT)
    expect(ZOOM_MAX).toBeGreaterThan(ZOOM_DEFAULT)
  })

  it('is ascending and duplicate-free', () => {
    const sorted = [...ZOOM_STEPS].sort((a, b) => a - b)
    expect(ZOOM_STEPS).toEqual(sorted)
    expect(new Set(ZOOM_STEPS).size).toBe(ZOOM_STEPS.length)
  })

  it('snaps an off-rung value to the nearest rung instead of clamping it', () => {
    expect(clampZoom(1.16)).toBe(1.2)
    expect(clampZoom(1.24)).toBe(1.2)
    expect(clampZoom(0.95)).toBe(1)
  })

  it('rounds a half step up, rather than letting float noise decide', () => {
    // `Math.abs(1.1 - 1.15)` comes out two bits smaller than
    // `Math.abs(1.2 - 1.15)`, so a plain nearest-wins scan sends 1.15 down.
    // The stated rule is that a tie rounds up, which is the rule anyone
    // reading `1.15` in a config file would guess.
    expect(clampZoom(1.15)).toBe(1.2)
    expect(clampZoom(1.25)).toBe(1.3)
    expect(clampZoom(0.75)).toBe(0.8)
    expect(clampZoom(1.55)).toBe(1.6)
  })

  it('clamps a wild value to the ends and a broken one to default', () => {
    expect(clampZoom(9)).toBe(ZOOM_MAX)
    expect(clampZoom(-3)).toBe(ZOOM_MIN)
    expect(clampZoom(Number.NaN)).toBe(ZOOM_DEFAULT)
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(ZOOM_DEFAULT)
  })

  it('leaves every rung where it is', () => {
    for (const step of ZOOM_STEPS) expect(clampZoom(step)).toBe(step)
  })

  it('makes zooming out the exact inverse of zooming in', () => {
    // The two ends are excluded: pressing "smaller" at 70% is a no-op, so the
    // inverse only has to hold for a rung that could actually move.
    for (const step of ZOOM_STEPS) {
      if (step === ZOOM_MIN || step === ZOOM_MAX) continue
      expect(nextZoom(nextZoom(step, 1), -1)).toBe(step)
      expect(nextZoom(nextZoom(step, -1), 1)).toBe(step)
    }
  })

  it('parks at the ends rather than wrapping or leaving the ladder', () => {
    expect(nextZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
    expect(nextZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
    // Held down past the end must stay a valid rung, never NaN.
    let value = ZOOM_DEFAULT
    for (let i = 0; i < 40; i += 1) value = nextZoom(value, 1)
    expect(value).toBe(ZOOM_MAX)
    for (let i = 0; i < 40; i += 1) value = nextZoom(value, -1)
    expect(value).toBe(ZOOM_MIN)
  })

  it('reports a whole percent with no float tail', () => {
    expect(zoomPercent(1)).toBe('100%')
    expect(zoomPercent(1.2)).toBe('120%')
    expect(zoomPercent(0.7)).toBe('70%')
    expect(zoomPercent(1.1 * 1.1 * 1.1)).toBe('130%')
  })

  it('walks one rung per command and resets to exactly 100%', () => {
    expect(zoomForCommand(1, 'in')).toBe(1.1)
    expect(zoomForCommand(1, 'out')).toBe(0.9)
    expect(zoomForCommand(1.25, 'in')).toBe(1.4)
    expect(zoomForCommand(1.25, 'reset')).toBe(ZOOM_DEFAULT)
    // Reset means 100% wherever you started from, not "back to where you were".
    expect(zoomForCommand(ZOOM_MAX, 'reset')).toBe(1)
    expect(zoomForCommand(ZOOM_MIN, 'reset')).toBe(1)
    // In then out is the identity, which is the whole reason for a ladder.
    expect(zoomForCommand(zoomForCommand(1, 'in'), 'out')).toBe(1)
  })
})

describe('zoom keystrokes', () => {
  const keys = (over: Partial<Parameters<typeof zoomCommand>[0]>): Parameters<typeof zoomCommand>[0] => ({
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...over
  })

  it('accepts every spelling of bigger', () => {
    expect(zoomCommand(keys({ key: '=', ctrlKey: true }))).toBe('in')
    // Shift+= is how a US keyboard types '+', so shift must not disqualify.
    expect(zoomCommand(keys({ key: '+', ctrlKey: true }))).toBe('in')
    expect(zoomCommand(keys({ key: '+', metaKey: true }))).toBe('in')
    expect(zoomCommand(keys({ key: 'Add', ctrlKey: true }))).toBe('in')
    expect(zoomCommand(keys({ key: '', code: 'NumpadAdd', ctrlKey: true }))).toBe('in')
  })

  it('accepts every spelling of smaller', () => {
    expect(zoomCommand(keys({ key: '-', ctrlKey: true }))).toBe('out')
    expect(zoomCommand(keys({ key: '_', ctrlKey: true }))).toBe('out')
    expect(zoomCommand(keys({ key: '-', metaKey: true }))).toBe('out')
    expect(zoomCommand(keys({ key: 'Subtract', ctrlKey: true }))).toBe('out')
    expect(zoomCommand(keys({ key: '', code: 'NumpadSubtract', ctrlKey: true }))).toBe('out')
  })

  it('resets on zero, main row or numpad', () => {
    expect(zoomCommand(keys({ key: '0', ctrlKey: true }))).toBe('reset')
    expect(zoomCommand(keys({ key: '0', metaKey: true }))).toBe('reset')
    expect(zoomCommand(keys({ key: '', code: 'Numpad0', ctrlKey: true }))).toBe('reset')
  })

  it('ignores the same keys without a modifier', () => {
    expect(zoomCommand(keys({ key: '=' }))).toBeNull()
    expect(zoomCommand(keys({ key: '-' }))).toBeNull()
    expect(zoomCommand(keys({ key: '0' }))).toBeNull()
  })

  it('ignores Alt+= (a layout switcher elsewhere) and unrelated keys', () => {
    expect(zoomCommand(keys({ key: '=', ctrlKey: true, altKey: true }))).toBeNull()
    expect(zoomCommand(keys({ key: 'z', ctrlKey: true }))).toBeNull()
    expect(zoomCommand(keys({ key: 'Enter', ctrlKey: true }))).toBeNull()
    expect(zoomCommand(keys({ key: 'F5', ctrlKey: true }))).toBeNull()
  })
})
