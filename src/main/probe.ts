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
