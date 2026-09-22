import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  isOurPluginFile,
  OPENCODE_PLUGIN_EVENTS,
  PI_EXTENSION_EVENTS,
  PLUGIN_MARKER,
  renderOpencodePlugin,
  renderPiExtension
} from '../src/shared/agentPlugins'
import { renderPluginFile, type PluginAgent } from '../src/main/hooksInstaller'
import { kindForEvent } from '../src/shared/hookEvent'
import { HEALTH_MARKER } from '../src/shared/endpoint'
import { portAttempts } from '../src/shared/portPolicy'
import { createTestRelay, occupyPort, type TestRelay } from './helpers/relay'

// ============================================================
// OpenCode and Pi have no hook config, so CodeWaifu writes them a plugin file
// instead. That file is generated text we cannot lint, typecheck or import from
// here as part of the app build, and it runs inside *the user's agent*: a typo
// in a field name is a silent hole in the timeline, and a throw is a crash in
// somebody else's CLI.
//
// So this suite does both halves. The text half pins the contracts a reader
// cannot verify by looking (exactly one export, byte-stable renders, the health
// gate, never writing to a decision the agent handed us). The executed half
// imports the generated file in a real child process, drives it with the
// payloads OpenCode and Pi actually pass, and checks what arrives at a live
// relay - the same approach `hookRunnerExec.test.ts` takes for run-hook.sh, for
// the same reason: only running it shows that `"app":"codewaifu"` and
// `hook_event_name` survive the trip.
// ============================================================

const OPENCODE = renderOpencodePlugin()
const PI = renderPiExtension()

const TOKEN = 'test-token-0123456789abcdef'

/** The app's own version, so "byte-stable" can be checked against a real stamp. */
const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version as string

const tmpDirs: string[] = []
let relays: TestRelay[] = []
const servers: http.Server[] = []

/**
 * A port that accepts connections and never answers.
 *
 * `occupyPort` answers with the wrong body, which tests the /health gate. This
 * one tests something else: whether a handler *waits* on us. A refused
 * connection returns instantly and would pass a timing assertion either way,
 * so proving "fire and forget" needs a relay that simply goes quiet.
 */
function hangPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(() => {
      /* hold the socket open and say nothing */
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('no address'))
        return
      }
      servers.push(server)
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.()
            server.close(() => done())
          })
      })
    })
  })
}

/** A scratch home with an `endpoint.env` pointing at `port`, plus the plugin. */
function makeHome(port: number, agent: PluginAgent): { home: string; file: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `cw-plugin-${agent}-`))
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
  // `.mjs` for both, including Pi: the extension we ship for Pi is `.ts` and Pi
  // loads it through jiti, but the generated text is plain ESM (no type
  // imports, no annotations - pinned below) and CI runs Node 22, which does not
  // strip types by default. Importing the same bytes as `.mjs` exercises the
  // real source without depending on a loader feature the shipped file does
  // not need.
  const file = path.join(home, 'plugin.mjs')
  fs.writeFileSync(file, renderPluginFile(agent))
  return { home, file }
}

/**
 * Run a generated plugin in a child process.
 *
 * ⛔ A child, not an in-process import: the relay under test lives in *this*
 * process, and the plugin's fetch would be answered by an event loop that is
 * busy awaiting it. It also keeps a plugin that throws from taking the suite
 * down with it - a non-zero exit and stderr are the evidence instead.
 */
function runPlugin(
  home: string,
  harness: string,
  env: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const file = path.join(home, 'harness.mjs')
  fs.writeFileSync(file, harness)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, CODEWAIFU_HOME: home, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000)
    timer.unref?.()
    child.once('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${String(error)}` }))
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

async function startRelay(): Promise<TestRelay> {
  const relay = createTestRelay({ token: TOKEN })
  await relay.server.start(portAttempts({ pinned: 0, sticky: relay.config.port }))
  relays.push(relay)
  return relay
}

/** Wait until the relay has recorded `n` events (the plugin posts fire-and-forget). */
async function waitForEvents(relay: TestRelay, n: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (relay.recorded.events.length >= n) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** The relay is fire-and-forget, so "nothing arrived" needs its own window. */
async function settle(ms = 600): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

afterEach(async () => {
  for (const relay of relays) await relay.shutdown()
  relays = []
})

afterAll(() => {
  for (const server of servers) {
    server.closeAllConnections?.()
    server.close()
  }
  servers.length = 0
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
  tmpDirs.length = 0
})

describe('generated plugin text', () => {
  it('says who made it, on line one, and only our files do', () => {
    expect(PLUGIN_MARKER).toBe('@codewaifu-managed')
    for (const text of [OPENCODE, PI]) {
      expect(text.startsWith(`// ${PLUGIN_MARKER}`)).toBe(true)
      expect(isOurPluginFile(text)).toBe(true)
    }
    // Uninstall reads a file it did not write as "leave it alone", so anything
    // the user put in that directory has to fail this test.
    expect(isOurPluginFile('export default () => ({})')).toBe(false)
    expect(isOurPluginFile('')).toBe(false)
    expect(isOurPluginFile(null)).toBe(false)
    expect(isOurPluginFile(undefined)).toBe(false)
    expect(isOurPluginFile({ text: PLUGIN_MARKER })).toBe(false)
  })

  it('routes per agent, and renders the same bytes every time', () => {
    expect(renderPluginFile('opencode')).toBe(OPENCODE)
    expect(renderPluginFile('pi')).toBe(PI)
    expect(renderPluginFile('opencode')).not.toBe(PI)
    // Byte-stable or every install rewrites an unchanged file (and every
    // uninstall looks like a diff). No date stamp, no cwd, no version.
    expect(renderOpencodePlugin()).toBe(OPENCODE)
    expect(renderPiExtension()).toBe(PI)
    for (const text of [OPENCODE, PI]) {
      expect(text).not.toMatch(/new Date\(/)
      // A stamped version would mean every release rewrites both files and
      // leaves a backup of a file whose behaviour did not change.
      expect(text).not.toContain(VERSION)
    }
  })

  it('carries the same relay contract the shell runner has', () => {
    for (const [agent, text] of [
      ['opencode', OPENCODE],
      ['pi', PI]
    ] as Array<[PluginAgent, string]>) {
      // The port is never trusted: endpoint.env is re-read per event and
      // /health has to answer as CodeWaifu before session data is sent.
      expect(text).toContain('endpoint.env')
      expect(text).toContain('/health')
      expect(text).toContain('"app":"codewaifu"')
      expect(text).toContain(HEALTH_MARKER)
      expect(text).toContain('CODEWAIFU_HOME')
      expect(text).toContain(`const AGENT = "${agent}"`)
      expect(text).toContain('/hook/${AGENT}')
      // Fail open, and never block: bounded requests, swallowed errors.
      expect(text).toContain('AbortController')
      expect(text).toContain('MAX_BODY')
      expect(text).toContain('/* fail open */')
      expect(text).toContain('.catch(() => {})')
      expect(text).toContain('void send(')
      // Dependency-free: only node builtins, because the host runtime is
      // unknown (Node, Bun, or whatever the agent embeds).
      expect(text).toContain('from "node:fs"')
      expect(text.match(/^import .* from "(?!node:)/gm)).toBeNull()
    }
  })

  it('exports exactly one function for OpenCode, whose loader throws on anything else', () => {
    expect(OPENCODE.match(/^export /gm)).toEqual(['export '])
    expect(OPENCODE).toContain('export default async (input) => {')
    // The legacy loader iterates every export and throws
    // "Plugin export is not a function" on the first non-function, which would
    // take the user's own plugins down with ours.
    expect(OPENCODE).not.toMatch(/^export (const|let|var|function|class|type|interface)/m)
    expect(OPENCODE).not.toContain('export {')
  })

  it('relays every OpenCode event it announces, and decides none of them', () => {
    for (const name of [
      'session.created',
      'session.idle',
      'session.compacted',
      'chat.message',
      'permission.ask',
      'tool.execute.before',
      'tool.execute.after'
    ]) {
      expect(OPENCODE).toContain(`"${name}"`)
    }
    for (const event of OPENCODE_PLUGIN_EVENTS) {
      expect(OPENCODE).toContain(`relay("${event}"`)
    }
    // Approvals are observed, never granted: `output.status` is mentioned in a
    // comment and never assigned.
    expect(OPENCODE).toContain('output.status')
    expect(OPENCODE).not.toMatch(/output\.status\s*=/)
    expect(OPENCODE).toContain('PermissionRequest')
    // Assistant turns arrive on the same hook as the human's; speaking those
    // would announce every reply as if the user had typed it.
    expect(OPENCODE).toContain('info.role !== "user"')
  })

  it('relays every Pi event it announces, returns nothing from input, and claims no permission event', () => {
    for (const name of [
      'session_start',
      'session_compact',
      'input',
      'tool_execution_start',
      'tool_execution_end',
      'agent_end'
    ]) {
      expect(PI).toContain(`pi.on("${name}"`)
    }
    for (const event of PI_EXTENSION_EVENTS) {
      expect(PI).toContain(`"${event}"`)
    }
    // Pi has no permission prompt, so announcing one would be an event that
    // can never fire and a toggle that appears to do nothing.
    expect(PI_EXTENSION_EVENTS).not.toContain('PermissionRequest')
    expect(PI).not.toContain('PermissionRequest')
    // Pi reports a failed tool call as its own kind; dropping it would hide the
    // one tool result worth announcing.
    expect(PI_EXTENSION_EVENTS).toContain('PostToolUseFailure')
    expect(PI).toContain('"PostToolUseFailure"')
    expect(PI).toContain('event.isError')
    // `input` is awaited by Pi and `{ action: "handled" }` means "I took this
    // message". Returning the relay promise would delay the user's message and
    // could swallow it.
    expect(PI).toContain('return undefined')
    expect(PI).toContain('pi.on("input"')
    // A resume has to say "resumed", which only works if Pi's reason is forwarded.
    expect(PI).toContain('event.reason')
    // jiti transpiles but does not typecheck: a type import we cannot resolve
    // is worse than no types.
    expect(PI).not.toContain('import type')
    expect(PI).toContain('export default (pi) => {')
    expect(PI.match(/^export /gm)).toEqual(['export '])
  })

  it('announces only events our own table knows, so none of them lands mute', () => {
    // `other` is owned by no toggle: an event that lands there is permanently
    // silent while the settings panel says it is installed.
    const expected: Record<string, string> = {
      SessionStart: 'session_start',
      UserPromptSubmit: 'prompt',
      PermissionRequest: 'permission',
      PreToolUse: 'tool',
      PostToolUse: 'tool',
      PostToolUseFailure: 'tool',
      Compact: 'compact',
      Stop: 'stop'
    }
    for (const event of OPENCODE_PLUGIN_EVENTS) {
      expect(kindForEvent(event, 'opencode')).toBe(expected[event])
    }
    for (const event of PI_EXTENSION_EVENTS) {
      expect(kindForEvent(event, 'pi')).toBe(expected[event])
    }
    expect(kindForEvent('SomethingNew', 'opencode')).toBe('other')
  })
})

describe('generated plugins, executed against a live relay', () => {
  it(
    'delivers the OpenCode lifecycle with the right agent, kind and cwd',
    async () => {
      const relay = await startRelay()
      const { home, file } = makeHome(relay.port, 'opencode')
      const url = pathToFileURL(file).href
      const harness = [
        `const mod = await import(${JSON.stringify(url)})`,
        'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))',
        'const handlers = await mod.default({ directory: "/tmp/oc-fallback" })',
        'console.log("HANDLERS=" + Object.keys(handlers).sort().join(","))',
        '',
        'await handlers.event({ event: { type: "session.created", properties: { info: { id: "oc-1", directory: "/tmp/oc-project" } } } })',
        'await sleep(150)',
        // A later event carries only an id; the directory has to come from the
        // one we remembered at creation.
        'await handlers.event({ event: { type: "session.compacted", properties: { sessionID: "oc-1" } } })',
        'await sleep(150)',
        'await handlers["chat.message"]({ sessionID: "oc-1" }, { message: { role: "user", sessionID: "oc-1" }, parts: [{ type: "text", text: "fix the build" }] })',
        'await sleep(150)',
        'await handlers["chat.message"]({ sessionID: "oc-1" }, { message: { role: "assistant", sessionID: "oc-1" }, parts: [{ type: "text", text: "ASSISTANT-ONLY-TEXT" }] })',
        'await sleep(150)',
        // An empty object: any key on it afterwards is one the plugin wrote.
        'const output = {}',
        'await handlers["permission.ask"]({ sessionID: "oc-1", type: "bash", title: "rm -rf out" }, output)',
        'console.log("OUTPUT_STATUS=" + String(output.status))',
        'console.log("OUTPUT_KEYS=" + Object.keys(output).length)',
        'await sleep(150)',
        'await handlers["tool.execute.before"]({ sessionID: "oc-1", tool: "bash" }, { args: { command: "npm test" } })',
        'await sleep(150)',
        'await handlers["tool.execute.after"]({ sessionID: "oc-1", tool: "bash", args: { command: "npm test" } }, { title: "ran npm test" })',
        'await sleep(150)',
        // A payload with no session id at all must still arrive, resolved to
        // the directory OpenCode gave the plugin.
        'await handlers["tool.execute.before"]({ tool: "read" }, { args: { filePath: "/tmp/oc-fallback/a.ts" } })',
        'await sleep(150)',
        'await handlers.event({ event: { type: "session.idle", properties: { sessionID: "oc-1" } } })',
        'await sleep(400)'
      ].join('\n')

      const run = await runPlugin(home, harness, { HERDR_PANE_ID: 'pane-oc-1' })
      expect(run.stderr).toBe('')
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('OUTPUT_STATUS=undefined')
      expect(run.stdout).toContain('OUTPUT_KEYS=0')
      expect(run.stdout).toContain(
        'HANDLERS=chat.message,event,permission.ask,tool.execute.after,tool.execute.before'
      )

      await waitForEvents(relay, 8)
      await settle()
      const events = relay.recorded.events
      expect(events).toHaveLength(8)
      for (const event of events) {
        expect(event.agent).toBe('opencode')
        // The pane header is the one piece of identity the payload cannot carry.
        expect(event.paneId).toBe('pane-oc-1')
      }
      expect(events.map((event) => event.kind)).toEqual([
        'session_start',
        'compact',
        'prompt',
        'permission',
        'tool',
        'tool',
        'tool',
        'stop'
      ])
      expect(events.map((event) => event.rawEvent)).toEqual([
        'SessionStart',
        'Compact',
        'UserPromptSubmit',
        'PermissionRequest',
        'PreToolUse',
        'PostToolUse',
        'PreToolUse',
        'Stop'
      ])
      // The remembered directory wins over the plugin's fallback.
      expect(events[0].cwd).toBe('/tmp/oc-project')
      expect(events[1].sessionId).toBe('oc-1')
      expect(events[2].detail).toContain('fix the build')
      expect(events[3].title).toBe('Permission needed')
      expect(events[3].detail).toContain('rm -rf out')
      expect(events[4].toolName).toBe('bash')
      expect(events[7].title).toBe('Agent finished')
      // The assistant's own turn is never announced as the human's prompt.
      expect(events.some((event) => event.detail.includes('ASSISTANT-ONLY-TEXT'))).toBe(false)
      expect(events.some((event) => event.sourceText.includes('ASSISTANT-ONLY-TEXT'))).toBe(false)
      // No session id in the payload, so the fallback directory is the honest answer.
      expect(events[6].cwd).toBe('/tmp/oc-fallback')
      expect(events[6].toolName).toBe('read')
    },
    // A cold Node start plus eight round trips; the same ceiling
    // `installWindows.test.ts` uses for a spawned child.
    40_000
  )

  it(
    'delivers the Pi lifecycle, forwards its resume reason, and never takes the message',
    async () => {
      const relay = await startRelay()
      const { home, file } = makeHome(relay.port, 'pi')
      const url = pathToFileURL(file).href
      const harness = [
        `const mod = await import(${JSON.stringify(url)})`,
        'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))',
        'const registered = new Map()',
        'mod.default({ on: (name, cb) => registered.set(name, cb) })',
        'console.log("PI_EVENTS=" + [...registered.keys()].sort().join(","))',
        'const ctx = { cwd: "/tmp/pi-project", sessionManager: { getSessionId: () => "pi-1" } }',
        'const fire = async (name, event) => {',
        '  const handler = registered.get(name)',
        '  if (!handler) throw new Error("no handler for " + name)',
        '  return await handler(event, ctx)',
        '}',
        'await fire("session_start", { reason: "resume" })',
        'await sleep(150)',
        // Pi awaits this one and reads a returned object as "message handled".
        'const inputResult = await fire("input", { text: "ship it" })',
        'console.log("INPUT_RESULT=" + String(inputResult))',
        'await sleep(150)',
        'await fire("input", { text: "   " })',
        'await sleep(150)',
        'await fire("tool_execution_start", { toolName: "bash", args: { command: "npm test" } })',
        'await sleep(150)',
        'await fire("tool_execution_end", { toolName: "bash", isError: true })',
        'await sleep(150)',
        'await fire("tool_execution_end", { toolName: "read" })',
        'await sleep(150)',
        'await fire("session_compact", {})',
        'await sleep(150)',
        'await fire("agent_end", { messages: [{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "text", text: "PI-DONE-TEXT" }] }] })',
        'await sleep(400)'
      ].join('\n')

      const run = await runPlugin(home, harness)
      expect(run.stderr).toBe('')
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('INPUT_RESULT=undefined')
      expect(run.stdout).toContain(
        'PI_EVENTS=agent_end,input,session_compact,session_start,tool_execution_end,tool_execution_start'
      )

      await waitForEvents(relay, 7)
      await settle()
      const events = relay.recorded.events
      // Seven, not eight: an `input` that is only whitespace relays nothing.
      expect(events).toHaveLength(7)
      for (const event of events) {
        expect(event.agent).toBe('pi')
        expect(event.sessionId).toBe('pi-1')
        expect(event.cwd).toBe('/tmp/pi-project')
      }
      expect(events.map((event) => event.rawEvent)).toEqual([
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUseFailure',
        'PostToolUse',
        'Compact',
        'Stop'
      ])
      expect(events[0].matcher).toBe('resume')
      expect(events[0].title).toBe('Session resumed')
      expect(events[1].detail).toContain('ship it')
      expect(events[3].kind).toBe('tool')
      // The finish announcement quotes the agent, not the user's prompt.
      expect(events[6].sourceText).toBe('PI-DONE-TEXT')
    },
    40_000
  )

  it(
    'sends nothing when the port answers as somebody else',
    async () => {
      // The port we bound last week can belong to any dev server today, and the
      // payload carries session data. /health has to say "codewaifu" first.
      const blocker = await occupyPort()
      const { home } = makeHome(blocker.port, 'opencode')
      const relay = await startRelay()
      const harness = [
        `const mod = await import(${JSON.stringify(pathToFileURL(path.join(home, 'plugin.mjs')).href)})`,
        'const handlers = await mod.default({ directory: "/tmp/oc-project" })',
        'await handlers.event({ event: { type: "session.created", properties: { info: { id: "oc-gate", directory: "/tmp/oc-project" } } } })',
        'await new Promise((r) => setTimeout(r, 500))',
        'console.log("GATE_DONE")'
      ].join('\n')

      const run = await runPlugin(home, harness)
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('GATE_DONE')
      await blocker.close()
      await settle(300)
      expect(relay.recorded.events).toHaveLength(0)
    },
    40_000
  )

  it(
    'never waits on us: a relay that goes quiet costs the handler nothing',
    async () => {
      // Both plugin agents, because both are awaited by their host at a moment
      // a human is waiting on: Pi awaits `input` before it sends the message,
      // OpenCode awaits `permission.ask` before it shows the prompt. Whatever
      // these numbers are, that is the latency we add to a keystroke.
      const hanging = await hangPort()
      const pi = makeHome(hanging.port, 'pi')
      const opencode = makeHome(hanging.port, 'opencode')
      const piHarness = [
        `const mod = await import(${JSON.stringify(pathToFileURL(pi.file).href)})`,
        'const registered = new Map()',
        'mod.default({ on: (name, cb) => registered.set(name, cb) })',
        'const ctx = { cwd: "/tmp/pi-project", sessionManager: { getSessionId: () => "pi-hang" } }',
        'for (const [name, handler] of registered) {',
        '  const started = Date.now()',
        '  await handler({ text: "hi", reason: "startup", toolName: "bash", args: {}, messages: [] }, ctx)',
        '  console.log("HANDLER_MS pi:" + name + " " + (Date.now() - started))',
        '}',
        'console.log("NO_THROW")'
      ].join('\n')
      const opencodeHarness = [
        `const mod = await import(${JSON.stringify(pathToFileURL(opencode.file).href)})`,
        'const handlers = await mod.default({ directory: "/tmp/oc-project" })',
        'const calls = [',
        '  ["event", () => handlers.event({ event: { type: "session.created", properties: { info: { id: "s", directory: "/tmp/oc-project" } } } })],',
        '  ["chat.message", () => handlers["chat.message"]({ sessionID: "s" }, { message: { role: "user" }, parts: [{ type: "text", text: "hi" }] })],',
        // The one OpenCode blocks its permission prompt on.
        '  ["permission.ask", () => handlers["permission.ask"]({ sessionID: "s", title: "rm -rf out" }, {})],',
        '  ["tool.execute.before", () => handlers["tool.execute.before"]({ sessionID: "s", tool: "bash" }, { args: {} })],',
        '  ["tool.execute.after", () => handlers["tool.execute.after"]({ sessionID: "s", tool: "bash" }, {})]',
        ']',
        'for (const [name, call] of calls) {',
        '  const started = Date.now()',
        '  await call()',
        '  console.log("HANDLER_MS opencode:" + name + " " + (Date.now() - started))',
        '}',
        'console.log("NO_THROW")'
      ].join('\n')

      const runs = [
        await runPlugin(pi.home, piHarness),
        await runPlugin(opencode.home, opencodeHarness)
      ]
      for (const run of runs) {
        expect(run.stderr).toBe('')
        expect(run.code).toBe(0)
        expect(run.stdout).toContain('NO_THROW')
      }
      const timings = [
        ...runs[0].stdout.matchAll(/HANDLER_MS (\S+) (\d+)/g),
        ...runs[1].stdout.matchAll(/HANDLER_MS (\S+) (\d+)/g)
      ]
      // Six Pi events plus five OpenCode calls: every handler either registers.
      expect(timings).toHaveLength(11)
      for (const [, name, ms] of timings) {
        // Well under the 1s /health budget and the 2s POST budget: an awaited
        // relay shows up here as one of those two numbers, exactly.
        expect(Number(ms), `${name} waited ${ms}ms`).toBeLessThan(300)
      }
      await hanging.close()
    },
    40_000
  )

  it(
    'fails open: a dead relay costs an event, never a throw',
    async () => {
      // Nothing is listening. The agent must not be able to tell we exist.
      const blocker = await occupyPort()
      const deadPort = blocker.port
      await blocker.close()
      const { home } = makeHome(deadPort, 'pi')
      const harness = [
        `const mod = await import(${JSON.stringify(pathToFileURL(path.join(home, 'plugin.mjs')).href)})`,
        'const registered = new Map()',
        'mod.default({ on: (name, cb) => registered.set(name, cb) })',
        'const ctx = { cwd: "/tmp/pi-project", sessionManager: { getSessionId: () => "pi-dead" } }',
        // Every handler, awaited in turn: if one of them rethrows or blocks on a
        // socket timeout, this is where the agent would feel it.
        'for (const [name, handler] of registered) {',
        '  await handler({ text: "hi", reason: "startup", toolName: "bash", args: {}, isError: false, messages: [] }, ctx)',
        '}',
        'console.log("NO_THROW")'
      ].join('\n')

      const run = await runPlugin(home, harness)
      expect(run.stderr).toBe('')
      expect(run.code).toBe(0)
      expect(run.stdout).toContain('NO_THROW')
    },
    40_000
  )
})
