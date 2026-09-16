import http from 'node:http'
import { HEALTH_MARKER, type Endpoint } from '../shared/endpoint'

export interface HealthPayload {
  ok: boolean
  app?: string
  version?: string
  port?: number
  pid?: number
  boot?: string
}

export interface JsonResponse {
  status: number
  json: unknown
}

/**
 * Loopback JSON client shared by the app (owner probes, duplicate detection) and
 * the CLI (status/say). Everything is short-lived and fail-soft: a probe that
 * throws is just "nobody home".
 */
export function requestJson(
  method: string,
  port: number,
  path: string,
  options: { token?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<JsonResponse> {
  const { token = '', body, timeoutMs = 3000 } = options
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        timeout: timeoutMs,
        headers: {
          ...(token ? { 'X-CodeWaifu-Token': token } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown = text
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            /* keep the raw text so callers can still pattern-match it */
          }
          resolve({ status: res.statusCode || 0, json })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export async function probeHealth(port: number, timeoutMs = 1200): Promise<HealthPayload | null> {
  if (!port) return null
  try {
    const { status, json } = await requestJson('GET', port, '/health', { timeoutMs })
    if (status !== 200) return null
    const payload = json as HealthPayload
    if (!payload || typeof payload !== 'object') return null
    return payload.app === 'codewaifu' ? payload : { ok: false, app: String(payload.app ?? '') }
  } catch {
    return null
  }
}

/** True when a live CodeWaifu relay answers on this port. */
export async function isCodeWaifuPort(port: number, timeoutMs = 1200): Promise<HealthPayload | null> {
  const payload = await probeHealth(port, timeoutMs)
  return payload && payload.ok && payload.app === 'codewaifu' ? payload : null
}

/**
 * Reads `endpoint.env` and asks the port whether it is still ours. This is the
 * only trustworthy "is the app running" test: the file survives a crash and its
 * port may have been recycled to something else in the meantime.
 */
export async function resolveLiveEndpoint(
  readEndpoint: () => Endpoint | null,
  timeoutMs = 1200
): Promise<{ endpoint: Endpoint | null; health: HealthPayload | null; live: boolean }> {
  const endpoint = readEndpoint()
  if (!endpoint) return { endpoint: null, health: null, live: false }
  const health = await probeHealth(endpoint.port, timeoutMs)
  return { endpoint, health, live: Boolean(health && health.ok && health.app === 'codewaifu') }
}

/** Kept next to the client so a change to either side fails a test, not a hook. */
export function healthMarkerMatches(serializedHealth: string): boolean {
  return serializedHealth.includes(HEALTH_MARKER)
}

export interface StreamReady {
  status: number
  /** The parsed body when the status was not 200, which is never NDJSON. */
  json: unknown
}

export interface StreamClosed {
  /** `ended` is the app finishing the response; the other two are not. */
  reason: 'ended' | 'error' | 'closed'
  detail: string
}

export interface StreamHandle {
  /**
   * Settles once the headers are in: status 200 means frames will start
   * arriving through `onFrame`, anything else means the relay answered with a
   * JSON error and no frame will ever come. Rejects only when the socket dies
   * before the headers, which is the same "nobody home" a request reports.
   */
  ready: Promise<StreamReady>
  /** Settles when the stream stops, whether the app ended it or it broke. */
  closed: Promise<StreamClosed>
  close(): void
}

/**
 * An NDJSON client for the one route that pushes: `GET /pro/stream`.
 *
 * `requestJson` cannot serve it, and not only because it buffers: it also arms
 * a timeout, and a watcher cut off after five seconds of a quiet session would
 * report a fault where nothing went wrong. So there is no timeout here at all -
 * liveness is the relay's ping frame and the socket's own close - and frames
 * are parsed as they land rather than at the end.
 *
 * A line that fails to parse is dropped instead of surfaced: the only malformed
 * frame a healthy relay produces is the half-written one from the moment the
 * connection ended, and failing a watcher for that turns "the app quit" into
 * "the app is broken".
 */
export function streamNdjson(
  port: number,
  path: string,
  options: { token?: string; onFrame: (frame: unknown) => void }
): StreamHandle {
  const { token = '', onFrame } = options

  let settleReady!: (value: StreamReady) => void
  let failReady!: (error: Error) => void
  let settleClosed!: (value: StreamClosed) => void
  const ready = new Promise<StreamReady>((resolve, reject) => {
    settleReady = resolve
    failReady = reject
  })
  const closed = new Promise<StreamClosed>((resolve) => {
    settleClosed = resolve
  })

  let done = false
  const finish = (reason: StreamClosed['reason'], detail = ''): void => {
    if (done) return
    done = true
    settleClosed({ reason, detail })
  }

  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: {
        Accept: 'application/x-ndjson',
        ...(token ? { 'X-CodeWaifu-Token': token } : {})
      }
    },
    (res) => {
      const status = res.statusCode || 0
      if (status !== 200) {
        // The error path: read the whole body and hand it back. No frames.
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown = text
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            /* keep the raw text so a caller can still pattern-match it */
          }
          settleReady({ status, json })
          finish('ended')
        })
        res.on('error', (error) => {
          settleReady({ status, json: null })
          finish('error', String(error))
        })
        return
      }

      settleReady({ status, json: null })
      let buffer = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          if (!line) continue
          try {
            onFrame(JSON.parse(line))
          } catch {
            /* a torn trailing frame; see the note above */
          }
        }
      })
      res.on('end', () => finish('ended'))
      res.on('error', (error) => finish('error', String(error)))
      res.on('close', () => finish('closed'))
    }
  )

  req.on('error', (error) => {
    finish('error', String(error))
    failReady(error)
  })
  // A watcher sits for as long as the human watches, so the socket must not be
  // reaped by an idle timeout on either side.
  req.setSocketKeepAlive(true)
  req.end()

  return {
    ready,
    closed,
    close: () => {
      finish('closed')
      try {
        req.destroy()
      } catch {
        /* already gone */
      }
    }
  }
}
