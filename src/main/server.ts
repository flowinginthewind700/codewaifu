import http from 'node:http'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { normalizeHook } from '../shared/hookEvent'
import { detectLang, toSpeakable } from '../shared/lang'
import type { AppConfig } from '../shared/config'
import type { Agent, HookEvent, RuntimeState, SteerResult, ThreadInfo } from '../shared/protocol'
import type { MediaCommand, MediaState } from '../shared/media'
import { emptyCounts, type BenchView } from '../shared/pro'
import {
  isProReject,
  parseProAnswer,
  parseProLedger,
  parseProSsh,
  parseProTask,
  type ProActionRequest,
  type ProLedgerRequest,
  type ProResult,
  type ProSshRequest,
  type ProTaskRequest
} from '../shared/proIpc'
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

/**
 * How many `GET /pro/stream` watchers one app serves, and how often each gets a
 * ping. The cap is a leak guard rather than a limit anybody should hit: a
 * watcher is a subscriber on the bench's own projection, so an unbounded count
 * would be an unbounded set of sockets notified on every change. Exported
 * because a test that waits for a real 20s ping is not a test.
 */
export const PRO_STREAM_MAX = 16
export const PRO_STREAM_HEARTBEAT_MS = 20_000

/**
 * The slice of the bench the relay needs (F6), declared here instead of imported
 * from `main/pro/service`: `ProService` satisfies it structurally, so the server
 * can be tested against a fake and never learns how the bench works.
 *
 * Deliberately narrow: there is no `paneOp`, so a script can drive tasks, intent
 * and attention decisions but can never become a second keyboard for a terminal
 * that is already open (MVP section 9). `sshOp` belongs here because a session
 * it opens types one known connect line into a pane it just created, which is
 * provisioning; addressing keystrokes at somebody's live pane is not, and stays
 * out.
 */
export interface ProApi {
  online(): boolean
  view(): BenchView | null
  act(request: ProActionRequest): Promise<ProResult>
  taskOp(request: ProTaskRequest): Promise<ProResult>
  ledgerOp(request: ProLedgerRequest): ProResult
  /** The machine roster and the sessions opened from it (`/pro/ssh`). */
  sshOp(request: ProSshRequest): Promise<ProResult>
  /**
   * Subscribe to the projection; `/pro/stream` hands one listener per watcher
   * to the bench and unsubscribes when that watcher's socket closes.
   */
  onChange(listener: (view: BenchView | null) => void): () => void
}

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
  /** Absent or `null` while Pro is off; `/pro/*` then answers 503. */
  pro?: () => ProApi | null
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
  private readonly streams = new Set<http.ServerResponse>()

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
    this.endStreams()
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
      // Ended rather than reset, so a watcher prints "the app went away"
      // instead of a socket error that reads like our bug.
      this.endStreams()
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

    if (route === 'pro') {
      await this.handlePro(req, res, parts, method, url)
      return
    }

    sendJson(res, 404, { ok: false, error: `no route for ${method} ${url.pathname}` })
  }

  /**
   * F6, the bench as an API. Six routes and no policy: each one validates with
   * the same parser the IPC channels use and hands the typed request to the same
   * `ProService` the window talks to, so a script and a click cannot disagree
   * about what is legal, or about what needs the human.
   *
   * All of it sits behind the token check in `handle()`, like every other
   * mutating route.
   */
  private async handlePro(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    parts: string[],
    method: string,
    // The parsed request target, not just its path: `/pro/ssh?q=` carries its
    // filter in the query, so this handler needs the whole URL.
    url: URL
  ): Promise<void> {
    const pathname = url.pathname
    const sub = parts[1] || ''
    const pro = this.deps.pro?.() ?? null
    if (!pro) {
      // Not "broken" and not "forbidden": the bench exists and is off. A script
      // can poll this and learn to wait rather than to give up.
      sendJson(res, 503, { ok: false, code: 'not-running', error: 'the bench is not running' })
      return
    }

    if (method === 'GET' && sub === 'state') {
      const view = pro.view()
      sendJson(res, 200, { ok: true, online: pro.online(), running: view !== null, view })
      return
    }

    if (method === 'GET' && sub === 'attention') {
      // The queue on its own, for a caller that only asks "what needs me": no
      // groups, no panes, no recovery plans.
      const view = pro.view()
      sendJson(res, 200, {
        ok: true,
        online: pro.online(),
        counts: view?.counts ?? emptyCounts(),
        attention: view?.attention ?? []
      })
      return
    }

    if (method === 'GET' && sub === 'stream') {
      this.streamPro(req, res, pro)
      return
    }

    if (method === 'GET' && sub === 'ssh') {
      // The roster as a read, because "which machines does this box know" is a
      // question a script asks on its own. The filter rides in the query so
      // `curl` is enough to search, and the payload still goes through the same
      // parser a POST does - one place decides what a legal filter is.
      const query = url.searchParams.get('q') ?? url.searchParams.get('query') ?? ''
      const request = parseProSsh({ op: 'list', query })
      if (isProReject(request)) {
        sendJson(res, 400, { ok: false, code: request.code, error: request.error })
        return
      }
      const result = await pro.sshOp(request)
      sendJson(res, proStatus(result), result)
      return
    }

    if (method !== 'POST') {
      sendJson(res, 404, { ok: false, error: `no route for ${method} ${pathname}` })
      return
    }

    const body = await readBody(req)

    if (sub === 'answer') {
      const request = parseProAnswer(body, pro.view()?.attention ?? [])
      if (isProReject(request)) {
        sendJson(res, 400, { ok: false, code: request.code, error: request.error })
        return
      }
      const result = await pro.act(request)
      sendJson(res, proStatus(result), result)
      return
    }

    if (sub === 'tasks') {
      const request = parseProTask(body)
      if (isProReject(request)) {
        sendJson(res, 400, { ok: false, code: request.code, error: request.error })
        return
      }
      const result = await pro.taskOp(request)
      sendJson(res, proStatus(result), result)
      return
    }

    if (sub === 'ledger') {
      // The task id belongs in the path (`/pro/ledger/<taskId>`) because that is
      // how the contract is worded, and in the body because a script that
      // already built a JSON blob should not have to split it. The path wins.
      const taskId = parts[2] || ''
      const request = parseProLedger({
        ...body,
        ...(taskId ? { taskId } : {}),
        // Provenance is not the caller's to claim. Whatever wrote this arrived
        // over HTTP, and the ledger is the audit trail.
        origin: 'api'
      })
      if (isProReject(request)) {
        sendJson(res, 400, { ok: false, code: request.code, error: request.error })
        return
      }
      const result = pro.ledgerOp(request)
      sendJson(res, proStatus(result), result)
      return
    }

    if (sub === 'ssh') {
      const request = parseProSsh(body)
      if (isProReject(request)) {
        sendJson(res, 400, { ok: false, code: request.code, error: request.error })
        return
      }
      const result = await pro.sshOp(request)
      sendJson(res, proStatus(result), result)
      return
    }

    sendJson(res, 404, { ok: false, error: `no route for ${method} ${pathname}` })
  }

  /**
   * `GET /pro/stream`: the projection, pushed instead of polled.
   *
   * One NDJSON frame per change, and a frame body is the one `/pro/state`
   * answers with plus a `kind`, so a consumer that understands one understands
   * the other and there is no second projection free to drift. The first frame
   * is written here rather than by the subscription, because a watcher that
   * must wait for something to change before it prints anything looks broken
   * during the quiet parts of a session.
   *
   * The ping is liveness, not data: on loopback a dead app is caught by the
   * socket anyway, but "quiet for an hour" and "gone" should not be the same
   * silence to whatever is printing them.
   */
  private streamPro(req: http.IncomingMessage, res: http.ServerResponse, pro: ProApi): void {
    if (this.streams.size >= PRO_STREAM_MAX) {
      sendJson(res, 429, {
        ok: false,
        code: 'too-many-watchers',
        error: `${PRO_STREAM_MAX} watchers are already attached to this bench`
      })
      return
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    this.streams.add(res)

    const write = (frame: Record<string, unknown>): void => {
      if (res.writableEnded || res.destroyed) return
      try {
        res.write(`${JSON.stringify(frame)}\n`)
      } catch {
        // A write that throws is a socket that is already gone; `close` does the
        // cleanup, and rethrowing here would take the request handler with it.
      }
    }

    const frameFor = (view: BenchView | null): Record<string, unknown> => ({
      kind: 'state',
      ok: true,
      online: pro.online(),
      running: view !== null,
      view
    })

    write(frameFor(pro.view()))

    const unsubscribe = pro.onChange((view) => write(frameFor(view)))
    const heartbeat = setInterval(
      () => write({ kind: 'ping', at: Date.now() }),
      PRO_STREAM_HEARTBEAT_MS
    )
    // Neither the heartbeat nor the subscription may outlive the process that
    // asked for them: a leaked interval keeps the event loop alive, and a
    // leaked subscriber is a bench notifying a socket nobody reads.
    heartbeat.unref?.()

    const cleanup = (): void => {
      clearInterval(heartbeat)
      unsubscribe()
      this.streams.delete(res)
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
    res.on('close', cleanup)
  }

  /** Close every watcher, so `stop()` is not left waiting on sockets it owns. */
  private endStreams(): void {
    for (const res of [...this.streams]) {
      this.streams.delete(res)
      try {
        if (!res.writableEnded) res.end()
      } catch {
        /* the socket is already gone */
      }
    }
  }
}

/**
 * HTTP shape of a `ProResult`. Four classes, because a script has to tell "you
 * asked about something that is not there" from "we are in no state to do this"
 * without parsing prose: 400 your payload, 404 your target, 503 the bench or
 * herdr is absent, 500 our own disk failed. Everything else is 409 - understood
 * and refused - which is also what `/steer` already answers.
 */
const PRO_STATUS: Record<string, number> = {
  'not-running': 503,
  offline: 503,
  'no-herdr-binary': 503,
  'no-item': 404,
  'no-task': 404,
  'bad-payload': 400,
  'bad-task': 400,
  'unknown-action': 400,
  'no-dir': 400,
  // A machine the caller failed to name is their argument, not a decision the
  // bench declined: exit 2 (usage) sends them back to the command line, exit 5
  // would send them looking for a policy.
  'bad-machine': 400,
  'write-failed': 500,
  internal: 500
}

function proStatus(result: ProResult): number {
  return result.ok ? 200 : (PRO_STATUS[result.code] ?? 409)
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
        // Still answer 200 (the agent must never be blocked by us), but leave a
        // trace: a mangled body silently degrades into an empty "other" event,
        // which is exactly how a quoting bug in the runner once went unnoticed.
        log('warn', 'request body is not valid JSON; treating it as empty', {
          bytes: text.length,
          head: text.slice(0, 120)
        })
        finish({})
      }
    })
    req.on('error', () => finish({}))
  })
}
