/**
 * A stand-in `herdr terminal session control` child, plus a clock we own.
 *
 * The bridge is the one part of Pro that talks to a process rather than a
 * socket, and its interesting behaviour is all about ordering: frames arriving
 * faster than the renderer drains them, a child that dies because herdr's own
 * TUI already holds the terminal, a kill that has to wait out a grace period.
 * Both need driving by hand, so the fake exposes the pipes and the clock
 * exposes `advance`.
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { BridgeChild, BridgeTimers, SpawnFn } from '../../src/main/pro/herdr/terminalBridge'

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'herdr')

export class FakeChild extends EventEmitter implements BridgeChild {
  readonly writes: string[] = []
  readonly kills: Array<NodeJS.Signals | number> = []
  stdinEnded = false
  readonly pid = 4242

  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()

  readonly stdin = {
    write: (chunk: string): boolean => {
      this.writes.push(chunk)
      return true
    },
    end: (): void => {
      this.stdinEnded = true
    }
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.kills.push(signal)
    return true
  }

  /* ------------------------------------------------------------- *
   * What herdr would have printed.
   * ------------------------------------------------------------- */

  /** Push raw stdout, optionally split across reads. */
  feed(text: string, pieces = 1): void {
    if (pieces <= 1) {
      this.stdout.emit('data', text)
      return
    }
    const size = Math.max(1, Math.ceil(text.length / pieces))
    for (let at = 0; at < text.length; at += size) this.stdout.emit('data', text.slice(at, at + size))
  }

  /** One NDJSON line on stdout. */
  sendLine(value: unknown, pieces = 1): void {
    this.feed(`${JSON.stringify(value)}\n`, pieces)
  }

  /** A terminal frame, base64 like the real one. */
  frame(
    seq: number,
    patch: { full?: boolean; width?: number; height?: number; bytes?: string } = {}
  ): void {
    this.sendLine({
      type: 'terminal.frame',
      seq,
      width: patch.width ?? 60,
      height: patch.height ?? 12,
      full: patch.full ?? false,
      bytes: patch.bytes ?? Buffer.from(`frame-${seq}`).toString('base64'),
      encoding: 'ansi'
    })
  }

  say(text: string): void {
    this.stderr.emit('data', text)
  }

  exitWith(code: number | null = 0, signal: string | null = null): void {
    this.emit('exit', code, signal)
  }

  failWith(message: string): void {
    this.emit('error', new Error(message))
  }

  /** Replay a recorded capture line by line, one read per line. */
  playFixture(name: string): number {
    const body = fs.readFileSync(path.join(FIXTURES, name), 'utf8')
    const rows = body.split('\n').filter((line) => line.trim())
    for (const line of rows) this.feed(`${line}\n`)
    return rows.length
  }

  /** The commands the bridge wrote to us, parsed. */
  commands(): Array<Record<string, unknown>> {
    return this.writes.filter((line) => line.trim()).map((line) => JSON.parse(line.replace(/\n$/, '')))
  }

  lastCommand(): Record<string, unknown> | null {
    const all = this.commands()
    return all[all.length - 1] ?? null
  }
}

export interface FakeSpawner {
  spawn: SpawnFn
  readonly children: FakeChild[]
  /** argv of every spawn, so a test can pin the herdr command line. */
  readonly calls: Array<{ binary: string; args: string[]; env: Record<string, string> }>
  /** The most recent child by default, or the nth one after a respawn. */
  child(index?: number): FakeChild
  /** Make the next spawn throw, for the missing-binary case. */
  failNext(message: string): void
}

export function fakeSpawner(): FakeSpawner {
  const children: FakeChild[] = []
  const calls: Array<{ binary: string; args: string[]; env: Record<string, string> }> = []
  let failure = ''

  const spawn: SpawnFn = (binary, args, options) => {
    calls.push({ binary, args: [...args], env: options.env ?? {} })
    if (failure) {
      const message = failure
      failure = ''
      throw new Error(message)
    }
    const child = new FakeChild()
    children.push(child)
    return child
  }

  return {
    spawn,
    children,
    calls,
    child: (index?: number) => {
      const at = index ?? children.length - 1
      const child = children[at]
      if (!child) throw new Error(`no child at index ${at}`)
      return child
    },
    failNext: (message: string) => {
      failure = message
    }
  }
}

export interface FakeClock {
  timers: BridgeTimers
  /** Run everything due within `ms`, in order. Returns how many fired. */
  advance(ms: number): number
  /** Timers still waiting to fire. */
  pending(): number
  readonly now: number
}

/**
 * The bridge has two delays - the respawn backoff and the kill grace - and both
 * are policy: too short and a hiccup becomes a respawn storm, too long and a
 * dead pane stays black. A real `setTimeout` cannot be asserted on without
 * waiting, so the clock is ours.
 */
export function fakeClock(start = 0): FakeClock {
  interface Entry {
    id: number
    at: number
    cb: () => void
    cancelled: boolean
  }
  const entries: Entry[] = []
  let clock = start
  let nextId = 1

  return {
    timers: {
      after: (cb, ms) => {
        const entry: Entry = { id: nextId, at: clock + Math.max(0, ms), cb, cancelled: false }
        nextId += 1
        entries.push(entry)
        return {
          cancel: () => {
            entry.cancelled = true
          }
        }
      },
      now: () => clock
    },
    advance(ms: number): number {
      const target = clock + ms
      let ran = 0
      for (;;) {
        const due = entries
          .filter((entry) => !entry.cancelled && entry.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0]
        if (!due) break
        due.cancelled = true
        clock = Math.max(clock, due.at)
        due.cb()
        ran += 1
      }
      clock = target
      return ran
    },
    pending: () => entries.filter((entry) => !entry.cancelled).length,
    get now(): number {
      return clock
    }
  }
}
