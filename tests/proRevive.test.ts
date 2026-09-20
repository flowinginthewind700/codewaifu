/**
 * A task the human finished, still finishing itself.
 *
 * Two truths read one row: the pill comes from `status` on disk and the dot
 * comes from live panes. Pick a conversation back up after closing it and they
 * disagree forever, and the one that is wrong is the one you act on. These
 * cases pin down the rule that resolves the disagreement, because every way it
 * could be wrong is a different kind of lie:
 *
 * - Never flipping is the bug as reported: "done" sticks over a green dot.
 * - Flipping on a busy pane alone would undo a close the human made with the
 *   spinner visibly running, which teaches them the button does nothing.
 * - Flipping on the first observation would reopen rows that were already
 *   closed before this run of the app ever saw a terminal.
 *
 * Everything here goes through `parseSnapshot`/`parseTaskRecord`, so a fixture
 * cannot describe a bench the projection could never produce.
 */
import { describe, expect, it } from 'vitest'
import { parseSnapshot, type Snapshot } from '../src/shared/herdr'
import {
  livenessByTask,
  paneProgressSignature,
  parseTaskRecord,
  reviveTaskStatus,
  type TaskLiveness,
  type TaskRecord
} from '../src/shared/pro'

const NOW = 1_700_000_000_000
const REPO = '/work/codewaifu'

function record(patch: Record<string, unknown>): TaskRecord {
  const parsed = parseTaskRecord(patch)
  if (!parsed) throw new Error(`task fixture did not parse: ${JSON.stringify(patch)}`)
  return parsed
}

interface PaneSpec {
  paneId: string
  workspaceId: string
  status?: string
  revision?: number
  terminalTitle?: string
  title?: string
  offsetFromBottom?: number
}

/** One workspace per pane, built through the wire parser. */
function snapshot(panes: readonly PaneSpec[]): Snapshot {
  const parsed = parseSnapshot({
    version: '0.0.0-test',
    protocol: 1,
    workspaces: panes.map((pane, index) => ({
      workspace_id: pane.workspaceId,
      number: index + 1,
      label: pane.workspaceId
    })),
    panes: panes.map((pane) => ({
      pane_id: pane.paneId,
      workspace_id: pane.workspaceId,
      tab_id: `${pane.paneId}:tab`,
      cwd: `/tmp/live/${pane.workspaceId}`,
      agent: 'codex',
      agent_status: pane.status ?? 'working',
      revision: pane.revision ?? 0,
      terminal_title: pane.terminalTitle ?? '',
      title: pane.title ?? '',
      scroll: {
        offset_from_bottom: pane.offsetFromBottom ?? 0,
        max_offset_from_bottom: 500,
        viewport_rows: 24
      }
    }))
  })
  if (!parsed) throw new Error('snapshot fixture did not parse')
  return parsed
}

/** A done task over one workspace, which is the shape the bug arrives in. */
function doneTask(id: string, workspaceId: string, status = 'done'): TaskRecord {
  return record({
    id,
    title: `the closed conversation ${id}`,
    workdir: REPO,
    repoRoot: REPO,
    status,
    updatedAt: NOW,
    workspaceId,
    paneIds: [`${workspaceId}:p1`]
  })
}

/**
 * The same row claiming every pane of its workspace. A binding only reports the
 * panes the task listed, so a two-pane case has to say so - otherwise the second
 * pane is somebody else's terminal and nothing about it can move this row.
 */
function wideTask(id: string, workspaceId: string, panes: number): TaskRecord {
  const paneIds: string[] = []
  for (let index = 1; index <= panes; index += 1) paneIds.push(`${workspaceId}:p${index}`)
  return record({
    id,
    title: `the closed conversation ${id}`,
    workdir: REPO,
    repoRoot: REPO,
    status: 'done',
    updatedAt: NOW,
    workspaceId,
    paneIds
  })
}

const BUSY: TaskLiveness = { live: 'working', signature: 'w1:p1=0|spinner|codex|0' }
const BUSY_MOVED: TaskLiveness = { live: 'working', signature: 'w1:p1=0|spinner2|codex|0' }

describe('paneProgressSignature', () => {
  it('moves on any of the four fields that beat while an agent works', () => {
    const base = snapshot([
      { paneId: 'p1', workspaceId: 'w1', revision: 7, terminalTitle: 'codex', title: 'shell', offsetFromBottom: 3 }
    ]).panes[0]
    const moves = [
      { paneId: 'p1', workspaceId: 'w1', revision: 8, terminalTitle: 'codex', title: 'shell', offsetFromBottom: 3 },
      { paneId: 'p1', workspaceId: 'w1', revision: 7, terminalTitle: 'codex *', title: 'shell', offsetFromBottom: 3 },
      { paneId: 'p1', workspaceId: 'w1', revision: 7, terminalTitle: 'codex', title: 'shell 2', offsetFromBottom: 3 },
      { paneId: 'p1', workspaceId: 'w1', revision: 7, terminalTitle: 'codex', title: 'shell', offsetFromBottom: 4 }
    ]
    const seen = paneProgressSignature(base)
    for (const spec of moves) {
      const pane = snapshot([spec]).panes[0]
      expect(paneProgressSignature(pane)).not.toBe(seen)
    }
  })

  it('is still when nothing moves, which is what a leftover terminal looks like', () => {
    const spec = { paneId: 'p1', workspaceId: 'w1', revision: 7, terminalTitle: 'codex', title: 'shell' }
    expect(paneProgressSignature(snapshot([spec]).panes[0])).toBe(
      paneProgressSignature(snapshot([spec]).panes[0])
    )
  })
})

describe('livenessByTask', () => {
  it('reports no liveness at all while herdr is down', () => {
    const tasks = [doneTask('t-done', 'w1')]
    expect(livenessByTask(tasks, null).size).toBe(0)
  })

  it('folds the panes of one task and says unknown for a task with none', () => {
    const tasks = [
      wideTask('t-two', 'w1', 2),
      record({ id: 't-none', title: 'no terminal left', workdir: REPO, repoRoot: REPO, status: 'done' })
    ]
    const snap = snapshot([
      { paneId: 'w1:p1', workspaceId: 'w1', status: 'working' },
      { paneId: 'w1:p2', workspaceId: 'w1', status: 'idle' }
    ])
    const seen = livenessByTask(tasks, snap)
    // `working` outranks `idle`, so the fold is what the tree already shows.
    expect(seen.get('t-two')?.live).toBe('working')
    expect(seen.get('t-none')?.live).toBe('unknown')
    expect(seen.get('t-none')?.signature).toBe('')
  })

  it('reads two panes listed in either order as the same proof of life', () => {
    const tasks = [wideTask('t-two', 'w1', 2)]
    const panes: readonly PaneSpec[] = [
      { paneId: 'w1:p1', workspaceId: 'w1', terminalTitle: 'one' },
      { paneId: 'w1:p2', workspaceId: 'w1', terminalTitle: 'two' }
    ]
    const forward = livenessByTask(tasks, snapshot(panes)).get('t-two')?.signature ?? ''
    const backward = livenessByTask(tasks, snapshot([...panes].reverse())).get('t-two')?.signature ?? ''
    expect(forward).toBe(backward)
    expect(forward).toContain('w1:p1')
    expect(forward).toContain('w1:p2')
  })

  it('counts one pane repainting as progress in the whole task', () => {
    const tasks = [wideTask('t-two', 'w1', 2)]
    const before = snapshot([
      { paneId: 'w1:p1', workspaceId: 'w1', terminalTitle: 'one' },
      { paneId: 'w1:p2', workspaceId: 'w1', terminalTitle: 'two' }
    ])
    const after = snapshot([
      { paneId: 'w1:p1', workspaceId: 'w1', terminalTitle: 'one' },
      { paneId: 'w1:p2', workspaceId: 'w1', terminalTitle: 'two *' }
    ])
    expect(livenessByTask(tasks, after).get('t-two')?.signature).not.toBe(
      livenessByTask(tasks, before).get('t-two')?.signature
    )
  })
})

describe('reviveTaskStatus', () => {
  it('reopens on a quiet-to-busy transition, which is the case the human described', () => {
    const prior: TaskLiveness = { live: 'idle', signature: 'w1:p1=0|||0' }
    expect(reviveTaskStatus('done', BUSY, prior, false)).toBe(true)
    // Even over a close we watched: a transition is a new turn, not a spinner.
    expect(reviveTaskStatus('done', BUSY, prior, true)).toBe(true)
  })

  it('reopens on a moved signature when nobody watched the close', () => {
    expect(reviveTaskStatus('done', BUSY_MOVED, BUSY, false)).toBe(true)
  })

  it('honours a close made over a busy pane until something actually changes', () => {
    expect(reviveTaskStatus('done', BUSY_MOVED, BUSY, true)).toBe(false)
    // The same verdict still yields to a real transition into busy.
    expect(
      reviveTaskStatus('done', BUSY_MOVED, { live: 'idle', signature: 'w1:p1=0|||0' }, true)
    ).toBe(true)
  })

  it('never flips on the first observation: a baseline is recorded, not judged', () => {
    expect(reviveTaskStatus('done', BUSY_MOVED, null, false)).toBe(false)
    expect(reviveTaskStatus('done', BUSY_MOVED, null, true)).toBe(false)
  })

  it('leaves a genuinely quiet terminal alone', () => {
    expect(reviveTaskStatus('done', BUSY, BUSY, false)).toBe(false)
    const idle = { live: 'idle', signature: 'w1:p1=0|||0' } as TaskLiveness
    expect(reviveTaskStatus('done', idle, BUSY_MOVED, false)).toBe(false)
  })

  it('leaves a task with no pane alone, however the signature moves', () => {
    const none = { live: 'unknown', signature: '' } as TaskLiveness
    expect(reviveTaskStatus('done', none, { live: 'working', signature: 'w1:p1=0|x||0' }, false)).toBe(
      false
    )
  })

  it('only ever touches done: a park is a decision about attention, not about work', () => {
    for (const status of ['active', 'parked', 'lost'] as const) {
      expect(reviveTaskStatus(status, BUSY_MOVED, BUSY, false)).toBe(false)
    }
  })

  it('treats a blocked pane as work resuming, because it is the agent asking again', () => {
    const blocked = { live: 'blocked', signature: 'w1:p1=0|approval||0' } as TaskLiveness
    expect(reviveTaskStatus('done', blocked, BUSY, false)).toBe(true)
  })
})
