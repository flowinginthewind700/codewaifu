/**
 * A stand-in bench for transport tests.
 *
 * The point is to test the wire, not the service: everything here records what
 * arrived and answers with a result the test chooses, so a route test can assert
 * "this payload became this typed request" and "this failure became this status"
 * without a herdr, a window or a disk.
 */
import { emptyCounts, type AttentionItem, type BenchView } from '../../src/shared/pro'
import {
  okResult,
  type ProActionRequest,
  type ProLedgerRequest,
  type ProResult,
  type ProTaskRequest
} from '../../src/shared/proIpc'
import type { ProApi } from '../../src/main/server'

/** One queue entry, with every field filled in. */
export function attentionItem(patch: Partial<AttentionItem> = {}): AttentionItem {
  const taskId = patch.taskId ?? 't1'
  const kind = patch.kind ?? 'permission'
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
    title: 'Run the test suite?',
    detail: 'the agent wants to run npm test',
    toolName: 'shell',
    command: 'npm test',
    since: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    snoozedUntil: 0,
    resolved: false,
    ...patch
  }
}

/** A whole projection, empty except for what the caller cares about. */
export function benchView(patch: Partial<BenchView> = {}): BenchView {
  return {
    generatedAt: 1_700_000_000_000,
    herdr: {
      online: true,
      version: '0.0.0-test',
      socketPath: '/tmp/herdr.sock',
      error: '',
      workspaces: 1,
      panes: 1
    },
    counts: emptyCounts(),
    groups: [],
    tasks: [],
    attention: [],
    recovery: [],
    companion: { visible: false, notices: 0 },
    ...patch
  }
}

export interface ProRecorder {
  actions: ProActionRequest[]
  tasks: ProTaskRequest[]
  ledger: ProLedgerRequest[]
}

export interface FakePro {
  api: ProApi
  recorded: ProRecorder
  setResult(result: ProResult): void
  setView(view: BenchView | null): void
  setOnline(online: boolean): void
  /** How often the relay asked for the projection. */
  viewCalls(): number
  /**
   * How many `/pro/stream` watchers are still subscribed. A relay that leaks
   * one after the socket closes passes every status-code test and still holds
   * a listener on the bench forever, so the count is the assertion.
   */
  subscriberCount(): number
}

/**
 * The fake itself. Every mutating call records its typed request and answers
 * with `result`, so a test drives the status code and the payload separately.
 */
export function fakePro(initial: { view?: BenchView | null; online?: boolean } = {}): FakePro {
  const recorded: ProRecorder = { actions: [], tasks: [], ledger: [] }
  let view: BenchView | null = initial.view === undefined ? benchView() : initial.view
  let online = initial.online ?? true
  let result: ProResult = okResult(null, '', '')
  let views = 0
  const listeners = new Set<(view: BenchView | null) => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) listener(view)
  }

  const api: ProApi = {
    online: () => online,
    view: () => {
      views += 1
      return view
    },
    act: async (request) => {
      recorded.actions.push(request)
      return result
    },
    taskOp: async (request) => {
      recorded.tasks.push(request)
      return result
    },
    ledgerOp: (request) => {
      recorded.ledger.push(request)
      return result
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }

  return {
    api,
    recorded,
    setResult: (next) => {
      result = next
    },
    setView: (next) => {
      view = next
      // The real service pushes on change; a fake that only answers polls
      // would let a dead stream route look alive.
      notify()
    },
    setOnline: (next) => {
      online = next
      notify()
    },
    viewCalls: () => views,
    subscriberCount: () => listeners.size
  }
}
