#!/usr/bin/env node
/**
 * Record real herdr traffic into tests/fixtures/herdr so the Pro client, the
 * event stream and the terminal bridge are all tested against bytes a live
 * server actually produced.
 *
 * Nothing here is a mock: the script talks to a running herdr session, mutates
 * it (create workspace, split pane, focus, close), records what comes back, and
 * restores the session to the shape it started with. Run it after any herdr
 * upgrade — protocol drift shows up here first, and a fixture that no longer
 * matches the server is a test that is lying.
 *
 *   node scripts/capture-herdr-fixtures.mjs --session cwfix
 *   node scripts/capture-herdr-fixtures.mjs --binary ~/.local/bin/herdr --out tests/fixtures/herdr
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
function flag(name, fallback) {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}

const session = flag('--session', process.env.HERDR_SESSION || 'cwfix')
const binary = path.resolve(flag('--binary', path.join(os.homedir(), '.local/bin/herdr')))
const outDir = path.resolve(flag('--out', 'tests/fixtures/herdr'))
const socketPath =
  flag('--socket', process.env.HERDR_SOCKET_PATH || '') ||
  path.join(os.homedir(), '.config/herdr/sessions', session, 'herdr.sock')

/**
 * The lifecycle set Pro keeps open on its stable connection. These are exactly
 * the subscriptions that take no parameters: `pane.agent_status_changed`,
 * `pane.output_matched` and `pane.scroll_changed` all require a `pane_id` (or a
 * match) and belong to the per-pane status connection instead. Getting that
 * wrong is not a warning — herdr rejects the whole request with
 * `invalid_request: missing field pane_id`.
 */
const LIFECYCLE = [
  'workspace.created',
  'workspace.updated',
  'workspace.closed',
  'workspace.renamed',
  'workspace.focused',
  'worktree.created',
  'tab.created',
  'tab.closed',
  'tab.focused',
  'pane.created',
  'pane.closed',
  'pane.updated',
  'pane.focused',
  'pane.exited',
  'pane.agent_detected',
  'layout.updated'
].map((type) => ({ type }))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function write(name, body) {
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, name)
  fs.writeFileSync(file, body)
  console.log(`wrote ${path.relative(process.cwd(), file)} (${Buffer.byteLength(body)} bytes)`)
}

function herdr(args, options = {}) {
  const result = spawnSync(binary, args, {
    env: { ...process.env, HERDR_SESSION: session },
    encoding: 'utf8',
    timeout: options.timeout ?? 20000
  })
  if (result.status !== 0) {
    throw new Error(`herdr ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

/** One NDJSON connection: write a request, collect lines until the socket ends. */
function callOnce(method, params, { keepOpen = false, onLine, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const lines = []
    const socket = net.createConnection(socketPath)
    let buffer = ''
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(lines)
    }
    const timer = setTimeout(() => {
      if (keepOpen) finish()
      else reject(new Error(`${method}: timed out waiting for a reply`))
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: `capture:${method}`, method, params: params ?? {} })}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      let at = buffer.indexOf('\n')
      while (at >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, '')
        buffer = buffer.slice(at + 1)
        if (line.trim()) {
          lines.push(line)
          onLine?.(line)
        }
        at = buffer.indexOf('\n')
      }
    })
    socket.on('error', reject)
    if (!keepOpen) socket.on('end', finish)
  })
}

/** Spawn the terminal bridge, drive it, and keep every line it emits. */
function captureTerminal(target, { cols = 60, rows = 12, timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const lines = []
    const child = spawn(binary, ['terminal', 'session', 'control', target, '--cols', String(cols), '--rows', String(rows)], {
      env: { ...process.env, HERDR_SESSION: session },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let at = buffer.indexOf('\n')
      while (at >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, '')
        buffer = buffer.slice(at + 1)
        if (line.trim()) lines.push(line)
        at = buffer.indexOf('\n')
      }
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      try {
        child.stdin.write(`${JSON.stringify({ type: 'terminal.release' })}\n`)
      } catch {
        /* already gone */
      }
      child.kill('SIGTERM')
      resolve(lines)
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdin.write(`${JSON.stringify({ type: 'terminal.resize', cols, rows, cell_width_px: 0, cell_height_px: 0 })}\n`)
    // Something that repaints, so the fixture carries more than one frame.
    child.stdin.write(`${JSON.stringify({ type: 'terminal.input', text: 'echo codewaifu-fixture\r' })}\n`)
  })
}

/** Everything this script creates is labelled `fixture-*`, so it is findable. */
function fixtureWorkspaces() {
  const snapshot = JSON.parse(herdr(['api', 'snapshot']))
  return (snapshot.result?.snapshot?.workspaces ?? []).filter((workspace) =>
    /^fixture-/.test(workspace.label ?? '')
  )
}

function closeFixtures() {
  for (const workspace of fixtureWorkspaces()) {
    try {
      herdr(['workspace', 'close', workspace.workspace_id])
    } catch (error) {
      console.warn(`could not close ${workspace.workspace_id}: ${error.message}`)
    }
  }
}

async function main() {
  console.log(`herdr ${binary}\nsession ${session}\nsocket  ${socketPath}`)
  const status = herdr(['status'])
  if (!/status:\s*running/.test(status)) throw new Error(`herdr is not running:\n${status}`)

  // 0. A crashed earlier run leaves `fixture-*` workspaces behind, and two
  //    workspaces sharing a label makes every by-label lookup in the tests
  //    ambiguous. Clean before capturing, not only after.
  closeFixtures()

  // 1. The whole-session snapshot, exactly as the CLI prints it.
  const raw = herdr(['api', 'snapshot'])
  write('snapshot-live.raw.json', raw)
  write('snapshot-live.json', `${JSON.stringify(JSON.parse(raw), null, 2)}\n`)

  // 2. A multi-workspace snapshot: two roots, one with a split pane. This is
  //    the shape the bench tree groups by, so it has to be a real one.
  fs.mkdirSync('/tmp/codewaifu-fixture/a', { recursive: true })
  fs.mkdirSync('/tmp/codewaifu-fixture/b', { recursive: true })
  herdr(['workspace', 'create', '--cwd', '/tmp/codewaifu-fixture/a', '--label', 'fixture-a'])
  herdr(['workspace', 'create', '--cwd', '/tmp/codewaifu-fixture/b', '--label', 'fixture-b'])
  await sleep(300)
  const multi = herdr(['api', 'snapshot'])
  write('snapshot-multi.json', `${JSON.stringify(JSON.parse(multi), null, 2)}\n`)

  // 3. The event stream. Open the subscription first, then mutate, so every
  //    line in the fixture was pushed rather than asked for.
  const eventLines = []
  const stream = callOnce('events.subscribe', { subscriptions: LIFECYCLE }, {
    keepOpen: true,
    timeoutMs: 5000,
    onLine: (line) => eventLines.push(line)
  })
  await sleep(600)
  const snapshot = JSON.parse(multi)
  const targetWorkspace = snapshot.result?.snapshot?.workspaces?.find((w) => w.label === 'fixture-a')
  const targetPane = snapshot.result?.snapshot?.panes?.find((p) => p.workspace_id === targetWorkspace?.workspace_id)
  if (targetPane) {
    // Every mutation here is chosen to produce a distinct event name, so the
    // fixture exercises the lifecycle, the stateful and the layout channels.
    herdr(['workspace', 'focus', targetWorkspace.workspace_id])
    await sleep(250)
    herdr(['pane', 'split', targetPane.pane_id, '--direction', 'down', '--focus'])
    await sleep(350)
    const split = JSON.parse(herdr(['api', 'snapshot']))
    const newPane = (split.result?.snapshot?.panes ?? [])
      .filter((p) => p.workspace_id === targetWorkspace.workspace_id && p.pane_id !== targetPane.pane_id)
      .at(-1)
    herdr(['pane', 'send-text', targetPane.pane_id, 'echo codewaifu-events\r'])
    await sleep(250)
    herdr(['pane', 'rename', targetPane.pane_id, 'fixture-pane'])
    await sleep(250)
    if (newPane) {
      herdr(['pane', 'close', newPane.pane_id])
      await sleep(350)
    }
  }
  await stream
  write('events-stream.ndjson', `${eventLines.join('\n')}\n`)

  // 4. The per-pane status stream. `pane.agent_status_changed` needs a
  //    `pane_id`, so it lives on its own connection — and the only way to see
  //    one without a real agent is to report agent state the way an integration
  //    does. `report-agent` is also what puts `agent_session` on a pane, which
  //    is the field recovery depends on, so this capture doubles as the
  //    resumable-task fixture.
  if (targetPane) {
    const statusLines = []
    const statusStream = callOnce(
      'events.subscribe',
      {
        // Only subscriptions that take a pane_id: herdr rejects unknown fields,
        // so the parameterless `pane.agent_detected` cannot ride along here.
        subscriptions: [{ type: 'pane.agent_status_changed', pane_id: targetPane.pane_id }]
      },
      { keepOpen: true, timeoutMs: 4000, onLine: (line) => statusLines.push(line) }
    )
    await sleep(500)
    const reportArgs = [
      'pane',
      'report-agent',
      targetPane.pane_id,
      '--source',
      'codewaifu-capture',
      '--agent',
      'codex'
    ]
    herdr([...reportArgs, '--state', 'working', '--agent-session-id', 'fixture-session-01'])
    await sleep(300)
    herdr([...reportArgs, '--state', 'blocked', '--message', 'Allow command? (y/n)'])
    await sleep(300)
    const withAgent = herdr(['api', 'snapshot'])
    write('snapshot-agent.json', `${JSON.stringify(JSON.parse(withAgent), null, 2)}\n`)
    // `report-agent` accepts idle|working|blocked|unknown only; `done` is a
    // status herdr derives itself when an agent exits.
    herdr([...reportArgs, '--state', 'idle'])
    await sleep(300)
    herdr(['pane', 'release-agent', targetPane.pane_id, '--source', 'codewaifu-capture', '--agent', 'codex'])
    await sleep(300)
    await statusStream
    write('events-status.ndjson', `${statusLines.join('\n')}\n`)
  }

  // 5. Terminal bridge frames for a real pane.
  if (targetPane) {
    const bridgeLines = await captureTerminal(targetPane.pane_id)
    write('terminal-bridge.ndjson', `${bridgeLines.join('\n')}\n`)
  }

  // 6. Leave the session as we found it: the fixture workspaces go away.
  closeFixtures()
  const after = herdr(['api', 'snapshot'])
  write('snapshot-live.json', `${JSON.stringify(JSON.parse(after), null, 2)}\n`)
  console.log('done')
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
