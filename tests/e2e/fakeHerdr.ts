/**
 * A real herdr, faked at the socket.
 *
 * `tests/helpers/herdrSocket.ts` fakes the transport *inside* the process by
 * handing the client a stub `connect`. That is the right tool for framing and
 * timeout tests and useless here: the smoke test launches the built bundle as a
 * separate Electron process, so the only thing it can be given is a path. This
 * is a real `net` server on a real unix socket speaking the same NDJSON -
 * `{id, method, params}` in, `{id, result}` out, with `events.subscribe` left
 * open the way a live stream is.
 *
 * What it deliberately does not fake is the `herdr terminal session control`
 * child, because a pane would spawn a real process against a socket that cannot
 * answer it. So the snapshot served here has no panes, and the task the smoke
 * test seeds has none either. The smoke asserts that the bundled document
 * paints and that main reached herdr; attaching a terminal is `proBridge`'s job.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** What `parseSnapshot` needs to not return null: a version, or a pane. */
export const E2E_HERDR_VERSION = '0.9.0-e2e'

const SNAPSHOT = {
  version: E2E_HERDR_VERSION,
  protocol: 22,
  workspaces: [
    {
      workspace_id: 'w1',
      number: 1,
      label: 'e2e',
      focused: true,
      pane_count: 0,
      tab_count: 0,
      active_tab_id: '',
      agent_status: 'unknown'
    }
  ],
  tabs: [],
  panes: [],
  agents: [],
  layouts: [],
  focused_workspace_id: 'w1',
  focused_tab_id: '',
  focused_pane_id: ''
}

export interface FakeHerdr {
  readonly socketPath: string
  /** Every method the app asked for, in arrival order. Duplicates kept. */
  readonly methods: string[]
  close: () => Promise<void>
}

/**
 * Listen on a fresh unix socket in a temp dir.
 *
 * The dir is per-run and removed on close: two smoke runs at once must not
 * share a socket, and a stale socket file is an EADDRINUSE that reads like a
 * bug in the app.
 */
export async function startFakeHerdr(): Promise<FakeHerdr> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-e2e-herdr-'))
  const socketPath = path.join(dir, 'herdr.sock')
  const methods: string[] = []
  const sockets = new Set<net.Socket>()

  const server = net.createServer((socket) => {
    sockets.add(socket)
    // A peer that vanishes mid-call is normal (the app closes streams on
    // quit); an unhandled 'error' here would take the test process with it.
    socket.on('error', () => undefined)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let cut = buffer.indexOf('\n')
      while (cut >= 0) {
        const line = buffer.slice(0, cut).trim()
        buffer = buffer.slice(cut + 1)
        cut = buffer.indexOf('\n')
        if (line) answer(socket, line)
      }
    })
  })

  function answer(socket: net.Socket, line: string): void {
    let request: { id?: unknown; method?: unknown; params?: unknown }
    try {
      request = JSON.parse(line)
    } catch {
      return
    }
    const id = typeof request.id === 'string' ? request.id : ''
    const method = typeof request.method === 'string' ? request.method : ''
    methods.push(method)
    socket.write(`${JSON.stringify({ id, result: resultFor(method) })}\n`)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })

  return {
    socketPath,
    methods,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

function resultFor(method: string): Record<string, unknown> {
  switch (method) {
    case 'ping':
      return { type: 'pong', version: E2E_HERDR_VERSION, protocol: 22, capabilities: [] }
    case 'session.snapshot':
      return { type: 'snapshot', snapshot: SNAPSHOT }
    case 'workspace.list':
      return { type: 'ok', workspaces: SNAPSHOT.workspaces }
    case 'agent.list':
      return { type: 'ok', agents: [] }
    case 'events.subscribe':
      // The ack is what flips the session to 'live'; the stream itself then
      // stays open and silent, which is a healthy idle herdr.
      return { type: 'ok', subscribed: true }
    default:
      return { type: 'ok' }
  }
}
