import type { Agent } from './protocol'

// ============================================================
// Agent transcript -> chat view.
//
// Both agents already persist a complete JSONL transcript on disk
// (`~/.codex/sessions/**/rollout-*.jsonl`, `~/.claude/projects/*/<uuid>.jsonl`),
// so the panel can show the real conversation instead of only the hook events
// we happened to catch. Everything here is a pure function over parsed rows:
// file discovery and byte-level tailing live in main/transcript.ts, and the two
// formats are normalized into one shape the renderer can draw.
//
// ⛔ Keep this module free of node/electron imports — it is unit tested and it
//    is bundled into the renderer.
// ============================================================

export type ChatRole = 'user' | 'assistant' | 'tool' | 'reasoning' | 'system'

export interface ChatMessage {
  /** Stable within one transcript: `${agent}-${ordinal}`. */
  id: string
  role: ChatRole
  text: string
  /** Tool name for `role: 'tool'`. */
  tool?: string
  /** Tool result, paired onto the call so one bubble holds both. */
  output?: string
  /**
   * The shell command that produced `output`, kept whole and unclipped.
   *
   * `text` is a one-line summary cut at 120 characters, which is right for the
   * chip and wrong for deciding what language the output is in: `cat` of a deep
   * path loses its extension to the cut, and the cut is what makes the output
   * render grey. See `shared/toolOutput.ts`, which reads this field.
   */
  command?: string
  /** Epoch ms; 0 when the row carried no timestamp. */
  at: number
  /** Sub-agent (Claude `isSidechain`) traffic. */
  sidechain?: boolean
  /** `text` or `output` was cut to fit the per-message cap. */
  truncated?: boolean
}

export interface ChatTranscript {
  key: string
  agent: Agent
  id: string
  title: string
  cwd: string
  /** Absolute transcript path, for the "reveal in Finder" action. */
  file: string
  messages: ChatMessage[]
  /** Messages dropped from the head to respect `limit`. */
  dropped: number
  mtimeMs: number
  bytes: number
  steerable: boolean
}

/** Per-message character cap. Long pastes are folded, not dropped. */
export const MAX_MESSAGE_CHARS = 4000
/** Default window of messages shown; "load older" re-reads with a bigger one. */
export const DEFAULT_MESSAGE_LIMIT = 240
export const MAX_MESSAGE_LIMIT = 2000

/**
 * Cut a string to `max` characters on a line boundary. Returns `null` when it
 * did not fit, so callers can mark the message as truncated instead of
 * silently pretending the tail was never there.
 */
export function clipText(text: string, max: number = MAX_MESSAGE_CHARS): string | null {
  const raw = String(text ?? '')
  if (raw.length <= max) return null
  // Prefer cutting at a newline so we never end mid-word inside a code block.
  const slice = raw.slice(0, max)
  const lastBreak = slice.lastIndexOf('\n')
  return (lastBreak > max * 0.5 ? slice.slice(0, lastBreak) : slice).trimEnd()
}

type Row = Record<string, unknown>

function asRow(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : null
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function timeOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000
  if (typeof value === 'string') {
    const at = Date.parse(value)
    return Number.isFinite(at) ? at : 0
  }
  return 0
}

/** Join the text parts of a `content` array (both agents use this shape). */
function contentText(content: unknown, wanted: string[]): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    const row = asRow(part)
    if (!row) continue
    if (wanted.includes(textOf(row.type))) {
      const text = textOf(row.text)
      if (text) parts.push(text)
    }
  }
  return parts.join('\n')
}

/**
 * Codex wraps injected context (AGENTS.md, environment, system reminders) in
 * rows that carry `role: "user"`. Rendering those as user bubbles would put
 * thousands of characters of scaffolding in the middle of the conversation.
 */
const CODEX_NOISE = [
  '<environment_context>',
  '<user_instructions>',
  '<system-reminder>',
  '<skills_instructions>',
  '# AGENTS.md instructions',
  '<INSTRUCTIONS>'
]

export function isInjectedContext(text: string): boolean {
  const head = text.trimStart().slice(0, 200)
  return CODEX_NOISE.some((marker) => head.includes(marker))
}

/** Hard cap for a tool row's one-line detail: longer args are cut, not wrapped. */
const MAX_ARGS_CHARS = 120

function clipArgs(text: string): string {
  return text.length > MAX_ARGS_CHARS ? `${text.slice(0, MAX_ARGS_CHARS)}…` : text
}

/** Keys a list-of-objects argument keeps its human text under. */
const ITEM_TEXT_KEYS = ['step', 'text', 'description', 'label', 'content', 'title', 'question']

/**
 * Render one argument value as a single line.
 *
 * The agents do not agree on shapes: Codex sends `cmd` as a string but
 * `prefix_rule` as an argv array, and `update_plan` as a list of step objects
 * (1198 of them in one month of real rollouts). Reading only strings turned
 * every one of those tool rows into an empty chip, so arrays are flattened:
 * strings join with a space (they are a command line), objects join on `·`.
 */
function argText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) {
    const nested = asRow(value)
    if (!nested) return ''
    for (const entry of Object.values(nested)) {
      if (typeof entry === 'string' && entry.trim()) return entry.trim()
    }
    return ''
  }
  const parts: string[] = []
  let allStrings = true
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.trim()) parts.push(item.trim())
      continue
    }
    allStrings = false
    const row = asRow(item)
    if (!row) continue
    const text = ITEM_TEXT_KEYS.map((key) => textOf(row[key]).trim()).find(Boolean)
    if (text) parts.push(text)
  }
  return parts.join(allStrings ? ' ' : ' · ')
}

/** Compact one-line summary of a tool call's arguments. */
export function summarizeArgs(raw: unknown): string {
  const { value, notJson } = unwrapArgs(raw)
  // Not JSON at all (Codex `apply_patch` sends the raw patch body): the body is
  // the summary.
  if (notJson) return clipArgs(String(raw ?? ''))
  const row = asRow(value)
  if (!row) return clipArgs(argText(value))
  const preferred = ['cmd', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt']
  for (const key of preferred) {
    const hit = argText(row[key])
    if (hit) return clipArgs(hit)
  }
  for (const entry of Object.values(row)) {
    const text = argText(entry)
    if (text) return clipArgs(text)
  }
  return ''
}

/**
 * Take the JSON string layer off a tool call's arguments. Codex stores them as
 * a JSON *string* (`arguments`), Claude as an object (`input`), and Codex
 * `apply_patch` sends a raw patch body that is not JSON at all.
 */
function unwrapArgs(raw: unknown): { value: unknown; notJson: boolean } {
  if (typeof raw !== 'string') return { value: raw, notJson: false }
  try {
    return { value: JSON.parse(raw), notJson: false }
  } catch {
    return { value: raw, notJson: true }
  }
}

/**
 * The shell command behind a tool call, or `''`.
 *
 * Only shell tools get one: `commandLanguage()` is strict about which command
 * words may vouch for their own stdout, so handing it `apply_patch`'s patch body
 * or `view_image`'s path would just be noise it has to reject. The key list is
 * the union of what both agents actually send - Codex `cmd` (34,929 calls in 40
 * recent rollouts) and `command` (1), Claude Bash `command` and `script`.
 */
export function toolCommand(raw: unknown): string {
  const { value, notJson } = unwrapArgs(raw)
  if (notJson) return ''
  const row = asRow(value)
  if (!row) return ''
  for (const key of ['cmd', 'command', 'script']) {
    const entry = row[key]
    if (typeof entry === 'string' && entry.trim()) return entry
  }
  return ''
}

/**
 * One Codex rollout row -> zero or one chat message. Tool *outputs* return
 * `null` here and are paired onto their call by `normalizeMessages`.
 */
export function parseCodexRow(row: Row, index: number): ChatMessage | null {
  const at = timeOf(row.timestamp)
  const payload = asRow(row.payload)
  if (!payload) return null
  const kind = textOf(payload.type)
  const base = { id: `codex-${index}`, at }

  if (kind === 'message') {
    const role = textOf(payload.role)
    const text = contentText(payload.content, ['input_text', 'output_text', 'text']).trim()
    if (!text) return null
    if (role === 'assistant') return { ...base, role: 'assistant', text }
    // `developer` / `system` rows are prompt scaffolding, never conversation.
    if (role !== 'user') return null
    if (isInjectedContext(text)) return null
    return { ...base, role: 'user', text }
  }

  if (kind === 'reasoning') {
    const summary = Array.isArray(payload.summary)
      ? payload.summary.map((entry) => textOf(asRow(entry)?.summary_text ?? asRow(entry)?.text)).filter(Boolean)
      : []
    const text = summary.join('\n').trim() || contentText(payload.content, ['text']).trim()
    if (!text) return null
    return { ...base, role: 'reasoning', text }
  }

  if (kind === 'function_call' || kind === 'custom_tool_call') {
    const name = textOf(payload.name) || 'tool'
    const args = kind === 'custom_tool_call' ? payload.input : payload.arguments
    return {
      ...base,
      role: 'tool',
      tool: name,
      text: summarizeArgs(args),
      command: toolCommand(args) || undefined
    }
  }

  return null
}

/** Tool output rows, keyed by call id, so they can be folded into their call. */
export function parseCodexToolOutput(row: Row): { callId: string; output: string } | null {
  const payload = asRow(row.payload)
  if (!payload) return null
  const kind = textOf(payload.type)
  if (kind !== 'function_call_output' && kind !== 'custom_tool_call_output') return null
  const callId = textOf(payload.call_id)
  if (!callId) return null
  const raw = payload.output
  const nested = asRow(raw)
  const output =
    typeof raw === 'string'
      ? raw
      : nested
        ? contentText(nested.content, ['output_text', 'text']) || textOf(nested.output)
        : ''
  return { callId, output }
}

/** One Claude Code transcript row -> zero or one chat message. */
export function parseClaudeRow(row: Row, index: number): ChatMessage | null {
  const type = textOf(row.type)
  if (type !== 'user' && type !== 'assistant') return null
  const message = asRow(row.message)
  if (!message) return null
  const at = timeOf(row.timestamp)
  const base = { id: `claude-${index}`, at, sidechain: row.isSidechain === true ? true : undefined }
  const content = message.content

  if (type === 'user') {
    const toolResult = Array.isArray(content)
      ? content.map(asRow).find((part) => part && textOf(part.type) === 'tool_result')
      : null
    if (toolResult) return null // paired onto its tool_use below
    const text = contentText(content, ['text']).trim() || (typeof content === 'string' ? content.trim() : '')
    if (!text || isInjectedContext(text)) return null
    return { ...base, role: 'user', text }
  }

  const parts = Array.isArray(content) ? content.map(asRow).filter((part): part is Row => Boolean(part)) : []
  const text = parts
    .filter((part) => textOf(part.type) === 'text')
    .map((part) => textOf(part.text))
    .join('\n')
    .trim()
  const thinking = parts
    .filter((part) => textOf(part.type) === 'thinking')
    .map((part) => textOf(part.thinking))
    .join('\n')
    .trim()
  const toolUse = parts.find((part) => textOf(part.type) === 'tool_use')

  // A single assistant row can carry thinking + text + a tool call; text wins
  // because it is what the user actually reads, and the tool call follows as
  // its own row in the normalized stream.
  if (text) return { ...base, role: 'assistant', text }
  if (toolUse) {
    return {
      ...base,
      role: 'tool',
      tool: textOf(toolUse.name) || 'tool',
      text: summarizeArgs(toolUse.input),
      command: toolCommand(toolUse.input) || undefined
    }
  }
  if (thinking) return { ...base, role: 'reasoning', text: thinking }
  return null
}

export function parseClaudeToolResult(row: Row): { callId: string; output: string } | null {
  if (textOf(row.type) !== 'user') return null
  const content = asRow(row.message)?.content
  if (!Array.isArray(content)) return null
  for (const part of content) {
    const block = asRow(part)
    if (!block || textOf(block.type) !== 'tool_result') continue
    const callId = textOf(block.tool_use_id)
    if (!callId) continue
    const output = contentText(block.content, ['text']).trim()
    return { callId, output: output || (block.is_error === true ? 'error' : '') }
  }
  return null
}

export interface NormalizeOptions {
  agent: Agent
  /** Rows, in file order. */
  rows: Row[]
  limit?: number
}

export interface Normalized {
  messages: ChatMessage[]
  /** How many parsed messages were cut from the head to respect `limit`. */
  dropped: number
}

/**
 * Parse a whole transcript body and fold tool outputs onto their calls.
 *
 * Pairing is by call id, and an output with no matching call becomes a tool row
 * of its own — losing it would hide the fact that something ran.
 */
export function normalizeMessages(options: NormalizeOptions): Normalized {
  const { agent, rows } = options
  const limit = Math.min(MAX_MESSAGE_LIMIT, Math.max(20, options.limit ?? DEFAULT_MESSAGE_LIMIT))
  const messages: ChatMessage[] = []
  const byCallId = new Map<string, ChatMessage>()
  const pendingOutputs: Array<{ callId: string; output: string; at: number; index: number }> = []

  rows.forEach((row, index) => {
    const parsed = agent === 'claude' ? parseClaudeRow(row, index) : parseCodexRow(row, index)
    const result = agent === 'claude' ? parseClaudeToolResult(row) : parseCodexToolOutput(row)
    if (result) pendingOutputs.push({ ...result, at: timeOf(row.timestamp), index })
    if (!parsed) return
    messages.push(parsed)
    if (parsed.role === 'tool') {
      // Codex call ids live on the payload; Claude's on the content block. Both
      // are re-derived from the raw row so pairing needs no extra state.
      const callId = codexCallId(row) || claudeCallId(row)
      if (callId) byCallId.set(callId, parsed)
    }
  })

  for (const output of pendingOutputs) {
    const call = byCallId.get(output.callId)
    const clipped = clipText(output.output)
    const body = clipped ?? output.output
    if (call) {
      call.output = body
      if (clipped) call.truncated = true
      continue
    }
    messages.push({
      id: `${agent}-out-${output.index}`,
      role: 'tool',
      tool: 'output',
      text: '',
      output: body,
      at: output.at,
      truncated: clipped ? true : undefined
    })
  }

  messages.sort((a, b) => a.at - b.at || sequenceOf(a.id) - sequenceOf(b.id))
  for (const message of messages) {
    const clipped = clipText(message.text)
    if (clipped !== null) {
      message.text = clipped
      message.truncated = true
    }
  }

  const dropped = Math.max(0, messages.length - limit)
  return { messages: dropped ? messages.slice(dropped) : messages, dropped }
}

/** Trailing integer of a generated message id, used as the tie-breaker. */
function sequenceOf(id: string): number {
  const match = /(\d+)$/.exec(id)
  return match ? Number(match[1]) : 0
}

function codexCallId(row: Row): string {
  const payload = asRow(row.payload)
  return payload ? textOf(payload.call_id) : ''
}

function claudeCallId(row: Row): string {
  const content = asRow(row.message)?.content
  if (!Array.isArray(content)) return ''
  for (const part of content) {
    const block = asRow(part)
    if (block && textOf(block.type) === 'tool_use') return textOf(block.id)
  }
  return ''
}

/** Parse newline-delimited JSON, skipping torn lines (both agents append live). */
export function parseJsonl(text: string): Row[] {
  const out: Row[] = []
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const row = asRow(JSON.parse(trimmed))
      if (row) out.push(row)
    } catch {
      /* a half-written last line is normal while the agent is running */
    }
  }
  return out
}

/**
 * Substring filter for the thread list. Matches title, cwd and the tail of the
 * session id, so `robotworld` or `01a0960a` both find their thread.
 */
export function threadMatches(haystack: Array<string | undefined>, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return haystack.some((value) => Boolean(value) && String(value).toLowerCase().includes(needle))
}

/** Bucket key for grouping the thread list by recency. */
export function recencyBucket(at: number, now: number = Date.now()): 'today' | 'week' | 'older' {
  const age = Math.max(0, now - at)
  if (age < 24 * 3600 * 1000) {
    const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
    return sameDay ? 'today' : 'week'
  }
  return age < 7 * 24 * 3600 * 1000 ? 'week' : 'older'
}

export type ChatBlock = { kind: 'text' | 'code'; text: string; lang?: string }

/**
 * Split prose from fenced code blocks. Agent replies are mostly code and
 * diffs; rendering those with the prose font and word wrapping makes them
 * unreadable, and this is the cheapest way to keep them intact without pulling
 * a markdown library into a 420px widget.
 *
 * An unterminated fence (the agent is still streaming) is still returned as
 * code, so a half-received block does not flash as prose.
 */
export function splitBlocks(text: string): ChatBlock[] {
  const source = String(text ?? '')
  const blocks: ChatBlock[] = []
  const fence = /^ {0,3}(```|~~~)[ \t]*([\w+-]*)[^\n]*\n/g
  let cursor = 0
  for (;;) {
    fence.lastIndex = cursor
    const open = fence.exec(source)
    if (!open) break
    const marker = open[1]
    const closeRe = new RegExp(`^ {0,3}${marker === '```' ? '```' : '~~~'}[ \\t]*$`, 'm')
    const rest = source.slice(open.index + open[0].length)
    const close = closeRe.exec(rest)
    const body = close ? rest.slice(0, close.index) : rest
    const prose = source.slice(cursor, open.index)
    if (prose.trim()) blocks.push({ kind: 'text', text: prose.replace(/\n{3,}/g, '\n\n').trim() })
    blocks.push({ kind: 'code', text: body.replace(/\n$/, ''), lang: open[2] || undefined })
    cursor = close ? open.index + open[0].length + close.index + close[0].length : source.length
  }
  const tail = source.slice(cursor)
  if (tail.trim()) blocks.push({ kind: 'text', text: tail.replace(/\n{3,}/g, '\n\n').trim() })
  return blocks
}
