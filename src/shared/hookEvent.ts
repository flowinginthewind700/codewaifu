import { detectLang, resolveLang, toSpeakable } from './lang'
import { greetingKeyForHour, pickPhrase, type Rng } from './phrases'
import type { AppConfig } from './config'
import { asAgent, type Agent, type EventKind, type EventPlan, type HookEvent, type Lang } from './protocol'

const KIND_BY_EVENT: Record<string, EventKind> = {
  sessionstart: 'session_start',
  sessionend: 'session_end',
  userpromptsubmit: 'prompt',
  // Cursor names the same moments differently, and Gemini/Antigravity use
  // their own verbs. All three fold into the kinds the UI already knows.
  beforesubmitprompt: 'prompt',
  afteragentresponse: 'stop',
  beforeshellexecution: 'tool',
  beforemcpexecution: 'tool',
  beforetool: 'tool',
  aftertool: 'tool',
  // Gemini's `BeforeAgent`/`AfterAgent` bracket one *turn*, not one session -
  // the docs put BeforeAgent "after a user submits a prompt" and AfterAgent
  // "once per turn after the model generates its final response". Gemini has
  // real SessionStart/SessionEnd events for the session boundaries, so folding
  // these into the session kinds both stole the window on every prompt and
  // silenced the one moment worth announcing: the agent finishing.
  beforeagent: 'prompt',
  afteragent: 'stop',
  preinvocation: 'session_start',
  postinvocation: 'session_end',
  pretooluse: 'tool',
  posttooluse: 'tool',
  posttoolusefailure: 'tool',
  tool: 'tool',
  permissionrequest: 'permission',
  // OpenCode and Pi relay through a plugin rather than a config file, and their
  // own names are `permission.ask`, `session.idle`, `session.compacted` and
  // `agent_end`. The plugins translate to the canonical spellings above before
  // sending, so these rows are the belt to that brace: if a future relay passes
  // an agent's own name through, it still lands in the right bucket instead of
  // in `other`, which no toggle owns and so is permanently mute.
  permissionasked: 'permission',
  permissionreplied: 'interrupt',
  sessionidle: 'stop',
  sessioncompacted: 'compact',
  agentend: 'stop',
  notification: 'notification',
  stop: 'stop',
  stopfailure: 'stop',
  subagentstart: 'subagent',
  subagentstop: 'subagent',
  precompact: 'compact',
  precompress: 'compact',
  postcompact: 'compact',
  compact: 'compact',
  interrupt: 'interrupt'
}

/**
 * A spelling two agents use for a *different* moment than everyone else does.
 * Cursor's `preToolUse` and Antigravity's `PreToolUse` are their permission
 * prompts - that is why our hook answers both with "ask" - so they announce
 * under the permission toggle, which is also the toggle that installs them.
 * Read as plain tool activity they would be gated by the tool toggle (off by
 * default) and stay silent while the UI says permission events are on.
 * Keyed `agent:event`, both lowercased.
 */
const KIND_BY_AGENT_EVENT: Record<string, EventKind> = {
  'cursor:pretooluse': 'permission',
  'antigravity:pretooluse': 'permission'
}

export function kindForEvent(name: string, agent?: string): EventKind {
  const event = String(name || '').toLowerCase().replace(/[-_\s]/g, '')
  const who = String(agent || '').toLowerCase()
  return KIND_BY_AGENT_EVENT[`${who}:${event}`] || KIND_BY_EVENT[event] || 'other'
}

export function agentFromPath(path: string): Agent {
  const parts = String(path || '').split('/').filter(Boolean)
  const raw = (parts[parts.length - 1] || '').toLowerCase()
  return asAgent(raw)
}

function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  }
  return ''
}

/** Dig a field out of a possibly-nested payload (`tool_input.command` etc.). */
function nested(obj: Record<string, unknown>, path: string): string {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return ''
    cur = (cur as Record<string, unknown>)[part]
  }
  if (typeof cur === 'string') return cur
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur)
  return ''
}

let counter = 0
export function nextEventId(at: number): string {
  counter = (counter + 1) % 1e6
  return `e${at.toString(36)}${counter.toString(36)}`
}

/**
 * Turn whatever an agent POSTed into a stable internal shape. Both agents share
 * `hook_event_name`, `session_id`, `cwd` and `transcript_path`; everything else
 * is best-effort so an unknown future field never throws.
 *
 * `paneId` is not in the body: neither agent knows which terminal it is drawn
 * in, but the runner relaying the hook does, and it says so in a header.
 *
 * `fallbackEvent` is the event name the installer wrote into the hook command.
 * Cursor, Gemini, Antigravity and Kimi do not always repeat the event in the
 * payload, so the config-side name is what says what fired. A payload that does
 * carry `hook_event_name` still wins: that is the agent's own account.
 */
export function normalizeHook(
  agentRaw: string,
  payload: unknown,
  at = Date.now(),
  paneId = '',
  fallbackEvent = ''
): HookEvent {
  const obj = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const rawEvent = firstString(obj, ['hook_event_name', 'hookEventName', 'event']) || String(fallbackEvent || '')
  const agent: Agent = agentRaw ? asAgent(agentRaw) : agentFromPath(rawEvent)
  // The agent is resolved first, because a spelling's meaning can depend on who
  // sent it: `PreToolUse` is a permission prompt on Cursor and Antigravity, but
  // plain tool activity on Kimi.
  const kind = kindForEvent(rawEvent, agent)
  const matcher = firstString(obj, ['matcher', 'hook_matcher', 'source'])
  const toolName = firstString(obj, ['tool_name', 'toolName', 'tool'])
  const toolInput = (obj.tool_input && typeof obj.tool_input === 'object' ? obj.tool_input : {}) as Record<string, unknown>

  const detailCandidates = [
    toolName ? `${toolName}${toolInput.command ? ` ${String(toolInput.command)}` : ''}` : '',
    nested(obj, 'tool_input.command'),
    nested(obj, 'tool_input.file_path'),
    nested(obj, 'tool_input.path'),
    firstString(obj, ['message', 'reason', 'notification', 'title', 'prompt', 'last_assistant_message']),
    nested(obj, 'permission.mode'),
    rawEvent
  ]

  const sourceText = firstString(obj, ['last_assistant_message', 'message', 'notification', 'prompt', 'assistant_message'])
  const detail = toSpeakable(detailCandidates.find((c) => c && c.trim()) || '', 300)
  const isResume = /resume|clear|compact/i.test(matcher)

  const titleMap: Record<EventKind, string> = {
    session_start: isResume ? 'Session resumed' : 'Session started',
    session_end: 'Session ended',
    prompt: 'You sent a prompt',
    tool: toolName ? `Tool: ${toolName}` : 'Tool call',
    permission: 'Permission needed',
    notification: 'Notification',
    stop: 'Agent finished',
    subagent: 'Subagent update',
    compact: 'Context compaction',
    interrupt: 'Interrupted',
    other: rawEvent || 'Event'
  }

  return {
    id: nextEventId(at),
    agent,
    kind,
    rawEvent,
    matcher,
    sessionId: firstString(obj, ['session_id', 'sessionId', 'thread_id']),
    cwd: firstString(obj, ['cwd', 'working_directory', 'workspace']),
    paneId: String(paneId || '').trim(),
    title: titleMap[kind],
    detail,
    sourceText,
    at,
    transcriptPath: firstString(obj, ['transcript_path', 'transcriptPath']),
    model: firstString(obj, ['model', 'model_id']),
    toolName
  }
}

const TOGGLE_BY_KIND: Record<EventKind, keyof AppConfig['events'] | null> = {
  session_start: 'sessionStart',
  session_end: null,
  prompt: 'prompt',
  tool: 'tool',
  permission: 'permission',
  notification: 'notification',
  stop: 'stop',
  subagent: 'subagent',
  compact: 'compact',
  interrupt: 'stop',
  other: null
}

export interface PlanOptions {
  now?: Date
  rng?: Rng
}

/**
 * Decide whether an event is spoken, what it says, and whether the window pops
 * forward. Pure so the whole matrix is unit-testable.
 */
export function planEvent(config: AppConfig, event: HookEvent, opts: PlanOptions = {}): EventPlan {
  const now = opts.now || new Date()
  const rng = opts.rng || Math.random
  const toggle = TOGGLE_BY_KIND[event.kind]
  const wanted = toggle ? config.events[toggle] : false
  const speak = config.enabled && config.speak && wanted
  const popWindow = config.enabled && event.kind === 'session_start' ? config.popOnSessionStart : false

  if (!speak) return { event, speak: false, text: '', lang: resolveLang(config.lang, event.sourceText), popWindow }

  const vars = { agent: event.agent, tool: event.toolName, detail: event.detail }
  let text = ''
  let lang: Lang = config.lang === 'auto' ? 'en' : config.lang

  switch (event.kind) {
    case 'session_start': {
      const resumed = /resume|clear|compact/i.test(event.matcher)
      const key = resumed ? 'session_resume' : greetingKeyForHour(now.getHours())
      // Greetings are always addressed to the human, so they follow the UI
      // language preference rather than the (empty) event payload.
      lang = config.lang === 'auto' ? 'zh' : config.lang
      text = pickPhrase(key, lang, vars, rng)
      break
    }
    case 'notification': {
      const msg = toSpeakable(event.sourceText || event.detail)
      const idle = /idle|waiting for your input|needs input/i.test(msg)
      lang = resolveLang(config.lang, msg)
      text = msg || pickPhrase(idle ? 'idle' : 'notification', lang, vars, rng)
      if (!idle && msg) text = `${pickPhrase('notification', lang, vars, rng)} ${msg}`
      break
    }
    case 'stop': {
      const msg = toSpeakable(event.sourceText, 160)
      lang = resolveLang(config.lang, msg || event.detail)
      text = pickPhrase(event.rawEvent.toLowerCase() === 'interrupt' ? 'interrupt' : 'stop', lang, vars, rng)
      if (msg) text = `${text} ${msg}`
      break
    }
    case 'permission': {
      lang = resolveLang(config.lang, event.detail)
      text = pickPhrase('permission', lang, vars, rng)
      if (event.detail) text = `${text} ${toSpeakable(event.detail, 80)}`
      break
    }
    case 'tool':
      lang = resolveLang(config.lang, event.detail)
      text = pickPhrase('tool', lang, vars, rng)
      break
    case 'compact':
      lang = config.lang === 'auto' ? 'zh' : config.lang
      text = pickPhrase('compact', lang, vars, rng)
      break
    case 'subagent':
      lang = config.lang === 'auto' ? 'zh' : config.lang
      text = pickPhrase('subagent', lang, vars, rng)
      break
    case 'interrupt':
      lang = config.lang === 'auto' ? 'zh' : config.lang
      text = pickPhrase('interrupt', lang, vars, rng)
      break
    default:
      text = ''
  }

  text = toSpeakable(text, 320)
  return { event, speak: Boolean(text), text, lang: text ? lang : detectLang(text, 'en'), popWindow }
}
