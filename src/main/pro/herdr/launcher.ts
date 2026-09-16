/**
 * Starting herdr, which is the half of durability nobody else owns.
 *
 * herdr keeps panes alive across *its own* restarts and resumes agents it has a
 * native session ref for, so an app crash costs nothing. A machine reboot is
 * different: the server is gone and nothing on the box is going to start it,
 * because the thing a human would have run (`herdr`) is a TUI. Left alone, the
 * bench boots into an install card that says "herdr is not running" over a
 * registry full of work that is one socket away from continuing.
 *
 * `herdr server` is the headless form and is exactly the supervised/service
 * entry point its own help calls it. So: when discovery finds a binary and no
 * socket, spawn it detached, unref it, and let the existing rediscover backoff
 * notice the socket appear. The server must outlive us - that is the whole
 * premise of a control plane over a durable runtime - hence `detached` plus
 * `unref` plus `stdio: 'ignore'`, which also means we cannot read its stderr.
 * What we can do is count attempts, cap them, and point the card at herdr's own
 * log file, because "we tried and it did not stay up" without a place to look
 * is the same dead end as not trying.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { SESSION_ENV_VAR, SOCKET_ENV_VAR, logPathForSocket, type HerdrTarget } from './discovery'

/** The subset of a detached child we touch. Structural so a test can fake it. */
export interface ServerChild {
  readonly pid?: number
  unref?(): void
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

export interface ServerSpawnOptions {
  env: Record<string, string>
  detached: boolean
  stdio: 'ignore'
}

export type ServerSpawnFn = (
  binary: string,
  args: readonly string[],
  options: ServerSpawnOptions
) => ServerChild

export interface LauncherTimers {
  now(): number
}

export type LauncherLog = (
  level: 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>
) => void

export interface LauncherDeps {
  spawn?: ServerSpawnFn
  timers?: LauncherTimers
  log?: LauncherLog
  /**
   * Ceiling on attempts before we stop trying and say so. A box where herdr
   * cannot start (bad libc, no PTYs, a config that panics) must not be handed
   * an endless fork loop by the thing whose job was to make it durable.
   */
  maxAttempts?: number
  retryMs?: number
  maxRetryMs?: number
}

/** What the caller knows that discovery does not: the configured session. */
export interface LaunchRequest {
  target: HerdrTarget
  /** `pro.herdrSession`; '' means herdr's default session. */
  session: string
  /** `pro.socketPath`; only passed through when it was set explicitly. */
  socketPath: string
  /** Parent environment; the server needs PATH and HOME to spawn shells. */
  env: Record<string, string | undefined>
}

const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_RETRY_MS = 1500
const DEFAULT_MAX_RETRY_MS = 30000

/** herdr writes this next to the socket it was going to create. */
function logHintFor(target: HerdrTarget): string {
  return logPathForSocket(target.triedSockets[0] || target.socketPath || '')
}

/**
 * Why an attempt failed, in both languages.
 *
 * It ends up on the install card, which is localized, so a single English
 * sentence interpolated into a Chinese card is not acceptable - that is how a
 * bilingual product starts looking machine translated.
 */
interface Failure {
  readonly en: string
  readonly zh: string
}

function exitFailure(code: number | null, signal: string | null): Failure {
  if (signal) {
    return {
      en: `exited on ${signal} before taking the socket`,
      zh: `接管 socket 前被信号 ${signal} 终止`
    }
  }
  return {
    en: code === 0 ? 'exited before taking the socket' : `exited with code ${code} before taking the socket`,
    zh: code === 0 ? '接管 socket 前就退出了' : `接管 socket 前退出（code ${code}）`
  }
}

function startFailure(reason: string): Failure {
  return { en: `cannot start it: ${reason}`, zh: `无法启动：${reason}` }
}

export function realServerSpawn(
  binary: string,
  args: readonly string[],
  options: ServerSpawnOptions
): ServerChild {
  return nodeSpawn(binary, [...args], {
    env: options.env,
    detached: options.detached,
    stdio: options.stdio
  }) as unknown as ServerChild
}

export class HerdrLauncher {
  private readonly spawnFn: ServerSpawnFn
  private readonly timers: LauncherTimers
  private readonly log: LauncherLog
  private readonly maxAttempts: number
  private readonly retryMs: number
  private readonly maxRetryMs: number

  private attempts = 0
  private lastAttemptAt = 0
  private lastFailure: Failure | null = null
  private pid = 0
  private gaveUp = false

  constructor(deps: LauncherDeps = {}) {
    this.spawnFn = deps.spawn ?? realServerSpawn
    this.timers = deps.timers ?? { now: () => Date.now() }
    this.log = deps.log ?? (() => {})
    this.maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    this.retryMs = Math.max(0, deps.retryMs ?? DEFAULT_RETRY_MS)
    this.maxRetryMs = Math.max(this.retryMs, deps.maxRetryMs ?? DEFAULT_MAX_RETRY_MS)
  }

  get attemptCount(): number {
    return this.attempts
  }

  get exhausted(): boolean {
    return this.gaveUp
  }

  /** Pid of the server we spawned, 0 when we have not or it was not reported. */
  get serverPid(): number {
    return this.pid
  }

  /**
   * Start the server if it is our turn to. Returns true only for the call that
   * actually spawned, so a caller can log once instead of on every probe.
   *
   * Idempotent by construction: discovery runs on a backoff timer and on every
   * settings change, and each of those must not become a process.
   */
  ensure(request: LaunchRequest): boolean {
    const target = request.target
    if (target.socketPath) {
      // It is up. Forget the attempt history, because the next reboot starts
      // from zero and a stale ceiling would leave it there.
      this.reset()
      return false
    }
    if (!target.binaryPath) return false
    if (this.attempts >= this.maxAttempts) {
      if (!this.gaveUp) {
        this.gaveUp = true
        this.log('warn', 'pro: gave up starting herdr', {
          attempts: this.attempts,
          error: this.lastFailure?.en ?? '',
          log: logHintFor(target)
        })
      }
      return false
    }
    const now = this.timers.now()
    if (this.lastAttemptAt && now - this.lastAttemptAt < this.backoffMs()) return false

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(request.env)) {
      if (typeof value === 'string') env[key] = value
    }
    const session = String(request.session || target.session || '').trim()
    if (session) env[SESSION_ENV_VAR] = session
    const socket = String(request.socketPath || '').trim()
    if (socket) env[SOCKET_ENV_VAR] = socket

    this.attempts += 1
    this.lastAttemptAt = now
    // The previous attempt's reason is kept: it is the only evidence we have
    // while this one is in flight, and `reset` clears it when a socket shows up.
    try {
      const child = this.spawnFn(target.binaryPath, ['server'], {
        env,
        detached: true,
        stdio: 'ignore'
      })
      this.pid = child.pid ?? 0
      child.on('exit', (code, signal) => {
        // An exit is only interesting while the socket is still missing; once
        // herdr is up, `ensure` resets this history anyway.
        this.lastFailure = exitFailure(code, signal)
        this.log('warn', 'pro: the herdr server we started did not stay up', {
          attempts: this.attempts,
          error: this.lastFailure.en,
          log: logHintFor(target)
        })
      })
      child.on('error', (error) => {
        this.lastFailure = startFailure(error?.message || String(error))
        this.log('error', 'pro: cannot start the herdr server', { error: this.lastFailure.en })
      })
      child.unref?.()
    } catch (error) {
      this.lastFailure = startFailure(error instanceof Error ? error.message : String(error))
      this.log('error', 'pro: cannot start the herdr server', { error: this.lastFailure.en })
      return false
    }
    this.log('info', 'pro: starting the herdr server', {
      attempt: this.attempts,
      of: this.maxAttempts,
      session: session || '(default)',
      binary: target.binaryPath
    })
    return true
  }

  /** A socket appeared (or settings moved us): the slate is clean. */
  reset(): void {
    this.attempts = 0
    this.lastAttemptAt = 0
    this.lastFailure = null
    this.pid = 0
    this.gaveUp = false
  }

  private backoffMs(): number {
    const step = this.retryMs * Math.pow(2, Math.max(0, this.attempts - 1))
    return Math.min(this.maxRetryMs, step)
  }

  /**
   * The one line the install card can add to "herdr is not running". Empty
   * until we have actually tried, because a card that says "starting" on a
   * machine where the knob is off is describing somebody else's machine.
   */
  describe(lang: 'zh' | 'en', target: HerdrTarget): string {
    if (!this.attempts) return ''
    const logHint = logHintFor(target)
    const failure = this.lastFailure ? this.lastFailure[lang] : ''
    if (lang === 'zh') {
      if (this.gaveUp) {
        const why = failure ? `：${failure}` : ''
        return `已尝试启动 herdr ${this.attempts} 次仍未成功${why}${logHint ? `，日志：${logHint}` : ''}`
      }
      const previous = failure ? `；上次尝试${failure}` : ''
      return `正在启动 herdr server（第 ${this.attempts} 次尝试）${previous}`
    }
    if (this.gaveUp) {
      const why = failure ? `: ${failure}` : ''
      return `tried to start herdr ${this.attempts} times and it did not stay up${why}${logHint ? `; log: ${logHint}` : ''}`
    }
    const previous = failure ? `; the previous attempt ${failure}` : ''
    return `starting herdr server (attempt ${this.attempts})${previous}`
  }
}
