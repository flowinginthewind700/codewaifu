import http from 'node:http'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { normalizeHook } from '../shared/hookEvent'
import { detectLang, toSpeakable } from '../shared/lang'
import type { AppConfig } from '../shared/config'
import type { Agent, HookEvent, RuntimeState, SteerResult, ThreadInfo } from '../shared/protocol'
import type { MediaCommand, MediaState } from '../shared/media'
import {
  bindFailureHint,
  classifyBindError,
  describeAttempts,
  type BindFailureKind,
  type PortAttempt,
  type PortAttemptReason,
  type PortOwner
} from '../shared/portPolicy'
import { log } from './log'
import { isCodeWaifuPort } from './probe'
import { platform } from './env'

const MAX_BODY = 256 * 1024
const MEDIA_COMMANDS = new Set<MediaCommand>(['toggle', 'play', 'pause', 'next', 'previous'])

export interface ServerDeps {
  getConfig: () => AppConfig
  setConfig: (patch: unknown) => Promise<AppConfig> | AppConfig
  onEvent: (event: HookEvent) => void
  onSay: (text: string, lang: 'zh' | 'en') => void
  onShow: () => void
  runtimeState: () => RuntimeState
  listThreads: () => Promise<ThreadInfo[]>
  steer: (agent: Agent, threadId: string, message: string) => Promise<SteerResult>
  mediaState: () => Promise<MediaState>
  mediaCommand: (command: MediaCommand) => Promise<MediaState>
}

export interface StartResult {
  port: number
  reason: PortAttemptReason
  attempts: PortAttempt[]
  failures: BindFailure[]
}

export interface BindFailure {
  port: number
  kind: BindFailureKind
  owner: PortOwner
  pid: number
  hint: string
}

export interface ServerIdentity {
  boot: string
  pid: number
  version: string
}

/** `none` while no socket is bound. */
export type BindReason = PortAttemptReason | 'none'

/**
 * Loopback-only control plane. Three rules hold it together: it binds
 * 127.0.0.1, every mutating route requires the per-install token, and the Host
 * header is validated so a DNS-rebinding page cannot talk to it.
 *
 * Port choice lives in `portPolicy`: try the preferred port, then ask the kernel
 * for a free one. Binding can therefore only fail if loopback itself is broken.
 */
export class HookServer {
  private server: http.Server | null = null
  private port = 0
  private identity: ServerIdentity = { boot: '', pid: 0, version: '0.0.0' }
  private reason: BindReason = 'none'
  private failures: BindFailure[] = []

  constructor(private readonly deps: ServerDeps) {}

  get listeningPort(): number {
    return this.port
  }

  get bindReason(): BindReason {
    return this.reason
  }

  get bindFailures(): BindFailure[] {
    return this.failures
  }

  get boot(): string {
    return this.identity.boot
  }

  setIdentity(identity: ServerIdentity): void {
    this.identity = identity
  }

  /**
   * Bind the first attempt that works. A busy preferred port is not an error, it
   * is the normal case on a dev machine, so we classify it, record it for the UI
   * and move on to the kernel-chosen port.
   */
  async start(attempts: PortAttempt[]): Promise<StartResult> {
    const list = attempts.length > 0 ? attempts : [{ port: 0, reason: 'os-assigned' as const }]
    this.failures = []
    let lastError: unknown = null
    for (let index = 0; index < list.length; index += 1) {
      const attempt = list[index]
      try {
        await this.listen(attempt.port)
        this.reason = attempt.reason
        if (this.failures.length > 0) {
          log(
            'warn',
            `relay bound ${this.port} after ${describeAttempts(list)}`,
            this.failures.map((f) => f.hint)
          )
        } else {
          log('info', `relay listening on 127.0.0.1:${this.port}`, { reason: attempt.reason })
        }
        return { port: this.port, reason: attempt.reason, attempts: list, failures: this.failures }
      } catch (error) {
        lastError = error
        const kind = classifyBindError(error)
        let owner: PortOwner = null
        let pid = 0
        if (kind === 'in-use' && attempt.port > 0) {
          // Somebody answers here. If it is another CodeWaifu we must not steal
          // its endpoint file, so the caller needs to know before we move on.
          const health = await isCodeWaifuPort(attempt.port, 800)
          if (health) {
            owner = 'codewaifu'
            pid = Number(health.pid) || 0
          } else {
            owner = 'other'
          }
        }
        const hint = bindFailureHint(kind, attempt.port, platform)
        this.failures.push({ port: attempt.port, kind, owner, pid, hint })
        log('warn', hint, String(error))
      }
    }
    this.reason = 'none'
    throw new Error(`could not bind a loopback port (tried ${describeAttempts(list)}): ${String(lastError)}`)
  }

  /** Re-bind, e.g. after the user changes the port in Settings. */
  async rebind(attempts: PortAttempt[]): Promise<StartResult> {
    await this.stopAsync()
    return this.start(attempts)
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          log('error', 'request handler crashed', String(error))
          sendJson(res, 500, { ok: false, error: 'internal error' })
        })
      })
      server.once('error', (error) => {
        server.removeAllListeners()
        reject(error)
      })
      server.listen(port, '127.0.0.1', () => {
        const address = server.address() as AddressInfo | null
        this.port = address ? address.port : port
        this.server = server
        server.removeAllListeners('error')
        server.on('error', (error) => log('error', 'http server error', String(error)))
        resolve()
      })
    })
  }

  stop(): void {
    const server = this.server
    this.server = null
    this.port = 0
    this.reason = 'none'
    if (server) {
      try {
        server.removeAllListeners()
        server.close()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Close and wait for the socket to actually disappear. `close()` alone leaves
   * keep-alive connections holding the port, and an immediate re-bind would then
   * fail with EADDRINUSE on a port we just owned.
   */
  async stopAsync(timeoutMs = 1500): Promise<void> {
    const server = this.server
    if (!server) {
      this.stop()
      return
    }
    this.server = null
    const closed = new Promise<void>((resolve) => {
      server.once('close', () => resolve())
      const timer = setTimeout(() => resolve(), timeoutMs)
      timer.unref?.()
    })
    try {
      server.closeAllConnections?.()
      server.close()
    } catch {
      /* ignore */
    }
    await closed
    this.port = 0
    this.reason = 'none'
  }

  private authorized(req: http.IncomingMessage): boolean {
    const token = this.deps.getConfig().token
    if (!token) return false
    const provided = String(req.headers['x-codewaifu-token'] || '')
    if (!provided) return false
    const a = Buffer.from(provided)
    const b = Buffer.from(token)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  }

  private hostAllowed(req: http.IncomingMessage): boolean {
    const host = String(req.headers.host || '')
    const name = host.replace(/:\d+$/, '').toLowerCase()
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1' || name === ''
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.hostAllowed(req)) {
      sendJson(res, 421, { ok: false, error: 'misdirected request' })
      return
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean)
    const method = req.method || 'GET'

    if (method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }

    if (parts[0] === 'health' && method === 'GET') {
      // Unauthenticated on purpose: hook runners probe this before they send
      // anything, so it must not leak more than "a CodeWaifu relay is here".
      // The exact shape is contractual - see HEALTH_MARKER in shared/endpoint.ts.
      sendJson(res, 200, {
        ok: true,
        app: 'codewaifu',
        version: this.identity.version,
        port: this.port,
        pid: this.identity.pid,
        boot: this.identity.boot
      })
      return
    }

    if (!this.authorized(req)) {
      sendJson(res, 401, { ok: false, error: 'missing or invalid X-CodeWaifu-Token' })
      return
    }

    const route = parts[0] || ''
    const sub = parts[1] || ''

    if (route === 'hook' && method === 'POST') {
      const body = await readBody(req)
      const event = normalizeHook(sub || 'unknown', body)
      // Respond before doing any work: the agent is waiting on this request.
      sendJson(res, 200, { ok: true, id: event.id })
      this.deps.onEvent(event)
      return
    }

    if (route === 'say' && method === 'POST') {
      const body = await readBody(req)
      const text = toSpeakable(typeof body.text === 'string' ? body.text : '', 400)
      if (!text) {
        sendJson(res, 400, { ok: false, error: 'text is required' })
        return
      }
      const lang = body.lang === 'zh' || body.lang === 'en' ? body.lang : detectLang(text)
      sendJson(res, 200, { ok: true })
      this.deps.onSay(text, lang)
      return
    }

    if (route === 'state' && method === 'GET') {
      sendJson(res, 200, this.deps.runtimeState())
      return
    }

    if (route === 'config') {
      if (method === 'GET') {
        const config = this.deps.getConfig()
        sendJson(res, 200, { ...config, token: config.token ? '***' : '' })
        return
      }
      if (method === 'POST') {
        const body = await readBody(req)
        const next = await this.deps.setConfig(body.patch ?? body)
        sendJson(res, 200, { ok: true, config: { ...next, token: '***' } })
        return
      }
    }

    if (route === 'threads' && method === 'GET') {
      const threads = await this.deps.listThreads()
      sendJson(res, 200, { ok: true, threads })
      return
    }

    if (route === 'steer' && method === 'POST') {
      const body = await readBody(req)
      const agent: Agent = body.agent === 'codex' || body.agent === 'claude' ? body.agent : 'unknown'
      const result = await this.deps.steer(agent, String(body.threadId || ''), String(body.message || ''))
      sendJson(res, result.ok ? 200 : 409, result)
      return
    }

    if (route === 'media') {
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, media: await this.deps.mediaState() })
        return
      }
      if (method === 'POST') {
        const command = sub as MediaCommand
        if (!MEDIA_COMMANDS.has(command)) {
          sendJson(res, 400, { ok: false, error: `unknown media command "${sub}"` })
          return
        }
        sendJson(res, 200, { ok: true, media: await this.deps.mediaCommand(command) })
        return
      }
    }

    if (route === 'show' && method === 'POST') {
      sendJson(res, 200, { ok: true })
      this.deps.onShow()
      return
    }

    sendJson(res, 404, { ok: false, error: `no route for ${method} ${url.pathname}` })
  }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  if (res.writableEnded) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (value: Record<string, unknown>): void => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        chunks.length = 0
        finish({})
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        finish({})
        return
      }
      try {
        const parsed = JSON.parse(text) as unknown
        finish(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {})
      } catch {
        finish({})
      }
    })
    req.on('error', () => finish({}))
  })
}
