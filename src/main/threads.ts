import fs from 'node:fs'
import path from 'node:path'
import type { Agent, EventKind, HookEvent, ThreadInfo } from '../shared/protocol'
import { toSpeakable } from '../shared/lang'
import { claudeProjectsDir, codexSessionIndex, codexSessionsDir } from './env'
import { log } from './log'

const MAX_PER_AGENT = 40
const CACHE_MS = 2500
const HEAD_BYTES = 96 * 1024

interface LiveSession {
  agent: Agent
  sessionId: string
  cwd: string
  title: string
  at: number
  lastKind: EventKind
  lastDetail: string
}

/**
 * Neither agent exposes a "list running threads" API we can poll cheaply, so
 * the list is assembled from three sources: live hook events (authoritative for
 * "running right now"), Codex's session index + rollout files, and Claude Code's
 * per-project transcript files.
 */
export class ThreadTracker {
  private live = new Map<string, LiveSession>()
  private cache: { at: number; threads: ThreadInfo[] } | null = null

  record(event: HookEvent): void {
    if (!event.sessionId || event.agent === 'unknown') return
    const key = `${event.agent}:${event.sessionId}`
    const previous = this.live.get(key)
    this.live.set(key, {
      agent: event.agent,
      sessionId: event.sessionId,
      cwd: event.cwd || previous?.cwd || '',
      title: previous?.title || '',
      at: event.at,
      lastKind: event.kind,
      lastDetail: event.detail || event.title
    })
    this.cache = null
    // Keep only the sessions that plausibly matter for the picker.
    if (this.live.size > 60) {
      const oldest = [...this.live.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, this.live.size - 60)
      for (const [key2] of oldest) this.live.delete(key2)
    }
  }

  forget(sessionId: string): void {
    for (const [key, value] of this.live) {
      if (value.sessionId === sessionId) this.live.delete(key)
    }
    this.cache = null
  }

  liveSessions(): LiveSession[] {
    return [...this.live.values()].sort((a, b) => b.at - a.at)
  }

  /**
   * Look one thread up without triggering a scan: the chat view polls this on
   * every refresh, and re-walking both agents' session trees 2x/second would
   * cost more than the transcript read itself. Falls back to the live map, so
   * a thread that has not been listed yet still resolves.
   */
  peek(agent: Agent, sessionId: string): ThreadInfo | null {
    const key = `${agent}:${sessionId}`
    const cached = this.cache?.threads.find((thread) => thread.key === key)
    if (cached) return cached
    const session = this.live.get(key)
    if (!session) return null
    return {
      key,
      agent: session.agent,
      id: session.sessionId,
      title: session.title || shortPath(session.cwd) || session.sessionId.slice(0, 8),
      cwd: session.cwd,
      updatedAt: session.at,
      live: true,
      lastKind: session.lastKind,
      lastDetail: session.lastDetail,
      steerable: session.agent === 'codex'
    }
  }

  async list(): Promise<ThreadInfo[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.threads
    const [codex, claude] = await Promise.all([safe(() => codexThreads(), []), safe(() => claudeThreads(), [])])
    const byKey = new Map<string, ThreadInfo>()
    for (const thread of [...codex, ...claude]) byKey.set(thread.key, thread)

    for (const session of this.live.values()) {
      const key = `${session.agent}:${session.sessionId}`
      const base = byKey.get(key)
      byKey.set(key, {
        key,
        agent: session.agent,
        id: session.sessionId,
        title: base?.title || session.title || shortPath(session.cwd) || session.sessionId.slice(0, 8),
        cwd: session.cwd || base?.cwd || '',
        updatedAt: Math.max(session.at, base?.updatedAt || 0),
        live: true,
        lastKind: session.lastKind,
        lastDetail: session.lastDetail,
        steerable: session.agent === 'codex'
      })
    }

    const threads = [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PER_AGENT * 2)
    this.cache = { at: Date.now(), threads }
    return threads
  }
}

async function safe<T>(fn: () => T | Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    log('warn', 'thread scan failed', String(error))
    return fallback
  }
}

function shortPath(cwd: string): string {
  if (!cwd) return ''
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

function newestFiles(dir: string, pattern: RegExp, depth: number): Array<{ file: string; mtimeMs: number }> {
  const out: Array<{ file: string; mtimeMs: number }> = []
  const walk = (current: string, level: number): void => {
    if (level > depth) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full, level + 1)
        continue
      }
      if (!pattern.test(entry.name)) continue
      try {
        out.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs })
      } catch {
        /* vanished mid-scan */
      }
    }
  }
  walk(dir, 0)
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function readHead(file: string): string {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(HEAD_BYTES)
    const bytes = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, Math.max(0, bytes)).toString('utf8')
  } catch {
    return ''
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

function codexThreads(): ThreadInfo[] {
  const names = new Map<string, { title: string; updatedAt: number }>()
  try {
    const text = fs.readFileSync(codexSessionIndex, 'utf8')
    const lines = text.split(/\r?\n/).filter(Boolean)
    // Later lines are renames of the same thread; last write wins.
    for (const line of lines.slice(-600)) {
      try {
        const row = JSON.parse(line) as { id?: string; thread_name?: string; updated_at?: string }
        if (!row.id) continue
        const at = row.updated_at ? Date.parse(row.updated_at) : NaN
        names.set(row.id, {
          title: String(row.thread_name || ''),
          updatedAt: Number.isFinite(at) ? at : 0
        })
      } catch {
        /* a torn last line is normal while Codex is writing */
      }
    }
  } catch {
    /* no index yet */
  }

  const rollouts = newestFiles(codexSessionsDir, /^rollout-.*\.jsonl$/, 4).slice(0, MAX_PER_AGENT)
  const found = new Map<string, ThreadInfo>()
  for (const { file, mtimeMs } of rollouts) {
    const idFromName = /rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
      path.basename(file)
    )
    const head = readHead(file)
    let id = idFromName ? idFromName[1] : ''
    let cwd = ''
    for (const line of head.split(/\r?\n/).slice(0, 6)) {
      if (!line.includes('session_meta')) continue
      try {
        const row = JSON.parse(line) as { payload?: { id?: string; cwd?: string } }
        id = row.payload?.id || id
        cwd = row.payload?.cwd || cwd
      } catch {
        /* ignore */
      }
      break
    }
    if (!id) continue
    const indexed = names.get(id)
    found.set(id, {
      key: `codex:${id}`,
      agent: 'codex',
      id,
      title: indexed?.title || shortPath(cwd) || id.slice(0, 8),
      cwd,
      updatedAt: Math.max(indexed?.updatedAt || 0, mtimeMs),
      live: false,
      lastKind: '',
      lastDetail: '',
      steerable: true
    })
  }

  // Threads renamed but rolled off the retention window still deserve a slot.
  for (const [id, value] of names) {
    if (found.has(id)) continue
    if (!value.title) continue
    found.set(id, {
      key: `codex:${id}`,
      agent: 'codex',
      id,
      title: value.title,
      cwd: '',
      updatedAt: value.updatedAt,
      live: false,
      lastKind: '',
      lastDetail: '',
      steerable: true
    })
  }
  return [...found.values()]
}

function claudeThreads(): ThreadInfo[] {
  const files = newestFiles(claudeProjectsDir, /^[0-9a-f-]{36}\.jsonl$/i, 2).slice(0, MAX_PER_AGENT)
  const out: ThreadInfo[] = []
  for (const { file, mtimeMs } of files) {
    const id = path.basename(file, '.jsonl')
    const projectDir = path.basename(path.dirname(file))
    let cwd = decodeClaudeProjectDir(projectDir)
    let title = ''
    for (const line of readHead(file).split(/\r?\n/)) {
      if (!line) continue
      let row: Record<string, unknown>
      try {
        row = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (!cwd && typeof row.cwd === 'string') cwd = row.cwd
      if (typeof row.summary === 'string' && row.summary) {
        title = row.summary
        break
      }
      if (!title && row.type === 'user') {
        const text = firstUserText(row)
        if (text) title = text
      }
    }
    out.push({
      key: `claude:${id}`,
      agent: 'claude',
      id,
      title: toSpeakable(title || shortPath(cwd) || id.slice(0, 8), 60),
      cwd,
      updatedAt: mtimeMs,
      live: false,
      lastKind: '',
      lastDetail: '',
      // Claude Code has no injection API; steering falls back to the clipboard.
      steerable: false
    })
  }
  return out
}

function firstUserText(row: Record<string, unknown>): string {
  const message = row.message as { content?: unknown } | undefined
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
        const text = (part as { text?: string }).text
        if (typeof text === 'string') return text
      }
    }
  }
  return ''
}

/**
 * Claude encodes the project path by replacing `/` with `-`. The mapping is
 * lossy for directories that already contain dashes, so treat the result as a
 * hint and prefer the `cwd` field from inside the transcript.
 */
export function decodeClaudeProjectDir(name: string): string {
  if (!name.startsWith('-')) return name
  return name.replace(/-/g, '/')
}
