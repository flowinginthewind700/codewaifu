/**
 * The task registry (F2): the only file Pro owns about *what work exists*.
 *
 * A task is the atom the human thinks in; herdr's workspace/pane ids are how
 * that atom happens to be alive right now. Keeping them in separate places is
 * the whole point — the registry survives a herdr restart, a rebuild and a
 * reboot, and `provisionTasks` re-binds it to whatever is live on boot.
 *
 * Adoption matters as much as creation: nobody should have to change how they
 * work to get value here, so every herdr workspace with no task becomes one the
 * first time the bench sees it.
 */
import crypto from 'node:crypto'
import {
  bindTasks,
  parseTaskRecord,
  provisionTasks,
  type ProvisionResult,
  type TaskBinding,
  type TaskRecord,
  type TaskOrigin,
  type TaskStatus
} from '../../shared/pro'
import type { Snapshot } from '../../shared/herdr'
import { readJson, writeJsonAtomic } from './env'

/** Bumped when the on-disk shape changes; a mismatch is a re-read, not a crash. */
export const REGISTRY_VERSION = 1

/**
 * A workspace the human removed, remembered until herdr agrees it is gone.
 *
 * Removing a row used to be the whole operation, and adoption undid it: every
 * snapshot re-adopts whatever no task claims, so a closed-over shell came back
 * on the next one - and "open a new terminal" is exactly what delivers the next
 * one. What the human meant by remove has to outlive the row it deleted.
 *
 * The entry is dropped once a snapshot stops reporting the workspace, so a
 * herdr restart that recycles the id cannot be blocked by a removal from last
 * week; `at` is the backstop for a workspace that never reappears at all.
 */
export interface ForgottenWorkspace {
  workspaceId: string
  paneIds: string[]
  at: number
}

/**
 * How long a removal is honoured when herdr never lets the workspace go.
 *
 * The entry normally dies the moment a snapshot stops reporting the workspace,
 * so this is only the backstop for a shell that stays alive indefinitely - and
 * for one that outlives the removal by longer than this, being adopted back
 * once is the lesser evil against an id that is blocked forever. A day, because
 * "I closed that yesterday" still has to mean closed.
 */
export const FORGOTTEN_TTL_MS = 24 * 60 * 60 * 1000

export interface RegistryFile {
  version: number
  updatedAt: number
  tasks: TaskRecord[]
  /** Optional: a registry written before removals were remembered has none. */
  forgotten?: ForgottenWorkspace[]
}

export interface CreateTaskInput {
  title?: string
  goal?: string
  workdir?: string
  repoRoot?: string
  branch?: string
  agentKind?: string
  agentSessionId?: string
  workspaceId?: string
  paneIds?: readonly string[]
  status?: TaskStatus
  id?: string
  /** Defaults to `created`; adoption and import pass their own. */
  origin?: TaskOrigin
}

export type RegistryPatch = Partial<Omit<TaskRecord, 'id' | 'createdAt'>>

/** `t` + base36 time + 4 hex: sortable, file-safe, and unique enough. */
export function newTaskId(now = Date.now()): string {
  return `t${now.toString(36)}${crypto.randomBytes(2).toString('hex')}`
}

export interface RegistryDeps {
  file: string
  now?: () => number
  newId?: () => string
  read?: (file: string) => RegistryFile | null
  write?: (file: string, value: RegistryFile) => boolean
}

export class TaskRegistry {
  private readonly file: string
  private readonly now: () => number
  private readonly newId: () => string
  private readonly read: (file: string) => RegistryFile | null
  private readonly write: (file: string, value: RegistryFile) => boolean
  private records: TaskRecord[] = []
  private forgottenRecords: ForgottenWorkspace[] = []
  private loaded = false
  private dirty = false

  constructor(deps: RegistryDeps) {
    this.file = deps.file
    this.now = deps.now ?? (() => Date.now())
    this.newId = deps.newId ?? newTaskId
    this.read = deps.read ?? ((file) => readJson<RegistryFile>(file))
    this.write =
      deps.write ??
      ((file, value) => {
        // A failed flush must not take the process down: the registry keeps its
        // in-memory truth and the caller decides whether to surface it.
        try {
          writeJsonAtomic(file, value)
          return true
        } catch {
          return false
        }
      })
  }

  /** Load once, lazily: a headless CLI run should not pay for a file it ignores. */
  load(force = false): TaskRecord[] {
    if (this.loaded && !force) return this.records
    const raw = this.read(this.file)
    const tasks = Array.isArray(raw?.tasks) ? raw.tasks : []
    this.records = tasks.map((entry) => parseTaskRecord(entry)).filter(nonNull)
    this.forgottenRecords = parseForgotten(raw?.forgotten)
    this.loaded = true
    this.dirty = false
    return this.records
  }

  tasks(): TaskRecord[] {
    return this.load().slice()
  }

  get(taskId: string): TaskRecord | null {
    return this.load().find((task) => task.id === taskId) ?? null
  }

  /** Persist now. Returns false when the write or the read-back failed. */
  save(): boolean {
    // `load()` first: `forgottenRecords` is only populated by it, and saving
    // before the first load would overwrite the file's list with an empty one.
    this.load()
    const file: RegistryFile = {
      version: REGISTRY_VERSION,
      updatedAt: this.now(),
      tasks: this.records.slice(),
      forgotten: this.forgottenRecords.slice()
    }
    const ok = this.write(this.file, file)
    if (ok) this.dirty = false
    return ok
  }

  get pending(): boolean {
    return this.dirty
  }

  private touch(): void {
    this.dirty = true
  }

  create(input: CreateTaskInput): TaskRecord {
    const now = this.now()
    const task: TaskRecord = {
      id: input.id && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.id) ? input.id : this.newId(),
      title: String(input.title ?? '').trim() || baseName(input.workdir ?? '') || 'untitled',
      goal: String(input.goal ?? ''),
      workdir: String(input.workdir ?? ''),
      repoRoot: String(input.repoRoot ?? input.workdir ?? ''),
      branch: String(input.branch ?? ''),
      agentKind: String(input.agentKind ?? '').toLowerCase(),
      agentSessionId: String(input.agentSessionId ?? ''),
      agentSessionPath: '',
      workspaceId: String(input.workspaceId ?? ''),
      paneIds: (input.paneIds ?? []).slice(),
      status: input.status ?? 'active',
      createdAt: now,
      updatedAt: now,
      parkedAt: 0,
      origin: input.origin ?? 'created'
    }
    this.load().push(task)
    this.touch()
    return task
  }

  upsert(task: TaskRecord): TaskRecord {
    const list = this.load()
    const at = list.findIndex((entry) => entry.id === task.id)
    if (at >= 0) list[at] = task
    else list.push(task)
    this.touch()
    return task
  }

  /**
   * Field-level update. `updatedAt` is refreshed by us, and `parkedAt` is set
   * when a task is parked because "how long has this been sitting here" is a
   * question the tree answers without asking the ledger.
   */
  patch(taskId: string, patch: RegistryPatch): TaskRecord | null {
    const task = this.get(taskId)
    if (!task) return null
    const now = this.now()
    const next: TaskRecord = { ...task, ...patch, id: task.id, createdAt: task.createdAt, updatedAt: now }
    if (patch.status === 'parked' && !task.parkedAt) next.parkedAt = now
    if (patch.status && patch.status !== 'parked') next.parkedAt = 0
    return this.upsert(next)
  }

  setStatus(taskId: string, status: TaskStatus): TaskRecord | null {
    return this.patch(taskId, { status })
  }

  remove(taskId: string): boolean {
    const list = this.load()
    const at = list.findIndex((entry) => entry.id === taskId)
    if (at < 0) return false
    list.splice(at, 1)
    this.touch()
    return true
  }

  /* ---------------------------------------------------------------- *
   * Remembered removals
   * ---------------------------------------------------------------- */

  /** The workspace ids a removal is still standing in front of. */
  forgotten(): string[] {
    this.load()
    return this.forgottenRecords.map((entry) => entry.workspaceId).filter(Boolean)
  }

  /**
   * Record a removal. Idempotent per workspace: removing two rows that were
   * both bound to one recycled id is one fact, not two.
   */
  forget(workspaceId: string, paneIds: readonly string[] = []): void {
    this.load()
    if (!workspaceId) return
    const at = this.now()
    const existing = this.forgottenRecords.find((entry) => entry.workspaceId === workspaceId)
    if (existing) {
      existing.at = at
      for (const paneId of paneIds) if (!existing.paneIds.includes(paneId)) existing.paneIds.push(paneId)
      this.touch()
      return
    }
    this.forgottenRecords.push({ workspaceId, paneIds: paneIds.slice(), at })
    this.touch()
  }

  /**
   * Drop a remembered removal, because the workspace is back on the bench.
   *
   * Only the explicit adopt path calls this. The entry would be harmless while
   * the row claims its workspace - a claimed workspace is never adopted twice -
   * but leaving it there means the next removal of the same row starts a fresh
   * day on the clock, and that a row whose binding went stale is blocked from
   * re-binding for no reason anybody can see.
   */
  unforget(workspaceId: string): void {
    this.load()
    if (!workspaceId) return
    const before = this.forgottenRecords.length
    this.forgottenRecords = this.forgottenRecords.filter(
      (entry) => entry.workspaceId !== workspaceId
    )
    if (this.forgottenRecords.length !== before) this.touch()
  }

  /**
   * Reconcile the list against what herdr now reports.
   *
   * A workspace herdr no longer has is a removal that landed - drop the entry,
   * because the id is about to be free for a genuinely new session. Entries
   * past the TTL go too: an id blocked forever is worse than one row that comes
   * back once.
   *
   * An empty report changes nothing. "herdr has no workspaces" arrives on the
   * reconnect while the server is still restoring its session, and treating it
   * as evidence would clear every removal a moment before the real snapshot
   * re-adopts all of them - the resurrection this list exists to prevent, now
   * on a timer nobody can see. The TTL still bounds an entry herdr never
   * reports again, so nothing is blocked forever.
   */
  reconcileForgotten(live: readonly string[]): void {
    this.load()
    if (!live.length) return
    const present = new Set(live.filter(Boolean))
    const now = this.now()
    const before = this.forgottenRecords.length
    this.forgottenRecords = this.forgottenRecords.filter(
      (entry) => present.has(entry.workspaceId) && now - entry.at < FORGOTTEN_TTL_MS
    )
    if (this.forgottenRecords.length !== before) this.touch()
  }

  /**
   * Adopt every unclaimed herdr workspace. Persisted immediately: an adopted
   * task that is lost on crash would make the bench look non-deterministic.
   *
   * `explicit` tells apart a snapshot arriving from the human pressing "adopt
   * workspaces". A remembered removal stands against the first - that is the
   * whole point of remembering it - and yields to the second. The alternative
   * is a button in the toolbar that silently does nothing for up to a day
   * after a removal, and the empty state invites a new user to press exactly
   * that button. Re-adopting on request is not the resurrection bug: the bug
   * was the bench growing rows nobody asked for.
   */
  adopt(snapshot: Snapshot | null, options: { explicit?: boolean } = {}): ProvisionResult {
    const explicit = options.explicit === true
    const result = provisionTasks({
      snapshot,
      tasks: this.load(),
      now: this.now(),
      newId: () => this.newId(),
      // A workspace the human removed is not "unclaimed", it is declined - and
      // the difference is whether it comes back on the next snapshot.
      forgotten: explicit ? [] : this.forgotten()
    })
    if (result.created.length) {
      if (explicit) for (const task of result.created) this.unforget(task.workspaceId)
      const list = this.load()
      list.push(...result.created)
      this.touch()
      this.save()
    }
    return result
  }

  /**
   * Re-bind tasks to live panes and persist anything that moved. This is what
   * makes a herdr restart invisible: ids change, tasks do not.
   */
  rebind(snapshot: Snapshot | null): TaskBinding[] {
    const bindings = bindTasks(this.load(), snapshot)
    const losers = this.duplicateClaims(bindings)
    let changed = false
    for (const binding of bindings) {
      const task = this.get(binding.taskId)
      if (!task) continue
      // Lost the workspace to a row with a better claim on it. The pane binding
      // goes, and unlike a merely stale one it goes for good: it points at a
      // shell somebody else is typing into, and recovery acting on it would
      // resume a conversation into the wrong terminal. `agentSessionId` stays -
      // that is the real resume evidence, and it is not shared.
      if (losers.has(binding.taskId)) {
        if (task.workspaceId || task.paneIds.length) {
          this.patch(task.id, { workspaceId: '', paneIds: [] })
          changed = true
        }
        binding.workspaceId = ''
        binding.paneIds = []
        binding.matchedBy = 'stale'
        continue
      }
      const sameWorkspace = task.workspaceId === binding.workspaceId
      const samePanes =
        task.paneIds.length === binding.paneIds.length &&
        task.paneIds.every((id, index) => id === binding.paneIds[index])
      if (sameWorkspace && samePanes) continue
      // A stale binding is left alone on purpose: the pane may come back, and
      // forgetting the last known ids would cost recovery its best evidence.
      if (binding.matchedBy === 'stale') continue
      this.patch(task.id, { workspaceId: binding.workspaceId, paneIds: binding.paneIds })
      changed = true
    }
    if (changed) this.save()
    return bindings
  }

  /**
   * Which rows have to give up a workspace another row also claims.
   *
   * `bindTasks` already stops the weak rule from taking a workspace the strong
   * ones hold, so what is left here is the case no per-snapshot reasoning can
   * see: herdr recycles `w1` across a rebuild, and two rows written in
   * different lives both name it. Left alone the tree shows two tasks over one
   * pane and the older one mirrors output it never started.
   *
   * The claim backed by better evidence wins - a stored workspace id, then a
   * conversation id, then a directory guess. Equal evidence means the id really
   * was recycled, and the row that opened its session most recently is the one
   * holding the live claim.
   */
  private duplicateClaims(bindings: TaskBinding[]): Set<string> {
    const byWorkspace = new Map<string, TaskBinding[]>()
    for (const binding of bindings) {
      if (!binding.workspaceId || binding.matchedBy === 'stale') continue
      const list = byWorkspace.get(binding.workspaceId)
      if (list) list.push(binding)
      else byWorkspace.set(binding.workspaceId, [binding])
    }
    const losers = new Set<string>()
    for (const group of byWorkspace.values()) {
      if (group.length < 2) continue
      const keep = group.reduce((best, binding) =>
        this.betterClaim(binding, best) ? binding : best
      )
      for (const binding of group) if (binding.taskId !== keep.taskId) losers.add(binding.taskId)
    }
    return losers
  }

  /** Is `candidate` the stronger of two claims on one workspace? */
  private betterClaim(candidate: TaskBinding, current: TaskBinding): boolean {
    const rank = (binding: TaskBinding): number =>
      binding.matchedBy === 'workspace' ? 3 : binding.matchedBy === 'session' ? 2 : 1
    const byEvidence = rank(candidate) - rank(current)
    if (byEvidence) return byEvidence > 0
    return this.createdAt(candidate.taskId) > this.createdAt(current.taskId)
  }

  private createdAt(taskId: string): number {
    return this.load().find((task) => task.id === taskId)?.createdAt ?? 0
  }
}

function baseName(value: string): string {
  const parts = String(value || '').split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/** Tolerant read of the on-disk list: a bad entry is dropped, not fatal. */
function parseForgotten(raw: unknown): ForgottenWorkspace[] {
  if (!Array.isArray(raw)) return []
  const out: ForgottenWorkspace[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const workspaceId = typeof record.workspaceId === 'string' ? record.workspaceId : ''
    if (!workspaceId) continue
    const paneIds = Array.isArray(record.paneIds)
      ? record.paneIds.filter((id): id is string => typeof id === 'string')
      : []
    const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0
    out.push({ workspaceId, paneIds, at })
  }
  return out
}
function nonNull<T>(value: T | null): value is T {
  return value !== null
}
