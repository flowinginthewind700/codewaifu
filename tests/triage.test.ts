/**
 * The stall heuristic, which until now had no test - and which shipped a bug
 * precisely because nothing pinned what "no new output" is allowed to look at.
 *
 * The bug: stall detection keyed on herdr's `revision` alone. A live probe of a
 * genuinely working codex pane showed `revision` frozen for an entire run while
 * `terminal_title` repainted about once a second (the title carries the spinner
 * Ghostty draws). So the one field that never moves during real work was the
 * only thing the heuristic watched, and busy agents were declared "stalled"
 * minutes into healthy output. The fix watches a signature that includes the
 * title, and lets out-of-band proof of life (terminal frames, a human typing)
 * reset the clock immediately.
 *
 * Nothing here is Electron and nothing touches the socket: `Triage` is pure, the
 * clock is a counter we advance by hand, and panes are built inline.
 */
import { describe, expect, it } from 'vitest'
import {
  paneReadHint,
  Triage,
  type TriageDeps,
  type TriageEvent,
  type TaskRef
} from '../src/main/pro/triage'
import type { AgentStatus, PaneInfo, Snapshot } from '../src/shared/herdr'
import type { AttentionItem, TaskStatus } from '../src/shared/pro'

const START = 1_700_000_000_000
/** Short on purpose so a test can cross the threshold in a few steps. */
const STALLED_MS = 10_000

function pane(patch: Partial<PaneInfo> = {}): PaneInfo {
  return {
    paneId: 'w1:p1',
    terminalId: 't1',
    workspaceId: 'w1',
    tabId: 'tab1',
    focused: true,
    cwd: '/work',
    foregroundCwd: '/work',
    label: '',
    agent: 'codex',
    title: 'codex',
    terminalTitle: 'codex',
    displayAgent: 'Codex',
    agentStatus: 'working' as AgentStatus,
    stateLabels: {},
    tokens: {},
    agentSession: null,
    revision: 1,
    scroll: { offsetFromBottom: 0, maxOffsetFromBottom: 0, viewportRows: 40 },
    ...patch
  }
}

function snapshot(panes: PaneInfo[]): Snapshot {
  return {
    version: 'test',
    protocol: 1,
    workspaces: [],
    tabs: [],
    panes,
    agents: [],
    layouts: [],
    focusedWorkspaceId: 'w1',
    focusedTabId: 'tab1',
    focusedPaneId: panes[0]?.paneId ?? ''
  }
}

/** A fake clock plus the triage events, so a test can assert what was raised. */
function harness(
  stalledAfterMs = STALLED_MS,
  deps: Omit<TriageDeps, 'now' | 'stalledAfterMs'> = {}
) {
  let now = START
  const triage = new Triage({ now: () => now, stalledAfterMs, ...deps })
  const events: TriageEvent[] = []
  triage.onEvent((event) => events.push(event))
  return {
    triage,
    events,
    advance(ms: number) {
      now += ms
    },
    get now() {
      return now
    },
    raised(kind: string): AttentionItem[] {
      return events.filter((e) => e.type === 'raised' && e.item.kind === kind).map(
        (e) => (e as { item: AttentionItem }).item
      )
    },
    /** Rows that changed type, which is what a pane read is allowed to do. */
    reclassified(): Array<{ from: string; item: AttentionItem }> {
      return events
        .filter((e) => e.type === 'reclassified')
        .map((e) => e as { from: string; item: AttentionItem })
    },
    live(kind: string): AttentionItem[] {
      return triage.items().filter((item) => item.kind === kind && !item.resolved)
    },
    liveStalled(): AttentionItem[] {
      return triage.items().filter((item) => item.kind === 'stalled' && !item.resolved)
    }
  }
}

/** One task the registry knows about, at whatever verdict the human left it. */
function ref(status: TaskStatus, paneId = 'w1:p1'): TaskRef {
  return {
    taskId: 't1',
    title: '论文采集',
    groupLabel: 'robotworld',
    agentKind: 'codex',
    paneId,
    paneIds: [paneId],
    workspaceId: 'w1',
    status
  }
}

/** The bench's own hydrate interval; a case crosses it to prove a point. */
const HYDRATE_MS = 30_000
/**
 * Mirrors triage's private `RESOLVED_SUPPRESS_MS`. The two mechanisms answer
 * different questions - that one is "did we just deal with this id", the ack is
 * "has this pane finished again since the human looked" - so a case about the
 * ack has to step past the window to be testing the ack.
 */
const SUPPRESS_MS = 120_000

describe('triage stall detection', () => {
  it('does not stall a working pane whose terminal title keeps repainting', () => {
    const h = harness()
    // First sight arms the clock.
    h.triage.onSnapshot(snapshot([pane({ revision: 1, terminalTitle: 'spin |' })]))
    // revision is frozen the whole run - exactly the live-probe condition - but
    // the title moves every tick. Past the threshold, this must stay quiet.
    for (let i = 0; i < 6; i += 1) {
      h.advance(3000)
      h.triage.onSnapshot(
        snapshot([pane({ revision: 1, terminalTitle: `spin ${'|/-\\'[i % 4]}` })])
      )
    }
    expect(h.raised('stalled')).toHaveLength(0)
    expect(h.liveStalled()).toHaveLength(0)
  })

  it('stalls a working pane that is genuinely quiet past the threshold', () => {
    const h = harness()
    const quiet = pane({ revision: 7, terminalTitle: 'done thinking', title: 'codex' })
    h.triage.onSnapshot(snapshot([quiet]))
    h.advance(STALLED_MS - 1)
    h.triage.onSnapshot(snapshot([quiet]))
    expect(h.liveStalled()).toHaveLength(0)
    h.advance(2)
    h.triage.onSnapshot(snapshot([quiet]))
    expect(h.raised('stalled')).toHaveLength(1)
    expect(h.liveStalled()).toHaveLength(1)
  })

  it('never stalls a pane that is not working, however quiet', () => {
    const h = harness()
    const idle = pane({ agentStatus: 'idle', revision: 3, terminalTitle: 'prompt' })
    h.triage.onSnapshot(snapshot([idle]))
    h.advance(STALLED_MS * 3)
    h.triage.onSnapshot(snapshot([idle]))
    expect(h.raised('stalled')).toHaveLength(0)
  })

  it('clears a raised stall the moment the title moves again', () => {
    const h = harness()
    h.triage.onSnapshot(snapshot([pane({ revision: 2, terminalTitle: 'quiet' })]))
    h.advance(STALLED_MS + 1)
    h.triage.onSnapshot(snapshot([pane({ revision: 2, terminalTitle: 'quiet' })]))
    expect(h.liveStalled()).toHaveLength(1)
    // Output resumes: same revision, new title.
    h.advance(1000)
    h.triage.onSnapshot(snapshot([pane({ revision: 2, terminalTitle: 'typing...' })]))
    expect(h.liveStalled()).toHaveLength(0)
  })

  it('noteActivity resets the clock so a just-typed pane cannot stall', () => {
    const h = harness()
    const quiet = pane({ revision: 5, terminalTitle: 'frozen' })
    h.triage.onSnapshot(snapshot([quiet]))
    h.advance(STALLED_MS - 500)
    // The human types: out-of-band proof of life, no snapshot yet.
    h.triage.noteActivity('w1:p1')
    h.advance(STALLED_MS - 500)
    h.triage.onSnapshot(snapshot([quiet]))
    // 19.5s of wall time, but the clock restarted at the keystroke.
    expect(h.raised('stalled')).toHaveLength(0)
  })

  it('noteActivity clears a stall that already fired', () => {
    const h = harness()
    const quiet = pane({ revision: 5, terminalTitle: 'frozen' })
    h.triage.onSnapshot(snapshot([quiet]))
    h.advance(STALLED_MS + 1)
    h.triage.onSnapshot(snapshot([quiet]))
    expect(h.liveStalled()).toHaveLength(1)
    h.triage.noteActivity('w1:p1')
    expect(h.liveStalled()).toHaveLength(0)
  })

  it('treats a scrollback move as progress', () => {
    const h = harness()
    h.triage.onSnapshot(
      snapshot([pane({ revision: 1, terminalTitle: 'same', scroll: { offsetFromBottom: 0, maxOffsetFromBottom: 100, viewportRows: 40 } })])
    )
    h.advance(STALLED_MS + 1)
    // Title and revision identical, but the human scrolled: still not a stall.
    h.triage.onSnapshot(
      snapshot([pane({ revision: 1, terminalTitle: 'same', scroll: { offsetFromBottom: 20, maxOffsetFromBottom: 100, viewportRows: 40 } })])
    )
    expect(h.raised('stalled')).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------ *
 * The human's verdict
 * ------------------------------------------------------------------ */

/**
 * A finished task that would not stay finished.
 *
 * The shipped bug, from a real bench: one task was marked done, its row
 * dismissed, and the companion then announced "完成了，等你 review" every two
 * minutes until the app was closed - the ledger for it holds three separate
 * `marked done` checkpoints four minutes apart, which is a human clicking the
 * same button three times because the first two did not take.
 *
 * Two independent loops produced it, and both are pinned below.
 *
 * herdr reports a finished pane as `done` on every snapshot forever, because
 * the pane really is still finished; nothing about the pane ever changes. The
 * only thing that can end the repetition is the human's own answer, so `review`
 * became the one kind that consults the task status, and an acknowledged finish
 * became state rather than a two-minute suppression window that always expired
 * before the pane did.
 *
 * The second loop was the pane read. `hydrate` matched the scrollback against a
 * prompt regex, and a finished agent's scrollback still contains every "do you
 * want to approve" it answered an hour ago - so a `review` row was reclassified
 * into a `permission` row, whose id is different because the id embeds the
 * kind, which the bench announced as a brand new need. The next snapshot raised
 * `review` again. Two announcements per hydrate tick, alternating, forever.
 */
describe('triage and the human verdict', () => {
  it('does not ask for a review of a task the human already closed', () => {
    for (const status of ['done', 'parked'] as const) {
      const h = harness(STALLED_MS, { resolveTask: () => ref(status) })
      h.triage.onSnapshot(snapshot([pane({ agentStatus: 'done' })]))
      expect(h.raised('review'), status).toHaveLength(0)
      expect(h.live('review'), status).toHaveLength(0)
    }
  })

  it('still asks while the task is open, and while it cannot be filed at all', () => {
    const h = harness(STALLED_MS, { resolveTask: () => ref('active') })
    h.triage.onSnapshot(snapshot([pane({ agentStatus: 'done' })]))
    expect(h.raised('review')).toHaveLength(1)

    // No task resolved: there is no verdict to consult, so the row is raised.
    // Guessing "closed" here would hide every pane the registry has not met.
    const orphan = harness(STALLED_MS, { resolveTask: () => null })
    orphan.triage.onSnapshot(snapshot([pane({ agentStatus: 'done', paneId: 'w9:p9' })]))
    expect(orphan.raised('review')).toHaveLength(1)
  })

  it('keeps a blocking need live under a closed task, because the agent is still there', () => {
    // A pane waiting on a keypress, or one that died, is stuck whether or not
    // the human is still counting the task, and only a live pane can be
    // unstuck. So those kinds ignore the verdict.
    const h = harness(STALLED_MS, { resolveTask: () => ref('done') })
    h.triage.onSnapshot(snapshot([pane({ agentStatus: 'blocked' })]))
    expect(h.live('permission')).toHaveLength(1)
  })

  it('does not call a closed task\'s quiet pane a stall', () => {
    // `stalled` is the other guess we make about a pane rather than something
    // the agent said, and it is the weakest signal we have: a long-running
    // command and a hung agent look identical from outside. Under a task the
    // human already closed it is not even a guess worth making - the leftover
    // pane of a finished task sits frozen at a prompt forever, and reading that
    // as "stuck" is what made a completed 论文采集 keep asking to be looked at.
    for (const status of ['done', 'parked'] as const) {
      const h = harness(STALLED_MS, { resolveTask: () => ref(status) })
      const quiet = pane({ agentStatus: 'working', revision: 9, terminalTitle: 'frozen' })
      h.triage.onSnapshot(snapshot([quiet]))
      h.advance(STALLED_MS + 1)
      h.triage.onSnapshot(snapshot([quiet]))
      expect(h.raised('stalled'), status).toHaveLength(0)
    }

    // Still raised while the task is open, and when it cannot be filed at all:
    // with no verdict to consult, guessing "closed" would hide every pane the
    // registry has not met yet.
    const open = harness(STALLED_MS, { resolveTask: () => ref('active') })
    const quiet = pane({ agentStatus: 'working', revision: 9, terminalTitle: 'frozen' })
    open.triage.onSnapshot(snapshot([quiet]))
    open.advance(STALLED_MS + 1)
    open.triage.onSnapshot(snapshot([quiet]))
    expect(open.raised('stalled')).toHaveLength(1)

    const orphan = harness(STALLED_MS, { resolveTask: () => null })
    orphan.triage.onSnapshot(snapshot([pane({ paneId: 'w9:p9' })]))
    orphan.advance(STALLED_MS + 1)
    orphan.triage.onSnapshot(snapshot([pane({ paneId: 'w9:p9' })]))
    expect(orphan.raised('stalled')).toHaveLength(1)
  })

  it('says "finished" once and then stays quiet, however long the pane sits there', () => {
    const h = harness(STALLED_MS, { resolveTask: () => ref('active') })
    const done = pane({ agentStatus: 'done' })
    h.triage.onSnapshot(snapshot([done]))
    expect(h.raised('review')).toHaveLength(1)
    h.triage.resolveTaskItems('t1', 'task marked done')

    // Ten hydrate ticks of the same finished pane. The old suppression window
    // was two minutes, so this loop used to re-raise on the fifth iteration.
    for (let i = 0; i < 10; i += 1) {
      h.advance(HYDRATE_MS)
      h.triage.onSnapshot(snapshot([done]))
    }
    expect(h.raised('review')).toHaveLength(1)
    expect(h.live('review')).toHaveLength(0)
  })

  it('counts dismissing the row itself as the acknowledgement', () => {
    // The bubble's "done" closes the task; the attention row's dismiss only
    // resolves the one item. Both are the human saying "I have seen this".
    const h = harness(STALLED_MS, { resolveTask: () => ref('active') })
    const done = pane({ agentStatus: 'done' })
    h.triage.onSnapshot(snapshot([done]))
    const [item] = h.raised('review')
    h.triage.resolve(item.id, 'acted')
    for (let i = 0; i < 10; i += 1) {
      h.advance(HYDRATE_MS)
      h.triage.onSnapshot(snapshot([done]))
    }
    expect(h.raised('review')).toHaveLength(1)
  })

  it('says it again when the pane works and finishes a second time', () => {
    const h = harness(STALLED_MS, { resolveTask: () => ref('active') })
    h.triage.onSnapshot(snapshot([pane({ agentStatus: 'done' })]))
    h.triage.resolveTaskItems('t1', 'task marked done')
    h.advance(SUPPRESS_MS + HYDRATE_MS)
    h.triage.onSnapshot(snapshot([pane({ agentStatus: 'done' })]))
    expect(h.raised('review')).toHaveLength(1)

    // A second run in the same pane is a second finish, and it is news again.
    h.triage.onSnapshot(
      snapshot([pane({ agentStatus: 'working', revision: 2, terminalTitle: 'spin |' })])
    )
    h.advance(1000)
    h.triage.onSnapshot(snapshot([pane({ agentStatus: 'done', revision: 3 })]))
    expect(h.raised('review')).toHaveLength(2)
  })

  it('does not reclassify a finished pane off prompts it answered an hour ago', async () => {
    const h = harness(STALLED_MS, { resolveTask: () => ref('active') })
    h.triage.onSnapshot(snapshot([pane({ agentStatus: 'done' })]))
    expect(h.live('review')).toHaveLength(1)

    // Exactly what the scrollback of the real 论文采集 pane looked like: an
    // approval prompt, long since answered, still on screen.
    const filled = await h.triage.hydrate(async () =>
      paneReadHint('Do you want to approve this command? (y/n)', 'review')
    )
    expect(filled).toBe(1)
    expect(h.live('review')).toHaveLength(1)
    expect(h.live('permission')).toHaveLength(0)
    expect(h.reclassified()).toHaveLength(0)
    // The read is still worth keeping; only the change of type is refused.
    expect(h.live('review')[0].title).toBe('Do you want to approve this command? (y/n)')
  })

  it('reclassifies a blocked pane as one need rather than two', async () => {
    const h = harness(STALLED_MS, { resolveTask: () => ref('active') })
    h.triage.onSnapshot(snapshot([pane({ agentStatus: 'done' })]))
    const [review] = h.live('review')
    // The human answers, the agent runs, and then blocks on a real question.
    h.triage.onSnapshot(snapshot([pane({ agentStatus: 'blocked', revision: 4 })]))
    expect(h.live('permission')).toHaveLength(1)

    await h.triage.hydrate(async (item) =>
      item.kind === 'review' ? { kind: 'question', title: 'Which target should I build?' } : null
    )
    const [moved] = h.reclassified()
    expect(moved.from).toBe(review.id)
    expect(moved.item.kind).toBe('question')
    expect(h.live('question')).toHaveLength(1)
    expect(h.live('review')).toHaveLength(0)
    // How long the human has been kept waiting is a fact about the wait, not
    // about our guess at its type, so it survives the move.
    expect(h.live('question')[0].since).toBe(review.since)
    // The point of the separate event: `raised` is what the bench speaks aloud,
    // and a better-informed label for the same wait is not news.
    expect(h.raised('question')).toHaveLength(0)
  })

  it('keeps one row when a reclassification lands on a need already raised', async () => {
    const h = harness(STALLED_MS, { resolveTask: () => ref('active') })
    h.triage.onSnapshot(snapshot([pane({ agentStatus: 'done' })]))
    h.triage.onSnapshot(snapshot([pane({ agentStatus: 'blocked', revision: 4 })]))
    const [permission] = h.live('permission')

    await h.triage.hydrate(async (item) =>
      item.kind === 'review' ? { kind: 'permission', title: 'y/n' } : null
    )
    // Both rows described the same pane waiting on the same keypress; the one
    // herdr raised is kept, and the guess retires instead of clobbering it.
    expect(h.reclassified()).toHaveLength(0)
    expect(h.live('review')).toHaveLength(0)
    expect(h.live('permission')).toHaveLength(1)
    expect(h.live('permission')[0].id).toBe(permission.id)
    // Kept, not overwritten: clobbering the row would swap what herdr proved
    // for what a scrollback regex guessed, and the id would stay the same, so
    // nothing downstream would notice the swap.
    expect(h.live('permission')[0].title).toBe(permission.title)
  })

  it('does not let enrichment turn into a second announcement', async () => {
    const h = harness(STALLED_MS, { resolveTask: () => ref('active') })
    const blocked = pane({ agentStatus: 'blocked', title: 'Waiting on you' })
    h.triage.onSnapshot(snapshot([blocked]))
    expect(h.raised('permission')).toHaveLength(1)
    const since = h.live('permission')[0].since

    await h.triage.hydrate(async () => ({
      title: 'Do you want to allow npm test?',
      detail: 'Press 1 to approve'
    }))
    expect(h.live('permission')[0].title).toBe('Do you want to allow npm test?')

    for (let i = 0; i < 4; i += 1) {
      h.advance(HYDRATE_MS)
      h.triage.onSnapshot(snapshot([blocked]))
    }
    // Nothing new happened to this pane. Writing the enriched fields back into
    // the row's fingerprint used to make the next identical snapshot look like
    // a different need, which re-raised it and reset the elapsed timer the row
    // is displayed with.
    expect(h.raised('permission')).toHaveLength(1)
    expect(h.live('permission')).toHaveLength(1)
    expect(h.live('permission')[0].since).toBe(since)
  })

  it('forgets a pane that closed, so a reused pane id starts honest', () => {
    const h = harness(STALLED_MS, { resolveTask: () => ref('active') })
    const done = pane({ agentStatus: 'done' })
    h.triage.onSnapshot(snapshot([done]))
    h.triage.resolveTaskItems('t1', 'task marked done')
    h.advance(SUPPRESS_MS + HYDRATE_MS)

    // herdr restarted and the pane is gone: the acknowledgement goes with it.
    h.triage.onSnapshot(snapshot([]))
    h.triage.onSnapshot(snapshot([done]))
    expect(h.raised('review')).toHaveLength(2)
  })
})

/* ------------------------------------------------------------------ *
 * One quiet period, one announcement
 * ------------------------------------------------------------------ */

/**
 * The second half of the same complaint, on the other kind.
 *
 * From the real bench: a task was marked done, the stall row was dismissed, and
 * two minutes later the companion said "卡住了" again - and kept saying it every
 * two minutes, because `RESOLVED_SUPPRESS_MS` is a timer and the pane it was
 * suppressing never changed. The row was resolved, `prune` dropped it twenty
 * seconds later, and the next tick found the same frozen signature with nothing
 * live to point at, so it raised it as new. Dismissing was not an answer, it was
 * a snooze with a fixed length.
 *
 * What makes a stall stop being news is not a clock: it is either the pane
 * producing output (a new quiet period, which nobody has seen) or the human
 * saying they have looked at this one.
 */
describe('triage stall acknowledgement', () => {
  it('says "stalled" once per quiet period, however long the pane sits there', () => {
    const h = harness(STALLED_MS, { resolveTask: () => ref('active') })
    const quiet = pane({ revision: 4, terminalTitle: 'frozen' })
    h.triage.onSnapshot(snapshot([quiet]))
    h.advance(STALLED_MS + 1)
    h.triage.onSnapshot(snapshot([quiet]))
    const [item] = h.raised('stalled')
    expect(item).toBeTruthy()
    h.triage.resolve(item.id, 'acted')

    // Well past the two-minute suppression window, ten times over: the pane has
    // not produced a byte since the human dismissed it, so there is nothing new
    // to say. This loop used to re-raise on the second iteration.
    for (let i = 0; i < 10; i += 1) {
      h.advance(SUPPRESS_MS + HYDRATE_MS)
      h.triage.onSnapshot(snapshot([quiet]))
    }
    expect(h.raised('stalled')).toHaveLength(1)
    expect(h.liveStalled()).toHaveLength(0)
  })

  it('counts marking the task done as the acknowledgement', () => {
    // The human closes the task instead of the row. Same verdict, and it has to
    // hold even though the pane stays open and frozen underneath it.
    const h = harness(STALLED_MS, { resolveTask: () => ref('active') })
    const quiet = pane({ revision: 4, terminalTitle: 'frozen' })
    h.triage.onSnapshot(snapshot([quiet]))
    h.advance(STALLED_MS + 1)
    h.triage.onSnapshot(snapshot([quiet]))
    expect(h.raised('stalled')).toHaveLength(1)
    h.triage.resolveTaskItems('t1', 'task marked done')
    for (let i = 0; i < 10; i += 1) {
      h.advance(SUPPRESS_MS + HYDRATE_MS)
      h.triage.onSnapshot(snapshot([quiet]))
    }
    expect(h.raised('stalled')).toHaveLength(1)
  })

  it('says it again when the pane works and goes quiet a second time', () => {
    const h = harness(STALLED_MS, { resolveTask: () => ref('active') })
    h.triage.onSnapshot(snapshot([pane({ revision: 4, terminalTitle: 'frozen' })]))
    h.advance(STALLED_MS + 1)
    h.triage.onSnapshot(snapshot([pane({ revision: 4, terminalTitle: 'frozen' })]))
    const [first] = h.raised('stalled')
    h.triage.resolve(first.id, 'acted')

    // Output resumes, so the dismissed period is over. Past the suppression
    // window too, because a genuinely new need that arrives inside it is held
    // back by design and would only muddy the point.
    h.advance(SUPPRESS_MS)
    h.triage.onSnapshot(snapshot([pane({ revision: 5, terminalTitle: 'typing...' })]))
    expect(h.liveStalled()).toHaveLength(0)

    // A second silence is a second question, and the human has not answered it.
    const quietAgain = pane({ revision: 5, terminalTitle: 'frozen once more' })
    h.triage.onSnapshot(snapshot([quietAgain]))
    h.advance(STALLED_MS + 1)
    h.triage.onSnapshot(snapshot([quietAgain]))
    expect(h.raised('stalled')).toHaveLength(2)
  })

  it('does not let a blind tick spend the acknowledgement', () => {
    // herdr hiccuping returns a null snapshot. Reading that as "every pane
    // closed" dropped the rows and forgot the acks, so the next real snapshot
    // re-raised the whole bench at once and she read all of it aloud again.
    const h = harness(STALLED_MS, { resolveTask: () => ref('active') })
    const quiet = pane({ revision: 4, terminalTitle: 'frozen' })
    h.triage.onSnapshot(snapshot([quiet]))
    h.advance(STALLED_MS + 1)
    h.triage.onSnapshot(snapshot([quiet]))
    const [item] = h.raised('stalled')
    h.triage.resolve(item.id, 'acted')

    h.advance(SUPPRESS_MS + HYDRATE_MS)
    h.triage.onSnapshot(null)
    for (let i = 0; i < 5; i += 1) {
      h.advance(SUPPRESS_MS + HYDRATE_MS)
      h.triage.onSnapshot(snapshot([quiet]))
    }
    expect(h.raised('stalled')).toHaveLength(1)
  })

  it('keeps a reviewed finish reviewed across a blind tick', () => {
    const h = harness(STALLED_MS, { resolveTask: () => ref('active') })
    const done = pane({ agentStatus: 'done' })
    h.triage.onSnapshot(snapshot([done]))
    h.triage.resolveTaskItems('t1', 'task marked done')
    expect(h.raised('review')).toHaveLength(1)

    h.advance(SUPPRESS_MS + HYDRATE_MS)
    h.triage.onSnapshot(null)
    h.advance(HYDRATE_MS)
    h.triage.onSnapshot(snapshot([done]))
    expect(h.raised('review')).toHaveLength(1)
  })
})
