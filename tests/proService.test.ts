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
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/shared/config'
import { emptyCounts, type LedgerDigest, type RecoveryPlan, type TaskRecord } from '../src/shared/pro'
import { okResult, type ProCompanionPush } from '../src/shared/proIpc'
import { parseSnapshot, type Snapshot } from '../src/shared/herdr'
import { TaskRegistry } from '../src/main/pro/bench'
import type { AnnounceResult } from '../src/main/pro/companion'
import type { HerdrTarget } from '../src/main/pro/herdr/discovery'
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

function fakeLedger(): LedgerLike {
  return {
    entries: () => [],
    digest: () => null,
    allDigests: (taskIds) => {
      const out: Record<string, LedgerDigest | null> = {}
      for (const taskId of taskIds) out[taskId] = null
      return out
    },
    append: () => null,
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
    openBench: () => {},
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
    parkedAt: 0
  }
}

interface Bench {
  service: ProService
  clock: TestClock
  session: FakeSession
  logs: string[]
  /** Every `announceText` the service sent, in order. */
  announced: string[]
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
}

async function boot(opts: BootOpts = {}): Promise<Bench> {
  const clock = testClock(START)
  const session = fakeSession({ snapshot: opts.snapshot ?? null, record: opts.record ?? false })
  const logs: string[] = []
  const announced: string[] = []
  const registry = new TaskRegistry({
    file: 'memory://bench.json',
    now: () => clock.now(),
    read: () => ({ version: 1, updatedAt: START, tasks: opts.tasks ?? [seedTask()] }),
    write: () => true
  })
  const service = new ProService({
    host: fakeHost(logs, { lang: opts.lang, autoResumeOnBoot: opts.autoResumeOnBoot }),
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
    ledger: fakeLedger(),
    companion: () => fakeCompanion(announced),
    session: () => session
  })
  const planAllCalls = countPlanAll(service.recovery)
  await service.start()
  return { service, clock, session, logs, announced, planAllCalls }
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
