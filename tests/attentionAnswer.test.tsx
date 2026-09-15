// @vitest-environment jsdom
/**
 * The queue's answer box (F3 invariant 1, F7 keyboard), rendered.
 *
 * The box exists so a question can be settled without focusing the pane, and the
 * reason it gets its own file is that the same Enter-to-send bug was fixed twice:
 * here and in the widget bubble. `shared/ime.ts` pins the predicate; these cases
 * pin the wiring, which is the half that regresses - a `key === 'Enter'` check
 * looks correct, passes review, and ships half-typed pinyin to an agent the first
 * time somebody answers in Chinese.
 *
 * The box hard-caps at the field (`maxLength`) where the bubble warns instead, so
 * the cap gets asserted here too: with it in place the plan's normalization is the
 * last line of defense rather than the only one.
 *
 * Newlines are *not* asserted here. A single-line field sanitizes its own value,
 * so the DOM removes a CR/LF before any of our code sees it; the caller that can
 * still deliver one is `POST /pro/answer`, and that folding is pinned where it
 * happens (`proAttention.test.ts`).
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANSWER_MAX_CHARS, type AttentionAction, type AttentionItem } from '../src/shared/pro'
import { makeTranslator } from '../src/renderer/src/pro/i18n'
import { AttentionQueue } from '../src/renderer/src/pro/AttentionQueue'

const NOW = 1_700_000_000_000
const t = makeTranslator('en')

/**
 * One queue entry, built here rather than imported from `tests/helpers/pro.ts`.
 *
 * That helper imports `src/main/server` for its fake transport, and a `.tsx` test
 * sits in `tsconfig.web.json` - which lists the `.tsx` tests but deliberately not
 * the main-process sources. Reaching across costs a TS6307 ("file is not listed
 * within the file list of project"), and silencing it would drag electron into
 * the web project. A queue item is a few fields; the boundary is worth more.
 */
function queueItem(patch: Partial<AttentionItem> = {}): AttentionItem {
  const kind = patch.kind ?? 'question'
  const taskId = patch.taskId ?? 't1'
  return {
    id: `${taskId}:${kind}:hook`,
    kind,
    source: 'hook',
    taskId,
    paneId: 'pane-1',
    workspaceId: 'ws-1',
    agentKind: 'codex',
    taskTitle: 'ship the bench',
    groupLabel: 'codewaifu',
    title: 'which environment should I use?',
    detail: '',
    toolName: '',
    command: '',
    since: NOW - 60_000,
    updatedAt: NOW - 60_000,
    snoozedUntil: 0,
    resolved: false,
    ...patch
  }
}

let container: HTMLDivElement
let root: Root
let acted: Array<{ id: string; action: AttentionAction; extra?: { text?: string; minutes?: number } }>
let notified: Array<{ text: string; tone?: string }>

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

function renderQueue(itemId = 't1:question:hook'): Promise<void> {
  const item = queueItem({ id: itemId })
  return render(
    <AttentionQueue
      items={[item]}
      cursorId={itemId}
      now={NOW}
      keys={null}
      t={t}
      onAct={(id, action, extra) => {
        acted.push({ id, action, extra })
      }}
      onOpen={() => {}}
      onNotify={(text, tone) => {
        notified.push({ text, tone })
      }}
    />
  )
}

function field(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('.answer-box input')
  if (!input) throw new Error('the answer box is not open')
  return input
}

/** React 18 tracks `value` itself, so the prototype setter is what fires onChange. */
function type(value: string): void {
  const input = field()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('no value setter')
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

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

/** The button whose label is the given copy, which is how a user finds it. */
function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('.qactions button')].find((node) =>
    node.textContent?.includes(label)
  )
}

async function openBox(): Promise<void> {
  const answer = button(t('actionAnswer'))
  if (!answer) throw new Error('no Answer button')
  await act(async () => {
    answer.click()
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  acted = []
  notified = []
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
})

describe('AttentionQueue answer box', () => {
  it('settles the item in place, with no pane focus involved', async () => {
    await renderQueue()
    await openBox()
    type('use the linux   box\tplease')
    key(field(), 'Enter')
    expect(acted).toEqual([
      { id: 't1:question:hook', action: 'answer', extra: { text: 'use the linux box please' } }
    ])
    expect(notified).toEqual([])
  })

  it('does not send on any of the three IME marks', async () => {
    await renderQueue()
    await openBox()
    type('ni hao')
    const input = field()
    key(input, 'Enter', { composing: true })
    key(input, 'Enter', { keyCode: 229 })
    composition(input, 'compositionstart')
    key(input, 'Enter')
    expect(acted).toEqual([])
    // Still open: the human is mid-word, not done.
    expect(container.querySelector('.answer-box')).not.toBeNull()
  })

  it('treats the Enter right after compositionend as the IME commit', async () => {
    await renderQueue()
    await openBox()
    const input = field()
    type('ni hao')
    composition(input, 'compositionstart')
    composition(input, 'compositionend')
    key(input, 'Enter')
    expect(acted).toEqual([])
  })

  it('refuses an answer with nothing in it, out loud', async () => {
    await renderQueue()
    await openBox()
    type('   \n ')
    key(field(), 'Enter')
    expect(acted).toEqual([])
    expect(notified).toEqual([{ text: t('answerNeedsText'), tone: 'warn' }])
  })

  it('stops at the cap in the field itself', async () => {
    await renderQueue()
    await openBox()
    expect(field().maxLength).toBe(ANSWER_MAX_CHARS)
  })

  it('keeps Escape for the IME, then closes the box', async () => {
    await renderQueue()
    await openBox()
    const input = field()
    type('ni hao')
    key(input, 'Escape', { composing: true })
    expect(container.querySelector('.answer-box')).not.toBeNull()
    key(input, 'Escape')
    expect(container.querySelector('.answer-box')).toBeNull()
    expect(acted).toEqual([])
  })

  it('sends on the button too, so the keyboard is a shortcut and not the only way', async () => {
    await renderQueue()
    await openBox()
    type('use the linux box')
    const send = [...container.querySelectorAll<HTMLButtonElement>('.answer-row button')].find(
      (node) => node.textContent === t('answerSend')
    )
    await act(async () => {
      send?.click()
    })
    expect(acted).toEqual([
      { id: 't1:question:hook', action: 'answer', extra: { text: 'use the linux box' } }
    ])
  })
})
