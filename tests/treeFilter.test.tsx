// @vitest-environment jsdom
/**
 * The tree's filters, and the strip that admits they are on.
 *
 * A filter that hides rows in silence is the bug this file exists for: the
 * needs-me chip and the origin facets can each shrink a nine-task tree to one
 * row, and nothing between the chips and the rows said so. The contract pinned
 * here is the one a confused human needs - while any filter is on, the rail
 * shows a strip naming every active filter plus how many rows it hides, and
 * one click clears all of them; while none is on, the strip is absent rather
 * than reading "filtering: nothing".
 *
 * The chip row itself is always mounted, because needs-me can be on before
 * anything was ever imported and a rail that hid its own filter surface would
 * hide the reason the tree looks short.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildBench,
  filterGroups,
  originCounts,
  parseTaskRecord,
  type AttentionItem,
  type GroupView,
  type TaskRecord
} from '../src/shared/pro'
import { makeTranslator } from '../src/renderer/src/pro/i18n'
import { TreeRail } from '../src/renderer/src/pro/TreeRail'

const NOW = 1_700_000_000_000
const REPO = '/work/codewaifu'
const t = makeTranslator('en')

/** Built here rather than imported from `tests/helpers/pro.ts`: that helper
 *  types itself against the relay, which pulls main-process modules into a
 *  renderer test's compile graph. */
const HERDR = {
  online: true,
  version: '0.9.0',
  socketPath: '/tmp/herdr.sock',
  error: '',
  workspaces: 0,
  panes: 0
}

function attentionFor(taskId: string): AttentionItem {
  return {
    id: `${taskId}:permission:hook`,
    kind: 'permission',
    source: 'hook',
    taskId,
    paneId: 'pane-1',
    workspaceId: 'ws-1',
    agentKind: 'codex',
    taskTitle: 'the one I started here',
    groupLabel: 'codewaifu',
    title: 'Run the test suite?',
    detail: 'the agent wants to run npm test',
    toolName: 'shell',
    command: 'npm test',
    since: NOW,
    updatedAt: NOW,
    snoozedUntil: 0,
    resolved: false
  }
}

function record(patch: Record<string, unknown>): TaskRecord {
  const parsed = parseTaskRecord({ workdir: REPO, repoRoot: REPO, updatedAt: NOW, ...patch })
  if (!parsed) throw new Error(`task fixture did not parse: ${JSON.stringify(patch)}`)
  return parsed
}

const MINE = record({
  id: 't-mine',
  title: 'the one I started here',
  status: 'active',
  origin: 'created'
})
const ADOPTED = record({
  id: 't-adopted',
  title: 'herdr was running this',
  status: 'active',
  origin: 'adopted'
})
const IMPORTED = record({
  id: 't-imported',
  title: 'a session she saw',
  status: 'active',
  origin: 'imported'
})

/** One open decision on MINE, so exactly one row survives a needs-me filter. */
function groupsOf(tasks: readonly TaskRecord[], attention: boolean): GroupView[] {
  return buildBench({
    now: NOW,
    herdr: HERDR,
    snapshot: null,
    tasks,
    attention: attention ? [attentionFor('t-mine')] : []
  }).groups
}

let container: HTMLDivElement
let root: Root
let toggledNeedsMe: number
let filters: string[]

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
  toggledNeedsMe = 0
  filters = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderRail(opts: {
  tasks?: readonly TaskRecord[]
  attention?: boolean
  needsMeOnly?: boolean
  filter?: 'all' | 'mine' | 'imported'
} = {}): void {
  const tasks = opts.tasks ?? [MINE, ADOPTED, IMPORTED]
  const groups = groupsOf(tasks, opts.attention ?? false)
  // The facet is applied by the Bench before the rail ever sees the tree, so a
  // rail test has to hand it the same already-filtered groups.
  const shownGroups = filterGroups(groups, opts.filter ?? 'all')
  act(() => {
    root.render(
      <TreeRail
        groups={shownGroups}
        totalTasks={tasks.length}
        selectedId=""
        cursorId=""
        needsMeOnly={opts.needsMeOnly ?? false}
        filter={opts.filter ?? 'all'}
        counts={originCounts(groups)}
        collapsed={new Set()}
        t={t}
        onFilter={(filter) => filters.push(filter)}
        onToggleNeedsMe={() => {
          toggledNeedsMe += 1
        }}
        onToggleGroup={vi.fn()}
        onSelect={vi.fn()}
        onRename={vi.fn()}
      />
    )
  })
}

function rows(): NodeListOf<Element> {
  return container.querySelectorAll('.task-row')
}

function strip(): HTMLElement | null {
  return container.querySelector('.rail-filterbar')
}

function chips(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.rail-facets .facet')]
}

describe('the filter strip', () => {
  it('is absent while nothing is filtered, so it never claims a filter', () => {
    renderRail()
    expect(strip()).toBeNull()
    expect(rows()).toHaveLength(3)
  })

  it('names the needs-me filter and how many rows it hides', () => {
    renderRail({ attention: true, needsMeOnly: true })
    const bar = strip()
    if (!bar) throw new Error('no filter strip while needs-me is on')
    expect(bar.textContent).toContain('Filtering')
    expect(bar.textContent).toContain('Needs me')
    expect(bar.textContent).toContain('2 hidden')
    expect(rows()).toHaveLength(1)
  })

  it('names an origin facet the same way', () => {
    renderRail({ filter: 'mine' })
    const bar = strip()
    if (!bar) throw new Error('no filter strip while a facet is on')
    expect(bar.textContent).toContain('Mine')
    expect(bar.textContent).toContain('2 hidden')
    expect(rows()).toHaveLength(1)
  })

  it('names both filters at once, because they stack', () => {
    renderRail({ attention: true, needsMeOnly: true, filter: 'imported' })
    const bar = strip()
    if (!bar) throw new Error('no filter strip while both filters are on')
    expect(bar.textContent).toContain('Needs me')
    expect(bar.textContent).toContain('Imported')
    expect(rows()).toHaveLength(0)
  })

  it('clears every filter with the one button, in one click', () => {
    renderRail({ attention: true, needsMeOnly: true, filter: 'mine' })
    const clear = container.querySelector<HTMLButtonElement>('.filterbar-clear')
    if (!clear) throw new Error('the strip has no clear button')
    act(() => {
      clear.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(toggledNeedsMe).toBe(1)
    expect(filters).toEqual(['all'])
  })
})

describe('the chip row', () => {
  it('is mounted even when nothing was ever imported', () => {
    renderRail({ tasks: [MINE] })
    expect(chips().length).toBeGreaterThan(0)
  })

  it('carries needs-me as a chip that promises its count and reports its state', () => {
    renderRail({ attention: true, needsMeOnly: true })
    const chip = chips().find((node) => node.textContent?.includes('Needs me'))
    if (!chip) throw new Error('needs-me is not a chip in the facet row')
    expect(chip.textContent).toContain('1')
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    act(() => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(toggledNeedsMe).toBe(1)
  })
})
