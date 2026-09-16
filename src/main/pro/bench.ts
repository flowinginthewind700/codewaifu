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
  bindTask,
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

export interface RegistryFile {
  version: number
  updatedAt: number
  tasks: TaskRecord[]
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
    const file: RegistryFile = {
      version: REGISTRY_VERSION,
      updatedAt: this.now(),
      tasks: this.load().slice()
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

  /**
   * Adopt every unclaimed herdr workspace. Persisted immediately: an adopted
   * task that is lost on crash would make the bench look non-deterministic.
   */
  adopt(snapshot: Snapshot | null): ProvisionResult {
    const result = provisionTasks({
      snapshot,
      tasks: this.load(),
      now: this.now(),
      newId: () => this.newId()
    })
    if (result.created.length) {
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
    const bindings = this.load().map((task) => bindTask(task, snapshot))
    let changed = false
    for (const binding of bindings) {
      const task = this.get(binding.taskId)
      if (!task) continue
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
}

function baseName(value: string): string {
  const parts = String(value || '').split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

function nonNull<T>(value: T | null): value is T {
  return value !== null
}
