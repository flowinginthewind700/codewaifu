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
import { DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT } from './chat'
import {
  attentionKindOf,
  DEFAULT_SNOOZE_MINUTES,
  taskStatusOf,
  type AttentionAction,
  type AttentionItem,
  type AttentionKind,
  type LedgerKind,
  type StateCounts,
  type TaskStatus
} from './pro'
import type { BenchCommand } from './companionLink'
import { TERMINAL_SCROLL_LINES_MAX, type PaneScroll } from './herdr'
import {
  clampPort,
  makeMachine,
  parseTarget,
  type MachineSource,
  type ProbeStatus,
  type SshMachine
} from './ssh'

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
  | 'bad-machine'
  | 'needs-text'
  | 'needs-workdir'
  | 'no-item'

export interface ProReject {
  ok: false
  code: ProRejectCode
  error: string
}

function reject(code: ProRejectCode, error: string): ProReject {
  return { ok: false, code, error }
}

/**
 * The one guard that tells a parsed request from a rejection. It lives here
 * rather than in each transport because IPC, HTTP and the companion bridge all
 * branch on it, and three copies of a two-line predicate is three chances to
 * let a rejected payload through to the service.
 */
export function isProReject(value: unknown): value is ProReject {
  return Boolean(value) && typeof value === 'object' && (value as { ok?: unknown }).ok === false
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

/**
 * `POST /pro/answer`, the one route whose caller is not looking at the queue.
 *
 * A script or another agent knows a *task* and some text; the bench acts on an
 * *item id*. Resolving between them is a pure function of the ranked queue, so
 * an HTTP caller, a bubble click and a test cannot disagree about which prompt
 * an answer lands on:
 *
 * - an explicit `itemId` always wins, and is the only way to hit a snoozed item;
 * - otherwise the first unresolved item of `taskId`, in queue order, which is
 *   already ordered by how long the agent has been blocked;
 * - `paneId` and `kind` narrow that match, and narrowing is strict: if the pane
 *   the caller named has no open item we answer nothing rather than sending text
 *   to a different prompt. Guessing here types into an agent's terminal.
 *
 * `origin` is pinned to `api` and is not read from the payload. The ledger
 * records who made a decision, and an HTTP caller is not the bench window no
 * matter what it claims.
 */
export function parseProAnswer(
  payload: unknown,
  attention: readonly AttentionItem[]
): ProActionParse {
  const raw = record(payload)
  const action = actionOf(raw.action) || 'answer'
  const text = str(raw.text ?? raw.answer, 4000).trim()
  if (action === 'answer' && !text) return reject('needs-text', 'an answer needs text')
  const itemId = str(raw.itemId, 200).trim() || matchAttentionItem(raw, attention)
  if (!itemId) {
    const taskId = taskIdOf(raw.taskId ?? raw.task)
    return reject(
      'no-item',
      taskId ? `no open attention item for task ${taskId}` : 'itemId or taskId is required'
    )
  }
  return {
    itemId,
    action,
    text,
    origin: 'api',
    minutes: int(raw.minutes, DEFAULT_SNOOZE_MINUTES, 1, 240)
  }
}

function matchAttentionItem(
  raw: Record<string, unknown>,
  attention: readonly AttentionItem[]
): string {
  const taskId = taskIdOf(raw.taskId ?? raw.task)
  if (!taskId) return ''
  const paneId = paneIdOf(raw.paneId)
  const kind = attentionKindOf(raw.kind)
  const open = attention.filter(
    (item) =>
      item.taskId === taskId &&
      !item.resolved &&
      (!paneId || item.paneId === paneId) &&
      (!kind || item.kind === kind)
  )
  return open[0]?.id ?? ''
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
  /**
   * Drop the row, and optionally the shell underneath it.
   *
   * `closeShell` is the difference between "hide this" and "get rid of this".
   * Absent means keep the workspace running, which is what a script calling the
   * HTTP API has always got; the bench sends an explicit answer from a checkbox
   * the human just read.
   */
  | { op: 'remove'; taskId: string; closeShell: boolean }
  | { op: 'adopt' }
  /**
   * Close every live workspace a remembered removal is holding off the bench.
   * The chip in the topbar is the only thing that reports those, so this is the
   * verb that answers it: one click and herdr stops carrying shells nobody can
   * reach from here.
   */
  | { op: 'purge' }
  /**
   * Pull sessions the companion can already see into the tree. `keys` are
   * `${agent}:${id}` thread keys; the service resolves them against the live
   * thread list, so a key that has aged out imports nothing and says so.
   * `attach` means "and put it to work now": the task is created active and the
   * recovery plan resumes the conversation in a workspace the bench owns.
   */
  | { op: 'import'; keys: string[]; attach: boolean }
  /**
   * The conversation behind a task, read from the agent's own transcript file.
   *
   * This is the surface for work the bench did not start. An imported session
   * is running in somebody else's terminal, so herdr has no pane for it and the
   * pane grid has nothing to draw; without this op the tree row is the whole of
   * what an import gives you, which reads as "the import lost the conversation"
   * rather than as "the conversation lives in a file we did not open". Same
   * reader the stage's chat view uses, so both modes show the same words.
   */
  | { op: 'transcript'; taskId: string; limit: number; fresh: boolean }
  /**
   * Answer the session behind a task. Codex takes a queue write, Claude has no
   * injection API and gets the clipboard; `steer.ts` already tells the two
   * apart, and the bench reports whatever it says instead of guessing.
   */
  | { op: 'steer'; taskId: string; message: string }

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
      return { op, taskId, closeShell: bool(raw.closeShell ?? raw.close) }
    }
    case 'adopt':
      return { op }
    case 'purge':
      return { op }
    case 'import': {
      const keys = threadKeysOf(raw.keys ?? raw.ids)
      if (!keys.length) return reject('bad-payload', 'import needs at least one thread key')
      return { op, keys, attach: bool(raw.attach) }
    }
    case 'transcript': {
      const taskId = taskIdOf(raw.taskId ?? raw.id)
      if (!taskId) return reject('bad-task', 'taskId is required')
      return {
        op,
        taskId,
        limit: int(raw.limit, DEFAULT_MESSAGE_LIMIT, 1, MAX_MESSAGE_LIMIT),
        fresh: bool(raw.fresh)
      }
    }
    case 'steer': {
      const taskId = taskIdOf(raw.taskId ?? raw.id)
      if (!taskId) return reject('bad-task', 'taskId is required')
      const message = str(raw.message ?? raw.text, 8000).trim()
      if (!message) return reject('bad-payload', 'steer needs a message')
      return { op, taskId, message }
    }
    default:
      return reject('bad-op', `unknown task op ${str(raw.op, 20)}`)
  }
}

/**
 * Thread keys, kept verbatim: `list()` lower-cases and truncates at 40, which
 * is right for agent names and wrong for a session id that is the only handle
 * on a conversation. A key that is not `agent:id` is dropped, and duplicates
 * collapse, because importing one session twice would be two rows for one
 * piece of work.
 */
export function threadKeysOf(value: unknown, max = 200): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const key = str(entry, 200).trim()
    if (!/^[A-Za-z0-9._-]{1,40}:[^\s:/\\]{1,150}$/.test(key)) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= max) break
  }
  return out
}

/**
 * One session the companion can see, as the import picker renders it. This is
 * the thread list plus the one thing the picker has to know that the thread
 * list does not: whether the bench already has a task for it.
 */
export interface ImportCandidate {
  key: string
  agent: string
  id: string
  title: string
  cwd: string
  updatedAt: number
  live: boolean
  /** Non-empty once a task claims this session; the row is then not offered. */
  taskId: string
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
  // Compared folded, returned canonical: `op` is lower-cased above, so a
  // camelCase comparison can never match. See parseProHost.
  if (op === 'plans') return { op }
  if (op === 'applyall') return { op: 'applyAll' }
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
  | {
      op: 'scroll'
      paneId: string
      direction: 'up' | 'down'
      lines: number
      source: 'wheel' | 'page_key'
    }
  | { op: 'scrollBottom'; paneId: string }
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
  // Lower-cased on the wire like every other op; `parseProPane` returns the
  // camelCase spelling callers switch on. Same dance as `applyall` above.
  'scrollbottom',
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
        // 200 was a guess from before this was measured: herdr's `lines` is a
        // u16, so the real ceiling is its own. A page key on a tall pane and a
        // trackpad flick both want more than 200, and clamping here would make
        // the pane crawl while the gesture said "go".
        lines: int(raw.lines, 3, 1, TERMINAL_SCROLL_LINES_MAX),
        source: raw.source === 'page_key' ? 'page_key' : 'wheel'
      }
    case 'scrollbottom':
      return { op: 'scrollBottom', paneId }
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
  /** Sessions the companion can see, with the task that already claims each. */
  | { op: 'threads' }
  | { op: 'pickDir' }
  | { op: 'openPath'; path: string }
  | { op: 'openExternal'; url: string }

export type ProHostParse = ProHostRequest | ProReject

/**
 * What a terminal link is allowed to be. Pane output is the one thing in this
 * app that is not ours: an agent prints any string it likes, and
 * `shell.openExternal` hands it straight to the OS. A `file:` URL would read
 * local state through whatever browser is registered, and a vendor scheme would
 * launch whatever claimed it, so the list stays short and closed.
 */
const EXTERNAL_SCHEME = /^(?:https?:|mailto:)/i

/**
 * Fold the op to lower case for tolerance, then return the canonical literal.
 *
 * The fold and the comparison used to disagree: `op` was lower-cased and then
 * tested against `pickDir` and `openPath`, so every camelCase host op fell
 * through to `bad-op`. The renderer's "choose directory" and "open folder"
 * buttons were dead on arrival and reported it as an unknown verb, which reads
 * like a version mismatch rather than a typo. Comparing on the folded form and
 * returning the literal the service switches on keeps one spelling per side.
 */
export function parseProHost(payload: unknown): ProHostParse {
  const raw = record(payload)
  const op = str(raw.op, 20).trim().toLowerCase() || 'discovery'
  switch (op) {
    case 'discovery':
    case 'agents':
    case 'threads':
      return { op }
    case 'pickdir':
      return { op: 'pickDir' }
    case 'openpath': {
      const target = str(raw.path, 400).trim()
      if (!target) return reject('bad-payload', 'path is required')
      return { op: 'openPath', path: target }
    }
    case 'openexternal': {
      const url = str(raw.url, 2000).trim()
      if (!EXTERNAL_SCHEME.test(url)) {
        return reject('bad-payload', 'only http, https and mailto links open')
      }
      return { op: 'openExternal', url }
    }
    default:
      return reject('bad-op', `unknown host op ${str(raw.op, 20)}`)
  }
}

/* ------------------------------------------------------------------ *
 * SSH and local terminals
 * ------------------------------------------------------------------ */

/**
 * One verb per thing the connect palette can do. `machine` and `target` travel
 * together and either may be empty: a roster row sends the machine it was
 * built from, the free-form row sends only what the human typed, and the
 * service is the one that decides which wins (it owns `~/.ssh/config`, so it
 * is also the only layer that can tell an alias from a hostname).
 */
export type ProSshRequest =
  /** The ranked roster, filtered the way the palette's input filters. */
  | { op: 'list'; query: string }
  /** Public keys in `~/.ssh`, conventional first. */
  | { op: 'keys' }
  | { op: 'probe'; machine: SshMachine | null; target: string }
  | { op: 'save'; machine: SshMachine | null; target: string }
  | { op: 'remove'; id: string }
  /**
   * Open a session: a pane, a task record, and the connect line typed into it.
   * `save` pins the machine as a side effect, which is what makes the second
   * connect to the same box one keystroke.
   */
  | { op: 'connect'; machine: SshMachine | null; target: string; save: boolean; cwd: string }
  /**
   * Make a machine passwordless. `run` types the setup line into a pane (the
   * human still answers the password prompt); without it we only hand back the
   * lines, for a palette that wants to show what it would do.
   */
  | { op: 'setup'; machine: SshMachine | null; target: string; key: string; run: boolean }
  /** A plain local shell. Empty `cwd` means home. */
  | { op: 'terminal'; cwd: string }

export type ProSshParse = ProSshRequest | ProReject

/** The roster, plus the home an empty directory field will resolve to. */
export interface ProSshRoster {
  machines: SshMachine[]
  home: string
}

/** One probe's verdict. `detail` is the last line ssh printed, for a tooltip. */
export interface ProSshProbe {
  machine: SshMachine
  status: ProbeStatus
  detail: string
}

/** Public keys in `~/.ssh`, and the one a setup would use by default. */
export interface ProSshKeys {
  keys: string[]
  key: string
}

/**
 * What opening a session produced. The renderer does not need the task record -
 * the projection push that follows carries it - but it does need the ids to
 * focus the right pane and to tell "typed" from "opened but silent".
 */
export interface ProSessionOpened {
  taskId: string
  workspaceId: string
  paneId: string
  /** How many of the requested lines actually reached the pane. */
  typed: number
}

/** The passwordless plan: the lines that would run, and the key they publish. */
export interface ProSshSetup {
  lines: string[]
  key: string
}

const MACHINE_SOURCES: readonly string[] = ['saved', 'config', 'herdr']

function machineSourceOf(value: unknown): MachineSource {
  const raw = str(value, 10).trim().toLowerCase()
  return (MACHINE_SOURCES.includes(raw) ? raw : 'saved') as MachineSource
}

/**
 * Narrow an untrusted `machine` blob. `makeMachine` is the same constructor the
 * roster uses, so a machine that arrives over the wire is clamped, trimmed and
 * labelled exactly like one that arrived from disk - and a hostile `port` or a
 * `host` carrying shell metacharacters becomes a quoted single argument rather
 * than something typed raw into a pane.
 */
export function machineOf(value: unknown): SshMachine | null {
  const raw = record(value)
  const host = str(raw.host, 200).trim()
  const alias = str(raw.alias, 200).trim()
  if (!host && !alias) return null
  return makeMachine({
    id: str(raw.id, 80).trim(),
    label: str(raw.label, 200).trim(),
    host: host || alias,
    port: clampPort(raw.port),
    user: str(raw.user, 100).trim(),
    identityFile: str(raw.identityFile, 400).trim(),
    proxyJump: str(raw.proxyJump, 400).trim(),
    alias,
    source: machineSourceOf(raw.source)
  })
}

/**
 * A free-form `user@host:port`, kept as typed; the service parses it.
 *
 * One whitespace-bearing shape is allowed through: a whole `ssh` command line,
 * because that is how a machine arrives from a README or a shell history, and
 * the palette is exactly where someone would paste it. It is admitted only when
 * `parseTarget` can read it as tokens, and that parser refuses any line with a
 * shell metacharacter in it - so `host; rm -rf ~` is dropped here the same as it
 * ever was. A newline is never a target: one line, one destination.
 */
function targetOf(value: unknown): string {
  const raw = str(value, 300)
    .trim()
    .replace(/[ \t]+/g, ' ')
  if (!raw || /[\r\n]/.test(raw)) return ''
  return /\s/.test(raw) && !parseTarget(raw) ? '' : raw
}

/** `~` and '' both mean home; anything else must be an absolute-ish path. */
function cwdOf(value: unknown): string {
  return str(value, 400).trim()
}

export function parseProSsh(payload: unknown): ProSshParse {
  const raw = record(payload)
  const op = str(raw.op, 20).trim().toLowerCase() || 'list'
  switch (op) {
    case 'list':
      // Trimmed like every other field here. `rankMachines` trims again, so
      // this is about the contract rather than the result: a filter that
      // arrives with the palette's trailing space still on it is not the same
      // string the palette thinks it sent.
      return { op, query: str(raw.query ?? raw.q, 200).trim() }
    case 'keys':
      return { op }
    case 'remove': {
      const id = str(raw.id, 120).trim()
      if (!id) return reject('bad-machine', 'a machine id is required')
      return { op, id }
    }
    case 'terminal':
      return { op, cwd: cwdOf(raw.cwd ?? raw.workdir ?? raw.path) }
    case 'probe':
    case 'save':
    case 'connect':
    case 'setup': {
      const machine = machineOf(raw.machine)
      const target = targetOf(raw.target)
      if (!machine && !target) {
        return reject('bad-machine', 'a machine or an ssh target is required')
      }
      if (op === 'save') return { op, machine, target }
      if (op === 'connect') {
        return {
          op,
          machine,
          target,
          save: bool(raw.save, true),
          cwd: cwdOf(raw.cwd ?? raw.workdir)
        }
      }
      if (op === 'setup') {
        return { op, machine, target, key: str(raw.key, 400).trim(), run: bool(raw.run, true) }
      }
      return { op, machine, target }
    }
    default:
      return reject('bad-op', `unknown ssh op ${str(raw.op, 20)}`)
  }
}

/* ------------------------------------------------------------------ *
 * Companion: bench -> widget, widget -> bench
 * ------------------------------------------------------------------ */

export type ProCompanionRequest =
  | { op: 'summon' }
  | { op: 'dismiss' }
  | { op: 'toggle' }
  /**
   * Hand the screen back: the bench goes away and the stage comes forward. It
   * is a mode switch inside one app, not "show the widget" - the widget may
   * already be visible, and what the human asked for is to be back on it.
   */
  | { op: 'stage' }
  | { op: 'announce'; text: string; lang: Lang }

export type ProCompanionParse = ProCompanionRequest | ProReject

export function parseProCompanion(payload: unknown): ProCompanionParse {
  const raw = record(payload)
  const op = str(raw.op ?? raw.type, 20).trim().toLowerCase()
  if (op === 'summon' || op === 'dismiss' || op === 'toggle' || op === 'stage') return { op }
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
    // Same rule as parseProHost: `type` is folded, so the labels are folded
    // and the values returned stay canonical. The short aliases are kept
    // because a widget author typing 'open' is not a protocol violation.
    case 'openbench':
    case 'open':
      return { type: 'openBench' }
    case 'snoozeall':
      return { type: 'snoozeAll', minutes: int(raw.minutes, DEFAULT_SNOOZE_MINUTES, 1, 240) }
    case 'focustask':
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
  /**
   * Where the pane is scrolled, when herdr told us. Absent means "unchanged
   * since the last push", not "at the bottom": a bridge push happens on every
   * phase flip and resize too, and re-sending a stale 0 would clear an honest
   * "you are 400 lines back" chip.
   */
  scroll?: PaneScroll
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
