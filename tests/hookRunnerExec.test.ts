import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { portAttempts } from '../src/shared/portPolicy'
import { renderHookSh } from '../src/shared/hookScript'
import { createTestRelay, type TestRelay } from './helpers/relay'

// ============================================================
// The runner is a shell script we generate as a string, so unit assertions on
// that string cannot catch shell semantics. This suite actually executes it
// with /bin/sh against a real relay and checks the bytes that arrive.
//
// It exists because of a real bug: `--data-binary "${BODY:-{}}"` looks correct
// and reads correctly, but POSIX ends a `${...}` expansion at the first `}`,
// so every non-empty payload went out with a stray trailing brace. The relay
// parsed it as `{}`, logged an empty event and stayed green. Only running the
// script shows it.
// ============================================================

const TOKEN = 'test-token-0123456789abcdef'
const canRun = process.platform !== 'win32' && fs.existsSync('/bin/sh') && Boolean(spawnSync('curl', ['--version']).status === 0)

let relays: TestRelay[] = []
const tmpDirs: string[] = []

async function startRelay(): Promise<TestRelay> {
  const relay = createTestRelay({ token: TOKEN })
  await relay.server.start(portAttempts({ pinned: 0, sticky: relay.config.port }))
  relays.push(relay)
  return relay
}

function makeHome(port: number): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-runner-'))
  tmpDirs.push(home)
  fs.writeFileSync(
    path.join(home, 'endpoint.env'),
    [
      '# test endpoint file',
      `CODEWAIFU_PORT=${port}`,
      `CODEWAIFU_TOKEN="${TOKEN}"`,
      `CODEWAIFU_BASE="http://127.0.0.1:${port}"`,
      ''
    ].join('\n')
  )
  const script = path.join(home, 'run-hook.sh')
  fs.writeFileSync(script, renderHookSh(), { mode: 0o755 })
  return home
}

/**
 * Run the generated script.
 *
 * ⛔ Async, not `spawnSync`: the relay under test lives in this same process,
 * and a synchronous wait blocks the event loop, so curl's /health probe can
 * never be answered and the runner correctly (and invisibly) bails. Every
 * assertion in this file would then pass vacuously or time out.
 */
function run(home: string, agent: string, stdin: string, env: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', [path.join(home, 'run-hook.sh'), agent], {
      env: { ...process.env, CODEWAIFU_HOME: home, ...env },
      stdio: ['pipe', 'ignore', 'ignore']
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    timer.unref?.()
    child.once('error', () => {
      clearTimeout(timer)
      resolve(-1)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code ?? -1)
    })
    child.stdin?.once('error', () => undefined)
    child.stdin?.end(stdin)
  })
}

/** Wait for the relay to record `n` events (the runner posts asynchronously). */
async function waitForEvents(relay: TestRelay, n: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (relay.recorded.events.length >= n) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

afterEach(async () => {
  for (const relay of relays) await relay.shutdown()
  relays = []
})

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
  tmpDirs.length = 0
})

describe.runIf(canRun)('generated run-hook.sh, executed', () => {
  it('delivers the payload byte-for-byte, braces and all', async () => {
    const relay = await startRelay()
    const home = makeHome(relay.port)
    const payload = JSON.stringify({
      session_id: 'exec-001',
      hook_event_name: 'SessionStart',
      cwd: '/tmp/project',
      source: 'startup',
      tool_input: { command: 'git status --short' }
    })

    expect(await run(home, 'codex', payload)).toBe(0)
    await waitForEvents(relay, 1)

    expect(relay.recorded.events).toHaveLength(1)
    const event = relay.recorded.events[0]
    expect(event.rawEvent).toBe('SessionStart')
    expect(event.kind).toBe('session_start')
    expect(event.agent).toBe('codex')
    expect(event.sessionId).toBe('exec-001')
    expect(event.cwd).toBe('/tmp/project')
    expect(event.matcher).toBe('startup')
  })

  it('keeps nested braces intact: a JSON body full of {} must survive', async () => {
    const relay = await startRelay()
    const home = makeHome(relay.port)
    const payload = JSON.stringify({
      session_id: 'exec-002',
      hook_event_name: 'Notification',
      message: 'waiting for your input {}',
      nested: { a: { b: { c: '}' } } }
    })

    expect(await run(home, 'claude', payload)).toBe(0)
    await waitForEvents(relay, 1)

    const event = relay.recorded.events[0]
    expect(event.agent).toBe('claude')
    expect(event.kind).toBe('notification')
    expect(event.sourceText).toBe('waiting for your input {}')
  })

  it('says which pane it ran in, and nothing at all outside herdr', async () => {
    const relay = await startRelay()
    const home = makeHome(relay.port)
    const payload = JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'exec-pane',
      cwd: '/tmp/project'
    })

    expect(await run(home, 'codex', payload, { HERDR_PANE_ID: 'w5:p1' })).toBe(0)
    await waitForEvents(relay, 1)
    expect(relay.recorded.events[0].paneId).toBe('w5:p1')

    // A plain terminal has no pane to report. The header still goes out, empty,
    // which is the honest "I do not know" the bench falls back on - and the
    // runner must not fail just because the variable is unset.
    expect(await run(home, 'codex', payload, { HERDR_PANE_ID: '' })).toBe(0)
    await waitForEvents(relay, 2)
    expect(relay.recorded.events).toHaveLength(2)
    expect(relay.recorded.events[1].paneId).toBe('')
  })

  it('sends an empty object when the agent gives no stdin', async () => {
    const relay = await startRelay()
    const home = makeHome(relay.port)

    expect(await run(home, 'codex', '')).toBe(0)
    await waitForEvents(relay, 1)

    expect(relay.recorded.events).toHaveLength(1)
    expect(relay.recorded.events[0].kind).toBe('other')
  })

  it('exits 0 and sends nothing when the port is owned by someone else', async () => {
    const relay = await startRelay()
    const home = makeHome(relay.port)
    // Point the runner at a closed port: the /health preflight must stop it.
    fs.writeFileSync(
      path.join(home, 'endpoint.env'),
      ['CODEWAIFU_PORT=1', `CODEWAIFU_TOKEN="${TOKEN}"`, 'CODEWAIFU_BASE="http://127.0.0.1:1"', ''].join('\n')
    )

    expect(await run(home, 'codex', '{"hook_event_name":"Stop"}')).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(relay.recorded.events).toHaveLength(0)
  })

  it('exits 0 when endpoint.env is missing entirely', async () => {
    const relay = await startRelay()
    const home = makeHome(relay.port)
    fs.unlinkSync(path.join(home, 'endpoint.env'))

    expect(await run(home, 'codex', '{"hook_event_name":"Stop"}')).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(relay.recorded.events).toHaveLength(0)
  })
})
