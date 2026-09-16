/**
 * The service itself, which until now had no direct test: every other file here
 * tests one of the pieces it composes (registry, ledger, triage, recovery,
 * terminal bridge) or a pure projection in `shared/`, and the wiring between
 * them was covered only by the built-app gate. That is how a two-second memo
 * survived review and then contradicted the projection it fed.
 *
 * The case pinned below is that memo. Recovery plans are the one part of the
 * projection whose input is not the clock but a fact about the world - whether
 * herdr is reachable - and a TTL cannot express "the world changed". herdr
 * coming back is exactly when the recovery tab gets read, so the stale verdict
 * lands on the one screen whose whole job is to be read after a restart: the
 * tab says "herdr is not running" over a task that is merely lost, and on a
 * quiet bench nothing ever asks again.
 *
 * Nothing here is Electron, and nothing touches disk: the registry is an
 * in-memory file, the ledger answers from a closure, the session is a flag.
 */
import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/shared/config'
import {
  emptyCounts,
  resolveWorkdir,
  type LedgerDigest,
  type RecoveryPlan,
  type TaskRecord
} from '../src/shared/pro'
import {
  okResult,
  type ImportCandidate,
  type ProCompanionPush,
  type ProTaskRequest
} from '../src/shared/proIpc'
import { parseSnapshot, type Snapshot } from '../src/shared/herdr'
import type { ChatTranscript } from '../src/shared/chat'
import type { SteerResult, ThreadInfo } from '../src/shared/protocol'
import { TaskRegistry } from '../src/main/pro/bench'
import type { AnnounceResult } from '../src/main/pro/companion'
import { GitProbe } from '../src/main/pro/git'
import type { HerdrTarget } from '../src/main/pro/herdr/discovery'
import type { LedgerInput } from '../src/main/pro/ledger'
import type { SessionChange, SessionStatus } from '../src/main/pro/herdr/session'
import type { Recovery } from '../src/main/pro/recovery'
import {
  ProService,
  type CompanionLike,
  type HerdrClientLike,
  type LedgerLike,
  type ProHost,
  type ServiceTimers,
  type SessionLike
} from '../src/main/pro/service'

const SOCKET = '/tmp/codewaifu-proservice.sock'
/** Deliberately absent: `dirExists` false is part of the shape being planned. */
const WORKDIR = '/nonexistent/codewaifu/proservice'
const TASK_ID = 't-proservice'
const START = 1_700_000_000_000
/** The default, spelled out because every case below stays inside it. */
const RECOVERY_TTL_MS = 2000
const PUSH_MS = 5
/** Ids of a pane herdr restored for us, used by the "never touch it" case. */
const LIVE_WORKSPACE = 'w-live'
const LIVE_PANE = 'p-live'
/** The settle window the unattended pass waits out, kept short and explicit. */
const BOOT_RESUME_MS = 30
/**
 * A directory that really exists, because `importThreads` stats a thread's cwd
 * before it will create anything: a conversation whose folder is gone is a
 * conversation the bench cannot run, and importing it would be a task that can
 * never be resumed.
 */
const IMPORT_DIR = os.tmpdir()
/** What the fake git answers `rev-parse --show-toplevel` with for it. */
const IMPORT_ROOT = '/repo/imported'
/** Session ids: one nobody owns, one a task already carries. */
const FREE = 'sess-free'
const CLAIMED = 'sess-claimed'

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

interface TestClock {
  timers: ServiceTimers
  /** Run everything due within `ms`, in order, then land on `now + ms`. */
  advance(ms: number): void
  now(): number
}

/**
 * `ServiceTimers` has an `every`, and the service arms three of them at boot,
 * so this is not `tests/helpers/bridge.ts::fakeClock`: that one has no
 * intervals. The intervals here are set an order of magnitude past anything a
 * case advances, which is the other way to keep them quiet - the clock is what
 * makes the *coalescing* window assertable.
 */
function testClock(start: number): TestClock {
  interface Entry {
    id: number
    at: number
    every: number
    cb: () => void
    cancelled: boolean
  }
  const entries: Entry[] = []
  let now = start
  let nextId = 1
  const arm = (cb: () => void, ms: number, every: number): ServiceTimerish => {
    const entry: Entry = { id: nextId, at: now + Math.max(0, ms), every, cb, cancelled: false }
    nextId += 1
    entries.push(entry)
    return {
      cancel: () => {
        entry.cancelled = true
      }
    }
  }
  return {
    timers: {
      after: (cb, ms) => arm(cb, ms, 0),
      every: (cb, ms) => arm(cb, ms, ms),
      now: () => now
    },
    advance(ms: number): void {
      const target = now + ms
      for (;;) {
        const due = entries
          .filter((entry) => !entry.cancelled && entry.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0]
        if (!due) break
        now = Math.max(now, due.at)
        // An interval re-arms from when it fired, not from when it was read.
        if (due.every > 0) due.at = now + due.every
        else due.cancelled = true
        due.cb()
      }
      now = target
    },
    now: () => now
  }
}

type ServiceTimerish = ReturnType<ServiceTimers['after']>

interface FakeSession extends SessionLike {
  /** Flip the bridge and tell the service, which is what a real reconnect does. */
  setOnline(online: boolean): void
  /** Push a snapshot the way a real bridge does after a reconnect. */
  pushSnapshot(snapshot: Snapshot): void
  /** herdr client methods actually invoked, in order. Empty unless recording. */
  readonly calls: ClientCall[]
}

/** One herdr client call, as the recording proxy saw it. */
interface ClientCall {
  method: string
  arg: unknown
}

/**
 * Planning a recovery is reading the world through a cached snapshot and one
 * statSync; *applying* one is what talks to herdr. A client that throws on
 * touch turns that boundary into a failure instead of a slow test.
 */
function throwingClient(): HerdrClientLike {
  return new Proxy({} as HerdrClientLike, {
    get(_target, prop): unknown {
      return (): never => {
        throw new Error(`planning recovery must not call herdr (tried ${String(prop)})`)
      }
    }
  }) as HerdrClientLike
}

/**
 * The other half: a client that answers the three calls a `lost` task's plan
 * makes, and remembers every call so a test can assert on what the unattended
 * pass actually did to herdr.
 */
function recordingClient(calls: ClientCall[]): HerdrClientLike {
  return new Proxy({} as HerdrClientLike, {
    get(_target, prop): unknown {
      return async (arg: unknown): Promise<unknown> => {
        calls.push({ method: String(prop), arg })
        if (prop === 'createWorkspace' || prop === 'createWorktree') {
          return {
            workspace: { workspaceId: 'w-new' },
            pane: { paneId: 'p-new' },
            worktree: { checkoutPath: '' }
          }
        }
        if (prop === 'startAgent' || prop === 'promptAgent') return { agentId: 'a-new' }
        return null
      }
    }
  }) as HerdrClientLike
}

interface FakeSessionOpts {
  /** What `start` and `refresh` hand back; null is "herdr has nothing". */
  snapshot?: Snapshot | null
  record?: boolean
}

function fakeSession(opts: FakeSessionOpts = {}): FakeSession {
  const listeners = new Set<(change: SessionChange) => void>()
  let online = false
  const calls: ClientCall[] = []
  const status = (): SessionStatus => ({
    phase: online ? 'live' : 'connecting',
    online,
    socketPath: SOCKET,
    version: online ? '0.9.0' : '',
    protocol: 1,
    error: online ? '' : 'connect ECONNREFUSED',
    events: 0,
    lastEventAt: 0,
    attempts: online ? 1 : 2,
    reconnectInMs: online ? 0 : 1000,
    subscribedPanes: 0
  })
  const client = opts.record ? recordingClient(calls) : throwingClient()
  const snapshot = opts.snapshot ?? null

  return {
    client,
    snapshot,
    status,
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async start() {
      return snapshot
    },
    stop() {},
    async refresh() {
      return snapshot
    },
    setOnline(next: boolean) {
      online = next
      const change: SessionChange = { type: 'status', status: status() }
      for (const listener of [...listeners]) listener(change)
    },
    pushSnapshot(next: Snapshot) {
      const change: SessionChange = { type: 'snapshot', snapshot: next }
      for (const listener of [...listeners]) listener(change)
    },
    calls
  }
}

/** Ledger with a tape: an import writes a line, and a task with no history is a task nobody can explain later. */
function fakeLedger(tape: LedgerInput[] = []): LedgerLike {
  return {
    entries: () => [],
    digest: () => null,
    allDigests: (taskIds) => {
      const out: Record<string, LedgerDigest | null> = {}
      for (const taskId of taskIds) out[taskId] = null
      return out
    },
    append: (input) => {
      tape.push(input)
      return null
    },
    invalidate: () => {}
  }
}

/** Companion with a tape: `announceText` is how an unattended pass speaks. */
function fakeCompanion(announced: string[] = []): CompanionLike {
  const push: ProCompanionPush = {
    notices: 0,
    expression: 'idle',
    counts: emptyCounts(),
    benchFocused: false,
    widgetVisible: false,
    announcing: '',
    at: START
  }
  const quiet: AnnounceResult = { summoned: false, spoke: false, bubbled: false, text: '' }
  return {
    announce: () => quiet,
    announceRecovery: () => '',
    announceText: (text: string) => {
      announced.push(text)
      return false
    },
    sync: () => push,
    clearAnnounce: () => {},
    dismissAll: () => {},
    shutdown: () => {},
    command: async () => okResult(null, '', ''),
    companionCommand: () => okResult(null, '', ''),
    state: () => push,
    badge: () => 0
  }
}

interface FakeHostOpts {
  lang?: 'zh' | 'en'
  /** `pro.autoResumeOnBoot`; the shipped default is on, so tests turn it off. */
  autoResumeOnBoot?: boolean
  /** What the companion can see on this machine; the import picker reads it. */
  threads?: readonly ThreadInfo[]
  /**
   * What the transcript reader answers, and the tape of what the bench asked
   * it to deliver. Absent transcript means "nothing on disk", which is a real
   * outcome the panel has to name rather than a test that forgot to stub.
   */
  transcript?: ChatTranscript | null
  steers?: string[]
  /** How the agent took the message; absent means it could not be reached. */
  steer?: SteerResult | null
  /** Window verbs the service asked for, in order. */
  calls?: string[]
}

function fakeHost(logs: string[], opts: FakeHostOpts = {}): ProHost {
  const config = {
    ...DEFAULT_CONFIG,
    pro: {
      ...DEFAULT_CONFIG.pro,
      autoResumeOnBoot: opts.autoResumeOnBoot ?? DEFAULT_CONFIG.pro.autoResumeOnBoot
    }
  }
  return {
    config: () => config,
    lang: () => opts.lang ?? 'en',
    emit: () => {},
    bubble: () => {},
    speak: () => {},
    speaking: () => false,
    setWidget: () => {},
    widgetVisible: () => false,
    benchFocused: () => false,
    setBadge: () => {},
    bubbleMs: () => 0,
    openBench: () => {
      opts.calls?.push('openBench')
    },
    openStage: () => {
      opts.calls?.push('openStage')
    },
    listThreads: async () => opts.threads ?? [],
    readTranscript: () => opts.transcript ?? null,
    steerThread: async (agent, threadId, message) => {
      opts.steers?.push(`${agent}:${threadId} ${message}`)
      return opts.steer ?? { ok: false, method: 'none', message: 'nobody is listening', reason: 'no-cli' }
    },
    pickDir: async () => '',
    openPath: () => {},
    openExternal: () => {},
    log: (level, message) => {
      logs.push(`${level}: ${message}`)
    }
  }
}

const herdrTarget = (): HerdrTarget => ({
  binaryPath: '/usr/bin/herdr',
  socketPath: SOCKET,
  session: '',
  childEnv: {},
  found: true,
  reason: 'ok',
  triedSockets: [SOCKET],
  triedBinaries: ['/usr/bin/herdr'],
  sessionsFound: []
})

/**
 * One task with no workspace, no pane and no session id: the shape a task has
 * after the machine it was created on went away, which is the shape the recovery
 * tab exists for. `resumeArgsFor` finds nothing to resume, so the verdict herdr
 * owes once it is back is `lost` - and the verdict it owes while it is down is
 * `offline`, which is a sentence about herdr and not about the task.
 */
function seedTask(): TaskRecord {
  return {
    id: TASK_ID,
    title: 'the task that outlived its pane',
    goal: 'prove a reconnect re-reads the recovery memo',
    workdir: WORKDIR,
    repoRoot: WORKDIR,
    branch: 'main',
    agentKind: 'codex',
    agentSessionId: '',
    agentSessionPath: '',
    workspaceId: '',
    paneIds: [],
    status: 'active',
    createdAt: START,
    updatedAt: START,
    parkedAt: 0,
    origin: 'created'
  }
}

/** One conversation as the companion sees it, key and all. */
function thread(agent: 'codex' | 'claude', id: string, cwd = IMPORT_DIR, title = ''): ThreadInfo {
  return {
    key: `${agent}:${id}`,
    agent,
    id,
    title,
    cwd,
    updatedAt: START,
    live: false,
    lastKind: '',
    lastDetail: '',
    steerable: false
  }
}

/**
 * One conversation as the transcript reader hands it over. The messages are the
 * point of the shape: a task with no pane has nothing else to show, so an empty
 * `messages` array here would let a panel that drops every line pass for one
 * that renders them.
 */
function chatTranscript(id = FREE, agent: 'codex' | 'claude' = 'codex'): ChatTranscript {
  return {
    key: `${agent}:${id}`,
    agent,
    id,
    title: 'the conversation the bench did not start',
    cwd: IMPORT_DIR,
    file: `/home/nobody/.codex/sessions/rollout-${id}.jsonl`,
    messages: [
      { id: `${agent}-0`, role: 'user', text: 'pick up where we left off', at: START },
      { id: `${agent}-1`, role: 'assistant', text: 'reading the tree now', at: START + 1000 }
    ],
    dropped: 0,
    mtimeMs: START,
    bytes: 2048,
    steerable: true
  }
}

/**
 * A git probe that cannot spawn anything. `importThreads` resolves the repo root
 * of the directory a conversation started in, so that answer has to come from a
 * probe rather than from whatever `git` happens to be on the runner's PATH; the
 * tree it feeds is grouped by repo, and a group that depends on the machine
 * running the test is a test that passes for the wrong reason.
 */
function fakeGit(clock: TestClock, roots: Record<string, string>): GitProbe {
  return new GitProbe({
    now: () => clock.now(),
    run: async (args, cwd) => {
      const root = roots[cwd] ?? ''
      if (root && args.includes('rev-parse')) return { code: 0, stdout: `${root}\n`, stderr: '' }
      return { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
    }
  })
}

interface Bench {
  service: ProService
  clock: TestClock
  session: FakeSession
  logs: string[]
  /** Every `announceText` the service sent, in order. */
  announced: string[]
  /** Window verbs the service asked the app for, in order. */
  calls: string[]
  /** Every ledger line written, so a case can ask what the task remembers. */
  ledgerTape: LedgerInput[]
  /** Every message the bench asked an agent to take, as `agent:id text`. */
  steers: string[]
  /** The registry the service was built on: what an import actually created. */
  registry: TaskRegistry
  /** How many times the plans were actually computed, memo misses only. */
  planAllCalls(): number
}

/**
 * The memo is the thing under test, so the count has to come from the `Recovery`
 * the service wired for itself - injecting our own would test a copy of that
 * wiring and quietly diverge from it. `planAll` is the only call the memo makes.
 */
function countPlanAll(recovery: Recovery): () => number {
  const real = recovery.planAll.bind(recovery)
  let calls = 0
  recovery.planAll = (
    tasks: readonly TaskRecord[],
    digests: Record<string, LedgerDigest | null>
  ): RecoveryPlan[] => {
    calls += 1
    return real(tasks, digests)
  }
  return () => calls
}

/**
 * Snapshots are built through the wire parser on purpose: a hand-written
 * `Snapshot` literal would drift from what herdr actually sends, and the boot
 * gate below is precisely about trusting a reconciled snapshot.
 */
function emptySnapshot(): Snapshot {
  return parseSnapshot({ version: '0.9.0', protocol: 1 }) as Snapshot
}

/** One live pane in one workspace: what herdr hands back when it restored us. */
function liveSnapshot(): Snapshot {
  return parseSnapshot({
    version: '0.9.0',
    protocol: 1,
    workspaces: [{ workspace_id: LIVE_WORKSPACE, number: 1, label: 'restored' }],
    panes: [
      {
        pane_id: LIVE_PANE,
        workspace_id: LIVE_WORKSPACE,
        tab_id: 'tab-1',
        cwd: WORKDIR,
        agent: 'codex'
      }
    ]
  }) as Snapshot
}

/** The same seeded task, but bound to a pane herdr already has. */
function liveTask(): TaskRecord {
  return { ...seedTask(), workspaceId: LIVE_WORKSPACE, paneIds: [LIVE_PANE] }
}

/** A second pane-less task, so a cap has something to leave behind. */
function otherTask(): TaskRecord {
  return {
    ...seedTask(),
    id: 't-proservice-2',
    title: 'the second task that outlived its pane',
    workdir: `${WORKDIR}-2`,
    repoRoot: `${WORKDIR}-2`
  }
}

interface BootOpts {
  tasks?: TaskRecord[]
  snapshot?: Snapshot | null
  /** Answer herdr calls instead of throwing on them. */
  record?: boolean
  lang?: 'zh' | 'en'
  autoResumeOnBoot?: boolean
  bootResumeMs?: number
  autoResumeMax?: number
  /** What `listThreads` answers; absent means the companion sees nothing. */
  threads?: readonly ThreadInfo[]
  /** What the transcript reader answers; absent means nothing on disk. */
  transcript?: ChatTranscript | null
  /** How the agent takes a message from the bench; absent means it cannot. */
  steer?: SteerResult | null
  /** Directory -> repo root for the fake probe. Absent keeps the service default. */
  gitRoots?: Record<string, string>
  /** Build the real companion bridge instead of the tape. */
  realCompanion?: boolean
}

async function boot(opts: BootOpts = {}): Promise<Bench> {
  const clock = testClock(START)
  const session = fakeSession({ snapshot: opts.snapshot ?? null, record: opts.record ?? false })
  const logs: string[] = []
  const announced: string[] = []
  const calls: string[] = []
  const ledgerTape: LedgerInput[] = []
  const steers: string[] = []
  const registry = new TaskRegistry({
    file: 'memory://bench.json',
    now: () => clock.now(),
    read: () => ({ version: 1, updatedAt: START, tasks: opts.tasks ?? [seedTask()] }),
    write: () => true
  })
  const service = new ProService({
    host: fakeHost(logs, {
      lang: opts.lang,
      autoResumeOnBoot: opts.autoResumeOnBoot,
      threads: opts.threads,
      transcript: opts.transcript,
      steer: opts.steer,
      steers,
      calls
    }),
    timers: clock.timers,
    // Intervals an order of magnitude past any advance below: the tick, the git
    // sweep and the hydrate would each rebuild the projection for a reason this
    // file cannot see, and a rebuild from nowhere is a green test lying.
    // `bootResumeMs` is parked out of the way for the same reason; the cases
    // that want the unattended pass ask for it explicitly.
    intervals: {
      tickMs: 60_000,
      gitMs: 60_000,
      hydrateMs: 60_000,
      pushMs: PUSH_MS,
      bootResumeMs: opts.bootResumeMs ?? 60_000,
      autoResumeMax: opts.autoResumeMax ?? 12
    },
    discover: () => herdrTarget(),
    registry,
    ledger: fakeLedger(ledgerTape),
    // The mode switch is a verb the real bridge owns, so the cases that send one
    // leave the factory out and let the service build it: a fake companion
    // answering `stage` would only tell us what the fake does.
    ...(opts.realCompanion ? {} : { companion: () => fakeCompanion(announced) }),
    // Same reasoning for git. Cases that never resolve a directory keep the
    // service default, which is the probe the shipped bench uses.
    ...(opts.gitRoots ? { git: fakeGit(clock, opts.gitRoots) } : {}),
    session: () => session
  })
  const planAllCalls = countPlanAll(service.recovery)
  await service.start()
  return {
    service,
    clock,
    session,
    logs,
    announced,
    calls,
    ledgerTape,
    steers,
    registry,
    planAllCalls
  }
}

/** Read the projection the way the window and `pro state` both do. */
function verdicts(bench: Bench): string[] {
  return (bench.service.view()?.recovery ?? []).map((plan) => plan.verdict)
}

/** Drain the microtasks behind an async timer callback (`advance` is sync). */
async function flush(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe('ProService', () => {
  it('plans recovery once per memo window while herdr stays down', async () => {
    const bench = await boot()
    expect(bench.service.view()?.herdr.online).toBe(false)
    expect(verdicts(bench)).toEqual(['offline'])
    expect(bench.planAllCalls()).toBe(1)

    // Still connecting, and the bridge says so again. The rebuild is free; the
    // statSync per task behind it is exactly what the memo is buying, so a fix
    // for the case below must not turn into "compute it every time".
    bench.session.setOnline(false)
    bench.clock.advance(PUSH_MS * 4)
    expect(verdicts(bench)).toEqual(['offline'])
    expect(bench.planAllCalls(), 'the memo stopped memoizing').toBe(1)
  })

  it('re-plans when herdr comes back inside the memo window', async () => {
    const bench = await boot()
    expect(verdicts(bench)).toEqual(['offline'])

    // The clock says the memo is still fresh, and it is: what went stale is the
    // fact it was computed under. One frame later the projection used to carry
    // both "herdr is online" and a plan that says herdr is not running.
    bench.session.setOnline(true)
    bench.clock.advance(PUSH_MS * 4)
    expect(bench.clock.now() - START).toBeLessThan(RECOVERY_TTL_MS)

    const view = bench.service.view()
    expect(view?.herdr.online).toBe(true)
    expect(verdicts(bench)).toEqual(['lost'])
    expect(bench.planAllCalls()).toBe(2)

    // And it is still a memo: nothing about the world moved, so nothing re-probes.
    bench.session.setOnline(true)
    bench.clock.advance(PUSH_MS * 4)
    expect(verdicts(bench)).toEqual(['lost'])
    expect(bench.planAllCalls()).toBe(2)
  })

  it('pushes the projection to a watcher, and null once the bench is gone', async () => {
    const bench = await boot()
    const seen: (ReturnType<ProService['view']>)[] = []
    const unsubscribe = bench.service.onChange((view) => seen.push(view))

    bench.session.setOnline(true)
    bench.clock.advance(PUSH_MS * 4)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.herdr.online).toBe(true)

    // A watcher that keeps printing the last tree after shutdown is describing a
    // world that no longer exists, so the last frame is the absence of one.
    bench.service.shutdown()
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBeNull()
    unsubscribe()
  })
})

/**
 * The unattended half of "open the app after a reboot and it is already
 * working". herdr restores its own panes and we adopt them; what nobody
 * restored is a task whose pane did not survive, and until now that task sat in
 * the recovery tab waiting for a click nobody was there to give.
 *
 * Every case below is about the two gates and the one ceiling, because an
 * automatic pass that starts agents is the one feature in this product where a
 * bug means a second agent in one worktree:
 *   gate 1  the bridge is online
 *   gate 2  a snapshot has been reconciled (a status event proves nothing
 *           about which panes exist)
 *   ceiling one pass per connection, at most `autoResumeMax` tasks, and only
 *           plans that are `actionable` - which is exactly "no live pane".
 */
describe('ProService boot auto-resume', () => {
  it('applies the pane-less plans once, without a hand, and says so', async () => {
    const bench = await boot({
      snapshot: emptySnapshot(),
      record: true,
      bootResumeMs: BOOT_RESUME_MS
    })
    expect(verdicts(bench)).toEqual(['offline'])

    bench.session.setOnline(true)
    expect(verdicts(bench)).toEqual(['lost'])

    // Still inside the settle window: nothing has been touched yet.
    bench.clock.advance(BOOT_RESUME_MS - 1)
    await flush()
    expect(bench.session.calls).toHaveLength(0)

    bench.clock.advance(1)
    await flush()
    expect(bench.session.calls.map((call) => call.method)).toEqual([
      'createWorkspace',
      'startAgent',
      'promptAgent'
    ])
    expect(bench.announced).toEqual(['resumed 1 interrupted task(s) on boot'])
    expect(bench.logs.some((line) => line.includes('boot auto-resume applied'))).toBe(true)

    // Once per connection, not once per tick: a service that re-applied the
    // plan on every rebuild would start a second agent in the same worktree.
    bench.clock.advance(5_000)
    await flush()
    expect(bench.session.calls).toHaveLength(3)
    expect(bench.announced).toHaveLength(1)
  })

  it('waits for a reconciled snapshot, not just a green connection', async () => {
    const bench = await boot({ record: true, bootResumeMs: BOOT_RESUME_MS })
    bench.session.setOnline(true)
    bench.clock.advance(BOOT_RESUME_MS * 4)
    await flush()
    expect(bench.session.calls).toHaveLength(0)
    expect(bench.announced).toHaveLength(0)
    // Still one click away, which is the correct place for it.
    expect(verdicts(bench)).toEqual(['lost'])
  })

  it('stays quiet when the knob is off', async () => {
    const bench = await boot({
      snapshot: emptySnapshot(),
      record: true,
      bootResumeMs: BOOT_RESUME_MS,
      autoResumeOnBoot: false
    })
    bench.session.setOnline(true)
    bench.clock.advance(BOOT_RESUME_MS * 4)
    await flush()
    expect(bench.session.calls).toHaveLength(0)
    expect(bench.announced).toHaveLength(0)
    expect(verdicts(bench)).toEqual(['lost'])
  })

  it('never touches a task whose pane came back', async () => {
    const bench = await boot({
      tasks: [liveTask()],
      snapshot: liveSnapshot(),
      record: true,
      bootResumeMs: BOOT_RESUME_MS
    })
    bench.session.setOnline(true)
    bench.clock.advance(BOOT_RESUME_MS * 4)
    await flush()
    expect(verdicts(bench)).toEqual(['intact'])
    expect(bench.session.calls).toHaveLength(0)
    expect(bench.announced).toHaveLength(0)
  })

  it('caps the batch and names what is left for a click', async () => {
    const bench = await boot({
      tasks: [seedTask(), otherTask()],
      snapshot: emptySnapshot(),
      record: true,
      bootResumeMs: BOOT_RESUME_MS,
      autoResumeMax: 1
    })
    bench.session.setOnline(true)
    bench.clock.advance(BOOT_RESUME_MS)
    await flush()
    expect(bench.session.calls).toHaveLength(3)
    expect(bench.announced).toEqual([
      'resumed 1 interrupted task(s) on boot; 1 more need a click in Recovery'
    ])
    // The deferred task is still on the list, still actionable.
    expect(verdicts(bench)).toEqual(['lost', 'lost'])
  })

  it('announces in the language the companion speaks', async () => {
    const bench = await boot({
      snapshot: emptySnapshot(),
      record: true,
      bootResumeMs: BOOT_RESUME_MS,
      lang: 'zh'
    })
    bench.session.setOnline(true)
    bench.clock.advance(BOOT_RESUME_MS)
    await flush()
    expect(bench.announced).toEqual(['开机已自动恢复 1 个中断的任务'])
  })

  it('a herdr restart earns exactly one more unattended attempt', async () => {
    const bench = await boot({
      snapshot: emptySnapshot(),
      record: true,
      bootResumeMs: BOOT_RESUME_MS
    })
    bench.session.setOnline(true)
    bench.clock.advance(BOOT_RESUME_MS)
    await flush()
    expect(bench.session.calls).toHaveLength(3)

    // The bridge drops and comes back: from the bench's side that is another
    // boot, so it gets another pass - but only once the snapshot lands.
    bench.session.setOnline(false)
    bench.session.setOnline(true)
    bench.clock.advance(BOOT_RESUME_MS * 4)
    await flush()
    expect(bench.session.calls, 'a status event is not a boot').toHaveLength(3)

    bench.session.pushSnapshot(emptySnapshot())
    bench.clock.advance(BOOT_RESUME_MS)
    await flush()
    expect(bench.session.calls).toHaveLength(6)
    expect(bench.announced).toHaveLength(2)
  })
})

/* ------------------------------------------------------------------ *
 * Import: the tree's other door
 * ------------------------------------------------------------------ */

/**
 * The tree lists the bench's own tasks, grouped by the directory they run in.
 * Importing is the other way in: conversations Codex and Claude Code already
 * have on this machine, which the companion can see and the bench cannot.
 *
 * What is worth pinning is the three places this could quietly lie, because all
 * three are visible to a human as a row that does not do what it says:
 *
 *   claimed  a session a task already carries must not become a second row,
 *            since only one of the two could ever be resumed;
 *   parked   the conversation is running in a terminal the bench does not own,
 *            and an active task with no pane is exactly what the Recovery tab
 *            calls `lost` - importing one would be a crash we caused ourselves;
 *   re-parked `attach` is the honest way to want it working now, but herdr may
 *            be down, and a failed attach must not leave the active-and-unbound
 *            task behind.
 */
describe('ProService import', () => {
  it('lists what the companion sees and marks the session a task already claims', async () => {
    const bench = await boot({
      tasks: [seedTask(), { ...seedTask(), id: 't-claim', agentSessionId: CLAIMED }],
      threads: [
        thread('codex', FREE, IMPORT_DIR, 'a conversation nobody owns'),
        thread('codex', CLAIMED, IMPORT_DIR, 'already a task'),
        thread('claude', 'c-1', IMPORT_DIR)
      ]
    })

    const result = await bench.service.hostOp({ op: 'threads' })
    expect(result.code).toBe('threads')
    const rows = ((result.data as { threads: ImportCandidate[] } | null)?.threads ?? []).map(
      (row) => [row.key, row.taskId]
    )
    expect(rows).toEqual([
      [`codex:${FREE}`, ''],
      [`codex:${CLAIMED}`, 't-claim'],
      ['claude:c-1', '']
    ])
  })

  it('imports a session as a parked task, in the directory it was started in', async () => {
    const bench = await boot({
      threads: [thread('codex', FREE, IMPORT_DIR, 'refactor the socket layer')],
      gitRoots: { [IMPORT_DIR]: IMPORT_ROOT }
    })

    const result = await bench.service.taskOp({
      op: 'import',
      keys: [`codex:${FREE}`],
      attach: false
    })
    expect(result.ok).toBe(true)
    expect(result.code).toBe('imported')
    const data = result.data as { imported: number; attached: number; skipped: string[] }
    expect([data.imported, data.attached, data.skipped]).toEqual([1, 0, []])

    const created = bench.registry.tasks().find((task) => task.id !== TASK_ID)
    expect(created?.status, 'an import is not ours to run yet').toBe('parked')
    expect(created?.origin).toBe('imported')
    expect(created?.title).toBe('refactor the socket layer')
    expect(created?.workdir).toBe(IMPORT_DIR)
    // The tree groups by repo, so the root is resolved at import time and not
    // guessed from the cwd later.
    expect(created?.repoRoot).toBe(IMPORT_ROOT)
    expect(created?.agentKind).toBe('codex')
    expect(created?.agentSessionId).toBe(FREE)

    // And it is on the map: the projection the window renders, not just the file.
    expect(bench.service.view()?.tasks).toHaveLength(2)
    expect(bench.ledgerTape.map((entry) => entry.text)).toContain(
      `imported codex:${FREE} from the companion`
    )
  })

  it('refuses a session a task already claims', async () => {
    const bench = await boot({
      tasks: [{ ...seedTask(), agentSessionId: CLAIMED }],
      threads: [thread('codex', CLAIMED, IMPORT_DIR)]
    })

    const result = await bench.service.taskOp({
      op: 'import',
      keys: [`codex:${CLAIMED}`],
      attach: false
    })
    // The picker marks a claimed row so it cannot be chosen; this is the second
    // gate, for the caller that did not go through the picker (`pro import`).
    expect(result.ok).toBe(false)
    expect(result.code).toBe('nothing-to-do')
    expect(bench.registry.tasks()).toHaveLength(1)
  })

  it('names what it skipped: an aged-out key and a directory that is gone', async () => {
    const bench = await boot({
      threads: [thread('codex', FREE, IMPORT_DIR), thread('codex', 'ghost', WORKDIR)]
    })

    const result = await bench.service.taskOp({
      op: 'import',
      keys: [`codex:${FREE}`, 'codex:aged-out', 'codex:ghost'],
      attach: false
    })
    expect(result.code).toBe('imported')
    const data = result.data as { imported: number; skipped: string[] }
    expect(data.imported).toBe(1)
    // A silent skip is a click that appears to have done nothing, so the
    // refusal carries the keys it dropped.
    expect(data.skipped).toEqual(['codex:aged-out', 'codex:ghost'])
  })

  it('parks the task again when attach cannot reach herdr', async () => {
    const bench = await boot({ threads: [thread('codex', FREE, IMPORT_DIR)] })

    const result = await bench.service.taskOp({
      op: 'import',
      keys: [`codex:${FREE}`],
      attach: true
    })
    expect(result.ok).toBe(true)
    expect(result.code).toBe('imported-attached')
    const data = result.data as { imported: number; attached: number }
    expect([data.imported, data.attached]).toEqual([1, 0])

    const created = bench.registry.tasks().find((task) => task.id !== TASK_ID)
    expect(
      created?.status,
      'a failed attach must not leave an active task with no pane behind'
    ).toBe('parked')
    expect(created?.agentSessionId).toBe(FREE)
  })
})

/**
 * The conversation of a task the bench has no terminal for.
 *
 * Import creates a parked task pointing at a session that is still running in
 * the human's own console: herdr has no pane for it, so the centre column would
 * otherwise be its honest-but-useless "no panes", and the imported work reads as
 * lost. The transcript the agent writes for itself is the other source of truth
 * - the same file the stage reads - and `steer` is the only way to answer a
 * terminal we do not own, so both go through the host and neither invents a
 * delivery it cannot prove.
 */
describe('ProService conversation', () => {
  it('reads the transcript of an imported task, which has no pane to draw', async () => {
    const bench = await boot({
      tasks: [{ ...seedTask(), paneIds: [], agentSessionId: FREE, origin: 'imported' }],
      transcript: chatTranscript()
    })

    const result = await bench.service.taskOp({
      op: 'transcript',
      taskId: TASK_ID,
      limit: 240,
      fresh: true
    })
    expect(result.ok).toBe(true)
    expect(result.code).toBe('transcript')
    const transcript = result.data as ChatTranscript
    expect(transcript.id).toBe(FREE)
    expect(transcript.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  it('separates "no session yet" from "the file is gone"', async () => {
    // The two ask for different actions: one is a task that has not spoken, the
    // other is a conversation that ran somewhere this machine cannot see.
    const silent = await boot({ tasks: [{ ...seedTask(), agentSessionId: '' }] })
    const noSession = await silent.service.taskOp({
      op: 'transcript',
      taskId: TASK_ID,
      limit: 240,
      fresh: true
    })
    expect(noSession.code).toBe('no-session')

    const missing = await boot({ tasks: [{ ...seedTask(), agentSessionId: FREE }] })
    const noFile = await missing.service.taskOp({
      op: 'transcript',
      taskId: TASK_ID,
      limit: 240,
      fresh: true
    })
    expect(noFile.code).toBe('no-transcript')
  })

  it('refuses to read a session whose agent it cannot parse', async () => {
    // `agentKind` is free text in the registry; a reader handed `unknown` would
    // have to guess a directory, and guessing is how one agent's conversation
    // ends up rendered as another's.
    const bench = await boot({
      tasks: [{ ...seedTask(), agentKind: 'aider', agentSessionId: FREE }],
      transcript: chatTranscript()
    })
    const result = await bench.service.taskOp({
      op: 'transcript',
      taskId: TASK_ID,
      limit: 240,
      fresh: true
    })
    expect(result.code).toBe('no-session')
  })

  it('answers the session through steer, and writes the human into the ledger', async () => {
    const bench = await boot({
      tasks: [{ ...seedTask(), agentSessionId: FREE }],
      steer: { ok: true, method: 'queue', message: 'queued for codex', reason: 'sent' }
    })

    const result = await bench.service.taskOp({ op: 'steer', taskId: TASK_ID, message: 'ship it' })
    expect(result.ok).toBe(true)
    expect(result.code).toBe('steered')
    // Never a keystroke into a pane we do not own: the host verb is the queue.
    expect(bench.steers).toEqual([`codex:${FREE} ship it`])
    const notes = bench.ledgerTape.filter((entry) => entry.kind === 'note')
    expect(notes.map((entry) => entry.text)).toContain('ship it')
  })

  it('reports a clipboard delivery as a copy, not as a send', async () => {
    // Claude has no injection API. Saying "sent" would be a lie the human
    // discovers only after waiting on an agent that never saw the message.
    const bench = await boot({
      tasks: [{ ...seedTask(), agentKind: 'claude', agentSessionId: FREE }],
      steer: { ok: true, method: 'clipboard', message: 'on your clipboard', reason: 'clipboard' }
    })

    const result = await bench.service.taskOp({ op: 'steer', taskId: TASK_ID, message: 'paste me' })
    expect(result.code).toBe('copied')
    expect(bench.steers).toEqual([`claude:${FREE} paste me`])
  })

  it('says so when the agent could not be reached', async () => {
    const bench = await boot({ tasks: [{ ...seedTask(), agentSessionId: FREE }] })

    const result = await bench.service.taskOp({ op: 'steer', taskId: TASK_ID, message: 'anyone there' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('steer-failed')
  })
})

/**
 * One app, two modes. "Take me back to her" puts the bench window away and
 * brings the stage forward; it is not a quit, so the projection has to survive
 * the switch - the badge keeps counting and the widget keeps reading the fleet
 * while the stage is what the human looks at.
 */
describe('ProService mode switch', () => {
  it('hands the screen back to the stage without closing the bench', async () => {
    const bench = await boot({ realCompanion: true })
    expect(bench.calls).toEqual([])

    const result = bench.service.companionOp({ op: 'stage' })
    expect(result.ok).toBe(true)
    expect(result.code).toBe('stage')
    // The focused window verb, and not `openBench`: the bench is the window
    // being put away here.
    expect(bench.calls).toEqual(['openStage'])
    expect(bench.service.view()?.tasks).toHaveLength(1)
  })
})

/**
 * What a typed path means. The new-task form's directory field is the one input
 * in the product a human types as a path, so it gets typed like one: `~` and a
 * blank field both mean home. Expanding that is main's job and not the
 * renderer's, because main is the layer that knows whose home it is - and the
 * registry stores an absolute path either way, since a `~` in bench.json is a
 * path only the machine that wrote it could read back.
 */
describe('ProService task paths', () => {
  const HOME = os.homedir()

  function create(workdir: string): ProTaskRequest {
    return {
      op: 'create',
      title: 'from a typed path',
      goal: '',
      workdir,
      branch: '',
      base: '',
      worktree: false,
      agent: '',
      start: false,
      prompt: ''
    }
  }

  it('reads blank and ~ as home, and a real path as itself', () => {
    expect(resolveWorkdir('', HOME)).toBe(HOME)
    expect(resolveWorkdir('   ', HOME)).toBe(HOME)
    expect(resolveWorkdir('~', HOME)).toBe(HOME)
    expect(resolveWorkdir('~/', HOME)).toBe(HOME)
    expect(resolveWorkdir('~/src/app', HOME)).toBe(`${HOME}/src/app`)
    expect(resolveWorkdir('/work/app', HOME)).toBe('/work/app')
    // Somebody else's home is not ours to guess, so it stays literal and fails
    // the directory check like any other path that is not there.
    expect(resolveWorkdir('~root/src', HOME)).toBe('~root/src')
  })

  it('expands against a Windows home without mixing the separators', () => {
    expect(resolveWorkdir('~', 'C:\\Users\\u')).toBe('C:\\Users\\u')
    expect(resolveWorkdir('~/src/app', 'C:\\Users\\u')).toBe('C:\\Users\\u\\src\\app')
    expect(resolveWorkdir('~\\src', 'C:\\Users\\u')).toBe('C:\\Users\\u\\src')
  })

  it('leaves the tilde alone when there is no home to expand it against', () => {
    expect(resolveWorkdir('~/src', '')).toBe('~/src')
    expect(resolveWorkdir('', '')).toBe('')
  })

  it('creates the task in home when the form sent the default', async () => {
    const bench = await boot({ tasks: [], gitRoots: {} })

    const result = await bench.service.taskOp(create('~'))
    expect(result.ok).toBe(true)

    const created = bench.registry.tasks()[0]
    expect(created?.workdir).toBe(HOME)
    // Home is not a repository, so it groups under itself rather than under
    // nothing: the tree's spine is directories and this one is real.
    expect(created?.repoRoot).toBe(HOME)
    expect(bench.service.view()?.tasks).toHaveLength(1)
  })

  it('still refuses a path the expansion made absolute but not real', async () => {
    const bench = await boot({ tasks: [], gitRoots: {} })

    const result = await bench.service.taskOp(create('~/.codewaifu-no-such-dir'))
    expect(result.ok).toBe(false)
    expect(result.code).toBe('no-dir')
    expect(bench.registry.tasks()).toHaveLength(0)
  })
})
