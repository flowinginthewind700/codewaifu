import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { parseConfig, type AppConfig } from '../../src/shared/config'
import { EMPTY_MEDIA, type MediaState } from '../../src/shared/media'
import type { HookEvent, RuntimeState, SteerResult, ThreadInfo } from '../../src/shared/protocol'
import { HookServer, type ProApi, type ServerDeps } from '../../src/main/server'

export interface Recorded {
  events: HookEvent[]
  said: Array<{ text: string; lang: 'zh' | 'en' }>
  shown: number
  patches: unknown[]
  steers: Array<{ agent: string; threadId: string; message: string }>
  mediaCommands: string[]
}

/** One live NDJSON response, as a test sees it. */
export interface TestStream {
  status: number
  /** Frames parsed so far, in arrival order. */
  frames: Array<Record<string, unknown>>
  /** True once the relay ended the response or the socket went away. */
  ended: boolean
  /**
   * The next frame after `after` (default: the ones already in). Rejects rather
   * than hangs, because "no frame arrived" *is* the failure, and a test that
   * times out cannot say which frame it was waiting for.
   */
  next(after?: number, timeoutMs?: number): Promise<Record<string, unknown>>
  /** Settles when the response is over, however it ended. */
  done: Promise<void>
  close(): Promise<void>
}

export interface TestRelay {
  server: HookServer
  config: AppConfig
  recorded: Recorded
  port: number
  base: string
  get(path: string, token?: string): Promise<{ status: number; body: string; json: unknown }>
  post(path: string, payload: unknown, token?: string): Promise<{ status: number; body: string; json: unknown }>
  request(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }>
  /**
   * Open a push route and hand back its frames as they land.
   *
   * Deliberately not built on `streamNdjson` in main/probe: the client and the
   * route are two halves of one contract, and a test that reads the stream with
   * the production client cannot say which half broke. The CLI round trip in
   * `tests/proCli.test.ts` is where the two meet.
   */
  stream(path: string, token?: string): Promise<TestStream>
  shutdown(): Promise<void>
}

/**
 * A relay wired to in-memory stubs, so tests exercise the real HTTP routes.
 *
 * `pro` defaults to "the bench is off" (`null`), which is what `/pro/*` answers
 * 503 for; pass a fake from `tests/helpers/pro.ts` to exercise those routes.
 */
export function createTestRelay(
  patch?: Partial<AppConfig>,
  pro: () => ProApi | null = () => null
): TestRelay {
  const config = parseConfig({ token: 'test-token-0123456789abcdef', ...patch })
  const recorded: Recorded = { events: [], said: [], shown: 0, patches: [], steers: [], mediaCommands: [] }

  const runtimeState = (): RuntimeState => ({
    version: '9.9.9-test',
    relay: {
      port: server.listeningPort,
      requested: config.port,
      pinned: false,
      reason: server.bindReason,
      boot: server.boot,
      endpointFile: '/tmp/endpoint.env',
      conflict: null,
      duplicateOf: 0
    },
    speaking: false,
    queueLength: 0,
    hooks: {
      codex: { path: '/codex/hooks.json', installed: false, events: [] },
      claude: { path: '/claude/settings.json', installed: false, events: [] },
      runnerInstalled: false,
      codexTrustNeeded: false
    },
    agents: { codex: false, claude: false },
    voices: [],
    // The relay never synthesizes; this is the shape the widget expects.
    neural: { phase: 'unavailable', received: 0, total: 0, file: '', error: '', dir: '', sampleRate: 0, loadMs: 0 },
    systemLang: 'zh'
  })

  const deps: ServerDeps = {
    getConfig: () => config,
    setConfig: async (next) => {
      recorded.patches.push(next)
      return config
    },
    onEvent: (event) => recorded.events.push(event),
    onSay: (text, lang) => recorded.said.push({ text, lang }),
    onShow: () => {
      recorded.shown += 1
    },
    runtimeState,
    listThreads: async (): Promise<ThreadInfo[]> => [],
    steer: async (agent, threadId, message): Promise<SteerResult> => {
      recorded.steers.push({ agent, threadId, message })
      return { ok: true, method: 'queue', message: 'queued' }
    },
    mediaState: async (): Promise<MediaState> => EMPTY_MEDIA,
    mediaCommand: async (command) => {
      recorded.mediaCommands.push(command)
      return EMPTY_MEDIA
    },
    pro
  }

  const server = new HookServer(deps)
  server.setIdentity({ boot: 'testboot', pid: process.pid, version: '9.9.9-test' })

  const request = (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string
  ): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const port = server.listeningPort
      const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })

  const parse = async (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string
  ): Promise<{ status: number; body: string; json: unknown }> => {
    const raw = await request(method, path, headers, body)
    let json: unknown = null
    try {
      json = JSON.parse(raw.body)
    } catch {
      json = null
    }
    return { ...raw, json }
  }

  const stream = (path: string, token?: string): Promise<TestStream> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = token ? { 'x-codewaifu-token': token } : {}
      const req = http.request(
        { host: '127.0.0.1', port: server.listeningPort, path, method: 'GET', headers },
        (res) => {
          const frames: Array<Record<string, unknown>> = []
          /** A waiter returns true once it has settled, and is then dropped. */
          const waiters: Array<{ wake: () => boolean }> = []
          let buffer = ''
          let ended = false
          let finishDone!: () => void
          const done = new Promise<void>((settle) => {
            finishDone = settle
          })

          const wake = (): void => {
            for (const waiter of [...waiters]) {
              if (waiter.wake()) waiters.splice(waiters.indexOf(waiter), 1)
            }
          }
          const finish = (): void => {
            if (ended) return
            ended = true
            wake()
            finishDone()
          }

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
                frames.push(JSON.parse(line) as Record<string, unknown>)
              } catch {
                /* a frame torn by the close; the route is not on trial for it */
              }
            }
            wake()
          })
          res.on('end', finish)
          res.on('error', finish)
          res.on('close', finish)

          resolve({
            get status(): number {
              return res.statusCode || 0
            },
            frames,
            get ended(): boolean {
              return ended
            },
            next: (after = frames.length, timeoutMs = 2000) =>
              new Promise<Record<string, unknown>>((got, fail) => {
                const waiter = {
                  wake: (): boolean => {
                    if (frames.length > after) {
                      clearTimeout(timer)
                      got(frames[after])
                      return true
                    }
                    if (ended) {
                      clearTimeout(timer)
                      fail(new Error(`the stream ended before frame ${after + 1}`))
                      return true
                    }
                    return false
                  }
                }
                const timer = setTimeout(() => {
                  waiters.splice(waiters.indexOf(waiter), 1)
                  fail(new Error(`no frame ${after + 1} within ${timeoutMs}ms (have ${frames.length})`))
                }, timeoutMs)
                timer.unref?.()
                if (waiter.wake()) return
                waiters.push(waiter)
              }),
            done,
            close: async () => {
              req.destroy()
              await done
            }
          })
        }
      )
      req.on('error', reject)
      req.end()
    })

  return {
    server,
    config,
    recorded,
    get port(): number {
      return server.listeningPort
    },
    get base(): string {
      return `http://127.0.0.1:${server.listeningPort}`
    },
    get: (path, token) => parse('GET', path, token ? { 'x-codewaifu-token': token } : {}),
    post: (path, payload, token) =>
      parse(
        'POST',
        path,
        { 'content-type': 'application/json', ...(token ? { 'x-codewaifu-token': token } : {}) },
        JSON.stringify(payload)
      ),
    request,
    stream,
    shutdown: async () => {
      await server.stopAsync(500)
    }
  }
}

/** Occupy a loopback port so a bind attempt against it must fail. */
export function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const blocker = http.createServer((_req, res) => res.end('not codewaifu'))
    blocker.once('error', reject)
    blocker.listen(0, '127.0.0.1', () => {
      const address = blocker.address() as AddressInfo
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            blocker.closeAllConnections?.()
            blocker.close(() => done())
          })
      })
    })
  })
}
