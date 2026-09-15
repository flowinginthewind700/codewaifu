/**
 * The live herdr connection: one snapshot cache kept honest by events.
 *
 * Acceptance criterion 1 says the tree must be correct in under a second and
 * update by push, with no polling loop in the log. That requires three things
 * this file owns:
 *
 * 1. **Two subscriptions, not one.** herdr only emits
 *    `pane.agent_status_changed` to a subscription that names a `pane_id`, and
 *    it rejects a `pane_id` on an event that takes none. So the lifecycle set
 *    rides one stable connection and the per-pane status set rides another that
 *    is rebuilt (debounced) whenever the pane set changes.
 * 2. **Patch in place, re-read on structure.** A status flip or a pane update
 *    patches the cache; anything that changes the *shape* of the bench
 *    schedules a debounced snapshot re-read. Patching keeps the UI instant,
 *    re-reading keeps the cache from drifting when we guess a payload wrong.
 * 3. **Reconnect with capped backoff.** herdr may not be running when we boot.
 *    Retrying is also how the bench notices herdr starting later, so "offline"
 *    is a state we recover from without a restart.
 *
 * Merging matters more than it looks: `pane_updated` carries no `agent` or
 * `agent_session` key, so replacing the cached pane wholesale would silently
 * un-detect the agent and lose the resume id. Fields absent from the payload
 * are kept from the cache.
 */
import {
  LIFECYCLE_SUBSCRIPTIONS,
  isStateEvent,
  isStatusEvent,
  isStructuralEvent,
  parseLayout,
  parsePane,
  parseStatusChange,
  parseTab,
  parseWorkspace,
  statusSubscriptions,
  type HerdrEvent,
  type LayoutInfo,
  type PaneInfo,
  type Snapshot,
  type StatusChange,
  type TabInfo,
  type WorkspaceInfo
} from '../../../shared/herdr'
import { HerdrClient } from './client'
import { HerdrError, subscribe, type ConnectFn, type Subscription } from './socket'

export type SessionPhase = 'idle' | 'connecting' | 'live' | 'error' | 'stopped'

export interface SessionStatus {
  phase: SessionPhase
  /** True while the lifecycle subscription is acknowledged by herdr. */
  online: boolean
  socketPath: string
  version: string
  protocol: number
  /** '' while healthy; otherwise why not (connect refused, timeout, ...). */
  error: string
  events: number
  lastEventAt: number
  attempts: number
  /** Backoff currently armed, so the UI can say "retrying in 2s". */
  reconnectInMs: number
  /** Panes we hold a status subscription for. */
  subscribedPanes: number
}

export type SessionChange =
  | { type: 'snapshot'; snapshot: Snapshot | null }
  | { type: 'status'; status: SessionStatus }
  | { type: 'event'; event: HerdrEvent }

export interface SessionTimer {
  cancel: () => void
}

/** Injectable so tests can drive debounce and backoff without real time. */
export interface SessionTimers {
  after(cb: () => void, ms: number): SessionTimer
  now(): number
}

export const realTimers: SessionTimers = {
  after(cb, ms) {
    const handle = setTimeout(cb, ms)
    return { cancel: () => clearTimeout(handle) }
  },
  now: () => Date.now()
}

export interface SessionOptions {
  socketPath: string
  client?: HerdrClient
  connect?: ConnectFn
  timeoutMs?: number
  /** Coalescing window for "the shape changed, re-read the snapshot". */
  refreshDebounceMs?: number
  /** Coalescing window for rebuilding the per-pane status subscription. */
  statusDebounceMs?: number
  reconnectMs?: number
  maxReconnectMs?: number
  timers?: SessionTimers
}

/** Focus-only events: patched exactly, so they must not cost a snapshot read. */
const FOCUS_EVENTS: readonly string[] = ['pane_focused', 'tab_focused', 'workspace_focused']

/** Raw payload key -> parsed field, for merge-on-partial-update. */
const PANE_FIELDS: ReadonlyArray<readonly [string, keyof PaneInfo]> = [
  ['terminal_id', 'terminalId'],
  ['workspace_id', 'workspaceId'],
  ['tab_id', 'tabId'],
  ['focused', 'focused'],
  ['cwd', 'cwd'],
  ['foreground_cwd', 'foregroundCwd'],
  ['label', 'label'],
  ['agent', 'agent'],
  ['title', 'title'],
  ['terminal_title', 'terminalTitle'],
  ['display_agent', 'displayAgent'],
  ['agent_status', 'agentStatus'],
  ['state_labels', 'stateLabels'],
  ['tokens', 'tokens'],
  ['agent_session', 'agentSession'],
  ['revision', 'revision'],
  ['scroll', 'scroll']
]

const WORKSPACE_FIELDS: ReadonlyArray<readonly [string, keyof WorkspaceInfo]> = [
  ['number', 'number'],
  ['label', 'label'],
  ['focused', 'focused'],
  ['pane_count', 'paneCount'],
  ['tab_count', 'tabCount'],
  ['active_tab_id', 'activeTabId'],
  ['agent_status', 'agentStatus'],
  ['tokens', 'tokens'],
  ['worktree', 'worktree']
]

const TAB_FIELDS: ReadonlyArray<readonly [string, keyof TabInfo]> = [
  ['workspace_id', 'workspaceId'],
  ['number', 'number'],
  ['label', 'label'],
  ['focused', 'focused'],
  ['pane_count', 'paneCount'],
  ['agent_status', 'agentStatus']
]

function rawObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Overlay a parsed payload on the cached object, keeping absent fields. */
function mergeFields<T extends object>(
  parsed: T,
  existing: T,
  raw: Record<string, unknown>,
  pairs: ReadonlyArray<readonly [string, keyof T]>
): T {
  const out: Record<string, unknown> = { ...(parsed as Record<string, unknown>) }
  for (const [rawKey, field] of pairs) {
    if (rawKey in raw) continue
    out[field as string] = existing[field]
  }
  return out as T
}

export class HerdrSession {
  private readonly socketPath: string
  private readonly herdr: HerdrClient
  private readonly connect: ConnectFn | undefined
  private readonly timeoutMs: number | undefined
  private readonly refreshDebounceMs: number
  private readonly statusDebounceMs: number
  private readonly reconnectMs: number
  private readonly maxReconnectMs: number
  private readonly timers: SessionTimers

  private cache: Snapshot | null = null
  private lifecycle: Subscription | null = null
  private statusSub: Subscription | null = null
  private statusKey = ''
  private refreshTimer: SessionTimer | null = null
  private statusTimer: SessionTimer | null = null
  private reconnectTimer: SessionTimer | null = null
  private refreshSeq = 0
  private stopped = true
  private backoff: number
  private attemptCount = 0
  private eventCount = 0
  private lastEventAt = 0
  private errorText = ''
  private phaseValue: SessionPhase = 'idle'
  private armedReconnectMs = 0
  private hasBeenReady = false
  private readonly listeners = new Set<(change: SessionChange) => void>()

  constructor(options: SessionOptions) {
    this.socketPath = options.socketPath
    this.herdr =
      options.client ??
      new HerdrClient({ socketPath: options.socketPath, timeoutMs: options.timeoutMs, connect: options.connect })
    this.connect = options.connect
    this.timeoutMs = options.timeoutMs
    this.refreshDebounceMs = options.refreshDebounceMs ?? 120
    this.statusDebounceMs = options.statusDebounceMs ?? 250
    this.reconnectMs = options.reconnectMs ?? 400
    this.maxReconnectMs = options.maxReconnectMs ?? 5000
    this.backoff = this.reconnectMs
    this.timers = options.timers ?? realTimers
  }

  get client(): HerdrClient {
    return this.herdr
  }

  get snapshot(): Snapshot | null {
    return this.cache
  }

  status(): SessionStatus {
    return {
      phase: this.phaseValue,
      online: this.phaseValue === 'live',
      socketPath: this.socketPath,
      version: this.cache?.version ?? '',
      protocol: this.cache?.protocol ?? 0,
      error: this.errorText,
      events: this.eventCount,
      lastEventAt: this.lastEventAt,
      attempts: this.attemptCount,
      reconnectInMs: this.armedReconnectMs,
      subscribedPanes: this.statusKey ? this.statusKey.split('|').filter(Boolean).length : 0
    }
  }

  onChange(listener: (change: SessionChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Open the stream and take the first reading. Safe to call once. */
  async start(): Promise<Snapshot | null> {
    if (!this.stopped) return this.cache
    this.stopped = false
    this.openLifecycle()
    return this.refresh()
  }

  stop(): void {
    this.stopped = true
    this.refreshTimer?.cancel()
    this.statusTimer?.cancel()
    this.reconnectTimer?.cancel()
    this.refreshTimer = null
    this.statusTimer = null
    this.reconnectTimer = null
    this.lifecycle?.close()
    this.statusSub?.close()
    this.lifecycle = null
    this.statusSub = null
    this.statusKey = ''
    this.armedReconnectMs = 0
    this.setPhase('stopped')
  }

  /** Re-read the snapshot. Out-of-order replies are dropped by `refreshSeq`. */
  async refresh(): Promise<Snapshot | null> {
    const seq = this.refreshSeq + 1
    this.refreshSeq = seq
    try {
      const snapshot = await this.herdr.snapshot()
      if (seq !== this.refreshSeq || this.stopped) return snapshot
      this.setCache(snapshot)
      if (snapshot) this.errorText = ''
      return snapshot
    } catch (error) {
      if (seq !== this.refreshSeq || this.stopped) return null
      this.noteFailure(error, true)
      return null
    }
  }

  /* ---------------------------------------------------------------- *
   * Connections
   * ---------------------------------------------------------------- */

  private openLifecycle(): void {
    this.lifecycle?.close()
    this.lifecycle = null
    this.setPhase('connecting')
    this.lifecycle = subscribe(
      this.socketPath,
      LIFECYCLE_SUBSCRIPTIONS,
      {
        onEvent: (event) => this.onEvent(event),
        onReady: () => this.onReady(),
        onError: (error) => this.noteFailure(error, true),
        onClose: (reason) => this.noteFailure(new HerdrError('closed', 'events.subscribe', reason), true)
      },
      { connect: this.connect, timeoutMs: this.timeoutMs }
    )
  }

  private onReady(): void {
    const first = !this.hasBeenReady
    this.hasBeenReady = true
    this.attemptCount = 0
    this.backoff = this.reconnectMs
    this.armedReconnectMs = 0
    this.errorText = ''
    this.setPhase('live')
    // On a reconnect we may have missed events while the socket was down, so
    // the cache is re-read. The very first ready is covered by start().
    if (!first) void this.refresh()
  }

  private noteFailure(error: unknown, fatal: boolean): void {
    if (this.stopped) return
    const message = error instanceof Error ? error.message : String(error)
    this.errorText = message || 'herdr unreachable'
    if (!fatal) {
      // A status connection dropping is not an outage: the lifecycle stream is
      // still up and will re-arm the status set on its next event.
      this.statusSub = null
      this.statusKey = ''
      this.emitStatus()
      return
    }
    this.lifecycle?.close()
    this.lifecycle = null
    this.statusSub?.close()
    this.statusSub = null
    this.statusKey = ''
    this.hasBeenReady = false
    if (this.reconnectTimer) return
    this.setPhase('error')
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    const delay = this.backoff
    this.armedReconnectMs = delay
    this.attemptCount += 1
    this.backoff = Math.min(this.maxReconnectMs, Math.max(this.reconnectMs, this.backoff * 2))
    this.emitStatus()
    this.reconnectTimer = this.timers.after(() => {
      this.reconnectTimer = null
      this.armedReconnectMs = 0
      if (this.stopped) return
      this.openLifecycle()
    }, delay)
  }

  /** Rebuild the per-pane status subscription when the pane set changed. */
  private ensureStatusSubscriptions(): void {
    if (this.stopped || this.phaseValue !== 'live') return
    const ids = (this.cache?.panes ?? []).map((pane) => pane.paneId)
    const key = ids.slice().sort().join('|')
    if (key === this.statusKey && this.statusSub?.live()) return
    this.statusKey = key
    this.statusSub?.close()
    this.statusSub = null
    if (!ids.length) return
    this.statusSub = subscribe(
      this.socketPath,
      statusSubscriptions(ids),
      {
        onEvent: (event) => this.onEvent(event),
        onError: (error) => this.noteFailure(error, false),
        onClose: () => {
          this.statusSub = null
          this.statusKey = ''
        }
      },
      { connect: this.connect, timeoutMs: this.timeoutMs }
    )
    this.emitStatus()
  }

  private scheduleStatusSubscriptions(): void {
    this.statusTimer?.cancel()
    this.statusTimer = this.timers.after(() => {
      this.statusTimer = null
      this.ensureStatusSubscriptions()
    }, this.statusDebounceMs)
  }

  private scheduleRefresh(): void {
    this.refreshTimer?.cancel()
    this.refreshTimer = this.timers.after(() => {
      this.refreshTimer = null
      void this.refresh()
    }, this.refreshDebounceMs)
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  private onEvent(event: HerdrEvent): void {
    if (this.stopped) return
    this.eventCount += 1
    this.lastEventAt = this.timers.now()
    const name = event.event
    let changed = false
    if (isStatusEvent(name)) {
      const change = parseStatusChange(event.data)
      if (change) changed = this.applyStatus(change)
    } else {
      changed = this.patchCache(event)
    }
    if (changed) this.emitSnapshot()
    // Focus events are patched exactly, so re-reading would only cost a round
    // trip; everything structural re-reads because we do not model it fully.
    if (isStructuralEvent(name) && !FOCUS_EVENTS.includes(name)) this.scheduleRefresh()
    if (isStateEvent(name) || isStructuralEvent(name)) this.scheduleStatusSubscriptions()
    this.emit({ type: 'event', event })
  }

  /** A status flip touches only vitals, and never carries a session ref. */
  private applyStatus(change: StatusChange): boolean {
    const cache = this.cache
    if (!cache) return false
    const index = cache.panes.findIndex((pane) => pane.paneId === change.paneId)
    if (index < 0) return false
    const pane = cache.panes[index]
    if (
      pane.agentStatus === change.agentStatus &&
      (!change.agent || pane.agent === change.agent) &&
      (!change.title || pane.title === change.title)
    ) {
      return false
    }
    const next: PaneInfo = {
      ...pane,
      agentStatus: change.agentStatus,
      agent: change.agent || pane.agent,
      displayAgent: change.displayAgent || pane.displayAgent,
      title: change.title || pane.title,
      workspaceId: change.workspaceId || pane.workspaceId,
      stateLabels: Object.keys(change.stateLabels).length ? change.stateLabels : pane.stateLabels
    }
    const panes = cache.panes.slice()
    panes[index] = next
    this.cache = {
      ...cache,
      panes,
      agents: cache.agents.map((agent) =>
        agent.paneId === change.paneId
          ? {
              ...agent,
              agentStatus: change.agentStatus,
              agent: change.agent || agent.agent,
              displayAgent: change.displayAgent || agent.displayAgent
            }
          : agent
      )
    }
    return true
  }

  /**
   * Patch what we can model exactly. Returns true when the cache changed.
   * Anything not listed falls through to the debounced snapshot re-read.
   */
  private patchCache(event: HerdrEvent): boolean {
    const cache = this.cache
    if (!cache) return false
    const data = rawObject(event.data)
    const name = String(data.type || event.event || '')
    switch (name) {
      case 'pane_created':
      case 'pane_updated':
        return this.upsertPane(rawObject(data.pane))
      case 'pane_closed':
      case 'pane_exited':
        return this.removePane(String(data.pane_id || ''))
      case 'pane_focused':
        return this.setFocus(String(data.pane_id || ''))
      case 'workspace_created':
      case 'workspace_updated':
      case 'workspace_metadata_updated':
        return this.upsertWorkspace(rawObject(data.workspace))
      case 'workspace_closed':
        return this.removeWorkspace(String(data.workspace_id || ''))
      case 'tab_created':
      case 'tab_updated':
        return this.upsertTab(rawObject(data.tab))
      case 'tab_closed':
        return this.removeTab(String(data.tab_id || ''))
      case 'layout_updated':
        return this.upsertLayout(rawObject(data.layout))
      default:
        return false
    }
  }

  private commit(patch: Partial<Snapshot>): void {
    this.cache = this.cache ? { ...this.cache, ...patch } : null
  }

  private upsertPane(raw: Record<string, unknown>): boolean {
    const cache = this.cache
    if (!cache) return false
    const parsed = parsePane(raw)
    if (!parsed) return false
    const index = cache.panes.findIndex((pane) => pane.paneId === parsed.paneId)
    const panes = cache.panes.slice()
    if (index < 0) panes.push(parsed)
    else panes[index] = mergeFields(parsed, panes[index], raw, PANE_FIELDS)
    this.commit({ panes })
    return true
  }

  private removePane(paneId: string): boolean {
    const cache = this.cache
    if (!paneId || !cache) return false
    const panes = cache.panes.filter((pane) => pane.paneId !== paneId)
    if (panes.length === cache.panes.length) return false
    this.commit({
      panes,
      agents: cache.agents.filter((agent) => agent.paneId !== paneId),
      layouts: cache.layouts.map((layout) => ({
        ...layout,
        panes: layout.panes.filter((pane) => pane.paneId !== paneId)
      }))
    })
    return true
  }

  private setFocus(paneId: string): boolean {
    const cache = this.cache
    if (!paneId || !cache) return false
    const target = cache.panes.find((pane) => pane.paneId === paneId)
    if (!target || target.focused) return false
    this.commit({
      focusedPaneId: paneId,
      focusedTabId: target.tabId || cache.focusedTabId,
      focusedWorkspaceId: target.workspaceId || cache.focusedWorkspaceId,
      // Focus is per tab in herdr: the panes sharing that tab lose it.
      panes: cache.panes.map((pane) => {
        if (pane.paneId === paneId) return pane.focused ? pane : { ...pane, focused: true }
        if (pane.tabId === target.tabId) return pane.focused ? { ...pane, focused: false } : pane
        return pane
      }),
      layouts: cache.layouts.map((layout) =>
        layout.tabId === target.tabId ? { ...layout, focusedPaneId: paneId } : layout
      )
    })
    return true
  }

  private upsertWorkspace(raw: Record<string, unknown>): boolean {
    const cache = this.cache
    if (!cache) return false
    const parsed = parseWorkspace(raw)
    if (!parsed) return false
    const index = cache.workspaces.findIndex((entry) => entry.workspaceId === parsed.workspaceId)
    const workspaces = cache.workspaces.slice()
    if (index < 0) workspaces.push(parsed)
    else workspaces[index] = mergeFields(parsed, workspaces[index], raw, WORKSPACE_FIELDS)
    this.commit({ workspaces })
    return true
  }

  private removeWorkspace(workspaceId: string): boolean {
    const cache = this.cache
    if (!workspaceId || !cache) return false
    const workspaces = cache.workspaces.filter((entry) => entry.workspaceId !== workspaceId)
    if (workspaces.length === cache.workspaces.length) return false
    this.commit({
      workspaces,
      tabs: cache.tabs.filter((tab) => tab.workspaceId !== workspaceId),
      panes: cache.panes.filter((pane) => pane.workspaceId !== workspaceId),
      agents: cache.agents.filter((agent) => agent.workspaceId !== workspaceId),
      layouts: cache.layouts.filter((layout) => layout.workspaceId !== workspaceId)
    })
    return true
  }

  private upsertTab(raw: Record<string, unknown>): boolean {
    const cache = this.cache
    if (!cache) return false
    const parsed = parseTab(raw)
    if (!parsed) return false
    const index = cache.tabs.findIndex((tab) => tab.tabId === parsed.tabId)
    const tabs = cache.tabs.slice()
    if (index < 0) tabs.push(parsed)
    else tabs[index] = mergeFields(parsed, tabs[index], raw, TAB_FIELDS)
    this.commit({ tabs })
    return true
  }

  private removeTab(tabId: string): boolean {
    const cache = this.cache
    if (!tabId || !cache) return false
    const tabs = cache.tabs.filter((tab) => tab.tabId !== tabId)
    const panes = cache.panes.filter((pane) => pane.tabId !== tabId)
    if (tabs.length === cache.tabs.length && panes.length === cache.panes.length) return false
    this.commit({
      tabs,
      panes,
      agents: cache.agents.filter((agent) => agent.tabId !== tabId),
      layouts: cache.layouts.filter((layout) => layout.tabId !== tabId)
    })
    return true
  }

  private upsertLayout(raw: Record<string, unknown>): boolean {
    const cache = this.cache
    if (!cache) return false
    const parsed: LayoutInfo | null = parseLayout(raw)
    if (!parsed) return false
    const layouts = cache.layouts.slice()
    const index = layouts.findIndex(
      (layout) => layout.workspaceId === parsed.workspaceId && layout.tabId === parsed.tabId
    )
    if (index < 0) layouts.push(parsed)
    else layouts[index] = parsed
    this.commit({ layouts })
    return true
  }

  private setCache(snapshot: Snapshot | null): void {
    this.cache = snapshot
    this.emitSnapshot()
    this.scheduleStatusSubscriptions()
  }

  /* ---------------------------------------------------------------- *
   * Emission
   * ---------------------------------------------------------------- */

  private setPhase(phase: SessionPhase): void {
    if (this.phaseValue === phase) return
    this.phaseValue = phase
    this.emitStatus()
  }

  private emitStatus(): void {
    this.emit({ type: 'status', status: this.status() })
  }

  private emitSnapshot(): void {
    this.emit({ type: 'snapshot', snapshot: this.cache })
  }

  private emit(change: SessionChange): void {
    for (const listener of this.listeners) listener(change)
  }
}
