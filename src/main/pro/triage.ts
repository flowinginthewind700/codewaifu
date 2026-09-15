/**
 * The attention tracker (F3): the one place that decides what needs the human.
 *
 * Two signal sources, in a strict hierarchy:
 *
 *   hooks  - the agent itself said "I need permission" / "I stopped". Ground
 *            truth, and it arrives with the tool name and the session id.
 *   herdr  - a pane went `blocked`. The fallback for agents with no hooks
 *            installed, and for the case where the hook POST failed.
 *
 * A hook item is never downgraded by a status item, and a status item is never
 * created while a hook item for the same task is live. What both share is the
 * clearing rule: observed progress resolves a need. The moment a pane goes back
 * to `working`, whatever it was waiting for is no longer waiting, and an item
 * that stays queued after the agent moved on is exactly the failure that makes
 * humans stop trusting a queue.
 */
import type { HookEvent } from '../../shared/protocol'
import type { AgentStatus, PaneInfo, Snapshot, StatusChange } from '../../shared/herdr'
import {
  attentionId,
  DEFAULT_SNOOZE_MINUTES,
  type AttentionItem,
  type AttentionKind,
  type AttentionSource
} from '../../shared/pro'

/** What a hook or status event tells us about where the work lives. */
export interface TaskHint {
  sessionId: string
  transcriptPath: string
  cwd: string
  agent: string
  paneId: string
  workspaceId: string
}

/** A task as the attention queue needs to see it. */
export interface TaskRef {
  taskId: string
  title: string
  groupLabel: string
  agentKind: string
  paneId: string
  paneIds: string[]
  workspaceId: string
}

export type TriageEvent =
  | { type: 'raised'; item: AttentionItem }
  | { type: 'updated'; item: AttentionItem }
  | { type: 'resolved'; item: AttentionItem; reason: string }
  | { type: 'snoozed'; item: AttentionItem; until: number }
  | { type: 'dropped'; itemId: string; reason: string }

/** What a pane read can add to an item that herdr raised blind. */
export interface PaneReadHint {
  title?: string
  detail?: string
  toolName?: string
  command?: string
  /** A read can reclassify: a `blocked` pane may be asking a question. */
  kind?: AttentionKind
}

export interface TriageDeps {
  now?: () => number
  /** Map a hint onto the registry. ProService provides it; it owns both. */
  resolveTask?: (hint: TaskHint) => TaskRef | null
  /** How long a `working` pane with no new output counts as stalled. */
  stalledAfterMs?: number
}

/** What a raise carries. herdr knows the title; only a hook knows the tool. */
export interface RaisePayload {
  title: string
  detail: string
  toolName?: string
  command?: string
}

const DEFAULT_STALLED_MS = 300000
/** A resolved row lingers so the UI can show it drain, then goes. */
const RESOLVED_TTL = 20000
/**
 * How long a dealt-with need stays dealt with. herdr re-emits `blocked` on
 * every snapshot and a hook can re-fire, so without this window the queue
 * resurrects rows the human already dismissed. Deliberately longer than
 * RESOLVED_TTL: the row disappears from the UI long before the memory does.
 */
const RESOLVED_SUPPRESS_MS = 120000
/** An unfiled row that never found a task is noise after a day. */
const UNFILED_TTL = 24 * 3600 * 1000
/** Pane reads are cheap but not free; three misses is enough to stop trying. */
const MAX_READ_ATTEMPTS = 3
const READ_RETRY_MS = 4000
/** Stable on purpose: the UI derives elapsed time from `since`. */
const STALLED_DETAIL = 'working, no new output'
/** How much of a pane read is worth carrying into the queue. */
const READ_TAIL_LINES = 14
const READ_DETAIL_MAX = 1200

interface Row {
  item: AttentionItem
  /** What the item said last time; a change means a genuinely new decision. */
  fingerprint: string
  hint: TaskHint
  readAttempts: number
  lastReadAt: number
  reading: boolean
  resolvedAt: number
}

/** Source precedence: a hook beats herdr beats a screen scrape. */
const SOURCE_RANK: Record<AttentionSource, number> = { hook: 0, herdr: 1, screen: 2 }

const PERMISSION_TEXT = /permission|approve|allow this|do you want|y\/n|press 1|needs your/i
const FAILURE_TEXT = /fail|error|panic|crash|aborted/i

export function emptyHint(): TaskHint {
  return { sessionId: '', transcriptPath: '', cwd: '', agent: '', paneId: '', workspaceId: '' }
}

export class Triage {
  private readonly now: () => number
  private readonly resolveTask: (hint: TaskHint) => TaskRef | null
  private stalledAfterMs: number

  private readonly rows = new Map<string, Row>()
  private readonly blockedSince = new Map<string, number>()
  private readonly revisions = new Map<string, { revision: number; sinceAt: number }>()
  private readonly listeners = new Set<(event: TriageEvent) => void>()
  /** Needs the human already dealt with, by id: do not resurrect these. */
  private readonly suppressed = new Map<string, { fingerprint: string; until: number }>()

  constructor(deps: TriageDeps = {}) {
    this.now = deps.now ?? (() => Date.now())
    this.resolveTask = deps.resolveTask ?? (() => null)
    this.stalledAfterMs = Math.max(5000, deps.stalledAfterMs ?? DEFAULT_STALLED_MS)
  }

  /**
   * Config can change at runtime (the bench exposes a stalled threshold), and
   * triage outlives a config write. Clamped the same way as the constructor so
   * a stray 0 cannot turn every idle pane into a stall.
   */
  setStalledAfterMs(ms: number): void {
    this.stalledAfterMs = Math.max(5000, ms)
  }

  onEvent(listener: (event: TriageEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Raw rows for `buildBench`; ranking and filtering happen there, once. */
  items(): AttentionItem[] {
    return [...this.rows.values()].map((row) => ({ ...row.item }))
  }

  get(id: string): AttentionItem | null {
    const row = this.rows.get(id)
    return row ? { ...row.item } : null
  }

  /** First epoch ms each task was seen blocked; tasks that are not blocked are absent. */
  blockedSinceMap(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [taskId, at] of this.blockedSince) {
      if (taskId && at > 0) out[taskId] = at
    }
    return out
  }

  /* ---------------------------------------------------------------- *
   * Hooks: ground truth
   * ---------------------------------------------------------------- */

  /**
   * Feed one hook event. Returns the item only when it is a genuinely new need,
   * which is what the companion bridge keys "speak this" off: a re-fired hook
   * for the same prompt must not make her say it twice.
   */
  onHook(event: HookEvent): AttentionItem | null {
    if (!event) return null
    const at = event.at > 0 ? event.at : this.now()
    const hint: TaskHint = {
      ...emptyHint(),
      sessionId: event.sessionId,
      transcriptPath: event.transcriptPath,
      cwd: event.cwd,
      agent: event.agent === 'unknown' ? '' : event.agent
    }

    switch (event.kind) {
      case 'permission':
        return this.raise('permission', 'hook', hint, hookPayload(event), at)
      case 'notification': {
        // Claude Code and Codex both use Notification for "I am waiting": the
        // text is the only thing that says whether it wants a yes or an answer.
        const text = `${event.detail} ${event.sourceText}`
        const kind: AttentionKind = PERMISSION_TEXT.test(text) ? 'permission' : 'question'
        return this.raise(kind, 'hook', hint, hookPayload(event), at)
      }
      case 'stop': {
        // A failure-shaped stop means the agent died mid-task: that needs a
        // re-prompt, not a review.
        if (FAILURE_TEXT.test(event.rawEvent) || FAILURE_TEXT.test(event.detail)) {
          return this.raise('failed', 'hook', hint, hookPayload(event), at)
        }
        const raised = this.raise('review', 'hook', hint, hookPayload(event, 'Finished, awaiting review'), at)
        this.clearKinds(hint, ['permission', 'question', 'stalled'], 'agent stopped')
        return raised
      }
      case 'interrupt':
        this.clearKinds(hint, ['permission', 'question', 'stalled', 'failed'], 'interrupted')
        return null
      case 'session_start':
        // A fresh or resumed conversation invalidates whatever we thought it was
        // waiting for. The session id itself belongs in the ledger, not here.
        this.clearKinds(hint, ['permission', 'question', 'stalled', 'failed'], 'session started')
        return null
      case 'prompt':
      case 'tool':
      case 'compact':
      case 'subagent':
        // Pure activity: a human typing or a tool running means nothing is
        // blocked, and a stall timer must not survive it.
        this.clearKinds(hint, ['stalled'], 'activity')
        return null
      default:
        return null
    }
  }

  /* ---------------------------------------------------------------- *
   * herdr status: the fallback
   * ---------------------------------------------------------------- */

  /** Feed one `pane.agent_status_changed`. Returns a new need, when there is one. */
  onStatusChange(change: StatusChange): AttentionItem | null {
    if (!change || !change.paneId) return null
    const hint: TaskHint = {
      ...emptyHint(),
      paneId: change.paneId,
      workspaceId: change.workspaceId,
      agent: change.displayAgent || change.agent
    }
    return this.applyStatus(hint, change.agentStatus, change.title, this.now())
  }

  /**
   * Reconcile every pane in a snapshot. Called on each refresh, which is also
   * how we notice a pane that closed without an event (herdr restart).
   */
  onSnapshot(snapshot: Snapshot | null): void {
    const at = this.now()
    const live = new Set<string>()
    for (const pane of snapshot?.panes ?? []) {
      live.add(pane.paneId)
      this.applyStatus(hintOfPane(pane), pane.agentStatus, pane.title, at)
    }
    this.detectStalls(snapshot, at)
    // A pane that is gone cannot be waiting for anything.
    for (const row of [...this.rows.values()]) {
      if (row.item.paneId && !live.has(row.item.paneId) && row.item.source !== 'hook') {
        this.drop(row.item.id, 'pane closed')
      }
    }
    this.prune(at)
  }

  private applyStatus(
    hint: TaskHint,
    status: AgentStatus,
    title: string,
    at: number
  ): AttentionItem | null {
    if (status === 'blocked') {
      // Waiting on a human is not a stall; the pane is exactly where it should be.
      this.clearKinds(hint, ['stalled'], 'agent is blocked')
      // Never duplicate a hook item: the hook knows more than the pixel state.
      if (this.blockedItem(hint, 'hook')) return null
      return this.raise('permission', 'herdr', hint, { title: title || 'Waiting on you', detail: '' }, at)
    }
    if (status === 'done') {
      this.clearKinds(hint, ['permission', 'question', 'stalled'], 'agent finished')
      if (this.blockedItem(hint, 'hook')) return null
      return this.raise('review', 'herdr', hint, { title: 'Finished, awaiting review', detail: '' }, at)
    }
    if (status === 'working' || status === 'idle') {
      // Not `stalled`: a stalled pane is by definition still `working`. Only new
      // output ends a stall, which detectStalls sees as a revision change.
      this.clearKinds(hint, ['permission', 'question'], `agent is ${status}`)
    }
    return null
  }

  /**
   * A `working` pane whose revision has not moved for `stalledAfterMs` is either
   * running something very long or hung. From outside they look identical, which
   * is why `stalled` ranks last and offers no destructive verb.
   */
  private detectStalls(snapshot: Snapshot | null, at: number): void {
    if (!snapshot) return
    const seen = new Set<string>()
    for (const pane of snapshot.panes) {
      seen.add(pane.paneId)
      const hint = hintOfPane(pane)
      const prior = this.revisions.get(pane.paneId)
      if (!prior || prior.revision !== pane.revision) {
        // New output is the only thing that ends a stall.
        if (prior) this.clearKinds(hint, ['stalled'], 'new output')
        this.revisions.set(pane.paneId, { revision: pane.revision, sinceAt: at })
        continue
      }
      if (pane.agentStatus !== 'working') continue
      if (at - prior.sinceAt < this.stalledAfterMs) continue
      if (this.blockedItem(hint, 'hook')) continue
      // Already queued. Re-raising would reset its snooze and, worse, re-fire
      // `raised`, which is what makes the companion say the same thing twice.
      if (this.liveKind(hint, 'stalled')) continue
      this.raise(
        'stalled',
        'herdr',
        hint,
        { title: 'No output for a while', detail: STALLED_DETAIL },
        prior.sinceAt
      )
    }
    for (const paneId of [...this.revisions.keys()]) {
      if (!seen.has(paneId)) this.revisions.delete(paneId)
    }
  }

  /* ---------------------------------------------------------------- *
   * Raising, updating, clearing
   * ---------------------------------------------------------------- */

  private raise(
    kind: AttentionKind,
    source: AttentionSource,
    hint: TaskHint,
    payload: RaisePayload,
    at: number
  ): AttentionItem | null {
    const ref = this.resolveTask(hint)
    const taskId = ref?.taskId ?? ''
    const paneId = ref?.paneId || hint.paneId || ''
    const origin = hint.sessionId || (paneId ? `pane:${paneId}` : hint.cwd || 'unknown')
    const id = attentionId(taskId, kind, origin)
    const fingerprint = fingerprintOf(kind, payload)
    const existing = this.rows.get(id)

    if (this.suppresses(id, fingerprint, at)) return null

    const item: AttentionItem = {
      id,
      kind,
      // A hook never loses to a status probe for the same slot.
      source:
        existing && SOURCE_RANK[existing.item.source] < SOURCE_RANK[source] ? existing.item.source : source,
      taskId,
      paneId,
      workspaceId: ref?.workspaceId || hint.workspaceId || '',
      agentKind: (ref?.agentKind || hint.agent || '').toLowerCase(),
      taskTitle: ref?.title ?? '',
      groupLabel: ref?.groupLabel ?? '',
      title: payload.title,
      detail: payload.detail,
      toolName: payload.toolName ?? '',
      command: payload.command ?? '',
      since: at,
      updatedAt: at,
      snoozedUntil: 0,
      resolved: false
    }

    if (existing) {
      const isNewNeed = existing.fingerprint !== fingerprint
      const carried: AttentionItem = {
        ...item,
        since: isNewNeed ? at : existing.item.since,
        // A snooze was granted against the previous question; a different one
        // deserves to be seen. The same question re-firing does not.
        snoozedUntil: isNewNeed ? 0 : existing.item.snoozedUntil,
        title: item.title || existing.item.title,
        detail: item.detail || existing.item.detail,
        toolName: item.toolName || existing.item.toolName,
        command: item.command || existing.item.command
      }
      // Repeated identical signals are the common case (herdr re-emits on every
      // snapshot); touching the row then would repaint the queue for nothing.
      if (!isNewNeed && sameItem(carried, existing.item)) return null
      this.rows.set(id, {
        ...existing,
        item: carried,
        fingerprint,
        hint,
        resolvedAt: 0,
        readAttempts: isNewNeed ? 0 : existing.readAttempts,
        reading: false
      })
      if (carried.taskId) this.markBlocked(carried.taskId, carried.kind, carried.since)
      this.emit(isNewNeed ? { type: 'raised', item: carried } : { type: 'updated', item: carried })
      return isNewNeed ? { ...carried } : null
    }

    this.rows.set(id, {
      item,
      fingerprint,
      hint,
      readAttempts: 0,
      lastReadAt: 0,
      reading: false,
      resolvedAt: 0
    })
    if (taskId) this.markBlocked(taskId, kind, at)
    this.emit({ type: 'raised', item })
    return { ...item }
  }

  private markBlocked(taskId: string, kind: AttentionKind, at: number): void {
    if (!isBlockingKind(kind)) return
    const prior = this.blockedSince.get(taskId)
    if (!prior || prior <= 0) this.blockedSince.set(taskId, at)
  }

  private unmarkBlocked(taskId: string): void {
    const still = [...this.rows.values()].some(
      (row) => row.item.taskId === taskId && !row.item.resolved && isBlockingKind(row.item.kind)
    )
    if (!still) this.blockedSince.delete(taskId)
  }

  /** Resolve every live item of these kinds that this hint points at. */
  private clearKinds(hint: TaskHint, kinds: readonly AttentionKind[], reason: string): number {
    let cleared = 0
    for (const row of [...this.rows.values()]) {
      if (!kinds.includes(row.item.kind) || row.item.resolved) continue
      if (!pointsAt(row, hint)) continue
      this.resolveRow(row, reason)
      cleared += 1
    }
    return cleared
  }

  private resolveRow(row: Row, reason: string): void {
    if (row.item.resolved) return
    const item: AttentionItem = { ...row.item, resolved: true, updatedAt: this.now() }
    row.item = item
    row.resolvedAt = this.now()
    this.suppressed.set(row.item.id, {
      fingerprint: row.fingerprint,
      until: this.now() + RESOLVED_SUPPRESS_MS
    })
    if (item.taskId) this.unmarkBlocked(item.taskId)
    this.emit({ type: 'resolved', item, reason })
  }

  /**
   * True when this exact need was already dealt with and the window has not
   * expired. The fingerprint check keeps it honest: a different question from
   * the same pane is a new need and must get through.
   */
  private suppresses(id: string, fingerprint: string, at: number): boolean {
    const prior = this.suppressed.get(id)
    if (!prior) return false
    if (prior.until <= at) {
      this.suppressed.delete(id)
      return false
    }
    return prior.fingerprint === fingerprint
  }

  private drop(itemId: string, reason: string): void {
    const row = this.rows.get(itemId)
    if (!row) return
    this.rows.delete(itemId)
    // Suppression outlives the row on purpose: prune() drops resolved rows after
    // RESOLVED_TTL, and clearing here would shrink the window back to 20s.
    if (row.item.taskId) this.unmarkBlocked(row.item.taskId)
    this.emit({ type: 'dropped', itemId, reason })
  }

  /** The live blocking item a hint points at, optionally filtered by source. */
  private blockedItem(hint: TaskHint, source?: AttentionSource): AttentionItem | null {
    for (const row of this.rows.values()) {
      const item = row.item
      if (item.resolved || !isBlockingKind(item.kind)) continue
      if (source && item.source !== source) continue
      if (!pointsAt(row, hint)) continue
      return { ...item }
    }
    return null
  }

  /** The live item of one kind a hint points at, whatever its source. */
  private liveKind(hint: TaskHint, kind: AttentionKind): AttentionItem | null {
    for (const row of this.rows.values()) {
      const item = row.item
      if (item.resolved || item.kind !== kind) continue
      if (!pointsAt(row, hint)) continue
      return { ...item }
    }
    return null
  }

  /* ---------------------------------------------------------------- *
   * Human actions
   * ---------------------------------------------------------------- */

  /** The human acted: the row leaves the queue but stays readable for a moment. */
  resolve(itemId: string, reason = 'acted'): AttentionItem | null {
    const row = this.rows.get(itemId)
    if (!row) return null
    this.resolveRow(row, reason)
    return { ...row.item }
  }

  /** A task was parked, archived or recovered: nothing it wants matters now. */
  resolveTaskItems(taskId: string, reason = 'task closed'): number {
    let count = 0
    for (const row of [...this.rows.values()]) {
      if (row.item.taskId !== taskId || row.item.resolved) continue
      this.resolveRow(row, reason)
      count += 1
    }
    return count
  }

  snooze(itemId: string, until: number): AttentionItem | null {
    const row = this.rows.get(itemId)
    if (!row) return null
    const at = this.now()
    const item: AttentionItem = { ...row.item, snoozedUntil: Math.max(at + 1000, until), updatedAt: at }
    row.item = item
    this.emit({ type: 'snoozed', item, until: item.snoozedUntil })
    return { ...item }
  }

  snoozeAll(minutes = DEFAULT_SNOOZE_MINUTES): number {
    const until = this.now() + Math.max(1, Math.round(minutes)) * 60000
    let count = 0
    for (const row of [...this.rows.values()]) {
      if (row.item.resolved) continue
      this.snooze(row.item.id, until)
      count += 1
    }
    return count
  }

  /**
   * Fill in items that herdr raised blind. `reader` is a pane read; the tracker
   * never touches the socket itself, which keeps it unit-testable and leaves
   * exactly one owner for herdr IO.
   */
  async hydrate(reader: (item: AttentionItem) => Promise<PaneReadHint | null>, limit = 4): Promise<number> {
    const at = this.now()
    const targets = [...this.rows.values()].filter((row) => {
      const item = row.item
      if (item.resolved || row.reading) return false
      if (row.readAttempts >= MAX_READ_ATTEMPTS) return false
      if (row.lastReadAt && at - row.lastReadAt < READ_RETRY_MS) return false
      if (!item.paneId) return false
      // A hook item already carries the decision; only read what is missing.
      return !item.detail && !item.command
    })
    if (!targets.length) return 0
    let filled = 0
    for (const row of targets.slice(0, Math.max(1, limit))) {
      row.reading = true
      row.readAttempts += 1
      row.lastReadAt = at
      let hint: PaneReadHint | null = null
      try {
        hint = await reader({ ...row.item })
      } catch {
        hint = null
      } finally {
        row.reading = false
      }
      if (this.applyRead(row, hint)) filled += 1
    }
    return filled
  }

  private applyRead(row: Row, hint: PaneReadHint | null): boolean {
    if (!hint || !this.rows.has(row.item.id)) return false
    const kind: AttentionKind = hint.kind && hint.kind !== row.item.kind ? hint.kind : row.item.kind
    const title = String(hint.title ?? '').trim()
    const detail = String(hint.detail ?? '').trim()
    const toolName = String(hint.toolName ?? '').trim()
    const command = String(hint.command ?? '').trim()
    if (!title && !detail && !toolName && !command) return false

    const item: AttentionItem = {
      ...row.item,
      title: title || row.item.title,
      detail: detail || row.item.detail,
      toolName: toolName || row.item.toolName,
      command: command || row.item.command,
      updatedAt: this.now()
    }
    if (kind === row.item.kind) {
      row.item = item
      row.fingerprint = fingerprintOf(item.kind, item)
      this.emit({ type: 'updated', item })
      return true
    }
    // Reclassified: the id embeds the kind, so the row has to move. `since`
    // carries over, because how long the human has been kept waiting is a fact
    // about the wait, not about our guess at its type.
    const oldId = row.item.id
    const moved: AttentionItem = {
      ...item,
      kind,
      id: attentionId(item.taskId, kind, originOf(oldId)),
      since: row.item.since
    }
    this.rows.delete(oldId)
    this.emit({ type: 'dropped', itemId: oldId, reason: 'reclassified' })
    this.rows.set(moved.id, { ...row, item: moved, fingerprint: fingerprintOf(kind, moved) })
    this.emit({ type: 'raised', item: moved })
    return true
  }

  /* ---------------------------------------------------------------- *
   * Rebinding and pruning
   * ---------------------------------------------------------------- */

  /**
   * Retry task resolution for rows that arrived before the registry knew about
   * them (first run, or a hook that beat the snapshot). Also drops rows whose
   * task has been deleted outright. Returns how many rows moved.
   */
  resync(knownTaskIds?: ReadonlySet<string>): number {
    const at = this.now()
    let rebound = 0
    for (const row of [...this.rows.values()]) {
      if (knownTaskIds && row.item.taskId && !knownTaskIds.has(row.item.taskId)) {
        this.drop(row.item.id, 'task deleted')
        continue
      }
      if (row.item.taskId && row.item.taskTitle) continue
      const ref = this.resolveTask(row.hint)
      if (!ref) continue
      const oldId = row.item.id
      const item: AttentionItem = {
        ...row.item,
        taskId: ref.taskId,
        taskTitle: ref.title,
        groupLabel: ref.groupLabel,
        agentKind: row.item.agentKind || ref.agentKind,
        paneId: row.item.paneId || ref.paneId,
        workspaceId: row.item.workspaceId || ref.workspaceId,
        id: attentionId(ref.taskId, row.item.kind, originOf(oldId)),
        updatedAt: at
      }
      if (item.id === oldId) {
        row.item = item
        this.emit({ type: 'updated', item })
        rebound += 1
        continue
      }
      this.rows.delete(oldId)
      this.rows.set(item.id, { ...row, item })
      if (item.taskId) this.markBlocked(item.taskId, item.kind, item.since)
      this.emit({ type: 'raised', item })
      rebound += 1
    }
    return rebound
  }

  private prune(at: number): void {
    for (const row of [...this.rows.values()]) {
      if (!row.item.resolved) continue
      if (at - (row.resolvedAt || at) > RESOLVED_TTL) this.drop(row.item.id, 'expired')
    }
    for (const row of [...this.rows.values()]) {
      if (row.item.taskId || row.item.resolved) continue
      if (at - row.item.since > UNFILED_TTL) this.drop(row.item.id, 'unfiled and stale')
    }
    for (const [id, entry] of [...this.suppressed]) {
      if (entry.until <= at) this.suppressed.delete(id)
    }
  }

  /** Drop everything: herdr went away, or the bench is shutting down. */
  clear(): void {
    for (const id of [...this.rows.keys()]) this.drop(id, 'cleared')
    this.blockedSince.clear()
    this.revisions.clear()
    this.suppressed.clear()
  }

  private emit(event: TriageEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function isBlockingKind(kind: AttentionKind): boolean {
  return kind === 'permission' || kind === 'question' || kind === 'failed'
}

function fingerprintOf(
  kind: AttentionKind,
  payload: { title?: string; detail?: string; toolName?: string; command?: string }
): string {
  return [
    kind,
    payload.toolName ?? '',
    payload.command ?? '',
    payload.title ?? '',
    payload.detail ?? ''
  ].join('|')
}

/** True when the two field-level differences that matter are both absent. */
function sameItem(a: AttentionItem, b: AttentionItem): boolean {
  return (
    a.kind === b.kind &&
    a.source === b.source &&
    a.taskId === b.taskId &&
    a.paneId === b.paneId &&
    a.title === b.title &&
    a.detail === b.detail &&
    a.toolName === b.toolName &&
    a.command === b.command &&
    a.snoozedUntil === b.snoozedUntil &&
    a.resolved === b.resolved
  )
}

/** Does this row belong to the place the hint points at? */
function pointsAt(row: Row, hint: TaskHint): boolean {
  if (hint.paneId && row.item.paneId) return row.item.paneId === hint.paneId
  if (hint.sessionId && row.hint.sessionId) return row.hint.sessionId === hint.sessionId
  if (hint.cwd && row.hint.cwd) return samePath(row.hint.cwd, hint.cwd)
  return false
}

function hookPayload(event: HookEvent, fallbackTitle = ''): RaisePayload {
  const detail = String(event.detail || '').trim()
  const source = String(event.sourceText || '').trim()
  const title = fallbackTitle || detail || source || defaultTitle(event.kind)
  return {
    title: clip(title, 160),
    detail: clip(source && source !== detail ? source : detail, 400),
    toolName: String(event.toolName || '').trim(),
    command: clip(commandOf(detail, event.toolName), 400)
  }
}

function defaultTitle(kind: HookEvent['kind']): string {
  switch (kind) {
    case 'permission':
      return 'Permission needed'
    case 'notification':
      return 'Agent needs input'
    case 'stop':
      return 'Finished, awaiting review'
    default:
      return 'Needs you'
  }
}

/**
 * `detail` for a tool hook is "Bash npm test"; splitting it back apart is worth
 * it because the queue shows the command in monospace and the tool as a chip,
 * and a human scanning twenty rows reads those two, not the sentence.
 */
function commandOf(detail: string, toolName: string): string {
  const text = String(detail || '').trim()
  if (!text) return ''
  const tool = String(toolName || '').trim()
  if (tool && text.startsWith(tool)) return text.slice(tool.length).trim()
  return ''
}

function hintOfPane(pane: PaneInfo): TaskHint {
  return {
    ...emptyHint(),
    paneId: pane.paneId,
    workspaceId: pane.workspaceId,
    agent: pane.displayAgent || pane.agent,
    cwd: pane.foregroundCwd || pane.cwd,
    sessionId: pane.agentSession?.kind === 'id' ? pane.agentSession.value : ''
  }
}

/** `taskId:kind:origin` -> origin, so a reclassified item keeps its lineage. */
function originOf(id: string): string {
  const parts = String(id || '').split(':')
  return parts.length > 2 ? parts.slice(2).join(':') : 'hook'
}

function samePath(a: string, b: string): boolean {
  const left = String(a || '').replace(/[\\/]+$/, '')
  const right = String(b || '').replace(/[\\/]+$/, '')
  if (!left || !right) return false
  return left === right || left.toLowerCase() === right.toLowerCase()
}

function clip(text: string, max: number): string {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  return value.length > max ? `${value.slice(0, max - 1)}...` : value
}

/** Like `clip`, but a terminal tail is only readable if it keeps its newlines. */
function clipBlock(text: string, max: number): string {
  const value = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!value) return ''
  if (value.length <= max) return value
  return `...${value.slice(value.length - max)}`
}

/**
 * Turn a pane read into queue context. herdr can tell us a pane is `blocked`
 * but not what it is blocked on; the last screenful can, and it is the only
 * source we have for agents with no hooks installed.
 *
 * `current` is the kind we already guessed. A read only ever reclassifies
 * towards `permission`, because that is the one thing the text can prove: a
 * prompt on screen means a keypress answers it, which changes what the bench
 * offers to click.
 */
export function paneReadHint(text: string, current: AttentionKind): PaneReadHint | null {
  const raw = String(text || '').replace(/\r\n?/g, '\n')
  const lines = raw
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0)
  if (!lines.length) return null

  const tail = lines.slice(-READ_TAIL_LINES)
  const lastLine = tail[tail.length - 1].trim()

  // Nearest prompt to the cursor wins: older ones are already answered.
  let prompt = ''
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    if (PERMISSION_TEXT.test(tail[i])) {
      prompt = tail[i].trim()
      break
    }
  }

  let command = ''
  for (const line of tail) {
    const trimmed = line.trim()
    if (/^[$#>]\s+\S/.test(trimmed)) {
      command = trimmed.replace(/^[$#>]\s+/, '')
      break
    }
  }

  const detail = clipBlock(raw, READ_DETAIL_MAX)
  const title = clip(prompt || lastLine, 160)
  if (!title && !detail && !command) return null

  const kind: AttentionKind = prompt ? 'permission' : current
  const hint: PaneReadHint = {}
  if (title) hint.title = title
  if (detail) hint.detail = detail
  if (command) hint.command = clip(command, 400)
  if (kind !== current) hint.kind = kind
  return hint
}
