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
 * Two ways in are pinned besides double-click: the pencil that belongs to a row,
 * and `F2` on whatever `j/k` last highlighted. The pencil is the row's sibling
 * rather than its child - a `<button>` may not hold another `<button>` - so the
 * test finds it through `.task-cell`, which is the box that owns both. `F2` is
 * bound on `window` because that is where the Bench's own keys are handled, and
 * it has to stay out of a text field: the common case is a terminal with focus,
 * where the key belongs to the agent.
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
/** Every row click the rail made, so "the pencil did not select the row" is a
 *  thing this file can assert rather than assume. */
let selected: string[]

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

function renderRail(
  tasks: readonly TaskRecord[] = [SHIP, FIX],
  opts: { cursorId?: string; selectedId?: string; open?: boolean } = {}
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
      open={opts.open ?? true}
      t={t}
      onFilter={vi.fn()}
      onToggleNeedsMe={vi.fn()}
      onToggleGroup={vi.fn()}
      onSelect={(id) => selected.push(id)}
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

/** This row's own pencil, found through the box that owns row and pencil. */
function pencilOf(title: string): HTMLButtonElement {
  const button = rowOf(title)
    .closest('.task-cell')
    ?.querySelector<HTMLButtonElement>('.row-rename')
  if (!button) throw new Error(`the row reading ${title} has no pencil`)
  return button
}

/** A bare F2 on the window, which is where the rail listens for it. */
function f2(target: EventTarget | null = null): void {
  const event = new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true })
  act(() => {
    ;(target ?? window).dispatchEvent(event)
  })
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
  selected = []
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

  it('renames from the pencil on its own row, without selecting that row', async () => {
    await renderRail([SHIP, FIX], { selectedId: 't-ship' })
    const pencil = pencilOf('fix the approval card')
    expect(pencil.getAttribute('aria-label')).toBe(t('renameTask'))
    await act(async () => {
      pencil.click()
    })
    const input = field()
    if (!input) throw new Error('the pencil did not open a field')
    expect(input.value).toBe('fix the approval card')
    // The field replaced the title, on the row that was clicked - not on the one
    // that happened to be selected. `data-cursor` is always present as a boolean
    // attribute value, so 'false' is what "not the highlighted row" reads as.
    expect(editingRow()?.dataset.cursor).toBe('false')
    expect(editingRow()?.dataset.selected).toBe('false')
    expect(editingRow()?.querySelector('.task-name')).toBeNull()
    // A pencil inside a row that also selects would rename a task it just made
    // current, which is a second thing happening on one click.
    expect(selected).toEqual([])
    type(input, 'fix the permission card')
    key(input, 'Enter')
    expect(renamed).toEqual([{ id: 't-fix', title: 'fix the permission card' }])
  })

  it('keeps one pencil per row, so showing it cannot move the pills', async () => {
    await renderRail([SHIP, FIX], { cursorId: 't-fix' })
    expect(container.querySelectorAll('.row-rename')).toHaveLength(2)
    for (const title of ['ship the bench', 'fix the approval card']) {
      const cell = rowOf(title).closest('.task-cell')
      expect(cell?.querySelectorAll('.row-rename')).toHaveLength(1)
      // The pencil floats over padding the row reserves permanently, so it is a
      // sibling of the row and never inside it.
      expect(rowOf(title).contains(cell?.querySelector('.row-rename') ?? null)).toBe(false)
    }
    // And it goes away while the field is open: a pencil beside a caret is two
    // ways to do one thing, and the second reopens what was just closed.
    await open('ship the bench')
    // `rowOf` finds rows by their title, and the open row has handed its title
    // to the field - so this walks up from the row that says it is editing.
    expect(editingRow()?.closest('.task-cell')?.querySelector('.row-rename')).toBeNull()
    expect(pencilOf('fix the approval card')).toBeTruthy()
  })

  it('renames the row j/k left highlighted on F2', async () => {
    await renderRail([SHIP, FIX], { cursorId: 't-fix', selectedId: 't-ship' })
    f2()
    const input = field()
    if (!input) throw new Error('F2 did not open a field')
    // The cursor, not the selection: F2 renames the row you are pointing at with
    // the keyboard, the way a file manager renames the highlighted file.
    expect(input.value).toBe('fix the approval card')
    expect(selected).toEqual([])
    type(input, 'fix the permission card')
    key(input, 'Enter')
    expect(renamed).toEqual([{ id: 't-fix', title: 'fix the permission card' }])
  })

  it('does nothing on F2 when there is no row to rename', async () => {
    // Nothing highlighted: a field opening on an arbitrary row would be a rename
    // the human did not ask for.
    await renderRail([SHIP, FIX])
    f2()
    expect(field()).toBeNull()

    // A rail folded away cannot show the field it opened, and a rename that
    // commits on the next blur with nothing on screen reads as data loss.
    await renderRail([SHIP, FIX], { cursorId: 't-fix', open: false })
    f2()
    expect(field()).toBeNull()
  })

  it('leaves F2 to whatever is taking text', async () => {
    await renderRail([SHIP, FIX], { cursorId: 't-fix' })
    const term = document.createElement('div')
    term.className = 'xterm'
    const helper = document.createElement('textarea')
    term.appendChild(helper)
    document.body.appendChild(term)
    f2(helper)
    expect(field()).toBeNull()
    term.remove()

    // A dialog owns the window: renaming a row behind it steals focus from the
    // field being filled in, and commits on the blur that follows.
    const dialog = document.createElement('div')
    dialog.setAttribute('aria-modal', 'true')
    dialog.appendChild(document.createElement('input'))
    document.body.appendChild(dialog)
    f2(document.body)
    expect(field()).toBeNull()
    dialog.remove()

    // Still ours once neither is on screen.
    f2()
    expect(field()).not.toBeNull()
  })

  it('leaves a chorded F2 alone: a chord is somebody else', async () => {
    await renderRail([SHIP, FIX], { cursorId: 't-fix' })
    const mods = [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]
    for (const mod of mods) {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, ...mod }))
      })
      expect(field(), JSON.stringify(mod)).toBeNull()
    }
    // Bare F2 still arrives, so the guard did not take the key with it.
    f2()
    expect(field()).not.toBeNull()
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
