/**
 * The herdr NDJSON transport (acceptance §6.6).
 *
 * Two connections, two protocols, and getting them confused is the classic bug:
 * a request connection is closed by the server after one reply, an event
 * connection stays open and pushes bare `{"event","data"}` lines that carry no
 * id. Every failure has to come back as a `HerdrError` with a code the bench can
 * act on, because "herdr is not running" is a normal state for a cockpit to be
 * in, not a crash to surface.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TIMEOUT_MS,
  HerdrError,
  request,
  subscribe
} from '../src/main/pro/herdr/socket'
import {
  LIFECYCLE_SUBSCRIPTIONS,
  isStateEvent,
  isStructuralEvent,
  parseStatusChange,
  type HerdrEvent
} from '../src/shared/herdr'
import { fakeServer } from './helpers/herdrSocket'

const FIXTURES = path.join(__dirname, 'fixtures', 'herdr')

/**
 * The focus-only names `session.ts` patches in place instead of re-reading for.
 * Mirrored here rather than exported: the point of the assertion is that every
 * recorded event name lands in *some* bucket, so the tree never goes stale.
 */
const FOCUS_EVENTS = ['pane_focused', 'tab_focused', 'workspace_focused']

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
}

/** The recorded NDJSON of one file, as lines. */
function lines(name: string): string[] {
  return fixture(name)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

const SOCKET = '/tmp/codewaifu-test-herdr.sock'

describe('request', () => {
  it('sends one id/method/params line and resolves with the result object', async () => {
    const server = fakeServer({ result: { type: 'pong', version: '0.9.0', protocol: 22 } })
    const result = await request(SOCKET, 'ping', { quiet: true }, { connect: server.connect })
    expect(result).toEqual({ type: 'pong', version: '0.9.0', protocol: 22 })
    expect(server.paths).toEqual([SOCKET])
    const sent = server.socket().request()
    expect(sent?.method).toBe('ping')
    expect(sent?.params).toEqual({ quiet: true })
    // The id is namespaced per method, which is what makes a log readable.
    expect(sent?.id.startsWith('ping:')).toBe(true)
    expect(server.socket().encoding).toBe('utf8')
  })

  it('tears the connection down on success so a slow close cannot delay the next call', async () => {
    const server = fakeServer({ result: { type: 'ok' } })
    await request(SOCKET, 'pane.focus', {}, { connect: server.connect })
    expect(server.socket().ended).toBe(true)
    expect(server.socket().destroyed).toBe(true)
  })

  it('reassembles a reply that arrives in pieces', async () => {
    const recorded = JSON.parse(fixture('snapshot-live.json')) as { result: unknown }
    const server = fakeServer({ result: recorded.result, pieces: 7 })
    const result = await request(SOCKET, 'session.snapshot', {}, { connect: server.connect })
    expect(result).toEqual(recorded.result)
  })

  it('ignores a reply addressed to a different request id', async () => {
    const server = fakeServer({ silent: true })
    const pending = request(SOCKET, 'ping', {}, { connect: server.connect, timeoutMs: 40 })
    await new Promise((resolve) => setTimeout(resolve, 5))
    // A late answer to something we already gave up on must not resolve this one.
    server.socket().sendLine({ id: 'somebody-else:1', result: { type: 'pong' } })
    await expect(pending).rejects.toMatchObject({ code: 'timeout', method: 'ping' })
  })

  it('accepts a reply with no id, which is what a one-shot server sends', async () => {
    const server = fakeServer({ silent: true })
    const pending = request(SOCKET, 'ping', {}, { connect: server.connect })
    await new Promise((resolve) => setTimeout(resolve, 5))
    server.socket().sendLine({ result: { type: 'ok' } })
    await expect(pending).resolves.toEqual({ type: 'ok' })
  })

  it('turns herdr\'s own error reply into a HerdrError carrying its code', async () => {
    const server = fakeServer({ silent: true })
    const pending = request(SOCKET, 'pane.read', { pane_id: 'nope' }, { connect: server.connect })
    await new Promise((resolve) => setTimeout(resolve, 5))
    server.socket().fail('invalid_request', 'unknown pane: nope')
    const error = await pending.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HerdrError)
    expect(error).toMatchObject({ code: 'invalid_request', method: 'pane.read' })
    expect((error as HerdrError).message).toBe('unknown pane: nope')
    expect(server.socket().destroyed).toBe(true)
  })

  it('reports a refused or missing socket as `connect`: herdr is simply not running', async () => {
    for (const code of ['ENOENT', 'ECONNREFUSED']) {
      const server = fakeServer({ failConnect: code })
      await expect(request(SOCKET, 'ping', {}, { connect: server.connect })).rejects.toMatchObject({
        code: 'connect',
        method: 'ping'
      })
    }
  })

  it('reports a connect() that throws synchronously as `connect` too', async () => {
    const server = fakeServer({ throwOnConnect: 'spawn failed' })
    await expect(request(SOCKET, 'ping', {}, { connect: server.connect })).rejects.toMatchObject({
      code: 'connect'
    })
  })

  it('calls a close before any reply `closed`, not a timeout', async () => {
    const server = fakeServer({ closeAfterScript: true })
    await expect(request(SOCKET, 'session.snapshot', {}, { connect: server.connect })).rejects.toMatchObject({
      code: 'closed'
    })
  })

  it('times out on a wedged server and says how long it waited', async () => {
    const server = fakeServer({ silent: true })
    const error = await request(SOCKET, 'agent.wait', {}, { connect: server.connect, timeoutMs: 25 }).catch(
      (caught: unknown) => caught
    )
    expect(error).toMatchObject({ code: 'timeout', method: 'agent.wait' })
    expect((error as HerdrError).message).toContain('25ms')
    expect(server.socket().destroyed).toBe(true)
    expect(DEFAULT_TIMEOUT_MS).toBe(5000)
  })

  it('skips garbage and event lines until the real reply shows up', async () => {
    const server = fakeServer({ silent: true })
    const pending = request(SOCKET, 'ping', {}, { connect: server.connect })
    await new Promise((resolve) => setTimeout(resolve, 5))
    server.socket().feed('not json at all\n')
    server.socket().sendLine({ event: 'pane.agent_status_changed', data: { pane_id: 'wA:p1' } })
    server.socket().sendLine({ hello: 'world' })
    server.socket().reply({ type: 'pong' })
    await expect(pending).resolves.toEqual({ type: 'pong' })
  })

  it('settles once: a close after a reply does not overwrite the answer', async () => {
    const server = fakeServer({ silent: true })
    const pending = request(SOCKET, 'ping', {}, { connect: server.connect })
    await new Promise((resolve) => setTimeout(resolve, 5))
    server.socket().reply({ type: 'pong' })
    server.socket().peerClose()
    await expect(pending).resolves.toEqual({ type: 'pong' })
  })
})

describe('subscribe', () => {
  it('asks for the whole lifecycle set and goes live on the ack', async () => {
    const server = fakeServer({ script: lines('events-status.ndjson') })
    const events: HerdrEvent[] = []
    let ready = 0
    const sub = subscribe(SOCKET, LIFECYCLE_SUBSCRIPTIONS, { onEvent: (e) => events.push(e), onReady: () => { ready += 1 } }, { connect: server.connect })
    expect(sub.live(), 'not live before the ack').toBe(false)
    await new Promise((resolve) => setImmediate(resolve))
    expect(sub.socketPath).toBe(SOCKET)
    expect(server.socket().params()).toEqual({ subscriptions: LIFECYCLE_SUBSCRIPTIONS })
    expect(ready).toBe(1)
    expect(sub.live()).toBe(true)
    // The recorded fixture is one ack plus four status changes for one pane.
    expect(events.map((event) => event.event)).toEqual(Array(4).fill('pane.agent_status_changed'))
    expect(events.map((event) => parseStatusChange(event.data)?.agentStatus)).toEqual([
      'working',
      'blocked',
      'idle',
      'unknown'
    ])
    sub.close()
    expect(sub.live()).toBe(false)
    expect(server.socket().destroyed).toBe(true)
  })

  it('keeps the stream open across many events instead of answering once', async () => {
    const server = fakeServer({ script: lines('events-stream.ndjson') })
    const events: HerdrEvent[] = []
    const sub = subscribe(SOCKET, LIFECYCLE_SUBSCRIPTIONS, { onEvent: (event) => events.push(event) }, {
      connect: server.connect
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toHaveLength(11)
    expect(sub.live()).toBe(true)
    expect(server.socket().ended, 'an event connection must not be torn down').toBe(false)
    // Lifecycle events arrive in herdr's snake_case spelling, not the dotted one
    // we subscribe with. The classification tables are keyed on what is actually
    // emitted, so pin the recording: a name that matches nothing costs the bench
    // its live tree, silently.
    expect(events.map((event) => event.event)).toEqual([
      'workspace_focused',
      'tab_focused',
      'pane_focused',
      'workspace_focused',
      'tab_focused',
      'pane_created',
      'pane_focused',
      'layout_updated',
      'pane_updated',
      'pane_closed',
      'layout_updated'
    ])
    for (const event of events) {
      const known =
        isStructuralEvent(event.event) || isStateEvent(event.event) || FOCUS_EVENTS.includes(event.event)
      expect(known, `${event.event} must be classified`).toBe(true)
    }
    // Every event keeps its payload: the patcher reads `pane`, `layout`, ids.
    expect(events[5].data.pane).toBeTruthy()
    expect(events[8].data.pane).toBeTruthy()
    expect(events[10].data.layout).toBeTruthy()
    sub.close()
  })

  it('reassembles events split across reads', async () => {
    const server = fakeServer({ script: lines('events-status.ndjson'), pieces: 4 })
    const events: HerdrEvent[] = []
    const sub = subscribe(SOCKET, LIFECYCLE_SUBSCRIPTIONS, { onEvent: (event) => events.push(event) }, {
      connect: server.connect
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(events).toHaveLength(4)
    expect(sub.live()).toBe(true)
    sub.close()
  })

  it('reports the peer going away as a close, and stops reporting after we close it', async () => {
    const server = fakeServer({ script: lines('events-status.ndjson') })
    const closes: string[] = []
    const sub = subscribe(SOCKET, LIFECYCLE_SUBSCRIPTIONS, { onEvent: () => undefined, onClose: (why) => closes.push(why) }, {
      connect: server.connect
    })
    await new Promise((resolve) => setImmediate(resolve))
    server.socket().peerClose()
    expect(closes).toEqual(['socket closed'])
    expect(sub.live()).toBe(false)
    // Our own close is not a transport failure and must not look like one.
    sub.close()
    server.socket().emit('close')
    expect(closes).toHaveLength(1)
    sub.close()
  })

  it('surfaces an error line from herdr with its own code', async () => {
    const server = fakeServer({ silent: true })
    const errors: HerdrError[] = []
    subscribe(SOCKET, LIFECYCLE_SUBSCRIPTIONS, { onEvent: () => undefined, onError: (error) => errors.push(error) }, {
      connect: server.connect
    })
    await new Promise((resolve) => setImmediate(resolve))
    server.socket().sendLine({ error: { code: 'not_subscribed', message: 'unknown event type' } })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'not_subscribed', method: 'events.subscribe' })
  })

  it('reports a connect failure asynchronously and stays inert', async () => {
    const server = fakeServer({ failConnect: 'ENOENT' })
    const errors: HerdrError[] = []
    const sub = subscribe(SOCKET, LIFECYCLE_SUBSCRIPTIONS, { onEvent: () => undefined, onError: (error) => errors.push(error) }, {
      connect: server.connect
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('connect')
    expect(sub.live()).toBe(false)
    expect(() => sub.close()).not.toThrow()
  })

  it('survives a connect() that throws, and a close() before anything happened', () => {
    const server = fakeServer({ throwOnConnect: 'no socket' })
    const errors: HerdrError[] = []
    const sub = subscribe(SOCKET, LIFECYCLE_SUBSCRIPTIONS, { onEvent: () => undefined, onError: (error) => errors.push(error) }, {
      connect: server.connect
    })
    expect(sub.live()).toBe(false)
    expect(() => sub.close()).not.toThrow()
    return Promise.resolve().then(() => {
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ code: 'connect', method: 'events.subscribe' })
    })
  })

  it('ignores garbage on the event stream rather than dropping the subscription', async () => {
    const server = fakeServer({ silent: true })
    const events: HerdrEvent[] = []
    const closes: string[] = []
    const sub = subscribe(SOCKET, LIFECYCLE_SUBSCRIPTIONS, {
      onEvent: (event) => events.push(event),
      onClose: (why) => closes.push(why)
    }, { connect: server.connect })
    await new Promise((resolve) => setImmediate(resolve))
    server.socket().feed('{truncated\n')
    server.socket().sendLine({ event: 'workspace.created', data: { workspace_id: 'wA' } })
    expect(events.map((event) => event.event)).toEqual(['workspace.created'])
    expect(events[0].data).toEqual({ workspace_id: 'wA' })
    expect(closes).toEqual([])
    expect(sub.live(), 'an unacked stream is not live even if it is talking').toBe(false)
    sub.close()
  })
})
