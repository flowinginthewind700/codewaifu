// @vitest-environment jsdom
/**
 * The agent's own menu, rendered as buttons (F3 invariant 2, F7 chips).
 *
 * `paneOptions.test.ts` pins the read and the keystroke. What only exists once
 * React is in the loop is the choice the human is given, and the bug this file
 * exists for was a choice that was not offered: the card said "Approve", the
 * recipe sent `1`, and the agent was sitting on a menu whose row 1 was not the
 * row the human meant. Both surfaces have to show the rows and pass the row
 * number out, so each gets a case, and each also asserts the generic
 * approve/deny pair steps aside rather than duplicating the decision.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parsePaneOptions, type AttentionAction, type AttentionItem } from '../src/shared/pro'
import type { BubbleMessage, BubbleRoute } from '../src/shared/ui'
import { makeTranslator } from '../src/renderer/src/pro/i18n'
import { AttentionQueue } from '../src/renderer/src/pro/AttentionQueue'
import { Bubble } from '../src/renderer/src/Bubble'

const NOW = 1_700_000_000_000
const t = makeTranslator('en')

/** codex's exec approval, read the way the pane reader reads it. */
const ROWS = parsePaneOptions(
  [
    '\u203a 1. Yes, proceed (y)',
    "  2. Yes, and don't ask again for commands that start with `echo hello world` (p)",
    '  3. No, and tell Codex what to do differently (esc)'
  ].join('\n')
)

function queueItem(patch: Partial<AttentionItem> = {}): AttentionItem {
  const kind = patch.kind ?? 'permission'
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
    title: 'Would you like to run the following command?',
    detail: '',
    toolName: 'shell',
    command: 'echo hello world',
    since: NOW - 60_000,
    updatedAt: NOW - 60_000,
    snoozedUntil: 0,
    resolved: false,
    ...patch
  }
}

function bubbleRoute(patch: Partial<BubbleRoute> = {}): BubbleRoute {
  return {
    taskId: 't1',
    paneId: 'pane-1',
    itemId: 't1:permission:hook',
    kind: 'permission',
    actions: ['approve', 'deny', 'answer', 'snooze', 'open'],
    benchLabel: 'Open in Bench',
    ...patch
  }
}

function bubbleMessage(patch: Partial<BubbleMessage> = {}): BubbleMessage {
  return {
    id: 'b1',
    text: 'codex wants to run `echo hello world`',
    lang: 'en',
    agent: 'codex',
    kind: 'permission',
    at: NOW,
    route: bubbleRoute({ options: ROWS }),
    ...patch
  }
}

let container: HTMLDivElement
let root: Root
let acted: Array<{ id: string; action: AttentionAction; extra?: unknown }>
let bubbleActs: Array<{ action: string; option?: number }>

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

function renderQueue(item: AttentionItem = queueItem({ options: ROWS })): Promise<void> {
  return render(
    <AttentionQueue
      items={[item]}
      cursorId={item.id}
      now={NOW}
      keys={null}
      t={t}
      onAct={(id, action, extra) => {
        acted.push({ id, action, extra })
      }}
      onOpen={() => {}}
      onNotify={() => {}}
    />
  )
}

function renderBubble(msg: BubbleMessage = bubbleMessage()): Promise<void> {
  return render(
    <Bubble
      message={msg}
      onOpen={() => {}}
      onAct={(route, action, option) => {
        void route
        bubbleActs.push({ action, option })
      }}
    />
  )
}

function rows(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.qoption')]
}

function chips(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.bubble-chip.option')]
}

async function click(node: HTMLButtonElement | undefined): Promise<void> {
  if (!node) throw new Error('the button is not there')
  await act(async () => {
    node.click()
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  acted = []
  bubbleActs = []
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

describe('the queue, when it could read the menu', () => {
  it('shows one button per row, numbered and labelled', async () => {
    await renderQueue()
    expect(rows()).toHaveLength(3)
    expect(rows()[0].textContent).toContain('1')
    expect(rows()[0].textContent).toContain('Yes, proceed')
    expect(rows()[2].textContent).toContain('No, and tell Codex what to do differently')
  })

  it('shows the key each row will press, before it presses it', async () => {
    await renderQueue()
    const keys = rows().map((node) => node.querySelector('kbd')?.textContent)
    expect(keys).toEqual(['y', 'p', 'esc'])
  })

  it('steps the generic approve/deny pair aside, so a decision is not offered twice', async () => {
    await renderQueue()
    const labels = [...container.querySelectorAll<HTMLButtonElement>('.qactions button')].map(
      (node) => node.textContent ?? ''
    )
    expect(labels.join(' ')).not.toContain(t('actionApprove'))
    expect(labels.join(' ')).not.toContain(t('actionDeny'))
    // The rest of the item stays actionable in place.
    expect(labels.join(' ')).toContain(t('actionAnswer'))
  })

  it('marks the esc row as a refusal and the rest as approvals', async () => {
    await renderQueue()
    expect(rows().map((node) => node.className)).toEqual([
      'qoption approve',
      'qoption approve',
      'qoption deny'
    ])
  })

  it('sends the row number out, so the plan can press that row and no other', async () => {
    await renderQueue()
    await click(rows()[1])
    expect(acted).toEqual([{ id: 't1:permission:hook', action: 'approve', extra: { option: 2 } }])
  })

  it('sends deny for the row that means leave it alone', async () => {
    await renderQueue()
    await click(rows()[2])
    expect(acted).toEqual([{ id: 't1:permission:hook', action: 'deny', extra: { option: 3 } }])
  })

  it('keeps approve/deny when no menu was read, because then they are all we have', async () => {
    await renderQueue(queueItem({ options: undefined }))
    expect(rows()).toHaveLength(0)
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.qactions button')]
    expect(buttons[0].textContent).toContain(t('actionApprove'))
    await click(buttons[0])
    // No row named: the plan falls back to the recipe for this agent.
    expect(acted[0]?.action).toBe('approve')
    expect(acted[0]?.extra).toBeUndefined()
  })
})

describe('the bubble, when it could read the menu', () => {
  it('shows a chip per row with its number, since a 196px bubble has no room for the text', async () => {
    await renderBubble()
    expect(chips()).toHaveLength(3)
    expect(chips()[0].querySelector('.bubble-option-n')?.textContent).toBe('1')
    // The whole label is still reachable: the chip is clipped, the title is not.
    expect(chips()[1].getAttribute('title')).toContain("don't ask again for commands that start with")
  })

  it('sends the row it was clicked on, not the first one', async () => {
    await renderBubble()
    await click(chips()[1])
    expect(bubbleActs).toEqual([{ action: 'approve', option: 2 }])
  })

  it('drops approve/deny from the chip row, keeping the verbs that still mean one thing', async () => {
    await renderBubble()
    const labels = [...container.querySelectorAll<HTMLButtonElement>('.bubble-chip')].map(
      (node) => node.textContent ?? ''
    )
    expect(labels).not.toContain('Approve')
    expect(labels).not.toContain('Deny')
    expect(labels.join(' ')).toContain('Snooze')
    expect(labels.join(' ')).toContain('Open in Bench')
  })

  it('renders exactly as before when the route carries no rows', async () => {
    await renderBubble(bubbleMessage({ route: bubbleRoute({ options: undefined }) }))
    expect(chips()).toHaveLength(0)
    const labels = [...container.querySelectorAll<HTMLButtonElement>('.bubble-chip')].map(
      (node) => node.textContent ?? ''
    )
    expect(labels).toContain('Approve')
    expect(labels).toContain('Deny')
  })
})
