// @vitest-environment jsdom
/**
 * The number in the topbar's `needs me` chip.
 *
 * `badgeFor` is the documented single source for "how many things need you", and
 * it counts *queue items*: one task holding two open decisions is two things to
 * answer. The chip used to render `counts.needsMe`, which counts *tasks*, so the
 * bar said 1 while the bell beside it, the tray badge, the widget bubble, the
 * queue tab and `codewaifu pro state` all said 2. Same words, two numbers, on one
 * screen - and the smaller one was in the place you look first.
 *
 * The fixture is built here rather than imported from `tests/helpers/pro.ts`:
 * that helper imports `src/main/server`, and a `.tsx` test sits in
 * `tsconfig.web.json`, which does not list the main-process sources (TS6307).
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyCounts, type AttentionItem, type BenchView } from '../src/shared/pro'
import { badgeFor } from '../src/shared/companionLink'
import { makeTranslator } from '../src/renderer/src/pro/i18n'
import { TopBar } from '../src/renderer/src/pro/TopBar'

const NOW = 1_700_000_000_000
const t = makeTranslator('en')

function item(patch: Partial<AttentionItem> = {}): AttentionItem {
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

/**
 * One task, two open decisions on it. Only `counts` and `attention` reach the
 * chip, so the tree stays empty: a fixture with less in it has less to go stale.
 */
function bench(attention: AttentionItem[], taskCount: number): BenchView {
  return {
    generatedAt: NOW,
    herdr: {
      online: true,
      version: '0.9.0',
      socketPath: '/tmp/herdr.sock',
      error: '',
      workspaces: 1,
      panes: 1
    },
    counts: { ...emptyCounts(), working: 1, blocked: 1, needsMe: taskCount, total: 1 },
    groups: [],
    tasks: [],
    attention,
    recovery: [],
    declined: [],
    companion: { visible: false, notices: 0 }
  }
}

let container: HTMLDivElement
let root: Root

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

function renderBar(
  view: BenchView,
  opts: {
    railOpen?: boolean
    rightOpen?: boolean
    onPurgeDeclined?: () => void
  } = {}
): Promise<void> {
  const railOpen = opts.railOpen ?? true
  const rightOpen = opts.rightOpen ?? true
  const onPurgeDeclined = opts.onPurgeDeclined ?? vi.fn()
  return render(
    <TopBar
      view={view}
      pro={null}
      railOpen={railOpen}
      rightOpen={rightOpen}
      t={t}
      onToggle={vi.fn()}
      onSummon={vi.fn()}
      onCompanion={vi.fn()}
      onSnoozeAll={vi.fn()}
      onAdopt={vi.fn()}
      onPurgeDeclined={onPurgeDeclined}
      onImport={vi.fn()}
      onStage={vi.fn()}
      onNewTask={vi.fn()}
      onConnect={vi.fn()}
      onTerminal={vi.fn()}
      onRediscover={vi.fn()}
      onToggleRail={vi.fn()}
      onToggleRight={vi.fn()}
    />
  )
}

function chip(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.count[data-state="needsMe"]')
  if (!el) throw new Error('the needs-me chip is not rendered')
  return el
}

function bell(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.right-toggle')
  if (!el) throw new Error('the queue bell is not rendered')
  return el
}

function tree(): HTMLElement {
  const el = container.querySelector<HTMLElement>('.rail-toggle')
  if (!el) throw new Error('the tree toggle is not rendered')
  return el
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

describe('the needs-me chip', () => {
  it('names every control itself: aria-labels yes, native titles no', async () => {
    // The icon row owns its tooltips now (see Tip): a `title` left on a bar
    // button would stack an OS bubble under the real one a second later.
    await renderBar(bench([], 0))
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('header button'))
    expect(buttons.length).toBeGreaterThan(8)
    for (const button of buttons) {
      expect(button.getAttribute('aria-label') || button.textContent).toBeTruthy()
      expect(button.hasAttribute('title')).toBe(false)
    }
  })

  it('shows the badge number, not the task number', async () => {
    const view = bench([item({ kind: 'question' }), item({ kind: 'permission' })], 1)
    // The shape that split the two numbers: one task, two things to answer.
    expect(view.counts.needsMe).toBe(1)
    expect(badgeFor(view)).toBe(2)
    await renderBar(view)
    expect(chip().querySelector('b')?.textContent).toBe('2')
  })

  it('agrees with the bell three controls to its right', async () => {
    const view = bench([item({ kind: 'question' }), item({ kind: 'permission' })], 1)
    await renderBar(view)
    expect(bell().dataset.count).toBe(chip().querySelector('b')?.textContent)
  })

  it('reads 0 when nothing is open, so the row does not reflow', async () => {
    const view = bench([], 0)
    await renderBar(view)
    expect(chip().querySelector('b')?.textContent).toBe('0')
    expect(chip().dataset.zero).toBe('true')
  })

  /**
   * Why the numbers have to match rather than the labels having to differ: the
   * chip and the queue it opens are the same words in both languages, so a
   * reader has no way to tell that one counts tasks and the other counts items.
   */
  it('uses the same words as the queue, which is why it may not use a different number', async () => {
    expect(t('countNeedsMe').toLowerCase()).toBe(t('queueTitle').toLowerCase())
    const view = bench([item()], 1)
    await renderBar(view)
    expect(chip().textContent).toContain(t('countNeedsMe'))
  })

  /**
   * The bell is a hide/show control at every width now, so it names the verb
   * rather than the panel: a label that reads "Queue" while the queue is already
   * on screen says nothing about what the click will do. `aria-expanded` is what
   * carries the state, and the two labels have to differ or the control cannot
   * be told apart from its own tooltip.
   */
  it('names what the click will do, and which way the panel is going', async () => {
    expect(t('collapseRight')).not.toBe(t('expandRight'))
    expect(t('collapseRail')).not.toBe(t('expandRail'))
    const view = bench([item()], 1)
    await renderBar(view)
    expect(bell().getAttribute('aria-label')).toBe(t('collapseRight'))
    expect(bell().getAttribute('aria-expanded')).toBe('true')
    await renderBar(view, { railOpen: false, rightOpen: false })
    expect(bell().getAttribute('aria-label')).toBe(t('expandRight'))
    expect(bell().getAttribute('aria-expanded')).toBe('false')
    expect(tree().getAttribute('aria-label')).toBe(t('expandRail'))
  })
})

/**
 * The chip that reports removals which left the shell running.
 *
 * Keeping a shell alive on purpose is a fine answer, but only if it stays
 * reachable: without this chip the bench would be hiding a terminal the human
 * removed, which is indistinguishable from having lost it - and it is the
 * hidden half of the bug where removed rows came back on the next snapshot.
 */
describe('the declined chip', () => {
  function declinedChip(): HTMLElement | null {
    return container.querySelector<HTMLElement>('.chip.declined')
  }

  function withDeclined(n: number): BenchView {
    return {
      ...bench([], 0),
      declined: Array.from({ length: n }, (_unused, at) => ({
        workspaceId: `w${at + 1}`,
        label: `repo-${at + 1}`,
        panes: 1,
        agentStatus: 'idle' as const
      }))
    }
  }

  it('is absent at zero, because a chip reading "nothing is wrong" is noise', async () => {
    await renderBar(bench([], 0))
    expect(declinedChip()).toBeNull()
  })

  it('counts what the projection says, and names every workspace in the tooltip', async () => {
    await renderBar(withDeclined(2))
    const el = declinedChip()
    expect(el?.textContent).toContain('2')
    const title = el?.getAttribute('title') ?? ''
    expect(title).toContain('w1 · repo-1')
    expect(title).toContain('w2 · repo-2')
  })

  it('closes them all from the one button on it, which is the only way to reach them', async () => {
    const purge = vi.fn()
    await renderBar(withDeclined(3), { onPurgeDeclined: purge })
    const button = declinedChip()?.querySelector<HTMLButtonElement>('button')
    expect(button?.getAttribute('aria-label')).toBe(t('declinedClose'))
    await act(async () => {
      button?.click()
    })
    expect(purge).toHaveBeenCalledTimes(1)
  })
})
