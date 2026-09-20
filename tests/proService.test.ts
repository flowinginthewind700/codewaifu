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
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type ProConfig } from '../src/shared/config'
import { normalizeHook } from '../src/shared/hookEvent'
import {
  emptyCounts,
  pathBase,
  resolveWorkdir,
  type LedgerDigest,
  type RecoveryPlan,
  type TaskRecord
} from '../src/shared/pro'
import {
  okResult,
  type ImportCandidate,
  type ProAgentsData,
  type ProBridgePush,
  type ProCompanionPush,
  type ProNoticePush,
  type ProSessionOpened,
  type ProSshProbe,
  type ProSshRoster,
  type ProSshSetup,
  type ProTaskCreated,
  type ProTaskRequest
} from '../src/shared/proIpc'
import {
  agentName,
  parseAgentInstance,
  parseSnapshot,
  SCROLL_EVENT,
  type AgentInstance,
  type HerdrEvent,
  type Snapshot
} from '../src/shared/herdr'
import { IPC } from '../src/shared/ipcChannels'
import type { ChatTranscript } from '../src/shared/chat'
import type { SteerResult, ThreadInfo } from '../src/shared/protocol'
import { FORGOTTEN_TTL_MS, TaskRegistry, type RegistryFile } from '../src/main/pro/bench'
import type { AnnounceResult } from '../src/main/pro/companion'
import { GitProbe } from '../src/main/pro/git'
import type { HerdrTarget } from '../src/main/pro/herdr/discovery'
import type { LedgerInput } from '../src/main/pro/ledger'
import type { SessionChange, SessionStatus } from '../src/main/pro/herdr/session'
import type { Recovery } from '../src/main/pro/recovery'
import { SshService, type MachinesFile } from '../src/main/pro/ssh'
import { makeMachine, type SshMachine } from '../src/shared/ssh'
import {
  ProService,
  unionAgentKinds,
  type CompanionLike,
  type HerdrClientLike,
  type LedgerLike,
  type ProHost,
  type ServiceTimers,
  type SessionLike
} from '../src/main/pro/service'
import { fakeSpawner, type FakeSpawner } from './helpers/bridge'

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
  /**
   * One subscription event, exactly as the socket delivered it. Scroll and
   * agent status both arrive this way, and only one of them is allowed to
   * leave the projection untouched.
   */
  pushEvent(event: HerdrEvent): void
  /** herdr client methods actually invoked, in order. Empty unless recording. */
  readonly calls: ClientCall[]
}

/** One herdr client call, as the recording proxy saw it. */
interface ClientCall {
  method: string
  arg: unknown
  /**
   * Every argument, because the interesting one is not always first: a typed
   * line arrives as `sendText(paneId, text)`, and asserting on `arg` alone would
   * only ever prove that a pane was addressed.
   */
  args: unknown[]
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
function recordingClient(
  calls: ClientCall[],
  closeOk = true,
  agents: readonly AgentInstance[] = [],
  startAgentError = ''
): HerdrClientLike {
  return new Proxy({} as HerdrClientLike, {
    get(_target, prop): unknown {
      return async (...args: unknown[]): Promise<unknown> => {
        calls.push({ method: String(prop), arg: args[0], args })
        // A session pane is typed into, and typing is the whole of what `connect`
        // and `setup` do once the pane exists: answering null here would turn
        // every ssh case into the "herdr refused the input" case.
        if (prop === 'sendText' || prop === 'sendKeys') return true
        // The picker reads "what is running" from here. Answered from the option
        // instead of falling through to null, because `listAgents` promises an
        // array and a null is the fake lying about the interface.
        if (prop === 'listAgents') return [...agents]
        // Closing is a boolean, and the honest default is "yes": a herdr that
        // always refused would make every removal case a refusal case. The
        // cases that want a refusal say so through `closeOk`.
        if (prop === 'closeWorkspace') return closeOk
        if (prop === 'createWorkspace' || prop === 'createWorktree') {
          return {
            workspace: { workspaceId: 'w-new' },
            pane: { paneId: 'p-new' },
            worktree: { checkoutPath: '' }
          }
        }
        // herdr validating an agent name is the one refusal a case can ask for
        // by name: it is the failure the bench used to swallow whole.
        if (prop === 'startAgent' && startAgentError) throw new Error(startAgentError)
        if (prop === 'startAgent' || prop === 'promptAgent') return { agentId: 'a-new' }
        // An absolute scroll answers with the pane it moved, and the number the
        // bench shows is herdr's own post-scroll offsets rather than the one we
        // asked for. That is the whole reason `scrollBottom` reads the reply:
        // assuming the request stuck is how a chip ends up lying about a pane.
        if (prop === 'scrollPane') {
          return {
            paneId: String(args[0]),
            scroll: { offsetFromBottom: 0, maxOffsetFromBottom: 412, viewportRows: 24 }
          }
        }
        return null
      }
    }
  }) as HerdrClientLike
}

interface FakeSessionOpts {
  /** What `start` and `refresh` hand back; null is "herdr has nothing". */
  snapshot?: Snapshot | null
  record?: boolean
  /** What the recorded client answers `closeWorkspace` with. */
  closeOk?: boolean
  /** What it answers `listAgents` with: herdr's live instances. */
  agents?: readonly AgentInstance[]
  /** What it refuses `startAgent` with; absent means it accepts the name. */
  startAgentError?: string
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
  const client = opts.record
    ? recordingClient(calls, opts.closeOk ?? true, opts.agents ?? [], opts.startAgentError ?? '')
    : throwingClient()
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
    pushEvent(event: HerdrEvent) {
      const change: SessionChange = { type: 'event', event }
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
  /**
   * Overrides for the rest of `pro.*`. The shipped defaults are the ones every
   * other case runs under, so a case that needs a muted bench says so here
   * rather than editing a default it does not own.
   */
  pro?: Partial<ProConfig>
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
  /** Every main -> renderer push, as `{channel, payload}`; absent drops them. */
  emits?: Array<{ channel: string; payload: unknown }>
}

function fakeHost(logs: string[], opts: FakeHostOpts = {}): ProHost {
  const config = {
    ...DEFAULT_CONFIG,
    pro: {
      ...DEFAULT_CONFIG.pro,
      autoResumeOnBoot: opts.autoResumeOnBoot ?? DEFAULT_CONFIG.pro.autoResumeOnBoot,
      ...opts.pro
    }
  }
  return {
    config: () => config,
    lang: () => opts.lang ?? 'en',
    emit: (channel, payload) => {
      opts.emits?.push({ channel, payload })
    },
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

/** A fake home, so `keys()` and `~` expansion have somewhere to point at. */
const SSH_HOME = '/home/nobody'
/** The box this file connects to: the real one the ssh work was verified against. */
const UBUNTU = 'wanlian@172.18.29.206:2222'

interface FakeSshOpts {
  /** Machines already pinned in the store the service reads and writes. */
  saved?: SshMachine[]
  /** What `~/.ssh/config` says; absent means there is no config file. */
  config?: string
  /** Filenames in `~/.ssh`; absent means a box with no keypair at all. */
  keys?: string[]
  /** What the probe's `ssh` exits with. Absent means a key-auth host: exit 0. */
  probe?: { code: number; stdout?: string; stderr?: string; timedOut?: boolean }
  /** Every child the service spawned, as argv. Nothing is really executed. */
  runs?: string[][]
  /** Flip to false and the store refuses every write, like a read-only disk. */
  writable?: boolean
}

/**
 * The roster with all three of its impure edges injected: the machines file is a
 * closure rather than `~/.config/codewaifu/machines.json`, `~/.ssh` is a list of
 * names rather than a directory, and the probe is an exit code rather than a
 * child process. Without this the suite would read the developer's own
 * `~/.ssh/config` and spawn a real `ssh` at whatever host it found there, which
 * is a test whose result depends on the machine running it.
 */
function fakeSsh(opts: FakeSshOpts = {}): SshService {
  let store: MachinesFile = { version: 1, updatedAt: START, machines: opts.saved ?? [] }
  let nextId = 0
  return new SshService({
    file: 'memory://machines.json',
    home: SSH_HOME,
    sshConfigPath: `${SSH_HOME}/.ssh/config`,
    platform: 'posix',
    now: () => START,
    newId: () => `m${(nextId += 1)}`,
    read: () => store,
    write: (_file, value) => {
      if (opts.writable === false) return false
      store = value as MachinesFile
      return true
    },
    readFile: (file) => (file === `${SSH_HOME}/.ssh/config` ? (opts.config ?? null) : null),
    listDir: (dir) => (dir === `${SSH_HOME}/.ssh` ? (opts.keys ?? []) : []),
    run: async (cmd, args) => {
      opts.runs?.push([cmd, ...args])
      const probe = opts.probe ?? { code: 0 }
      return {
        code: probe.code,
        stdout: probe.stdout ?? '',
        stderr: probe.stderr ?? '',
        timedOut: probe.timedOut ?? false
      }
    }
  })
}

/** The lines a session typed into its pane, in order, without the keystrokes. */
function typedLines(bench: Bench): unknown[] {
  return bench.session.calls.filter((call) => call.method === 'sendText').map((call) => call.args[1])
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
  /** Every push the service sent the window, in order. */
  emits: Array<{ channel: string; payload: unknown }>
  /** Terminal children the service spawned; stays empty without `terminal`. */
  spawner: FakeSpawner
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
  /** With `record`, what `closeWorkspace` answers. */
  closeOk?: boolean
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
  /** The ssh roster the connect palette reads. Absent builds the real one. */
  ssh?: SshService
  /**
   * Spawn a fake `herdr terminal session control` child instead of the real
   * binary. Only the cases that attach a pane want one, and the default has to
   * stay "no spawner injected" so a case that reaches a real spawn by accident
   * fails instead of quietly talking to a fake.
   */
  terminal?: boolean
  /** Which CLIs the fake binary probe finds; absent means this machine has none. */
  binaries?: readonly string[]
  /** What the fake herdr answers `agent.list` with. Needs `record`. */
  agents?: readonly AgentInstance[]
  /** What the fake herdr refuses `agent.start` with; absent means it accepts. */
  startAgentError?: string
  /** Overrides for `pro.*`; see `FakeHostOpts.pro`. */
  pro?: Partial<ProConfig>
}

async function boot(opts: BootOpts = {}): Promise<Bench> {
  const clock = testClock(START)
  const session = fakeSession({
    snapshot: opts.snapshot ?? null,
    record: opts.record ?? false,
    closeOk: opts.closeOk,
    agents: opts.agents,
    startAgentError: opts.startAgentError
  })
  const logs: string[] = []
  const announced: string[] = []
  const calls: string[] = []
  const emits: Array<{ channel: string; payload: unknown }> = []
  const spawner = fakeSpawner()
  const ledgerTape: LedgerInput[] = []
  const steers: string[] = []
  const installed = opts.binaries ?? []
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
      calls,
      emits,
      pro: opts.pro
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
    // Which agent CLIs are installed is a fact about the machine running the
    // test, so the picker's probe is faked the way `git` and `ssh` are: a case
    // that passed here and failed on a laptop without `claude` would have been
    // testing the developer's PATH.
    findBinary: async (name) => (installed.includes(name) ? `/usr/bin/${name}` : null),
    registry,
    ledger: fakeLedger(ledgerTape),
    // The mode switch is a verb the real bridge owns, so the cases that send one
    // leave the factory out and let the service build it: a fake companion
    // answering `stage` would only tell us what the fake does.
    ...(opts.realCompanion ? {} : { companion: () => fakeCompanion(announced) }),
    // Same reasoning for git. Cases that never resolve a directory keep the
    // service default, which is the probe the shipped bench uses.
    ...(opts.gitRoots ? { git: fakeGit(clock, opts.gitRoots) } : {}),
    ...(opts.ssh ? { ssh: opts.ssh } : {}),
    ...(opts.terminal ? { spawn: spawner.spawn } : {}),
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
    emits,
    spawner,
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

/* ------------------------------------------------------------------ *
 * Who announces a hook
 * ------------------------------------------------------------------ */

/**
 * The claim is one line in `index.ts`, and it decides whether the legacy
 * companion still gets to speak for a hook Pro has already judged. `onHook`
 * returning null used to read as "Pro has nothing to say", so the event fell
 * through to `planEvent` and its phrase table - which for a `Stop` is the
 * "done" line. A task the human had marked done therefore announced its own
 * finish again on every turn, and the reason is the cruel part: the verdict
 * that silenced the bench is exactly the verdict the phrase table cannot know
 * about. Marking a task done bought silence from one voice and repeats from
 * the other.
 *
 * So the claim covers the kinds triage models as a need, spoken or not, and
 * leaves the ambient ones alone: claiming `tool` and the greetings would take
 * away her chatter without putting anything in its place.
 */
describe('ProService hook claim', () => {
  it('claims the stop of a task the human already closed, and stays silent', async () => {
    const bench = await boot({ tasks: [{ ...seedTask(), status: 'done' }] })
    const event = normalizeHook(
      'codex',
      {
        hook_event_name: 'Stop',
        session_id: 'sess-done',
        cwd: WORKDIR,
        last_assistant_message: 'all tests pass'
      },
      START
    )
    // Triage declined: `review` defers to the verdict, and the verdict is done.
    expect(bench.service.onHook(event)).toBeNull()
    // Declining is still an answer, so the legacy voice must not repeat it.
    expect(bench.service.claimsEvent(event)).toBe(true)
  })

  it('claims the kinds that carry a verdict, and leaves the ambient ones alone', async () => {
    const bench = await boot()
    const ours = ['Stop', 'PermissionRequest', 'Notification']
    for (const raw of ours) {
      const event = normalizeHook(
        'codex',
        { hook_event_name: raw, session_id: 'sess-1', cwd: WORKDIR },
        START
      )
      expect(bench.service.claimsEvent(event), raw).toBe(true)
    }

    // Everything here is activity or greeting. Pro records it and says nothing,
    // so claiming one would be a mute button wearing a verdict's clothes.
    const hers = [
      'SessionStart',
      'SessionEnd',
      'UserPromptSubmit',
      'PreToolUse',
      'PreCompact',
      'SubagentStop',
      'Interrupt'
    ]
    for (const raw of hers) {
      const event = normalizeHook(
        'codex',
        { hook_event_name: raw, session_id: 'sess-1', cwd: WORKDIR },
        START
      )
      expect(bench.service.claimsEvent(event), raw).toBe(false)
    }
  })

  it('hands every hook back when both ambient channels are muted', async () => {
    // Muting is a setting, not a judgement about the task. With nothing of ours
    // left to say it, the event belongs to the companion again rather than to
    // nobody: a bench the human silenced should not silence her too.
    const bench = await boot({ pro: { speakAttention: false, bubbleAttention: false } })
    const event = normalizeHook(
      'codex',
      { hook_event_name: 'Stop', session_id: 'sess-1', cwd: WORKDIR },
      START
    )
    expect(bench.service.announcesAttention()).toBe(false)
    expect(bench.service.claimsEvent(event)).toBe(false)
  })

  it('hands every hook back once the bench is gone', async () => {
    const bench = await boot()
    const event = normalizeHook(
      'codex',
      { hook_event_name: 'Stop', session_id: 'sess-1', cwd: WORKDIR },
      START
    )
    bench.service.shutdown()
    expect(bench.service.claimsEvent(event)).toBe(false)
  })
})

/* ------------------------------------------------------------------ *
 * Which task a hook belongs to
 * ------------------------------------------------------------------ */

/**
 * The complaint behind this block: a task the human had marked done kept
 * announcing its own finish, and marking it read bought two minutes at a time.
 *
 * Triage has a gate for exactly that - `review` defers to the verdict - and the
 * gate was never reached. A hook payload carries a session id and a cwd but no
 * pane, three tasks shared one checkout here, so the cwd match landed on
 * whichever task the registry held first. The Stop from the finished task's
 * terminal resolved onto a live one, the gate saw `active` and waved it
 * through, and the finish was announced under a task that was still working.
 * The task that actually finished kept silent in its own ledger: not one hook
 * row was ever recorded against it.
 *
 * `recordHook` made it worse than a misfiled announcement. It wrote the session
 * id from that same guess, and a session id used to outrank a pane, so the wrong
 * binding then won every later hook on its own authority - and the poisoned id
 * is why the fix reorders the match instead of merely adding the pane to it.
 */
describe('ProService hook attribution', () => {
  /** Two tasks, one directory: the shape a cwd cannot resolve. */
  function sharedCheckout(): TaskRecord[] {
    return [
      {
        ...seedTask(),
        id: 't-live',
        title: 'the one still running',
        paneIds: ['w2:p1'],
        workspaceId: 'w2',
        status: 'active'
      },
      {
        ...seedTask(),
        id: 't-done',
        title: 'the one the human closed',
        paneIds: ['w5:p1'],
        workspaceId: 'w5',
        status: 'done'
      }
    ]
  }

  /** One finish as the relay hands it over: pane in the header, rest in the body. */
  function stop(sessionId: string, paneId = ''): ReturnType<typeof normalizeHook> {
    return normalizeHook(
      'codex',
      {
        hook_event_name: 'Stop',
        session_id: sessionId,
        cwd: WORKDIR,
        last_assistant_message: 'all collected'
      },
      START,
      paneId
    )
  }

  it('files the finish of a closed task under that task, and says nothing', async () => {
    const bench = await boot({ tasks: sharedCheckout() })
    const event = stop('sess-done', 'w5:p1')

    // Triage declined because the verdict is done...
    expect(bench.service.onHook(event)).toBeNull()
    // ...and declining is an answer, so the legacy voice must not say it either.
    expect(bench.service.claimsEvent(event)).toBe(true)

    // Attribution is visible in the ledger: the rows belong to the task whose
    // terminal sent the hook, not to the one that shares its directory.
    expect(bench.ledgerTape.map((row) => row.taskId)).toEqual(['t-done', 't-done'])
  })

  it('still raises the finish of a task that is actually running', async () => {
    const bench = await boot({ tasks: sharedCheckout() })
    const raised = bench.service.onHook(stop('sess-live', 'w2:p1'))
    expect(raised?.taskId).toBe('t-live')
    expect(raised?.kind).toBe('review')
  })

  it('believes the pane over a session id another task already holds', async () => {
    const bench = await boot({
      tasks: [
        { ...seedTask(), id: 't-live', paneIds: ['w2:p1'], status: 'active' },
        // The residue of a cwd guess, now sitting on the closed task. Under the
        // old order this id won and the hook was filed here, forever.
        { ...seedTask(), id: 't-done', paneIds: ['w5:p1'], status: 'done', agentSessionId: 'sess-real' }
      ]
    })

    expect(bench.service.onHook(stop('sess-real', 'w2:p1'))?.taskId).toBe('t-live')
    // The binding follows the pane, so the next hook needs no correcting.
    expect(bench.registry.get('t-live')?.agentSessionId).toBe('sess-real')
  })

  it('does not write a session id it inferred from a shared directory', async () => {
    const bench = await boot({ tasks: sharedCheckout() })

    // No pane: an agent outside herdr, or a runner older than the header. The
    // finish is still worth recording, but which of the two tasks it belongs to
    // is a guess, and a guess must not be written down as the strongest key we
    // hold - that is the binding which then outvotes the pane.
    expect(bench.service.onHook(stop('sess-guess'))?.taskId).toBe('t-live')
    expect(bench.registry.get('t-live')?.agentSessionId).toBe('')
    expect(bench.registry.get('t-done')?.agentSessionId).toBe('')
    expect(bench.ledgerTape.some((row) => row.kind === 'session')).toBe(false)
    expect(bench.ledgerTape.map((row) => row.taskId)).toEqual(['t-live'])
  })

  it('falls back to what it has when nobody owns the reported pane', async () => {
    const bench = await boot({ tasks: sharedCheckout() })

    // A pane herdr has not told us about yet, or one that died between the hook
    // and the match. Dropping the event would lose the finish entirely.
    expect(bench.service.onHook(stop('sess-live', 'w9:p9'))?.taskId).toBe('t-live')
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
    // `path.join`, not a hand-written `/`: this case runs on a Windows runner
    // too, where the real home is `C:\Users\x` and the expansion has to come
    // back with backslashes. The literal-separator behaviour is pinned by the
    // next case, which does not depend on the host at all.
    expect(resolveWorkdir('~/src/app', HOME)).toBe(path.join(HOME, 'src', 'app'))
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

/* ------------------------------------------------------------------ *
 * Removal: what "remove" has to mean while herdr keeps the session
 * ------------------------------------------------------------------ */

/**
 * Removing a row and closing a session are different operations, and the gap
 * between them is the bug these cases pin down.
 *
 * Dropping the row is a change to our file; leaving the shell alive is a change
 * to nothing, and a session that keeps running keeps arriving in snapshots,
 * unclaimed. The bench adopts every workspace no task claims, which made removal
 * self-undoing: drop five rows, open one terminal, and the snapshot that arrives
 * next adopts all five back as fresh rows. What the human meant by "remove" has
 * to outlive the row it deleted - and a shell kept on purpose has to stay
 * reachable, which is what the declined list and its purge are for.
 */
describe('ProService removal', () => {
  /** Any number of one-pane workspaces, all sitting in the same directory. */
  function snapshotOf(workspaceIds: readonly string[]): Snapshot {
    return parseSnapshot({
      version: '0.9.0',
      protocol: 1,
      workspaces: workspaceIds.map((id, index) => ({
        workspace_id: id,
        number: index + 1,
        label: id,
        pane_count: 1
      })),
      panes: workspaceIds.map((id) => ({
        pane_id: `${id}:p1`,
        workspace_id: id,
        tab_id: `${id}:t1`,
        cwd: WORKDIR,
        agent: 'codex',
        agent_status: 'idle'
      }))
    }) as Snapshot
  }

  /** A shell row over one of them, as `openSession` would have written it. */
  function shell(id: string, workspaceId: string): TaskRecord {
    return {
      ...seedTask(),
      id,
      title: `shell ${workspaceId}`,
      agentKind: '',
      workspaceId,
      paneIds: [`${workspaceId}:p1`],
      origin: 'created'
    }
  }

  function workspaces(bench: Bench): string[] {
    return bench.registry.tasks().map((task) => task.workspaceId)
  }

  it('does not hand a removed workspace back on the next snapshot', async () => {
    const bench = await boot({
      tasks: [shell('t-a', 'w1'), shell('t-b', 'w2')],
      snapshot: snapshotOf(['w1', 'w2']),
      record: true
    })

    for (const taskId of ['t-a', 't-b']) {
      expect((await bench.service.taskOp({ op: 'remove', taskId, closeShell: false })).ok).toBe(true)
    }
    expect(bench.registry.tasks()).toHaveLength(0)

    // The moment the rows used to come back: a snapshot still reporting both
    // workspaces, arriving after the removals landed. `w3` is here too so the
    // case would fail loudly if removal blocked adoption wholesale.
    bench.session.pushSnapshot(snapshotOf(['w1', 'w2', 'w3']))
    expect(workspaces(bench)).toEqual(['w3'])
  })

  it('gives the adopt button the last word, because a removal with no undo is a trap', async () => {
    const bench = await boot({
      tasks: [shell('t-a', 'w1')],
      snapshot: snapshotOf(['w1']),
      record: true
    })
    await bench.service.taskOp({ op: 'remove', taskId: 't-a', closeShell: false })
    bench.session.pushSnapshot(snapshotOf(['w1']))
    expect(workspaces(bench)).toEqual([])

    // A snapshot is the world telling us what exists; the toolbar button is the
    // human asking for it back. Only the second one overrides a removal, and it
    // drops the entry so the row it just made is not blocked from re-binding.
    expect((await bench.service.taskOp({ op: 'adopt' })).ok).toBe(true)
    expect(workspaces(bench)).toEqual(['w1'])
    expect(bench.registry.forgotten()).toEqual([])

    // One row, not one per snapshot: the workspace is claimed again.
    bench.session.pushSnapshot(snapshotOf(['w1']))
    expect(workspaces(bench)).toEqual(['w1'])
  })

  it('leaves the pane running when asked to, and says so where it can be seen', async () => {
    const bench = await boot({
      tasks: [shell('t-a', 'w1')],
      snapshot: snapshotOf(['w1']),
      record: true
    })

    await bench.service.taskOp({ op: 'remove', taskId: 't-a', closeShell: false })

    // Closing it would be the easy way to stop the resurrection, and a
    // destructive one: an adopted row is somebody else's shell, running
    // something they did not start from this bench.
    expect(bench.session.calls.map((call) => call.method)).not.toContain('closeWorkspace')

    // ...which is also why keeping it cannot be silent. A shell the bench will
    // no longer show and nobody can reach from here is indistinguishable from a
    // lost terminal, so it goes on the projection the topbar chip renders.
    expect(bench.service.view()?.declined).toEqual([
      { workspaceId: 'w1', label: 'w1', panes: 1, agentStatus: 'idle' }
    ])
  })

  it('closes the shell when the box says so, and stops holding its id', async () => {
    const bench = await boot({
      tasks: [shell('t-a', 'w1')],
      snapshot: snapshotOf(['w1']),
      record: true
    })

    const result = await bench.service.taskOp({ op: 'remove', taskId: 't-a', closeShell: true })

    expect(result.ok).toBe(true)
    expect(result.code).toBe('removed-closed')
    const closes = bench.session.calls.filter((call) => call.method === 'closeWorkspace')
    expect(closes.map((call) => call.arg)).toEqual(['w1'])
    // herdr let it go, so the id is free. A remembered removal stands in for a
    // shell that is still running; blocking a recycled w1 for a day after the
    // real one is gone would cost the human the next terminal they open.
    expect(bench.registry.forgotten()).toEqual([])
    expect(bench.service.view()?.declined).toEqual([])
    expect(bench.ledgerTape.map((entry) => entry.text)).toContain('workspace w1 closed on remove')
  })

  it('treats a refused close as a removal that worked and a shell that survived', async () => {
    const bench = await boot({
      tasks: [shell('t-a', 'w1')],
      snapshot: snapshotOf(['w1']),
      record: true,
      closeOk: false
    })

    const result = await bench.service.taskOp({ op: 'remove', taskId: 't-a', closeShell: true })

    // The row is gone, so the human's intent landed; what failed is the optional
    // half. Reporting that as a failed remove invites a retry of a remove that
    // already happened, so it is a kept shell on the chip instead.
    expect(result.ok).toBe(true)
    expect(result.code).toBe('removed')
    expect(bench.registry.forgotten()).toEqual(['w1'])
    expect(bench.service.view()?.declined.map((entry) => entry.workspaceId)).toEqual(['w1'])
    expect(bench.ledgerTape.map((entry) => entry.text)).toContain('workspace w1 survived remove')
  })

  it('purges what removals left running, because one dialog at a time is not a thing anybody finishes', async () => {
    const bench = await boot({
      tasks: [shell('t-a', 'w1'), shell('t-b', 'w2')],
      snapshot: snapshotOf(['w1', 'w2', 'w3']),
      record: true
    })
    for (const taskId of ['t-a', 't-b']) {
      await bench.service.taskOp({ op: 'remove', taskId, closeShell: false })
    }
    expect(bench.service.view()?.declined.map((entry) => entry.workspaceId)).toEqual(['w1', 'w2'])

    const result = await bench.service.taskOp({ op: 'purge' })

    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ closed: 2, remaining: 0 })
    expect(
      bench.session.calls.filter((call) => call.method === 'closeWorkspace').map((call) => call.arg)
    ).toEqual(['w1', 'w2'])
    // `w3` was never a removal. Purging the declined list is not a licence to
    // close anything else herdr happens to be carrying.
    expect(bench.registry.forgotten()).toEqual([])
    expect(bench.service.view()?.declined).toEqual([])
  })

  it('answers a purge with nothing declined without touching herdr', async () => {
    const bench = await boot({
      tasks: [shell('t-a', 'w1')],
      snapshot: snapshotOf(['w1']),
      record: true
    })

    const result = await bench.service.taskOp({ op: 'purge' })

    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ closed: 0, remaining: 0 })
    expect(bench.session.calls).toHaveLength(0)
  })

  it('keeps a refused purge on the chip, so the count cannot lie about the machine', async () => {
    const bench = await boot({
      tasks: [shell('t-a', 'w1')],
      snapshot: snapshotOf(['w1']),
      record: true,
      closeOk: false
    })
    await bench.service.taskOp({ op: 'remove', taskId: 't-a', closeShell: true })

    const result = await bench.service.taskOp({ op: 'purge' })

    expect(result.ok).toBe(true)
    expect(result.data).toEqual({ closed: 0, remaining: 1 })
    expect(bench.registry.forgotten()).toEqual(['w1'])
  })

  it('lets the id go once herdr does, so a recycled id is not blocked forever', async () => {
    const bench = await boot({
      tasks: [shell('t-a', 'w1')],
      snapshot: snapshotOf(['w1']),
      record: true
    })
    await bench.service.taskOp({ op: 'remove', taskId: 't-a', closeShell: false })

    // A snapshot that still reports other workspaces but not this one is herdr
    // agreeing the removal landed - and the id is about to mean something else,
    // so the removal stops standing in front of it.
    bench.session.pushSnapshot(snapshotOf(['w2']))
    bench.session.pushSnapshot(snapshotOf(['w1']))

    expect(workspaces(bench)).toEqual(['w1'])
    expect(bench.registry.tasks()[0]?.origin).toBe('adopted')
  })

  it('does not read an empty snapshot as agreement, because that is what a reconnect looks like', async () => {
    const bench = await boot({
      tasks: [shell('t-a', 'w1'), shell('t-b', 'w2')],
      snapshot: snapshotOf(['w1', 'w2']),
      record: true
    })
    for (const taskId of ['t-a', 't-b']) {
      await bench.service.taskOp({ op: 'remove', taskId, closeShell: false })
    }

    // "herdr has no workspaces" is what the bridge reports while the server is
    // still restoring its session. Taking it as evidence clears every removal a
    // moment before the real snapshot re-adopts all of them: the resurrection
    // this list exists to prevent, back again on a timer nobody can see.
    bench.session.pushSnapshot(emptySnapshot())
    expect(bench.registry.forgotten()).toEqual(['w1', 'w2'])

    bench.session.pushSnapshot(snapshotOf(['w1', 'w2']))
    expect(workspaces(bench)).toEqual([])
  })

  it('reports an unknown task instead of remembering a removal that did not happen', async () => {
    const bench = await boot({ tasks: [], snapshot: snapshotOf(['w1']), record: true })

    const result = await bench.service.taskOp({ op: 'remove', taskId: 't-nope', closeShell: true })
    expect(result.ok).toBe(false)
    expect(bench.registry.forgotten()).toEqual([])
    // Not a scratch on herdr either: an unknown row is not a licence to close
    // whatever workspace the caller happened to name.
    expect(bench.session.calls).toHaveLength(0)
  })
})

/**
 * The remembered-removal list itself, held at the registry so the clock is ours.
 *
 * Through the service the only way to age an entry past its TTL is to advance a
 * clock that also arms the tick, the git sweep and the hydrate, and a projection
 * rebuilt by a timer is a green test lying about which code path produced it.
 */
describe('TaskRegistry forgotten removals', () => {
  function registry(start: number): { registry: TaskRegistry; now: () => number; set: (n: number) => void } {
    let current = start
    let stored: RegistryFile | null = null
    const registry = new TaskRegistry({
      file: 'memory://bench.json',
      now: () => current,
      read: () => stored,
      write: (_file, value) => {
        stored = value
        return true
      }
    })
    return { registry, now: () => current, set: (next) => (current = next) }
  }

  it('survives a write and a re-read, because the point is outliving the row', () => {
    const box = registry(START)
    box.registry.forget('w1', ['w1:p1'])
    expect(box.registry.save()).toBe(true)
    // Same file, new registry: a restart must not resurrect what was removed.
    box.registry.load(true)
    expect(box.registry.forgotten()).toEqual(['w1'])
  })

  it('is one fact per workspace, however many rows named it', () => {
    const box = registry(START)
    box.registry.forget('w1', ['w1:p1'])
    box.registry.forget('w1', ['w1:p2'])
    expect(box.registry.forgotten()).toEqual(['w1'])
  })

  it('drops an entry herdr no longer reports', () => {
    const box = registry(START)
    box.registry.forget('w1')
    box.registry.reconcileForgotten(['w2', 'w3'])
    expect(box.registry.forgotten()).toEqual([])
  })

  it('reads nothing into an empty report, because that is a reconnect and not an answer', () => {
    const box = registry(START)
    box.registry.forget('w1')
    box.registry.reconcileForgotten([])
    expect(box.registry.forgotten()).toEqual(['w1'])
  })

  it('expires an entry herdr never let go of, rather than block the id forever', () => {
    const box = registry(START)
    box.registry.forget('w1')
    box.set(START + FORGOTTEN_TTL_MS - 1)
    box.registry.reconcileForgotten(['w1'])
    expect(box.registry.forgotten()).toEqual(['w1'])
    box.set(START + FORGOTTEN_TTL_MS)
    box.registry.reconcileForgotten(['w1'])
    // The bounded regression, chosen deliberately: a shell that outlives its
    // removal by more than a day may be adopted back once, against an id that
    // would otherwise be unusable for the rest of the install.
    expect(box.registry.forgotten()).toEqual([])
  })

  it('reads a registry written before removals were remembered', () => {
    let stored: RegistryFile | null = { version: 1, updatedAt: START, tasks: [] }
    const registry = new TaskRegistry({
      file: 'memory://bench.json',
      now: () => START,
      read: () => stored,
      write: (_file, value) => {
        stored = value
        return true
      }
    })
    expect(registry.forgotten()).toEqual([])
    // And saving it must not invent a list from nothing.
    expect(registry.save()).toBe(true)
    expect(stored?.forgotten).toEqual([])
  })

  it('ignores a hand-edited entry with no workspace in it', () => {
    const stored: RegistryFile = {
      version: 1,
      updatedAt: START,
      tasks: [],
      forgotten: [
        { workspaceId: '', paneIds: ['w1:p1'], at: START },
        { workspaceId: 'w2', paneIds: 'nope' as unknown as string[], at: 'soon' as unknown as number }
      ]
    }
    const registry = new TaskRegistry({
      file: 'memory://bench.json',
      now: () => START,
      read: () => stored,
      write: () => true
    })
    expect(registry.forgotten()).toEqual(['w2'])
  })
})

/* ------------------------------------------------------------------ *
 * SSH: the connect palette's backend
 * ------------------------------------------------------------------ */

/**
 * A terminal session is a Bench task with no agent in it. That is the whole
 * design, and it is why these cases live in this file rather than in a new one:
 * herdr owns the PTY, the registry owns the row in the tree, and the pane
 * renderer that already draws agent output draws a shell too. There is no second
 * terminal implementation in this app and no node-pty, so what `sshOp` adds is a
 * provisioning path - `openSession` - which is task creation with the agent left
 * out and some text typed into the result.
 *
 * Four things about that path can be wrong without anything throwing, and they
 * are what gets pinned below:
 *
 * - the task carries `agentKind: ''`, so the tree does not grow a Codex badge
 *   over what is only a shell,
 * - the ledger line is `session`, not `goal`, because a connect line is not a
 *   brief and the history panel must not present it as one,
 * - the line is typed exactly once, as text plus Enter, and `typed` reports what
 *   actually reached the pane rather than what was asked for,
 * - a directory that is not there is refused, instead of opening a pane that can
 *   never be resumed and a task that will read `lost` forever after.
 *
 * Nothing here spawns `ssh` or reads a real `~/.ssh`: the roster's disk and child
 * edges are injected, so a suite cannot pass because of the machine it ran on.
 */
describe('ProService ssh', () => {
  const HOME = os.homedir()
  /** The connect line a human would have typed for the box below. */
  const LINE = 'ssh -p 2222 wanlian@172.18.29.206'

  /** One bench with herdr answering, an injected roster, and no git anywhere. */
  async function sshBench(ssh: SshService, online = true): Promise<Bench> {
    const bench = await boot({ tasks: [], record: true, ssh, gitRoots: {} })
    if (online) bench.session.setOnline(true)
    return bench
  }

  it('answers the palette with one roster, and the home a blank directory means', async () => {
    const ssh = fakeSsh({
      saved: [makeMachine({ id: 'm1', host: '10.0.0.9', user: 'alice', source: 'saved' })],
      config: 'Host lab\n  HostName lab.example\n  User bob\n  Port 2222\n'
    })
    const bench = await sshBench(ssh)

    const result = await bench.service.sshOp({ op: 'list', query: '' })
    expect(result.ok).toBe(true)
    const roster = result.data as ProSshRoster
    expect(roster.machines.map((machine) => machine.host).sort()).toEqual([
      '10.0.0.9',
      'lab.example'
    ])
    // The palette prints this next to a blank field, so it has to be the same
    // home `openSession` will resolve that blank against.
    expect(roster.home).toBe(HOME)

    // Filtering is the service's job: a renderer that re-implemented ranking
    // would show a different list than the one it was handed.
    const filtered = await bench.service.sshOp({ op: 'list', query: 'lab' })
    expect((filtered.data as ProSshRoster).machines.map((machine) => machine.host)).toEqual([
      'lab.example'
    ])
  })

  it('refuses to connect to nothing, rather than opening a local shell that looks connected', async () => {
    const bench = await sshBench(fakeSsh())

    const result = await bench.service.sshOp({
      op: 'connect',
      machine: null,
      target: '',
      save: true,
      cwd: ''
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('bad-machine')
    expect(bench.registry.tasks()).toHaveLength(0)
  })

  it('refuses while herdr is down, and still keeps the machine it was asked to pin', async () => {
    const ssh = fakeSsh()
    const bench = await sshBench(ssh, false)

    const result = await bench.service.sshOp({
      op: 'connect',
      machine: null,
      target: UBUNTU,
      save: true,
      cwd: ''
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('offline')
    // No task and no ledger line: a session that was never opened has no history.
    expect(bench.registry.tasks()).toHaveLength(0)
    expect(bench.ledgerTape).toHaveLength(0)
    // Pinned anyway, on purpose - a box the human meant to keep is worth keeping
    // even when the attempt to reach it could not be made.
    expect(ssh.saved().map((machine) => machine.host)).toEqual(['172.18.29.206'])
  })

  it('opens a bare terminal in home when no directory came with it', async () => {
    const bench = await sshBench(fakeSsh())

    const result = await bench.service.sshOp({ op: 'terminal', cwd: '' })
    expect(result.ok).toBe(true)
    expect(result.code).toBe('terminal')
    const opened = result.data as ProSessionOpened
    expect(opened.paneId).toBe('p-new')
    expect(opened.typed).toBe(0)
    expect(typedLines(bench)).toEqual([])

    const task = bench.registry.tasks()[0]
    expect(task?.agentKind, 'a shell is not an agent').toBe('')
    expect(task?.workdir).toBe(HOME)
    // The last segment, however this host spells a path: `HOME.split('/')` is
    // the whole string on Windows, and a title reading `C:\Users\x` over a
    // directory called `x` is the kind of wrong that ships quietly.
    expect(task?.title).toBe(pathBase(HOME))
    expect(bench.ledgerTape).toHaveLength(1)
    expect(bench.ledgerTape[0]?.kind).toBe('session')
    // The human asked to be somewhere; landing them there is the point.
    expect(bench.calls).toContain('openBench')
  })

  it('names the directory that is not one instead of opening a pane inside it', async () => {
    const bench = await sshBench(fakeSsh())

    const result = await bench.service.sshOp({ op: 'terminal', cwd: WORKDIR })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('no-dir')
    expect(result.detail).toContain(WORKDIR)
    expect(bench.registry.tasks()).toHaveLength(0)
  })

  it('types one connect line into the pane it just opened, and pins the box on the way', async () => {
    const ssh = fakeSsh()
    const bench = await sshBench(ssh)

    const result = await bench.service.sshOp({
      op: 'connect',
      machine: null,
      target: UBUNTU,
      save: true,
      cwd: IMPORT_DIR
    })
    expect(result.ok).toBe(true)
    expect(result.code).toBe('connected')
    const opened = result.data as ProSessionOpened
    expect(opened.typed).toBe(1)
    expect(opened.workspaceId).toBe('w-new')
    expect(typedLines(bench)).toEqual([LINE])
    // Text without Enter is a prompt with something typed in it, not a connection.
    expect(bench.session.calls.filter((call) => call.method === 'sendKeys').map((call) => call.args[1])).toEqual([['enter']])

    const task = bench.registry.tasks()[0]
    expect(task?.agentKind).toBe('')
    expect(task?.workdir).toBe(IMPORT_DIR)
    expect(task?.title).toBe('wanlian@172.18.29.206')
    // The line is the goal: it is what the history panel can honestly say this
    // task was for.
    expect(task?.goal).toBe(LINE)
    expect(bench.ledgerTape).toHaveLength(1)
    expect(bench.ledgerTape[0]).toMatchObject({ kind: 'session', text: LINE, agent: '' })
    expect(ssh.saved().map((machine) => machine.host)).toEqual(['172.18.29.206'])
  })

  it('leaves the roster alone when the palette said not to pin', async () => {
    const ssh = fakeSsh()
    const bench = await sshBench(ssh)

    const result = await bench.service.sshOp({
      op: 'connect',
      machine: null,
      target: UBUNTU,
      save: false,
      cwd: IMPORT_DIR
    })
    expect(result.ok).toBe(true)
    expect(result.code).toBe('connected-unsaved')
    expect(typedLines(bench)).toEqual([LINE])
    expect(ssh.saved()).toEqual([])
  })

  it('connects by alias when the machine came from ~/.ssh/config', async () => {
    // config already carries the port, the user and the key, so re-passing them
    // could only contradict the file the user maintains by hand.
    const ssh = fakeSsh({ config: 'Host ubu\n  HostName 172.18.29.206\n  Port 2222\n  User wanlian\n' })
    const bench = await sshBench(ssh)
    const [machine] = await ssh.roster('ubu')
    expect(machine?.alias).toBe('ubu')

    const result = await bench.service.sshOp({
      op: 'connect',
      machine: machine ?? null,
      target: '',
      save: false,
      cwd: ''
    })
    expect(result.ok).toBe(true)
    expect(typedLines(bench)).toEqual(['ssh ubu'])
  })

  it('reads a whole pasted command line the same as the target inside it', async () => {
    const bench = await sshBench(fakeSsh())

    const result = await bench.service.sshOp({
      op: 'connect',
      machine: null,
      target: 'ssh wanlian@172.18.29.206 -p 2222',
      save: false,
      cwd: IMPORT_DIR
    })
    expect(result.ok).toBe(true)
    expect(typedLines(bench)).toEqual([LINE])
  })

  it('hands back the passwordless plan without touching herdr, and makes a key first when there is none', async () => {
    const runs: string[][] = []
    const bench = await sshBench(fakeSsh({ runs }))

    const result = await bench.service.sshOp({
      op: 'setup',
      machine: null,
      target: UBUNTU,
      key: '',
      run: false
    })
    expect(result.ok).toBe(true)
    expect(result.code).toBe('setup-plan')
    const plan = result.data as ProSshSetup
    // No keypair on this box, so `ssh-copy-id` alone would be the first of two
    // failures the human has to read.
    expect(plan.lines).toHaveLength(2)
    expect(plan.lines[0]).toContain('ssh-keygen')
    expect(plan.lines[1]).toBe('ssh-copy-id -p 2222 wanlian@172.18.29.206')
    expect(plan.key).toBe('')
    expect(bench.session.calls).toHaveLength(0)
    expect(bench.registry.tasks()).toHaveLength(0)
    expect(runs).toEqual([])
  })

  it('publishes the conventional key when this box has one', async () => {
    const bench = await sshBench(fakeSsh({ keys: ['id_rsa.pub', 'id_ed25519.pub'] }))

    const result = await bench.service.sshOp({
      op: 'setup',
      machine: null,
      target: UBUNTU,
      key: '',
      run: false
    })
    const plan = result.data as ProSshSetup
    expect(plan.key).toBe(`${SSH_HOME}/.ssh/id_ed25519.pub`)
    expect(plan.lines).toEqual([
      `ssh-copy-id -i ${SSH_HOME}/.ssh/id_ed25519.pub -p 2222 wanlian@172.18.29.206`
    ])
  })

  it('types the plan when asked to run it, because the password prompt is the human\'s to answer', async () => {
    const bench = await sshBench(fakeSsh({ keys: ['id_ed25519.pub'] }))

    const result = await bench.service.sshOp({
      op: 'setup',
      machine: null,
      target: UBUNTU,
      key: '',
      run: true
    })
    expect(result.ok).toBe(true)
    expect(result.code).toBe('setup')
    const setup = result.data as ProSshSetup & ProSessionOpened
    expect(setup.typed).toBe(setup.lines.length)
    expect(typedLines(bench)).toEqual(setup.lines)
    expect(bench.registry.tasks()[0]?.agentKind).toBe('')
    expect(bench.ledgerTape).toHaveLength(1)
    expect(bench.ledgerTape[0]?.kind).toBe('session')
  })

  it('reports what the probe found, which is the cue to offer passwordless setup', async () => {
    const runs: string[][] = []
    const ssh = fakeSsh({
      runs,
      probe: {
        code: 255,
        stderr: 'wanlian@172.18.29.206: Permission denied (publickey,password).\n'
      }
    })
    const bench = await sshBench(ssh)

    const result = await bench.service.sshOp({ op: 'probe', machine: null, target: UBUNTU })
    expect(result.ok).toBe(true)
    expect(result.code).toBe('auth')
    const probe = result.data as ProSshProbe
    expect(probe.status).toBe('auth')
    expect(probe.detail).toContain('Permission denied')
    // BatchMode is the whole trick: it forbids the prompt, so "would ask for a
    // password" arrives as an exit code instead of a hung child.
    expect(runs).toHaveLength(1)
    expect(runs[0]).toContain('BatchMode=yes')
    expect(runs[0]?.slice(-2)).toEqual(['wanlian@172.18.29.206', 'exit'])
  })

  it('calls a key-auth box ok, and a box with no ssh client no-ssh', async () => {
    const ok = await sshBench(fakeSsh())
    const good = await ok.service.sshOp({ op: 'probe', machine: null, target: UBUNTU })
    expect((good.data as ProSshProbe).status).toBe('ok')

    const missing = await sshBench(fakeSsh({ probe: { code: 127, stderr: 'ssh: command not found' } }))
    const bad = await missing.service.sshOp({ op: 'probe', machine: null, target: UBUNTU })
    expect((bad.data as ProSshProbe).status).toBe('no-ssh')
  })

  it('says so when the machine to unpin was never pinned', async () => {
    const bench = await sshBench(fakeSsh())

    const result = await bench.service.sshOp({ op: 'remove', id: 'm-nope' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('no-item')
  })

  it('tells the truth when the roster cannot be written', async () => {
    const bench = await sshBench(fakeSsh({ writable: false }))

    const result = await bench.service.sshOp({ op: 'save', machine: null, target: UBUNTU })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('bad-machine')
  })
})

/* ------------------------------------------------------------------ *
 * Terminal scrollback: what a scroll is allowed to touch
 * ------------------------------------------------------------------ */

/**
 * A pane with history is read through two channels on purpose, and the split is
 * the thing worth pinning down here rather than in either channel's own file.
 *
 * Wheel and page keys travel over the bridge's control stream, because that is
 * the stream already carrying keystrokes and a relative nudge has to land in
 * order with them. "Back to the live edge" travels over the socket instead: the
 * control stream's `lines` is a u16, so a pane with a long history could not be
 * told "all the way down" without stopping short, and a jump that stops short
 * looks exactly like a jump that worked.
 *
 * What both share is the third leg. herdr answers with where the pane actually
 * ended up, and only that answer is allowed to move the header chip. A scroll is
 * also the one arrival that must not look like a snapshot: it lands many times a
 * second while a wheel is moving, so it patches the cached pane, tells the one
 * header showing it, and rebuilds nothing.
 */
describe('ProService terminal scrollback', () => {
  /** One live pane, bridged the way the centre column bridges it. */
  async function bridged(): Promise<Bench> {
    const bench = await boot({
      tasks: [liveTask()],
      snapshot: liveSnapshot(),
      record: true,
      terminal: true
    })
    const result = await bench.service.paneOp({
      op: 'attach',
      paneId: LIVE_PANE,
      cols: 80,
      rows: 24,
      takeover: false
    })
    expect(result.ok, 'every case below needs a bridge to talk about').toBe(true)
    return bench
  }

  /** herdr reporting that the pane moved, as the subscription delivers it. */
  function scrolled(offsetFromBottom: number, paneId = LIVE_PANE): HerdrEvent {
    return {
      event: SCROLL_EVENT,
      data: {
        pane_id: paneId,
        workspace_id: LIVE_WORKSPACE,
        scroll: {
          offset_from_bottom: offsetFromBottom,
          max_offset_from_bottom: 412,
          viewport_rows: 24
        }
      }
    }
  }

  /** The bridge pushes the service sent the window, newest last. */
  function pushes(bench: Bench): ProBridgePush[] {
    return bench.emits
      .filter((emit) => emit.channel === IPC.pushProBridge)
      .map((emit) => emit.payload as ProBridgePush)
  }

  it('hands the bridged pane herdr own offsets, and nothing else', async () => {
    const bench = await bridged()
    const before = pushes(bench).length

    bench.session.pushEvent(scrolled(12))

    const sent = pushes(bench).slice(before)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.paneId).toBe(LIVE_PANE)
    // herdr's numbers, not the ones we asked for: the chip says where the pane
    // is, and only the pane's own server knows that.
    expect(sent[0]?.scroll).toEqual({
      offsetFromBottom: 12,
      maxOffsetFromBottom: 412,
      viewportRows: 24
    })
  })

  it('says nothing about a pane nobody is looking at', async () => {
    // Not bridged, so there is no header to be stale - and a push for it would
    // be a frame the renderer has to reason about for a view it never opened.
    const bench = await boot({ tasks: [liveTask()], snapshot: liveSnapshot(), record: true })

    bench.session.pushEvent(scrolled(30))

    expect(pushes(bench)).toHaveLength(0)
  })

  it('is not a snapshot: sixty wheel notches must not rebuild the bench', async () => {
    const bench = await bridged()
    const frames: unknown[] = []
    bench.service.onChange((view) => frames.push(view))
    bench.clock.advance(PUSH_MS * 4)
    // Then past the recovery memo's window. A rebuild inside that window is
    // invisible - the memo answers from cache either way - so the clock moves
    // first and a wasted re-plan becomes something a case can assert on. The
    // tick, the git sweep and the hydrate are all an order of magnitude further
    // out, so nothing else moves with it.
    bench.clock.advance(RECOVERY_TTL_MS)
    const settled = frames.length
    const plans = bench.planAllCalls()
    const before = pushes(bench).length

    for (let offset = 1; offset <= 60; offset += 1) bench.session.pushEvent(scrolled(offset))
    bench.clock.advance(PUSH_MS * 4)

    // The header hears every one of them - that is what the per-pane push buys -
    // while the projection the whole window renders does not move at all.
    const sent = pushes(bench).slice(before)
    expect(sent).toHaveLength(60)
    expect(sent[59]?.scroll?.offsetFromBottom).toBe(60)
    expect(frames, 'a scroll rebuilt the projection').toHaveLength(settled)
    expect(bench.planAllCalls(), 'a scroll re-planned recovery').toBe(plans)
  })

  it('jumps to the live edge over the socket, because the control stream cannot count that high', async () => {
    const bench = await bridged()

    const result = await bench.service.paneOp({ op: 'scrollBottom', paneId: LIVE_PANE })

    expect(result.ok).toBe(true)
    expect(bench.session.calls.find((call) => call.method === 'scrollPane')?.args).toEqual([
      LIVE_PANE,
      0
    ])
    // herdr's answer rides back, so the chip clears on the same tick as the
    // repaint instead of waiting for the subscription to come around.
    const data = result.data as { paneId: string; scroll: { offsetFromBottom: number } }
    expect(data.paneId).toBe(LIVE_PANE)
    expect(data.scroll.offsetFromBottom).toBe(0)
    // The relative channel stays quiet. A u16 nudge is the wrong verb for "all
    // the way down", which is the entire reason this op exists.
    expect(scrollCommands(bench)).toHaveLength(0)
  })

  it('keeps a page key a page key, because herdr treats the two gestures differently', async () => {
    const bench = await bridged()

    await bench.service.paneOp({
      op: 'scroll',
      paneId: LIVE_PANE,
      direction: 'up',
      lines: 3,
      source: 'wheel'
    })
    await bench.service.paneOp({
      op: 'scroll',
      paneId: LIVE_PANE,
      direction: 'down',
      lines: 24,
      source: 'page_key'
    })

    // Read off the child's stdin rather than off the bridge: the wire spelling
    // is what herdr parses, and a `source` dropped on the way out is invisible
    // to every layer above it.
    expect(scrollCommands(bench)).toEqual([
      { type: 'terminal.scroll', direction: 'up', lines: 3, source: 'wheel' },
      { type: 'terminal.scroll', direction: 'down', lines: 24, source: 'page_key' }
    ])
  })
})

/** What the bridged child was actually told to scroll, in order. */
function scrollCommands(bench: Bench): Array<Record<string, unknown>> {
  return bench.spawner
    .child()
    .commands()
    .filter((command) => command.type === 'terminal.scroll')
}

/**
 * One live herdr instance, built through the wire parser like everything else
 * here: a hand-written `AgentInstance` literal would drift from what herdr
 * sends, and the shape of that record is the whole subject of the cases below.
 */
function runningAgent(kind: string): AgentInstance {
  return parseAgentInstance({
    pane_id: LIVE_PANE,
    workspace_id: LIVE_WORKSPACE,
    tab_id: 'tab-1',
    terminal_id: 'term-1',
    name: `agent-${kind || 'none'}`,
    agent: kind,
    agent_status: 'working',
    cwd: WORKDIR
  }) as AgentInstance
}

/** What the new-task dialog is handed when it asks for the agent picker. */
async function picker(bench: Bench): Promise<ProAgentsData> {
  const result = await bench.service.hostOp({ op: 'agents' })
  expect(result.ok, result.detail).toBe(true)
  return result.data as ProAgentsData
}

describe('the new-task agent picker', () => {
  /*
   * The shipped crash: `host.agents` answered herdr's agent *records*, the
   * dialog rendered each one as an `<option>` child, and React error #31 put a
   * fault card over the whole bench - on any machine where herdr had so much as
   * one agent running. `okResult` infers its `T`, so nothing upstream of the
   * window could see it. The payload type now lives in `shared/` with the
   * renderer naming it too, and these cases are the runtime half; the e2e smoke
   * test drives the real dialog against a fake herdr serving one live instance,
   * and it cannot run in CI.
   */
  it('answers names, never the records herdr answers with', async () => {
    const bench = await boot({ record: true, agents: [runningAgent('codex')] })
    expect((await picker(bench)).agents).toEqual(['codex'])
  })

  it('lists what this machine can start when nothing is running', async () => {
    // `record` with no instances: herdr is up and answers `agent.list` with an
    // empty list, which is the quiet-machine case every install starts in. The
    // form still needs a menu, and an empty one reads as "this machine has no
    // agents" - a lie the dialog has no way to correct.
    const bench = await boot({ record: true, agents: [], binaries: ['claude', 'codex'] })
    const result = await bench.service.hostOp({ op: 'agents' })
    expect(result.ok, result.detail).toBe(true)
    expect(result.code).toBe('agents')
    // Probe order, not the order the binaries were listed in: the menu reads
    // `KNOWN_AGENT_KINDS`, so it is the same menu on every machine.
    expect((result.data as ProAgentsData).agents).toEqual(['codex', 'claude'])
  })

  it('adds a running kind the probe cannot see, once', async () => {
    // A live instance proves launchability better than a PATH entry does, which
    // is why the two sources are unioned rather than one preferred over the
    // other: herdr can be running an agent from a path no login shell has.
    const bench = await boot({
      record: true,
      binaries: ['codex'],
      agents: [runningAgent('codex'), runningAgent('aider'), runningAgent('aider')]
    })
    expect((await picker(bench)).agents).toEqual(['codex', 'aider'])
  })

  it('falls back to an empty picker rather than failing the form', async () => {
    // Nothing running and nothing installed: the one honest empty. The form
    // opens anyway, because a picker is not worth failing a dialog over.
    const bench = await boot({ record: true, agents: [] })
    const result = await bench.service.hostOp({ op: 'agents' })
    expect(result.ok, result.detail).toBe(true)
    expect(result.code).toBe('agents-fallback')
    expect((result.data as ProAgentsData).agents).toEqual([])
  })

  it('drops a record herdr left the kind off of', () => {
    // An empty name would render as a blank row that launches nothing, and
    // `unionAgentKinds` is the one place the two sources meet.
    expect(unionAgentKinds(['codex'], [runningAgent('')])).toEqual(['codex'])
    expect(unionAgentKinds(['codex', 'claude'], [runningAgent('grok')])).toEqual([
      'codex',
      'claude',
      'grok'
    ])
  })
})

/* ------------------------------------------------------------------ *
 * Creating a task: what the form gets back, and what herdr is asked for
 * ------------------------------------------------------------------ */

/**
 * One report - "I picked codex, a plain terminal opened, and the new task was
 * not selected" - turned out to be two unrelated defects on the same screen.
 *
 * The agent: `createTask` handed herdr the task title as the agent name and
 * caught whatever came back into a null. herdr validates that name (lowercase
 * ASCII letter first, `[a-z0-9_-]`, 32 bytes, unique among live agents), so
 * "Fix Login" and 论文采集 were both refused and the pane came up as a plain
 * shell under a row that claimed to have an agent. Nothing said why, because
 * the refusal was swallowed on the way out.
 *
 * The selection: `createTask` answered an envelope - `{taskId, workspaceId,
 * paneId, task}` - while the IPC type promised a bare `TaskRecord`, so the
 * dialog read `result.data.id`, got undefined, and the tree highlighted
 * nothing. A payload type that lies is invisible from the window, which is the
 * only place the consequence shows up.
 */
describe('ProService task creation', () => {
  function createRequest(
    title: string,
    agent = '',
    start = false
  ): Extract<ProTaskRequest, { op: 'create' }> {
    return {
      op: 'create',
      title,
      goal: '',
      // A directory that really exists, because the form is refused before it
      // ever reaches herdr otherwise, and these cases are about herdr.
      workdir: IMPORT_DIR,
      branch: '',
      base: '',
      worktree: false,
      agent,
      start,
      prompt: ''
    }
  }

  /** Online and settled: an offline bench records the task and starts nothing. */
  async function createBench(opts: { startAgentError?: string } = {}): Promise<Bench> {
    const bench = await boot({
      tasks: [],
      record: true,
      gitRoots: { [IMPORT_DIR]: IMPORT_ROOT },
      ...opts
    })
    bench.session.setOnline(true)
    await flush()
    return bench
  }

  it('answers with the task it created, which is what the tree selects', async () => {
    const bench = await createBench()
    const result = await bench.service.taskOp(createRequest('the new task'))
    expect(result.ok, result.detail).toBe(true)
    const data = result.data as ProTaskCreated
    expect(data.task.id).toBeTruthy()
    expect(data.taskId).toBe(data.task.id)
    expect(data.paneId).toBe('p-new')
    expect(bench.registry.get(data.task.id)?.title).toBe('the new task')
  })

  it('names the agent with something herdr accepts, not the title a human typed', async () => {
    const bench = await createBench()
    const result = await bench.service.taskOp(createRequest('Fix Login', 'codex', true))
    expect(result.ok, result.detail).toBe(true)
    const started = bench.session.calls.find((call) => call.method === 'startAgent')
    expect(started, 'the agent was never started').toBeTruthy()
    const arg = started?.arg as { name: string; kind: string; paneId: string }
    expect(arg.kind).toBe('codex')
    expect(arg.paneId).toBe('p-new')
    expect(arg.name).not.toBe('Fix Login')
    expect(arg.name).toBe(agentName('Fix Login', (result.data as ProTaskCreated).task.id))
    expect(/^[a-z][a-z0-9_-]*$/.test(arg.name)).toBe(true)
    expect(arg.name.length).toBeLessThanOrEqual(32)
    // herdr accepted it, so there is nothing to complain about and the bench
    // stays quiet - the warning is the second half of the fix, not the first.
    expect(bench.emits.filter((emit) => emit.channel === IPC.pushProNotice)).toHaveLength(0)
  })

  it('says why when herdr refuses the agent anyway', async () => {
    const bench = await createBench({ startAgentError: 'invalid_agent_name' })
    const result = await bench.service.taskOp(createRequest('Fix Login', 'codex', true))
    // The task still exists: a refused agent leaves a pane the human can type
    // into, which is worth more than a form that failed outright.
    expect(result.ok, result.detail).toBe(true)
    const notice = bench.emits.find((emit) => emit.channel === IPC.pushProNotice)
      ?.payload as ProNoticePush
    expect(notice?.tone).toBe('warn')
    expect(notice?.text).toContain('invalid_agent_name')
    expect(bench.logs.some((line) => line.includes('herdr refused to start the agent'))).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * A finished task that is still finishing itself
 * ------------------------------------------------------------------ */

/**
 * The tree pill and the live dot read two different sources, and they can
 * disagree forever: close a row, keep talking to that conversation, and the dot
 * says working while the pill says done. These cases drive the snapshot pass
 * that resolves it, because the rule is the easy half (`tests/proRevive.test.ts`
 * has it) and what is worth pinning here is the wiring - that the pass runs on a
 * snapshot at all, that it writes through the registry, and that a close the
 * human made over a busy pane survives the spinner repainting.
 */
describe('ProService reviving a finished task', () => {
  /** One workspace per row, each pane with the fields proof of life reads. */
  function snapOf(
    panes: readonly { workspaceId: string; status?: string; title?: string }[]
  ): Snapshot {
    const parsed = parseSnapshot({
      version: '0.9.0',
      protocol: 1,
      workspaces: panes.map((pane, index) => ({
        workspace_id: pane.workspaceId,
        number: index + 1,
        label: pane.workspaceId
      })),
      panes: panes.map((pane) => ({
        pane_id: `${pane.workspaceId}:p1`,
        workspace_id: pane.workspaceId,
        tab_id: `${pane.workspaceId}:t1`,
        cwd: WORKDIR,
        agent: 'codex',
        agent_status: pane.status ?? 'working',
        terminal_title: pane.title ?? ''
      }))
    })
    if (!parsed) throw new Error('snapshot fixture did not parse')
    return parsed
  }

  function row(id: string, workspaceId: string, status: TaskRecord['status']): TaskRecord {
    return { ...seedTask(), id, title: `the row over ${workspaceId}`, workspaceId, paneIds: [`${workspaceId}:p1`], status }
  }

  const statuses = (bench: Bench): string[] =>
    bench.registry.tasks().map((task) => `${task.id}:${task.status}`)

  it('reopens a closed row whose pane starts working again', async () => {
    const bench = await boot({
      tasks: [row('t-done', 'w1', 'done')],
      // The first snapshot is a baseline, so this one is recorded rather than
      // judged: it is how a run that starts up over a busy terminal learns what
      // busy looks like for this pane before it is allowed to contradict it.
      snapshot: snapOf([{ workspaceId: 'w1', status: 'idle', title: 'idle' }])
    })
    expect(statuses(bench)).toEqual(['t-done:done'])

    bench.session.pushSnapshot(snapOf([{ workspaceId: 'w1', status: 'working', title: 'spinner' }]))

    expect(statuses(bench)).toEqual(['t-done:active'])
    // And the ledger says why, because a status that moves on its own is a
    // status nobody can explain three days later.
    expect(bench.ledgerTape.map((entry) => entry.text)).toContain(
      'reopened: the agent is working in it again'
    )
  })

  it('reopens on proof of life when the busy label never changed', async () => {
    // The shape the report actually describes: the row had been closed for days
    // while its pane stayed `working` the whole time, so no transition into busy
    // ever happens and the label alone contradicts the screen indefinitely.
    const bench = await boot({
      tasks: [row('t-done', 'w1', 'done')],
      snapshot: snapOf([{ workspaceId: 'w1', status: 'working', title: 'Codex ⠏ thinking' }])
    })
    expect(statuses(bench)).toEqual(['t-done:done'])

    bench.session.pushSnapshot(
      snapOf([{ workspaceId: 'w1', status: 'working', title: 'Codex ⠹ thinking' }])
    )

    expect(statuses(bench)).toEqual(['t-done:active'])
  })

  it('leaves a closed row closed while its terminal is genuinely frozen', async () => {
    const bench = await boot({
      tasks: [row('t-done', 'w1', 'done')],
      snapshot: snapOf([{ workspaceId: 'w1', status: 'working', title: 'Codex ⠏ thinking' }])
    })

    // Same bytes again: a leftover terminal holding the last frame of a finished
    // run looks busy to herdr forever, and reopening it would put a row the
    // human closed back into the queue with nothing new in it.
    bench.session.pushSnapshot(
      snapOf([{ workspaceId: 'w1', status: 'working', title: 'Codex ⠏ thinking' }])
    )

    expect(statuses(bench)).toEqual(['t-done:done'])
    expect(bench.ledgerTape.map((entry) => entry.text)).not.toContain(
      'reopened: the agent is working in it again'
    )
  })

  it('honours a close the human made over a busy pane until work actually resumes', async () => {
    const bench = await boot({
      tasks: [row('t-live', 'w1', 'active')],
      snapshot: snapOf([{ workspaceId: 'w1', status: 'working', title: 'Codex ⠏ thinking' }])
    })

    // "Mark done" while the spinner is running means "I am done tracking it",
    // not "it stopped" - so the pass that runs a second later must not argue
    // with the button the human just pressed.
    await bench.service.taskOp({ op: 'status', taskId: 't-live', status: 'done' })
    bench.session.pushSnapshot(
      snapOf([{ workspaceId: 'w1', status: 'working', title: 'Codex ⠹ thinking' }])
    )
    expect(statuses(bench)).toEqual(['t-live:done'])

    // A real transition is a new turn, and that outranks the verdict.
    bench.session.pushSnapshot(
      snapOf([{ workspaceId: 'w1', status: 'idle', title: 'waiting' }])
    )
    bench.session.pushSnapshot(
      snapOf([{ workspaceId: 'w1', status: 'working', title: 'Codex ⠋ working' }])
    )
    expect(statuses(bench)).toEqual(['t-live:active'])
  })

  it('drops the verdict once the human types into that pane again', async () => {
    const bench = await boot({
      tasks: [row('t-live', 'w1', 'active')],
      snapshot: snapOf([{ workspaceId: 'w1', status: 'working', title: 'Codex ⠏ thinking' }]),
      record: true
    })
    await bench.service.taskOp({ op: 'status', taskId: 't-live', status: 'done' })

    // Answering a question in a closed task is the clearest possible statement
    // that it is not closed, and it does not need the row selected to be true.
    await bench.service.paneOp({ op: 'send', paneId: 'w1:p1', text: 'keep going', enter: true })
    bench.session.pushSnapshot(
      snapOf([{ workspaceId: 'w1', status: 'working', title: 'Codex ⠹ thinking' }])
    )

    expect(statuses(bench)).toEqual(['t-live:active'])
  })

  it('leaves a parked neighbour alone, however busy its pane is', async () => {
    const bench = await boot({
      tasks: [row('t-done', 'w1', 'done'), row('t-parked', 'w2', 'parked')],
      snapshot: snapOf([
        { workspaceId: 'w1', status: 'working', title: 'a' },
        { workspaceId: 'w2', status: 'working', title: 'b' }
      ])
    })

    bench.session.pushSnapshot(
      snapOf([
        { workspaceId: 'w1', status: 'working', title: 'a2' },
        { workspaceId: 'w2', status: 'working', title: 'b2' }
      ])
    )

    // A park is a decision about attention, not a claim that nothing is running;
    // un-parking it behind the human's back puts a silenced row back in the queue.
    expect(statuses(bench)).toEqual(['t-done:active', 't-parked:parked'])
  })

  it('records a baseline after a reconnect instead of judging a remembered terminal', async () => {
    const bench = await boot({
      tasks: [row('t-done', 'w1', 'done')],
      snapshot: snapOf([{ workspaceId: 'w1', status: 'working', title: 'before' }])
    })

    bench.session.setOnline(true)
    bench.session.setOnline(false)
    bench.session.setOnline(true)
    bench.session.pushSnapshot(
      snapOf([{ workspaceId: 'w1', status: 'working', title: 'after the outage' }])
    )

    // Proof of life is a fact about terminals we are watching, and the ones we
    // watched before the socket went away are not these.
    expect(statuses(bench)).toEqual(['t-done:done'])

    bench.session.pushSnapshot(
      snapOf([{ workspaceId: 'w1', status: 'working', title: 'still after' }])
    )
    expect(statuses(bench)).toEqual(['t-done:active'])
  })
})
