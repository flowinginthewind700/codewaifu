// @vitest-environment jsdom
/**
 * The bare stage's glass: which pointer positions the box claims.
 *
 * The behaviour under test is invisible when it works and unmistakable when it
 * does not - a veil that stays on after the pointer leaves says "your click
 * lands here" over a box nothing is pointing at. Pinned here rather than left
 * to a look at the screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VEIL_ATTR, attachStageVeil, veilInside, type VeilBox } from '../src/renderer/src/stageVeil'

const BOX: VeilBox = { left: 100, top: 50, width: 300, height: 300 }

let node: HTMLDivElement
let detach: () => void

/**
 * A stage box at a known place on screen. jsdom measures nothing, so the box is
 * asserted rather than laid out - which is also the honest setup: the veil's
 * contract is arithmetic against a rect, and the rect comes from a window that
 * main moves underneath us.
 */
function mount(box: VeilBox = BOX): void {
  node = document.createElement('div')
  node.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => box }) as DOMRect
  document.body.appendChild(node)
  detach = attachStageVeil(node, window)
}

function move(clientX: number, clientY: number): void {
  window.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY }))
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  detach?.()
  node?.remove()
  vi.restoreAllMocks()
})

describe('veilInside', () => {
  it('claims the pointer inside the box, wherever in the box it is', () => {
    expect(veilInside(100, 50, BOX)).toBe(true)
    expect(veilInside(250, 200, BOX)).toBe(true)
    // The far edge is still hers: the box owns every pixel up to and including
    // left + width, which is what getBoundingClientRect means.
    expect(veilInside(400, 350, BOX)).toBe(true)
  })

  it('answers false outside, because outside is not "at the edge"', () => {
    expect(veilInside(99, 200, BOX)).toBe(false)
    expect(veilInside(401, 200, BOX)).toBe(false)
    expect(veilInside(250, 49, BOX)).toBe(false)
    expect(veilInside(250, 351, BOX)).toBe(false)
  })

  it('answers false for a box that is not on screen and for a coordinate that is not a number', () => {
    expect(veilInside(10, 10, { left: 0, top: 0, width: 0, height: 300 })).toBe(false)
    expect(veilInside(Number.NaN, 10, BOX)).toBe(false)
  })
})

describe('attachStageVeil', () => {
  it('survives a null node, which is what the ref is before the first commit', () => {
    expect(() => attachStageVeil(null)()).not.toThrow()
  })

  it('says the pointer is inside with one attribute, and nothing else', () => {
    mount()
    move(250, 200)
    expect(node.getAttribute(VEIL_ATTR)).toBe('1')
  })

  it('takes the veil down when the pointer leaves the box, which is the only exit a forwarded stream reports', () => {
    mount()
    move(250, 200)
    move(20, 20)
    expect(node.hasAttribute(VEIL_ATTR)).toBe(false)
    // Coming back is a fresh veil, not a continuation of the old one.
    move(250, 200)
    expect(node.getAttribute(VEIL_ATTR)).toBe('1')
  })

  it('writes the attribute once for a stream of moves that never leave', () => {
    mount()
    const spy = vi.spyOn(node, 'setAttribute')
    move(250, 200)
    move(250.2, 200.4)
    move(260, 210)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(node.getAttribute(VEIL_ATTR)).toBe('1')
  })

  it('takes the veil down when the window loses the pointer without a move', () => {
    mount()
    move(250, 200)
    window.dispatchEvent(new Event('blur'))
    expect(node.hasAttribute(VEIL_ATTR)).toBe(false)
  })

  it('does nothing for a box that measures zero, rather than painting a veil over nothing', () => {
    mount({ left: 0, top: 0, width: 0, height: 0 })
    move(0, 0)
    expect(node.hasAttribute(VEIL_ATTR)).toBe(false)
  })

  it('ignores an event with no coordinates, which is what a synthetic move looks like', () => {
    mount()
    window.dispatchEvent(new Event('mousemove'))
    expect(node.hasAttribute(VEIL_ATTR)).toBe(false)
  })

  it('stops listening on detach, and leaves the box as it found it', () => {
    mount()
    move(250, 200)
    detach()
    expect(node.hasAttribute(VEIL_ATTR)).toBe(false)
    move(260, 210)
    expect(node.hasAttribute(VEIL_ATTR)).toBe(false)
  })
})
