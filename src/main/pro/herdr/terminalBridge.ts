/**
 * One pane's pixels, rented from herdr.
 *
 * `herdr terminal session control <pane>` is a child process speaking NDJSON:
 * base64 ANSI frames out, input/resize/scroll/release in. This file owns that
 * child and nothing else — it does not render, and it does not interpret ANSI.
 *
 * Two rules from the MVP matter here:
 *
 * - **Frames are dropped, never queued without bound.** A busy `npm test` can
 *   emit thousands of repaints a second. If the renderer falls behind we drop
 *   the oldest frames and mark the stream as needing a resync, because a
 *   terminal that keeps a backlog replays history at the user forever.
 * - **A resync is a respawn.** A fresh control connection always opens with a
 *   full repaint, so respawning the child is the cheapest correct way to get
 *   back to a known screen. The same path handles the child dying for any
 *   other reason, which is why the bench survives a hiccup without a reload.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { encodeTerminalCommand, parseTerminalMessage, type TerminalCommand, type TerminalFrame } from '../../../shared/herdr'
import { LineDecoder } from './ndjson'

/** The slice of `ChildProcess` this file uses; a fake satisfies it in tests. */
export interface BridgeChild extends EventEmitter {
  stdin: { write(chunk: string): boolean; end(): void } | null
  stdout: { setEncoding?(encoding: string): void; on(event: string, cb: (chunk: unknown) => void): void } | null
  stderr: { setEncoding?(encoding: string): void; on(event: string, cb: (chunk: unknown) => void): void } | null
  kill(signal?: NodeJS.Signals | number): boolean
  readonly pid?: number
}

export type SpawnFn = (
  binary: string,
  args: readonly string[],
  options: { env?: Record<string, string> }
) => BridgeChild

export type BridgePhase = 'idle' | 'starting' | 'live' | 'respawning' | 'closed' | 'error'

export interface BridgeState {
  paneId: string
  phase: BridgePhase
  live: boolean
  cols: number
  rows: number
  frames: number
  /** Frames dropped because the consumer fell behind. */
  dropped: number
  /** Highest seq seen; 0 until the first frame arrives. */
  seq: number
  /** True when a gap means the screen must be repainted from scratch. */
  needsResync: boolean
  respawns: number
  error: string
}

/** A frame as it crosses IPC: still base64, so main never decodes ANSI. */
export interface WireFrame {
  paneId: string
  seq: number
  full: boolean
  width: number
  height: number
  bytes: string
}

export interface BridgeTimer {
  cancel: () => void
}

export interface BridgeTimers {
  after(cb: () => void, ms: number): BridgeTimer
  now(): number
}

export const realBridgeTimers: BridgeTimers = {
  after(cb, ms) {
    const handle = setTimeout(cb, ms)
    return { cancel: () => clearTimeout(handle) }
  },
  now: () => Date.now()
}

export interface BridgeOptions {
  /** herdr's target for the control connection; normally the pane id. */
  target: string
  binaryPath: string
  /** Env that points the child at the same server we talk to. */
  env?: Record<string, string>
  cols?: number
  rows?: number
  /** Take the terminal over from another attached client (herdr's own TUI). */
  takeover?: boolean
  /** Bounded frame queue; oldest frames go first. */
  maxFrames?: number
  respawnDelayMs?: number
  killGraceMs?: number
  spawn?: SpawnFn
  timers?: BridgeTimers
}

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40
const DEFAULT_MAX_FRAMES = 512
const STDERR_LIMIT = 4096

/** herdr says this when another client already holds the control connection. */
const BUSY = /already|attached|busy|in use|taken/i

/** Ceiling on the doubling, so a bad minute cannot park a pane for minutes. */
const MAX_BACKOFF_STEPS = 4

/**
 * How long to wait before replacing the control connection again.
 *
 * A resync costs a full repaint, so respawning on a fixed interval while the
 * renderer is still behind makes the overload worse: every attempt adds the
 * largest frame of all to a queue that is already overflowing. Doubling to a
 * ceiling gives a slow consumer room to catch up without ever parking a pane
 * that would have recovered by itself.
 */
export function respawnBackoff(streak: number, baseMs: number): number {
  const steps = Math.max(0, Math.min(MAX_BACKOFF_STEPS, Math.trunc(streak)))
  return Math.max(0, baseMs) * 2 ** steps
}

function defaultSpawn(binary: string, args: readonly string[], options: { env?: Record<string, string> }): BridgeChild {
  return nodeSpawn(binary, [...args], {
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe']
  }) as unknown as BridgeChild
}

export class TerminalBridge {
  private readonly target: string
  private readonly binaryPath: string
  private readonly env: Record<string, string>
  private readonly maxFrames: number
  private readonly respawnDelayMs: number
  private readonly killGraceMs: number
  private readonly spawnFn: SpawnFn
  private readonly timers: BridgeTimers
  private readonly queue: TerminalFrame[] = []
  private readonly listeners = new Set<(state: BridgeState) => void>()

  private child: BridgeChild | null = null
  private decoder = new LineDecoder()
  private phase: BridgePhase = 'idle'
  private cols: number
  private rows: number
  private takeover: boolean
  private closing = false
  private respawning = false
  private retriedTakeover = false
  private respawnTimer: BridgeTimer | null = null
  private killTimer: BridgeTimer | null = null
  private frameCount = 0
  private droppedCount = 0
  private lastSeq = 0
  private resync = false
  private respawnCount = 0
  /** Consecutive resyncs that each found new drops: the backoff input. */
  private respawnStreak = 0
  private droppedAtRespawn = 0
  /** Consecutive control processes that could not be started at all. */
  private spawnFailStreak = 0
  /** True while the current connection died before it ever started. */
  private spawnFailed = false
  private errorText = ''
  private stderrTail = ''

  constructor(options: BridgeOptions) {
    this.target = options.target
    this.binaryPath = options.binaryPath
    this.env = options.env ?? {}
    this.cols = Math.max(1, Math.trunc(options.cols ?? DEFAULT_COLS))
    this.rows = Math.max(1, Math.trunc(options.rows ?? DEFAULT_ROWS))
    this.takeover = options.takeover ?? false
    this.maxFrames = Math.max(8, Math.trunc(options.maxFrames ?? DEFAULT_MAX_FRAMES))
    this.respawnDelayMs = options.respawnDelayMs ?? 250
    this.killGraceMs = options.killGraceMs ?? 500
    this.spawnFn = options.spawn ?? defaultSpawn
    this.timers = options.timers ?? realBridgeTimers
  }

  get paneId(): string {
    return this.target
  }

  get live(): boolean {
    return this.phase === 'live'
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows }
  }

  status(): BridgeState {
    return {
      paneId: this.target,
      phase: this.phase,
      live: this.live,
      cols: this.cols,
      rows: this.rows,
      frames: this.frameCount,
      dropped: this.droppedCount,
      seq: this.lastSeq,
      needsResync: this.resync,
      respawns: this.respawnCount,
      error: this.errorText
    }
  }

  onState(listener: (state: BridgeState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Spawn the control process. Idempotent: a live bridge is left alone. */
  open(takeover?: boolean): void {
    if (takeover !== undefined) this.takeover = takeover
    if (this.closing) return
    if (this.child) return
    this.spawnChild()
  }

  /** Drain pending frames. The consumer renders them in order. */
  take(): WireFrame[] {
    if (!this.queue.length) return []
    const out = this.queue.splice(0, this.queue.length).map((frame) => ({
      paneId: this.target,
      seq: frame.seq,
      full: frame.full,
      width: frame.width,
      height: frame.height,
      bytes: frame.bytesB64
    }))
    return out
  }

  send(command: TerminalCommand): boolean {
    const child = this.child
    if (!child?.stdin) return false
    try {
      return child.stdin.write(`${encodeTerminalCommand(command)}\n`)
    } catch {
      return false
    }
  }

  input(text: string): boolean {
    if (!text) return false
    return this.send({ type: 'terminal.input', text })
  }

  /**
   * Resize the remote terminal. herdr answers with a full repaint, so this is
   * also the manual "redraw the pane" lever.
   */
  resize(cols: number, rows: number): boolean {
    const nextCols = Math.max(1, Math.trunc(cols))
    const nextRows = Math.max(1, Math.trunc(rows))
    if (nextCols === this.cols && nextRows === this.rows) return false
    this.cols = nextCols
    this.rows = nextRows
    return this.send({ type: 'terminal.resize', cols: nextCols, rows: nextRows })
  }

  scroll(direction: 'up' | 'down', lines = 3, source: 'wheel' | 'page_key' = 'wheel'): boolean {
    return this.send({ type: 'terminal.scroll', direction, lines: Math.max(1, Math.trunc(lines)), source })
  }

  /** Force a full repaint by replacing the control connection. */
  requestResync(delayMs = this.respawnDelayMs): void {
    this.resync = true
    this.scheduleRespawn(delayMs)
    this.emitState()
  }

  /**
   * Detach. herdr keeps the PTY and the process: closing a bench window must
   * never kill anybody's build. `terminal.release` tells the server we are
   * done politely; SIGTERM is the belt-and-braces follow-up.
   */
  close(): void {
    if (this.closing) return
    this.closing = true
    this.respawnTimer?.cancel()
    this.respawnTimer = null
    this.send({ type: 'terminal.release' })
    const child = this.child
    this.child = null
    this.queue.length = 0
    if (!child) {
      this.setPhase('closed')
      return
    }
    try {
      child.stdin?.end()
    } catch {
      /* already gone */
    }
    this.killTimer = this.timers.after(() => {
      this.killTimer = null
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }, this.killGraceMs)
    this.setPhase('closed')
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private spawnChild(): void {
    const args = [
      'terminal',
      'session',
      'control',
      this.target,
      '--cols',
      String(this.cols),
      '--rows',
      String(this.rows)
    ]
    if (this.takeover) args.push('--takeover')
    let child: BridgeChild
    try {
      child = this.spawnFn(this.binaryPath, args, { env: this.env })
    } catch (error) {
      this.errorText = error instanceof Error ? error.message : String(error)
      this.setPhase('error')
      return
    }
    this.child = child
    this.decoder = new LineDecoder()
    this.stderrTail = ''
    this.spawnFailed = false
    // herdr numbers frames per connection, so this counter belongs to the
    // connection and has to die with it. Left at the previous high value, every
    // frame of the new connection reads as a backwards seq: the opening full
    // repaint clears the flag once, the very next frame re-arms it, and the
    // bridge respawns itself forever at four a second - for as long as the pane
    // keeps printing, which is exactly when it was already falling behind.
    this.lastSeq = 0
    this.setPhase('starting')

    child.stdout?.on('data', (chunk: unknown) => this.onStdout(chunk))
    child.stderr?.on('data', (chunk: unknown) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
      if (!text) return
      this.stderrTail = `${this.stderrTail}${text}`.slice(-STDERR_LIMIT)
    })
    // Ignore the exit of a child we replaced on purpose: an intentional respawn
    // must not look like a crash and schedule a second one.
    let exited = false
    child.on('exit', (code: unknown, signal: unknown) => {
      exited = true
      if (this.child === child) this.onExit(code, signal)
    })
    // A spawn that could not happen never sends `exit`: Node emits `error`
    // (ENOENT, EACCES) and then `close`, and that is all. Listening for `exit`
    // alone left the pane parked on "Attaching..." forever - no message, no
    // retry, and no way out except reloading the window.
    child.on('close', (code: unknown, signal: unknown) => {
      if (!exited && this.child === child) this.onExit(code, signal)
    })
    child.on('error', (error: unknown) => {
      this.errorText = error instanceof Error ? error.message : String(error)
      // Only a child that never painted is a failed spawn. An error on a
      // connection that was already live belongs to the exit handler: its
      // stderr tail says more about why herdr let go than this errno does, and
      // declaring the bridge dead here would beat the exit that follows it.
      if (this.phase === 'starting' || this.phase === 'idle') {
        this.spawnFailed = true
        this.setPhase('error')
      }
    })
  }

  private onStdout(chunk: unknown): void {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
    if (!text) return
    for (const line of this.decoder.push(text)) this.onLine(line)
  }

  private onLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    const message = parseTerminalMessage(parsed)
    if (message.kind === 'frame') {
      this.pushFrame(message.frame)
      return
    }
    if (message.kind === 'closed') {
      this.errorText = message.reason || 'bridge closed by herdr'
      this.setPhase('closed')
    }
  }

  private pushFrame(frame: TerminalFrame): void {
    // herdr numbers frames per connection, so a seq that goes backwards means
    // stale content survived a respawn: repaint from this frame instead.
    if (this.lastSeq && frame.seq && frame.seq < this.lastSeq) this.resync = true
    if (frame.seq > this.lastSeq) this.lastSeq = frame.seq
    this.frameCount += 1
    this.queue.push(frame)
    if (frame.full) this.resync = false
    while (this.queue.length > this.maxFrames) {
      this.queue.shift()
      this.droppedCount += 1
      this.resync = true
    }
    if (this.phase !== 'live') {
      // Painting again is the end of whatever went wrong before. Left standing,
      // a recovered pane keeps the old errno in its header tooltip and reads as
      // broken to the one person who just fixed it.
      this.errorText = ''
      this.setPhase('live')
    }
    // Frames are proof the control process exists, which is what makes a later
    // spawn failure a new streak instead of a continuation of an old one.
    this.spawnFailStreak = 0
    if (this.resync && !this.respawnTimer && !this.closing) {
      this.scheduleRespawn(respawnBackoff(this.respawnStreak, this.respawnDelayMs))
    }
  }

  private scheduleRespawn(delayMs: number): void {
    if (this.closing || this.respawnTimer) return
    this.respawnTimer = this.timers.after(() => {
      this.respawnTimer = null
      if (this.closing) return
      this.respawn()
    }, Math.max(0, delayMs))
  }

  private respawn(): void {
    if (this.respawning || this.closing) return
    this.respawning = true
    const child = this.child
    this.child = null
    if (child) {
      try {
        child.stdin?.end()
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    this.respawnCount += 1
    // New drops since the last attempt are what make this a streak rather than
    // a one-off hiccup, so it is measured against a watermark and not a clock: a
    // pane that respawned once and then behaved has to get the short delay back
    // immediately, and a pane still shedding frames has to be slowed down.
    if (this.droppedCount === this.droppedAtRespawn) this.respawnStreak = 0
    else this.respawnStreak += 1
    this.droppedAtRespawn = this.droppedCount
    this.setPhase('respawning')
    // The queue is stale screen content by definition once we respawn; the next
    // connection opens with a full repaint, so dropping it is what makes the
    // resync correct rather than additive.
    this.queue.length = 0
    this.spawnChild()
    this.respawning = false
  }

  private onExit(code: unknown, signal: unknown): void {
    this.child = null
    // The kill grace timer only exists to force out a child that ignored
    // stdin.end(); once it is really gone there is nothing left to signal.
    this.killTimer?.cancel()
    this.killTimer = null
    if (this.closing) {
      this.setPhase('closed')
      return
    }
    const exitText = `bridge exited (code ${String(code ?? 'null')}, signal ${String(signal ?? 'none')})`
    // Another client holds the terminal: take it over exactly once rather than
    // respawning into the same refusal forever.
    if (!this.takeover && !this.retriedTakeover && BUSY.test(this.stderrTail)) {
      this.retriedTakeover = true
      this.takeover = true
      this.errorText = ''
      this.scheduleRespawn(0)
      return
    }
    // A process that never started has no stderr and no exit code to report:
    // the `error` handler already wrote the only real diagnosis, and the
    // generic "code null" line would overwrite it with something meaningless.
    if (!this.spawnFailed) this.errorText = this.stderrTail.trim() || exitText
    this.setPhase('error')
    if (this.spawnFailed) {
      // Retrying a missing binary every 500ms forever is a busy loop that
      // looks like a crash: back off, and let a frame ever arriving reset it.
      this.spawnFailStreak += 1
      this.scheduleRespawn(respawnBackoff(this.spawnFailStreak, this.respawnDelayMs * 2))
      return
    }
    this.scheduleRespawn(this.respawnDelayMs * 2)
  }

  private setPhase(phase: BridgePhase): void {
    if (this.phase === phase) return
    this.phase = phase
    this.emitState()
  }

  private emitState(): void {
    const state = this.status()
    for (const listener of this.listeners) listener(state)
  }
}
