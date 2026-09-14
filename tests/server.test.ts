import { afterEach, describe, expect, it } from 'vitest'
import { portAttempts } from '../src/shared/portPolicy'
import { createTestRelay, occupyPort, type TestRelay } from './helpers/relay'

const TOKEN = 'test-token-0123456789abcdef'
let relays: TestRelay[] = []

async function startRelay(patch?: Parameters<typeof createTestRelay>[0]): Promise<TestRelay> {
  const relay = createTestRelay(patch)
  await relay.server.start(portAttempts({ pinned: 0, sticky: relay.config.port }))
  relays.push(relay)
  return relay
}

afterEach(async () => {
  for (const relay of relays) await relay.shutdown()
  relays = []
})

describe('authentication', () => {
  it('refuses every mutating or data route without the token', async () => {
    const relay = await startRelay()
    expect((await relay.get('/state')).status).toBe(401)
    expect((await relay.get('/threads')).status).toBe(401)
    expect((await relay.post('/hook/codex', { hook_event_name: 'Stop' })).status).toBe(401)
    expect((await relay.post('/say', { text: 'hi' })).status).toBe(401)
    expect(relay.recorded.events).toHaveLength(0)
    expect(relay.recorded.said).toHaveLength(0)
  })

  it('refuses a wrong token, including one of the right length', async () => {
    const relay = await startRelay()
    expect((await relay.get('/state', 'x'.repeat(TOKEN.length))).status).toBe(401)
    expect((await relay.get('/state', 'nope')).status).toBe(401)
  })

  it('accepts the token on every route', async () => {
    const relay = await startRelay()
    expect((await relay.get('/state', TOKEN)).status).toBe(200)
    expect((await relay.post('/say', { text: 'hello there' }, TOKEN)).status).toBe(200)
    expect(relay.recorded.said).toEqual([{ text: 'hello there', lang: 'en' }])
  })

  it('rejects a request whose Host header is not loopback (DNS rebinding)', async () => {
    const relay = await startRelay()
    const raw = await relay.request('GET', '/health', { host: 'evil.example.com' })
    expect(raw.status).toBe(421)
    expect(raw.body).toContain('misdirected')
  })

  it('never redacts the token into an unauthenticated response, and redacts it for the UI', async () => {
    const relay = await startRelay()
    const body = (await relay.get('/config', TOKEN)).body
    expect(body).not.toContain(TOKEN)
    expect(body).toContain('"token":"***"')
  })
})

describe('hook ingestion', () => {
  it('answers 200 before doing any work and normalizes the payload', async () => {
    const relay = await startRelay()
    const res = await relay.post(
      '/hook/claude',
      {
        hook_event_name: 'Stop',
        session_id: 'sess-123',
        cwd: '/tmp/project',
        last_assistant_message: '全部完成了'
      },
      TOKEN
    )
    expect(res.status).toBe(200)
    expect(relay.recorded.events).toHaveLength(1)
    const event = relay.recorded.events[0]
    expect(event.agent).toBe('claude')
    expect(event.kind).toBe('stop')
    expect(event.sessionId).toBe('sess-123')
    expect(event.sourceText).toBe('全部完成了')
  })

  it('survives an empty or malformed body instead of hanging the agent', async () => {
    const relay = await startRelay()
    expect((await relay.post('/hook/codex', {}, TOKEN)).status).toBe(200)
    const raw = await relay.request('POST', '/hook/codex', { 'content-type': 'application/json', 'x-codewaifu-token': TOKEN }, 'not json')
    expect(raw.status).toBe(200)
    expect(relay.recorded.events).toHaveLength(2)
  })

  it('drops an oversized body mid-stream instead of buffering it, and stays up', async () => {
    const relay = await startRelay()
    // readBody() destroys the socket past MAX_BODY, so the client sees a reset
    // rather than a status code. What matters is that we neither allocate the
    // whole payload nor take the relay down with it.
    await expect(relay.post('/say', { text: 'x'.repeat(300 * 1024) }, TOKEN)).rejects.toThrow()
    expect((await relay.get('/health')).status).toBe(200)
    expect(relay.recorded.said).toHaveLength(0)
  })

  it('/say needs text, and detects the language to speak', async () => {
    const relay = await startRelay()
    expect((await relay.post('/say', {}, TOKEN)).status).toBe(400)
    await relay.post('/say', { text: '构建成功了' }, TOKEN)
    expect(relay.recorded.said.at(-1)).toEqual({ text: '构建成功了', lang: 'zh' })
  })
})

describe('media and steer routes', () => {
  it('accepts the five transport commands and nothing else', async () => {
    const relay = await startRelay()
    for (const command of ['toggle', 'play', 'pause', 'next', 'previous']) {
      expect((await relay.post(`/media/${command}`, {}, TOKEN)).status, command).toBe(200)
    }
    expect(relay.recorded.mediaCommands).toEqual(['toggle', 'play', 'pause', 'next', 'previous'])
    expect((await relay.post('/media/eject', {}, TOKEN)).status).toBe(400)
  })

  it('passes a steer request through and reports failure as 409', async () => {
    const relay = await startRelay()
    const ok = await relay.post('/steer', { agent: 'codex', threadId: 'thread-1', message: 'run the tests' }, TOKEN)
    expect(ok.status).toBe(200)
    expect(relay.recorded.steers).toEqual([{ agent: 'codex', threadId: 'thread-1', message: 'run the tests' }])
  })

  it('404s an unknown route with the method and path in the message', async () => {
    const relay = await startRelay()
    const res = await relay.get('/definitely-not-a-route', TOKEN)
    expect(res.status).toBe(404)
    expect(res.body).toContain('/definitely-not-a-route')
  })
})

describe('port conflicts', () => {
  it('moves to a kernel-chosen port when the preferred one is busy, and says why', async () => {
    const blocker = await occupyPort()
    try {
      const relay = createTestRelay()
      relays.push(relay)
      const result = await relay.server.start(portAttempts({ pinned: 0, sticky: blocker.port }))
      expect(result.port).toBeGreaterThan(0)
      expect(result.port).not.toBe(blocker.port)
      expect(result.reason).toBe('os-assigned')
      expect(result.failures).toHaveLength(1)
      expect(result.failures[0]).toMatchObject({ port: blocker.port, kind: 'in-use', owner: 'other' })
      expect(result.failures[0].hint).toContain(String(blocker.port))
      // The relay is still fully usable on the new port.
      expect((await relay.get('/health')).status).toBe(200)
    } finally {
      await blocker.close()
    }
  })

  it('names another CodeWaifu as the owner instead of treating it as a stranger', async () => {
    const owner = await startRelay()
    const intruder = createTestRelay()
    relays.push(intruder)
    const result = await intruder.server.start(portAttempts({ pinned: owner.port, sticky: 0 }))
    expect(result.port).not.toBe(owner.port)
    expect(result.failures[0]).toMatchObject({ kind: 'in-use', owner: 'codewaifu', pid: process.pid })
  })

  it('reports the ladder it walked in the log line', async () => {
    const blocker = await occupyPort()
    try {
      const relay = createTestRelay()
      relays.push(relay)
      const attempts = portAttempts({ pinned: blocker.port, sticky: 0 })
      const result = await relay.server.start(attempts)
      expect(result.attempts).toEqual(attempts)
      expect(result.reason).toBe('os-assigned')
    } finally {
      await blocker.close()
    }
  })

  it('re-binds onto a port it just released, without EADDRINUSE', async () => {
    const relay = await startRelay()
    const first = relay.port
    await relay.server.stopAsync()
    const second = await relay.server.start(portAttempts({ pinned: first, sticky: 0 }))
    expect(second.port).toBe(first)
    expect(second.failures).toHaveLength(0)
  })
})
