import { describe, expect, it } from 'vitest'
import {
  endpointBase,
  HEALTH_MARKER,
  isSafeToken,
  parseEndpointEnv,
  renderEndpointEnv,
  type Endpoint
} from '../src/shared/endpoint'
import { portAttempts } from '../src/shared/portPolicy'
import { createTestRelay } from './helpers/relay'

const SAMPLE: Endpoint = {
  port: 4321,
  token: 'abc-DEF_0123456789',
  pid: 4242,
  boot: 'beef1234',
  version: '0.1.0',
  writtenAt: 1_760_000_000_000
}

describe('endpoint.env', () => {
  it('round-trips every field the runners need', () => {
    const parsed = parseEndpointEnv(renderEndpointEnv(SAMPLE))
    expect(parsed).toMatchObject({
      port: SAMPLE.port,
      token: SAMPLE.token,
      pid: SAMPLE.pid,
      boot: SAMPLE.boot,
      version: SAMPLE.version
    })
  })

  it('is POSIX-sourceable: unquoted numbers, quoted strings, no stray spaces', () => {
    const text = renderEndpointEnv(SAMPLE)
    expect(text).toContain(`CODEWAIFU_PORT=${SAMPLE.port}`)
    expect(text).toContain(`CODEWAIFU_TOKEN="${SAMPLE.token}"`)
    expect(text).toContain(`CODEWAIFU_BASE="${endpointBase(SAMPLE.port)}"`)
    expect(text).toContain(`CODEWAIFU_PID=${SAMPLE.pid}`)
    expect(text).toContain(`CODEWAIFU_BOOT="${SAMPLE.boot}"`)
    // One assignment per line: PORT, TOKEN, BASE, PID, BOOT, VERSION. Comments
    // are all `#`-prefixed so `.` on the sourcing side can never see them.
    const assignments = text.split('\n').filter((line) => line.includes('=') && !line.startsWith('#'))
    expect(assignments).toHaveLength(6)
    expect(assignments.every((line) => /^CODEWAIFU_[A-Z]+=(?:"[^"]*"|\d+)$/.test(line))).toBe(true)
  })

  it('tolerates CRLF and single quotes from a hand-edited file', () => {
    const text = renderEndpointEnv(SAMPLE).replace(/\n/g, '\r\n').replace(/"/g, "'")
    expect(parseEndpointEnv(text)?.port).toBe(SAMPLE.port)
  })

  it('rejects a file that does not name a usable port, so the runner exits 0', () => {
    expect(parseEndpointEnv('')).toBeNull()
    expect(parseEndpointEnv('# nothing here')).toBeNull()
    expect(parseEndpointEnv('CODEWAIFU_PORT=0')).toBeNull()
    expect(parseEndpointEnv('CODEWAIFU_PORT=70000')).toBeNull()
    expect(parseEndpointEnv('CODEWAIFU_PORT=abc')).toBeNull()
  })

  it('keeps a missing token as an empty string rather than undefined', () => {
    const parsed = parseEndpointEnv(renderEndpointEnv({ ...SAMPLE, token: '' }))
    expect(parsed?.token).toBe('')
  })
})

describe('isSafeToken', () => {
  it('accepts what the app generates and rejects anything short or shell-hostile', () => {
    expect(isSafeToken('a'.repeat(16))).toBe(true)
    expect(isSafeToken('Ab-_09'.repeat(6))).toBe(true)
    expect(isSafeToken('')).toBe(false)
    expect(isSafeToken('short')).toBe(false)
    expect(isSafeToken('a'.repeat(129))).toBe(false)
    expect(isSafeToken('has space and $backtick`')).toBe(false)
  })
})

describe('HEALTH_MARKER contract', () => {
  it('is exactly what a live relay answers with on /health', async () => {
    const relay = createTestRelay()
    await relay.server.start(portAttempts({}))
    try {
      const raw = await relay.get('/health')
      expect(raw.status).toBe(200)
      // The runners do a substring match in sh and PowerShell; if the server
      // ever pretty-prints JSON this assertion fails and the hooks go silent.
      expect(raw.body).toContain(HEALTH_MARKER)
      expect(HEALTH_MARKER).toBe('"app":"codewaifu"')
    } finally {
      await relay.shutdown()
    }
  })

  it('/health needs no token, because the runner probes before it trusts the port', async () => {
    const relay = createTestRelay()
    await relay.server.start(portAttempts({}))
    try {
      const json = (await relay.get('/health')).json as { ok: boolean; app: string; port: number }
      expect(json).toMatchObject({ ok: true, app: 'codewaifu', port: relay.port })
    } finally {
      await relay.shutdown()
    }
  })
})
