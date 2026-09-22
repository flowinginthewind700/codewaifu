import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  normalizeMessages,
  parseJsonl,
  type ChatMessage,
  type ChatTranscript
} from '../shared/chat'
import type { Agent } from '../shared/protocol'
import { claudeProjectsDir, codexSessionsDir, zcodeDbFile } from './env'
import { log } from './log'
import { readZcodeTranscript } from './zcodeDb'

// ============================================================
// Read-only transcript access.
//
// Transcripts grow for the lifetime of a session and reach tens of MB, so this
// never loads one whole file into memory after the first read: the initial pass
// takes the last `FIRST_READ_BYTES`, and every refresh reads only the bytes
// appended since then. Tailing is done at the byte level (not the character
// level) for two reasons — an offset can land in the middle of a UTF-8
// sequence, and the last line is usually half-written while the agent runs.
// ============================================================

/** Initial read window. 4MB of JSONL is thousands of turns. */
const FIRST_READ_BYTES = 4 * 1024 * 1024
/** Extra window per requested message when "load older" asks for history. */
const BYTES_PER_MESSAGE = 8 * 1024
/** Per-refresh cap, so a pathological burst cannot allocate unbounded. */
const MAX_APPEND_BYTES = 8 * 1024 * 1024
/** How many tails to keep; one per thread the user has opened recently. */
const MAX_TAILS = 8

interface Tail {
  file: string
  /** Bytes consumed so far, always at a line boundary. */
  consumed: number
  rows: ReturnType<typeof parseJsonl>
  touchedAt: number
}

const tails = new Map<string, Tail>()
const fileCache = new Map<string, { file: string | null; at: number }>()
const FILE_CACHE_MS = 5000

/** Locate the transcript file for a session id. Cached briefly: it never moves. */
export function transcriptFile(agent: Agent, threadId: string): string | null {
  const id = String(threadId || '').trim()
  if (!id || !/^[0-9a-fA-F-]{8,64}$/.test(id)) return null
  // Only codex and claude write JSONL we know how to find. Without this guard a
  // named agent such as `kimi` would fall through to the codex rollout walk and
  // match some unrelated session file by id.
  if (agent !== 'codex' && agent !== 'claude') return null
  const key = `${agent}:${id}`
  const hit = fileCache.get(key)
  if (hit && Date.now() - hit.at < FILE_CACHE_MS) return hit.file
  const file = agent === 'claude' ? findClaudeTranscript(id) : findCodexRollout(id)
  if (fileCache.size > 64) fileCache.clear()
  fileCache.set(key, { file, at: Date.now() })
  return file
}

/**
 * Codex lays rollouts out as `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`.
 * Walk the date directories newest-first and stop at the first filename match:
 * a session you are looking at is almost always in the most recent day, and
 * this avoids stat-ing a year of history.
 */
export function findCodexRollout(id: string, root: string = codexSessionsDir): string | null {
  const suffix = `-${id}.jsonl`
  for (const year of listDirsDesc(root)) {
    for (const month of listDirsDesc(path.join(root, year))) {
      // `root/year/month`, not `root/month`: Codex nests rollouts three levels
      // deep, and dropping the year yields no day directories at all, so every
      // Codex thread reported "no transcript file" in the chat view.
      for (const day of listDirsDesc(path.join(root, year, month))) {
        const dir = path.join(root, year, month, day)
        for (const name of listFiles(dir)) {
          if (name.startsWith('rollout-') && name.endsWith(suffix)) return path.join(dir, name)
        }
      }
    }
  }
  return null
}

/** Claude keeps one directory per project, `<uuid>.jsonl` inside it. */
export function findClaudeTranscript(id: string, root: string = claudeProjectsDir): string | null {
  const name = `${id}.jsonl`
  for (const project of listFiles(root, true)) {
    const candidate = path.join(root, project, name)
    if (isFile(candidate)) return candidate
  }
  return null
}

function listDirsDesc(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

function listFiles(dir: string, dirs: boolean = false): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (dirs ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

export interface ReadOptions {
  /** Message window; "load older" asks for a bigger one. */
  limit?: number
  /** Ignore the tail cache and re-read from scratch. */
  fresh?: boolean
}

/**
 * Read (and incrementally extend) the chat transcript for one thread.
 * Returns `null` when the session has no transcript on disk — e.g. a live
 * Codex thread whose rollout has not been flushed yet.
 */
export function readTranscript(agent: Agent, threadId: string, options: ReadOptions = {}): ChatTranscript | null {
  // ZCode keeps no JSONL file: its history is one SQLite database, so the
  // byte-range tail below has nothing to tail. Its reader windows the query
  // instead, and answers the same shape.
  if (agent === 'zcode') {
    const found = readZcodeTranscript(zcodeDbFile, threadId, { limit: options.limit })
    if (!found) return null
    return {
      key: `zcode:${threadId}`,
      agent: 'zcode',
      id: threadId,
      title: found.title,
      cwd: found.cwd,
      file: found.file,
      messages: found.messages,
      dropped: found.dropped,
      mtimeMs: found.mtimeMs,
      bytes: found.bytes,
      // No injection API, so the composer's steer falls back to the clipboard.
      steerable: false
    }
  }

  const file = transcriptFile(agent, threadId)
  if (!file) return null
  const key = `${agent}:${threadId}`
  const limit = Math.min(MAX_MESSAGE_LIMIT, Math.max(20, options.limit ?? DEFAULT_MESSAGE_LIMIT))

  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    tails.delete(key)
    return null
  }

  let tail = options.fresh ? null : tails.get(key)
  // A shrink means the file was rotated or truncated; start over.
  if (tail && (tail.file !== file || tail.consumed > stat.size)) tail = null
  // A bigger window cannot be satisfied by an append-only tail.
  if (tail && limit > tail.rows.length && tail.consumed > 0) tail = null

  try {
    if (!tail) {
      // "Load older" widens the window instead of re-reading the same tail.
      const window = Math.min(stat.size, Math.max(FIRST_READ_BYTES, limit * BYTES_PER_MESSAGE))
      const start = Math.max(0, stat.size - window)
      const chunk = readSlice(file, start, stat.size)
      tail = {
        file,
        consumed: endOfCompleteLines(chunk, start),
        rows: parseJsonl(decodeCompleteLines(chunk, start > 0)),
        touchedAt: Date.now()
      }
    } else if (stat.size > tail.consumed) {
      const end = Math.min(stat.size, tail.consumed + MAX_APPEND_BYTES)
      const chunk = readSlice(file, tail.consumed, end)
      const consumed = endOfCompleteLines(chunk, tail.consumed)
      const added = parseJsonl(decodeCompleteLines(chunk, false))
      tail = { file, consumed, rows: [...tail.rows, ...added], touchedAt: Date.now() }
    } else {
      tail.touchedAt = Date.now()
    }
  } catch (error) {
    log('warn', 'transcript read failed', String(error))
    return null
  }

  pruneTails(key, tail)
  const normalized = normalizeMessages({ agent, rows: tail.rows, limit })
  return {
    key,
    agent,
    id: threadId,
    title: '',
    cwd: cwdOf(tail.rows),
    file,
    messages: normalized.messages,
    dropped: normalized.dropped,
    mtimeMs: stat.mtimeMs,
    bytes: stat.size,
    steerable: agent === 'codex'
  }
}

function pruneTails(currentKey: string, tail: Tail): void {
  tails.set(currentKey, tail)
  if (tails.size <= MAX_TAILS) return
  const oldest = [...tails.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)
  for (const [key] of oldest.slice(0, tails.size - MAX_TAILS)) tails.delete(key)
}

function readSlice(file: string, start: number, end: number): Buffer {
  const length = Math.max(0, end - start)
  if (length === 0) return Buffer.alloc(0)
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(length)
    const bytes = fs.readSync(fd, buffer, 0, length, start)
    return buffer.subarray(0, Math.max(0, bytes))
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

/** Byte offset just past the final `\n`, so a torn last line is re-read later. */
function endOfCompleteLines(chunk: Buffer, start: number): number {
  const lastBreak = chunk.lastIndexOf(0x0a)
  return lastBreak < 0 ? start : start + lastBreak + 1
}

/**
 * Decode only the complete lines of a slice.
 *
 * When `skipPartialHead` is set the read started mid-file, so everything before
 * the first newline is the tail of a line we never saw the beginning of.
 */
function decodeCompleteLines(chunk: Buffer, skipPartialHead: boolean): string {
  if (chunk.byteLength === 0) return ''
  const lastBreak = chunk.lastIndexOf(0x0a)
  if (lastBreak < 0) return ''
  let from = 0
  if (skipPartialHead) {
    const firstBreak = chunk.indexOf(0x0a)
    // A slice that starts exactly on a line boundary has no partial head.
    from = firstBreak >= 0 && firstBreak < chunk.byteLength - 1 ? firstBreak + 1 : 0
  }
  return chunk.subarray(from, lastBreak + 1).toString('utf8')
}

/** The working directory recorded in the transcript header, if any. */
function cwdOf(rows: ReturnType<typeof parseJsonl>): string {
  for (const row of rows) {
    const direct = row.cwd
    if (typeof direct === 'string' && direct) return direct
    const payload = row.payload as Record<string, unknown> | undefined
    const nested = payload?.cwd
    if (typeof nested === 'string' && nested) return nested
  }
  return ''
}

/** Forget every tail (used by tests and by `codewaifu reset`). */
export function clearTranscriptCache(): void {
  tails.clear()
  fileCache.clear()
}

/** Messages already parsed for a thread, without touching the disk again. */
export function cachedMessages(agent: Agent, threadId: string): ChatMessage[] | null {
  const tail = tails.get(`${agent}:${threadId}`)
  if (!tail) return null
  return normalizeMessages({ agent, rows: tail.rows }).messages
}
