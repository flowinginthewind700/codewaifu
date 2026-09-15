/**
 * The Bench's wire contract: every payload that crosses IPC or the loopback
 * API, plus the parser that turns an untrusted blob into one of them.
 *
 * Three reasons this is its own file rather than inline in `main/pro/ipc.ts`:
 *
 * 1. Nothing here imports Electron or Node, so the renderer can type its own
 *    requests against the same definitions the handler validates.
 * 2. Validation is the security boundary. A channel is allow-listed by name,
 *    but the *payload* is whatever a compromised renderer wants to send, and
 *    `taskId` ends up in a file path (`ledgerFileFor`) and `paneId` in a
 *    spawned argv. Both are checked here, once, and the tests pin them.
 * 3. The HTTP API (`/pro/*`) accepts the same shapes as IPC. One parser, two
 *    transports, so a script and a click cannot disagree about what is legal.
 */
import type { Lang } from './protocol'
import type { Expression } from './ui'
import {
  attentionKindOf,
  DEFAULT_SNOOZE_MINUTES,
  taskStatusOf,
  type AttentionAction,
  type AttentionKind,
  type LedgerKind,
  type StateCounts,
  type TaskStatus
} from './pro'
import type { BenchCommand } from './companionLink'

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

/** Where a decision came from; it lands in the ledger as `source`. */
export type ProOrigin = 'bench' | 'widget' | 'api'

const ORIGINS: readonly string[] = ['bench', 'widget', 'api']

export function originOf(value: unknown): ProOrigin {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (ORIGINS.includes(raw) ? raw : 'bench') as ProOrigin
}

const ACTIONS: readonly string[] = [
  'approve',
  'deny',
  'answer',
  'snooze',
  'open',
  'done',
  'dismiss',
  'reprompt'
]

export function actionOf(value: unknown): AttentionAction | '' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (ACTIONS.includes(raw) ? raw : '') as AttentionAction | ''
}

const LEDGER_KINDS: readonly string[] = [
  'goal',
  'plan',
  'decision',
  'next',
  'event',
  'git',
  'session',
  'metric',
  'checkpoint',
  'note'
]

export function ledgerKindOf(value: unknown): LedgerKind | '' {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (LEDGER_KINDS.includes(raw) ? raw : '') as LedgerKind | ''
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function str(value: unknown, max = 4000): string {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) : value
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * A task id is ours (`t` + base36 + hex) but an HTTP caller can invent one, and
 * it becomes a filename. Rejecting anything with a separator in it is what keeps
 * `ledgerFileFor` from ever writing outside `pro/tasks/`.
 */
export function taskIdOf(value: unknown): string {
  const raw = str(value, 80).trim()
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw) ? raw : ''
}

/** Pane/workspace ids are herdr's (`pane-3`, uuid). Same rule: no separators. */
export function paneIdOf(value: unknown): string {
  const raw = str(value, 120).trim()
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(raw) ? raw : ''
}

function list(value: unknown, max = 16): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => str(entry, 40).trim().toLowerCase())
    .filter(Boolean)
    .slice(0, max)
}

/** A rejected request always says why, in a code the UI can localize. */
export type ProRejectCode =
  | 'bad-payload'
  | 'bad-op'
  | 'bad-task'
  | 'bad-pane'
  | 'bad-action'
  | 'bad-kind'
  | 'needs-text'
  | 'needs-workdir'

export interface ProReject {
  ok: false
  code: ProRejectCode
  error: string
}

function reject(code: ProRejectCode, error: string): ProReject {
  return { ok: false, code, error }
}

/* ------------------------------------------------------------------ *
 * Attention
 * ------------------------------------------------------------------ */

export interface ProActionRequest {
  itemId: string
  action: AttentionAction
  /** Free text for `answer`; ignored by every other verb. */
  text: string
  origin: ProOrigin
  /** Snooze length for `snooze`, minutes. */
  minutes: number
}

export type ProActionParse = ProActionRequest | ProReject

export function parseProAction(payload: unknown): ProActionParse {
  const raw = record(payload)
  const itemId = str(raw.itemId ?? raw.id, 200).trim()
  if (!itemId) return reject('bad-payload', 'itemId is required')
  const action = actionOf(raw.action)
  if (!action) return reject('bad-action', `unknown action ${str(raw.action, 40)}`)
  const text = str(raw.text ?? raw.answer, 4000).trim()
  if (action === 'answer' && !text) return reject('needs-text', 'an answer needs text')
  return {
    itemId,
    action,
    text,
    origin: originOf(raw.origin),
    minutes: int(raw.minutes, DEFAULT_SNOOZE_MINUTES, 1, 240)
  }
}

/* ------------------------------------------------------------------ *
 * Tasks
 * ------------------------------------------------------------------ */

export type ProTaskRequest =
  | {
      op: 'create'
      title: string
      goal: string
      workdir: string
      /** Non-empty means "make a worktree on this branch first". */
      branch: string
      base: string
      worktree: boolean
      agent: string
      /** Launch the agent as part of creation. */
      start: boolean
      /** First prompt, sent once the agent is up. */
      prompt: string
    }
  | { op: 'patch'; taskId: string; title: string; goal: string; branch: string }
  | { op: 'status'; taskId: string; status: TaskStatus }
  | { op: 'remove'; taskId: string }
  | { op: 'adopt' }

export type ProTaskParse = ProTaskRequest | ProReject

export function parseProTask(payload: unknown): ProTaskParse {
  const raw = record(payload)
  const op = str(raw.op, 20).trim().toLowerCase()
  switch (op) {
    case 'create': {
      const workdir = str(raw.workdir ?? raw.dir ?? raw.cwd, 400).trim()
      if (!workdir) return reject('needs-workdir', 'workdir is required')
      return {
        op,
        title: str(raw.title, 160).trim(),
        goal: str(raw.goal, 4000),
        workdir,
        branch: str(raw.branch, 200).trim(),
        base: str(raw.base, 200).trim(),
        worktree: bool(raw.worktree),
        agent: str(raw.agent ?? raw.agentKind, 40).trim().toLowerCase(),
        start: bool(raw.start, true),
        prompt: str(raw.prompt, 8000)
      }
    }
    case 'patch': {
      const taskId = taskIdOf(raw.taskId ?? raw.id)
      if (!taskId) return reject('bad-task', 'taskId is required')
      return {
        op,
        taskId,
        title: str(raw.title, 160).trim(),
        goal: str(raw.goal, 4000),
        branch: str(raw.branch, 200).trim()
      }
    }
    case 'status': {
      const taskId = taskIdOf(raw.taskId ?? raw.id)
      if (!taskId) return reject('bad-task', 'taskId is required')
      return { op, taskId, status: taskStatusOf(raw.status) }
    }
    case 'remove': {
      const taskId = taskIdOf(raw.taskId ?? raw.id)
      if (!taskId) return reject('bad-task', 'taskId is required')
      return { op, taskId }
    }
    case 'adopt':
      return { op }
    default:
      return reject('bad-op', `unknown task op ${str(raw.op, 20)}`)
  }
}

/* ------------------------------------------------------------------ *
 * Ledger
 * ------------------------------------------------------------------ */

export type ProLedgerRequest =
  | { op: 'read'; taskId: string; limit: number }
  | { op: 'digest'; taskId: string }
  | {
      op: 'append'
      taskId: string
      kind: LedgerKind
      text: string
      agent: string
      sessionKind: 'id' | 'path' | ''
      sessionValue: string
      gitHead: string
      branch: string
      dirty: number
      origin: ProOrigin
    }

export type ProLedgerParse = ProLedgerRequest | ProReject

export function parseProLedger(payload: unknown): ProLedgerParse {
  const raw = record(payload)
  const op = str(raw.op, 20).trim().toLowerCase() || 'append'
  const taskId = taskIdOf(raw.taskId ?? raw.id)
  if (!taskId) return reject('bad-task', 'taskId is required')
  if (op === 'read') return { op, taskId, limit: int(raw.limit, 200, 1, 2000) }
  if (op === 'digest') return { op, taskId }
  if (op !== 'append') return reject('bad-op', `unknown ledger op ${str(raw.op, 20)}`)
  const kind = ledgerKindOf(raw.kind)
  if (!kind) return reject('bad-kind', `unknown ledger kind ${str(raw.kind, 20)}`)
  const text = str(raw.text, 8000).trim()
  const sessionValue = str(raw.sessionValue, 400).trim()
  if (!text && !sessionValue) return reject('needs-text', 'a ledger entry needs text or a session')
  const sessionKind = raw.sessionKind === 'path' ? 'path' : raw.sessionKind === 'id' || sessionValue ? 'id' : ''
  return {
    op,
    taskId,
    kind,
    text,
    agent: str(raw.agent, 40).trim().toLowerCase(),
    sessionKind,
    sessionValue,
    gitHead: str(raw.gitHead, 64).trim(),
    branch: str(raw.branch, 200).trim(),
    dirty: int(raw.dirty, 0, 0, 1000000),
    origin: originOf(raw.origin ?? raw.source)
  }
}

/* ------------------------------------------------------------------ *
 * Recovery
 * ------------------------------------------------------------------ */

export type ProRecoveryRequest =
  | { op: 'plans' }
  | { op: 'apply'; taskId: string }
  | { op: 'applyAll' }
  | { op: 'handoff'; taskId: string }
  | { op: 'reprompt'; taskId: string }

export type ProRecoveryParse = ProRecoveryRequest | ProReject

export function parseProRecovery(payload: unknown): ProRecoveryParse {
  const raw = record(payload)
  const op = str(raw.op, 20).trim().toLowerCase() || 'plans'
  if (op === 'plans' || op === 'applyAll') return { op }
  if (op !== 'apply' && op !== 'handoff' && op !== 'reprompt') {
    return reject('bad-op', `unknown recovery op ${str(raw.op, 20)}`)
  }
  const taskId = taskIdOf(raw.taskId ?? raw.id)
  if (!taskId) return reject('bad-task', 'taskId is required')
  return { op, taskId }
}

/* ------------------------------------------------------------------ *
 * Panes and terminal bridges
 * ------------------------------------------------------------------ */

export type ProPaneRequest =
  | { op: 'attach'; paneId: string; cols: number; rows: number; takeover: boolean }
  | { op: 'detach'; paneId: string }
  | { op: 'input'; paneId: string; text: string }
  | { op: 'resize'; paneId: string; cols: number; rows: number }
  | { op: 'scroll'; paneId: string; direction: 'up' | 'down'; lines: number }
  | { op: 'send'; paneId: string; text: string; enter: boolean }
  | { op: 'keys'; paneId: string; keys: string[] }
  | { op: 'focus'; paneId: string }
  | { op: 'zoom'; paneId: string; mode: 'toggle' | 'on' | 'off' }
  | { op: 'read'; paneId: string; lines: number }

export type ProPaneParse = ProPaneRequest | ProReject

const PANE_OPS: readonly string[] = [
  'attach',
  'detach',
  'input',
  'resize',
  'scroll',
  'send',
  'keys',
  'focus',
  'zoom',
  'read'
]

export function parseProPane(payload: unknown): ProPaneParse {
  const raw = record(payload)
  const op = str(raw.op, 20).trim().toLowerCase()
  if (!PANE_OPS.includes(op)) return reject('bad-op', `unknown pane op ${str(raw.op, 20)}`)
  const paneId = paneIdOf(raw.paneId ?? raw.id)
  if (!paneId) return reject('bad-pane', 'paneId is required')
  const cols = int(raw.cols, 120, 20, 400)
  const rows = int(raw.rows, 40, 5, 200)
  switch (op) {
    case 'attach':
      return { op, paneId, cols, rows, takeover: bool(raw.takeover) }
    case 'resize':
      return { op, paneId, cols, rows }
    case 'scroll':
      return {
        op,
        paneId,
        direction: raw.direction === 'up' ? 'up' : 'down',
        lines: int(raw.lines, 3, 1, 200)
      }
    case 'send':
      return { op, paneId, text: str(raw.text, 8000), enter: bool(raw.enter, true) }
    case 'keys':
      return { op, paneId, keys: list(raw.keys, 8) }
    case 'input': {
      const text = str(raw.text, 4000)
      if (!text) return reject('needs-text', 'input needs text')
      return { op, paneId, text }
    }
    case 'zoom': {
      const mode = str(raw.mode, 10).trim().toLowerCase()
      return { op, paneId, mode: mode === 'on' || mode === 'off' ? mode : 'toggle' }
    }
    case 'read':
      return { op, paneId, lines: int(raw.lines, 40, 1, 400) }
    default:
      return { op: 'detach', paneId }
  }
}

/* ------------------------------------------------------------------ *
 * Host / discovery
 * ------------------------------------------------------------------ */

export type ProHostRequest =
  | { op: 'discovery' }
  | { op: 'agents' }
  | { op: 'pickDir' }
  | { op: 'openPath'; path: string }

export type ProHostParse = ProHostRequest | ProReject

export function parseProHost(payload: unknown): ProHostParse {
  const raw = record(payload)
  const op = str(raw.op, 20).trim().toLowerCase() || 'discovery'
  if (op === 'discovery' || op === 'agents' || op === 'pickDir') return { op }
  if (op === 'openPath') {
    const target = str(raw.path, 400).trim()
    if (!target) return reject('bad-payload', 'path is required')
    return { op, path: target }
  }
  return reject('bad-op', `unknown host op ${str(raw.op, 20)}`)
}

/* ------------------------------------------------------------------ *
 * Companion: bench -> widget, widget -> bench
 * ------------------------------------------------------------------ */

export type ProCompanionRequest =
  | { op: 'summon' }
  | { op: 'dismiss' }
  | { op: 'toggle' }
  | { op: 'announce'; text: string; lang: Lang }

export type ProCompanionParse = ProCompanionRequest | ProReject

export function parseProCompanion(payload: unknown): ProCompanionParse {
  const raw = record(payload)
  const op = str(raw.op ?? raw.type, 20).trim().toLowerCase()
  if (op === 'summon' || op === 'dismiss' || op === 'toggle') return { op }
  if (op === 'announce') {
    const text = str(raw.text, 400).trim()
    if (!text) return reject('needs-text', 'an announcement needs text')
    return { op, text, lang: raw.lang === 'en' ? 'en' : 'zh' }
  }
  return reject('bad-op', `unknown companion op ${str(raw.op ?? raw.type, 20)}`)
}

/**
 * What the widget is allowed to ask the Bench for. Deliberately narrower than
 * the Bench's own surface: she can route, act on an item and snooze the queue,
 * and nothing else. In particular there is no `input` verb here — the widget
 * must never become a second keyboard for a pane (see MVP section 9).
 */
export type ProCommandParse = BenchCommand | ProReject

export function parseBenchCommand(payload: unknown): ProCommandParse {
  const raw = record(payload)
  const type = str(raw.type ?? raw.op, 20).trim().toLowerCase()
  switch (type) {
    case 'openBench':
    case 'open':
      return { type: 'openBench' }
    case 'snoozeAll':
      return { type: 'snoozeAll', minutes: int(raw.minutes, DEFAULT_SNOOZE_MINUTES, 1, 240) }
    case 'focusTask':
    case 'focus': {
      const taskId = taskIdOf(raw.taskId)
      if (!taskId) return reject('bad-task', 'taskId is required')
      const paneId = paneIdOf(raw.paneId)
      return paneId ? { type: 'focusTask', taskId, paneId } : { type: 'focusTask', taskId }
    }
    case 'act': {
      const itemId = str(raw.itemId, 200).trim()
      const taskId = taskIdOf(raw.taskId)
      const action = actionOf(raw.action)
      if (!itemId) return reject('bad-payload', 'itemId is required')
      if (!taskId) return reject('bad-task', 'taskId is required')
      if (!action) return reject('bad-action', `unknown action ${str(raw.action, 40)}`)
      const text = str(raw.text, 4000).trim()
      if (action === 'answer' && !text) return reject('needs-text', 'an answer needs text')
      const paneId = paneIdOf(raw.paneId)
      const base = { type: 'act' as const, action, itemId, taskId, text }
      return paneId ? { ...base, paneId } : base
    }
    default:
      return reject('bad-op', `unknown bench command ${str(raw.type ?? raw.op, 20)}`)
  }
}

/* ------------------------------------------------------------------ *
 * Pushes (main -> renderer)
 * ------------------------------------------------------------------ */

/** One bridge's phase, mirrored from `main/pro/herdr/terminalBridge.ts`. */
export type ProBridgePhase = 'idle' | 'starting' | 'live' | 'respawning' | 'closed' | 'error'

export interface ProBridgePush {
  paneId: string
  phase: ProBridgePhase
  live: boolean
  cols: number
  rows: number
  /** Frames herdr sent that we dropped because the renderer fell behind. */
  dropped: number
  error: string
}

/**
 * A frame on the wire: still base64, so neither main nor the preload ever
 * decodes ANSI. `full` means "reset the terminal before writing this".
 */
export interface ProFramePush {
  paneId: string
  seq: number
  full: boolean
  width: number
  height: number
  bytes: string
}

export interface ProFramesPush {
  frames: ProFramePush[]
}

export interface ProFocusPush {
  taskId: string
  paneId: string
  /** Why: a bubble click, an HTTP call, the tray. Shown as a toast. */
  reason: string
  at: number
}

export interface ProNoticePush {
  text: string
  lang: Lang
  tone: 'info' | 'warn' | 'error'
  at: number
}

/** The widget's whole view of the bench: one object, no second source. */
export interface ProCompanionPush {
  /** Live attention count. The badge number, everywhere. */
  notices: number
  /** Her face. Computed in `companionLink`, never in the renderer. */
  expression: Expression
  /** Fleet counts, so "3 blocked" can be spoken without a full view. */
  counts: StateCounts
  benchFocused: boolean
  widgetVisible: boolean
  /** Item id currently being announced, '' when idle. */
  announcing: string
  at: number
}

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

/**
 * Every mutating call answers with the same envelope. `detail` is prose for a
 * human (already localized by the caller's lang), `code` is for a machine, and
 * `ok:false` never throws across IPC: a failed approve is a message in the
 * queue, not an exception in the renderer.
 */
/**
 * `T` defaults to `unknown` rather than to a record type on purpose: a bare
 * `ProResult` in a signature means "some payload or nothing", and every result
 * that does carry data must stay assignable to it. A stricter default makes
 * `Promise<ProResult>` unusable as an interface method type.
 */
export interface ProResult<T = unknown> {
  ok: boolean
  detail: string
  code: string
  data: T | null
}

export function okResult<T>(data: T | null = null, detail = '', code = ''): ProResult<T> {
  return { ok: true, detail, code, data }
}

export function failResult(code: string, detail: string): ProResult<never> {
  return { ok: false, detail, code, data: null } as ProResult<never>
}

/** Attention kinds the widget may render as a bubble route. */
export function isAttentionKind(value: unknown): value is AttentionKind {
  return attentionKindOf(value) !== ''
}
