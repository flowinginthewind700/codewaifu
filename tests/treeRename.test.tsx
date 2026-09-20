// @vitest-environment jsdom
/**
 * Renaming a task from the tree.
 *
 * The rename is one field with three exits (Enter, Esc, blur) and one rule that
 * is easy to lose: none of them may fire while an IME is composing. A Chinese
 * task name is the common case here, and Enter is how pinyin commits a
 * candidate - so the case that would ship broken is "I renamed a task in
 * Chinese and the field saved half a word".
 *
 * The other promise worth pinning is the shape of the row while it is open. An
 * `<input>` inside a `<button>` is invalid HTML and Chromium drops the
 * keystrokes, so the editing row is a `div` that keeps every class and data
 * attribute it had. A test that only checks "the input appeared" would pass
 * with a row that lost its cursor, and the cursor is what `j/k` walks.
 *
 * Groups come out of `buildBench` rather than being hand-written, for the same
 * reason `tests/proTree.test.ts` does it: a fixture here should not be able to
 * describe a tree the projection could never produce.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildBench,
  originCounts,
  parseTaskRecord,
  TASK_TITLE_MAX,
  type GroupView,
  type HerdrView,
  type TaskRecord
} from '../src/shared/pro'
import { COMPOSITION_END_GRACE_MS } from '../src/shared/ime'
import { makeTranslator } from '../src/renderer/src/pro/i18n'
import { TreeRail } from '../src/renderer/src/pro/TreeRail'

const NOW = 1_700_000_000_000
const REPO = '/work/codewaifu'
const t = makeTranslator('en')

const HERDR: HerdrView = {
  online: true,
  version: '0.9.0',
  socketPath: '/tmp/herdr.sock',
  error: '',
  workspaces: 0,
  panes: 0
}

function record(patch: Record<string, unknown>): TaskRecord {
  const parsed = parseTaskRecord({ workdir: REPO, repoRoot: REPO, updatedAt: NOW, ...patch })
  if (!parsed) throw new Error(`task fixture did not parse: ${JSON.stringify(patch)}`)
  return parsed
}

const SHIP = record({ id: 't-ship', title: 'ship the bench', status: 'active' })
const FIX = record({ id: 't-fix', title: 'fix the approval card', status: 'active' })

function groupsOf(tasks: readonly TaskRecord[]): GroupView[] {
  return buildBench({ now: NOW, herdr: HERDR, snapshot: null, tasks, attention: [] }).groups
}

let container: HTMLDivElement
let root: Root
let renamed: { id: string; title: string }[]

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

function renderRail(
  tasks: readonly TaskRecord[] = [SHIP, FIX],
  opts: { cursorId?: string; selectedId?: string } = {}
): Promise<void> {
  const groups = groupsOf(tasks)
  const total = tasks.length
  return render(
    <TreeRail
      groups={groups}
      totalTasks={total}
      selectedId={opts.selectedId ?? ''}
      cursorId={opts.cursorId ?? ''}
      needsMeOnly={false}
      filter="all"
      counts={originCounts(groups)}
      collapsed={new Set()}
      t={t}
      onFilter={vi.fn()}
      onToggleNeedsMe={vi.fn()}
      onToggleGroup={vi.fn()}
      onSelect={vi.fn()}
      onRename={(id, title) => renamed.push({ id, title })}
    />
  )
}

/** The row for a task, found by the title the human reads. */
function rowOf(title: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('.task-row')].find((node) =>
    node.querySelector('.task-name')?.textContent?.includes(title)
  )
  if (!row) throw new Error(`no row reading ${title}`)
  return row
}

function field(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('input.task-rename')
}

function editingRow(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.task-row[data-editing]')
}

async function open(title: string): Promise<HTMLInputElement> {
  await act(async () => {
    rowOf(title).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })
  const input = field()
  if (!input) throw new Error('double-click did not open the title field')
  return input
}

/** React 18 tracks `value` itself, so the prototype setter is what fires onChange. */
function type(input: HTMLInputElement, value: string): void {
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

function headPencil(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('.rail-head .rename-toggle')
  if (!button) throw new Error('the rail head has no rename button')
  return button
}

/** Real time: the grace window is measured against `performance.now()`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Leaving the field. React 18 listens for `focusout` to fire `onBlur`, and a
 * bare `blur` event does not bubble to the root - dispatching `blur` here would
 * test nothing and pass for the wrong reason.
 */
function blur(input: HTMLInputElement): void {
  act(() => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom implements no layout, so `scrollIntoView` is simply absent; the rail
  // calls it to keep the keyboard cursor in view.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView(): void {}
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  renamed = []
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

describe('renaming a task from the tree', () => {
  it('opens on a double-click, prefilled and fully selected', async () => {
    await renderRail()
    const input = await open('ship the bench')
    expect(input.value).toBe('ship the bench')
    // Renaming is normally "replace this name": a caret at the end is what
    // makes people keep the old prefix.
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    expect(input.maxLength).toBe(TASK_TITLE_MAX)
    expect(input.getAttribute('aria-label')).toBe(t('renameTask'))
    expect(input.title).toBe(t('renameKeys'))
  })

  it('commits the trimmed title on Enter and closes the field', async () => {
    await renderRail()
    const input = await open('ship the bench')
    type(input, '  ship the widget  ')
    key(input, 'Enter')
    expect(renamed).toEqual([{ id: 't-ship', title: 'ship the widget' }])
    expect(field()).toBeNull()
    expect(rowOf('ship the bench')).toBeTruthy()
  })

  it('commits exactly once: Enter on the way out also blurs', async () => {
    await renderRail()
    const input = await open('ship the bench')
    type(input, 'renamed once')
    key(input, 'Enter')
    // The unmounted node still gets a blur in Chromium; a field that commits on
    // both writes the title twice to the ledger.
    blur(input)
    expect(renamed).toHaveLength(1)
  })

  it('cancels on Escape without writing anything', async () => {
    await renderRail()
    const input = await open('ship the bench')
    type(input, 'a name I abandoned')
    key(input, 'Escape')
    expect(renamed).toEqual([])
    expect(field()).toBeNull()
    expect(rowOf('ship the bench')).toBeTruthy()
  })

  it('commits on blur, which is the click-away case', async () => {
    await renderRail()
    const input = await open('fix the approval card')
    type(input, 'fix the permission card')
    blur(input)
    expect(renamed).toEqual([{ id: 't-fix', title: 'fix the permission card' }])
    expect(field()).toBeNull()
  })

  it('treats empty and unchanged as cancel, not as a write', async () => {
    await renderRail()
    const emptied = await open('ship the bench')
    type(emptied, '   ')
    key(emptied, 'Enter')
    expect(renamed).toEqual([])
    expect(field()).toBeNull()

    const same = await open('ship the bench')
    type(same, 'ship the bench')
    key(same, 'Enter')
    // An unchanged title closing the field without a round trip is the
    // behaviour a human expects; a patch here would be a ledger line for nothing.
    expect(renamed).toEqual([])
    expect(field()).toBeNull()
  })

  it('ignores the Enter an IME uses to commit a candidate', async () => {
    await renderRail()
    const input = await open('ship the bench')
    composition(input, 'compositionstart')
    type(input, '重写标题')
    // All three signals Chromium leaves: our composition flag, `isComposing`,
    // and the legacy 229.
    key(input, 'Enter', { composing: true, keyCode: 229 })
    expect(renamed).toEqual([])
    expect(field()).not.toBeNull()
    // The Enter right after compositionend is still the IME's: some macOS input
    // methods dispatch it once every direct signal is already clean.
    composition(input, 'compositionend')
    key(input, 'Enter')
    expect(renamed).toEqual([])
    expect(field()).not.toBeNull()
    // Past the grace window it is the human's key again, and the field is still
    // open holding what they composed.
    await sleep(COMPOSITION_END_GRACE_MS + 20)
    key(input, 'Enter')
    expect(renamed).toEqual([{ id: 't-ship', title: '重写标题' }])
  })

  it('keeps Escape out of the IME, then gives it back', async () => {
    await renderRail()
    const input = await open('ship the bench')
    composition(input, 'compositionstart')
    key(input, 'Escape', { composing: true, keyCode: 229 })
    // Escape mid-composition drops the IME's candidate, not the rename.
    expect(field()).not.toBeNull()
    composition(input, 'compositionend')
    await sleep(COMPOSITION_END_GRACE_MS + 20)
    key(input, 'Escape')
    expect(field()).toBeNull()
    expect(renamed).toEqual([])
  })

  it('keeps the row a row while the title is open', async () => {
    await renderRail([SHIP, FIX], { cursorId: 't-ship', selectedId: 't-ship' })
    const before = rowOf('ship the bench')
    expect(before.tagName).toBe('BUTTON')
    expect(before.dataset.cursor).toBe('true')

    await open('ship the bench')
    const editing = editingRow()
    if (!editing) throw new Error('the open row lost data-editing')
    // An <input> inside a <button> is invalid HTML and Chromium drops the
    // keystrokes, so the row becomes a div - but it may not lose anything else.
    expect(editing.tagName).toBe('DIV')
    expect(editing.dataset.cursor).toBe('true')
    expect(editing.dataset.selected).toBe('true')
    expect(editing.querySelector('.dot')).toBeTruthy()
    expect(editing.querySelector('.task-sub')).toBeTruthy()
    expect(field()?.parentElement?.className).toBe('task-main')
    // The other row is untouched and still clickable.
    expect(rowOf('fix the approval card').tagName).toBe('BUTTON')
  })

  it('renames the row j/k left highlighted, and says so', async () => {
    await renderRail([SHIP, FIX])
    expect(headPencil().disabled).toBe(true)
    await renderRail([SHIP, FIX], { cursorId: 't-fix' })
    expect(headPencil().disabled).toBe(false)
    expect(headPencil().getAttribute('aria-label')).toBe(t('renameTask'))
    await act(async () => {
      headPencil().click()
    })
    const input = field()
    if (!input) throw new Error('the head button did not open a field')
    expect(input.value).toBe('fix the approval card')
    expect(editingRow()?.querySelector('.task-name')).toBeNull()
    type(input, 'fix the permission card')
    key(input, 'Enter')
    expect(renamed).toEqual([{ id: 't-fix', title: 'fix the permission card' }])
  })

  it('drops the field when the row it was editing leaves the tree', async () => {
    await renderRail([SHIP, FIX])
    await open('ship the bench')
    expect(field()).not.toBeNull()
    // The next projection no longer has the row: a field editing a task nobody
    // can see would commit into an empty tree.
    await renderRail([FIX])
    expect(field()).toBeNull()
    expect(editingRow()).toBeNull()
  })
})
