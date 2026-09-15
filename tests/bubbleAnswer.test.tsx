// @vitest-environment jsdom
/**
 * The bubble's answer composer (F7), rendered.
 *
 * `proAttention.test.ts` pins the normalization; `companionLink.test.ts` pins
 * which routes may offer it. What only exists once React is in the loop is the
 * keyboard, and the keyboard here is the part that fails quietly: the Enter that
 * commits a Chinese candidate arrives as an ordinary `keydown`, and sending on it
 * types half-typed pinyin into an agent's input line. Three signals stand that
 * key down (`isComposing`, `keyCode === 229`, our own composition flag) plus a
 * grace window for the macOS commit Enter that lands *after* compositionend, so
 * each of the four gets a case.
 *
 * The other thing pinned here is that a draft is keyed to the bubble it was
 * written for. A bubble can be replaced while the composer is open, and a draft
 * that outlives its item would be delivered to whichever task is on screen when
 * Enter lands - an answer to a question nobody asked, sent confidently.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BubbleMessage, BubbleRoute } from '../src/shared/ui'
import { ANSWER_MAX_CHARS } from '../src/shared/pro'
import { Bubble } from '../src/renderer/src/Bubble'

const AT = 1_700_000_000_000

function route(patch: Partial<BubbleRoute> = {}): BubbleRoute {
  return {
    taskId: 't1',
    paneId: 'pane-1',
    itemId: 't1:question:hook',
    kind: 'question',
    actions: ['answer', 'snooze', 'open'],
    benchLabel: 'Open in Bench',
    ...patch
  }
}

function message(patch: Partial<BubbleMessage> = {}): BubbleMessage {
  return {
    id: 'b1',
    text: 'codex asks: which environment should I use?',
    lang: 'en',
    agent: 'codex',
    kind: 'question',
    at: AT,
    route: route(),
    ...patch
  }
}

let container: HTMLDivElement
let root: Root
let calls: { answers: Array<{ route: BubbleRoute; text: string }>; compose: boolean[] }

/** Both props the composer reports through, recording into `calls`. */
const handlers = {
  onAnswer: (item: BubbleRoute, text: string): void => {
    calls.answers.push({ route: item, text })
  },
  onCompose: (open: boolean): void => {
    calls.compose.push(open)
  }
}

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

function renderBubble(msg: BubbleMessage = message()): Promise<void> {
  return render(<Bubble message={msg} {...handlers} />)
}

/** The composer's field. `null` means no composer is open. */
function field(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('input.bubble-input')
}

function chip(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('.bubble-chip')].find(
    (button) => button.textContent === label
  )
}

/**
 * Type into the field the way a browser does. React 18 reads `value` through its
 * own tracker, so assigning the property directly leaves onChange silent; the
 * prototype setter is what defeats the tracker.
 */
function type(value: string): void {
  const input = field()
  if (!input) throw new Error('no composer open')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('no value setter')
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** A keydown on the field, optionally marked as the IME's. */
function key(
  input: HTMLInputElement,
  eventKey: string,
  opts: { composing?: boolean; keyCode?: number } = {}
): void {
  const event = new KeyboardEvent('keydown', {
    key: eventKey,
    bubbles: true,
    cancelable: true,
    isComposing: opts.composing === true
  })
  if (opts.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: opts.keyCode, configurable: true })
  }
  act(() => {
    input.dispatchEvent(event)
  })
}

function composition(input: HTMLInputElement, kind: 'compositionstart' | 'compositionend'): void {
  act(() => {
    input.dispatchEvent(new CompositionEvent(kind, { bubbles: true }))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  calls = { answers: [], compose: [] }
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
})

describe('Bubble answer composer', () => {
  it('offers no composer for a bubble that cannot be answered', async () => {
    // A review item has no `answer` verb; a chip the service will refuse is worse
    // than no chip.
    await renderBubble(message({ kind: 'review', route: route({ itemId: 't1:review:hook', kind: 'review', actions: ['open', 'done', 'snooze'] }) }))
    expect(chip('Answer')).toBeUndefined()
    expect(field()).toBeNull()
  })

  it('offers no composer for a notice, which has no item behind it', async () => {
    await renderBubble(message({ route: route({ itemId: '' }) }))
    expect(chip('Answer')).toBeUndefined()
  })

  it('opens on the chip and tells App to pin the bubble', async () => {
    await renderBubble()
    expect(field()).toBeNull()
    await act(async () => {
      chip('Answer')?.click()
    })
    expect(field()).not.toBeNull()
    // App suspends the hold timer on this signal; without it the bubble can time
    // out mid-sentence and take the draft with it.
    expect(calls.compose).toEqual([true])
  })

  it('sends the folded sentence on a clean Enter', async () => {
    await renderBubble()
    await act(async () => {
      chip('Answer')?.click()
    })
    type('use the linux box')
    key(field() as HTMLInputElement, 'Enter')
    expect(calls.answers).toEqual([{ route: route(), text: 'use the linux box' }])
    // Sending takes the bubble down and unpins it.
    expect(calls.compose[calls.compose.length - 1]).toBe(false)
    expect(field()).toBeNull()
  })

  it('does not send on the Enter that commits a candidate', async () => {
    await renderBubble()
    await act(async () => {
      chip('Answer')?.click()
    })
    type('ni hao')
    const input = field() as HTMLInputElement
    // Signal one: the platform still marks the key.
    key(input, 'Enter', { composing: true })
    // Signal two: only the legacy code, which is all some Windows IMEs leave.
    key(input, 'Enter', { keyCode: 229 })
    // Signal three: no mark at all, but a composition is open.
    composition(input, 'compositionstart')
    key(input, 'Enter')
    expect(calls.answers).toEqual([])
    expect(field()).not.toBeNull()
  })

  it('does not send on the macOS commit Enter that follows compositionend', async () => {
    await renderBubble()
    await act(async () => {
      chip('Answer')?.click()
    })
    const input = field() as HTMLInputElement
    type('ni hao')
    composition(input, 'compositionstart')
    composition(input, 'compositionend')
    // Every direct signal is clean by now; only the grace window tells this Enter
    // apart from a deliberate send.
    key(input, 'Enter')
    expect(calls.answers).toEqual([])
  })

  it('keeps Escape for the IME until the composition is over', async () => {
    await renderBubble()
    await act(async () => {
      chip('Answer')?.click()
    })
    const input = field() as HTMLInputElement
    type('ni hao')
    key(input, 'Escape', { composing: true })
    expect(field()).not.toBeNull()
    key(input, 'Escape')
    expect(field()).toBeNull()
    expect(calls.answers).toEqual([])
    expect(calls.compose[calls.compose.length - 1]).toBe(false)
  })

  it('says out loud that a long answer will be cut, and cuts exactly there', async () => {
    await renderBubble()
    await act(async () => {
      chip('Answer')?.click()
    })
    type('x'.repeat(ANSWER_MAX_CHARS + 50))
    expect(container.querySelector('.bubble-answer-warn')).not.toBeNull()
    key(field() as HTMLInputElement, 'Enter')
    expect(calls.answers[0]?.text).toHaveLength(ANSWER_MAX_CHARS)
  })

  it('will not send an empty answer', async () => {
    await renderBubble()
    await act(async () => {
      chip('Answer')?.click()
    })
    type('   ')
    const send = chip('Send')
    expect(send?.disabled).toBe(true)
    key(field() as HTMLInputElement, 'Enter')
    expect(calls.answers).toEqual([])
  })

  it('drops the draft when the bubble is replaced, instead of sending it on', async () => {
    await renderBubble()
    await act(async () => {
      chip('Answer')?.click()
    })
    type('the linux box')
    // A different item takes over the announcement.
    await renderBubble(message({ id: 'b2', text: 'claude asks: which branch?' }))
    expect(field()).toBeNull()
    expect(calls.answers).toEqual([])
  })

  it('renders nothing at all without a message', async () => {
    await render(<Bubble message={null} {...handlers} />)
    expect(container.querySelector('.bubble')).toBeNull()
  })
})
