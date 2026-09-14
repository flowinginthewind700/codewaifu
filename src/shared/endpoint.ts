export interface Endpoint {
  port: number
  token: string
  /** Process id of the app that wrote the file. */
  pid?: number
  /** Random per-launch id; lets callers detect a restarted app. */
  boot?: string
  version?: string
  writtenAt?: number
}

/**
 * Substring every runner checks in `/health` before it POSTs anything. A port
 * we used last week can be owned by an unrelated dev server today, and the hook
 * payload contains session data, so the runner verifies who answers first.
 * Kept in sync with `HookServer` by `tests/endpoint.test.ts`.
 */
export const HEALTH_MARKER = '"app":"codewaifu"'

export function endpointBase(port: number): string {
  return `http://127.0.0.1:${port}`
}

/**
 * `~/.codewaifu/endpoint.env` is the handshake between the app and the hook
 * runners. It is deliberately valid POSIX shell *and* trivially parseable by
 * PowerShell, so neither runner needs a JSON parser.
 */
export function renderEndpointEnv(endpoint: Endpoint): string {
  const port = Number(endpoint.port) || 0
  const pid = Number(endpoint.pid) || 0
  return [
    '# Written by CodeWaifu. Sourced by the agent hook runners.',
    '# If the app is not running these values are stale: the runner probes',
    '# /health, sees the marker is missing, and exits 0 without sending anything.',
    `# updated ${endpoint.writtenAt ? new Date(endpoint.writtenAt).toISOString() : 'unknown'}`,
    `CODEWAIFU_PORT=${port}`,
    `CODEWAIFU_TOKEN="${endpoint.token || ''}"`,
    `CODEWAIFU_BASE="${endpointBase(port)}"`,
    `CODEWAIFU_PID=${pid}`,
    `CODEWAIFU_BOOT="${endpoint.boot || ''}"`,
    `CODEWAIFU_VERSION="${endpoint.version || ''}"`,
    ''
  ].join('\n')
}

export function parseEndpointEnv(text: string): Endpoint | null {
  let port = 0
  let token = ''
  let pid = 0
  let boot = ''
  let version = ''
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const value = m[2].trim().replace(/^["']|["']$/g, '')
    if (m[1] === 'CODEWAIFU_PORT') port = Number(value)
    if (m[1] === 'CODEWAIFU_TOKEN') token = value
    if (m[1] === 'CODEWAIFU_PID') pid = Number(value) || 0
    if (m[1] === 'CODEWAIFU_BOOT') boot = value
    if (m[1] === 'CODEWAIFU_VERSION') version = value
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
  return { port, token, pid, boot, version }
}

/** Tokens go into a world-readable-ish dotfile, so make them long and URL-safe. */
export function isSafeToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(token || '')
}
