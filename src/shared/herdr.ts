/**
 * herdr's wire format, normalized once and never touched raw again.
 *
 * herdr is the durable runtime Pro is a control plane over: it owns the PTYs,
 * the layout and the agent-session bookkeeping, and it speaks NDJSON over a
 * local socket. Three facts about that protocol shape this file:
 *
 * 1. Requests are one connection each: `{"id","method","params"}` in, then
 *    `{"id","result":{"type":...}}` or `{"id","error":{code,message}}` out.
 * 2. `events.subscribe` keeps its connection open. After the
 *    `{"type":"subscription_started"}` ack the server writes **bare**
 *    `{"event":...,"data":{...}}` lines with no `id` and no `result` wrapper.
 *    Lifecycle events use snake_case names (`workspace_created`,
 *    `pane_agent_status_changed`) while the three stateful subscriptions keep
 *    their dotted names (`pane.agent_status_changed`, `pane.output_matched`,
 *    `pane.scroll_changed`). Accepting both spellings is the protocol, not
 *    defensiveness.
 * 3. `herdr terminal session control <target>` is a different stream again:
 *    base64 ANSI frames out, input/resize/scroll/release in.
 *
 * Every parser here is total. Unknown fields are ignored, missing fields fall
 * back, and a malformed line becomes `null` instead of an exception: a workbench
 * that dies because herdr added a field is worse than one that shows `unknown`.
 */

/** herdr's own vocabulary for "what is this agent doing right now". */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

const STATUS_VALUES: readonly string[] = ['idle', 'working', 'blocked', 'done', 'unknown']

export function agentStatusOf(value: unknown): AgentStatus {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return STATUS_VALUES.includes(raw) ? (raw as AgentStatus) : 'unknown'
}

/* ------------------------------------------------------------------ *
 * Agent names: herdr's grammar, mirrored so we never send a name it rejects
 * ------------------------------------------------------------------ */

/** herdr counts bytes, and everything `agentName` emits is ASCII, so this is both. */
export const AGENT_NAME_MAX = 32

/**
 * Build a name `agent.start` will accept, from a title a human typed.
 *
 * herdr validates the name it is handed (`thirdparty/herdr/src/app/agents.rs`):
 * it must start with a lowercase ASCII letter, hold only lowercase letters,
 * digits, `-` and `_`, fit in 32 bytes, and not already belong to another live
 * agent. A task title satisfies none of that by default - "论文采集", "Fix
 * Login" and "wire up /api/v2" are all refused with `invalid_agent_name`, and
 * two tasks both titled "fix the flaky test" collide on `agent_name_taken`
 * (`AgentStartError::DuplicateName`, which also lists the panes already holding
 * that name - worth reading, because it names the task you forgot about).
 *
 * Passing the title through anyway is what made "start codex in this pane"
 * silently produce a plain shell: the refusal was caught and dropped, so the
 * bench showed a task with an agent while the pane showed a prompt. Hence this
 * function, which is the only way Pro names an agent.
 *
 * The title becomes a slug so `herdr agent list` stays readable, and the task id
 * is always the tail because it is the only part that is unique. Truncation
 * spends the budget on the slug and never on the id: a name that lost its id
 * would put two tasks back on one `agent.*` target. A CJK title slugifies to
 * nothing, which is fine - the id on its own is already a valid name.
 */
export function agentName(title: string, taskId: string): string {
  const id = uniqueTail(taskId)
  const body = letterFirst(slug(title))
  const room = AGENT_NAME_MAX - id.length - 1
  if (body && room > 0) return `${body.slice(0, room).replace(/-+$/, '')}-${id}`
  return id
}

/**
 * The task id, kept whole. It is the only part of a name that is unique, so it
 * is the part that never loses characters to truncation - but herdr wants a
 * leading lowercase letter, and an id that happens to start with a digit gets
 * one prepended rather than the digit dropped. Trimming the unique part is how
 * two tasks end up addressing the same agent.
 */
function uniqueTail(taskId: string): string {
  const raw = slug(taskId)
  if (!raw) return 'task'
  return (/^[a-z]/.test(raw) ? raw : `t${raw}`).slice(0, AGENT_NAME_MAX)
}

/** Same recipe as `suggestBranch`: fold accents, lowercase, keep alnum runs. */
function slug(text: string): string {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** herdr wants a leading lowercase letter, so a digit-first slug loses its digits. */
function letterFirst(text: string): string {
  return text.replace(/^[^a-z]+/, '')
}

/**
 * How herdr refers to a resumable agent conversation. `id` is what the CLI
 * accepts on its resume flag; `path` is a transcript file we would have to
 * translate ourselves, so recovery treats it as weaker evidence.
 */
export interface AgentSessionRef {
  source: string
  agent: string
  kind: 'id' | 'path'
  value: string
}

export interface WorktreeRef {
  repoKey: string
  repoName: string
  repoRoot: string
  checkoutPath: string
  isLinkedWorktree: boolean
}

export interface WorkspaceInfo {
  workspaceId: string
  number: number
  label: string
  focused: boolean
  paneCount: number
  tabCount: number
  activeTabId: string
  agentStatus: AgentStatus
  tokens: Record<string, string>
  worktree: WorktreeRef | null
}

export interface TabInfo {
  tabId: string
  workspaceId: string
  number: number
  label: string
  focused: boolean
  paneCount: number
  agentStatus: AgentStatus
}

export interface PaneInfo {
  paneId: string
  terminalId: string
  workspaceId: string
  tabId: string
  focused: boolean
  cwd: string
  /** Where the foreground process actually is; agents `cd` into worktrees. */
  foregroundCwd: string
  label: string
  agent: string
  title: string
  terminalTitle: string
  displayAgent: string
  agentStatus: AgentStatus
  stateLabels: Record<string, string>
  tokens: Record<string, string>
  agentSession: AgentSessionRef | null
  revision: number
  /** How far the pane is scrolled back; `0` means "pinned to the bottom". */
  scroll: PaneScroll
}

export interface PaneScroll {
  offsetFromBottom: number
  maxOffsetFromBottom: number
  viewportRows: number
}

/**
 * One live agent instance, as herdr tracks it separately from the pane. This
 * is where the resumable session id and the launch/ready flags live, so
 * recovery reads agents rather than panes when both are present.
 */
export interface AgentInstance {
  paneId: string
  workspaceId: string
  tabId: string
  terminalId: string
  /** herdr's own name for the instance; the `target` of every `agent.*` call. */
  name: string
  agent: string
  displayAgent: string
  agentStatus: AgentStatus
  agentSession: AgentSessionRef | null
  stateLabels: Record<string, string>
  tokens: Record<string, string>
  cwd: string
  foregroundCwd: string
  focused: boolean
  revision: number
  interactiveReady: boolean
  launchPending: boolean
  stateChangeSeq: number
}

/** Cell geometry of one pane inside its tab, from `layouts`. */
export interface LayoutRect {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutPane {
  paneId: string
  rect: LayoutRect
  focused: boolean
}

export interface LayoutSplit {
  id: string
  direction: string
  ratio: number
  rect: LayoutRect
}

/**
 * A tab's geometry. The bench pane grid renders these rects instead of
 * inventing its own layout, so a split made in herdr's TUI and a split made
 * from the bench look the same.
 */
export interface LayoutInfo {
  workspaceId: string
  tabId: string
  area: LayoutRect
  panes: LayoutPane[]
  splits: LayoutSplit[]
  zoomed: boolean
  focusedPaneId: string
}

export interface Snapshot {
  version: string
  protocol: number
  workspaces: WorkspaceInfo[]
  tabs: TabInfo[]
  panes: PaneInfo[]
  agents: AgentInstance[]
  layouts: LayoutInfo[]
  focusedWorkspaceId: string
  focusedTabId: string
  focusedPaneId: string
}

/** One bare line from a subscriber connection. */
export interface HerdrEvent {
  /** snake_case lifecycle name or dotted subscription name, as received. */
  event: string
  data: Record<string, unknown>
}

export type WireMessage =
  | { kind: 'result'; id: string; result: Record<string, unknown> }
  | { kind: 'error'; id: string; code: string; message: string }
  | { kind: 'event'; event: HerdrEvent }
  | { kind: 'unrecognized'; raw: unknown }

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
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

function bool(value: unknown): boolean {
  return value === true
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(obj(value))) {
    const text = str(raw)
    if (text) out[key] = text
  }
  return out
}

function sessionRef(value: unknown): AgentSessionRef | null {
  const raw = obj(value)
  const sessionValue = str(raw.value)
  if (!sessionValue) return null
  return {
    source: str(raw.source),
    agent: str(raw.agent),
    kind: raw.kind === 'path' ? 'path' : 'id',
    value: sessionValue
  }
}

function scrollOf(value: unknown): PaneScroll {
  const raw = obj(value)
  return {
    offsetFromBottom: num(raw.offset_from_bottom),
    maxOffsetFromBottom: num(raw.max_offset_from_bottom),
    viewportRows: num(raw.viewport_rows)
  }
}

function rect(value: unknown): LayoutRect {
  const raw = obj(value)
  return { x: num(raw.x), y: num(raw.y), width: num(raw.width), height: num(raw.height) }
}

export function parseAgentInstance(value: unknown): AgentInstance | null {
  const raw = obj(value)
  const paneId = str(raw.pane_id)
  if (!paneId) return null
  return {
    paneId,
    workspaceId: str(raw.workspace_id),
    tabId: str(raw.tab_id),
    terminalId: str(raw.terminal_id),
    name: str(raw.name),
    agent: str(raw.agent),
    displayAgent: str(raw.display_agent),
    agentStatus: agentStatusOf(raw.agent_status),
    agentSession: sessionRef(raw.agent_session),
    stateLabels: stringMap(raw.state_labels),
    tokens: stringMap(raw.tokens),
    cwd: str(raw.cwd),
    foregroundCwd: str(raw.foreground_cwd),
    focused: bool(raw.focused),
    revision: num(raw.revision),
    interactiveReady: bool(raw.interactive_ready),
    launchPending: bool(raw.launch_pending),
    stateChangeSeq: num(raw.state_change_seq)
  }
}

export function parseLayout(value: unknown): LayoutInfo | null {
  const raw = obj(value)
  const tabId = str(raw.tab_id)
  const panes = arr(raw.panes)
    .map((entry): LayoutPane | null => {
      const pane = obj(entry)
      const paneId = str(pane.pane_id)
      if (!paneId) return null
      return { paneId, rect: rect(pane.rect), focused: bool(pane.focused) }
    })
    .filter(nonNull)
  if (!tabId && panes.length === 0) return null
  const splits = arr(raw.splits)
    .map((entry): LayoutSplit => {
      const split = obj(entry)
      return {
        id: str(split.id),
        direction: str(split.direction),
        ratio: num(split.ratio),
        rect: rect(split.rect)
      }
    })
    .filter((split) => split.id || split.rect.width > 0)
  return {
    workspaceId: str(raw.workspace_id),
    tabId,
    area: rect(raw.area),
    panes,
    splits,
    zoomed: bool(raw.zoomed),
    focusedPaneId: str(raw.focused_pane_id)
  }
}

function worktree(value: unknown): WorktreeRef | null {
  const raw = obj(value)
  const checkoutPath = str(raw.checkout_path)
  if (!checkoutPath) return null
  return {
    repoKey: str(raw.repo_key),
    repoName: str(raw.repo_name),
    repoRoot: str(raw.repo_root),
    checkoutPath,
    isLinkedWorktree: bool(raw.is_linked_worktree)
  }
}

export function parseWorkspace(value: unknown): WorkspaceInfo | null {
  const raw = obj(value)
  const workspaceId = str(raw.workspace_id)
  if (!workspaceId) return null
  return {
    workspaceId,
    number: num(raw.number),
    label: str(raw.label),
    focused: bool(raw.focused),
    paneCount: num(raw.pane_count),
    tabCount: num(raw.tab_count),
    activeTabId: str(raw.active_tab_id),
    agentStatus: agentStatusOf(raw.agent_status),
    tokens: stringMap(raw.tokens),
    worktree: worktree(raw.worktree)
  }
}

export function parseTab(value: unknown): TabInfo | null {
  const raw = obj(value)
  const tabId = str(raw.tab_id)
  if (!tabId) return null
  return {
    tabId,
    workspaceId: str(raw.workspace_id),
    number: num(raw.number),
    label: str(raw.label),
    focused: bool(raw.focused),
    paneCount: num(raw.pane_count),
    agentStatus: agentStatusOf(raw.agent_status)
  }
}

export function parsePane(value: unknown): PaneInfo | null {
  const raw = obj(value)
  const paneId = str(raw.pane_id)
  if (!paneId) return null
  return {
    paneId,
    terminalId: str(raw.terminal_id),
    workspaceId: str(raw.workspace_id),
    tabId: str(raw.tab_id),
    focused: bool(raw.focused),
    cwd: str(raw.cwd),
    foregroundCwd: str(raw.foreground_cwd),
    label: str(raw.label),
    agent: str(raw.agent),
    title: str(raw.title),
    terminalTitle: str(raw.terminal_title),
    displayAgent: str(raw.display_agent),
    agentStatus: agentStatusOf(raw.agent_status),
    stateLabels: stringMap(raw.state_labels),
    tokens: stringMap(raw.tokens),
    agentSession: sessionRef(raw.agent_session),
    revision: num(raw.revision),
    scroll: scrollOf(raw.scroll)
  }
}

/**
 * Accept either a whole `session.snapshot` response (`{type, snapshot}`) or the
 * snapshot object itself, so a recorded fixture and a live reply parse the same
 * way. Returns `null` only when there is nothing that looks like a snapshot.
 */
export function parseSnapshot(value: unknown): Snapshot | null {
  const outer = obj(value)
  const raw = obj(outer.snapshot && typeof outer.snapshot === 'object' ? outer.snapshot : outer)
  const workspaces = arr(raw.workspaces).map(parseWorkspace).filter(nonNull)
  const panes = arr(raw.panes).map(parsePane).filter(nonNull)
  const tabs = arr(raw.tabs).map(parseTab).filter(nonNull)
  const agents = arr(raw.agents).map(parseAgentInstance).filter(nonNull)
  const layouts = arr(raw.layouts).map(parseLayout).filter(nonNull)
  if (workspaces.length === 0 && panes.length === 0 && !str(raw.version)) return null
  return {
    version: str(raw.version),
    protocol: num(raw.protocol),
    workspaces,
    tabs,
    panes,
    agents,
    layouts,
    focusedWorkspaceId: str(raw.focused_workspace_id),
    focusedTabId: str(raw.focused_tab_id),
    focusedPaneId: str(raw.focused_pane_id)
  }
}

function nonNull<T>(value: T | null): value is T {
  return value !== null
}

/**
 * Classify one NDJSON line from an API socket. The subscriber case is the
 * subtle one: an event line has an `event` key and no `id`, and must not be
 * mistaken for a late reply to a request we already timed out.
 */
export function parseWireMessage(value: unknown): WireMessage {
  const raw = obj(value)
  const error = obj(raw.error)
  if (raw.error && typeof raw.error === 'object') {
    return { kind: 'error', id: str(raw.id), code: str(error.code), message: str(error.message) }
  }
  if (raw.result && typeof raw.result === 'object') {
    return { kind: 'result', id: str(raw.id), result: obj(raw.result) }
  }
  const name = str(raw.event)
  if (name) return { kind: 'event', event: { event: name, data: obj(raw.data) } }
  return { kind: 'unrecognized', raw: value }
}

/**
 * The lifecycle subscriptions the bench keeps open. Deliberately the whole
 * lifecycle set: herdr filters server-side, and a client that re-polls because
 * it missed a `pane.closed` is exactly the polling loop this design forbids.
 */
export const LIFECYCLE_SUBSCRIPTIONS: ReadonlyArray<{ type: string }> = [
  { type: 'workspace.created' },
  { type: 'workspace.updated' },
  { type: 'workspace.closed' },
  { type: 'workspace.renamed' },
  { type: 'workspace.moved' },
  { type: 'workspace.reordered' },
  { type: 'workspace.focused' },
  { type: 'worktree.created' },
  { type: 'worktree.opened' },
  { type: 'worktree.removed' },
  { type: 'tab.created' },
  { type: 'tab.closed' },
  { type: 'tab.renamed' },
  { type: 'tab.moved' },
  { type: 'tab.focused' },
  { type: 'pane.created' },
  { type: 'pane.closed' },
  { type: 'pane.updated' },
  { type: 'pane.focused' },
  { type: 'pane.moved' },
  { type: 'pane.exited' },
  { type: 'pane.agent_detected' },
  { type: 'layout.updated' }
]

/** Event names that mean "the shape of the bench changed" -> re-read snapshot. */
export const STRUCTURAL_EVENTS: readonly string[] = [
  'workspace_created',
  'workspace_closed',
  'workspace_renamed',
  'workspace_moved',
  'workspace_reordered',
  'worktree_created',
  'worktree_opened',
  'worktree_removed',
  'tab_created',
  'tab_closed',
  'tab_renamed',
  'tab_moved',
  'pane_created',
  'pane_closed',
  'pane_moved',
  'pane_exited',
  'pane_agent_detected',
  'layout_updated'
]

/** Names that only change a pane's vitals -> patch in place, no snapshot round trip. */
export const STATE_EVENTS: readonly string[] = [
  'pane_agent_status_changed',
  'pane.agent_status_changed',
  'pane_updated',
  'workspace_updated',
  'workspace_metadata_updated'
]

export function isStructuralEvent(name: string): boolean {
  return STRUCTURAL_EVENTS.includes(name)
}

export function isStateEvent(name: string): boolean {
  return STATE_EVENTS.includes(name)
}

/**
 * Agent status transitions do **not** ride the lifecycle stream. herdr emits
 * `pane.agent_status_changed` only to subscriptions that name a `pane_id`, so
 * a bench that wants to know "this agent just went blocked" within a second has
 * to hold one entry per pane and rebuild the set when panes appear or go away.
 * That is why the live session keeps two connections open: a stable lifecycle
 * one and a status one that is re-subscribed on pane-set changes.
 *
 * Scroll position rides the same per-pane connection for the same reason: it is
 * stateful, it is not on the lifecycle stream, and the pane header that says
 * "you are 130 lines back" is only honest if it hears about a scroll somebody
 * else started - in herdr's own TUI, say - rather than about our own requests.
 *
 * A subscription carrying a `pane_id` for an event that takes none is rejected
 * outright (`invalid_request`), so the two sets are never mixed.
 */
export function statusSubscriptions(
  paneIds: readonly string[]
): Array<{ type: string; pane_id: string }> {
  const seen = new Set<string>()
  const out: Array<{ type: string; pane_id: string }> = []
  for (const paneId of paneIds) {
    if (!paneId || seen.has(paneId)) continue
    seen.add(paneId)
    out.push({ type: 'pane.agent_status_changed', pane_id: paneId })
    out.push({ type: SCROLL_EVENT, pane_id: paneId })
  }
  return out
}

export const STATUS_EVENT = 'pane.agent_status_changed'

export function isStatusEvent(name: string): boolean {
  return name === STATUS_EVENT || name === 'pane_agent_status_changed'
}

export const SCROLL_EVENT = 'pane.scroll_changed'

/** Both spellings, per the file header: lifecycle is snake_case, stateful is dotted. */
export function isScrollEvent(name: string): boolean {
  return name === SCROLL_EVENT || name === 'pane_scroll_changed'
}

/* ------------------------------------------------------------------ *
 * Result payloads
 * ------------------------------------------------------------------ */

/** The `type` discriminator every herdr result carries. */
export function resultType(value: unknown): string {
  return str(obj(value).type)
}

export interface PongResult {
  version: string
  protocol: number
  capabilities: string[]
}

export function parsePong(value: unknown): PongResult | null {
  const raw = obj(value)
  if (resultType(raw) !== 'pong') return null
  return {
    version: str(raw.version),
    protocol: num(raw.protocol),
    capabilities: arr(raw.capabilities).map((entry) => str(entry)).filter(Boolean)
  }
}

export interface PaneReadResult {
  paneId: string
  workspaceId: string
  tabId: string
  text: string
  truncated: boolean
  revision: number
  source: string
  format: string
}

/** `pane.read` is how the bench sees a prompt without focusing its pane. */
export function parsePaneRead(value: unknown): PaneReadResult | null {
  const outer = obj(value)
  const raw = obj(outer.read && typeof outer.read === 'object' ? outer.read : outer)
  if (!str(raw.pane_id) && resultType(outer) !== 'pane_read') return null
  return {
    paneId: str(raw.pane_id),
    workspaceId: str(raw.workspace_id),
    tabId: str(raw.tab_id),
    text: str(raw.text),
    truncated: bool(raw.truncated),
    revision: num(raw.revision),
    source: str(raw.source),
    format: str(raw.format)
  }
}

export interface CreatedResult {
  workspace: WorkspaceInfo | null
  tab: TabInfo | null
  pane: PaneInfo | null
  worktree: WorktreeRef | null
}

/**
 * `workspace.create`, `worktree.create` and `tab.create` all answer with the
 * objects they made, which is how a freshly created task learns its own ids
 * without a second snapshot round trip.
 */
export function parseCreated(value: unknown): CreatedResult {
  const raw = obj(value)
  return {
    workspace: parseWorkspace(raw.workspace),
    tab: parseTab(raw.tab),
    pane: parsePane(raw.root_pane ?? raw.pane),
    worktree: worktree(raw.worktree)
  }
}

/**
 * The status event payload. Only the pane's vitals arrive — no session id —
 * so a session reference always comes from a snapshot or from a hook.
 */
export interface StatusChange {
  paneId: string
  workspaceId: string
  agent: string
  agentStatus: AgentStatus
  title: string
  displayAgent: string
  stateLabels: Record<string, string>
}

export function parseStatusChange(data: unknown): StatusChange | null {
  const raw = obj(data)
  const paneId = str(raw.pane_id)
  if (!paneId) return null
  return {
    paneId,
    workspaceId: str(raw.workspace_id),
    agent: str(raw.agent),
    agentStatus: agentStatusOf(raw.agent_status),
    title: str(raw.title),
    displayAgent: str(raw.display_agent),
    stateLabels: stringMap(raw.state_labels)
  }
}

export interface ScrollChange {
  paneId: string
  workspaceId: string
  scroll: PaneScroll
}

/**
 * A `pane.scroll_changed` payload. herdr puts the whole `PaneScrollInfo` on the
 * event, so a pane header never has to ask twice: the number it shows and the
 * number herdr has are the same number.
 */
export function parseScrollChange(data: unknown): ScrollChange | null {
  const raw = obj(data)
  const paneId = str(raw.pane_id)
  if (!paneId) return null
  return { paneId, workspaceId: str(raw.workspace_id), scroll: scrollOf(raw.scroll) }
}

/* ------------------------------------------------------------------ *
 * Terminal bridge (`herdr terminal session control <target>`)
 * ------------------------------------------------------------------ */

export interface TerminalFrame {
  seq: number
  width: number
  height: number
  /** True when the frame repaints the whole screen instead of continuing it. */
  full: boolean
  /** ANSI bytes as received, still base64; decode with `ansiBytes`. */
  bytesB64: string
  /** herdr's label for the payload; only `ansi` exists today. */
  encoding: string
}

export type TerminalMessage =
  | { kind: 'frame'; frame: TerminalFrame }
  | { kind: 'closed'; reason: string }
  | { kind: 'unrecognized'; raw: unknown }

export function parseTerminalMessage(value: unknown): TerminalMessage {
  const raw = obj(value)
  const type = str(raw.type)
  if (type === 'terminal.frame') {
    return {
      kind: 'frame',
      frame: {
        seq: num(raw.seq),
        width: num(raw.width),
        height: num(raw.height),
        full: bool(raw.full),
        bytesB64: str(raw.bytes),
        encoding: str(raw.encoding) || 'ansi'
      }
    }
  }
  if (type === 'terminal.closed') return { kind: 'closed', reason: str(raw.reason) }
  return { kind: 'unrecognized', raw: value }
}

/**
 * Frames are the hot path (one per repaint per visible pane), so this stays a
 * plain decode with no intermediate string. `Buffer` exists in the main process
 * where this runs; `atob` keeps the function usable from a test runner or a
 * renderer that ever needs to inspect a captured frame.
 */
export function ansiBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0)
  const maybeBuffer = (globalThis as { Buffer?: { from(s: string, e: string): Uint8Array } }).Buffer
  if (maybeBuffer) return maybeBuffer.from(b64, 'base64')
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
  return out
}

/** Client -> bridge commands. Only what a terminal view actually needs. */
export type TerminalCommand =
  | { type: 'terminal.input'; text: string }
  | { type: 'terminal.input'; bytes: string }
  | { type: 'terminal.resize'; cols: number; rows: number; cellWidthPx?: number; cellHeightPx?: number }
  | { type: 'terminal.scroll'; direction: 'up' | 'down'; lines: number; source?: 'wheel' | 'page_key' }
  | { type: 'terminal.release' }

/**
 * The ceiling on a relative scroll, and it is herdr's, not ours: `lines` is a
 * `u16` on the control stream, and a larger value is not clamped but dropped -
 * the child prints "invalid value: integer 1000000, expected u16" on stderr and
 * the pane simply does not move. Measured against herdr 0.9.0.
 *
 * "Jump to the bottom" therefore cannot be a very large relative scroll: a pane
 * with more history than this would stop short and look pinned when it is not.
 * That jump goes over the socket as an absolute `pane.scroll` instead.
 */
export const TERMINAL_SCROLL_LINES_MAX = 65535

/**
 * Serialize one bridge command. The bridge is strict about mutually exclusive
 * fields (`terminal.input` accepts text *or* bytes, not both) and rejects
 * non-positive sizes, so the encoder clamps instead of letting a zero-height
 * layout measurement kill the stream.
 */
export function encodeTerminalCommand(command: TerminalCommand): string {
  switch (command.type) {
    case 'terminal.input':
      return 'text' in command
        ? JSON.stringify({ type: 'terminal.input', text: command.text })
        : JSON.stringify({ type: 'terminal.input', bytes: command.bytes })
    case 'terminal.resize':
      return JSON.stringify({
        type: 'terminal.resize',
        cols: Math.max(1, Math.trunc(command.cols)),
        rows: Math.max(1, Math.trunc(command.rows)),
        cell_width_px: Math.max(0, Math.trunc(command.cellWidthPx ?? 0)),
        cell_height_px: Math.max(0, Math.trunc(command.cellHeightPx ?? 0))
      })
    case 'terminal.scroll':
      return JSON.stringify({
        type: 'terminal.scroll',
        direction: command.direction === 'up' ? 'up' : 'down',
        // Clamped, not passed through: over the u16 ceiling herdr drops the
        // command silently, and a wheel gesture that quietly does nothing is
        // indistinguishable from a dead pane.
        lines: Math.min(TERMINAL_SCROLL_LINES_MAX, Math.max(1, Math.trunc(command.lines))),
        source: command.source === 'page_key' ? 'page_key' : 'wheel'
      })
    case 'terminal.release':
      return JSON.stringify({ type: 'terminal.release' })
  }
}
