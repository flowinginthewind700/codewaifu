/**
 * The bench model: everything Pro *owns*, as pure data and pure functions.
 *
 * Two quantities are worth optimizing (see docs/pro/MVP.md): decision latency
 * and survivability. This file is where both are decided — how tasks are
 * grouped, what needs the human now and in what order, what the ledger
 * remembers, and what to do when reality and the ledger disagree. None of it
 * touches the filesystem, a socket or a clock: `now`, ids and facts are
 * arguments, so every rule here is testable without herdr, Electron or a
 * terminal.
 *
 * It lives in `shared` because three processes need the same answers: main
 * computes them, the Bench window renders them, and the companion widget
 * announces them. A projection that differs per surface is how a workbench ends
 * up with a badge that lies.
 */
import type { AgentSessionRef, AgentStatus, PaneInfo, Snapshot, WorkspaceInfo } from './herdr'

/* ------------------------------------------------------------------ *
 * Paths, without node:path (shared code stays import-free)
 * ------------------------------------------------------------------ */

const SEP = /[\\/]+/

export function pathParts(value: string): string[] {
  return String(value || '')
    .split(SEP)
    .filter(Boolean)
}

export function pathBase(value: string): string {
  const parts = pathParts(value)
  return parts.length ? parts[parts.length - 1] : ''
}

/** Drive-letter or UNC prefix means Windows rules; used only for display. */
export function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function samePath(a: string, b: string): boolean {
  const left = String(a || '').replace(/[\\/]+$/, '')
  const right = String(b || '').replace(/[\\/]+$/, '')
  if (!left || !right) return false
  return left === right || left.toLowerCase() === right.toLowerCase()
}

/**
 * What a typed working directory means, resolved against a home the caller
 * supplies: empty is home, `~` is home, `~/src/app` is home plus the tail.
 *
 * The field is a path in a product that owns terminals, so it gets typed like
 * one - and a shell would have expanded the tilde before we ever saw it. Not
 * expanding it here means the one input that looks most like a path is the one
 * that fails with "not a directory", which reads as a bug in the form.
 *
 * Empty meaning home is the GUI's rule, not the CLI's: `--cli` fills in
 * `process.cwd()` before it sends anything, because a terminal knows where
 * "here" is and a window does not. Only the caller's home is expanded - `~root`
 * stays literal, since guessing another user's home is how a task lands
 * somewhere nobody meant.
 */
export function resolveWorkdir(raw: unknown, home: string): string {
  const value = String(raw ?? '').trim()
  const base = String(home || '').trim().replace(/[\\/]+$/, '')
  if (!value) return base
  const isTilde = value === '~' || value.startsWith('~/') || value.startsWith('~\\')
  if (!isTilde) return value
  if (!base) return value
  // Match the separator the home directory already uses, so a Windows home does
  // not end up stored as `C:\Users\u/src/app`. Only that direction: on POSIX a
  // backslash is an ordinary character in a filename and rewriting it would
  // point the task at a directory that does not exist.
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  const rest = value === '~' ? '' : value.slice(2).replace(/^[\\/]+/, '')
  const tail = separator === '\\' ? rest.replace(/\//g, '\\') : rest
  if (!tail) return base
  return `${base}${separator}${tail}`
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

/**
 * Human-set lifecycle. `lost` is assigned by the recovery planner, never by a
 * click: it means "we no longer know how to get this conversation back".
 */
export type TaskStatus = 'active' | 'parked' | 'done' | 'lost'

const TASK_STATUSES: readonly string[] = ['active', 'parked', 'done', 'lost']

export function taskStatusOf(value: unknown): TaskStatus {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return TASK_STATUSES.includes(raw) ? (raw as TaskStatus) : 'active'
}

/**
 * Where a task came from. The tree is a directory spine, so origin is a facet
 * on a row rather than a bucket of its own: work you made here, work herdr was
 * already running (adopted on first sight), and work pulled in from the
 * companion's session list (imported). The last two are the same thing to a
 * filter - "not made here" - and different things to a badge.
 */
export type TaskOrigin = 'created' | 'adopted' | 'imported'

const TASK_ORIGINS: readonly string[] = ['created', 'adopted', 'imported']

/**
 * How long a task title may be, everywhere it is written.
 *
 * One constant rather than three literal `160`s: the wire parser clamps to it,
 * so an input that does not is a title the user watched themselves type and
 * then lost the tail of.
 */
export const TASK_TITLE_MAX = 160

/** Unknown or hand-edited means `created`: the oldest records have no origin. */
export function taskOriginOf(value: unknown): TaskOrigin {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return TASK_ORIGINS.includes(raw) ? (raw as TaskOrigin) : 'created'
}

/** What survives on disk in `bench.json`. Live state is never stored here. */
export interface TaskRecord {
  id: string
  title: string
  goal: string
  /** Repo root, a worktree checkout, or any directory: the task's home. */
  workdir: string
  repoRoot: string
  branch: string
  /** herdr manifest id (`codex`, `claude`, ...); '' when unknown. */
  agentKind: string
  /** The conversation id we would hand to `resume`. '' when never captured. */
  agentSessionId: string
  /** Transcript path, weaker evidence than an id (see planRecovery). */
  agentSessionPath: string
  workspaceId: string
  paneIds: string[]
  status: TaskStatus
  createdAt: number
  updatedAt: number
  /** Epoch ms; 0 when not parked. Kept so the tree can show "parked 3d". */
  parkedAt: number
  /** Provenance. Never affects ordering; see `TaskOrigin`. */
  origin: TaskOrigin
}

function str(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function num(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

function strList(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).map(str).filter(Boolean)
}

/**
 * Read a task from `bench.json` without trusting it. A hand-edited or
 * half-written registry must degrade to a usable task, not to a crash on boot:
 * the registry is the index into the ledger, and losing it loses the intent.
 */
export function parseTaskRecord(value: unknown): TaskRecord | null {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const id = str(raw.id)
  if (!id) return null
  const workdir = str(raw.workdir)
  const createdAt = num(raw.createdAt)
  return {
    id,
    title: str(raw.title) || pathBase(workdir) || id,
    goal: str(raw.goal),
    workdir,
    repoRoot: str(raw.repoRoot) || workdir,
    branch: str(raw.branch),
    agentKind: str(raw.agentKind).toLowerCase(),
    agentSessionId: str(raw.agentSessionId),
    agentSessionPath: str(raw.agentSessionPath),
    workspaceId: str(raw.workspaceId),
    paneIds: strList(raw.paneIds),
    status: taskStatusOf(raw.status),
    createdAt: createdAt || num(raw.updatedAt),
    updatedAt: num(raw.updatedAt) || createdAt,
    parkedAt: num(raw.parkedAt),
    origin: taskOriginOf(raw.origin)
  }
}

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

export interface GroupView {
  /** Absolute directory the group is named after. */
  key: string
  label: string
  /** Parent directory, for two checkouts of the same repo side by side. */
  hint: string
  tasks: TaskView[]
  counts: StateCounts
}

/**
 * The directory a task is filed under. A worktree belongs to its repo, so a
 * task working in `.worktrees/fix-auth` still groups with the checkout it came
 * from — that is the whole point of grouping by repo root.
 */
export function groupKeyFor(task: Pick<TaskRecord, 'repoRoot' | 'workdir'>): string {
  const root = task.repoRoot || task.workdir
  return String(root || '').replace(/[\\/]+$/, '')
}

export function groupLabelFor(key: string): string {
  return pathBase(key) || key || 'unknown'
}

function groupHintFor(key: string): string {
  const parts = pathParts(key)
  if (parts.length < 2) return ''
  return parts[parts.length - 2]
}

/* ------------------------------------------------------------------ *
 * Live state
 * ------------------------------------------------------------------ */

export interface PaneView {
  paneId: string
  terminalId: string
  workspaceId: string
  tabId: string
  cwd: string
  agent: string
  displayAgent: string
  title: string
  agentStatus: AgentStatus
  focused: boolean
  revision: number
  /** True while this pane is bridged to an xterm view. */
  attached: boolean
}

export function paneViewOf(pane: PaneInfo, attached = false): PaneView {
  return {
    paneId: pane.paneId,
    terminalId: pane.terminalId,
    workspaceId: pane.workspaceId,
    tabId: pane.tabId,
    cwd: pane.foregroundCwd || pane.cwd,
    agent: pane.agent,
    displayAgent: pane.displayAgent || pane.agent,
    title: pane.title || pane.terminalTitle || pane.label,
    agentStatus: pane.agentStatus,
    focused: pane.focused,
    revision: pane.revision,
    attached
  }
}

/**
 * A task's state is the worst thing any of its panes is doing: one pane blocked
 * on a permission prompt means the task is blocked, no matter how busy its
 * siblings look. Precedence matches what a human would answer first.
 */
const STATUS_RANK: Record<AgentStatus, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4
}

export function foldStatus(statuses: readonly AgentStatus[]): AgentStatus {
  let best: AgentStatus = 'unknown'
  for (const status of statuses) {
    if (STATUS_RANK[status] < STATUS_RANK[best]) best = status
  }
  return best
}

/**
 * Proof of life for one task: what its panes are labelled, and what moves.
 *
 * `signature` is the same string the stall detector reads, for the same reason:
 * `agentStatus` is a *label* herdr derives from screen content, and it stays
 * `working` on the leftover terminal of a finished run for as long as that
 * terminal lives. The signature is what actually beats - a live codex pane held
 * its `revision` constant across an entire run while `terminal_title` repainted
 * about once a second with the spinner, so the label alone cannot tell "still
 * going" from "left on screen".
 */
export interface TaskLiveness {
  /** Fold of the bound panes' statuses; `unknown` when there are none. */
  live: AgentStatus
  /** '' when the task has no pane; otherwise every bound pane's signature. */
  signature: string
}

/**
 * Per-task liveness, computed the same way the projection computes live state,
 * for the callers that have to react to a *change* in it rather than render it.
 *
 * `buildBench` is a pure read and stays one: the bench has to write "this
 * finished task is working again" to the registry, and a projection that writes
 * is a projection that depends on when somebody happened to look at it. So the
 * same binding and the same fold live here, and the service diffs two passes.
 */
export function livenessByTask(
  tasks: readonly TaskRecord[],
  snapshot: Snapshot | null
): Map<string, TaskLiveness> {
  const out = new Map<string, TaskLiveness>()
  if (!snapshot) return out
  const panesById = new Map<string, PaneInfo>()
  for (const pane of snapshot.panes) panesById.set(pane.paneId, pane)
  for (const task of tasks) {
    const binding = bindTask(task, snapshot)
    const bound = binding.paneIds.map((id) => panesById.get(id)).filter(nonNull)
    out.set(task.id, {
      live: bound.length ? foldStatus(bound.map((pane) => pane.agentStatus)) : 'unknown',
      // Sorted, so a binding that lists the same panes in another order does
      // not read as movement; joined per pane, so any one of a task's panes
      // repainting counts as progress in that task.
      signature: bound
        .map((pane) => `${pane.paneId}=${paneProgressSignature(pane)}`)
        .sort()
        .join(';')
    })
  }
  return out
}

/**
 * The fields that beat while an agent works, joined into one string.
 *
 * `revision` is here because it is the documented output counter and some panes
 * do move it, but it is deliberately *not* alone: a live working codex pane held
 * its revision constant for an entire run. `terminal_title` is the field that
 * actually repaints during work - it carries the spinner and status line the
 * agent draws, which is the same byte stream Ghostty shows as "still going".
 * `title` and the scroll offset round it out, so any of the four moving counts
 * as progress and only genuine quiet across all of them reads as a stall.
 *
 * One definition, shared by the stall detector and the revive pass: both answer
 * "is this pane doing something right now", and two spellings of that question
 * drift into disagreeing about the same pane.
 */
export function paneProgressSignature(pane: PaneInfo): string {
  return [pane.revision, pane.terminalTitle, pane.title, pane.scroll?.offsetFromBottom ?? 0].join('|')
}

/**
 * A task the human finished is not finished any more once work resumes in it.
 *
 * The row keeps its status on disk, and every surface reads that status for the
 * pill while reading live panes for the dot - so a done task whose conversation
 * the human picked back up used to show a green "working" dot next to a
 * "done" pill forever, and its recovery plan stayed parked on "marked done".
 * Two surfaces, two truths, and the one that was wrong was the one you act on.
 *
 * Two ways in, because the bug has two shapes. A *status transition* into busy
 * is a new turn - the agent was quiet and now it is not - which is the case the
 * human describes as "I finished it and kept talking to it". A *moved
 * signature* under an unchanged busy label is proof of life, and it is the one
 * that actually catches a long-lived bench: the three rows stuck in this state
 * on a real machine had been `working` for five hours before they were ever
 * observed, so no transition ever happens and the label alone contradicts the
 * screen indefinitely.
 *
 * Proof of life is conditional on `witnessed`, transitions are not.
 * `witnessed` means we saw the human close this row while its pane was already
 * busy, which is a verdict made with their eyes open - "it is still going and I
 * am done tracking it" - and second-guessing it one second later is how an app
 * teaches the human that its buttons do nothing. A row that was already closed
 * when we started observing carries no such promise: nobody accepted a busy
 * pane in this life, and what is on screen outranks a verdict we did not see
 * made.
 *
 * `prior` is null for a task we have not observed yet, and an unobserved task
 * never flips: the first pass records a baseline, the next one decides. Going
 * offline clears the baseline, so restored panes are recorded rather than
 * compared against a memory of a terminal that no longer exists.
 *
 * Only `done` is eligible. A manual park is a decision about attention, not a
 * claim that nothing is running, and un-parking it behind the human's back
 * would put a task they deliberately silenced back into the queue.
 */
export function reviveTaskStatus(
  status: TaskStatus,
  now: TaskLiveness,
  prior: TaskLiveness | null,
  witnessed: boolean
): boolean {
  if (status !== 'done') return false
  if (!prior) return false
  if (now.live !== 'working' && now.live !== 'blocked') return false
  if (prior.live !== now.live) return true
  return !witnessed && prior.signature !== now.signature
}

export interface TaskView extends TaskRecord {
  /** Derived from live panes; `unknown` when herdr has no pane for the task. */
  liveStatus: AgentStatus
  /** True when herdr still has a pane for this task right now. */
  alive: boolean
  panes: PaneView[]
  groupKey: string
  groupLabel: string
  /** How long the task has been blocked, 0 when it is not. */
  blockedMs: number
  lastActivityAt: number
  /** Attention items pointing at this task. */
  needsMe: number
  dirty: number
  tokens: number
  recovery: RecoveryVerdict | ''
}

export interface StateCounts {
  working: number
  blocked: number
  done: number
  idle: number
  unknown: number
  needsMe: number
  total: number
}

export function emptyCounts(): StateCounts {
  return { working: 0, blocked: 0, done: 0, idle: 0, unknown: 0, needsMe: 0, total: 0 }
}

export function countStatus(counts: StateCounts, status: AgentStatus): void {
  if (status === 'working') counts.working += 1
  else if (status === 'blocked') counts.blocked += 1
  else if (status === 'done') counts.done += 1
  else if (status === 'idle') counts.idle += 1
  else counts.unknown += 1
}

export function stateCounts(views: readonly TaskView[]): StateCounts {
  const counts = emptyCounts()
  for (const view of views) {
    counts.total += 1
    countStatus(counts, view.liveStatus)
    if (view.needsMe > 0) counts.needsMe += 1
  }
  return counts
}

/* ------------------------------------------------------------------ *
 * Attention (triage)
 * ------------------------------------------------------------------ */

/**
 * The only five things an agent can need. Everything else is noise, and a queue
 * with noise in it is a queue the human stops reading.
 */
export type AttentionKind = 'permission' | 'question' | 'review' | 'stalled' | 'failed'

const KINDS: readonly string[] = ['permission', 'question', 'review', 'stalled', 'failed']

export function attentionKindOf(value: unknown): AttentionKind | '' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return KINDS.includes(raw) ? (raw as AttentionKind) : ''
}

/** Where the signal came from; hooks are ground truth, pixels are a guess. */
export type AttentionSource = 'hook' | 'herdr' | 'screen'

export type AttentionAction =
  | 'approve'
  | 'deny'
  | 'answer'
  | 'snooze'
  | 'open'
  | 'done'
  | 'dismiss'
  | 'reprompt'

export interface AttentionItem {
  /** Stable across re-renders: `${taskId}:${kind}:${origin}`, see attentionId. */
  id: string
  kind: AttentionKind
  source: AttentionSource
  taskId: string
  paneId: string
  workspaceId: string
  agentKind: string
  taskTitle: string
  groupLabel: string
  /** The decision itself, in the agent's own words where we have them. */
  title: string
  detail: string
  toolName: string
  command: string
  /**
   * The numbered rows the agent actually printed, read off the pane. Present
   * only when a read found a menu we are willing to swear to; absent means
   * "we could not read it", and the UI falls back to approve/deny.
   */
  options?: PaneOption[]
  /** Epoch ms the need first appeared. */
  since: number
  /** Epoch ms of the last update; ranking uses `since`. */
  updatedAt: number
  /** Epoch ms; 0 when not snoozed. A snoozed item stays listed, at the bottom. */
  snoozedUntil: number
  /** True once the human acted; the tracker drops it on the next tick. */
  resolved: boolean
}

export function attentionId(taskId: string, kind: AttentionKind, origin: string): string {
  return `${taskId || 'unfiled'}:${kind}:${origin || 'hook'}`
}

/**
 * Which buttons an item gets. The rule is that every item can be *answered in
 * place* or *opened*: an action set that forces a terminal focus is how a
 * workbench loses the decision-latency argument.
 */
export function attentionActions(kind: AttentionKind): AttentionAction[] {
  switch (kind) {
    case 'permission':
      return ['approve', 'deny', 'answer', 'snooze', 'open']
    case 'question':
      return ['answer', 'snooze', 'open']
    case 'failed':
      return ['reprompt', 'answer', 'open', 'dismiss']
    case 'review':
      return ['open', 'done', 'snooze']
    case 'stalled':
      return ['open', 'answer', 'snooze', 'dismiss']
  }
}

/**
 * Urgency, as a sort key. Live agents waiting on a human come first (nothing
 * progresses until they are answered), then dead ones, then finished work
 * awaiting review, then stalls — the weakest signal, because a long-running
 * command and a hung agent look identical from the outside. Snoozed items sink
 * but never vanish: a snooze is a delay, not a dismissal.
 */
const KIND_URGENCY: Record<AttentionKind, number> = {
  permission: 0,
  question: 1,
  failed: 2,
  review: 3,
  stalled: 4
}

export function attentionRank(item: AttentionItem, now: number): [number, number, number, string] {
  const snoozed = item.snoozedUntil > now ? 1 : 0
  const waited = -(Math.max(0, now - item.since) || 0)
  return [snoozed, KIND_URGENCY[item.kind] ?? 9, waited, item.id]
}

export function compareAttention(a: AttentionItem, b: AttentionItem, now: number): number {
  const left = attentionRank(a, now)
  const right = attentionRank(b, now)
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return left[3] < right[3] ? -1 : left[3] > right[3] ? 1 : 0
}

export function rankAttention(items: readonly AttentionItem[], now: number): AttentionItem[] {
  return items
    .filter((item) => !item.resolved && item.snoozedUntil <= now)
    .slice()
    .sort((a, b) => compareAttention(a, b, now))
}

export function waitedMs(item: AttentionItem, now: number): number {
  return Math.max(0, now - (item.since || now))
}

/* ------------------------------------------------------------------ *
 * Approve / deny as key recipes
 * ------------------------------------------------------------------ */

/**
 * A decision is keystrokes sent to the agent's own TUI. herdr key names are
 * lowercase (`enter`, `esc`, `1`). Recipes are per-agent and *configurable*,
 * because the one thing a workbench must never do is press the wrong button
 * confidently: the UI always previews the keys it is about to send, and
 * free-text `agent.prompt` is available for every item regardless.
 */
export interface KeyRecipe {
  keys: string[]
  /** What the UI shows before sending, e.g. "1 (Yes, proceed)". */
  preview: string
}

export const DEFAULT_KEY_RECIPES: Readonly<Record<string, Record<'approve' | 'deny', KeyRecipe>>> = {
  codex: {
    approve: { keys: ['1'], preview: '1 - yes, proceed' },
    deny: { keys: ['esc'], preview: 'esc - no, and say why' }
  },
  claude: {
    approve: { keys: ['1'], preview: '1 - yes' },
    deny: { keys: ['esc'], preview: 'esc - no, and tell Claude what to do' }
  }
}

/**
 * User overrides as flat config data (`'codex.approve' -> '1 enter'`), because a
 * config file is not the place for nested objects and a settings field should
 * not have to know what a recipe looks like.
 */
export type KeyOverrides = Record<string, string>

export function overrideKey(agentKind: string, decision: 'approve' | 'deny'): string {
  return `${String(agentKind || '').trim().toLowerCase()}.${decision}`
}

function parseKeys(value: string): string[] {
  return String(value || '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8)
}

/**
 * `null` means "we will not guess for this agent": an unknown TUI gets a
 * free-text answer or an opened pane instead of a blind keystroke.
 */
export function decisionKeys(
  agentKind: string,
  decision: 'approve' | 'deny',
  overrides?: KeyOverrides | null
): KeyRecipe | null {
  const agent = String(agentKind || '').trim().toLowerCase()
  const override = overrides ? parseKeys(overrides[overrideKey(agent, decision)]) : []
  if (override.length) return { keys: override, preview: override.join(' ') }
  const recipe = DEFAULT_KEY_RECIPES[agent]?.[decision]
  if (!recipe || !recipe.keys.length) return null
  return { keys: recipe.keys.slice(), preview: recipe.preview }
}

/* ------------------------------------------------------------------ *
 * The agent's own menu, read off the screen
 * ------------------------------------------------------------------ */

/**
 * One numbered row of an agent's on-screen menu.
 *
 * A blind `1` cannot be right for every prompt. codex's exec approval offers
 * "Yes, proceed" / "Yes, and don't ask again for commands starting with X" /
 * "No, and tell Codex what to do differently"; its permissions prompt offers
 * four rows, where 2 is *this turn with strict auto review* and 3 is *for this
 * session*. Which row means "approve all" is a property of the prompt on
 * screen, not of the agent - so the honest move is to show the human the rows
 * the agent actually printed and let them choose.
 */
export interface PaneOption {
  /** 1-based, exactly as printed. This is also the digit we send. */
  index: number
  /** The row's own text, trailing shortcut marker removed. */
  label: string
  /** herdr key name for the row's accelerator, when it advertised one. */
  shortcut?: string
}

/**
 * A numbered row: `› 1. Yes, proceed (y)`, `2. Full Access`, `  3. No (esc)`.
 *
 * The pointer is optional and may be any of the marks a TUI draws, because
 * which one is on screen depends on the agent's theme and on whether this row
 * happens to be the selected one.
 */
const OPTION_LINE = /^\s*[›>*●▪·]?\s*(\d)\.\s+(.*)$/

/**
 * A trailing `(y)` / `(esc)` is the row's accelerator.
 *
 * Only a single lowercase letter or `esc` counts. `(default)`, `(current)` and
 * `(recommended)` are annotations codex prints beside model and effort rows,
 * and treating one as a shortcut would type the literal word `default` into
 * the pane as seven keystrokes.
 */
const SHORTCUT_TAIL = /\((?:([a-z])|esc)\)\s*$/

/**
 * Rows we will believe came from one menu.
 *
 * A scrollback holds every prompt the pane ever printed, so an unbounded scan
 * could stitch a three-row approval overlay onto a five-row model picker and
 * number the buttons wrong. Real menus top out at about six.
 */
const MAX_OPTIONS = 9

/** How many wrapped description lines may follow a row before it stops being one. */
const WRAP_MAX_LINES = 6

/**
 * Read an agent's numbered menu out of a pane's text.
 *
 * Returns `[]` when there is no menu we are willing to swear to. Empty means
 * "could not read it", never "there was nothing to choose": the caller falls
 * back to the per-agent recipe, and the UI keeps showing the generic buttons.
 *
 * Only the *last* run of numbered rows is returned, on the same reasoning
 * {@link paneReadHint} uses for the prompt line: a scrollback holds every menu
 * this pane ever drew, and the one nearest the cursor is the one the human is
 * looking at. Merging runs would rebuild a menu that no longer exists and offer
 * buttons that do something else entirely.
 */
export function parsePaneOptions(text: unknown): PaneOption[] {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n')
  if (!raw.trim()) return []

  let run: PaneOption[] = []
  let best: PaneOption[] = []
  let wrapped = 0

  const close = (): void => {
    // Two rows is the floor. A lone `1.` in the agent's own prose is a
    // numbered sentence, not a menu with a button in it.
    if (run.length >= 2) best = run
    run = []
    wrapped = 0
  }

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (!line.trim()) {
      close()
      continue
    }
    const match = OPTION_LINE.exec(line)
    if (match) {
      const index = Number(match[1])
      // Must count up from 1, and stay in range: a run that jumps to `7.` is
      // prose or a wrapped sentence that happens to start with a number.
      if (index !== run.length + 1 || index > MAX_OPTIONS) {
        close()
        if (index === 1) run.push(optionOf(index, match[2]))
        continue
      }
      run.push(optionOf(index, match[2]))
      wrapped = 0
      continue
    }
    // Not a row. It may be a description codex wrapped under the row above:
    // `2. Full Access       Codex can edit files outside this workspace and`
    // then `                     access the internet without asking...`.
    if (run.length && wrapped < WRAP_MAX_LINES) {
      const last = run[run.length - 1]
      last.label = `${last.label} ${line.trim()}`.replace(/\s+/g, ' ').trim()
      wrapped += 1
      continue
    }
    close()
  }
  close()
  return best
}

/** One row, with its accelerator split off into a herdr key name. */
function optionOf(index: number, body: string): PaneOption {
  const text = body.trim()
  const match = SHORTCUT_TAIL.exec(text)
  if (!match) return { index, label: text }
  const label = text.slice(0, text.length - match[0].length).trim()
  // A row that is nothing but `(y)` keeps its text: an empty button label is
  // worse than a redundant one.
  return { index, label: label || text, shortcut: match[1] ?? 'esc' }
}

/**
 * Compile one menu row into herdr keys.
 *
 * Both branches send exactly one key, and that is not a guess - it is what
 * codex does, checked against its own source and confirmed live. In a
 * non-searchable list a digit goes `actual_idx_for_enabled_number` ->
 * `select_shortcut`, and `select_shortcut` calls `accept(Primary)` immediately
 * unless the row asks for explicit confirmation, which approval rows do not. A
 * letter accelerator goes through `try_handle_shortcut` and accepts outright.
 *
 * So the footers that read "Press enter to confirm" describe how a human
 * confirms the row their arrow keys are already on. Appending `enter` to either
 * key presses Enter on whatever the agent draws *next* - and the next view is
 * usually another menu (pick a model, then pick an effort level), so the stray
 * Enter silently takes row 1 of a prompt nobody read. One key, then stop.
 */
export function keysForOption(option: PaneOption | null | undefined): string[] {
  if (!option) return []
  if (option.shortcut) return [option.shortcut]
  if (option.index >= 1 && option.index <= MAX_OPTIONS) return [String(option.index)]
  return []
}

/** The row `approve` falls back to when we read a menu but got no explicit pick. */
export function firstOptionKeys(options: readonly PaneOption[] | undefined): string[] {
  return keysForOption(options?.[0])
}

/**
 * The row `deny` falls back to, or nothing.
 *
 * Only a row that advertises `esc` counts, and only when exactly one does:
 * `esc` means "leave this prompt alone" in every TUI that draws it, whereas
 * "the last row" is only where the agent happened to put it. Guessing by
 * position is how a deny ends up approving.
 */
export function dismissOption(options: readonly PaneOption[] | undefined): PaneOption | null {
  const hits = (options ?? []).filter((option) => option.shortcut === 'esc')
  return hits.length === 1 ? hits[0] : null
}

/**
 * Which verb a row belongs to.
 *
 * A row is a refusal only when it is the one row that advertises `esc` (see
 * {@link dismissOption}); everything else is an approval of some scope. This
 * decides the button's colour and the ledger line, never which key is pressed -
 * the key comes from the row itself, so a mislabelled row cannot approve
 * anything it was not already going to.
 */
export function optionAction(
  option: PaneOption,
  options: readonly PaneOption[] | undefined
): 'approve' | 'deny' {
  const dismiss = dismissOption(options)
  return dismiss && dismiss.index === option.index ? 'deny' : 'approve'
}

/* ------------------------------------------------------------------ *
 * From "the human clicked Approve" to "what herdr is told to do"
 * ------------------------------------------------------------------ */

/**
 * The compiled form of an attention action. One union, produced by a pure
 * function, consumed by exactly one executor: the Bench button, the widget
 * bubble click and `POST /pro/answer` all end up here, so there is a single
 * audit trail and a single place that can be wrong.
 */
export type AttentionExecution =
  | { kind: 'keys'; itemId: string; taskId: string; paneId: string; keys: string[]; preview: string }
  | { kind: 'prompt'; itemId: string; taskId: string; paneId: string; text: string }
  | { kind: 'focus'; itemId: string; taskId: string; paneId: string }
  | { kind: 'snooze'; itemId: string; minutes: number; until: number }
  | { kind: 'resolve'; itemId: string; taskId: string; status: 'done' | 'dismissed' }
  | { kind: 'none'; itemId: string; code: NoExecCode; reason: string }

/**
 * Stable codes rather than prose, because "we will not press a button we are
 * unsure about" is a message the UI has to explain in two languages.
 */
export type NoExecCode =
  | 'no-recipe'
  | 'no-pane'
  | 'no-text'
  | 'no-context'
  | 'no-option'
  | 'unknown-action'

export const DEFAULT_SNOOZE_MINUTES = 10

export interface AttentionPlanInput {
  item: AttentionItem
  action: AttentionAction
  /** Free-text answer, or nothing for the keystroke verbs. */
  text?: string
  /**
   * Which numbered row of the agent's own menu to take, 1-based. Meaningful
   * only for `approve`/`deny`, and only when we read a menu off the pane.
   */
  option?: number
  now: number
  keys?: KeyOverrides | null
  snoozeMinutes?: number
  /** Needed by `reprompt`, which reconstructs the task's context. */
  task?: TaskRecord | null
  digest?: LedgerDigest | null
}

function none(input: AttentionPlanInput, code: NoExecCode, reason: string): AttentionExecution {
  return { kind: 'none', itemId: input.item.id, code, reason }
}

/**
 * The longest answer one click may type into a pane.
 *
 * This is not a UI preference. An answer is delivered as keystrokes: the
 * `agent.prompt` path when herdr knows the agent, and `sendText` + `enter` when
 * it does not. A TUI's input line has its own buffer, and past it the readline
 * layer starts dropping or re-wrapping bytes - so an unbounded paste does not
 * fail loudly, it arrives mangled and the agent answers a question nobody asked.
 * Past the cap the honest move is to open the pane, which is one click away.
 */
export const ANSWER_MAX_CHARS = 400

export interface AnswerText {
  /** What will actually be sent: one line, at most {@link ANSWER_MAX_CHARS}. */
  text: string
  /** True when the cap cut something off, so the UI can say so instead of lying. */
  clipped: boolean
}

/**
 * Normalize a human answer into the one line a pane can take.
 *
 * Every whitespace run - including the newlines a pasted paragraph carries -
 * folds to a single space, because a newline is Enter: the fallback path sends
 * the text and then presses enter itself, so an embedded one submits the first
 * half and types the rest into whatever the agent shows next. Length is counted
 * in code points, not UTF-16 units, so the cap never cuts an emoji in half and
 * leaves a lone surrogate to be typed into the terminal.
 *
 * Shared by all three callers (Bench answer box, widget bubble, `POST
 * /pro/answer`) through {@link planAttentionAction}, so what the ledger records
 * is what the pane received.
 */
export function answerText(raw: unknown): AnswerText {
  const flat = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const points = Array.from(flat)
  if (points.length <= ANSWER_MAX_CHARS) return { text: flat, clipped: false }
  // Cut on a space when one is near the end: a half word in the pane reads as a
  // typo, and the same half word is what the ledger line will quote forever.
  const head = points.slice(0, ANSWER_MAX_CHARS).join('')
  const lastSpace = head.lastIndexOf(' ')
  const text = (lastSpace > ANSWER_MAX_CHARS * 0.6 ? head.slice(0, lastSpace) : head).trimEnd()
  return { text, clipped: true }
}

/**
 * Compile a click into a herdr instruction.
 *
 * The load-bearing rule is the `null` recipe: an agent we have no keystroke
 * table for gets `{kind:'none'}` and never a guessed key. Pressing "1" in a TUI
 * that means something else is the one failure mode this product cannot survive,
 * because it is silent and it is the agent doing the damage.
 */
export function planAttentionAction(input: AttentionPlanInput): AttentionExecution {
  const { item, action, now } = input
  const taskId = item.taskId
  const paneId = item.paneId
  // Folded and capped here rather than in each caller: the Bench answer box, the
  // widget bubble and `POST /pro/answer` all reach this line, and a newline that
  // survives to `sendText` submits half a sentence early.
  const { text } = answerText(input.text)

  switch (action) {
    case 'approve':
    case 'deny': {
      if (!paneId) return none(input, 'no-pane', 'no live pane for this task')
      // The agent's own menu wins over our table for it. We read the rows off
      // the screen, so what we press is a row the human was shown and chose;
      // the table below is the fallback for a pane we could not read.
      const options = item.options ?? []
      if (input.option) {
        const picked = options.find((entry) => entry.index === input.option) ?? null
        if (!picked) {
          return none(input, 'no-option', `the menu on screen has no row ${input.option}`)
        }
        const keys = keysForOption(picked)
        if (!keys.length) return none(input, 'no-option', `row ${picked.index} has no key we can send`)
        return { kind: 'keys', itemId: item.id, taskId, paneId, keys, preview: keys.join(' ') }
      }
      if (options.length) {
        const chosen = action === 'approve' ? options[0] : dismissOption(options)
        const keys = keysForOption(chosen)
        // A deny with no `esc` row falls through to the table rather than
        // pressing a row we cannot tell is a refusal.
        if (keys.length && (action === 'approve' || chosen)) {
          return { kind: 'keys', itemId: item.id, taskId, paneId, keys, preview: keys.join(' ') }
        }
      }
      const recipe = decisionKeys(item.agentKind, action, input.keys ?? null)
      if (!recipe) {
        return none(
          input,
          'no-recipe',
          `no ${action} keystrokes known for ${item.agentKind || 'this agent'}`
        )
      }
      return { kind: 'keys', itemId: item.id, taskId, paneId, keys: recipe.keys, preview: recipe.preview }
    }
    case 'answer': {
      if (!text) return none(input, 'no-text', 'an answer needs text')
      if (!paneId) return none(input, 'no-pane', 'no live pane for this task')
      return { kind: 'prompt', itemId: item.id, taskId, paneId, text }
    }
    case 'reprompt': {
      if (!paneId) return none(input, 'no-pane', 'no live pane for this task')
      const task = input.task
      if (!task) return none(input, 'no-context', 'task record is gone')
      const body = rePromptText(task, input.digest ?? null)
      if (!body) return none(input, 'no-context', 'nothing recorded to re-prompt with')
      return { kind: 'prompt', itemId: item.id, taskId, paneId, text: body }
    }
    case 'open': {
      if (!paneId) return none(input, 'no-pane', 'no live pane for this task')
      return { kind: 'focus', itemId: item.id, taskId, paneId }
    }
    case 'snooze': {
      const minutes = Math.min(240, Math.max(1, Math.round(input.snoozeMinutes ?? DEFAULT_SNOOZE_MINUTES)))
      return { kind: 'snooze', itemId: item.id, minutes, until: now + minutes * 60000 }
    }
    case 'done':
      return { kind: 'resolve', itemId: item.id, taskId, status: 'done' }
    case 'dismiss':
      return { kind: 'resolve', itemId: item.id, taskId, status: 'dismissed' }
    default:
      return none(input, 'unknown-action', `unknown action ${String(action)}`)
  }
}

/* ------------------------------------------------------------------ *
 * Ledger
 * ------------------------------------------------------------------ */

/**
 * One append-only line. Kinds are deliberately small and flat: this file is
 * read back by a recovery planner that must work even when the writer was a
 * newer version of us, so no nesting and no required fields beyond `at`/`kind`.
 */
export type LedgerKind =
  | 'goal'
  | 'plan'
  | 'decision'
  | 'next'
  | 'event'
  | 'git'
  | 'session'
  | 'metric'
  | 'checkpoint'
  | 'note'

const LEDGER_KINDS: readonly string[] = [
  'goal',
  'plan',
  'decision',
  'next',
  'event',
  'git',
  'session',
  'metric',
  'checkpoint',
  'note'
]

export interface LedgerEntry {
  v: 1
  at: number
  id: string
  taskId: string
  kind: LedgerKind
  text: string
  agent: string
  sessionKind: 'id' | 'path' | ''
  sessionValue: string
  gitHead: string
  branch: string
  dirty: number
  paneId: string
  workspaceId: string
  /** `hook` | `gui` | `api` | `agent` | `herdr` — who asserted this. */
  source: string
}

export function parseLedgerEntry(value: unknown): LedgerEntry | null {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const kind = str(raw.kind).toLowerCase()
  if (!LEDGER_KINDS.includes(kind)) return null
  const at = num(raw.at)
  return {
    v: 1,
    at,
    id: str(raw.id) || `${at.toString(36)}-${kind}`,
    taskId: str(raw.taskId),
    kind: kind as LedgerKind,
    text: str(raw.text),
    agent: str(raw.agent).toLowerCase(),
    sessionKind: raw.sessionKind === 'path' ? 'path' : raw.sessionKind === 'id' ? 'id' : '',
    sessionValue: str(raw.sessionValue),
    gitHead: str(raw.gitHead),
    branch: str(raw.branch),
    dirty: num(raw.dirty),
    paneId: str(raw.paneId),
    workspaceId: str(raw.workspaceId),
    source: str(raw.source) || 'hook'
  }
}

/** Parse a whole JSONL body, dropping corrupt lines instead of failing. */
export function parseLedger(body: string): LedgerEntry[] {
  const out: LedgerEntry[] = []
  for (const line of String(body || '').split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      const entry = parseLedgerEntry(JSON.parse(text))
      if (entry) out.push(entry)
    } catch {
      /* a truncated tail from a crash mid-write is expected, not an error */
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

export interface LedgerDigest {
  taskId: string
  goal: string
  plan: string[]
  decisions: string[]
  next: string
  agent: string
  sessionKind: 'id' | 'path' | ''
  sessionValue: string
  gitHead: string
  branch: string
  dirty: number
  lastAt: number
  entries: number
}

const PLAN_LIMIT = 24
const DECISION_LIMIT = 40

/**
 * Fold a ledger into "what was this task about". Last write wins for `goal` and
 * `next` (they are current state); `plan` and `decisions` accumulate, capped,
 * because a 400-line history is not a recovery brief.
 */
export function ledgerDigest(taskId: string, entries: readonly LedgerEntry[]): LedgerDigest {
  const digest: LedgerDigest = {
    taskId,
    goal: '',
    plan: [],
    decisions: [],
    next: '',
    agent: '',
    sessionKind: '',
    sessionValue: '',
    gitHead: '',
    branch: '',
    dirty: 0,
    lastAt: 0,
    entries: 0
  }
  for (const entry of entries) {
    if (taskId && entry.taskId && entry.taskId !== taskId) continue
    digest.entries += 1
    if (entry.at > digest.lastAt) digest.lastAt = entry.at
    switch (entry.kind) {
      case 'goal':
        if (entry.text) digest.goal = entry.text
        break
      case 'plan':
        if (entry.text) pushCapped(digest.plan, entry.text, PLAN_LIMIT)
        break
      case 'decision':
        if (entry.text) pushCapped(digest.decisions, entry.text, DECISION_LIMIT)
        break
      case 'next':
        digest.next = entry.text
        break
      case 'session':
        if (entry.sessionValue) {
          // An id is strictly better evidence than a path; never let a later
          // path-only line overwrite a resumable id.
          if (entry.sessionKind === 'id' || digest.sessionKind !== 'id') {
            digest.sessionKind = entry.sessionKind || 'id'
            digest.sessionValue = entry.sessionValue
          }
        }
        if (entry.agent) digest.agent = entry.agent
        break
      case 'git':
        if (entry.gitHead) digest.gitHead = entry.gitHead
        if (entry.branch) digest.branch = entry.branch
        digest.dirty = entry.dirty
        break
      default:
        break
    }
    if (entry.agent && !digest.agent) digest.agent = entry.agent
  }
  return digest
}

function pushCapped(list: string[], text: string, limit: number): void {
  const at = list.indexOf(text)
  if (at >= 0) list.splice(at, 1)
  list.push(text)
  if (list.length > limit) list.splice(0, list.length - limit)
}

/* ------------------------------------------------------------------ *
 * Recovery
 * ------------------------------------------------------------------ */

/**
 * `intact`   pane alive, state known — show it.
 * `resumable` conversation id known, pane gone — relaunch with resume args.
 * `rebuild`  directory or workspace missing — recreate, then resume.
 * `lost`     no id anywhere — show the last goal + next, offer a re-prompt.
 * `offline`  herdr is not running — nothing can be known yet.
 * `parked`   the human parked or finished it; recovery must not touch it.
 */
export type RecoveryVerdict = 'intact' | 'resumable' | 'rebuild' | 'lost' | 'offline' | 'parked'

export type RecoveryStep =
  | { kind: 'workspace'; cwd: string; label: string }
  | { kind: 'worktree'; cwd: string; branch: string; base: string; path: string }
  | { kind: 'agent'; agent: string; args: string[]; cwd: string }
  | { kind: 'prompt'; text: string }
  | { kind: 'notice'; text: string }

export interface RecoveryPlan {
  taskId: string
  title: string
  verdict: RecoveryVerdict
  /** One sentence for the UI: why this verdict, in plain terms. */
  reason: string
  steps: RecoveryStep[]
  /** The context block a lost task can be re-prompted with. '' when pointless. */
  rePrompt: string
  /** True when `Apply` has something to do. */
  actionable: boolean
}

/**
 * Verdicts that do not earn a row in the recovery tab, or a line from
 * `codewaifu pro recovery`.
 *
 * `intact` is the normal case, and listing thirty green rows to say "nothing is
 * broken" is the kind of noise that trains people to ignore the tab. `parked` is
 * filtered too: a task the human deliberately stopped is not a disaster, and
 * recovery is contractually forbidden to touch it.
 */
export const HIDDEN_VERDICTS: readonly RecoveryVerdict[] = ['intact', 'parked']

/**
 * Which plans are worth showing, as a pure function of the projection.
 *
 * The recovery tab's count badge, the panel's rows and the CLI's list are three
 * renders of one decision, so the decision lives here and nowhere else. A filter
 * duplicated in a component and in a terminal renderer is how a badge ends up
 * saying 1 while the list below it says 0.
 */
export function needsRecovery(plans: readonly RecoveryPlan[]): RecoveryPlan[] {
  return plans.filter((plan) => !HIDDEN_VERDICTS.includes(plan.verdict))
}

/**
 * The command-shaped summary of one step, in the words both surfaces use.
 *
 * `prompt` and `notice` collapse to one line on purpose: a 400-token re-prompt
 * inside a banner, or inside a terminal row, buries the thing it belongs to.
 */
export function recoveryStepText(step: RecoveryStep): string {
  switch (step.kind) {
    case 'workspace':
      return step.cwd || step.label
    case 'worktree': {
      const base = step.base ? ` ${step.base}` : ''
      return `git worktree add ${step.path} -b ${step.branch}${base}`
    }
    case 'agent':
      return [step.agent, ...step.args].filter(Boolean).join(' ')
    case 'prompt':
    case 'notice':
      return oneLineText(step.text)
  }
}

/**
 * `...`, not the typographic ellipsis: this one string is rendered by a browser
 * and by a terminal, and `shared/proCli` promises ASCII because a console we
 * cannot see is no place to gamble on a code page.
 */
function oneLineText(text: string, limit = 120): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 3)}...` : flat
}

/** Probed facts about the world, gathered by main/pro/recovery.ts. */
export interface RecoveryFacts {
  herdrOnline: boolean
  /** The task's directory (or worktree checkout) still exists on disk. */
  dirExists: boolean
  /** herdr still has this workspace id. */
  workspaceId: string
  /** A live pane bound to the task, '' when none. */
  paneId: string
  /** Live session ref herdr reports for that pane, when any. */
  sessionRef: AgentSessionRef | null
}

/**
 * herdr's resume table, verbatim: argv *after* the binary. An agent we do not
 * know gets no args, and the plan then falls back to a re-prompt rather than
 * inventing a flag that silently starts a fresh conversation.
 */
const RESUME_ARGS: Readonly<Record<string, (id: string) => string[]>> = {
  codex: (id) => ['resume', id],
  claude: (id) => ['--resume', id],
  copilot: (id) => [`--resume=${id}`],
  omp: (id) => [`--resume=${id}`],
  devin: (id) => ['--resume', id],
  droid: (id) => ['--resume', id],
  grok: (id) => ['--resume', id],
  qwen: (id) => ['--resume', id]
}

export function resumeArgsFor(agent: string, sessionId: string, kind: 'id' | 'path' = 'id'): string[] {
  const key = String(agent || '').trim().toLowerCase()
  const id = String(sessionId || '').trim()
  if (!id || kind !== 'id') return []
  const build = RESUME_ARGS[key]
  return build ? build(id) : []
}

/**
 * Diff the ledger against reality and decide. Order matters: the human's
 * explicit park outranks every probe, an offline herdr outranks every "pane is
 * gone", and a missing directory outranks a missing session id (recreating the
 * checkout is a step, forgetting the conversation is not recoverable).
 */
export function planRecovery(input: {
  task: TaskRecord
  digest: LedgerDigest | null
  facts: RecoveryFacts
}): RecoveryPlan {
  const { task, digest, facts } = input
  const sessionId = digest?.sessionValue || task.agentSessionId
  const sessionKind: 'id' | 'path' = digest?.sessionKind === 'path' || (!digest?.sessionKind && task.agentSessionPath)
    ? 'path'
    : 'id'
  const agent = digest?.agent || task.agentKind
  const base: Omit<RecoveryPlan, 'verdict' | 'reason' | 'steps' | 'actionable'> = {
    taskId: task.id,
    title: task.title,
    rePrompt: ''
  }

  if (task.status === 'parked' || task.status === 'done') {
    return {
      ...base,
      verdict: 'parked',
      reason: task.status === 'done' ? 'marked done' : 'parked by you',
      steps: [],
      rePrompt: rePromptText(task, digest),
      actionable: false
    }
  }
  if (!facts.herdrOnline) {
    return {
      ...base,
      verdict: 'offline',
      reason: 'herdr is not running; start it to see live state',
      steps: [{ kind: 'notice', text: 'start the herdr server, then re-run recovery' }],
      actionable: false
    }
  }
  if (facts.paneId) {
    return { ...base, verdict: 'intact', reason: 'pane alive', steps: [], actionable: false }
  }

  const rePrompt = rePromptText(task, digest)
  const args = resumeArgsFor(agent, sessionId, sessionKind)

  if (!args.length) {
    // No resumable conversation: the honest verdict is `lost`, even when the
    // directory is fine. What survives is the intent, so the plan hands back a
    // prompt that carries it.
    const steps: RecoveryStep[] = []
    if (!facts.dirExists || !facts.workspaceId) {
      steps.push({ kind: 'workspace', cwd: task.workdir, label: task.title })
    }
    if (agent) steps.push({ kind: 'agent', agent, args: [], cwd: task.workdir })
    if (rePrompt) steps.push({ kind: 'prompt', text: rePrompt })
    return {
      ...base,
      verdict: 'lost',
      reason: sessionId
        ? `session is a ${sessionKind} reference, not a resumable id`
        : 'no agent session id was ever captured',
      steps,
      rePrompt,
      actionable: steps.length > 0
    }
  }

  if (!facts.dirExists || !facts.workspaceId) {
    const steps: RecoveryStep[] = []
    if (!facts.dirExists && task.branch) {
      steps.push({
        kind: 'worktree',
        cwd: task.repoRoot || task.workdir,
        branch: task.branch,
        base: '',
        path: task.workdir
      })
    } else if (!facts.dirExists) {
      steps.push({ kind: 'workspace', cwd: task.repoRoot || task.workdir, label: task.title })
    }
    if (!facts.workspaceId) steps.push({ kind: 'workspace', cwd: task.workdir, label: task.title })
    steps.push({ kind: 'agent', agent, args, cwd: task.workdir })
    return {
      ...base,
      verdict: 'rebuild',
      reason: !facts.dirExists ? 'workdir is gone' : 'herdr lost the workspace',
      steps,
      rePrompt,
      actionable: true
    }
  }

  return {
    ...base,
    verdict: 'resumable',
    reason: `resume ${agent || 'agent'} ${sessionId.slice(0, 8)}`,
    steps: [{ kind: 'agent', agent, args, cwd: task.workdir }],
    rePrompt,
    actionable: true
  }
}

/**
 * The context block that makes a lost task cheap to restart: what it was for,
 * what was decided, what was next, and where the code is. This is the artifact
 * that turns "the agent died" from a catastrophe into an annoyance, and it is
 * also the handoff text for moving a task to a different model.
 */
export function rePromptText(task: TaskRecord, digest: LedgerDigest | null): string {
  const lines: string[] = []
  const goal = digest?.goal || task.goal
  if (goal) lines.push(`Goal: ${goal}`)
  const next = digest?.next
  if (next) lines.push(`Next action: ${next}`)
  if (digest?.decisions.length) {
    lines.push('Decisions already made:')
    for (const decision of digest.decisions.slice(-8)) lines.push(`- ${decision}`)
  }
  if (digest?.plan.length) {
    lines.push('Plan:')
    for (const step of digest.plan.slice(-8)) lines.push(`- ${step}`)
  }
  const branch = digest?.branch || task.branch
  const head = digest?.gitHead
  if (branch || head) lines.push(`Code: ${[branch && `branch ${branch}`, head && `head ${head}`].filter(Boolean).join(', ')}`)
  if (task.workdir) lines.push(`Workdir: ${task.workdir}`)
  if (!lines.length) return ''
  lines.unshift('Resuming a task whose previous agent session is gone.')
  lines.push('Confirm the current state of the work, then continue from the next action.')
  return lines.join('\n')
}

/** Same content, framed for a *different* agent or model taking the task over. */
export function handoffPrompt(task: TaskRecord, digest: LedgerDigest | null): string {
  const body = rePromptText(task, digest)
  if (!body) return ''
  return `You are taking over this task from another agent.\n\n${body}`
}

/* ------------------------------------------------------------------ *
 * Binding tasks to herdr reality
 * ------------------------------------------------------------------ */

export interface TaskBinding {
  taskId: string
  workspaceId: string
  paneIds: string[]
  /** How the binding was found; `stale` means nothing in herdr matches. */
  matchedBy: 'workspace' | 'session' | 'workdir' | 'stale'
}

/**
 * Re-bind a task to live panes. Workspace ids survive a herdr restart, but they
 * do not survive a rebuild, and the point of the ledger is that a task keeps its
 * identity when its terminal does not — so fall back to the conversation id,
 * then to the directory.
 *
 * `avoid` is the set of workspaces a stronger match already holds. Only the
 * directory fallback consults it, because that fallback is a guess about which
 * shell this task is running in, and a guess must not take a workspace away
 * from a task that knows it owns it.
 */
export function bindTask(
  task: TaskRecord,
  snapshot: Snapshot | null,
  avoid?: ReadonlySet<string>
): TaskBinding {
  const empty: TaskBinding = { taskId: task.id, workspaceId: '', paneIds: [], matchedBy: 'stale' }
  if (!snapshot) return empty
  const panes = snapshot.panes

  if (task.workspaceId) {
    const own = panes.filter((pane) => pane.workspaceId === task.workspaceId)
    if (own.length) {
      return {
        taskId: task.id,
        workspaceId: task.workspaceId,
        paneIds: task.paneIds.length
          ? task.paneIds.filter((id) => own.some((pane) => pane.paneId === id))
          : own.map((pane) => pane.paneId),
        matchedBy: 'workspace'
      }
    }
  }
  const wanted = task.agentSessionId
  if (wanted) {
    const hit = panes.find((pane) => pane.agentSession?.value === wanted)
    if (hit) {
      return {
        taskId: task.id,
        workspaceId: hit.workspaceId,
        paneIds: panes
          .filter((pane) => pane.workspaceId === hit.workspaceId)
          .map((pane) => pane.paneId),
        matchedBy: 'session'
      }
    }
  }
  if (task.workdir) {
    const hit = panes.find(
      (pane) =>
        !(avoid?.has(pane.workspaceId) ?? false) &&
        (samePath(pane.foregroundCwd, task.workdir) || samePath(pane.cwd, task.workdir))
    )
    if (hit) {
      return {
        taskId: task.id,
        workspaceId: hit.workspaceId,
        paneIds: panes
          .filter((pane) => pane.workspaceId === hit.workspaceId)
          .map((pane) => pane.paneId),
        matchedBy: 'workdir'
      }
    }
  }
  return empty
}

/**
 * Bind a whole roster in two passes, so no two rows end up owning one shell.
 *
 * Per-task binding cannot see the rest of the roster, and its weakest rule -
 * "some pane has my directory as cwd" - is the one that collides: every shell
 * opened in the same repo matches every task rooted there. Bound alone, a task
 * whose own workspace is momentarily missing from the snapshot grabs a
 * neighbour's instead, and `rebind` then writes that guess back to disk, so the
 * two rows stay glued to one pane across restarts.
 *
 * Pass one binds normally and collects what the strong rules (the stored
 * workspace id, the conversation id) actually hold. Pass two re-binds only the
 * rows whose match came from the directory guess and landed on a held
 * workspace, this time told to step around it - they keep looking for a shell of
 * their own and go `stale` when there is none, which is honest.
 */
export function bindTasks(
  tasks: readonly TaskRecord[],
  snapshot: Snapshot | null
): TaskBinding[] {
  const first = tasks.map((task) => bindTask(task, snapshot))
  if (!snapshot) return first
  const held = new Set<string>()
  for (const binding of first) {
    if (binding.workspaceId && binding.matchedBy !== 'workdir') held.add(binding.workspaceId)
  }
  if (!held.size) return first
  return first.map((binding, index) => {
    if (binding.matchedBy !== 'workdir' || !held.has(binding.workspaceId)) return binding
    return bindTask(tasks[index], snapshot, held)
  })
}

export interface ProvisionInput {
  snapshot: Snapshot | null
  tasks: readonly TaskRecord[]
  now: number
  /** Injectable id factory; the registry owns uniqueness, not this module. */
  newId: () => string
  /**
   * Workspace ids the human removed and herdr has not yet let go of. They are
   * declined rather than unclaimed: adopting one back is how "I closed that
   * terminal" turns into five terminals the next time a snapshot arrives.
   */
  forgotten?: readonly string[]
}

export interface ProvisionResult {
  created: TaskRecord[]
  bindings: TaskBinding[]
}

/**
 * Adopt whatever herdr already has. Nobody should have to change how they work
 * to get value from the bench, so every workspace with no task becomes one on
 * first sight, and every existing task gets re-bound to live panes.
 */
export function provisionTasks(input: ProvisionInput): ProvisionResult {
  const { snapshot, tasks, now, newId } = input
  const forgotten = new Set((input.forgotten ?? []).filter(Boolean))
  const bindings = bindTasks(tasks, snapshot)
  const created: TaskRecord[] = []
  if (!snapshot) return { created, bindings }

  const claimed = new Set<string>()
  for (const binding of bindings) {
    if (binding.workspaceId) claimed.add(binding.workspaceId)
    for (const paneId of binding.paneIds) claimed.add(paneId)
  }
  for (const task of tasks) {
    for (const paneId of task.paneIds) claimed.add(paneId)
    if (task.workspaceId) claimed.add(task.workspaceId)
  }

  for (const workspace of snapshot.workspaces) {
    if (claimed.has(workspace.workspaceId)) continue
    if (forgotten.has(workspace.workspaceId)) continue
    const panes = snapshot.panes.filter((pane) => pane.workspaceId === workspace.workspaceId)
    if (!panes.length) continue
    const first = panes[0]
    const workdir = workspace.worktree?.checkoutPath || first.foregroundCwd || first.cwd
    created.push({
      id: newId(),
      title: workspace.label || pathBase(workdir) || `workspace ${workspace.number}`,
      goal: '',
      workdir,
      repoRoot: workspace.worktree?.repoRoot || workdir,
      branch: '',
      agentKind: first.displayAgent || first.agent,
      agentSessionId: first.agentSession?.kind === 'id' ? first.agentSession.value : '',
      agentSessionPath: first.agentSession?.kind === 'path' ? first.agentSession.value : '',
      workspaceId: workspace.workspaceId,
      paneIds: panes.map((pane) => pane.paneId),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      parkedAt: 0,
      // Adopted, not created: herdr was already running this, and the row says
      // so, because "where did this come from" is the first question a tree
      // full of somebody else's sessions gets asked.
      origin: 'adopted'
    })
    claimed.add(workspace.workspaceId)
  }
  return { created, bindings }
}

/** Live vitals for one workspace, used by rows that are not tasks (yet). */
export function workspaceStatus(snapshot: Snapshot, workspace: WorkspaceInfo): AgentStatus {
  const statuses = snapshot.panes
    .filter((pane) => pane.workspaceId === workspace.workspaceId)
    .map((pane) => pane.agentStatus)
  return statuses.length ? foldStatus(statuses) : workspace.agentStatus
}

/* ------------------------------------------------------------------ *
 * The projection
 * ------------------------------------------------------------------ */

export interface HerdrView {
  online: boolean
  version: string
  socketPath: string
  /** '' when online; otherwise why not (missing binary, refused, timeout). */
  error: string
  workspaces: number
  panes: number
}

export interface BenchInput {
  now: number
  herdr: HerdrView
  snapshot: Snapshot | null
  tasks: readonly TaskRecord[]
  /** Raw tracked items; ranking happens here so every surface sees one order. */
  attention: readonly AttentionItem[]
  digests?: Record<string, LedgerDigest | null>
  recovery?: readonly RecoveryPlan[]
  /** Pane ids currently bridged to an xterm view. */
  attachedPanes?: readonly string[]
  /** Blocked-since per task, from the triage tracker. */
  blockedSince?: Record<string, number>
  /** Workspace ids a remembered removal is holding off the bench. */
  forgotten?: readonly string[]
  companion?: { visible: boolean; notices: number }
}

export interface BenchView {
  generatedAt: number
  herdr: HerdrView
  counts: StateCounts
  groups: GroupView[]
  tasks: TaskView[]
  attention: AttentionItem[]
  recovery: RecoveryPlan[]
  /**
   * Live herdr workspaces the bench is refusing to adopt because the human
   * removed them. Suppression that nobody can see reads as a lost terminal, so
   * it is reported here with the count that makes the topbar chip honest.
   */
  declined: DeclinedWorkspace[]
  companion: { visible: boolean; notices: number }
}

/** One live workspace a remembered removal is standing in front of. */
export interface DeclinedWorkspace {
  workspaceId: string
  label: string
  panes: number
  agentStatus: AgentStatus
}

/**
 * Which of herdr's live workspaces the bench is declining, and why the question
 * is worth asking out loud.
 *
 * A removal that only drops the row leaves the shell running - that is what the
 * confirmation promises - so herdr keeps reporting it and adoption keeps
 * stepping around it. Left invisible, that is a terminal the human closed and
 * can no longer find anywhere. Sorted by id so the chip's tooltip is stable
 * across snapshots rather than reshuffling on every push.
 */
export function declinedWorkspaces(
  snapshot: Snapshot | null,
  forgotten: readonly string[]
): DeclinedWorkspace[] {
  if (!snapshot || !forgotten.length) return []
  const blocked = new Set(forgotten.filter(Boolean))
  if (!blocked.size) return []
  const out: DeclinedWorkspace[] = []
  for (const workspace of snapshot.workspaces) {
    if (!blocked.has(workspace.workspaceId)) continue
    out.push({
      workspaceId: workspace.workspaceId,
      label: workspace.label || pathBase(workspace.worktree?.checkoutPath || '') || `workspace ${workspace.number}`,
      panes: workspace.paneCount,
      agentStatus: workspaceStatus(snapshot, workspace)
    })
  }
  out.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.label.localeCompare(b.label))
  return out
}

/**
 * The single projection every surface renders. Tree, queue, task card, badge and
 * widget bubble are all reads of this object, which is what keeps them from
 * drifting: there is no second place where "needs me" is computed.
 */
export function buildBench(input: BenchInput): BenchView {
  const { now, snapshot } = input
  const attention = rankAttention(input.attention, now)
  const attached = new Set(input.attachedPanes ?? [])
  const blockedSince = input.blockedSince ?? {}
  const needsByTask = new Map<string, number>()
  for (const item of attention) needsByTask.set(item.taskId, (needsByTask.get(item.taskId) ?? 0) + 1)

  const panesById = new Map<string, PaneInfo>()
  for (const pane of snapshot?.panes ?? []) panesById.set(pane.paneId, pane)

  const verdictByTask = new Map<string, RecoveryVerdict>()
  for (const plan of input.recovery ?? []) verdictByTask.set(plan.taskId, plan.verdict)

  const views: TaskView[] = input.tasks.map((task) => {
    const binding = bindTask(task, snapshot)
    const live = binding.paneIds.map((id) => panesById.get(id)).filter(nonNull)
    const panes = live.map((pane) => paneViewOf(pane, attached.has(pane.paneId)))
    const statuses = live.map((pane) => pane.agentStatus)
    // No live pane means no live state: `unknown` is honest, and the recovery
    // verdict on the same row is what explains why.
    const liveStatus = live.length ? foldStatus(statuses) : ('unknown' as AgentStatus)
    const blockedMs =
      liveStatus === 'blocked' && blockedSince[task.id]
        ? Math.max(0, now - blockedSince[task.id])
        : 0
    const lastActivityAt = live.reduce((latest, pane) => Math.max(latest, pane.revision), task.updatedAt)
    const tokens = live.reduce((total, pane) => total + tokenTotal(pane.tokens), 0)
    const groupKey = groupKeyFor(task)
    const digest = input.digests?.[task.id] ?? null
    return {
      ...task,
      workspaceId: binding.workspaceId || task.workspaceId,
      paneIds: binding.paneIds.length ? binding.paneIds : task.paneIds,
      branch: task.branch || digest?.branch || '',
      dirty: digest?.dirty ?? 0,
      agentKind: task.agentKind || digest?.agent || panes[0]?.displayAgent || '',
      agentSessionId: task.agentSessionId || (digest?.sessionKind === 'id' ? digest.sessionValue : ''),
      liveStatus,
      alive: live.length > 0,
      panes,
      groupKey,
      groupLabel: groupLabelFor(groupKey),
      blockedMs,
      lastActivityAt: task.updatedAt && lastActivityAt < task.updatedAt ? task.updatedAt : lastActivityAt,
      needsMe: needsByTask.get(task.id) ?? 0,
      tokens,
      recovery: verdictByTask.get(task.id) ?? ''
    }
  })

  views.sort(compareTasks)
  const groups = deriveGroups(views)
  return {
    generatedAt: now,
    herdr: input.herdr,
    counts: stateCounts(views),
    groups,
    tasks: views,
    attention,
    recovery: (input.recovery ?? []).slice(),
    declined: declinedWorkspaces(snapshot, input.forgotten ?? []),
    companion: input.companion ?? { visible: false, notices: 0 }
  }
}

function nonNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined
}

function tokenTotal(tokens: Record<string, string>): number {
  let total = 0
  for (const value of Object.values(tokens)) {
    const n = Number(value)
    if (Number.isFinite(n)) total += n
  }
  return total
}

/**
 * Tree order: tasks that need a decision float to the top of their group, and
 * otherwise the order is alphabetical and stable. Movement in a tree should
 * mean something, so the only thing that reorders a row is "it needs you now".
 */
export function compareTasks(a: TaskView, b: TaskView): number {
  const rankA = taskSortRank(a)
  const rankB = taskSortRank(b)
  if (rankA !== rankB) return rankA - rankB
  const byTitle = a.title.localeCompare(b.title)
  if (byTitle !== 0) return byTitle
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function taskSortRank(task: TaskView): number {
  if (task.needsMe > 0) return 0
  if (task.status === 'active') return task.liveStatus === 'working' ? 1 : 2
  if (task.status === 'lost') return 3
  return 4
}

export function deriveGroups(views: readonly TaskView[]): GroupView[] {
  const byKey = new Map<string, TaskView[]>()
  for (const view of views) {
    const list = byKey.get(view.groupKey)
    if (list) list.push(view)
    else byKey.set(view.groupKey, [view])
  }
  const groups: GroupView[] = []
  for (const [key, tasks] of byKey) {
    groups.push({ key, label: groupLabelFor(key), hint: groupHintFor(key), tasks, counts: stateCounts(tasks) })
  }
  // Group order is alphabetical and never urgency-driven: a jumping tree is
  // unreadable, and urgency already lives in the attention queue.
  groups.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key))
  return groups
}

/**
 * The tree's one facet: everything, only what you made here, or only what came
 * in from outside (adopted from herdr, imported from the session list).
 *
 * A facet rather than a fourth group, because the spine is directories and two
 * homes for one task is a tree that lies about where work lives. Filtering is
 * pure and drops empty groups, so the rail never shows a heading with nothing
 * under it; counts are recomputed from the rows that survived, never carried
 * over from the unfiltered group.
 */
export type TreeFilter = 'all' | 'mine' | 'imported'

export const TREE_FILTERS: readonly TreeFilter[] = ['all', 'mine', 'imported']

export function treeFilterOf(value: unknown): TreeFilter {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return raw === 'mine' || raw === 'imported' ? raw : 'all'
}

function keepsTask(filter: TreeFilter, task: TaskView): boolean {
  if (filter === 'mine') return task.origin === 'created'
  if (filter === 'imported') return task.origin !== 'created'
  return true
}

export function filterGroups(groups: readonly GroupView[], filter: TreeFilter): GroupView[] {
  if (filter === 'all') return groups.slice()
  return groups
    .map((group) => {
      const tasks = group.tasks.filter((task) => keepsTask(filter, task))
      return { ...group, tasks, counts: stateCounts(tasks) }
    })
    .filter((group) => group.tasks.length > 0)
}

/** What the facet chips are labelled with. Computed from the same rows. */
export interface OriginCounts {
  all: number
  mine: number
  imported: number
  /** Rows a "needs me only" filter would keep, so its chip can promise a count
   *  like the origin facets do. Over the unfiltered tree, same as the facets. */
  needsMe: number
}

export function originCounts(groups: readonly GroupView[]): OriginCounts {
  const counts: OriginCounts = { all: 0, mine: 0, imported: 0, needsMe: 0 }
  for (const group of groups) {
    for (const task of group.tasks) {
      counts.all += 1
      if (task.origin === 'created') counts.mine += 1
      else counts.imported += 1
      if (task.needsMe > 0) counts.needsMe += 1
    }
  }
  return counts
}

/** The badge number: what the tray, the widget and the tree header all show. */
export function needsMeCount(attention: readonly AttentionItem[], now: number): number {
  return attention.filter((item) => !item.resolved && item.snoozedUntil <= now).length
}

/** Why a pane's control process could not be started, as a reason and not as text. */
export interface SpawnFailure {
  /** Same vocabulary as `HerdrTarget.reason`, so one fix reads the same everywhere. */
  reason: 'no-binary' | 'not-executable' | ''
  /** The path Node tried, '' when the message did not carry one. */
  binary: string
}

/**
 * Turn a failed `spawn` into a reason the pane can put into words.
 *
 * Node reports a control process it could not start as `spawn /path/herdr ENOENT`,
 * and that string is what a pane's error line carries. It is accurate and it is
 * useless: ENOENT means "install herdr, or point pro.herdrPath at it" and EACCES
 * means "chmod +x", and a user who has to know which errno maps to which fix is
 * doing our job for us.
 *
 * Anything unrecognised comes back with an empty reason and is shown verbatim:
 * guessing at a failure nobody has seen is how a real message gets replaced by a
 * confident wrong one.
 */
export function spawnFailure(error: string): SpawnFailure {
  const text = String(error || '')
  const match = /spawn\w*\s+(.+?)\s+(ENOENT|EACCES|EPERM)\b/.exec(text)
  if (!match) return { reason: '', binary: '' }
  return { reason: match[2] === 'ENOENT' ? 'no-binary' : 'not-executable', binary: match[1] }
}
