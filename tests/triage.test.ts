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
import { Triage, type TriageEvent } from '../src/main/pro/triage'
import type { AgentStatus, PaneInfo, Snapshot } from '../src/shared/herdr'
import type { AttentionItem } from '../src/shared/pro'

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
function harness(stalledAfterMs = STALLED_MS) {
  let now = START
  const triage = new Triage({ now: () => now, stalledAfterMs })
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
    liveStalled(): AttentionItem[] {
      return triage.items().filter((item) => item.kind === 'stalled' && !item.resolved)
    }
  }
}

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
