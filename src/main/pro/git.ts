/**
 * Git facts for the bench tree: branch, dirty count, head, upstream.
 *
 * Two rules shape this file. First, **never block on git**: a tree row with a
 * stale branch is useful, a tree that waits 800 ms for `git status` on a network
 * checkout is not, so every read is cached with a TTL and every probe has a hard
 * timeout. Second, **never fight the agent for the index**: we pass
 * `--no-optional-locks` so a probe cannot take a lock a mid-commit agent needs.
 *
 * One `git status --porcelain=v2 --branch` call yields everything a row shows,
 * which is why the cache key is the directory rather than the field.
 */
import { execFile } from 'node:child_process'

export interface GitFacts {
  /** The directory the probe was asked about (not necessarily the repo root). */
  dir: string
  /** False for a directory that is not inside a work tree. */
  repo: boolean
  /** Absolute repo root; equals `dir` for a plain checkout. */
  repoRoot: string
  branch: string
  /** Full head sha, '' when unknown (empty repo, detached probe failure). */
  head: string
  /** Changed + untracked entries, clamped to DIRTY_MAX. */
  dirty: number
  upstream: string
  ahead: number
  behind: number
  /** True when the output was cut off by the buffer limit. */
  partial: boolean
  /** Epoch ms this reading was taken. */
  at: number
}

export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

export interface GitDeps {
  /** Injectable for tests: run `git` with args in cwd. */
  run?: (args: readonly string[], cwd: string) => Promise<GitRunResult>
  now?: () => number
  /** How long a status reading stays trustworthy. */
  ttlMs?: number
  /** Repo roots change only via re-clone, so they are cached much longer. */
  rootTtlMs?: number
  /** Negative results (`not a git repository`) are cached briefly: `git init`. */
  missTtlMs?: number
  timeoutMs?: number
  maxBuffer?: number
  /** Cap on concurrent git processes; the rest wait their turn. */
  concurrency?: number
}

export const NO_FACTS: Omit<GitFacts, 'dir' | 'at'> = {
  repo: false,
  repoRoot: '',
  branch: '',
  head: '',
  dirty: 0,
  upstream: '',
  ahead: 0,
  behind: 0,
  partial: false
}

const DEFAULT_TTL = 5000
const DEFAULT_ROOT_TTL = 300000
const DEFAULT_MISS_TTL = 30000
const DEFAULT_TIMEOUT = 4000
const DEFAULT_BUFFER = 8 * 1024 * 1024
const DEFAULT_CONCURRENCY = 4
/** A four-digit dirty count is already "this task is a mess"; no need to count on. */
export const DIRTY_MAX = 9999

const NOT_A_REPO = /not a git repository|fatal: not a git/i

/** Strip a trailing slash so `/a/b/` and `/a/b` share one cache entry. */
function dirKey(dir: string): string {
  return String(dir || '').replace(/[\\/]+$/, '')
}

interface CacheRow {
  facts: GitFacts
  expiresAt: number
}

export function runGit(
  args: readonly string[],
  cwd: string,
  options: { timeoutMs: number; maxBuffer: number }
): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        windowsHide: true,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : ''
        const err = typeof stderr === 'string' ? stderr : ''
        if (!error) {
          resolve({ code: 0, stdout: out, stderr: err })
          return
        }
        // execFile reports the exit status in `code` as a number, and a spawn
        // failure (ENOENT, ETIMEDOUT) as a string. A non-zero exit still carries
        // usable output, so only a spawn failure is a hard error.
        const code = (error as NodeJS.ErrnoException & { code?: number | string }).code
        if (typeof code === 'number') {
          resolve({ code, stdout: out, stderr: err })
          return
        }
        reject(error)
      }
    )
  })
}

/**
 * Parse `git status --porcelain=v2 --branch`. v2 is the machine format: the
 * header carries branch/upstream/ahead-behind and every following line is one
 * entry, so counting dirty files is a prefix test rather than a column parse.
 */
export function parseStatus(dir: string, stdout: string, at: number, partial = false): GitFacts {
  const facts: GitFacts = { dir, at, ...NO_FACTS, partial, repo: true }
  let dirty = 0
  for (const line of String(stdout || '').split('\n')) {
    if (line.startsWith('# branch.oid ')) {
      const sha = line.slice(13).trim()
      // `(initial)` on a repo with no commit yet.
      facts.head = /^[0-9a-f]{7,40}$/i.test(sha) ? sha : ''
    } else if (line.startsWith('# branch.head ')) {
      const name = line.slice(14).trim()
      facts.branch = name === '(detached)' ? '' : name
    } else if (line.startsWith('# branch.upstream ')) {
      facts.upstream = line.slice(18).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+)\s+-(\d+)/.exec(line.slice(12))
      if (match) {
        facts.ahead = Number(match[1]) || 0
        facts.behind = Number(match[2]) || 0
      }
    } else if (line.length > 2 && (line[0] === '1' || line[0] === '2' || line[0] === 'u' || line[0] === '?')) {
      // `!` (ignored) is deliberately not dirty: an agent's build output is not
      // a change the human has to think about.
      if (line[1] === ' ') dirty += 1
    }
    if (dirty >= DIRTY_MAX) break
  }
  facts.dirty = Math.min(dirty, DIRTY_MAX)
  if (!facts.branch && facts.head) facts.branch = facts.head.slice(0, 7)
  return facts
}

/**
 * Live git state for the bench. Caching is per directory and shared between
 * callers, because a repo with five task panes is still one `git status`.
 */
export class GitProbe {
  private readonly run: (args: readonly string[], cwd: string) => Promise<GitRunResult>
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly rootTtlMs: number
  private readonly missTtlMs: number
  private readonly concurrency: number

  private readonly cache = new Map<string, CacheRow>()
  private readonly roots = new Map<string, { root: string; expiresAt: number }>()
  private readonly inflight = new Map<string, Promise<GitFacts | null>>()
  private running = 0
  private readonly waiters: Array<() => void> = []

  constructor(deps: GitDeps = {}) {
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT
    const maxBuffer = deps.maxBuffer ?? DEFAULT_BUFFER
    this.run = deps.run ?? ((args, cwd) => runGit(args, cwd, { timeoutMs, maxBuffer }))
    this.now = deps.now ?? (() => Date.now())
    this.ttlMs = Math.max(250, deps.ttlMs ?? DEFAULT_TTL)
    this.rootTtlMs = Math.max(1000, deps.rootTtlMs ?? DEFAULT_ROOT_TTL)
    this.missTtlMs = Math.max(1000, deps.missTtlMs ?? DEFAULT_MISS_TTL)
    this.concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY)
  }

  /**
   * Read facts for a directory. Returns null only when git itself is missing or
   * the probe threw; a plain non-repo directory returns `repo: false`, which is
   * a fact the tree renders as "no branch" rather than as an error.
   */
  async facts(dir: string, force = false): Promise<GitFacts | null> {
    const key = dirKey(dir)
    if (!key) return null
    const at = this.now()
    const hit = this.cache.get(key)
    if (!force && hit && hit.expiresAt > at) return hit.facts
    const pending = this.inflight.get(key)
    if (pending) return pending
    const task = this.read(key, at)
      .then((facts) => {
        if (facts) {
          const ttl = facts.repo ? this.ttlMs : this.missTtlMs
          this.cache.set(key, { facts, expiresAt: this.now() + ttl })
        }
        return facts
      })
      .finally(() => {
        this.inflight.delete(key)
      })
    this.inflight.set(key, task)
    return task
  }

  /** Repo root for a directory, cached long: it only changes on re-clone. */
  async repoRoot(dir: string, force = false): Promise<string> {
    const key = dirKey(dir)
    if (!key) return ''
    const at = this.now()
    const hit = this.roots.get(key)
    if (!force && hit && hit.expiresAt > at) return hit.root
    await this.acquire()
    try {
      return await this.readRoot(key)
    } finally {
      this.release()
    }
  }

  /** Root lookup without taking a slot: callers inside `read` already hold one. */
  private async readRoot(key: string): Promise<string> {
    let root = ''
    try {
      const result = await this.run(['-C', key, 'rev-parse', '--show-toplevel'], key)
      if (result.code === 0) root = normalizeRoot(result.stdout)
    } catch {
      root = ''
    }
    this.roots.set(key, { root, expiresAt: this.now() + (root ? this.rootTtlMs : this.missTtlMs) })
    return root
  }

  /** Drop cached facts, e.g. right after a hook reports a commit. */
  invalidate(dir?: string): void {
    if (!dir) {
      this.cache.clear()
      this.roots.clear()
      return
    }
    const key = dirKey(dir)
    this.cache.delete(key)
    this.roots.delete(key)
  }

  /** Synchronous peek at the cache; the renderer never waits on this. */
  peek(dir: string): GitFacts | null {
    const row = this.cache.get(dirKey(dir))
    return row ? row.facts : null
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private async read(key: string, at: number): Promise<GitFacts | null> {
    await this.acquire()
    try {
      const result = await this.run(
        ['-C', key, '--no-optional-locks', 'status', '--porcelain=v2', '--branch'],
        key
      )
      if (result.code !== 0) {
        if (NOT_A_REPO.test(result.stderr) || NOT_A_REPO.test(result.stdout)) {
          return { dir: key, at: this.now(), ...NO_FACTS }
        }
        // Timeout, permission denied, corrupt index: keep whatever we had.
        return this.cache.get(key)?.facts ?? { dir: key, at: this.now(), ...NO_FACTS }
      }
      const facts = parseStatus(key, result.stdout, at, false)
      facts.repoRoot = (await this.readRoot(key)) || key
      return facts
    } catch {
      // git is not installed. Report "unknown", never an exception: a missing
      // optional tool must not be able to break the tree.
      return { dir: key, at: this.now(), ...NO_FACTS }
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.running += 1
        resolve()
      })
    })
  }

  private release(): void {
    this.running = Math.max(0, this.running - 1)
    const next = this.waiters.shift()
    if (next) next()
  }
}

function normalizeRoot(stdout: string): string {
  const line = String(stdout || '')
    .split('\n')
    .map((entry) => entry.trim())
    .find(Boolean)
  return dirKey(line || '')
}

/**
 * A branch name an agent will not choke on: lowercase, ASCII, slashes allowed
 * only as separators. Used by the "new worktree" verb, where a typo would
 * otherwise leave a task pointing at a directory herdr never created.
 */
export function suggestBranch(text: string, prefix = 'cw'): string {
  const slug = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const base = slug || `task-${Date.now().toString(36)}`
  const head = String(prefix || '').replace(/[^a-z0-9-]/gi, '').toLowerCase()
  return head ? `${head}/${base}` : base
}
