/**
 * Port selection for the loopback relay.
 *
 * Two rules drive everything here:
 *
 * 1. The relay must never fail to start because some other process owns a
 *    port. The last attempt is always `listen(0)`, where the kernel hands us a
 *    port that is free by construction, so there is nothing left to collide
 *    with. We never "guess a random port and hope" - guessing is what makes
 *    conflicts a lottery instead of an impossibility.
 * 2. A port that moves must be announced, never silently absorbed. The hook
 *    runners follow `endpoint.env`, so a move is safe, but a *pinned* port is a
 *    promise the user typed, and breaking it quietly would look like a bug.
 */

export type PortAttemptReason = 'pinned' | 'sticky' | 'os-assigned'

export interface PortAttempt {
  /** `0` asks the kernel for any free ephemeral port. */
  port: number
  reason: PortAttemptReason
}

export type BindFailureKind = 'in-use' | 'forbidden' | 'unavailable' | 'unknown'

/** Who owns the port we could not bind, when we can tell. */
export type PortOwner = 'codewaifu' | 'other' | null

export interface RelayConflict {
  port: number
  kind: BindFailureKind
  owner: PortOwner
  /** Owner process id reported by a live CodeWaifu, when there is one. */
  pid: number
  hint: string
}

export const MIN_USER_PORT = 1024
export const MAX_PORT = 65535

/**
 * `0` means automatic. Anything else must be an unprivileged TCP port; a
 * hand-edited config.json cannot point the server at 22 or at 99999.
 */
export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_USER_PORT && value <= MAX_PORT
}

export function isAutomaticPort(value: unknown): boolean {
  return value === 0 || value === undefined || value === null || value === ''
}

/** Clamp untrusted input to "a port we may bind", collapsing junk to automatic. */
export function normalizeRequestedPort(value: unknown): number {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || trimmed.toLowerCase() === 'auto') return 0
    const parsed = Number(trimmed)
    return isValidPort(parsed) ? parsed : 0
  }
  return isValidPort(value) ? value : 0
}

export interface PortPreference {
  /** Hard requirement typed by the user (or `CODEWAIFU_PORT`). May be 0/absent. */
  pinned?: number | null
  /** Last port that worked. Reused so `endpoint.env` rarely changes. */
  sticky?: number | null
}

/**
 * Ordered bind attempts. Always ends with `listen(0)`; a pinned port is tried
 * first and the kernel pick stays as the fallback that keeps the app alive.
 */
export function portAttempts(preference: PortPreference): PortAttempt[] {
  const attempts: PortAttempt[] = []
  const seen = new Set<number>()
  const push = (port: number, reason: PortAttemptReason): void => {
    if (seen.has(port)) return
    seen.add(port)
    attempts.push({ port, reason })
  }
  const pinned = normalizeRequestedPort(preference.pinned ?? 0)
  if (pinned) push(pinned, 'pinned')
  const sticky = normalizeRequestedPort(preference.sticky ?? 0)
  if (sticky) push(sticky, 'sticky')
  push(0, 'os-assigned')
  return attempts
}

/** True when a failing attempt still leaves a fallback, so the app stays up. */
export function hasFallback(attempts: PortAttempt[], index: number): boolean {
  return index >= 0 && index < attempts.length - 1
}

export function classifyBindError(error: unknown): BindFailureKind {
  const code = errorCode(error)
  if (code === 'EADDRINUSE') return 'in-use'
  if (code === 'EACCES' || code === 'EPERM') return 'forbidden'
  if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') return 'unavailable'
  return 'unknown'
}

export function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}

/**
 * One-line explanation for logs and the Settings panel. Windows deserves its own
 * wording: Hyper-V/WinNAT reserves whole TCP ranges, and a bind there fails with
 * EACCES no matter how free the port looks.
 */
export function bindFailureHint(kind: BindFailureKind, port: number, platform: string): string {
  const shown = port > 0 ? String(port) : 'the requested port'
  switch (kind) {
    case 'in-use':
      return `port ${shown} is already in use by another process; the relay moved to a free port`
    case 'forbidden':
      return platform === 'win32'
        ? `port ${shown} is blocked by Windows (reserved range or admin-only); pick another port or leave it on automatic`
        : `port ${shown} is not allowed for this user; pick a port above 1023 or leave it on automatic`
    case 'unavailable':
      return `port ${shown} cannot be bound on this machine (no loopback address?)`
    default:
      return `port ${shown} could not be bound`
  }
}

export function describeAttempts(attempts: PortAttempt[]): string {
  return attempts.map((a) => (a.port === 0 ? 'kernel-chosen' : String(a.port))).join(' -> ')
}
