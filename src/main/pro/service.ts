/**
 * Pro's composition root, and the only object the IPC layer and the HTTP API
 * talk to.
 *
 * Everything below this file owns one thing: herdr IO lives here and nowhere
 * else, the registry owns durable tasks, the ledger owns durable memory, the
 * tracker owns "what needs the human", and the companion bridge owns the
 * widget. What lives here is the wiring between them plus the four rules that
 * make the wiring safe:
 *
 * 1. **One projection.** `buildBench` is called in exactly one place. The tree,
 *    the queue, the tray badge, the widget bubble and `GET /pro/state` are all
 *    reads of the same object, so they cannot disagree about "needs me".
 * 2. **One executor.** A Bench button, a bubble click and an HTTP answer all
 *    compile through `planAttentionAction` into the same `AttentionExecution`
 *    union and run through the same `execute`. There is one audit trail and one
 *    place that can be wrong.
 * 3. **Never guess a keystroke.** `planAttentionAction` returns `none` for an
 *    agent with no key recipe, and `execute` turns that into a visible message
 *    rather than pressing "1" in a TUI where 1 means something else.
 * 4. **Degrade, never throw.** No herdr binary, no server, a refused socket, a
 *    dead pane: every one of those is a `ProResult` with a code and a line in
 *    the projection's `herdr.error`. The bench with nothing installed is an
 *    install card, not a crash.
 *
 * Electron is not imported. The host, the timers, discovery, the socket
 * connect function and the process spawner are all injected, so the whole
 * service is testable as a plain object.
 */
import fs from 'node:fs'
import { applyPatch, type AppConfig, type ProConfig } from '../../shared/config'
import {
  isStatusEvent,
  parseStatusChange,
  type AgentInstance,
  type AgentStatus,
  type CreatedResult,
  type PaneReadResult,
  type Snapshot
} from '../../shared/herdr'
import { IPC } from '../../shared/ipcChannels'
import type { Agent, HookEvent, Lang, SteerResult, ThreadInfo } from '../../shared/protocol'
import type { ChatTranscript } from '../../shared/chat'
import type { BubbleMessage } from '../../shared/ui'
import {
  buildBench,
  groupKeyFor,
  groupLabelFor,
  handoffPrompt,
  needsMeCount,
  pathBase,
  planAttentionAction,
  rePromptText,
  resolveWorkdir,
  type AttentionExecution,
  type AttentionItem,
  type BenchView,
  type HerdrView,
  type LedgerDigest,
  type LedgerEntry,
  type LedgerKind,
  type ProvisionResult,
  type RecoveryPlan,
  type TaskBinding,
  type TaskRecord,
  type TaskStatus
} from '../../shared/pro'
import {
  failResult,
  okResult,
  parseProHost,
  parseProLedger,
  parseProPane,
  parseProRecovery,
  parseProSsh,
  parseProTask,
  type ProActionRequest,
  type ProCompanionPush,
  type ProFocusPush,
  type ProFramePush,
  type ProHostRequest,
  type ProLedgerRequest,
  type ProNoticePush,
  type ProPaneRequest,
  type ProRecoveryRequest,
  type ProResult,
  type ProSessionOpened,
  type ProSshKeys,
  type ProSshProbe,
  type ProSshRoster,
  type ProSshSetup,
  type ProSshRequest,
  type ProTaskRequest,
  type ImportCandidate
} from '../../shared/proIpc'
import { parseTarget, type SshMachine } from '../../shared/ssh'
import { TaskRegistry, type CreateTaskInput, type RegistryPatch } from './bench'
import { CompanionBridge, type AnnounceResult, type CompanionApi } from './companion'
import { benchFile, ensureProDirs, tasksDir } from './env'
import { homeDir } from '../env'
import { GitProbe, suggestBranch, type GitFacts } from './git'
import type { HerdrClient, ReadFormat, ReadSource } from './herdr/client'
import {
  describeDiscovery,
  discoverHerdr,
  fsListDir,
  fsPathExists,
  type ExistsFn,
  type HerdrTarget,
  type ListDirFn,
  type ResolveDeps
} from './herdr/discovery'
import { HerdrSession, type SessionChange, type SessionStatus } from './herdr/session'
import type { ConnectFn } from './herdr/socket'
import { HerdrLauncher, realServerSpawn } from './herdr/launcher'
import {
  TerminalBridge,
  type BridgeState,
  type SpawnFn,
  type WireFrame
} from './herdr/terminalBridge'
import { LedgerStore, type LedgerInput } from './ledger'
import { Recovery, type ApplyResult } from './recovery'
import { SshService } from './ssh'
import {
  emptyHint,
  paneReadHint,
  Triage,
  type TaskHint,
  type TaskRef,
  type TriageEvent
} from './triage'

/* ------------------------------------------------------------------ *
 * Host: the only surface that touches Electron
 * ------------------------------------------------------------------ */

/**
 * What the service may ask the app for. Narrow on purpose: `openBench` is the
 * only window verb, because a workbench that can focus arbitrary windows is a
 * workbench that can steal the keyboard from a terminal the human is typing in.
 */
export interface ProHost {
  config: () => AppConfig
  /** Absent in tests and in a read-only embed; config edits then fail cleanly. */
  updateConfig?: (patch: unknown) => Promise<AppConfig>
  lang: () => Lang
  /** Main -> renderer. One function so a test can capture every push. */
  emit: (channel: string, payload: unknown) => void
  bubble: (message: BubbleMessage) => void
  /** Must be the mute-respecting path (`Speaker.say`), never a forced one. */
  speak: (text: string, lang: Lang) => void
  speaking: () => boolean
  setWidget: (visible: boolean) => void
  widgetVisible: () => boolean
  benchFocused: () => boolean
  setBadge: (count: number) => void
  bubbleMs: () => number
  openBench: () => void
  /**
   * The other half of the mode switch: the bench goes away and the stage comes
   * forward, *with* focus, because this one is a human clicking "take me back"
   * rather than a notification arriving. Two window verbs, both of them ours.
   */
  openStage: () => void
  /**
   * The sessions the companion can already see (Codex and Claude Code history
   * on this machine). The bench reads it to offer imports; it never writes it.
   * Async because the honest list is read off disk, and the picker is opened by
   * a human who can wait twenty milliseconds.
   */
  listThreads: () => Promise<readonly ThreadInfo[]>
  /**
   * One session's conversation, read off the agent's own transcript file. The
   * bench needs it because a task it did not start has no pane: herdr owns the
   * PTYs of workspaces the bench provisioned, and an imported session is still
   * running in the human's own terminal. Without a reader the tree row is the
   * whole of what an import gives back.
   */
  readTranscript: (
    agent: Agent,
    threadId: string,
    options?: { limit?: number; fresh?: boolean }
  ) => ChatTranscript | null
  /** Answer that session. Never a keystroke into a pane we do not own. */
  steerThread: (agent: Agent, threadId: string, message: string) => Promise<SteerResult>
  pickDir: () => Promise<string>
  openPath: (path: string) => void
  /** Hand a link to the OS browser. The scheme allow-list already ran. */
  openExternal: (url: string) => void
  log: (level: string, message: string, extra?: unknown) => void
}

/* ------------------------------------------------------------------ *
 * Injectable collaborators
 * ------------------------------------------------------------------ */

export interface ServiceTimer {
  cancel: () => void
}

export interface ServiceTimers {
  after(cb: () => void, ms: number): ServiceTimer
  every(cb: () => void, ms: number): ServiceTimer
  now(): number
}

export const realServiceTimers: ServiceTimers = {
  after(cb, ms) {
    const handle = setTimeout(cb, ms)
    // The bench must never be the reason the app cannot quit.
    handle.unref?.()
    return { cancel: () => clearTimeout(handle) }
  },
  every(cb, ms) {
    const handle = setInterval(cb, ms)
    handle.unref?.()
    return { cancel: () => clearInterval(handle) }
  },
  now: () => Date.now()
}

/**
 * The subset of `HerdrClient` this service calls. Declared structurally so a
 * test can implement a fake without stubbing a socket, and so adding a method
 * here is a deliberate act rather than an accident of the class surface.
 */
export interface HerdrClientLike {
  listAgents(): Promise<AgentInstance[]>
  createWorkspace(input: {
    cwd?: string | null
    label?: string | null
    focus?: boolean
    env?: Record<string, string>
  }): Promise<CreatedResult>
  createWorktree(input: {
    cwd?: string | null
    branch?: string | null
    base?: string | null
    path?: string | null
    label?: string | null
    focus?: boolean
    trustRepository?: boolean
    workspaceId?: string | null
  }): Promise<CreatedResult>
  focusPane(paneId: string): Promise<boolean>
  zoomPane(paneId: string, mode?: 'toggle' | 'on' | 'off'): Promise<boolean>
  readPane(
    paneId: string,
    options?: { source?: ReadSource; lines?: number; format?: ReadFormat; stripAnsi?: boolean }
  ): Promise<PaneReadResult | null>
  sendText(paneId: string, text: string): Promise<boolean>
  sendKeys(paneId: string, keys: readonly string[]): Promise<boolean>
  startAgent(input: {
    name: string
    kind: string
    paneId: string
    args?: readonly string[]
    timeoutMs?: number
  }): Promise<AgentInstance | null>
  promptAgent(input: {
    target: string
    text: string
    wait?: { until?: readonly AgentStatus[]; timeoutMs?: number } | null
  }): Promise<AgentInstance | null>
}

export interface SessionLike {
  readonly client: HerdrClientLike
  readonly snapshot: Snapshot | null
  status(): SessionStatus
  onChange(listener: (change: SessionChange) => void): () => void
  start(): Promise<Snapshot | null>
  stop(): void
  refresh(): Promise<Snapshot | null>
}

export type SessionFactory = (socketPath: string) => SessionLike

/** Structural so a test can hold the registry in memory instead of on disk. */
export interface RegistryLike {
  load(force?: boolean): TaskRecord[]
  tasks(): TaskRecord[]
  get(taskId: string): TaskRecord | null
  save(): boolean
  create(input: CreateTaskInput): TaskRecord
  patch(taskId: string, patch: RegistryPatch): TaskRecord | null
  setStatus(taskId: string, status: TaskStatus): TaskRecord | null
  remove(taskId: string): boolean
  adopt(snapshot: Snapshot | null): ProvisionResult
  rebind(snapshot: Snapshot | null): TaskBinding[]
  /** Workspace ids a removal is still standing in front of. */
  forgotten(): string[]
  /** Record that the human removed this workspace; see `TaskRegistry.forget`. */
  forget(workspaceId: string, paneIds?: readonly string[]): void
  /** Drop remembered removals herdr has let go of, or that went stale. */
  reconcileForgotten(live: readonly string[]): void
}

export interface LedgerLike {
  entries(taskId: string): LedgerEntry[]
  digest(taskId: string): LedgerDigest | null
  allDigests(taskIds: readonly string[]): Record<string, LedgerDigest | null>
  append(input: LedgerInput, now?: number): LedgerEntry | null
  invalidate(taskId: string): void
}

export interface CompanionLike {
  announce(item: AttentionItem, view: BenchView | null): AnnounceResult
  announceRecovery(view: BenchView | null): string
  announceText(text: string, lang?: Lang): boolean
  sync(view: BenchView | null): ProCompanionPush
  clearAnnounce(itemId?: string): void
  dismissAll(): void
  shutdown(): void
  command(payload: unknown): Promise<ProResult>
  companionCommand(payload: unknown): ProResult
  state(): ProCompanionPush | null
  badge(): number
}

export type CompanionFactory = (api: CompanionApi) => CompanionLike

export interface ServiceIntervals {
  /** Reconcile the tracker against the cached snapshot; drives stall detection. */
  tickMs: number
  gitMs: number
  frameMs: number
  /** Coalescing window for projection pushes. */
  pushMs: number
  /** Debounce for announcements, so a burst becomes one bubble at a time. */
  announceMs: number
  /** Recovery plans are memoized for this long; they cost a statSync per task. */
  recoveryTtlMs: number
  hydrateMs: number
  /**
   * How long to wait between "herdr is online with a snapshot" and acting on
   * it. herdr restores its layout and resumes agents *after* the socket opens,
   * so the first frame can describe a pane that is about to exist; relaunching
   * what is already coming back is how you get two agents in one worktree.
   */
  bootResumeMs: number
  /**
   * Ceiling on unattended relaunches per connection. Not a guess about what a
   * machine can take - a registry of forty stale tasks must not become forty
   * agents - and the rest stay one click away in the recovery tab.
   */
  autoResumeMax: number
}

export interface ProServiceDeps {
  host: ProHost
  timers?: ServiceTimers
  intervals?: Partial<ServiceIntervals>
  discover?: (deps: ResolveDeps) => HerdrTarget
  /**
   * The probe the default discovery resolves its candidate lists with. Real by
   * default (`fsPathExists`); a test fakes it to lay out a herdr that is not
   * installed. It is a dep rather than a constant so that "discovery cannot see
   * the filesystem" stays a testable state instead of an invisible one.
   */
  exists?: ExistsFn
  /** The directory read discovery uses to name sessions it is not pointed at. */
  listDir?: ListDirFn
  /** Injected into `HerdrSession` and `HerdrClient`; a test fakes the socket. */
  connect?: ConnectFn
  spawn?: SpawnFn
  /**
   * Starts the headless herdr server when discovery finds a binary and no
   * socket. Injected so a test can assert "we spawned, once, with this env"
   * instead of leaving a daemon on the box.
   */
  launcher?: HerdrLauncher
  env?: () => Record<string, string | undefined>
  ensureDirs?: () => void
  registry?: RegistryLike
  ledger?: LedgerLike
  git?: GitProbe
  triage?: Triage
  recovery?: Recovery
  companion?: CompanionFactory
  session?: SessionFactory
  /**
   * The SSH roster (saved machines, `~/.ssh/config`, probes, keys). Injected so
   * a test never spawns a real `ssh` and never reads the developer's own
   * `~/.ssh`.
   */
  ssh?: SshService
}

const DEFAULT_INTERVALS: ServiceIntervals = {
  tickMs: 1000,
  gitMs: 5000,
  frameMs: 16,
  pushMs: 32,
  announceMs: 250,
  recoveryTtlMs: 2000,
  hydrateMs: 30000,
  bootResumeMs: 3000,
  autoResumeMax: 12
}

/** Backoff while herdr is not installed: visible quickly, then quiet. */
const REDISCOVER_MS = 2000
const MAX_REDISCOVER_MS = 30000
/** Announced-item memory is bounded; a long session must not grow it forever. */
const ANNOUNCED_MAX = 256
/** A focus request is only worth replaying to a window that just opened. */
const FOCUS_REPLAY_MS = 10000
/** How long `agent.prompt` may block waiting for the agent to wake up. */
const PROMPT_WAIT_MS = 8000
/** Pane reads feed `paneReadHint`; 40 lines is a screenful and a half. */
const READ_LINES = 40
/** Frame caps: a renderer that fell behind wants a resync, not a backlog. */
const MAX_FRAMES_PER_PANE = 24
const MAX_FRAMES_PER_PUSH = 96
/** Wall-clock bucket for the push signature, so a timer alone cannot repaint. */
const SIGNATURE_BUCKET_MS = 15000

/** herdr's own agent ids. Used when it cannot answer `agent.list` itself. */
const KNOWN_AGENT_KINDS: readonly string[] = [
  'codex',
  'claude',
  'copilot',
  'omp',
  'devin',
  'droid',
  'grok',
  'qwen'
]

/**
 * Which ledger kind a hook writes. `tool` and `subagent` are deliberately
 * absent: an agent that runs forty commands a minute would bury the goal and
 * the decisions, and the ledger exists so a task can be handed off, not so it
 * can be replayed.
 */
const HOOK_LEDGER: Readonly<Record<string, LedgerKind>> = {
  session_start: 'session',
  prompt: 'plan',
  stop: 'checkpoint',
  compact: 'checkpoint',
  permission: 'event',
  notification: 'event',
  interrupt: 'event',
  session_end: 'event'
}

const HOOK_FALLBACK_TEXT: Readonly<Record<string, string>> = {
  session_start: 'session started',
  session_end: 'session ended',
  stop: 'agent stopped',
  compact: 'context compacted',
  interrupt: 'interrupted',
  permission: 'permission requested',
  notification: 'notification'
}

/**
 * What the companion says after the unattended boot recovery ran: how many
 * interrupted tasks went back to work on their own, and how many are still
 * waiting for a hand. Silence when nothing was attempted - a boot line about
 * zero tasks is noise over a bench that merely came up clean.
 */
function autoResumeText(lang: Lang, ok: number, attempted: number, deferred: number): string {
  const more = deferred > 0
  if (lang === 'zh') {
    if (!ok) return `开机自动恢复未成功（${attempted} 个任务），请在恢复计划里手动处理`
    if (more) return `开机已自动恢复 ${ok} 个中断的任务，另有 ${deferred} 个需要在恢复计划里手动处理`
    return `开机已自动恢复 ${ok} 个中断的任务`
  }
  if (!ok) return `boot auto-resume could not apply ${attempted} task(s); see Recovery`
  if (more) {
    return `resumed ${ok} interrupted task(s) on boot; ${deferred} more need a click in Recovery`
  }
  return `resumed ${ok} interrupted task(s) on boot`
}

/**
 * Why an action could not run, in both languages. Codes are stable and the
 * renderer may localize off them; these strings are for the toast and the log.
 */
const NO_EXEC_TEXT: Readonly<Record<string, { zh: string; en: string }>> = {
  'no-recipe': {
    zh: '不认识这个 agent 的按键，请用文本回复或打开面板',
    en: 'No keystrokes known for this agent; answer in text or open the pane'
  },
  'no-pane': { zh: '这个任务现在没有活着的窗格', en: 'No live pane for this task right now' },
  'no-text': { zh: '回答需要文本', en: 'An answer needs text' },
  'no-context': { zh: '账本里没有可用的上下文', en: 'Nothing recorded to work from' },
  'unknown-action': { zh: '未知操作', en: 'Unknown action' }
}

const OFFLINE_TEXT = {
  zh: 'herdr 没有连接，无法操作窗格',
  en: 'herdr is not connected; the pane cannot be driven'
}

export class ProService implements CompanionApi {
  private readonly host: ProHost
  private readonly timers: ServiceTimers
  private readonly intervals: ServiceIntervals
  private readonly discoverFn: (deps: ResolveDeps) => HerdrTarget
  private readonly existsFn: ExistsFn
  private readonly listDirFn: ListDirFn
  private readonly connect: ConnectFn | undefined
  private readonly spawn: SpawnFn | undefined
  private readonly launcher: HerdrLauncher
  private readonly env: () => Record<string, string | undefined>
  private readonly ensureDirs: () => void
  private readonly makeSession: SessionFactory

  readonly registry: RegistryLike
  readonly ledger: LedgerLike
  readonly git: GitProbe
  readonly triage: Triage
  readonly recovery: Recovery
  readonly companion: CompanionLike
  readonly ssh: SshService

  private target: HerdrTarget = EMPTY_TARGET
  private session: SessionLike | null = null
  private sessionSocket = ''
  private unsubSession: (() => void) | null = null

  private readonly bridges = new Map<string, TerminalBridge>()
  private readonly announced = new Set<string>()
  private readonly lastGit = new Map<string, { head: string; branch: string; dirty: number }>()

  private cached: BenchView | null = null
  private lastSignature = ''
  private lastCompanionKey = ''
  private recoveryCache: RecoveryPlan[] | null = null
  private recoveryAt = 0
  /** The herdr availability the memo was computed under; see `recoveryPlans`. */
  private recoveryOnline = false
  private readonly viewers = new Set<(view: BenchView | null) => void>()

  private running = false
  private armingAt = 0
  private recoveryAnnounced = false
  private wasOnline = false
  /** A snapshot has been reconciled since the bridge came online. */
  private bootSnapshot = false
  /** One unattended recovery attempt per connection; see `autoResume`. */
  private autoResumeDone = false
  private gitBusy = false
  private hydrating = false
  private rediscoverMs = 0
  private appliedPro: ProConfig | null = null

  private lastFocus: ProFocusPush | null = null

  private tickTimer: ServiceTimer | null = null
  private gitTimer: ServiceTimer | null = null
  private hydrateTimer: ServiceTimer | null = null
  private frameTimer: ServiceTimer | null = null
  private pushTimer: ServiceTimer | null = null
  private announceTimer: ServiceTimer | null = null
  private rediscoverTimer: ServiceTimer | null = null
  private autoResumeTimer: ServiceTimer | null = null

  constructor(deps: ProServiceDeps) {
    this.host = deps.host
    this.timers = deps.timers ?? realServiceTimers
    this.intervals = { ...DEFAULT_INTERVALS, ...(deps.intervals ?? {}) }
    this.existsFn = deps.exists ?? fsPathExists
    this.listDirFn = deps.listDir ?? fsListDir
    this.discoverFn = deps.discover ?? ((input) => discoverHerdr(input))
    this.connect = deps.connect
    this.spawn = deps.spawn
    this.launcher =
      deps.launcher ??
      new HerdrLauncher({
        spawn: realServerSpawn,
        timers: this.timers,
        log: (level, message, meta) => this.host.log(level, message, meta)
      })
    this.env = deps.env ?? (() => process.env as Record<string, string | undefined>)

    // Only touch disk when we are the ones owning it: a test that injects both
    // stores must not create ~/.codewaifu as a side effect of constructing us.
    this.ensureDirs = deps.ensureDirs ?? (deps.registry && deps.ledger ? () => {} : ensureProDirs)
    this.registry =
      deps.registry ?? new TaskRegistry({ file: benchFile, now: () => this.timers.now() })
    this.ledger = deps.ledger ?? new LedgerStore(tasksDir)
    this.git = deps.git ?? new GitProbe({ now: () => this.timers.now() })
    this.ssh =
      deps.ssh ??
      new SshService({
        home: homeDir,
        platform: process.platform === 'win32' ? 'windows' : 'posix'
      })
    this.triage =
      deps.triage ??
      new Triage({
        now: () => this.timers.now(),
        resolveTask: (hint) => this.resolveTaskRef(hint),
        stalledAfterMs: this.host.config().pro.stalledAfterMs
      })
    this.recovery =
      deps.recovery ??
      new Recovery({
        herdr: () => (this.client() as HerdrClient | null) ?? null,
        snapshot: () => this.snapshot(),
        online: () => this.online()
      })
    this.makeSession =
      deps.session ??
      ((socketPath) =>
        new HerdrSession({ socketPath, connect: this.connect, timers: this.timers }))
    // The factory is *called*, not stored: the bridge is the thing the rest of
    // the service talks to, and its every dep closes over `this`, so handing it
    // ourselves as the `CompanionApi` is safe even though we are mid-constructor.
    const makeCompanion = deps.companion ?? ((api: CompanionApi) => this.defaultCompanion(api))
    this.companion = makeCompanion(this)

    this.appliedPro = this.proConfig()
    this.triage.onEvent((event) => this.onTriageEvent(event))
  }

  private defaultCompanion(api: CompanionApi): CompanionBridge {
    return new CompanionBridge({
      api,
      config: () => this.proConfig(),
      lang: () => this.host.lang(),
      bubble: (message) => this.host.bubble(message),
      speak: (text, lang) => this.host.speak(text, lang),
      speaking: () => this.host.speaking(),
      setWidget: (visible) => this.host.setWidget(visible),
      widgetVisible: () => this.host.widgetVisible(),
      benchFocused: () => this.host.benchFocused(),
      setBadge: (count) => this.host.setBadge(count),
      bubbleMs: () => this.host.bubbleMs(),
      openStage: () => this.host.openStage(),
      // Every push the bridge makes funnels through here, which is what lets a
      // single comparison decide whether the widget needs to hear about it.
      push: (state) => this.onCompanionPush(state),
      timers: this.timers
    })
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  /**
   * Boot. Idempotent, and a no-op while `pro.enabled` is off, which is what
   * keeps the pre-Pro companion bit-identical for anyone who does not want a
   * workbench. `applyConfig` can turn us on later without a restart.
   */
  async start(): Promise<void> {
    if (this.running) return
    this.registry.load()
    const cfg = this.proConfig()
    if (!cfg.enabled) {
      this.host.log('info', 'pro: disabled in config, bench not started')
      return
    }
    this.running = true
    // Anything already blocked when we boot is a condition, not an event: the
    // recovery line summarizes it, and she does not read a queue aloud.
    this.armingAt = this.timers.now()
    try {
      this.ensureDirs()
    } catch (error) {
      this.host.log('error', 'pro: cannot create its state directory', { error: String(error) })
    }
    this.armTimers()
    await this.discoverNow()
    this.emitState()
    if (cfg.openBenchOnLaunch) this.host.openBench()
  }

  shutdown(): void {
    const wasRunning = this.running
    this.running = false
    this.cancelTimers()
    this.stopPump()
    for (const bridge of this.bridges.values()) bridge.close()
    this.bridges.clear()
    // Nothing she points at may outlive the bench: a bubble offering "approve"
    // for a pane nobody is watching is a lie with a click target.
    this.companion.shutdown()
    this.detachSession()
    if (wasRunning) this.registry.save()
    this.cached = null
    this.lastSignature = ''
    // Last frame, so a terminal watching the bench prints "it went away"
    // instead of holding a stale tree that still looks live.
    if (wasRunning) this.notifyView(null)
  }

  get isRunning(): boolean {
    return this.running
  }

  /** What discovery resolved, for the install card and the settings stage. */
  get herdrTarget(): HerdrTarget {
    return this.target
  }

  sessionStatus(): SessionStatus | null {
    return this.session?.status() ?? null
  }

  private armTimers(): void {
    this.cancelTimers()
    this.tickTimer = this.timers.every(() => this.tick(), this.intervals.tickMs)
    this.gitTimer = this.timers.every(() => void this.gitSweep(), this.intervals.gitMs)
    this.hydrateTimer = this.timers.every(() => void this.hydrate(), this.intervals.hydrateMs)
  }

  private cancelTimers(): void {
    for (const timer of [
      this.tickTimer,
      this.gitTimer,
      this.hydrateTimer,
      this.pushTimer,
      this.announceTimer,
      this.rediscoverTimer,
      this.autoResumeTimer
    ]) {
      timer?.cancel()
    }
    this.tickTimer = null
    this.gitTimer = null
    this.hydrateTimer = null
    this.pushTimer = null
    this.announceTimer = null
    this.rediscoverTimer = null
    this.autoResumeTimer = null
  }

  /* ---------------------------------------------------------------- *
   * herdr discovery and session
   * ---------------------------------------------------------------- */

  client(): HerdrClientLike | null {
    return this.session?.client ?? null
  }

  snapshot(): Snapshot | null {
    return this.session?.snapshot ?? null
  }

  online(): boolean {
    return this.session?.status().online ?? false
  }

  /**
   * True while Pro is the one who will tell the user about an attention item.
   * `Core` asks this before speaking for a hook: two voices reading the same
   * permission prompt is noise, not redundancy. Off (rather than true-but-
   * silent) whenever we are not running or both ambient channels are muted, so
   * the legacy companion keeps covering events we would only have logged.
   */
  announcesAttention(): boolean {
    if (!this.running) return false
    const cfg = this.proConfig()
    return cfg.enabled && (cfg.speakAttention || cfg.bubbleAttention)
  }

  /**
   * Re-resolve both halves of "where is herdr". Called at boot, on a timer
   * while it is missing (a human installing herdr should not have to restart
   * the app), and whenever settings change the binary, socket or session.
   */
  private async discoverNow(): Promise<void> {
    const cfg = this.proConfig()
    let target: HerdrTarget
    try {
      target = this.discoverFn({
        env: this.env(),
        exists: this.existsFn,
        listDir: this.listDirFn,
        binaryPath: cfg.herdrPath,
        socketPath: cfg.socketPath,
        session: cfg.herdrSession
      })
    } catch (error) {
      this.host.log('error', 'pro: herdr discovery threw', { error: String(error) })
      target = EMPTY_TARGET
    }
    this.target = target

    if (!target.socketPath) {
      // No server to talk to. Drop the session so the projection says offline
      // instead of showing a snapshot from a socket that is gone.
      this.detachSession()
      // After a reboot this is the whole state of the world: a binary, no
      // socket, and nothing else on the box that will start one. The loop below
      // would otherwise keep re-announcing that fact instead of fixing it.
      if (cfg.autoStartHerdr) {
        this.launcher.ensure({
          target,
          session: cfg.herdrSession,
          socketPath: cfg.socketPath,
          env: this.env()
        })
      }
      this.rediscoverMs = this.rediscoverMs
        ? Math.min(MAX_REDISCOVER_MS, this.rediscoverMs * 2)
        : REDISCOVER_MS
      this.armRediscover()
      this.invalidate()
      return
    }
    this.rediscoverMs = 0
    // It is up, whether we started it or a human did: the attempt history is
    // about the outage that just ended, and the next one starts from zero.
    this.launcher.reset()
    this.rediscoverTimer?.cancel()
    this.rediscoverTimer = null
    if (this.session && this.sessionSocket === target.socketPath) {
      this.invalidate()
      return
    }
    await this.attachSession(target.socketPath)
  }

  private armRediscover(): void {
    this.rediscoverTimer?.cancel()
    this.rediscoverTimer = this.timers.after(() => {
      this.rediscoverTimer = null
      if (this.running) void this.discoverNow()
    }, this.rediscoverMs)
  }

  /** Settings moved us to another herdr: forget everything and start over. */
  private async rediscover(): Promise<void> {
    this.detachSession()
    this.rediscoverMs = 0
    this.git.invalidate()
    await this.discoverNow()
  }

  private async attachSession(socketPath: string): Promise<void> {
    this.detachSession()
    const session = this.makeSession(socketPath)
    this.session = session
    this.sessionSocket = socketPath
    this.unsubSession = session.onChange((change) => this.onSessionChange(change))
    let snapshot: Snapshot | null = null
    try {
      snapshot = await session.start()
    } catch (error) {
      this.host.log('warn', 'pro: herdr session failed to start', { error: String(error) })
    }
    // Settings may have moved us on while that was in flight; a session we no
    // longer own must be stopped rather than left subscribed in the background.
    if (this.session !== session) {
      session.stop()
      return
    }
    if (snapshot) this.onSnapshotArrived(snapshot)
    this.invalidate()
  }

  private detachSession(): void {
    this.unsubSession?.()
    this.unsubSession = null
    this.session?.stop()
    this.session = null
    this.sessionSocket = ''
    this.wasOnline = false
    // A new connection earns a new unattended attempt; see armAutoResume.
    this.bootSnapshot = false
    this.autoResumeDone = false
    this.cancelAutoResume()
  }

  private onSessionChange(change: SessionChange): void {
    switch (change.type) {
      case 'event': {
        if (!isStatusEvent(change.event.event)) return
        const parsed = parseStatusChange(change.event.data)
        if (!parsed) return
        this.triage.onStatusChange(parsed)
        this.invalidate()
        return
      }
      case 'snapshot':
        if (change.snapshot) this.onSnapshotArrived(change.snapshot)
        this.invalidate()
        return
      case 'status': {
        const online = change.status.online
        if (online && !this.wasOnline) {
          this.wasOnline = true
          this.git.invalidate()
          this.announceBoot()
          this.armAutoResume()
        } else if (!online && this.wasOnline) {
          this.wasOnline = false
          // A herdr restart is exactly when "three tasks can be resumed"
          // matters, so the boot line is per-connection, not per-process.
          this.recoveryAnnounced = false
          this.bootSnapshot = false
          this.autoResumeDone = false
          this.cancelAutoResume()
        }
        this.invalidate()
        return
      }
    }
  }

  private announceBoot(): void {
    if (this.recoveryAnnounced) return
    this.recoveryAnnounced = true
    const text = this.companion.announceRecovery(this.rebuild())
    if (text) this.host.log('info', `pro: ${text}`)
  }

  /**
   * Arm the one unattended recovery attempt this connection gets.
   *
   * herdr restores its own panes when it comes back and we adopt them, but a
   * task whose pane did not survive - machine reboot, herdr upgrade, an agent
   * that died with the old pane - stays `lost` until a human clicks Apply.
   * "Open the app and it is already working again" needs a click without a
   * hand: once per connection, once the bridge is online AND a snapshot has
   * been reconciled (a status event alone proves nothing about panes), apply
   * the actionable plans after a short settle.
   *
   * `actionable` is exactly "no live pane to reuse": planRecovery answers it
   * false for `intact` (pane alive), `parked`, `done` and `offline`. That is
   * the whole safety argument - a pane herdr restored with a live agent in
   * it is never touched here, because herdr's agent detection reads screen
   * content and a false negative would start a second agent in one worktree.
   * Those tasks stay one click away in the recovery tab.
   */
  private armAutoResume(): void {
    if (!this.running || this.autoResumeDone || this.autoResumeTimer) return
    if (!this.proConfig().autoResumeOnBoot) return
    if (!this.online() || !this.bootSnapshot) return
    this.autoResumeTimer = this.timers.after(() => {
      this.autoResumeTimer = null
      void this.autoResume()
    }, this.intervals.bootResumeMs)
  }

  private cancelAutoResume(): void {
    this.autoResumeTimer?.cancel()
    this.autoResumeTimer = null
  }

  private async autoResume(): Promise<void> {
    if (this.autoResumeDone) return
    this.autoResumeDone = true
    if (!this.running || !this.online()) return
    // The snapshot that armed this is seconds old by now; a pane herdr
    // restored late would otherwise read as "no pane" and be given a second
    // one. One refresh closes that window.
    try {
      const fresh = await this.session?.refresh()
      if (fresh) this.onSnapshotArrived(fresh)
    } catch (error) {
      this.host.log('warn', 'pro: pre-resume refresh failed', { error: String(error) })
    }
    if (!this.online()) return
    const plans = this.recoveryPlans(true).filter((plan) => plan.actionable)
    if (!plans.length) return
    const take = plans.slice(0, Math.max(1, this.intervals.autoResumeMax))
    const results = await this.applyPlans(take, 'boot')
    const ok = results.filter((result) => result.ok).length
    const deferred = plans.length - take.length
    const lang = this.host.lang()
    this.companion.announceText(autoResumeText(lang, ok, take.length, deferred), lang)
    this.host.log('info', 'pro: boot auto-resume applied', {
      ok,
      attempted: take.length,
      deferred
    })
  }

  /** Apply plans in order, recording each exactly the way a click does. */
  private async applyPlans(
    plans: RecoveryPlan[],
    source: 'recovery' | 'boot'
  ): Promise<ApplyResult[]> {
    const results: ApplyResult[] = []
    for (const plan of plans) {
      const task = this.registry.get(plan.taskId)
      if (!task) continue
      const applied = await this.recovery.apply(plan, task)
      this.afterApply(applied, task, source)
      results.push(applied)
    }
    return results
  }

  /* ---------------------------------------------------------------- *
   * Snapshot reconciliation
   * ---------------------------------------------------------------- */

  /**
   * One snapshot, four consequences, in the order that keeps them consistent:
   * adopt what herdr already had, re-bind what we already knew, record the
   * session ids that make a task resumable, then let the tracker reconcile.
   */
  private onSnapshotArrived(snapshot: Snapshot): void {
    // Before `adopt`, so the list adoption consults is the one herdr has
    // already agreed with: a removal it has caught up to stops blocking its id.
    this.registry.reconcileForgotten(snapshot.workspaces.map((workspace) => workspace.workspaceId))
    this.registry.adopt(snapshot)
    this.registry.rebind(snapshot)
    this.captureSessions(snapshot)
    this.triage.onSnapshot(snapshot)
    this.triage.resync(new Set(this.registry.tasks().map((task) => task.id)))
    this.invalidate()
    // A reconciled snapshot is the second half of the boot gate: it is what
    // makes the recovery plans honest about which panes exist.
    this.bootSnapshot = true
    this.armAutoResume()
  }

  /**
   * Lift `pane.agentSession` into the task record and the ledger.
   *
   * This is the highest-value write in the whole product: a session id is the
   * difference between "rebuild this task from scratch" and "resume the
   * conversation the human already paid for". It runs on every snapshot because
   * an agent only reports its id once it is up, which is after the pane exists.
   */
  private captureSessions(snapshot: Snapshot): void {
    const tasks = this.registry.tasks()
    if (!tasks.length) return
    const byPane = new Map<string, TaskRecord>()
    const byWorkspace = new Map<string, TaskRecord>()
    const byCwd = new Map<string, TaskRecord>()
    for (const task of tasks) {
      for (const paneId of task.paneIds) if (!byPane.has(paneId)) byPane.set(paneId, task)
      if (task.workspaceId && !byWorkspace.has(task.workspaceId)) {
        byWorkspace.set(task.workspaceId, task)
      }
      for (const dir of [task.workdir, task.repoRoot]) {
        if (dir && !byCwd.has(dir)) byCwd.set(dir, task)
      }
    }

    // `patch` replaces the record object, so the maps above go stale the moment
    // we write. Track what this pass already applied instead of re-reading.
    const applied = new Map<string, string>()
    let changed = false
    for (const pane of snapshot.panes) {
      const ref = pane.agentSession
      if (!ref || ref.kind !== 'id' || !ref.value) continue
      const dir = pane.foregroundCwd || pane.cwd
      const task = byPane.get(pane.paneId) ?? byWorkspace.get(pane.workspaceId) ?? byCwd.get(dir)
      if (!task) continue
      if (task.agentSessionId === ref.value || applied.get(task.id) === ref.value) continue
      applied.set(task.id, ref.value)
      const patch: RegistryPatch = { agentSessionId: ref.value }
      if (!task.agentKind && ref.agent) patch.agentKind = ref.agent.toLowerCase()
      this.registry.patch(task.id, patch)
      this.ledger.append(
        {
          taskId: task.id,
          kind: 'session',
          agent: ref.agent || task.agentKind,
          sessionKind: 'id',
          sessionValue: ref.value,
          paneId: pane.paneId,
          workspaceId: pane.workspaceId,
          source: 'herdr'
        },
        this.timers.now()
      )
      changed = true
    }
    if (changed) this.registry.save()
  }

  /* ---------------------------------------------------------------- *
   * Hooks
   * ---------------------------------------------------------------- */

  /**
   * The entry point the existing hook server calls. Returns the item only when
   * it is a genuinely new need, so the caller can tell "recorded" from "raised".
   */
  onHook(event: HookEvent): AttentionItem | null {
    if (!this.running || !event) return null
    const hint: TaskHint = {
      ...emptyHint(),
      sessionId: event.sessionId,
      transcriptPath: event.transcriptPath,
      cwd: event.cwd,
      agent: event.agent === 'unknown' ? '' : event.agent
    }
    // The tracker fires `raised`/`updated` through onTriageEvent, which is what
    // schedules the announcement; we only add the durable half here.
    const raised = this.triage.onHook(event)
    this.recordHook(event, hint)
    this.invalidate()
    return raised
  }

  private recordHook(event: HookEvent, hint: TaskHint): void {
    const ref = this.resolveTaskRef(hint)
    if (!ref) return
    const taskId = ref.taskId
    const agent = event.agent === 'unknown' ? '' : event.agent

    if (event.sessionId) {
      const task = this.registry.get(taskId)
      // A hook is better evidence than a pane scrape, so it wins even when the
      // snapshot already gave us a different id.
      if (task && task.agentSessionId !== event.sessionId) {
        this.registry.patch(taskId, {
          agentSessionId: event.sessionId,
          agentKind: task.agentKind || agent
        })
        this.registry.save()
        // Only a *new* session id is worth a line: every hook carries one, and
        // writing it each time would bury the goal under forty identical rows.
        this.ledger.append(
          {
            taskId,
            kind: 'session',
            agent,
            sessionKind: 'id',
            sessionValue: event.sessionId,
            paneId: hint.paneId,
            source: 'hook'
          },
          this.timers.now()
        )
      }
    }

    const kind = HOOK_LEDGER[event.kind]
    if (!kind) return
    const text = hookText(event)
    if (!text) return
    this.ledger.append(
      { taskId, kind, text, agent, paneId: hint.paneId, workspaceId: hint.workspaceId, source: 'hook' },
      this.timers.now()
    )
  }

  /* ---------------------------------------------------------------- *
   * Task resolution
   * ---------------------------------------------------------------- */

  /**
   * Map a signal onto a task. Ordered by how much the evidence proves: a
   * session id is unique to a conversation, a pane id is unique to a terminal,
   * a workspace is unique to a directory, and a cwd is a guess that two
   * checkouts of the same repo can both satisfy.
   */
  private resolveTaskRef(hint: TaskHint): TaskRef | null {
    const tasks = this.registry.tasks()
    if (!tasks.length) return null
    const bySession = hint.sessionId
      ? tasks.find((task) => task.agentSessionId && task.agentSessionId === hint.sessionId)
      : undefined
    const byPane = hint.paneId ? tasks.find((task) => task.paneIds.includes(hint.paneId)) : undefined
    const byWorkspace = hint.workspaceId
      ? tasks.find((task) => task.workspaceId && task.workspaceId === hint.workspaceId)
      : undefined
    const byCwd = hint.cwd
      ? tasks.find((task) => sameDir(task.workdir, hint.cwd) || sameDir(task.repoRoot, hint.cwd))
      : undefined
    const task = bySession ?? byPane ?? byWorkspace ?? byCwd
    if (!task) return null
    return {
      taskId: task.id,
      title: task.title,
      groupLabel: groupLabelFor(groupKeyFor(task)),
      agentKind: task.agentKind || hint.agent,
      paneId:
        hint.paneId && task.paneIds.includes(hint.paneId) ? hint.paneId : (task.paneIds[0] ?? ''),
      paneIds: task.paneIds.slice(),
      workspaceId: task.workspaceId || hint.workspaceId
    }
  }

  /* ---------------------------------------------------------------- *
   * The projection
   * ---------------------------------------------------------------- */

  /** The one projection. `null` while Pro is off, so callers can hide cleanly. */
  view(): BenchView | null {
    if (!this.running) return null
    return this.cached ?? this.rebuild()
  }

  /**
   * Subscribe to the projection, for the callers that are not the window: the
   * relay hands one of these to every `GET /pro/stream` watcher.
   *
   * Notified from `emitState`, which is where the signature dedupe already
   * lives, so a pane repainting several times a second does not become a
   * firehose down a socket. `null` arrives once, on shutdown, because a watcher
   * that keeps printing the last view after the bench is gone is reporting a
   * world that no longer exists. The return value is its own unsubscribe: a
   * subscriber that outlives its connection is a leak the server cannot see.
   */
  onChange(listener: (view: BenchView | null) => void): () => void {
    this.viewers.add(listener)
    return () => {
      this.viewers.delete(listener)
    }
  }

  private notifyView(view: BenchView | null): void {
    for (const listener of [...this.viewers]) {
      try {
        listener(view)
      } catch (error) {
        // A watcher's socket is not the bench's business, and one broken
        // consumer must not stop the projection reaching the window.
        this.host.log('error', 'pro: a view subscriber threw', { error: String(error) })
      }
    }
  }

  private rebuild(): BenchView {
    const now = this.timers.now()
    const tasks = this.registry.tasks()
    const attention = this.triage.items()
    const view = buildBench({
      now,
      herdr: this.herdrView(),
      snapshot: this.snapshot(),
      tasks,
      attention,
      digests: this.ledger.allDigests(tasks.map((task) => task.id)),
      recovery: this.recoveryPlans(),
      attachedPanes: [...this.bridges.keys()],
      blockedSince: this.triage.blockedSinceMap(),
      companion: {
        visible: this.host.widgetVisible(),
        notices: needsMeCount(attention, now)
      }
    })
    this.cached = view
    return view
  }

  private herdrView(): HerdrView {
    const status = this.session?.status() ?? null
    const snapshot = this.snapshot()
    const online = status?.online ?? false
    let error = ''
    if (!online) {
      if (status?.error) {
        const retry = status.reconnectInMs > 0 ? ` (retry in ${Math.ceil(status.reconnectInMs / 1000)}s)` : ''
        error = `${status.error}${retry}`
      } else {
        // The install card text: what we looked for and what was missing.
        error = describeDiscovery(this.target, this.host.lang())
      }
      // "herdr is not running" over a server we are starting right now is a card
      // telling the human to do the thing already in flight, so say which it is.
      const starting = this.launcher.describe(this.host.lang(), this.target)
      if (starting) error = error ? `${error} (${starting})` : starting
    }
    return {
      online,
      version: status?.version ?? '',
      socketPath: status?.socketPath || this.target.socketPath || '',
      error,
      workspaces: snapshot?.workspaces.length ?? 0,
      panes: snapshot?.panes.length ?? 0
    }
  }

  /**
   * Recovery plans cost a statSync per task, so they are memoized briefly.
   *
   * The memo is keyed on herdr's availability as well as on the clock, because
   * availability is an input to every verdict: `planRecovery` answers `offline`
   * while the bridge is down and a real verdict once it is up. A TTL alone lets
   * the two straddle a reconnect - the plans computed while herdr was down are
   * still fresh when herdr coming back triggers the rebuild, and on a quiet
   * bench nothing invalidates again, so the recovery tab keeps saying "herdr is
   * not running" over a task that is merely lost. Indefinitely, in the one
   * projection whose whole job is to be read right after a restart.
   */
  private recoveryPlans(force = false): RecoveryPlan[] {
    const now = this.timers.now()
    const online = this.online()
    if (
      !force &&
      this.recoveryCache &&
      this.recoveryAt &&
      this.recoveryOnline === online &&
      now - this.recoveryAt < this.intervals.recoveryTtlMs
    ) {
      return this.recoveryCache
    }
    const tasks = this.registry.tasks()
    const plans = this.recovery.planAll(tasks, this.ledger.allDigests(tasks.map((task) => task.id)))
    this.recoveryCache = plans
    this.recoveryAt = now
    this.recoveryOnline = online
    return plans
  }

  private invalidate(): void {
    this.cached = null
    this.schedulePush()
  }

  private schedulePush(): void {
    if (!this.running || this.pushTimer) return
    this.pushTimer = this.timers.after(() => {
      this.pushTimer = null
      this.emitState()
    }, this.intervals.pushMs)
  }

  /**
   * Push only what changed. A terminal pane produces a snapshot event several
   * times a second, and a renderer that re-lays-out a 40-row tree for a
   * wall-clock tick is a workbench that feels slow for no reason.
   */
  private emitState(): void {
    if (!this.running) return
    const view = this.cached ?? this.rebuild()
    const signature = signatureOf(view)
    if (signature !== this.lastSignature) {
      this.lastSignature = signature
      this.host.emit(IPC.pushProState, view)
      this.notifyView(view)
    }
    // Always sync the widget: the badge is the one number that answers "do I
    // have to go back?", and it must not lag because the tree did not change.
    this.companion.sync(view)
  }

  private onCompanionPush(state: ProCompanionPush): void {
    // `at` changes every call, so it cannot be part of the comparison.
    const key = [
      state.notices,
      state.expression,
      state.benchFocused ? 1 : 0,
      state.widgetVisible ? 1 : 0,
      state.announcing,
      state.counts.working,
      state.counts.blocked,
      state.counts.done,
      state.counts.idle,
      state.counts.unknown,
      state.counts.needsMe,
      state.counts.total
    ].join('|')
    if (key === this.lastCompanionKey) return
    this.lastCompanionKey = key
    this.host.emit(IPC.pushProCompanion, state)
  }

  /** Called by the host on bench focus/blur and widget show/hide. */
  refreshCompanion(): void {
    if (!this.running) return
    this.companion.sync(this.cached ?? this.rebuild())
  }

  /* ---------------------------------------------------------------- *
   * Timers
   * ---------------------------------------------------------------- */

  private tick(): void {
    if (!this.running) return
    // Idempotent, and the only thing that drives stall detection between
    // snapshots: a hung pane produces no events at all.
    this.triage.onSnapshot(this.snapshot())
    this.pruneAnnounced()
    this.armAnnounce()
    this.schedulePush()
  }

  /** Fill in items herdr raised blind, one screenful at a time. */
  private async hydrate(): Promise<void> {
    const client = this.client()
    if (!client || this.hydrating) return
    this.hydrating = true
    try {
      const filled = await this.triage.hydrate(async (item) => {
        if (!item.paneId) return null
        const read = await client
          .readPane(item.paneId, {
            source: 'detection',
            lines: READ_LINES,
            format: 'text',
            stripAnsi: true
          })
          .catch(() => null)
        return read ? paneReadHint(read.text, item.kind) : null
      })
      if (filled) this.invalidate()
    } finally {
      this.hydrating = false
    }
  }

  /**
   * Git facts per task, on a slow timer.
   *
   * The ledger records *transitions*, not readings: a commit landing and a
   * clean tree becoming dirty are both things a handoff has to mention, while
   * a dirty count wobbling from 7 to 8 is noise that would push the goal off
   * the digest. The current numbers still reach the UI, through the registry
   * patch and this map.
   */
  private async gitSweep(): Promise<void> {
    if (!this.running || this.gitBusy) return
    this.gitBusy = true
    try {
      const tasks = this.registry.tasks().filter((task) => task.status !== 'done')
      let patched = false
      await Promise.all(
        tasks.map(async (task) => {
          const dir = task.workdir || task.repoRoot
          if (!dir) return
          const facts = await this.git.facts(dir).catch(() => null)
          if (!facts || !facts.repo) return
          const prior = this.lastGit.get(task.id)
          this.lastGit.set(task.id, { head: facts.head, branch: facts.branch, dirty: facts.dirty })

          const patch: RegistryPatch = {}
          if (!task.repoRoot && facts.repoRoot) patch.repoRoot = facts.repoRoot
          if (!task.branch && facts.branch) patch.branch = facts.branch
          if (Object.keys(patch).length) {
            this.registry.patch(task.id, patch)
            patched = true
          }

          // The first reading is a baseline, not an event: booting the bench
          // must not write a line into every task's history.
          if (!prior) return
          const headChanged = Boolean(facts.head) && prior.head !== facts.head
          const dirtyFlipped = (prior.dirty === 0) !== (facts.dirty === 0)
          if (!headChanged && !dirtyFlipped) return
          this.ledger.append(
            {
              taskId: task.id,
              kind: 'git',
              text: gitText(facts, headChanged),
              gitHead: facts.head,
              branch: facts.branch,
              dirty: facts.dirty,
              source: 'git'
            },
            this.timers.now()
          )
          this.invalidate()
        })
      )
      if (patched) {
        this.registry.save()
        this.invalidate()
      }
    } finally {
      this.gitBusy = false
    }
  }

  /* ---------------------------------------------------------------- *
   * Announcing (F7)
   * ---------------------------------------------------------------- */

  private onTriageEvent(event: TriageEvent): void {
    switch (event.type) {
      case 'raised':
        this.invalidate()
        this.scheduleAnnounce()
        return
      case 'resolved':
      case 'dropped': {
        const id = event.type === 'resolved' ? event.item.id : event.itemId
        this.announced.delete(id)
        // Invalidate first: clearAnnounce re-syncs the widget off `view()`, and
        // a sync against the pre-resolution queue would put the badge back.
        this.invalidate()
        this.companion.clearAnnounce(id)
        return
      }
      case 'updated':
      case 'snoozed':
        this.invalidate()
        return
    }
  }

  private scheduleAnnounce(): void {
    if (!this.running || this.announceTimer) return
    this.announceTimer = this.timers.after(() => {
      this.announceTimer = null
      this.announceNext()
    }, this.intervals.announceMs)
  }

  /**
   * Re-arm after a bubble's lifetime ends. The tick is what sequences a burst:
   * one item per bubble, so four agents blocking at once is four lines she says
   * in turn rather than one wall of overlapping speech.
   */
  private armAnnounce(): void {
    if (this.announceTimer) return
    if (this.companion.state()?.announcing) return
    const view = this.cached ?? this.rebuild()
    const now = this.timers.now()
    if (!view.attention.some((item) => this.announceable(item, now))) return
    this.scheduleAnnounce()
  }

  private announceable(item: AttentionItem, now: number): boolean {
    if (item.resolved) return false
    if (item.snoozedUntil > now) return false
    if (item.since < this.armingAt) return false
    return !this.announced.has(item.id)
  }

  private announceNext(): void {
    if (!this.running) return
    const view = this.rebuild()
    const now = this.timers.now()
    for (const item of view.attention) {
      if (item.resolved) continue
      // A need that predates this boot is a condition, not news. It is still
      // in the queue and still on the badge; she just does not read it aloud.
      if (item.since < this.armingAt) {
        this.announced.add(item.id)
        continue
      }
      if (item.snoozedUntil > now) continue
      if (this.announced.has(item.id)) continue
      this.announced.add(item.id)
      this.companion.announce(item, view)
      this.invalidate()
      return
    }
  }

  private pruneAnnounced(): void {
    if (this.announced.size <= ANNOUNCED_MAX) return
    const view = this.cached ?? this.rebuild()
    const live = new Set(view.attention.map((item) => item.id))
    for (const id of [...this.announced]) {
      if (!live.has(id)) this.announced.delete(id)
    }
  }

  /* ---------------------------------------------------------------- *
   * Attention actions: the one executor
   * ---------------------------------------------------------------- */

  /**
   * Run one action. Bench button, widget bubble and `POST /pro/answer` all
   * arrive here, so there is a single audit trail: every verb that reaches an
   * agent also writes a `decision` line into that task's ledger.
   */
  async act(request: ProActionRequest): Promise<ProResult> {
    if (!this.running) return failResult('not-running', 'the bench is not running')
    const item = this.findItem(request.itemId)
    if (!item) return failResult('no-item', `attention item ${request.itemId} is gone`)
    const execution = planAttentionAction({
      item,
      action: request.action,
      text: request.text,
      now: this.timers.now(),
      keys: this.proConfig().keys,
      snoozeMinutes: request.minutes,
      task: this.registry.get(item.taskId),
      digest: this.ledger.digest(item.taskId)
    })
    return this.execute(execution, item, request)
  }

  private findItem(itemId: string): AttentionItem | null {
    return this.triage.get(itemId) ?? this.view()?.attention.find((item) => item.id === itemId) ?? null
  }

  private async execute(
    execution: AttentionExecution,
    item: AttentionItem,
    request: ProActionRequest
  ): Promise<ProResult> {
    switch (execution.kind) {
      case 'none': {
        // Visible, always. A button that silently does nothing is worse than a
        // button that does not exist.
        this.notice(this.text(NO_EXEC_TEXT[execution.code]), 'warn')
        return failResult(execution.code, execution.reason)
      }
      case 'keys': {
        const client = this.client()
        if (!client) return this.offline()
        const sent = await client.sendKeys(execution.paneId, execution.keys).catch(() => false)
        if (!sent) return this.sendFailed(execution.paneId, 'keystrokes')
        this.triage.resolve(execution.itemId, `acted:${request.action}`)
        this.recordDecision(item, request, `${request.action} (${execution.preview})`)
        this.invalidate()
        return okResult(
          { itemId: execution.itemId, paneId: execution.paneId, keys: execution.keys },
          execution.preview,
          'sent'
        )
      }
      case 'prompt': {
        const client = this.client()
        if (!client) return this.offline()
        const sent = await this.sendToPane(client, execution.paneId, execution.text)
        if (!sent) return this.sendFailed(execution.paneId, 'text')
        this.triage.resolve(execution.itemId, `acted:${request.action}`)
        this.recordDecision(item, request, execution.text)
        this.invalidate()
        return okResult(
          { itemId: execution.itemId, paneId: execution.paneId },
          '',
          'sent'
        )
      }
      case 'focus': {
        const client = this.client()
        if (client) await client.focusPane(execution.paneId).catch(() => false)
        // Deliberately not a resolve: looking at a pane changes nothing about
        // whether it is waiting, and a queue that empties when you look at it
        // is a queue you cannot trust.
        this.focusBench(execution.taskId, execution.paneId, 'attention')
        this.invalidate()
        return okResult(
          { itemId: execution.itemId, taskId: execution.taskId, paneId: execution.paneId },
          '',
          'focused'
        )
      }
      case 'snooze': {
        this.triage.snooze(execution.itemId, execution.until)
        this.recordDecision(item, request, `snoozed ${execution.minutes}m`)
        this.invalidate()
        return okResult(
          { itemId: execution.itemId, minutes: execution.minutes, until: execution.until },
          '',
          'snoozed'
        )
      }
      case 'resolve': {
        if (execution.status === 'done' && execution.taskId) {
          this.registry.setStatus(execution.taskId, 'done')
          const count = this.triage.resolveTaskItems(execution.taskId, 'task marked done')
          this.ledger.append(
            { taskId: execution.taskId, kind: 'checkpoint', text: 'marked done', source: request.origin },
            this.timers.now()
          )
          this.registry.save()
          this.invalidate()
          return okResult({ itemId: execution.itemId, taskId: execution.taskId, count }, '', 'done')
        }
        this.triage.resolve(execution.itemId, `acted:${request.action}`)
        this.recordDecision(item, request, request.action)
        this.invalidate()
        return okResult({ itemId: execution.itemId }, '', execution.status)
      }
    }
  }

  /**
   * Deliver free text to a pane.
   *
   * One implementation for every text verb in the product (queue Answer,
   * widget answer, re-prompt, task creation), because "how do I make this TUI
   * submit a line" has exactly one right answer per agent and getting it twice
   * is how a pane ends up with the same sentence typed into it twice.
   */
  private async sendToPane(client: HerdrClientLike, paneId: string, text: string): Promise<boolean> {
    const agent = this.agentForPane(paneId)
    if (agent) {
      try {
        // `agent.prompt` knows how this TUI submits, and `wait` means we report
        // success only once the agent has actually picked the text up.
        await client.promptAgent({
          target: agent.name || paneId,
          text,
          wait: { until: ['working', 'blocked', 'done'], timeoutMs: PROMPT_WAIT_MS }
        })
        return true
      } catch (error) {
        // Thrown means the call did not land, so falling back cannot double-send.
        this.host.log('warn', 'pro: agent.prompt failed, falling back to raw pane input', {
          paneId,
          error: String(error)
        })
      }
    }
    const sent = await client.sendText(paneId, text).catch(() => false)
    if (!sent) return false
    return client.sendKeys(paneId, ['enter']).catch(() => false)
  }

  private agentForPane(paneId: string): AgentInstance | null {
    if (!paneId) return null
    return this.snapshot()?.agents.find((agent) => agent.paneId === paneId) ?? null
  }

  private recordDecision(item: AttentionItem, request: ProActionRequest, text: string): void {
    if (!item.taskId) return
    this.ledger.append(
      {
        taskId: item.taskId,
        kind: 'decision',
        text: clipText(text, 400),
        agent: item.agentKind,
        paneId: item.paneId,
        workspaceId: item.workspaceId,
        source: request.origin
      },
      this.timers.now()
    )
  }

  /* ---------------------------------------------------------------- *
   * Tasks
   * ---------------------------------------------------------------- */

  async taskOp(request: ProTaskRequest): Promise<ProResult> {
    if (!this.running) return failResult('not-running', 'the bench is not running')
    switch (request.op) {
      case 'create':
        return this.createTask(request)
      case 'patch': {
        const patch: RegistryPatch = {}
        if (request.title) patch.title = request.title
        if (request.goal) patch.goal = request.goal
        if (request.branch) patch.branch = request.branch
        if (!Object.keys(patch).length) return failResult('bad-payload', 'nothing to change')
        const task = this.registry.patch(request.taskId, patch)
        if (!task) return this.noTask(request.taskId)
        this.registry.save()
        this.invalidate()
        return okResult({ task }, '', 'patched')
      }
      case 'status': {
        const task = this.registry.setStatus(request.taskId, request.status)
        if (!task) return this.noTask(request.taskId)
        // A parked or finished task's queue is nobody's problem; leaving it
        // there would put a number on the badge that cannot be acted on.
        if (request.status !== 'active') {
          this.triage.resolveTaskItems(request.taskId, `task ${request.status}`)
        }
        this.ledger.append(
          { taskId: request.taskId, kind: 'event', text: `marked ${request.status}`, source: 'gui' },
          this.timers.now()
        )
        this.registry.save()
        this.invalidate()
        return okResult({ task }, '', request.status)
      }
      case 'remove': {
        const task = this.registry.get(request.taskId)
        if (!task) return this.noTask(request.taskId)
        // Remembered before the row goes. Dropping the row used to be the whole
        // operation, and adoption undid it: the pane keeps running (that is what
        // the confirmation promises), so the next snapshot saw a workspace
        // nobody claimed and handed it straight back. "Remove" has to outlive
        // the row it deleted, and this is the part that makes it.
        this.registry.forget(task.workspaceId, task.paneIds)
        if (!this.registry.remove(request.taskId)) return this.noTask(request.taskId)
        this.triage.resolveTaskItems(request.taskId, 'task removed')
        this.lastGit.delete(request.taskId)
        // The ledger file stays on disk. It is the record of what happened, and
        // a task recreated with the same id should inherit it rather than start
        // amnesiac; deleting it would make "remove" destroy history.
        this.registry.save()
        this.invalidate()
        return okResult({ taskId: request.taskId }, '', 'removed')
      }
      case 'adopt': {
        const result = this.registry.adopt(this.snapshot())
        this.triage.resync(new Set(this.registry.tasks().map((task) => task.id)))
        this.invalidate()
        return okResult(
          { created: result.created.length, bindings: result.bindings.length },
          '',
          'adopted'
        )
      }
      case 'import':
        return this.importThreads(request)
      case 'transcript':
        return this.taskTranscript(request)
      case 'steer':
        return this.steerTask(request)
    }
  }

  /**
   * Create a task, and provision the workspace it runs in when herdr is up.
   *
   * Offline is a supported path, not an error: the record is written with
   * `created-offline` so the human can still see the task and its goal, and
   * recovery will bind it to a workspace the moment herdr appears.
   */
  private async createTask(request: Extract<ProTaskRequest, { op: 'create' }>): Promise<ProResult> {
    // `~` and an empty field both mean home, and the expansion happens here
    // rather than in the form because this is the layer that knows whose home
    // it is. What the registry stores is always a real absolute path.
    const workdir = resolveWorkdir(request.workdir, homeDir)
    if (!workdir) return failResult('bad-payload', 'a task needs a working directory')
    if (!isDirectory(workdir)) return failResult('no-dir', `${workdir} is not a directory`)

    const repoRoot = await this.git.repoRoot(workdir).catch(() => '')
    const branch = request.branch || (request.worktree ? suggestBranch(request.title) : '')
    const client = this.client()
    const provisioned = Boolean(client && this.online())

    let workspaceId = ''
    let paneIds: string[] = []
    let finalWorkdir = workdir
    let code = provisioned ? 'created' : 'created-offline'

    if (provisioned && client) {
      try {
        const created =
          request.worktree && branch && repoRoot
            ? await client.createWorktree({
                cwd: repoRoot,
                branch,
                base: request.base || null,
                path: null,
                label: request.title || null,
                focus: false
              })
            : await client.createWorkspace({ cwd: workdir, label: request.title || null, focus: false })
        workspaceId = created.workspace?.workspaceId ?? ''
        if (created.pane?.paneId) paneIds = [created.pane.paneId]
        const checkout = created.worktree?.checkoutPath
        if (checkout) finalWorkdir = checkout
      } catch (error) {
        // herdr refusing is not a reason to lose the human's intent.
        this.host.log('warn', 'pro: provisioning failed, recording the task anyway', {
          error: String(error)
        })
        code = 'created-offline'
      }
    }

    const input: CreateTaskInput = {
      title: request.title,
      goal: request.goal,
      workdir: finalWorkdir,
      repoRoot: repoRoot || finalWorkdir,
      branch,
      agentKind: request.agent,
      workspaceId,
      paneIds,
      status: 'active'
    }
    const task = this.registry.create(input)
    const paneId = paneIds[0] ?? ''

    if (client && paneId && request.start && request.agent) {
      const instance = await client
        .startAgent({ name: task.title || task.id, kind: request.agent, paneId })
        .catch(() => null)
      if (instance) {
        this.registry.patch(task.id, { agentKind: instance.agent || request.agent })
      } else {
        this.notice(this.text(AGENT_START_FAILED), 'warn')
      }
    }
    if (client && paneId && request.prompt) {
      const sent = await this.sendToPane(client, paneId, request.prompt)
      if (!sent) this.notice(this.text(SEND_FAILED_TEXT), 'error')
    }

    this.ledger.append(
      {
        taskId: task.id,
        kind: 'goal',
        text: request.goal || request.prompt || task.title,
        agent: request.agent,
        branch,
        paneId,
        workspaceId,
        source: 'gui'
      },
      this.timers.now()
    )
    this.registry.save()
    this.git.invalidate(finalWorkdir)
    if (this.session) await this.session.refresh().catch(() => null)
    this.invalidate()
    return okResult({ taskId: task.id, workspaceId, paneId, task }, '', code)
  }

  /**
   * The sessions the companion can see, each with the task that already claims
   * it. Claimed means "some task carries this session id", which is what keeps
   * the picker from offering a duplicate: two rows for one conversation, and
   * only one of them can be resumed.
   */
  private async importCandidates(): Promise<ImportCandidate[]> {
    const claimed = new Map<string, string>()
    for (const task of this.registry.tasks()) {
      if (task.agentSessionId && !claimed.has(task.agentSessionId)) {
        claimed.set(task.agentSessionId, task.id)
      }
    }
    const threads = await this.host.listThreads().catch(() => [] as readonly ThreadInfo[])
    return threads.map((thread) => ({
      key: thread.key,
      agent: thread.agent,
      id: thread.id,
      title: thread.title,
      cwd: thread.cwd,
      updatedAt: thread.updatedAt,
      live: thread.live,
      taskId: claimed.get(thread.id) ?? ''
    }))
  }

  /**
   * Pull sessions in from the companion's list (the tree's other door).
   *
   * An import lands *parked* unless `attach` was asked for. That is the honest
   * state: the conversation is running somewhere the bench does not own - the
   * human's own terminal - and an active task with no pane is a lost task, so
   * importing it as active would put a fresh crash on the Recovery tab. Parked
   * keeps it on the map and out of the queue.
   *
   * `attach` is the other answer to the same question, and it reuses recovery
   * instead of inventing a second resume path: create the task active, then let
   * `planRecovery` build what it already builds for an interrupted task
   * (workspace, agent, `resume <session id>`). A failed attach parks the task
   * again rather than leaving it active and unbound.
   */
  private async importThreads(
    request: Extract<ProTaskRequest, { op: 'import' }>
  ): Promise<ProResult> {
    const found = await this.host.listThreads().catch(() => [] as readonly ThreadInfo[])
    const threads = new Map(found.map((thread) => [thread.key, thread]))
    const claimed = new Set(
      this.registry
        .tasks()
        .map((task) => task.agentSessionId)
        .filter(Boolean)
    )
    const imported: TaskRecord[] = []
    const skipped: string[] = []
    for (const key of request.keys) {
      const thread = threads.get(key)
      if (!thread || !thread.cwd || !isDirectory(thread.cwd)) {
        skipped.push(key)
        continue
      }
      if (thread.id && claimed.has(thread.id)) {
        skipped.push(key)
        continue
      }
      const repoRoot = await this.git.repoRoot(thread.cwd).catch(() => '')
      const task = this.registry.create({
        title: thread.title || pathBase(thread.cwd),
        goal: '',
        workdir: thread.cwd,
        repoRoot: repoRoot || thread.cwd,
        agentKind: thread.agent,
        agentSessionId: thread.id,
        status: request.attach ? 'active' : 'parked',
        origin: 'imported'
      })
      if (thread.id) claimed.add(thread.id)
      this.ledger.append(
        {
          taskId: task.id,
          kind: 'event',
          text: clipText(`imported ${thread.key} from the companion`, 400),
          agent: thread.agent,
          source: 'gui'
        },
        this.timers.now()
      )
      imported.push(task)
    }

    if (!imported.length) {
      return failResult('nothing-to-do', `no session to import (${skipped.length} skipped)`)
    }

    let attached = 0
    if (request.attach) {
      for (const task of imported) {
        const plan = this.recovery.plan(task, this.ledger.digest(task.id))
        const result = await this.applyPlan(plan, task)
        if (result.ok) attached += 1
        else this.registry.setStatus(task.id, 'parked')
      }
    }

    this.registry.save()
    this.triage.resync(new Set(this.registry.tasks().map((task) => task.id)))
    this.invalidate()
    return okResult(
      { imported: imported.length, attached, skipped, tasks: imported },
      '',
      request.attach ? 'imported-attached' : 'imported'
    )
  }

  /* ---------------------------------------------------------------- *
   * Conversation
   * ---------------------------------------------------------------- */

  /**
   * The conversation behind a task, whether or not the bench owns a terminal
   * for it.
   *
   * An imported or adopted task can be perfectly alive and still have nothing
   * to draw: herdr only has panes for workspaces the bench provisioned, and the
   * session this task points at is running in the human's own terminal. The
   * agent's own transcript file is the other source of truth, and it is the one
   * the stage already reads, so both modes show the same words.
   *
   * Three outcomes, three codes, because "no session id yet" and "the file is
   * gone" ask the human to do different things.
   */
  private taskTranscript(request: Extract<ProTaskRequest, { op: 'transcript' }>): ProResult {
    const task = this.registry.get(request.taskId)
    if (!task) return this.noTask(request.taskId)
    const session = sessionOf(task)
    if (!session) {
      return failResult('no-session', `task ${task.id} has no agent session to read yet`)
    }
    let found: ChatTranscript | null = null
    try {
      found = this.host.readTranscript(session.agent, session.id, {
        limit: request.limit,
        fresh: request.fresh
      })
    } catch (error) {
      this.host.log('warn', 'pro transcript read failed', String(error))
      return failResult('no-transcript', `could not read the ${session.agent} transcript`)
    }
    if (!found) {
      return failResult(
        'no-transcript',
        `no transcript on disk for ${session.agent} session ${session.id.slice(0, 8)}`
      )
    }
    return okResult(found, '', 'transcript')
  }

  /**
   * Answer that session from the bench.
   *
   * This goes through `steer` rather than through a pane, on purpose: the point
   * of the op is the task with no pane, and typing into a terminal the bench
   * does not own is not something it can do anyway. What the agent gets is the
   * same delivery the stage's composer uses, and the result it reports is the
   * same honest one - `codex queue` exits 0 even when nobody reads the queue.
   */
  private async steerTask(request: Extract<ProTaskRequest, { op: 'steer' }>): Promise<ProResult> {
    const task = this.registry.get(request.taskId)
    if (!task) return this.noTask(request.taskId)
    const session = sessionOf(task)
    if (!session) {
      return failResult('no-session', `task ${task.id} has no agent session to answer`)
    }
    const result = await this.host
      .steerThread(session.agent, session.id, request.message)
      .catch((error: unknown) => {
        this.host.log('warn', 'pro steer failed', String(error))
        return null
      })
    if (!result) {
      return failResult('steer-failed', `could not reach the ${session.agent} session`)
    }
    // The ledger is the task's memory, and "a human said this" belongs in it
    // whether or not the agent had a pane to say it into.
    this.ledger.append(
      {
        taskId: task.id,
        kind: 'note',
        text: clipText(request.message, 400),
        agent: session.agent,
        source: 'bench'
      },
      this.timers.now()
    )
    this.invalidate()
    if (!result.ok) return failResult('steer-failed', result.message || 'the agent refused the message')
    return okResult(result, result.message, result.method === 'queue' ? 'steered' : 'copied')
  }

  /* ---------------------------------------------------------------- *
   * Ledger
   * ---------------------------------------------------------------- */

  ledgerOp(request: ProLedgerRequest): ProResult {
    if (!this.running) return failResult('not-running', 'the bench is not running')
    switch (request.op) {
      case 'read': {
        const entries = this.ledger.entries(request.taskId)
        return okResult(
          { taskId: request.taskId, entries: entries.slice(-Math.max(1, request.limit)) },
          '',
          'ledger'
        )
      }
      case 'digest':
        return okResult(
          { taskId: request.taskId, digest: this.ledger.digest(request.taskId) },
          '',
          'digest'
        )
      case 'append': {
        const entry = this.ledger.append(
          {
            taskId: request.taskId,
            kind: request.kind,
            text: request.text,
            agent: request.agent,
            sessionKind: request.sessionKind,
            sessionValue: request.sessionValue,
            gitHead: request.gitHead,
            branch: request.branch,
            dirty: request.dirty,
            source: request.origin
          },
          this.timers.now()
        )
        if (!entry) return failResult('bad-task', 'that task id cannot be written')
        this.invalidate()
        return okResult({ entry }, '', 'appended')
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Recovery
   * ---------------------------------------------------------------- */

  async recoveryOp(request: ProRecoveryRequest): Promise<ProResult> {
    if (!this.running) return failResult('not-running', 'the bench is not running')
    switch (request.op) {
      case 'plans':
        return okResult({ plans: this.recoveryPlans(true) }, '', 'plans')
      case 'apply': {
        const task = this.registry.get(request.taskId)
        if (!task) return this.noTask(request.taskId)
        const plan = this.recovery.plan(task, this.ledger.digest(task.id))
        return this.applyPlan(plan, task)
      }
      case 'applyAll': {
        const plans = this.recoveryPlans(true).filter((plan) => plan.actionable)
        const results = await this.applyPlans(plans, 'recovery')
        const ok = results.filter((result) => result.ok).length
        return okResult({ results, ok, total: results.length }, '', 'applied-all')
      }
      case 'handoff': {
        const task = this.registry.get(request.taskId)
        if (!task) return this.noTask(request.taskId)
        const text = handoffPrompt(task, this.ledger.digest(task.id))
        if (!text) return failResult('no-context', 'nothing recorded to hand off')
        return okResult({ taskId: task.id, text }, '', 'handoff')
      }
      case 'reprompt':
        return this.reprompt(request.taskId)
    }
  }

  private async applyPlan(plan: RecoveryPlan, task: TaskRecord): Promise<ProResult> {
    if (!plan.actionable) {
      return failResult('nothing-to-do', `${task.title}: ${plan.verdict} (${plan.reason})`)
    }
    const result = await this.recovery.apply(plan, task)
    this.afterApply(result, task)
    const detail = result.notices.join('; ')
    if (!result.ok) return failResult('apply-failed', detail || 'recovery failed')
    return okResult({ result }, detail, 'applied')
  }

  /** Bind the registry to whatever recovery just made, and write it down. */
  private afterApply(
    result: ApplyResult,
    task: TaskRecord,
    source: 'recovery' | 'boot' = 'recovery'
  ): void {
    const patch: RegistryPatch = {}
    if (result.workspaceId) patch.workspaceId = result.workspaceId
    if (result.paneId) patch.paneIds = [result.paneId]
    if (result.workdir) patch.workdir = result.workdir
    if (result.ok) patch.status = 'active'
    if (Object.keys(patch).length) this.registry.patch(task.id, patch)
    for (const step of result.steps) {
      this.ledger.append(
        {
          taskId: task.id,
          kind: 'event',
          text: clipText(`${step.kind} ${step.ok ? 'ok' : 'failed'}: ${step.detail}`, 400),
          paneId: result.paneId,
          workspaceId: result.workspaceId,
          source
        },
        this.timers.now()
      )
    }
    this.registry.save()
    if (task.workdir) this.git.invalidate(task.workdir)
    if (this.session) void this.session.refresh().catch(() => null)
    this.invalidate()
  }

  /**
   * Re-prompt a task from its own ledger.
   *
   * When the pane is gone this recovers first and prompts into whatever
   * recovery built, because "resume this" is exactly what a human means when
   * they click it on a task that has no terminal.
   */
  private async reprompt(taskId: string): Promise<ProResult> {
    const task = this.registry.get(taskId)
    if (!task) return this.noTask(taskId)
    const digest = this.ledger.digest(taskId)
    const text = rePromptText(task, digest)
    if (!text) return failResult('no-context', 'nothing recorded to re-prompt with')

    const paneId = task.paneIds[0] ?? ''
    const client = this.client()
    if (client && paneId && this.paneExists(paneId)) {
      const sent = await this.sendToPane(client, paneId, text)
      if (!sent) return this.sendFailed(paneId, 'text')
      this.triage.resolveTaskItems(taskId, 're-prompted')
      this.ledger.append(
        { taskId, kind: 'event', text: 're-prompted', paneId, source: 'gui' },
        this.timers.now()
      )
      this.invalidate()
      return okResult({ taskId, paneId }, '', 'reprompted')
    }

    const plan = this.recovery.plan(task, digest)
    const applied = await this.applyPlan(plan, task)
    if (!applied.ok) return applied
    const fresh = this.client()
    const newPaneId = (applied.data as { result?: ApplyResult } | null)?.result?.paneId ?? ''
    if (!fresh || !newPaneId) return failResult('no-pane', 'recovery produced no pane to prompt')
    const sent = await this.sendToPane(fresh, newPaneId, text)
    if (!sent) return this.sendFailed(newPaneId, 'text')
    this.ledger.append(
      { taskId, kind: 'event', text: 're-prompted after recovery', paneId: newPaneId, source: 'gui' },
      this.timers.now()
    )
    this.invalidate()
    return okResult({ taskId, paneId: newPaneId, recovered: true }, '', 'reprompted')
  }

  private paneExists(paneId: string): boolean {
    return (this.snapshot()?.panes ?? []).some((pane) => pane.paneId === paneId)
  }

  /* ---------------------------------------------------------------- *
   * Panes and terminal bridges
   * ---------------------------------------------------------------- */

  async paneOp(request: ProPaneRequest): Promise<ProResult> {
    if (!this.running) return failResult('not-running', 'the bench is not running')
    switch (request.op) {
      case 'attach':
        return this.attach(request.paneId, request.cols, request.rows, request.takeover)
      case 'detach':
        return this.detach(request.paneId)
      case 'input': {
        const bridge = this.bridges.get(request.paneId)
        if (!bridge) return this.noBridge(request.paneId)
        return bridge.input(request.text)
          ? okResult(null, '', 'sent')
          : failResult('not-live', 'the terminal bridge is not live')
      }
      case 'resize': {
        const bridge = this.bridges.get(request.paneId)
        if (!bridge) return this.noBridge(request.paneId)
        return bridge.resize(request.cols, request.rows)
          ? okResult(null, '', 'resized')
          : failResult('not-live', 'the terminal bridge is not live')
      }
      case 'scroll': {
        const bridge = this.bridges.get(request.paneId)
        if (!bridge) return this.noBridge(request.paneId)
        return bridge.scroll(request.direction, request.lines, 'wheel')
          ? okResult(null, '', 'scrolled')
          : failResult('not-live', 'the terminal bridge is not live')
      }
      case 'send': {
        const client = this.client()
        if (!client) return this.offline()
        const sent = await client.sendText(request.paneId, request.text).catch(() => false)
        if (!sent) return this.sendFailed(request.paneId, 'text')
        if (request.enter) await client.sendKeys(request.paneId, ['enter']).catch(() => false)
        return okResult({ paneId: request.paneId }, '', 'sent')
      }
      case 'keys': {
        const client = this.client()
        if (!client) return this.offline()
        const sent = await client.sendKeys(request.paneId, request.keys).catch(() => false)
        return sent
          ? okResult({ paneId: request.paneId, keys: request.keys }, '', 'sent')
          : this.sendFailed(request.paneId, 'keystrokes')
      }
      case 'focus': {
        const client = this.client()
        if (!client) return this.offline()
        const ok = await client.focusPane(request.paneId).catch(() => false)
        return ok
          ? okResult({ paneId: request.paneId }, '', 'focused')
          : failResult('no-pane', `herdr has no pane ${request.paneId}`)
      }
      case 'zoom': {
        const client = this.client()
        if (!client) return this.offline()
        const ok = await client.zoomPane(request.paneId, request.mode).catch(() => false)
        return ok
          ? okResult({ paneId: request.paneId, mode: request.mode }, '', 'zoomed')
          : failResult('no-pane', `herdr refused to zoom ${request.paneId}`)
      }
      case 'read': {
        const client = this.client()
        if (!client) return this.offline()
        const read = await client
          .readPane(request.paneId, {
            source: 'detection',
            lines: request.lines,
            format: 'text',
            stripAnsi: true
          })
          .catch(() => null)
        if (!read) return failResult('no-pane', `herdr cannot read pane ${request.paneId}`)
        return okResult(
          { paneId: read.paneId, text: read.text, revision: read.revision, truncated: read.truncated },
          '',
          'read'
        )
      }
    }
  }

  /**
   * Bridge a pane into an xterm view.
   *
   * Needs the herdr *binary*, not just the socket: the stream is a child
   * process speaking herdr's terminal protocol, which is also why a read-only
   * deployment (socket, no binary) still gets a working bench minus live
   * terminals.
   */
  private attach(paneId: string, cols: number, rows: number, takeover: boolean): ProResult {
    if (!paneId) return failResult('bad-payload', 'paneId is required')
    const existing = this.bridges.get(paneId)
    if (existing) {
      existing.resize(cols, rows)
      return okResult({ paneId, status: existing.status() }, 'already attached', 'attached')
    }
    const binary = this.target.binaryPath
    if (!binary) {
      return failResult('no-herdr-binary', 'a terminal view needs the herdr binary, which we did not find')
    }
    const bridge = new TerminalBridge({
      target: paneId,
      binaryPath: binary,
      env: this.target.childEnv,
      cols,
      rows,
      takeover,
      spawn: this.spawn,
      timers: this.timers
    })
    bridge.onState((state) => this.onBridgeState(state))
    this.bridges.set(paneId, bridge)
    bridge.open(takeover)
    this.startPump()
    this.invalidate()
    return okResult({ paneId, status: bridge.status() }, '', 'attaching')
  }

  private detach(paneId: string): ProResult {
    const bridge = this.bridges.get(paneId)
    if (!bridge) return this.noBridge(paneId)
    bridge.close()
    this.bridges.delete(paneId)
    if (!this.bridges.size) this.stopPump()
    this.invalidate()
    return okResult({ paneId }, '', 'detached')
  }

  private onBridgeState(state: BridgeState): void {
    this.host.emit(IPC.pushProBridge, {
      paneId: state.paneId,
      phase: state.phase,
      live: state.live,
      cols: state.cols,
      rows: state.rows,
      dropped: state.dropped,
      error: state.error
    })
    this.invalidate()
  }

  private startPump(): void {
    if (this.frameTimer || !this.bridges.size) return
    this.frameTimer = this.timers.every(() => this.pumpFrames(), this.intervals.frameMs)
  }

  private stopPump(): void {
    this.frameTimer?.cancel()
    this.frameTimer = null
  }

  /**
   * Drain every bridge once per frame and ship one batch.
   *
   * Two caps, both about the same thing: a renderer that fell behind must be
   * resynced, not handed a backlog. Deltas applied out of order or with gaps
   * corrupt a terminal silently, so when we drop anything we ask that pane for
   * a full frame rather than hoping it notices.
   */
  private pumpFrames(): void {
    if (!this.bridges.size) {
      this.stopPump()
      return
    }
    const frames: ProFramePush[] = []
    for (const bridge of this.bridges.values()) {
      const taken = bridge.take()
      if (!taken.length) continue
      if (taken.length > MAX_FRAMES_PER_PANE) {
        bridge.requestResync()
        continue
      }
      for (const frame of tailFromFull(taken)) {
        if (frames.length >= MAX_FRAMES_PER_PUSH) {
          bridge.requestResync()
          break
        }
        frames.push({
          paneId: frame.paneId,
          seq: frame.seq,
          full: frame.full,
          width: frame.width,
          height: frame.height,
          bytes: frame.bytes
        })
      }
    }
    if (frames.length) this.host.emit(IPC.pushProFrames, { frames })
  }

  /* ---------------------------------------------------------------- *
   * Host and companion
   * ---------------------------------------------------------------- */

  async hostOp(request: ProHostRequest): Promise<ProResult> {
    switch (request.op) {
      case 'discovery':
        return okResult(
          {
            target: this.target,
            description: describeDiscovery(this.target, this.host.lang()),
            online: this.online(),
            status: this.sessionStatus()
          },
          '',
          'discovery'
        )
      case 'agents': {
        const client = this.client()
        if (client) {
          const agents = await client.listAgents().catch(() => [] as AgentInstance[])
          if (agents.length) return okResult({ agents, kinds: KNOWN_AGENT_KINDS }, '', 'agents')
        }
        // Offline fallback: the create form still needs a picker, and the agent
        // list is not a secret worth failing the form over.
        return okResult({ agents: [], kinds: KNOWN_AGENT_KINDS }, '', 'agents-fallback')
      }
      case 'threads':
        return okResult({ threads: await this.importCandidates() }, '', 'threads')
      case 'pickDir': {
        const dir = await this.host.pickDir().catch(() => '')
        return dir ? okResult({ path: dir }, '', 'picked') : failResult('cancelled', 'no directory chosen')
      }
      case 'openPath':
        this.host.openPath(request.path)
        return okResult({ path: request.path }, '', 'opened')
      case 'openExternal':
        this.host.openExternal(request.url)
        return okResult({ url: request.url }, '', 'opened')
    }
  }

  /* ---------------------------------------------------------------- *
   * SSH and local terminals
   * ---------------------------------------------------------------- */

  /**
   * The connect palette's whole backend.
   *
   * A terminal session is a Bench task with no agent (`agentKind: ''`): herdr
   * owns the PTY, the registry owns the row in the tree, and the pane renderer
   * that already draws agent output draws a shell too. That is why `connect`,
   * `terminal` and `setup` all end up in `openSession` - one provisioning path,
   * and the only thing that differs is what gets typed into the fresh shell.
   * There is no second terminal implementation in this app, and no node-pty.
   */
  async sshOp(request: ProSshRequest): Promise<ProResult> {
    if (!this.running) return failResult('not-running', 'the bench is not running')
    switch (request.op) {
      case 'list': {
        const machines = await this.ssh.roster(request.query)
        const roster: ProSshRoster = { machines, home: homeDir }
        return okResult(roster, '', 'roster')
      }
      case 'keys':
        return okResult<ProSshKeys>(
          { keys: this.ssh.keys(), key: this.ssh.defaultKey() },
          '',
          'keys'
        )
      case 'probe': {
        const machine = this.machineFor(request.machine, request.target)
        if (!machine) return this.noMachine()
        const probe = await this.ssh.probe(machine)
        const result: ProSshProbe = { machine, status: probe.status, detail: probe.detail }
        return okResult(result, probe.detail, probe.status)
      }
      case 'save': {
        const machine = this.machineFor(request.machine, request.target)
        if (!machine) return this.noMachine()
        const saved = this.ssh.save(machine)
        this.invalidate()
        return saved
          ? okResult({ machine: saved }, '', 'saved')
          : failResult('bad-machine', 'the machine could not be stored')
      }
      case 'remove': {
        const removed = this.ssh.remove(request.id)
        this.invalidate()
        return removed
          ? okResult({ id: request.id }, '', 'removed')
          : failResult('no-item', `no saved machine ${request.id}`)
      }
      case 'connect': {
        const machine = this.machineFor(request.machine, request.target)
        if (!machine) return this.noMachine()
        // Pin first, so the roster the human sees next time already has this box
        // in it even if herdr turns out to be down. A saved machine that never
        // connected is still a machine they meant to keep.
        const saved = request.save ? this.ssh.save(machine) : null
        const line = this.ssh.connectLine(machine)
        return this.openSession({
          title: machine.label,
          cwd: request.cwd,
          goal: line,
          lines: [line],
          code: saved ? 'connected' : 'connected-unsaved'
        })
      }
      case 'setup': {
        const machine = this.machineFor(request.machine, request.target)
        if (!machine) return this.noMachine()
        const lines = this.setupPlan(machine, request.key)
        if (!request.run) {
          return okResult<ProSshSetup>({ lines, key: this.ssh.defaultKey() }, '', 'setup-plan')
        }
        const opened = await this.openSession({
          title: machine.label,
          cwd: '',
          goal: lines.join('\n'),
          lines,
          code: 'setup'
        })
        if (!opened.ok || !opened.data) return opened
        return okResult<ProSshSetup & ProSessionOpened>(
          { ...opened.data, lines, key: this.ssh.defaultKey() },
          opened.detail,
          opened.code
        )
      }
      case 'terminal':
        return this.openSession({
          title: '',
          cwd: request.cwd,
          goal: '',
          lines: [],
          code: 'terminal'
        })
    }
  }

  /** What a session open produced; the renderer focuses the pane from it. */
  private async openSession(input: {
    title: string
    cwd: string
    goal: string
    lines: readonly string[]
    code: string
  }): Promise<ProResult<ProSessionOpened>> {
    const client = this.client()
    if (!client || !this.online()) return this.offline()

    // `~` and an empty field both mean home - the same rule the New task form
    // uses, and the reason "open a terminal" needs no directory at all.
    const workdir = resolveWorkdir(input.cwd, homeDir)
    if (!workdir) return failResult('needs-workdir', 'no working directory and no home to fall back to')
    if (!isDirectory(workdir)) return failResult('no-dir', `${workdir} is not a directory`)

    const repoRoot = (await this.git.repoRoot(workdir).catch(() => '')) || workdir
    const title = input.title.trim() || pathBase(workdir) || 'terminal'

    let created: CreatedResult
    try {
      created = await client.createWorkspace({ cwd: workdir, label: title, focus: false })
    } catch (error) {
      this.host.log('warn', 'pro: cannot open a session workspace', { error: String(error) })
      return failResult('no-workspace', String(error))
    }
    const workspaceId = created.workspace?.workspaceId ?? ''
    const paneId = created.pane?.paneId ?? ''
    if (!paneId) return failResult('no-pane', 'herdr opened a workspace with no pane in it')

    const task = this.registry.create({
      title,
      goal: input.goal,
      workdir,
      repoRoot,
      branch: '',
      agentKind: '',
      workspaceId,
      paneIds: [paneId],
      status: 'active',
      origin: 'created'
    })

    let typed = 0
    for (const line of input.lines) {
      if (!line.trim()) continue
      if (await this.typeLine(client, paneId, line)) typed += 1
    }
    if (input.lines.length && !typed) this.notice(this.text(SEND_FAILED_TEXT), 'error')

    this.ledger.append(
      {
        taskId: task.id,
        kind: 'session',
        text: input.goal || title,
        agent: '',
        branch: '',
        paneId,
        workspaceId,
        source: 'gui'
      },
      this.timers.now()
    )
    this.registry.save()
    this.git.invalidate(workdir)
    if (this.session) await this.session.refresh().catch(() => null)
    this.invalidate()
    // The human asked to be somewhere; landing them on the pane they just opened
    // is the whole point, and it also attaches the bridge that draws it.
    this.focusBench(task.id, paneId, input.code)
    return okResult({ taskId: task.id, workspaceId, paneId, typed }, '', input.code)
  }

  /**
   * Type one line into a bare shell and submit it.
   *
   * Deliberately not `sendToPane`: that path is agent-aware, and `agent.prompt`
   * would wait for an agent that is not there. This is the raw half of it. The
   * PTY buffers input, so typing the moment herdr hands the pane back is safe
   * even while the shell is still reading its rc files.
   */
  private async typeLine(client: HerdrClientLike, paneId: string, line: string): Promise<boolean> {
    const sent = await client.sendText(paneId, line).catch(() => false)
    if (!sent) return false
    return client.sendKeys(paneId, ['enter']).catch(() => false)
  }

  /**
   * Which of the two the palette sent wins. A roster row has already been
   * through `~/.ssh/config`, so it may carry the alias that makes
   * `ssh <alias>` the correct line; a typed target has not, so it is parsed
   * here, in the process that owns the same config file.
   */
  private machineFor(machine: SshMachine | null, target: string): SshMachine | null {
    if (machine && machine.host.trim()) return machine
    return target ? parseTarget(target) : null
  }

  /**
   * The lines that make a machine passwordless, with keypair creation folded in
   * when this box has no key at all - otherwise the first thing a fresh install
   * sees is `ssh-copy-id` failing on a public key that does not exist.
   */
  private setupPlan(machine: SshMachine, key: string): string[] {
    const lines = this.ssh.setup(machine, key)
    return this.ssh.keys().length ? lines : [this.ssh.keygen(), ...lines]
  }

  private noMachine(): ProResult<never> {
    return failResult('bad-machine', 'a machine or an ssh target is required')
  }

  /** Widget, tray or HTTP -> bench. Parsed and resolved by the bridge. */
  command(payload: unknown): Promise<ProResult> {
    if (!this.running) return Promise.resolve(failResult('not-running', 'the bench is not running'))
    return this.companion.command(payload)
  }

  /** Bench -> widget: summon, dismiss, toggle, announce. */
  companionOp(payload: unknown): ProResult {
    return this.companion.companionCommand(payload)
  }

  /**
   * Patch `pro.*`. Validation is `applyPatch`, which is the same clamping path
   * the settings UI uses, so a hand-written config and a stage-bar toggle
   * cannot disagree about what a legal value is.
   */
  async configOp(payload: unknown): Promise<ProResult> {
    const current = this.host.config()
    const next = applyPatch(current, { pro: { ...current.pro, ...recordOf(payload) } }).pro
    if (this.host.updateConfig) {
      try {
        await this.host.updateConfig({ pro: next })
      } catch (error) {
        this.host.log('error', 'pro: config write failed', { error: String(error) })
        return failResult('write-failed', `could not save config: ${String(error)}`)
      }
    }
    // The write can reach us twice: once here, once through the host's config
    // listener calling `syncConfig`. That is harmless because the diff is taken
    // against whatever we last applied, so the second pass finds nothing to do.
    await this.applyProDiff(next)
    return okResult({ pro: next }, '', 'config-applied')
  }

  /**
   * React to a `pro.*` change we did not make: the widget's stage bar, the HTTP
   * relay, or a hand-edited file. The same diff `configOp` applies, minus the
   * write, because whoever told us already saved it.
   */
  async syncConfig(): Promise<void> {
    await this.applyProDiff(this.proConfig())
  }

  /**
   * The one place a config delta becomes behaviour, so a settings toggle, a
   * host listener and a test cannot disagree about what a change means.
   */
  private async applyProDiff(next: ProConfig): Promise<void> {
    const before = this.appliedPro ?? next
    this.appliedPro = next
    if (before.stalledAfterMs !== next.stalledAfterMs) {
      this.triage.setStalledAfterMs(next.stalledAfterMs)
    }
    const moved =
      before.socketPath !== next.socketPath ||
      before.herdrSession !== next.herdrSession ||
      before.herdrPath !== next.herdrPath
    if (before.enabled !== next.enabled) {
      if (next.enabled) await this.start()
      else this.shutdown()
    } else if (moved && next.enabled && this.running) {
      await this.rediscover()
    }
    this.invalidate()
  }

  /* ---------------------------------------------------------------- *
   * CompanionApi
   * ---------------------------------------------------------------- */

  focusBench(taskId: string, paneId = '', reason = ''): void {
    const task = taskId ? this.registry.get(taskId) : null
    const resolved = paneId || task?.paneIds[0] || ''
    this.host.openBench()
    const push: ProFocusPush = { taskId, paneId: resolved, reason, at: this.timers.now() }
    this.lastFocus = push
    this.host.emit(IPC.pushProFocus, push)
    this.invalidate()
  }

  /**
   * Re-send the last focus request to a window that has just finished loading.
   * A bubble click creates the bench window and emits in the same tick, so
   * without this the window opens showing whatever it opened on.
   */
  replayFocus(): void {
    const focus = this.lastFocus
    if (!focus) return
    if (this.timers.now() - focus.at > FOCUS_REPLAY_MS) return
    this.host.emit(IPC.pushProFocus, focus)
  }

  snoozeAll(minutes: number): number {
    const count = this.triage.snoozeAll(minutes)
    this.invalidate()
    return count
  }

  openBench(): void {
    this.host.openBench()
  }

  /* ---------------------------------------------------------------- *
   * Shared failure paths
   * ---------------------------------------------------------------- */

  private proConfig(): ProConfig {
    return this.host.config().pro
  }

  private text(pair: { zh: string; en: string }): string {
    return this.host.lang() === 'zh' ? pair.zh : pair.en
  }

  private notice(text: string, tone: ProNoticePush['tone'] = 'info'): void {
    const clean = String(text || '').trim()
    if (!clean) return
    this.host.emit(IPC.pushProNotice, {
      text: clean,
      lang: this.host.lang(),
      tone,
      at: this.timers.now()
    })
  }

  private offline(): ProResult<never> {
    const status = this.sessionStatus()
    const why = status?.error || describeDiscovery(this.target, this.host.lang()) || 'not connected'
    this.notice(this.text(OFFLINE_TEXT), 'warn')
    return failResult('offline', why)
  }

  private sendFailed(paneId: string, what: string): ProResult<never> {
    const detail = `herdr refused ${what} for pane ${paneId}`
    this.notice(detail, 'error')
    return failResult('send-failed', detail)
  }

  private noTask(taskId: string): ProResult<never> {
    return failResult('no-task', `no task ${taskId}`)
  }

  private noBridge(paneId: string): ProResult<never> {
    return failResult('no-bridge', `pane ${paneId} is not attached`)
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const EMPTY_TARGET: HerdrTarget = {
  binaryPath: null,
  socketPath: null,
  session: '',
  childEnv: {},
  found: false,
  reason: 'no-server',
  triedSockets: [],
  triedBinaries: [],
  sessionsFound: []
}

const AGENT_START_FAILED = {
  zh: 'agent 启动失败，任务已创建',
  en: 'the agent did not start; the task was created anyway'
}

const SEND_FAILED_TEXT = {
  zh: '发送失败：herdr 拒绝了这次输入',
  en: 'send failed: herdr refused the input'
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isDirectory(value: string): boolean {
  const target = String(value || '').trim()
  if (!target) return false
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function sameDir(a: string, b: string): boolean {
  const left = String(a || '').replace(/[\\/]+$/, '')
  const right = String(b || '').replace(/[\\/]+$/, '')
  if (!left || !right) return false
  return left === right || left.toLowerCase() === right.toLowerCase()
}

function clipText(text: string, max: number): string {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}...` : value
}

/**
 * The session a task points at, as the transcript reader wants it.
 *
 * `agentKind` is free text in the registry (herdr reports what it saw, import
 * reports what the tracker saw), so it is narrowed here rather than at every
 * call site: anything that is not codex or claude has no transcript format we
 * can parse, and saying so is better than handing `unknown` to a reader that
 * would then guess a directory.
 */
function sessionOf(task: TaskRecord): { agent: Agent; id: string } | null {
  const id = String(task.agentSessionId || '').trim()
  if (!id) return null
  const kind = String(task.agentKind || '').trim().toLowerCase()
  if (kind !== 'codex' && kind !== 'claude') return null
  return { agent: kind, id }
}
function hookText(event: HookEvent): string {
  const source = String(event.sourceText || '').trim()
  const detail = String(event.detail || '').trim()
  const title = String(event.title || '').trim()
  let body = source || detail || title
  // A human typing "ok" is not a plan worth a ledger line.
  if (event.kind === 'prompt' && body.length < 4) return ''
  if (!body) body = HOOK_FALLBACK_TEXT[event.kind] ?? event.kind
  const tool = String(event.toolName || '').trim()
  return clipText(tool ? `${event.kind} ${tool}: ${body}` : `${event.kind}: ${body}`, 600)
}

function gitText(facts: GitFacts, headChanged: boolean): string {
  const where = facts.branch ? ` on ${facts.branch}` : ''
  if (headChanged) return `commit ${facts.head.slice(0, 7)}${where}`
  return facts.dirty ? `working tree dirty (${facts.dirty})${where}` : `working tree clean${where}`
}

/**
 * Keep only what a terminal can still use: everything from the most recent
 * full frame onward. Anything before it is already superseded.
 */
function tailFromFull(frames: readonly WireFrame[]): readonly WireFrame[] {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    if (frames[i].full) return frames.slice(i)
  }
  return frames
}

/**
 * What counts as "the projection changed".
 *
 * Two deliberate omissions. Wall-clock fields are bucketed to 15s, because a
 * signature that changes every second pushes a full tree once a second and the
 * renderer already derives its own "3m ago" from `since`. And `lastActivityAt`
 * is left out for the same reason: it moves on every pane revision, which is
 * several times a second on a busy agent.
 */
function signatureOf(view: BenchView): string {
  const bucket = (ms: number): number => Math.floor(ms / SIGNATURE_BUCKET_MS)
  const tasks = view.tasks
    .map((task) =>
      [
        task.id,
        task.status,
        task.liveStatus,
        task.alive ? 1 : 0,
        task.branch,
        task.dirty,
        task.tokens,
        task.needsMe,
        task.recovery,
        task.workspaceId,
        task.paneIds.join('+'),
        task.agentKind,
        task.agentSessionId,
        task.title,
        task.goal,
        bucket(task.blockedMs)
      ].join('~')
    )
    .join('|')
  const attention = view.attention
    .map((item) =>
      [
        item.id,
        item.resolved ? 'r' : 'l',
        item.snoozedUntil,
        item.title,
        item.detail,
        item.command,
        item.toolName,
        item.source,
        item.taskId,
        item.paneId,
        bucket(item.since),
        bucket(item.updatedAt)
      ].join('~')
    )
    .join('|')
  const groups = view.groups.map((group) => `${group.key}:${group.tasks.length}`).join(',')
  const recovery = view.recovery.map((plan) => `${plan.taskId}:${plan.verdict}:${plan.steps.length}`).join(',')
  const counts = view.counts
  return [
    view.herdr.online ? 1 : 0,
    view.herdr.version,
    view.herdr.socketPath,
    view.herdr.error,
    view.herdr.workspaces,
    view.herdr.panes,
    counts.working,
    counts.blocked,
    counts.done,
    counts.idle,
    counts.unknown,
    counts.needsMe,
    counts.total,
    groups,
    tasks,
    attention,
    recovery,
    view.companion.visible ? 1 : 0,
    view.companion.notices
  ].join('#')
}

/**
 * The five entry points the IPC layer needs, with parsing already done. Kept
 * next to the service so a channel added later has an obvious home, and so the
 * parsers are called exactly once per request.
 */
export const proParsers = {
  task: parseProTask,
  ledger: parseProLedger,
  recovery: parseProRecovery,
  pane: parseProPane,
  host: parseProHost,
  ssh: parseProSsh
}
