import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { parseConfig, type AppConfig } from '../../src/shared/config'
import { EMPTY_MEDIA, type MediaState } from '../../src/shared/media'
import type { HookEvent, RuntimeState, SteerResult, ThreadInfo } from '../../src/shared/protocol'
import { HookServer, type ServerDeps } from '../../src/main/server'

export interface Recorded {
  events: HookEvent[]
  said: Array<{ text: string; lang: 'zh' | 'en' }>
  shown: number
  patches: unknown[]
  steers: Array<{ agent: string; threadId: string; message: string }>
  mediaCommands: string[]
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
  shutdown(): Promise<void>
}

/** A relay wired to in-memory stubs, so tests exercise the real HTTP routes. */
export function createTestRelay(patch?: Partial<AppConfig>): TestRelay {
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
    voices: []
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
    }
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
