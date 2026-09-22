import fs from 'node:fs'
import { createRequire } from 'node:module'
import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  clipText,
  isInjectedContext,
  summarizeArgs,
  toolCommand,
  type ChatMessage
} from '../shared/chat'
import { toSpeakable } from '../shared/lang'
import type { ThreadInfo } from '../shared/protocol'
import { zcodeDbFile } from './env'
import { log } from './log'

// ============================================================
// ZCode's history, read out of SQLite.
//
// ZCode writes no JSONL. Everything it remembers lives in one database -
// `~/.zcode/cli/db/db.sqlite` - in three tables: `session` (one row per
// conversation, title and working directory included), `message` (a JSON blob
// per turn, `role` plus a `synthetic` flag) and `part` (a JSON blob per step
// inside a turn: `text`, `reasoning`, `tool`, plus `step-start`/`step-finish`
// noise nobody wants to read). Both `message` and `part` carry a `sequence`
// that agrees with their timestamps, so ordering is a sort key rather than a
// guess.
//
// Three rules this file lives by:
//
// 1. Read-only, always. The database belongs to a running agent; opening it
//    writable would risk a lock fight we can only lose, so every handle is
//    `readOnly: true` and closed in a `finally`.
// 2. Windowed, never whole. A month of ZCode is tens of MB of parts, so the
//    query asks SQLite for the newest `limit` chat parts through the index on
//    `(session_id, sequence)` and reports what it left out as `dropped`.
// 3. Failure is silence. No ZCode, no database, a schema we do not recognize,
//    a mid-write lock: the answer is `null` (or `[]` for the thread list) and
//    a throttled warning. An agent we cannot read must never take the panel
//    down with us.
//
// ⛔ `node:sqlite` is loaded through `createRequire` and behind a try/catch:
//    it is unflagged only from Node 22.13 on, so an older Electron answers
//    `undefined` here and ZCode simply stays a hook reporter.
// ============================================================

type SqlParam = string | number | bigint | null
type SqlRow = Record<string, SqlParam>

interface SqlStatement {
  all(...params: SqlParam[]): SqlRow[]
  get(...params: SqlParam[]): SqlRow | undefined
}

interface SqlDatabase {
  prepare(sql: string): SqlStatement
  close(): void
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqlDatabase
}

let sqliteModule: SqliteModule | null | undefined

function sqlite(): SqliteModule | null {
  if (sqliteModule !== undefined) return sqliteModule
  try {
    // Same rebuild-the-require trick the other native deps here use: the main
    // bundle is ESM, and a builtin under a `node:` specifier still resolves
    // through it without the bundler having to know the name exists.
    const required = createRequire(import.meta.url)('node:sqlite') as Partial<SqliteModule> | undefined
    sqliteModule = typeof required?.DatabaseSync === 'function' ? (required as SqliteModule) : null
  } catch {
    sqliteModule = null
  }
  return sqliteModule
}

/** One warning per database per minute: a corrupt file must not fill the log. */
const warned = new Map<string, number>()
const WARN_EVERY_MS = 60_000

function warnOnce(dbPath: string, error: unknown): void {
  const now = Date.now()
  const last = warned.get(dbPath) ?? 0
  if (now - last < WARN_EVERY_MS) return
  warned.set(dbPath, now)
  log('warn', 'zcode database read failed', `${dbPath}: ${String(error)}`)
}

/** Run `read` against a read-only handle, answering `null` on any failure. */
function withDatabase<T>(dbPath: string, read: (db: SqlDatabase) => T): T | null {
  if (!dbPath) return null
  const module = sqlite()
  if (!module) return null
  // A missing database is the normal case for anyone without ZCode installed:
  // answer quietly rather than paying SQLite's open error every 2.5s.
  if (!fs.existsSync(dbPath)) return null
  let db: SqlDatabase | null = null
  try {
    db = new module.DatabaseSync(dbPath, { readOnly: true })
    return read(db)
  } catch (error) {
    warnOnce(dbPath, error)
    return null
  } finally {
    if (db) {
      try {
        db.close()
      } catch {
        /* a handle that will not close is not worth an exception of its own */
      }
    }
  }
}

const SESSION_COLUMNS = 'id, title, directory, time_updated'

/**
 * Sessions worth listing: not archived, and not a sub-agent's. Sub-agent rows
 * are `task_type = 'subagent_child'` *and* carry a `parent_id`, so the parent
 * check alone drops them and keeps the query off a column a future ZCode may
 * rename.
 */
const THREADS_SQL = `select ${SESSION_COLUMNS} from session
  where time_archived is null and parent_id is null
  order by time_updated desc, id desc limit ?`

/** ZCode's own session row, so the chat header can name the thread. */
export interface ZcodeSession {
  id: string
  title: string
  cwd: string
  updatedAt: number
}

/**
 * Find one session by id, in either spelling.
 *
 * The database keys sessions as `sess_<uuid>`, while a hook payload may report
 * the bare uuid - and a thread listed from a live event and the same thread
 * listed from the database have to land on the same key, or the board shows one
 * conversation twice. The suffix match costs nothing (the column is the primary
 * key, and the list is a handful of rows) and makes both spellings resolve.
 */
const SESSION_BY_ID_SQL = `select ${SESSION_COLUMNS} from session
  where id = ? or substr(id, -length(?)) = ? limit 1`

function sessionRow(row: SqlRow | undefined): ZcodeSession | null {
  if (!row) return null
  const id = String(row.id ?? '')
  if (!id) return null
  return {
    id,
    title: String(row.title ?? ''),
    cwd: String(row.directory ?? ''),
    updatedAt: Number(row.time_updated ?? 0) || 0
  }
}

export function zcodeSession(dbPath: string = zcodeDbFile, id: string = ''): ZcodeSession | null {
  const wanted = String(id || '').trim()
  if (!wanted) return null
  return withDatabase(dbPath, (db) =>
    sessionRow(db.prepare(SESSION_BY_ID_SQL).get(wanted, wanted, wanted))
  )
}

export function zcodeThreads(dbPath: string = zcodeDbFile, limit: number = 40): ThreadInfo[] {
  const rows = withDatabase(dbPath, (db) => db.prepare(THREADS_SQL).all(Math.max(1, limit)))
  if (!rows) return []
  const out: ThreadInfo[] = []
  for (const row of rows) {
    const session = sessionRow(row)
    if (!session) continue
    out.push({
      key: `zcode:${session.id}`,
      agent: 'zcode',
      id: session.id,
      title: toSpeakable(session.title || shortPath(session.cwd) || tail(session.id), 60),
      cwd: session.cwd,
      updatedAt: session.updatedAt,
      live: false,
      lastKind: '',
      lastDetail: '',
      // ZCode has no injection API, so steering falls back to the clipboard -
      // the same honest answer the thread list gives for Claude Code.
      steerable: false
    })
  }
  return out
}

/**
 * The newest `limit` chat parts of one session, oldest-first.
 *
 * The subquery does the windowing (`order by ... desc limit ?`) and the outer
 * one puts the rows back in reading order, which is what lets SQLite satisfy
 * both directions from `message_session_sequence_idx` instead of sorting a
 * whole session in memory. `substr(..., 1, 20000)` caps what one row can hand
 * us before `clipText` cuts it to the panel's per-message budget: a single tool
 * output in the wild is 400KB of build log, and the renderer does not need it.
 *
 * `synthetic` messages are ZCode's own scaffolding (todo reminders, background
 * notifications, system reminders) and are marked `transcriptVisibility:
 * hidden`; filtering them in SQL is exact and keeps 122 rows of noise out of a
 * 240-message window.
 */
const WINDOW_SQL = `select * from (
  select m.sequence mseq, p.sequence pseq,
         json_extract(m.data, '$.role') role,
         json_extract(p.data, '$.type') type,
         json_extract(p.data, '$.tool') tool,
         substr(json_extract(p.data, '$.text'), 1, 20000) text,
         substr(json_extract(p.data, '$.state.input'), 1, 20000) input,
         substr(coalesce(json_extract(p.data, '$.state.output'), json_extract(p.data, '$.state.error')), 1, 20000) output,
         coalesce(json_extract(p.data, '$.time.start'), m.time_created) at
  from part p join message m on m.id = p.message_id
  where m.session_id = ?
    and coalesce(json_extract(m.data, '$.synthetic'), 0) = 0
    and json_extract(p.data, '$.type') in ('text', 'reasoning', 'tool')
  order by m.sequence desc, p.sequence desc limit ?
) order by mseq asc, pseq asc`

/** Same predicate as the window, counting only: what `dropped` is made of. */
const COUNT_SQL = `select count(*) c from part p join message m on m.id = p.message_id
  where m.session_id = ?
    and coalesce(json_extract(m.data, '$.synthetic'), 0) = 0
    and json_extract(p.data, '$.type') in ('text', 'reasoning', 'tool')`

export interface ZcodeTranscript {
  messages: ChatMessage[]
  /** Chat parts left out at the head to respect `limit`. */
  dropped: number
  title: string
  cwd: string
  /** Newest mtime across the database and its `-wal`/`-shm` siblings. */
  mtimeMs: number
  bytes: number
  file: string
}

export function readZcodeTranscript(
  dbPath: string = zcodeDbFile,
  id: string = '',
  options: { limit?: number } = {}
): ZcodeTranscript | null {
  const wanted = String(id || '').trim()
  if (!wanted) return null
  const limit = Math.min(MAX_MESSAGE_LIMIT, Math.max(20, options.limit ?? DEFAULT_MESSAGE_LIMIT))
  const found = withDatabase(dbPath, (db) => {
    // The session row is read first: it settles which spelling of the id the
    // rest of the queries bind, and a session that is not there is a null.
    const session = sessionRow(db.prepare(SESSION_BY_ID_SQL).get(wanted, wanted, wanted))
    if (!session) return null
    const rows = db.prepare(WINDOW_SQL).all(session.id, limit)
    const messages: ChatMessage[] = []
    const prefix = `zcode-${tail(session.id)}`
    rows.forEach((row, index) => {
      const message = toMessage(row, `${prefix}-${index}`)
      if (message) messages.push(message)
    })
    // Only a full window can have left anything behind, so the count - the one
    // query that has to look at every part of the session - is skipped for the
    // short threads that are nearly all of them.
    const dropped =
      rows.length >= limit
        ? Math.max(0, Number(db.prepare(COUNT_SQL).get(session.id)?.c ?? 0) - messages.length)
        : 0
    return { session, messages, dropped }
  })
  if (!found) return null
  return {
    messages: found.messages,
    dropped: found.dropped,
    title: found.session.title,
    cwd: found.session.cwd,
    mtimeMs: databaseMtimeMs(dbPath),
    bytes: databaseBytes(dbPath),
    file: dbPath
  }
}

/** One window row -> one chat message, or null when it carries nothing to read. */
function toMessage(row: SqlRow, id: string): ChatMessage | null {
  const type = String(row.type ?? '')
  const at = Number(row.at ?? 0) || 0

  if (type === 'tool') {
    const input = row.input
    const output = String(row.output ?? '')
    const clipped = clipText(output)
    return {
      id,
      role: 'tool',
      tool: String(row.tool ?? '') || 'tool',
      text: summarizeArgs(input),
      command: toolCommand(input) || undefined,
      output: (clipped ?? output) || undefined,
      at,
      truncated: clipped ? true : undefined
    }
  }

  const text = String(row.text ?? '').trim()
  if (!text) return null
  if (type === 'reasoning') {
    const clipped = clipText(text)
    return { id, role: 'reasoning', text: clipped ?? text, at, truncated: clipped ? true : undefined }
  }
  if (type !== 'text') return null
  const role = String(row.role ?? '') === 'user' ? 'user' : 'assistant'
  // ZCode injects context rows under `role: "user"` exactly like Codex does;
  // drawing them as things a human said puts scaffolding mid-conversation.
  if (role === 'user' && isInjectedContext(text)) return null
  const clipped = clipText(text)
  return { id, role, text: clipped ?? text, at, truncated: clipped ? true : undefined }
}

/**
 * Freshness of the database.
 *
 * ZCode runs in WAL mode, so new parts land in `db.sqlite-wal` and the main
 * file's mtime does not move until a checkpoint. Reading the database also
 * touches `-shm`. Taking the newest of the three is what makes the chat view's
 * "is this thread still live" test answer correctly while an agent is working.
 */
export function databaseMtimeMs(dbPath: string): number {
  let newest = 0
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      newest = Math.max(newest, fs.statSync(candidate).mtimeMs)
    } catch {
      /* the sidecars only exist while a writer holds the database open */
    }
  }
  return newest
}

function databaseBytes(dbPath: string): number {
  let total = 0
  for (const candidate of [dbPath, `${dbPath}-wal`]) {
    try {
      total += fs.statSync(candidate).size
    } catch {
      /* ditto */
    }
  }
  return total
}

/** Last eight characters of a session id: enough to tell two threads apart. */
function tail(id: string): string {
  const clean = String(id || '').replace(/^sess_/, '')
  return clean.slice(-8) || 'session'
}

function shortPath(cwd: string): string {
  if (!cwd) return ''
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}
