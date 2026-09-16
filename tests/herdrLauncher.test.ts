/**
 * The launcher, which is the half of "open the app after a reboot and it is
 * already working" that nobody else owns: herdr survives its own restarts, but
 * nothing on a rebooted machine starts the server, because the command a human
 * runs is a TUI.
 *
 * What has to be pinned here is the discipline around a detached child we
 * cannot watch: one spawn per backoff step (discovery runs on a timer and on
 * every settings change, and each of those must not become a process), a
 * ceiling with a sentence instead of an endless fork loop, a clean slate the
 * moment a socket appears, and the session/socket handed over through the
 * environment - `herdr server` has no flag form for either.
 */
import { describe, expect, it } from 'vitest'
import {
  HerdrLauncher,
  type ServerChild,
  type ServerSpawnOptions
} from '../src/main/pro/herdr/launcher'
import type { HerdrTarget } from '../src/main/pro/herdr/discovery'

const BINARY = '/usr/local/bin/herdr'
const SOCKET = '/tmp/codewaifu-launcher.sock'

interface SpawnCall {
  binary: string
  args: string[]
  options: ServerSpawnOptions
}

interface FakeChild extends ServerChild {
  listeners: Record<string, ((...args: never[]) => void)[]>
  unreffed: boolean
}

interface LaunchReq {
  target: HerdrTarget
  session: string
  socketPath: string
  env: Record<string, string | undefined>
}

function baseRequest(target: HerdrTarget): LaunchReq {
  return { target, session: '', socketPath: '', env: { PATH: '/usr/bin', HOME: '/home/wanlian' } }
}

function harness(maxAttempts = 4) {
  const calls: SpawnCall[] = []
  const children: FakeChild[] = []
  const logs: string[] = []
  let now = 1_700_000_000_000
  const spawn = (
    binary: string,
    args: readonly string[],
    options: ServerSpawnOptions
  ): ServerChild => {
    const child: FakeChild = {
      pid: 4000 + calls.length,
      unreffed: false,
      listeners: {},
      unref() {
        this.unreffed = true
      },
      on(event: string, listener: (...args: never[]) => void): void {
        ;(this.listeners[event] ??= []).push(listener)
      }
    }
    calls.push({ binary, args: [...args], options })
    children.push(child)
    return child
  }
  const launcher = new HerdrLauncher({
    spawn,
    timers: { now: () => now },
    // Meta is where the detail lives (`{ error }`, per the house logging
    // convention), so a capture that drops it cannot assert on a reason.
    log: (level, message, meta) => {
      logs.push(meta ? `${level}: ${message} ${JSON.stringify(meta)}` : `${level}: ${message}`)
    },
    maxAttempts,
    retryMs: 100,
    maxRetryMs: 400
  })
  const target = (over: Partial<HerdrTarget> = {}): HerdrTarget => ({
    binaryPath: BINARY,
    socketPath: '',
    session: '',
    childEnv: {},
    found: true,
    reason: 'ok',
    triedSockets: [SOCKET],
    triedBinaries: [BINARY],
    sessionsFound: [],
    ...over
  })
  const request = (over: Partial<LaunchReq> = {}): LaunchReq => ({
    ...baseRequest(target()),
    ...over
  })
  return {
    launcher,
    calls,
    children,
    logs,
    target,
    request,
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('HerdrLauncher', () => {
  it('spawns once per backoff step, detached and unrefd, with args server', () => {
    const h = harness()
    expect(h.launcher.ensure(h.request())).toBe(true)
    // Discovery probing again inside the backoff window is not a second process.
    expect(h.launcher.ensure(h.request())).toBe(false)
    expect(h.calls).toHaveLength(1)

    const call = h.calls[0]
    expect(call.binary).toBe(BINARY)
    expect(call.args).toEqual(['server'])
    expect(call.options.detached).toBe(true)
    expect(call.options.stdio).toBe('ignore')
    expect(h.children[0].unreffed).toBe(true)
    expect(h.launcher.serverPid).toBe(4000)

    // retryMs is 100: one step later the next probe is allowed to try again.
    h.advance(100)
    expect(h.launcher.ensure(h.request())).toBe(true)
    expect(h.calls).toHaveLength(2)
  })

  it('doubles the wait between attempts, up to the ceiling', () => {
    const h = harness(8)
    const at: number[] = []
    let now = 0
    // t=0 attempt 1; the window before attempt 2 is retryMs * 2^0.
    if (h.launcher.ensure(h.request())) at.push(now)
    for (let t = 1; t <= 1600; t += 1) {
      now = t
      h.advance(1)
      if (h.launcher.ensure(h.request())) at.push(now)
    }
    const gaps = at.slice(1).map((value, index) => value - at[index])
    expect(gaps[0]).toBe(100)
    expect(gaps[1]).toBe(200)
    expect(gaps[2]).toBe(400)
    // maxRetryMs: the fourth gap would be 800 and is held at the ceiling.
    expect(gaps[3]).toBe(400)
  })

  it('hands the session and an explicit socket over through the environment', () => {
    const h = harness()
    h.launcher.ensure(h.request({ session: 'cwfix', socketPath: SOCKET }))
    const env = h.calls[0].options.env
    expect(env.HERDR_SESSION).toBe('cwfix')
    expect(env.HERDR_SOCKET_PATH).toBe(SOCKET)
    expect(env.PATH).toBe('/usr/bin')
    // Undefined parent entries must not arrive as the string "undefined".
    expect(Object.values(env).every((value) => typeof value === 'string')).toBe(true)
  })

  it('stops at the ceiling and says where the log is', () => {
    const h = harness(2)
    expect(h.launcher.ensure(h.request())).toBe(true)
    h.advance(100)
    expect(h.launcher.ensure(h.request())).toBe(true)
    h.advance(200)
    expect(h.launcher.ensure(h.request())).toBe(false)
    expect(h.calls).toHaveLength(2)
    expect(h.launcher.exhausted).toBe(true)
    expect(h.logs.some((line) => line.startsWith('warn: pro: gave up starting herdr'))).toBe(true)

    const en = h.launcher.describe('en', h.target())
    expect(en).toContain('tried to start herdr 2 times')
    expect(en).toContain('log: /tmp/herdr-server.log')
    const zh = h.launcher.describe('zh', h.target())
    expect(zh).toContain('已尝试启动 herdr 2 次')
  })

  it('says nothing before it has tried anything', () => {
    const h = harness()
    expect(h.launcher.describe('en', h.target())).toBe('')
    expect(h.launcher.describe('zh', h.target())).toBe('')
    // A box with no binary is not ours to start: no spawn, no sentence.
    expect(h.launcher.ensure(h.request({ target: h.target({ binaryPath: '' }) }))).toBe(false)
    expect(h.calls).toHaveLength(0)
  })

  it('a socket appearing clears the slate, and the card says starting while not', () => {
    const h = harness(2)
    h.launcher.ensure(h.request())
    expect(h.launcher.describe('en', h.target())).toContain('starting herdr server (attempt 1)')
    expect(h.launcher.describe('zh', h.target())).toContain('正在启动 herdr server（第 1 次尝试）')

    // herdr came up (somebody else, or our own child): history is stale.
    expect(h.launcher.ensure(h.request({ target: h.target({ socketPath: SOCKET }) }))).toBe(false)
    expect(h.launcher.attemptCount).toBe(0)
    expect(h.launcher.exhausted).toBe(false)
    expect(h.calls).toHaveLength(1)
  })

  it('a spawn that throws is a logged failure, not a thrown one', () => {
    const logs: string[] = []
    const launcher = new HerdrLauncher({
      spawn: () => {
        throw new Error('EACCES')
      },
      log: (level, message, meta) => {
        logs.push(meta ? `${level}: ${message} ${JSON.stringify(meta)}` : `${level}: ${message}`)
      },
      retryMs: 0
    })
    const target: HerdrTarget = {
      binaryPath: BINARY,
      socketPath: '',
      session: '',
      childEnv: {},
      found: true,
      reason: 'ok',
      triedSockets: [SOCKET],
      triedBinaries: [BINARY],
      sessionsFound: []
    }
    const spawned = launcher.ensure({ target, session: '', socketPath: '', env: {} })
    expect(spawned).toBe(false)
    expect(logs.some((line) => line.includes('EACCES'))).toBe(true)
  })

  it('a child that exits before taking the socket becomes the reason', () => {
    const h = harness()
    h.launcher.ensure(h.request())
    const child = h.children[0]
    for (const listener of child.listeners.exit ?? []) listener(1 as never, null as never)
    h.advance(100)
    h.launcher.ensure(h.request())
    expect(h.launcher.describe('en', h.target())).toContain('exited with code 1')
  })

  it('the reason is localized, and a signal is named instead of coded', () => {
    const h = harness()
    h.launcher.ensure(h.request())
    const child = h.children[0]
    for (const listener of child.listeners.exit ?? []) listener(null as never, 'SIGKILL' as never)
    // The card is bilingual, so the Chinese one must not carry an English clause.
    expect(h.launcher.describe('zh', h.target())).toContain('被信号 SIGKILL 终止')
    expect(h.launcher.describe('zh', h.target())).not.toContain('before taking the socket')
    expect(h.launcher.describe('en', h.target())).toContain('exited on SIGKILL')
  })
})
