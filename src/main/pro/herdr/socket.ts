/**
 * herdr's socket API: one connection per request, one long-lived connection for
 * events.
 *
 * The protocol's shape dictates the design (see shared/herdr.ts): a request
 * connection is closed by the server after it replies, so there is nothing to
 * pool, and the subscription connection emits bare `{"event","data"}` lines that
 * carry no id. Getting those two cases confused is the classic bug here — a
 * client that waits for a reply on the event stream hangs forever — so they are
 * two functions and neither tries to do the other's job.
 *
 * Every failure mode is a `HerdrError` with a code the UI can act on:
 * `connect` (herdr is not running), `timeout` (it is wedged), `closed` (it went
 * away mid-call) and whatever code herdr itself returned. The bench never
 * throws a raw socket error at the renderer.
 */
import net from 'node:net'
import { parseWireMessage, type HerdrEvent } from '../../../shared/herdr'
import { LineDecoder, encodeRequest, nextRequestId } from './ndjson'

export type SocketErrorCode = 'connect' | 'timeout' | 'closed' | 'protocol' | string

export class HerdrError extends Error {
  readonly code: SocketErrorCode
  readonly method: string

  constructor(code: SocketErrorCode, method: string, message: string) {
    super(message || `${method} failed (${code})`)
    this.name = 'HerdrError'
    this.code = code
    this.method = method
  }
}

/** Injectable so a test can hand us a fake duplex instead of a real socket. */
export type ConnectFn = (path: string) => net.Socket

export interface SocketOptions {
  timeoutMs?: number
  connect?: ConnectFn
}

export const DEFAULT_TIMEOUT_MS = 5000

function defaultConnect(path: string): net.Socket {
  return net.createConnection(path)
}

/**
 * One method call. Resolves with the `result` object (which still carries its
 * `type` discriminator), rejects with `HerdrError`.
 */
export function request(
  socketPath: string,
  method: string,
  params: unknown = {},
  options: SocketOptions = {}
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const connect = options.connect ?? defaultConnect
  const id = nextRequestId(method.replace(/\W+/g, '.'))

  return new Promise((resolve, reject) => {
    let settled = false
    let socket: net.Socket
    try {
      socket = connect(socketPath)
    } catch (error) {
      reject(new HerdrError('connect', method, String(error)))
      return
    }
    const decoder = new LineDecoder()
    const fail = (code: SocketErrorCode, message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(new HerdrError(code, method, message))
    }
    const succeed = (result: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // herdr closes it anyway; destroying here is what makes a slow close
      // unable to delay the next call.
      socket.end()
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => fail('timeout', `${method} timed out after ${timeoutMs}ms`), timeoutMs)

    socket.setEncoding('utf8')
    socket.once('connect', () => {
      socket.write(encodeRequest(id, method, params))
    })
    socket.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const line of decoder.push(text)) handleLine(line)
    })
    socket.on('end', () => {
      for (const line of decoder.end()) handleLine(line)
      if (!settled) fail('closed', `${method}: connection closed before a reply`)
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // ENOENT on a unix socket means "nobody is listening": herdr is not
      // running. That is a normal state for a bench to be in, not a crash.
      const code = error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'connect' : 'connect'
      fail(code, error.message || String(error))
    })
    socket.on('close', () => {
      if (!settled) fail('closed', `${method}: socket closed`)
    })

    function handleLine(line: string): void {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        return
      }
      const message = parseWireMessage(parsed)
      if (message.kind === 'result' && (!message.id || message.id === id)) {
        succeed(message.result)
        return
      }
      if (message.kind === 'error' && (!message.id || message.id === id)) {
        fail(message.code || 'protocol', message.message)
      }
      // An `event` line on a request connection is unexpected but harmless.
    }
  })
}

export interface SubscriptionHandlers {
  onEvent: (event: HerdrEvent) => void
  /** herdr acknowledged the subscription; the stream is now live. */
  onReady?: () => void
  /** Transport-level failure. The caller decides whether to reconnect. */
  onError?: (error: HerdrError) => void
  /** The stream ended (herdr stopped, socket closed). */
  onClose?: (reason: string) => void
}

export interface Subscription {
  close: () => void
  readonly socketPath: string
  /** True once the ack arrived; used by tests and by the readiness badge. */
  live: () => boolean
}

/**
 * Open the event stream. The connection stays open and herdr pushes bare event
 * lines until we close it or it exits.
 */
export function subscribe(
  socketPath: string,
  subscriptions: ReadonlyArray<{ type: string }>,
  handlers: SubscriptionHandlers,
  options: SocketOptions = {}
): Subscription {
  const connect = options.connect ?? defaultConnect
  const id = nextRequestId('events.subscribe')
  let closed = false
  let ready = false
  let socket: net.Socket

  try {
    socket = connect(socketPath)
  } catch (error) {
    const failure = new HerdrError('connect', 'events.subscribe', String(error))
    queueMicrotask(() => handlers.onError?.(failure))
    return { close: () => undefined, socketPath, live: () => false }
  }

  const decoder = new LineDecoder()
  socket.setEncoding('utf8')
  socket.once('connect', () => {
    socket.write(encodeRequest(id, 'events.subscribe', { subscriptions }))
  })
  socket.on('data', (chunk: string | Buffer) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    for (const line of decoder.push(text)) handleLine(line)
  })
  socket.on('error', (error: NodeJS.ErrnoException) => {
    if (closed) return
    handlers.onError?.(new HerdrError('connect', 'events.subscribe', error.message || String(error)))
  })
  socket.on('close', () => {
    if (closed) return
    ready = false
    handlers.onClose?.('socket closed')
  })
  socket.on('end', () => {
    for (const line of decoder.end()) handleLine(line)
  })

  function handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    const message = parseWireMessage(parsed)
    if (message.kind === 'event') {
      handlers.onEvent(message.event)
      return
    }
    if (message.kind === 'result') {
      // The ack is a result line: {"type":"subscription_started"}.
      ready = true
      handlers.onReady?.()
      return
    }
    if (message.kind === 'error') {
      handlers.onError?.(new HerdrError(message.code || 'protocol', 'events.subscribe', message.message))
    }
  }

  return {
    socketPath,
    live: () => ready && !closed,
    close: () => {
      if (closed) return
      closed = true
      ready = false
      try {
        socket.end()
        socket.destroy()
      } catch {
        /* a socket that is already gone is not an error */
      }
    }
  }
}
