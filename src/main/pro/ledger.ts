/**
 * The intent ledger: an append-only JSONL file per task, fsync'd (F5, L3).
 *
 * This is the part of Pro that nobody else has. herdr can restore a layout and
 * an agent CLI can resume a conversation, but neither can answer "what was this
 * task *for*, what did we decide, and what was supposed to happen next" three
 * days after the machine rebooted. So the format is deliberately dumb: one JSON
 * object per line, no nesting, no required field beyond `at` and `kind`, and a
 * reader that drops corrupt lines instead of failing. A truncated tail from a
 * crash mid-write is an expected state, not an error.
 *
 * The store keeps a per-task entry cache so rebuilding the bench on every herdr
 * event does not re-read the disk, and appends go through `openSync('a')` +
 * `fsyncSync` because a ledger that can lose the last line is not a ledger.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import {
  ledgerDigest,
  parseLedger,
  type LedgerDigest,
  type LedgerEntry,
  type LedgerKind
} from '../../shared/pro'
import { ensureProDirs, isSafeTaskId, ledgerFileFor } from './env'

export interface LedgerInput {
  taskId: string
  kind: LedgerKind
  text?: string
  agent?: string
  sessionKind?: 'id' | 'path' | ''
  sessionValue?: string
  gitHead?: string
  branch?: string
  dirty?: number
  paneId?: string
  workspaceId?: string
  /** `hook` | `gui` | `api` | `agent` | `herdr` — who asserted this. */
  source?: string
  at?: number
  id?: string
}

/** Clip text so one chatty agent cannot write a 4MB line. */
const TEXT_LIMIT = 4000
/** Entries kept per task before compaction is worth offering. */
export const DEFAULT_LEDGER_LIMIT = 400

export function newEntryId(at: number, kind: string): string {
  return `${at.toString(36)}-${kind}-${crypto.randomBytes(3).toString('hex')}`
}

/**
 * Build one entry. Returns null when the task id is not writable, which is the
 * only validation a ledger needs: everything else is data.
 */
export function newEntry(input: LedgerInput, now = Date.now()): LedgerEntry | null {
  if (!isSafeTaskId(input.taskId)) return null
  const at = Number.isFinite(input.at) && (input.at as number) > 0 ? Math.trunc(input.at as number) : now
  return {
    v: 1,
    at,
    id: input.id || newEntryId(at, input.kind),
    taskId: input.taskId,
    kind: input.kind,
    text: clip(input.text ?? ''),
    agent: String(input.agent ?? '').trim().toLowerCase(),
    sessionKind: input.sessionKind === 'path' ? 'path' : input.sessionKind === 'id' ? 'id' : '',
    sessionValue: clip(input.sessionValue ?? '', 400),
    gitHead: clip(input.gitHead ?? '', 64),
    branch: clip(input.branch ?? '', 200),
    dirty: Math.max(0, Math.trunc(Number(input.dirty) || 0)),
    paneId: clip(input.paneId ?? '', 120),
    workspaceId: clip(input.workspaceId ?? '', 120),
    source: clip(input.source ?? 'gui', 24)
  }
}

function clip(value: string, limit = TEXT_LIMIT): string {
  const text = String(value ?? '')
  return text.length > limit ? text.slice(0, limit) : text
}

export function entryLine(entry: LedgerEntry): string {
  return `${JSON.stringify(entry)}\n`
}

/** Append one line and make sure it reached the platter. */
export function appendEntry(entry: LedgerEntry): boolean {
  const file = ledgerFileFor(entry.taskId)
  if (!file) return false
  ensureProDirs()
  let fd = -1
  try {
    fd = fs.openSync(file, 'a')
    fs.writeSync(fd, entryLine(entry))
    fs.fsyncSync(fd)
    return true
  } catch {
    return false
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd)
      } catch {
        /* nothing left to do */
      }
    }
  }
}

export function readEntries(taskId: string): LedgerEntry[] {
  const file = ledgerFileFor(taskId)
  if (!file) return []
  try {
    return parseLedger(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

/** Task ids that have a ledger on disk. Used by recovery and by `pro tasks`. */
export function ledgerTaskIds(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length))
      .filter(isSafeTaskId)
  } catch {
    return []
  }
}

/**
 * Shrink a ledger without losing the recovery brief.
 *
 * Compaction is a *rewrite*, so it has to keep every line the digest reads:
 * the last goal, the last next action, the last session id, the last git state,
 * and a bounded tail of plans and decisions. Everything else is noise from a
 * long session, and the most recent entries always survive because "what just
 * happened" is the second thing a human asks after "what was this for".
 */
export function compactEntries(entries: readonly LedgerEntry[], limit = DEFAULT_LEDGER_LIMIT): LedgerEntry[] {
  if (entries.length <= limit) return entries.slice()
  const keep = new Set<LedgerEntry>()
  const take = (count: number, kinds: readonly LedgerKind[]): void => {
    let taken = 0
    for (let index = entries.length - 1; index >= 0 && taken < count; index -= 1) {
      const entry = entries[index]
      if (!kinds.includes(entry.kind)) continue
      if (keep.has(entry)) continue
      keep.add(entry)
      taken += 1
    }
  }
  take(1, ['goal'])
  take(1, ['next'])
  take(2, ['session'])
  take(1, ['git'])
  take(1, ['checkpoint'])
  take(24, ['plan'])
  take(40, ['decision'])
  for (let index = entries.length - 1; index >= 0 && keep.size < limit; index -= 1) keep.add(entries[index])
  return entries.filter((entry) => keep.has(entry))
}

/** Rewrite one ledger in place. Returns the entry count after compaction. */
export function compactLedger(taskId: string, limit = DEFAULT_LEDGER_LIMIT): number {
  const file = ledgerFileFor(taskId)
  if (!file) return 0
  const kept = compactEntries(readEntries(taskId), limit)
  const body = kept.map(entryLine).join('')
  ensureProDirs()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    return 0
  }
  return kept.length
}

/**
 * The object the rest of Pro talks to. Caching matters because the bench
 * rebuilds its whole projection on every herdr event, and a projection that
 * re-reads 20 files per keystroke of output is how a workbench becomes lag.
 */
export class LedgerStore {
  private readonly cache = new Map<string, LedgerEntry[]>()
  private readonly digests = new Map<string, LedgerDigest>()
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  entries(taskId: string): LedgerEntry[] {
    const hit = this.cache.get(taskId)
    if (hit) return hit
    const loaded = readEntries(taskId)
    if (loaded.length) this.cache.set(taskId, loaded)
    return loaded
  }

  digest(taskId: string): LedgerDigest | null {
    const cached = this.digests.get(taskId)
    if (cached) return cached
    const entries = this.entries(taskId)
    if (!entries.length) return null
    const digest = ledgerDigest(taskId, entries)
    this.digests.set(taskId, digest)
    return digest
  }

  /** Every digest Pro knows about, for the bench projection. */
  allDigests(taskIds: readonly string[]): Record<string, LedgerDigest | null> {
    const out: Record<string, LedgerDigest | null> = {}
    for (const taskId of taskIds) out[taskId] = this.digest(taskId)
    return out
  }

  append(input: LedgerInput, now = Date.now()): LedgerEntry | null {
    const entry = newEntry(input, now)
    if (!entry) return null
    if (!appendEntry(entry)) return null
    const list = this.cache.get(entry.taskId) ?? this.entries(entry.taskId)
    const next = list.concat([entry])
    this.cache.set(entry.taskId, next)
    this.digests.set(entry.taskId, ledgerDigest(entry.taskId, next))
    if (next.length > DEFAULT_LEDGER_LIMIT * 2) {
      const compacted = compactEntries(next)
      if (compacted.length !== next.length && compactLedger(entry.taskId)) {
        this.cache.set(entry.taskId, compacted)
        this.digests.set(entry.taskId, ledgerDigest(entry.taskId, compacted))
      }
    }
    return entry
  }

  /** Drop cached state for a task (after an external edit or a delete). */
  invalidate(taskId: string): void {
    this.cache.delete(taskId)
    this.digests.delete(taskId)
  }

  knownTaskIds(): string[] {
    return ledgerTaskIds(this.dir)
  }
}

/** Replace a whole ledger atomically (tests, and the "rewrite" verb). */
export function writeLedger(taskId: string, entries: readonly LedgerEntry[]): boolean {
  const file = ledgerFileFor(taskId)
  if (!file) return false
  ensureProDirs()
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, entries.map(entryLine).join(''), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}
