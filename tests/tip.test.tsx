// @vitest-environment jsdom
/**
 * The shared tooltip.
 *
 * The chrome's icon rows answer "what is this?" themselves now: the native
 * `title` attribute was a second late and invisible in the transparent stage
 * window. These pin the contract a glance relies on - a cold hover waits out
 * the flicker guard, a warm one does not, the bubble leaves with the pointer
 * or with Escape or with a click, a key travels as a keycap, and a handler
 * the trigger already owned survives the wrap.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tip } from '../src/renderer/src/Tip'

let container: HTMLDivElement
let root: Root

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

function trigger(): HTMLButtonElement {
  const el = container.querySelector('button')
  if (!el) throw new Error('no trigger rendered')
  return el
}

function tip(): HTMLElement | null {
  return document.querySelector('[role="tooltip"]')
}

/** React synthesises enter/leave from over/out, like the browser does. */
function over(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }))
  })
}

function out(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // The warm window is module state; walk the fake clock past it so every
  // test starts from a cold hover unless it says otherwise.
  act(() => {
    vi.advanceTimersByTime(2000)
  })
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  document.querySelectorAll('[role="tooltip"]').forEach((node) => node.remove())
  vi.useRealTimers()
})

describe('Tip', () => {
  it('waits out the flicker guard on a cold hover, then arrives', async () => {
    await render(
      <Tip label="Snooze all">
        <button type="button">x</button>
      </Tip>
    )
    over(trigger())
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(tip()).toBeNull()
    act(() => {
      vi.advanceTimersByTime(30)
    })
    expect(tip()?.textContent).toContain('Snooze all')
    out(trigger())
    expect(tip()).toBeNull()
  })

  it('is warm right after a tip hid, and cold again once the window passes', async () => {
    await render(
      <Tip label="Adopt workspaces">
        <button type="button">x</button>
      </Tip>
    )
    over(trigger())
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(tip()).not.toBeNull()
    out(trigger())

    over(trigger())
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(tip()?.textContent).toContain('Adopt workspaces')
    out(trigger())

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    over(trigger())
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(tip()).toBeNull()
  })

  it('wires the bubble to the trigger for assistive tech', async () => {
    await render(
      <Tip label="Needs me">
        <button type="button">x</button>
      </Tip>
    )
    over(trigger())
    act(() => {
      vi.advanceTimersByTime(500)
    })
    const id = tip()?.id
    expect(id).toBeTruthy()
    expect(trigger().getAttribute('aria-describedby')).toBe(id)
    out(trigger())
    expect(trigger().getAttribute('aria-describedby')).toBeNull()
  })

  it('carries the key as a keycap and as aria-keyshortcuts', async () => {
    await render(
      <Tip label="Connect to a machine" kbd="c">
        <button type="button">x</button>
      </Tip>
    )
    expect(trigger().getAttribute('aria-keyshortcuts')).toBe('c')
    over(trigger())
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(tip()?.querySelector('.tip-kbd')?.textContent).toBe('c')
  })

  it('leaves with Escape and with a click, because menus open under it', async () => {
    await render(
      <Tip label="Expression">
        <button type="button">x</button>
      </Tip>
    )
    over(trigger())
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(tip()).not.toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(tip()).toBeNull()

    over(trigger())
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(tip()).not.toBeNull()
    act(() => {
      window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(tip()).toBeNull()
  })

  it('keeps a handler the trigger already owned', async () => {
    const seen = vi.fn()
    await render(
      <Tip label="Motion">
        <button type="button" onMouseEnter={seen}>
          x
        </button>
      </Tip>
    )
    over(trigger())
    expect(seen).toHaveBeenCalledTimes(1)
    out(trigger())
  })
})
