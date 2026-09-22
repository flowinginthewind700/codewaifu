/**
 * The two agents that have no hook config at all.
 *
 * Codex, Claude, Cursor, Gemini, Antigravity, Kimi and ZCode all read a config
 * file that names a command per event, so the installer merges a command in and
 * the shared POSIX relay does the work. OpenCode and Pi have no such file: they
 * load *code* - OpenCode every module in `~/.config/opencode/plugins/`, Pi every
 * `.ts`/`.js` file in `~/.pi/agent/extensions/` - and call it with their own
 * runtime objects.
 *
 * So for those two we generate the plugin itself. Each file is a small relay
 * with the same contract the shell runner has, and the same rules:
 *
 * - fail open. A throw here would surface inside the user's agent, so every
 *   handler body is wrapped and every network call is caught.
 * - never block. Relays are fired, not awaited, and nothing an agent handed us
 *   to decide is ever written to: OpenCode's `permission.ask` gives us
 *   `output.status` and we leave it alone, because CodeWaifu observes approvals
 *   rather than granting them.
 * - never trust the port. `endpoint.env` is re-read per event and `/health`
 *   must answer as CodeWaifu before a payload carrying session data is sent;
 *   the port we bound last week can belong to anything today.
 *
 * Both files are generated text, so they are byte-stable: rendering twice must
 * produce the same string, or every install would rewrite a file that has not
 * changed and every uninstall would look like a diff.
 */

/**
 * Ownership marker. A plugins directory can hold anything the user wrote, and
 * uninstall must not eat it, so our files say who made them on line one.
 * Path-shaped markers do not work here: the generated code never mentions
 * `~/.codewaifu` as a literal path, it builds it from `$CODEWAIFU_HOME`.
 */
export const PLUGIN_MARKER = '@codewaifu-managed'

export function isOurPluginFile(text: unknown): boolean {
  return typeof text === 'string' && text.includes(PLUGIN_MARKER)
}

/**
 * Canonical event names each plugin relays, in the spelling the app's own
 * `KIND_BY_EVENT` table already knows. Reported as "installed events" so the
 * settings panel says the same thing for a plugin agent as for a config one.
 *
 * These are all-or-nothing: a plugin file cannot be written per toggle without
 * rewriting it whenever a toggle flips, and the app already gates speech by
 * kind (`planEvent`), so relaying everything and announcing what is enabled is
 * both simpler and honest.
 */
export const OPENCODE_PLUGIN_EVENTS: readonly string[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'Compact',
  'Stop'
]

export const PI_EXTENSION_EVENTS: readonly string[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Compact',
  'Stop'
]

/**
 * The relay both plugins share, as source lines. Deliberately dependency-free:
 * `node:fs`/`node:os`/`node:path` plus global `fetch`, which Node 18+ and Bun
 * both have, because we cannot know which runtime the agent is built on.
 */
function runtimeLines(agent: string): string[] {
  return [
    'import { readFileSync } from "node:fs"',
    'import { homedir } from "node:os"',
    'import { join } from "node:path"',
    '',
    `const AGENT = "${agent}"`,
    'const HEALTH_TIMEOUT_MS = 1000',
    '// Two seconds, the same budget the shell relay gets. An agent that waits on',
    '// us should not be able to tell we exist.',
    'const POST_TIMEOUT_MS = 2000',
    '// The server refuses a body over 256KB; stay under it and keep the fields',
    '// that carry meaning rather than the ones that carry bulk.',
    'const MAX_BODY = 200 * 1024',
    'const MAX_TEXT = 4000',
    '',
    'function stateFile() {',
    '  const home = process.env.CODEWAIFU_HOME || join(homedir(), ".codewaifu")',
    '  return join(home, "endpoint.env")',
    '}',
    '',
    '/** endpoint.env, parsed here rather than sourced: this is not a shell. */',
    'function readEndpoint() {',
    '  let text = ""',
    '  try {',
    '    text = readFileSync(stateFile(), "utf8")',
    '  } catch {',
    '    return null',
    '  }',
    '  let port = 0',
    '  let token = ""',
    '  let base = ""',
    '  for (const line of String(text).split(/\\r?\\n/)) {',
    '    if (/^\\s*#/.test(line)) continue',
    '    const match = /^\\s*([A-Z_]+)\\s*=\\s*(.*)$/.exec(line)',
    '    if (!match) continue',
    '    const value = match[2].trim().replace(/^["\x27]|["\x27]$/g, "")',
    '    if (match[1] === "CODEWAIFU_PORT") port = Number(value) || 0',
    '    else if (match[1] === "CODEWAIFU_TOKEN") token = value',
    '    else if (match[1] === "CODEWAIFU_BASE") base = value',
    '  }',
    '  if (port < 1 || port > 65535) return null',
    '  return { base: base || `http://127.0.0.1:${port}`, token }',
    '}',
    '',
    'async function request(url, ms, init) {',
    '  const controller = new AbortController()',
    '  const timer = setTimeout(() => controller.abort(), ms)',
    '  try {',
    '    const response = await fetch(url, Object.assign({}, init, { signal: controller.signal }))',
    '    return await response.text()',
    '  } finally {',
    '    clearTimeout(timer)',
    '  }',
    '}',
    '',
    'function stringify(value) {',
    '  try {',
    '    return JSON.stringify(value) || "{}"',
    '  } catch {',
    '    return "{}"',
    '  }',
    '}',
    '',
    'function clipStrings(payload) {',
    '  const out = {}',
    '  for (const key of Object.keys(payload)) {',
    '    const value = payload[key]',
    '    out[key] = typeof value === "string" && value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value',
    '  }',
    '  return out',
    '}',
    '',
    '/** Shrink until it fits, dropping bulk before meaning. "" means give up. */',
    'function encode(event, payload) {',
    '  const body = Object.assign({ hook_event_name: event }, payload)',
    '  const first = stringify(body)',
    '  if (first.length <= MAX_BODY) return first',
    '  const clipped = clipStrings(body)',
    '  const second = stringify(clipped)',
    '  if (second.length <= MAX_BODY) return second',
    '  delete clipped.tool_input',
    '  const third = stringify(clipped)',
    '  return third.length <= MAX_BODY ? third : ""',
    '}',
    '',
    'function paneId() {',
    '  // herdr exports this into every pane; outside herdr it is empty, and an',
    '  // empty header value is a request some stacks refuse.',
    '  return String(process.env.HERDR_PANE_ID || "")',
    '}',
    '',
    'async function send(event, payload) {',
    '  const endpoint = readEndpoint()',
    '  if (!endpoint) return',
    '  const text = encode(event, payload)',
    '  if (!text) return',
    '  const probe = await request(`${endpoint.base}/health`, HEALTH_TIMEOUT_MS).catch(() => "")',
    '  if (!probe || probe.indexOf(\x27"app":"codewaifu"\x27) === -1) return',
    '  const headers = {',
    '    "Content-Type": "application/json",',
    '    "X-CodeWaifu-Token": endpoint.token,',
    '    "X-CodeWaifu-Event": event',
    '  }',
    '  const pane = paneId()',
    '  if (pane) headers["X-CodeWaifu-Pane"] = pane',
    '  await request(`${endpoint.base}/hook/${AGENT}`, POST_TIMEOUT_MS, {',
    '    method: "POST",',
    '    headers,',
    '    body: text',
    '  }).catch(() => "")',
    '}',
    '',
    '/**',
    ' * Fire and forget. Nothing here may be awaited by a handler: OpenCode awaits',
    ' * `permission.ask` before it shows the prompt, and Pi awaits `input` before',
    ' * it sends the message, so an awaited relay is a laggy agent.',
    ' */',
    'function relay(event, payload) {',
    '  try {',
    '    void send(event, payload || {}).catch(() => {})',
    '  } catch {',
    '    /* a relay that throws is worse than no relay at all */',
    '  }',
    '}'
  ]
}

/**
 * OpenCode's plugin file.
 *
 * Two shapes of the loader matter here. Current OpenCode reads a v1 plugin (an
 * object with `id` and `server`); when that fails it falls back to the legacy
 * path, which iterates *every* export of the module and throws
 * `TypeError: Plugin export is not a function` at the first one that is not a
 * function. So this file exports exactly one thing, a function, and keeps its
 * helpers unexported. A single stray `export const` would break plugin loading
 * for the whole directory, including the user's own plugins.
 *
 * Event mapping: OpenCode's own names are on the left, ours on the right.
 * `session.created` -> SessionStart, `session.idle` -> Stop,
 * `session.compacted` -> Compact, `permission.ask` -> PermissionRequest,
 * `chat.message` (user role only) -> UserPromptSubmit, `tool.execute.before` ->
 * PreToolUse, `tool.execute.after` -> PostToolUse.
 */
export function renderOpencodePlugin(): string {
  const lines: string[] = [
    `// ${PLUGIN_MARKER}`,
    '// Generated by CodeWaifu - do not edit; the app rewrites this file.',
    '//',
    '// OpenCode has no hook config, so CodeWaifu ships a plugin instead. It reads',
    '// the agent lifecycle and relays it to the app over localhost HTTP. It never',
    '// decides anything: `permission.ask` hands us `output.status` and we leave it',
    '// untouched, and no handler is awaited by us, so a dead relay costs an event',
    '// and never a blocked session.',
    '//',
    '// Exactly one export, on purpose: OpenCode\x27s legacy plugin loader iterates',
    '// every export of the module and throws on the first one that is not a',
    '// function, which would take the user\x27s own plugins down with it.',
    ...runtimeLines('opencode'),
    '',
    'export default async (input) => {',
    '  const fallbackCwd = String((input && (input.directory || input.worktree)) || process.cwd())',
    '  // A session can be created before we ever see its directory, and the',
    '  // events that follow only carry an id.',
    '  const dirs = new Map()',
    '',
    '  const dirOf = (sessionId) => dirs.get(sessionId) || fallbackCwd',
    '  const noteDir = (sessionId, dir) => {',
    '    if (sessionId && dir) dirs.set(sessionId, String(dir))',
    '  }',
    '',
    '  return {',
    '    event: async (arg) => {',
    '      try {',
    '        const event = arg && arg.event',
    '        if (!event || typeof event !== "object") return',
    '        const type = String(event.type || "")',
    '        const props = event.properties || {}',
    '        if (type === "session.created") {',
    '          const info = props.info || {}',
    '          const sessionId = String(info.id || "")',
    '          noteDir(sessionId, info.directory)',
    '          relay("SessionStart", {',
    '            session_id: sessionId,',
    '            cwd: dirOf(sessionId),',
    '            source: "startup"',
    '          })',
    '          return',
    '        }',
    '        const sessionId = String(props.sessionID || props.session_id || "")',
    '        if (type === "session.idle") {',
    '          relay("Stop", { session_id: sessionId, cwd: dirOf(sessionId) })',
    '          return',
    '        }',
    '        if (type === "session.compacted" || type === "session.compact") {',
    '          relay("Compact", { session_id: sessionId, cwd: dirOf(sessionId) })',
    '        }',
    '      } catch {',
    '        /* fail open */',
    '      }',
    '    },',
    '',
    '    "chat.message": async (message, output) => {',
    '      try {',
    '        const info = (output && output.message) || {}',
    '        // Assistant turns arrive on the same hook; speaking those would',
    '        // announce every reply as if the human had typed it.',
    '        if (info.role && info.role !== "user") return',
    '        const parts = (output && output.parts) || []',
    '        let text = ""',
    '        for (const part of parts) {',
    '          if (part && part.type === "text" && typeof part.text === "string") {',
    '            text = part.text',
    '            break',
    '          }',
    '        }',
    '        if (!text.trim()) return',
    '        const sessionId = String((message && message.sessionID) || info.sessionID || "")',
    '        relay("UserPromptSubmit", { session_id: sessionId, cwd: dirOf(sessionId), message: text })',
    '      } catch {',
    '        /* fail open */',
    '      }',
    '    },',
    '',
    '    "permission.ask": async (permission) => {',
    '      try {',
    '        const request = permission || {}',
    '        const sessionId = String(request.sessionID || "")',
    '        relay("PermissionRequest", {',
    '          session_id: sessionId,',
    '          cwd: dirOf(sessionId),',
    '          title: String(request.title || request.type || "")',
    '        })',
    '      } catch {',
    '        /* fail open */',
    '      }',
    '    },',
    '',
    '    "tool.execute.before": async (call, output) => {',
    '      try {',
    '        const sessionId = String((call && call.sessionID) || "")',
    '        relay("PreToolUse", {',
    '          session_id: sessionId,',
    '          cwd: dirOf(sessionId),',
    '          tool_name: String((call && call.tool) || ""),',
    '          tool_input: (output && output.args) || {}',
    '        })',
    '      } catch {',
    '        /* fail open */',
    '      }',
    '    },',
    '',
    '    "tool.execute.after": async (call, output) => {',
    '      try {',
    '        const sessionId = String((call && call.sessionID) || "")',
    '        relay("PostToolUse", {',
    '          session_id: sessionId,',
    '          cwd: dirOf(sessionId),',
    '          tool_name: String((call && call.tool) || ""),',
    '          tool_input: (call && call.args) || {},',
    '          title: String((output && output.title) || "")',
    '        })',
    '      } catch {',
    '        /* fail open */',
    '      }',
    '    }',
    '  }',
    '}',
    ''
  ]
  return lines.join('\n')
}

/**
 * Pi's extension file.
 *
 * Pi imports extensions with `jiti` and takes the default export as a factory
 * `(pi) => void`, so this is plain ESM with no type imports: `jiti` transpiles
 * but does not type-check, and a type import we cannot resolve would be worse
 * than no types at all.
 *
 * Mapping: `session_start` -> SessionStart (its `reason` becomes our `source`,
 * which is what makes a resume say "resumed" instead of "started"),
 * `session_compact` -> Compact, `agent_end` -> Stop, `tool_execution_start` ->
 * PreToolUse, `tool_execution_end` -> PostToolUse (PostToolUseFailure when Pi
 * says the call failed), `input` -> UserPromptSubmit. Pi has no permission
 * event, so that toggle installs nothing here.
 *
 * ⛔ Pi awaits `input` handlers and reads `{ action: "handled" }` as "I took
 * this message", so the handler must return undefined. Returning the relay
 * promise would both delay the user's message and, if it ever resolved to an
 * object, swallow it.
 */
export function renderPiExtension(): string {
  const lines: string[] = [
    `// ${PLUGIN_MARKER}`,
    '// Generated by CodeWaifu - do not edit; the app rewrites this file.',
    '//',
    '// Pi has no hook config, so CodeWaifu ships an extension instead. It reads',
    '// the agent lifecycle and relays it to the app over localhost HTTP. Every',
    '// handler returns undefined on purpose: Pi awaits `input` handlers and reads',
    '// `{ action: "handled" }` as "this message was taken", and nothing here has',
    '// any business taking a message or deciding a tool call.',
    ...runtimeLines('pi'),
    '',
    'function sessionIdOf(ctx) {',
    '  try {',
    '    const manager = ctx && ctx.sessionManager',
    '    if (manager && typeof manager.getSessionId === "function") return String(manager.getSessionId() || "")',
    '  } catch {',
    '    /* fail open */',
    '  }',
    '  return ""',
    '}',
    '',
    'function cwdOf(ctx) {',
    '  const cwd = ctx && ctx.cwd',
    '  return String(cwd || process.cwd())',
    '}',
    '',
    '/** The last thing the agent said, for the finish announcement. Best effort. */',
    'function lastAssistantText(messages) {',
    '  if (!Array.isArray(messages)) return ""',
    '  for (let i = messages.length - 1; i >= 0; i--) {',
    '    const message = messages[i]',
    '    if (!message || message.role !== "assistant") continue',
    '    const content = message.content',
    '    if (typeof content === "string") return content',
    '    if (Array.isArray(content)) {',
    '      let text = ""',
    '      for (const part of content) {',
    '        if (part && part.type === "text" && typeof part.text === "string") text += part.text',
    '      }',
    '      if (text) return text',
    '    }',
    '  }',
    '  return ""',
    '}',
    '',
    'export default (pi) => {',
    '  try {',
    '    pi.on("session_start", (event, ctx) => {',
    '      relay("SessionStart", {',
    '        session_id: sessionIdOf(ctx),',
    '        cwd: cwdOf(ctx),',
    '        source: String((event && event.reason) || "startup")',
    '      })',
    '    })',
    '',
    '    pi.on("session_compact", (_event, ctx) => {',
    '      relay("Compact", { session_id: sessionIdOf(ctx), cwd: cwdOf(ctx) })',
    '    })',
    '',
    '    pi.on("input", (event, ctx) => {',
    '      const text = String((event && event.text) || "")',
    '      if (text.trim()) {',
    '        relay("UserPromptSubmit", {',
    '          session_id: sessionIdOf(ctx),',
    '          cwd: cwdOf(ctx),',
    '          message: text',
    '        })',
    '      }',
    '      // Never a value: see the note above `input` in the header.',
    '      return undefined',
    '    })',
    '',
    '    pi.on("tool_execution_start", (event, ctx) => {',
    '      relay("PreToolUse", {',
    '        session_id: sessionIdOf(ctx),',
    '        cwd: cwdOf(ctx),',
    '        tool_name: String((event && event.toolName) || ""),',
    '        tool_input: (event && event.args) || {}',
    '      })',
    '    })',
    '',
    '    pi.on("tool_execution_end", (event, ctx) => {',
    '      const failed = Boolean(event && event.isError)',
    '      relay(failed ? "PostToolUseFailure" : "PostToolUse", {',
    '        session_id: sessionIdOf(ctx),',
    '        cwd: cwdOf(ctx),',
    '        tool_name: String((event && event.toolName) || "")',
    '      })',
    '    })',
    '',
    '    pi.on("agent_end", (event, ctx) => {',
    '      relay("Stop", {',
    '        session_id: sessionIdOf(ctx),',
    '        cwd: cwdOf(ctx),',
    '        last_assistant_message: lastAssistantText(event && event.messages)',
    '      })',
    '    })',
    '  } catch {',
    '    /* an extension that fails to load must not take Pi down with it */',
    '  }',
    '}',
    ''
  ]
  return lines.join('\n')
}
