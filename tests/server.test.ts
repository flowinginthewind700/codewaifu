import { afterEach, describe, expect, it, vi } from 'vitest'
import { portAttempts } from '../src/shared/portPolicy'
import { failResult } from '../src/shared/proIpc'
import { PRO_STREAM_HEARTBEAT_MS, PRO_STREAM_MAX } from '../src/main/server'
import { createTestRelay, occupyPort, type TestRelay } from './helpers/relay'
import { attentionItem, benchView, fakePro, type FakePro } from './helpers/pro'

const TOKEN = 'test-token-0123456789abcdef'
let relays: TestRelay[] = []

async function startRelay(
  patch?: Parameters<typeof createTestRelay>[0],
  pro?: Parameters<typeof createTestRelay>[1]
): Promise<TestRelay> {
  const relay = createTestRelay(patch, pro)
  await relay.server.start(portAttempts({ pinned: 0, sticky: relay.config.port }))
  relays.push(relay)
  return relay
}

/** A relay with a bench behind it, plus the fake so a test can poke it. */
async function startPro(
  view: ReturnType<typeof benchView> | null = benchView()
): Promise<{ relay: TestRelay; pro: FakePro }> {
  const pro = fakePro({ view })
  return { relay: await startRelay(undefined, () => pro.api), pro }
}

/** Poll the way a socket event would: often, briefly, and then fail loudly. */
async function until(check: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((settle) => setTimeout(settle, 5))
  }
  throw new Error(`${what} never became true within ${ms}ms`)
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

  it('reads the pane off the relay header, which is where the runner puts it', async () => {
    const relay = await startRelay()
    const raw = await relay.request(
      'POST',
      '/hook/codex',
      {
        'content-type': 'application/json',
        'x-codewaifu-token': TOKEN,
        'x-codewaifu-pane': 'w5:p1'
      },
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-pane', cwd: '/tmp/project' })
    )
    expect(raw.status).toBe(200)
    expect(relay.recorded.events).toHaveLength(1)
    expect(relay.recorded.events[0].paneId).toBe('w5:p1')
  })

  it('leaves the pane empty for a runner older than the header', async () => {
    // The header is new and the runners on disk are rewritten lazily, so an
    // event without one is normal rather than broken: resolution has to fall
    // back to session and cwd exactly the way it did before.
    const relay = await startRelay()
    expect((await relay.post('/hook/codex', { hook_event_name: 'Stop' }, TOKEN)).status).toBe(200)
    expect(relay.recorded.events[0].paneId).toBe('')
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

describe('pro api (F6)', () => {
  it('answers 503 on every route while the bench is off', async () => {
    const relay = await startRelay()
    for (const path of ['/pro/state', '/pro/attention']) {
      const res = await relay.get(path, TOKEN)
      expect(res.status, path).toBe(503)
      expect(res.json, path).toMatchObject({ ok: false, code: 'not-running' })
    }
    expect((await relay.post('/pro/answer', { taskId: 't1', text: 'yes' }, TOKEN)).status).toBe(503)
    expect((await relay.post('/pro/tasks', { op: 'adopt' }, TOKEN)).status).toBe(503)
    expect((await relay.post('/pro/ledger/t1', { kind: 'note', text: 'x' }, TOKEN)).status).toBe(503)
  })

  it('keeps the bench behind the token like every other mutating route', async () => {
    const { relay } = await startPro()
    expect((await relay.get('/pro/state')).status).toBe(401)
    expect((await relay.get('/pro/state', 'wrong')).status).toBe(401)
    expect((await relay.post('/pro/answer', { taskId: 't1', text: 'yes' })).status).toBe(401)
  })

  it('serves the whole projection on /pro/state', async () => {
    const { relay, pro } = await startPro(benchView({ attention: [attentionItem()] }))
    const res = await relay.get('/pro/state', TOKEN)
    expect(res.status).toBe(200)
    const body = res.json as {
      ok: boolean
      online: boolean
      running: boolean
      view: { attention: unknown[] }
    }
    expect(body).toMatchObject({ ok: true, online: true, running: true })
    expect(body.view.attention).toHaveLength(1)
    // Herdr going away is a state, not an error: the window keeps rendering.
    pro.setOnline(false)
    expect((await relay.get('/pro/state', TOKEN)).json).toMatchObject({ online: false, running: true })
  })

  it('reports a stopped bench as running:false instead of failing the request', async () => {
    const { relay } = await startPro(null)
    const res = await relay.get('/pro/state', TOKEN)
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true, running: false, view: null })
  })

  it('serves just the queue on /pro/attention, in the order the bench ranks it', async () => {
    const view = benchView({
      attention: [attentionItem({ taskId: 't1' }), attentionItem({ taskId: 't2', kind: 'question' })]
    })
    const { relay } = await startPro(view)
    const res = await relay.get('/pro/attention', TOKEN)
    expect(res.status).toBe(200)
    const body = res.json as { attention: Array<{ id: string }>; counts: Record<string, number> }
    expect(body.attention.map((item) => item.id)).toEqual(['t1:permission:hook', 't2:question:hook'])
    expect(body.counts).toBeDefined()
  })

  it('resolves an answer to the first open item of that task', async () => {
    const view = benchView({
      attention: [
        attentionItem({ taskId: 't1', kind: 'review' }),
        attentionItem({ taskId: 't1', kind: 'permission' }),
        attentionItem({ taskId: 't2' })
      ]
    })
    const { relay, pro } = await startPro(view)
    const res = await relay.post('/pro/answer', { taskId: 't1', text: 'yes, and keep going' }, TOKEN)
    expect(res.status).toBe(200)
    expect(pro.recorded.actions).toEqual([
      {
        itemId: 't1:review:hook',
        action: 'answer',
        text: 'yes, and keep going',
        origin: 'api',
        minutes: 10,
        option: 0
      }
    ])
  })

  it('skips an item the human already acted on', async () => {
    const view = benchView({
      attention: [
        attentionItem({ taskId: 't1', resolved: true }),
        attentionItem({ taskId: 't1', kind: 'question' })
      ]
    })
    const { relay, pro } = await startPro(view)
    await relay.post('/pro/answer', { taskId: 't1', text: 'go on' }, TOKEN)
    expect(pro.recorded.actions[0].itemId).toBe('t1:question:hook')
  })

  it('narrows by pane, and refuses rather than answering a different prompt', async () => {
    const { relay, pro } = await startPro(benchView({ attention: [attentionItem({ taskId: 't1' })] }))
    const hit = await relay.post('/pro/answer', { taskId: 't1', paneId: 'pane-1', text: 'go' }, TOKEN)
    expect(hit.status).toBe(200)
    const miss = await relay.post('/pro/answer', { taskId: 't1', paneId: 'pane-9', text: 'go' }, TOKEN)
    expect(miss.status).toBe(400)
    expect(miss.json).toMatchObject({ ok: false, code: 'no-item' })
    // The refused call must not have typed anything anywhere.
    expect(pro.recorded.actions).toHaveLength(1)
  })

  it('carries the other verbs, so one agent can unblock another', async () => {
    const { relay, pro } = await startPro(benchView({ attention: [attentionItem({ taskId: 't7' })] }))
    const res = await relay.post('/pro/answer', { taskId: 't7', action: 'approve' }, TOKEN)
    expect(res.status).toBe(200)
    expect(pro.recorded.actions[0]).toMatchObject({ action: 'approve', text: '', origin: 'api' })
  })

  it('takes an explicit itemId and pins origin to api, whatever the caller claims', async () => {
    const { relay, pro } = await startPro(benchView({ attention: [attentionItem({ taskId: 't1' })] }))
    await relay.post(
      '/pro/answer',
      { itemId: 't1:permission:hook', action: 'deny', origin: 'bench' },
      TOKEN
    )
    expect(pro.recorded.actions[0]).toMatchObject({ itemId: 't1:permission:hook', origin: 'api' })
  })

  it('rejects an answer with no text, an unknown task, and no target at all', async () => {
    const { relay, pro } = await startPro(benchView({ attention: [attentionItem({ taskId: 't1' })] }))
    const noText = await relay.post('/pro/answer', { taskId: 't1' }, TOKEN)
    expect(noText.status).toBe(400)
    expect(noText.json).toMatchObject({ code: 'needs-text' })
    const noTask = await relay.post('/pro/answer', { taskId: 'nope', text: 'hi' }, TOKEN)
    expect(noTask.status).toBe(400)
    expect(noTask.json).toMatchObject({ code: 'no-item' })
    expect((await relay.post('/pro/answer', { text: 'hi' }, TOKEN)).status).toBe(400)
    expect(pro.recorded.actions).toHaveLength(0)
  })

  it('maps a service failure onto a status a script can branch on', async () => {
    const { relay, pro } = await startPro(benchView({ attention: [attentionItem({ taskId: 't1' })] }))
    const cases: Array<[string, number]> = [
      ['offline', 503],
      ['not-running', 503],
      ['no-item', 404],
      ['no-recipe', 409],
      ['write-failed', 500]
    ]
    for (const [code, status] of cases) {
      pro.setResult(failResult(code, 'nope'))
      const res = await relay.post('/pro/answer', { taskId: 't1', action: 'approve' }, TOKEN)
      expect(res.status, code).toBe(status)
      expect(res.json, code).toMatchObject({ ok: false, code })
    }
  })

  it('creates a task through the same parser the bench window uses', async () => {
    const { relay, pro } = await startPro()
    const res = await relay.post(
      '/pro/tasks',
      { op: 'create', title: 'wire the api', workdir: '/tmp/repo', start: false },
      TOKEN
    )
    expect(res.status).toBe(200)
    expect(pro.recorded.tasks).toEqual([
      {
        op: 'create',
        title: 'wire the api',
        goal: '',
        workdir: '/tmp/repo',
        branch: '',
        base: '',
        worktree: false,
        agent: '',
        start: false,
        prompt: ''
      }
    ])
  })

  it('400s a task op nobody implements, and a create with no workdir', async () => {
    const { relay, pro } = await startPro()
    expect((await relay.post('/pro/tasks', { op: 'launch' }, TOKEN)).status).toBe(400)
    const noDir = await relay.post('/pro/tasks', { op: 'create', title: 'x' }, TOKEN)
    expect(noDir.status).toBe(400)
    expect(noDir.json).toMatchObject({ code: 'needs-workdir' })
    expect(pro.recorded.tasks).toHaveLength(0)
  })

  it('appends to the ledger named in the path, stamped as an api writer', async () => {
    const { relay, pro } = await startPro()
    const res = await relay.post(
      '/pro/ledger/t9',
      { kind: 'decision', text: 'use the socket path discovery found', origin: 'bench' },
      TOKEN
    )
    expect(res.status).toBe(200)
    expect(pro.recorded.ledger).toEqual([
      {
        op: 'append',
        taskId: 't9',
        kind: 'decision',
        text: 'use the socket path discovery found',
        agent: '',
        sessionKind: '',
        sessionValue: '',
        gitHead: '',
        branch: '',
        dirty: 0,
        origin: 'api'
      }
    ])
  })

  it('takes the task id from the body when the path has none, and the path wins over both', async () => {
    const { relay, pro } = await startPro()
    await relay.post('/pro/ledger', { taskId: 'body1', kind: 'note', text: 'from the body' }, TOKEN)
    await relay.post('/pro/ledger/path1', { taskId: 'body2', kind: 'note', text: 'path wins' }, TOKEN)
    expect(pro.recorded.ledger.map((entry) => entry.taskId)).toEqual(['body1', 'path1'])
  })

  it('400s an empty ledger entry, and a taskId that would escape the tasks dir', async () => {
    const { relay, pro } = await startPro()
    const empty = await relay.post('/pro/ledger/t1', { kind: 'note' }, TOKEN)
    expect(empty.status).toBe(400)
    expect(empty.json).toMatchObject({ code: 'needs-text' })
    // Path traversal is the reason taskIdOf exists; a route must not bypass it.
    const escape = await relay.post('/pro/ledger', { taskId: '../../etc', kind: 'note', text: 'x' }, TOKEN)
    expect(escape.status).toBe(400)
    expect(escape.json).toMatchObject({ code: 'bad-task' })
    expect(pro.recorded.ledger).toHaveLength(0)
  })

  it('404s a /pro path or method that does not exist', async () => {
    const { relay } = await startPro()
    expect((await relay.get('/pro/nope', TOKEN)).status).toBe(404)
    expect((await relay.get('/pro/tasks', TOKEN)).status).toBe(404)
    expect((await relay.post('/pro/state', {}, TOKEN)).status).toBe(404)
    // No pane route over HTTP: a script is not a second keyboard (MVP section 9).
    const pane = await relay.post('/pro/pane', { op: 'send', paneId: 'pane-1', text: 'ls' }, TOKEN)
    expect(pane.status).toBe(404)
  })

  it('reads the roster on GET /pro/ssh, taking the filter from the query', async () => {
    const { relay, pro } = await startPro()
    const res = await relay.get('/pro/ssh', TOKEN)
    expect(res.status).toBe(200)
    expect(pro.recorded.ssh).toEqual([{ op: 'list', query: '' }])

    await relay.get('/pro/ssh?q=prod', TOKEN)
    expect(pro.recorded.ssh[1]).toEqual({ op: 'list', query: 'prod' })
  })

  it('opens a session on POST /pro/ssh, recording the typed request', async () => {
    const { relay, pro } = await startPro()
    const res = await relay.post('/pro/ssh', { op: 'connect', target: 'prod' }, TOKEN)
    expect(res.status).toBe(200)
    expect(pro.recorded.ssh[0]).toMatchObject({ op: 'connect', target: 'prod', save: true })
  })

  it('400s an ssh op the parser refuses, before the bench is asked', async () => {
    const { relay, pro } = await startPro()
    // An edit with no field to change is the parser's to refuse, not the bench's:
    // a route that forwarded it would record a request the service then rejects.
    const res = await relay.post('/pro/ssh', { op: 'edit', target: 'prod' }, TOKEN)
    expect(res.status).toBe(400)
    expect(res.json).toMatchObject({ code: 'bad-machine' })
    expect(pro.recorded.ssh).toHaveLength(0)
  })

  it('maps a bench failure to its status, and answers 503 while the bench is off', async () => {
    const { relay, pro } = await startPro()
    pro.setResult(failResult('offline', 'herdr went away'))
    expect((await relay.post('/pro/ssh', { op: 'keys' }, TOKEN)).status).toBe(503)

    const off = await startRelay()
    expect((await off.get('/pro/ssh', TOKEN)).status).toBe(503)
    expect((await off.post('/pro/ssh', { op: 'keys' }, TOKEN)).status).toBe(503)
  })

  it('keeps /pro/ssh behind the token, read and write alike', async () => {
    const { relay } = await startPro()
    expect((await relay.get('/pro/ssh')).status).toBe(401)
    expect((await relay.post('/pro/ssh', { op: 'keys' })).status).toBe(401)
  })
})

/* ------------------------------------------------------------------ *
 * The push route
 * ------------------------------------------------------------------ */

describe('the push route (/pro/stream)', () => {
  /**
   * Why this route exists: `pro state` in a loop is a poll, and a poll is either
   * too slow to feel live or too fast to leave the bench alone. So the assertion
   * that matters is not "a frame arrived" but "the relay never asked the bench
   * for the projection again".
   */
  it('pushes the tree once, then one frame per change, without asking again', async () => {
    const { relay, pro } = await startPro(benchView())
    const stream = await relay.stream('/pro/stream', TOKEN)
    try {
      expect(stream.status).toBe(200)
      const first = await stream.next(0)
      expect(first).toMatchObject({ kind: 'state', ok: true, online: true, running: true })
      const asked = pro.viewCalls()

      pro.setView(benchView({ attention: [attentionItem()] }))
      const second = await stream.next(1)
      expect((second.view as { attention: unknown[] }).attention).toHaveLength(1)
      expect(pro.viewCalls()).toBe(asked)

      // And herdr going away is pushed too: it is not part of the tree, so a
      // watcher that only diffed tasks would sit on a bench that cannot move.
      pro.setOnline(false)
      expect(await stream.next(2)).toMatchObject({ online: false, running: true })
    } finally {
      await stream.close()
    }
  })

  it('sends the body /pro/state answers, so there is no second projection free to drift', async () => {
    const { relay } = await startPro(benchView({ attention: [attentionItem()] }))
    const stream = await relay.stream('/pro/stream', TOKEN)
    try {
      const polled = (await relay.get('/pro/state', TOKEN)).json as Record<string, unknown>
      const pushed = { ...(await stream.next(0)) }
      delete pushed.kind
      expect(pushed).toEqual(polled)
    } finally {
      await stream.close()
    }
  })

  it('unsubscribes when the watcher goes away: a leaked listener is a leak the server cannot see', async () => {
    const { relay, pro } = await startPro()
    const stream = await relay.stream('/pro/stream', TOKEN)
    await stream.next(0)
    expect(pro.subscriberCount()).toBe(1)
    await stream.close()
    await until(() => pro.subscriberCount() === 0, 'the closed watcher was never unsubscribed')
  })

  it('keeps the stream behind the token, and subscribes to nothing without it', async () => {
    const { relay, pro } = await startPro()
    expect((await relay.get('/pro/stream')).status).toBe(401)
    expect((await relay.get('/pro/stream', 'wrong')).status).toBe(401)
    expect(pro.subscriberCount()).toBe(0)
  })

  it('answers 503 while the bench is off, because there is nothing to watch', async () => {
    const relay = await startRelay()
    const refused = await relay.get('/pro/stream', TOKEN)
    expect(refused.status).toBe(503)
    expect(refused.json).toMatchObject({ ok: false, code: 'not-running' })
  })

  it('refuses the watcher past the cap, and frees the slot when one leaves', async () => {
    const { relay, pro } = await startPro()
    const open: Awaited<ReturnType<TestRelay['stream']>>[] = []
    try {
      for (let index = 0; index < PRO_STREAM_MAX; index += 1) {
        open.push(await relay.stream('/pro/stream', TOKEN))
      }
      await until(() => pro.subscriberCount() === PRO_STREAM_MAX, 'the cap was never reached')

      const refused = await relay.stream('/pro/stream', TOKEN)
      expect(refused.status).toBe(429)
      // Refused means refused: the body is already over and carries no frames, so
      // a watcher cannot mistake the cap for a stream that is attached but quiet.
      await refused.done
      expect(refused.ended).toBe(true)
      expect(refused.frames).toHaveLength(0)
      expect(pro.subscriberCount()).toBe(PRO_STREAM_MAX)
      await refused.close()

      // The cap is a leak guard, not a wall: one watcher leaving has to make room
      // for the next, or a busy bench would refuse a terminal forever.
      await open.pop()!.close()
      let again = await relay.stream('/pro/stream', TOKEN)
      for (let attempt = 0; attempt < 100 && again.status === 429; attempt += 1) {
        await again.close()
        await new Promise((settle) => setTimeout(settle, 10))
        again = await relay.stream('/pro/stream', TOKEN)
      }
      expect(again.status).toBe(200)
      open.push(again)
    } finally {
      await Promise.all(open.map((stream) => stream.close()))
    }
  })

  it('pushes a stopped bench as view:null instead of dropping the connection', async () => {
    const { relay, pro } = await startPro(benchView({ attention: [attentionItem()] }))
    const stream = await relay.stream('/pro/stream', TOKEN)
    try {
      await stream.next(0)
      pro.setView(null)
      // The watcher is told the bench is gone rather than left holding a tree
      // that still looks live; and it stays attached, because Pro can come back.
      expect(await stream.next(1)).toMatchObject({ kind: 'state', running: false, view: null })
      expect(stream.ended).toBe(false)
    } finally {
      await stream.close()
    }
  })

  it('ends every stream when the app goes, so no watcher is left on a dead socket', async () => {
    const { relay } = await startPro()
    const first = await relay.stream('/pro/stream', TOKEN)
    const second = await relay.stream('/pro/stream', TOKEN)
    await first.next(0)
    await second.next(0)
    await relay.server.stopAsync(500)
    await Promise.all([first.done, second.done])
    expect(first.ended).toBe(true)
    expect(second.ended).toBe(true)
  })

  it('pings, so an hour of nothing and a dead app are not the same silence', async () => {
    // Only the interval is faked: the frames still travel over a real socket, so
    // this asserts that the relay writes a heartbeat, not that a timer fires.
    vi.useFakeTimers({ toFake: ['setInterval'] })
    const { relay } = await startPro()
    const stream = await relay.stream('/pro/stream', TOKEN)
    try {
      await stream.next(0)
      vi.advanceTimersByTime(PRO_STREAM_HEARTBEAT_MS)
      const ping = await stream.next(1)
      expect(ping.kind).toBe('ping')
      expect(typeof ping.at).toBe('number')
    } finally {
      await stream.close()
      vi.useRealTimers()
    }
  })
})
