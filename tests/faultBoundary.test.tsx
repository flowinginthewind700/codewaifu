// @vitest-environment jsdom
/**
 * The fault card, rendered by React instead of described in isolation.
 *
 * `renderFault.test.ts` pins every decision the card makes about a thrown value.
 * This file pins the two that only exist once React is involved: that a child
 * which throws produces a card rather than an empty container, and that the
 * card's two buttons do what their labels promise.
 *
 * The second half is not ceremony. Both crashes that shipped blank (a renderer
 * module reading `process.env`, and `Pane` constructing a terminal before the
 * Unicode11 addon had enabled the proposed-API flag) were renderer-only failures,
 * and until this file existed `npm test` could not render one pro component - so a
 * green run was not evidence about the window the user actually looks at.
 *
 * Language is asserted in English because jsdom's `navigator.languages` is
 * `['en-US','en']` whatever the host locale says, which makes the card's language
 * choice deterministic here. The Chinese case overrides that one property, which
 * is the same path `localLang()` takes on a real machine.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FAULT_STACK_LINES } from '../src/shared/renderFault'
import { FaultBoundary } from '../src/renderer/src/pro/FaultBoundary'

/** A child that throws during render, which is how both shipped crashes failed. */
function Boom({ error }: { error: unknown }): null {
  throw error
}

/** Indented V8 frames, without the `Name: message` header V8 puts above them. */
function frames(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `    at Pane${index} (file:///app/out/renderer.js:${index}:1)`
  )
}

let container: HTMLDivElement
let root: Root
const realConsoleError = console.error

/**
 * React 18 dev rethrows a render error through a synthetic DOM event so the
 * browser can show it in its own console; jsdom would report that as an uncaught
 * error and fail the run. `preventDefault()` is the browser's "somebody handled
 * this" signal and React honours it, which is accurate here rather than a mute
 * button: the boundary really did handle it, and the card is the handling.
 */
function swallow(event: ErrorEvent): void {
  event.preventDefault()
}

async function renderTree(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

/** DOM order, which is the order the card lays them out: reload, then copy. */
function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.fault-actions button')]
}

/** The crash every card test starts from: one TypeError with a real V8 stack. */
function boom(frameCount = 3): ReactNode {
  const error = new TypeError('cannot read pane of undefined')
  error.stack = ['TypeError: cannot read pane of undefined', ...frames(frameCount)].join('\n')
  return (
    <FaultBoundary>
      <div className="bench-ok">bench</div>
      <Boom error={error} />
    </FaultBoundary>
  )
}

function text(selector: string): string {
  return container.querySelector(selector)?.textContent ?? ''
}

/** `navigator` stubs are per-test and must not leak: jsdom's window outlives them. */
function resetNavigator(): void {
  const nav = navigator as unknown as Record<string, unknown>
  delete nav.clipboard
  delete nav.languages
}

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  const nav = navigator as unknown as Record<string, unknown>
  Object.defineProperty(nav, 'clipboard', { value: { writeText }, configurable: true })
}

beforeEach(() => {
  // Without this React warns that `act` is being called outside an act
  // environment and state updates from the boundary land unflushed.
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  console.error = (): void => {}
  window.addEventListener('error', swallow)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  window.removeEventListener('error', swallow)
  resetNavigator()
  vi.useRealTimers()
  console.error = realConsoleError
})

describe('FaultBoundary', () => {
  it('renders its child while nothing throws', async () => {
    await renderTree(
      <FaultBoundary>
        <div className="bench-ok">bench</div>
      </FaultBoundary>
    )
    expect(text('.bench-ok')).toBe('bench')
    expect(container.querySelector('.fault')).toBeNull()
  })

  it('turns a throwing child into a card, and the tree below it goes away', async () => {
    await renderTree(boom())
    const card = container.querySelector('.fault')
    expect(card).not.toBeNull()
    // `role="alert"` is what makes a screen reader say the crash out loud instead
    // of presenting an empty window as a working one.
    expect(card?.getAttribute('role')).toBe('alert')
    expect(text('.fault-kind')).toBe('TypeError')
    expect(text('.fault-message')).toBe('cannot read pane of undefined')
    expect(container.querySelector('.bench-ok')).toBeNull()
  })

  it('says the agents are still alive before anything else', async () => {
    await renderTree(boom())
    // The load-bearing sentence of the whole card: herdr owns the PTYs, so a dead
    // renderer has killed nobody. A card that leads with the stack instead reads
    // as "your work is gone".
    expect(text('.fault-body')).toContain('your agents are still running in herdr')
    expect(text('.fault-actions')).toContain('Reload the bench')
  })

  it('shows frames, and never the stack header the message row already prints', async () => {
    await renderTree(boom(FAULT_STACK_LINES + 2))
    const lines = text('.fault-stack').split('\n')
    expect(lines).toHaveLength(FAULT_STACK_LINES)
    expect(lines.every((line) => line.startsWith('at '))).toBe(true)
    expect(lines.some((line) => line.startsWith('TypeError:'))).toBe(false)
  })

  it('says so when the error left no readable message', async () => {
    await renderTree(
      <FaultBoundary>
        <Boom error={new Error('')} />
      </FaultBoundary>
    )
    expect(text('.fault-message')).toBe('The error left no readable message.')
    // The kind chip is still on the card, so this is not a dead end.
    expect(text('.fault-kind')).toBe('Error')
  })

  it('cards a thrown string, which is legal and which glue code does', async () => {
    await renderTree(
      <FaultBoundary>
        <Boom error={'herdr socket closed'} />
      </FaultBoundary>
    )
    expect(text('.fault-kind')).toBe('string')
    expect(text('.fault-message')).toBe('herdr socket closed')
  })

  it('still cards an error that fights back on every property read', async () => {
    // There is no boundary behind the boundary: if describing a fault could throw,
    // the window would go blank a second time and look identical to the crash this
    // card exists for. What `describeFault` returns for such a value is pinned in
    // `renderFault.test.ts`; what is asserted here is the invariant that survives
    // React - a card, with something readable on it, and no leftover tree.
    //
    // Worth recording what React dev does to this value. Its guarded-callback
    // trick replays the throw through a synthetic DOM event, and jsdom reads
    // `.message` off the value while reporting it, so a value whose getters throw
    // reaches the boundary as a different, real Error (observed: kind `Error`).
    // The boundary cannot tell the difference and does not need to; a production
    // React build uses a plain try/catch and delivers the original.
    const hostile = {
      get name(): string {
        throw new Error('name is not for you')
      },
      get message(): string {
        throw new Error('message is not for you')
      },
      get stack(): string {
        throw new Error('stack is not for you')
      }
    }
    await renderTree(
      <FaultBoundary>
        <div className="bench-ok">bench</div>
        <Boom error={hostile} />
      </FaultBoundary>
    )
    expect(container.querySelector('.fault')).not.toBeNull()
    expect(text('.fault-kind')).not.toBe('')
    expect(text('.fault-message')).not.toBe('')
    expect(container.querySelector('.bench-ok')).toBeNull()
  })

  it('logs the component stack, which a bundled error stack cannot give', async () => {
    const calls: unknown[][] = []
    console.error = (...args: unknown[]): void => {
      calls.push(args)
    }
    await renderTree(boom())
    const ours = calls.find((args) => args[0] === '[pro] renderer fault')
    expect(ours).toBeDefined()
    // `out/renderer/assets/pro-*.js:1:40231` tells nobody which component threw;
    // the component stack does, and it is the reason componentDidCatch exists.
    expect(String(ours?.[2])).toContain('Boom')
  })

  it('shows the copy failure when there is no clipboard', async () => {
    expect('clipboard' in navigator).toBe(false)
    await renderTree(boom())
    await act(async () => {
      buttons()[1].click()
    })
    // A silent failure here is a lost bug report: the one button whose whole job
    // is to get a crash off the machine has to say when it did not.
    expect(text('.fault-failed')).toContain('Copy failed')
    expect(text('.fault-actions button:last-child')).toContain('Copy details')
  })

  it('copies the same text the card shows', async () => {
    const writeText = vi.fn(async (_text: string): Promise<void> => {})
    stubClipboard(writeText)
    await renderTree(boom())
    await act(async () => {
      buttons()[1].click()
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    const payload = String(writeText.mock.calls[0]?.[0])
    expect(payload.startsWith('TypeError: cannot read pane of undefined')).toBe(true)
    expect(payload).toContain('at Pane0')
    expect(buttons()[1].textContent).toBe('Copied')
  })

  it('treats a refused clipboard as the failure it is, not as a success', async () => {
    // The usual cause is an unfocused window: `navigator.clipboard` is gated on
    // document focus, and the crash is exactly when the window may not have it.
    const writeText = vi.fn(async (_text: string): Promise<void> => {
      throw new Error('NotAllowedError')
    })
    stubClipboard(writeText)
    await renderTree(boom())
    await act(async () => {
      buttons()[1].click()
    })
    expect(text('.fault-failed')).toContain('Copy failed')
    expect(buttons()[1].textContent).toBe('Copy details')
  })

  it('makes Copied a moment rather than a latch', async () => {
    const writeText = vi.fn(async (_text: string): Promise<void> => {})
    stubClipboard(writeText)
    vi.useFakeTimers()
    await renderTree(boom())
    await act(async () => {
      buttons()[1].click()
    })
    expect(buttons()[1].textContent).toBe('Copied')
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    // Back to a button, because a latched "Copied" is a lie the second the
    // clipboard starts refusing.
    expect(buttons()[1].textContent).toBe('Copy details')
  })

  it('answers in Chinese when the window is Chinese', async () => {
    Object.defineProperty(navigator, 'languages', {
      value: ['zh-CN', 'zh'],
      configurable: true
    })
    await renderTree(boom())
    expect(text('.fault-title')).toBe('工作台界面出错了')
    expect(text('.fault-body')).toContain('herdr')
  })

  it('wires reload without taking the card down', async () => {
    await renderTree(boom())
    await act(async () => {
      buttons()[0].click()
    })
    // jsdom implements `location.reload` as "not implemented: navigation", so the
    // claim under test is that the click is wired and harmless. The interesting
    // assertion about reloading is the copy's: it is safe because herdr owns the
    // PTYs and the tree is re-derived at boot.
    expect(container.querySelector('.fault')).not.toBeNull()
  })
})
