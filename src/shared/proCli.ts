/**
 * The bench, typed into a terminal.
 *
 * `codewaifu pro <verb>` is the fourth render of one authority: it reads the
 * same endpoint file the hook runners read and speaks the same `/pro/*` routes
 * the Bench window and the widget speak, so a shell, a cron job or another agent
 * can see the queue and unblock it without a GUI. Two rules keep that from
 * becoming a second, worse implementation:
 *
 * 1. This module is pure. Parsing turns argv into a typed call, rendering turns
 *    a payload into text, and neither touches a socket, the clock (`now` is
 *    always an argument) or the disk. That is what lets `tests/proCli.test.ts`
 *    pin the whole table instead of one happy path.
 * 2. It invents no verbs. Every command maps onto one existing route and is
 *    re-validated on the far side by the same parsers the Bench uses
 *    (`parseProAnswer`, `parseProTask`, `parseProLedger`), so the CLI can never
 *    accept an argument the bench would refuse and can never reach a capability
 *    the relay does not expose. There is deliberately no `send-keys` here: a
 *    script is not a second keyboard for a terminal (MVP section 9).
 *
 * Text is English and ASCII. This is a terminal, not the widget, and a box
 * drawing character is a mojibake risk on a console we cannot see.
 */
import { attentionActions, needsRecovery, recoveryStepText, waitedMs } from './pro'
import type {
  AttentionItem,
  AttentionKind,
  BenchView,
  GroupView,
  LedgerDigest,
  LedgerEntry,
  RecoveryPlan,
  StateCounts,
  TaskRecord,
  TaskView
} from './pro'
import type { ProResult } from './proIpc'

export type ProCliVerb =
  | 'state'
  | 'attention'
  | 'recovery'
  | 'watch'
  | 'answer'
  | 'new'
  | 'log'
  | 'park'
  | 'resume'
  | 'done'
  | 'remove'
  | 'adopt'

/** One parsed command: exactly what the relay needs, and nothing else. */
export interface ProCliCall {
  kind: 'call'
  verb: ProCliVerb
  /** `--json`: print the payload instead of the rendering. */
  json: boolean
  method: 'GET' | 'POST'
  path: string
  /** null for a GET: the relay rejects a body it did not ask for. */
  body: Record<string, unknown> | null
}

export interface ProCliHelp {
  kind: 'help'
  json: boolean
}

export type ProCliCode =
  | 'bad-verb'
  | 'bad-action'
  | 'bad-kind'
  | 'needs-target'
  | 'needs-text'
  | 'needs-title'

export interface ProCliReject {
  kind: 'reject'
  code: ProCliCode
  error: string
}

export type ProCliParse = ProCliCall | ProCliHelp | ProCliReject

/**
 * Exit codes a script can branch on without reading prose. They mirror the
 * relay's own status classes (see `PRO_STATUS` in main/server.ts) so `curl` and
 * `codewaifu pro` agree about what went wrong.
 */
export const PRO_EXIT = {
  ok: 0,
  fault: 1,
  usage: 2,
  offline: 3,
  missing: 4,
  refused: 5,
  token: 6
} as const

export function exitForStatus(status: number): number {
  if (status >= 200 && status < 300) return PRO_EXIT.ok
  if (status === 400) return PRO_EXIT.usage
  if (status === 401 || status === 403) return PRO_EXIT.token
  if (status === 404) return PRO_EXIT.missing
  if (status === 409) return PRO_EXIT.refused
  // 429 is only ever `too-many-watchers`: the relay understood the request and
  // declined it, which is what exit 5 means, and a script that reads 1 here
  // would go looking for a bug instead of for a watcher to close.
  if (status === 429) return PRO_EXIT.refused
  if (status === 503) return PRO_EXIT.offline
  return PRO_EXIT.fault
}

const ACTIONS: readonly string[] = [
  'answer',
  'approve',
  'deny',
  'snooze',
  'done',
  'dismiss',
  'reprompt',
  'open'
]
const KINDS: readonly string[] = ['permission', 'question', 'review', 'stalled', 'failed']
const STATUS_VERB: Record<string, 'parked' | 'active' | 'done'> = {
  park: 'parked',
  resume: 'active',
  done: 'done'
}

/** Flags that take a value; everything else is a switch. */
const VALUE_FLAGS = new Set([
  'task',
  'item',
  'pane',
  'kind',
  'action',
  'minutes',
  'text',
  'dir',
  'agent',
  'goal',
  'branch',
  'base',
  'prompt',
  'title',
  'limit'
])

const SHORT_FLAGS: Record<string, string> = {
  t: 'task',
  i: 'item',
  a: 'action',
  d: 'dir',
  C: 'dir',
  n: 'limit'
}

export const PRO_CLI_USAGE = `CodeWaifu Pro on the command line

Usage:
  codewaifu pro <verb> [args] [--json]

See the bench:
  state                       the tree: groups, tasks, live states, what needs you
  attention                   the ranked queue, with the ids an answer needs
  recovery                    what survived the last interruption, and what it takes
                              (read-only: the Bench window applies a plan)
  watch                       the tree, then one line per change until ctrl-c
                              (--json streams the raw frames, for a script)

Act on it:
  answer <id> <text...>       answer an agent; <id> is an item id or a task id
    --action <verb>           answer | approve | deny | snooze | done | dismiss | reprompt
    --minutes <n>             snooze length (default 15)
    --pane <id> --kind <k>    narrow a task id to one pane or one kind of need
  approve <id> / deny <id>    sugar for --action approve / --action deny

Start and file work:
  new <title...>              create a task and launch its agent
    --dir <path>              where it runs (default: the current directory)
    --agent <name>            herdr manifest id: codex, claude, ...
    --goal <text>             the line the recovery planner quotes back to you
    --prompt <text>           first message, sent once the agent is up
    --branch <name>           branch to make; add --worktree to make it a worktree
    --no-start                file the task without launching anything
  adopt                       turn herdr workspaces that are not tasks into tasks

Task state:
  park <taskId>               stop counting it; its panes keep running
  resume <taskId>             bring it back to active
  done <taskId>               mark it finished and clear its queue
  rm <taskId>                 drop the task record (its ledger stays on disk)
  log <taskId>                the audit trail; --digest for goal / plan / next

Text after -- is taken literally, so a prompt may start with a dash.
Exits: 0 ok, 2 bad arguments, 3 bench or herdr not running, 4 no such task or
item, 5 understood and refused, 6 the app did not accept our token.
`

interface Split {
  flags: Map<string, string>
  switches: Set<string>
  positional: string[]
  json: boolean
  help: boolean
}

function split(args: readonly string[]): Split {
  const flags = new Map<string, string>()
  const switches = new Set<string>()
  const positional: string[] = []
  let json = false
  let help = false
  let literal = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (literal) {
      positional.push(arg)
      continue
    }
    if (arg === '--') {
      literal = true
      continue
    }
    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg)
      continue
    }
    let name = ''
    let inline: string | null = null
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      name = (eq > 0 ? arg.slice(2, eq) : arg.slice(2)).toLowerCase()
      if (eq > 0) inline = arg.slice(eq + 1)
    } else {
      name = SHORT_FLAGS[arg.slice(1)] ?? arg.slice(1)
    }
    if (name === 'json') {
      json = true
      continue
    }
    if (name === 'help' || name === 'h') {
      help = true
      continue
    }
    if (VALUE_FLAGS.has(name)) {
      // A flag with no value is an empty value, never the next positional:
      // `pro answer --task "yes go ahead"` must not quietly answer an unnamed
      // item with the text as its id.
      let value = inline
      if (value === null) {
        const next = args[i + 1] ?? ''
        if (next && !next.startsWith('-')) {
          i += 1
          value = next
        } else {
          value = ''
        }
      }
      flags.set(name, value)
      continue
    }
    switches.add(name)
  }
  return { flags, switches, positional, json, help }
}

function call(
  verb: ProCliVerb,
  method: 'GET' | 'POST',
  path: string,
  body: Record<string, unknown> | null,
  json: boolean
): ProCliCall {
  return { kind: 'call', verb, json, method, path, body }
}

function reject(code: ProCliCode, error: string): ProCliReject {
  return { kind: 'reject', code, error }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Parse `codewaifu pro ...`. The full argv is accepted (a leading `--cli` or
 * anything before `pro` is ignored) so a caller never has to slice it right.
 */
export function parseProCli(args: readonly string[]): ProCliParse {
  const at = args.findIndex((arg) => arg === 'pro')
  const rest = at >= 0 ? args.slice(at + 1) : args.slice()
  // The verb is the first token that is not a flag, so `pro --json state` and
  // `pro state --json` are one command. Reading rest[0] makes the first spelling
  // an unknown verb, which a human reads as "the CLI has no such feature"
  // rather than as "put the flag after the verb".
  const verbAt = rest.findIndex((arg) => !arg.startsWith('-') || arg === '-')
  const verb = (verbAt >= 0 ? rest[verbAt] : 'help').toLowerCase()
  const around = verbAt >= 0 ? [...rest.slice(0, verbAt), ...rest.slice(verbAt + 1)] : rest
  const { flags, switches, positional, json, help } = split(around)
  if (help) return { kind: 'help', json }

  switch (verb) {
    case '':
    case 'help':
      return { kind: 'help', json }

    case 'state':
    case 'ls':
      return call('state', 'GET', '/pro/state', null, json)

    case 'attention':
    case 'queue':
      return call('attention', 'GET', '/pro/attention', null, json)

    case 'recovery':
      // The plans ride along in the projection, so this is a GET of the same
      // route `state` reads: no new surface, and no way for the terminal to be
      // told something the window was not.
      return call('recovery', 'GET', '/pro/state', null, json)

    case 'watch':
    case 'tail':
    case 'follow':
      // The one route that pushes. Same payload as `state`, delivered per change
      // instead of per poll, so the runner treats it as its own verb: a request
      // that never finishes cannot go through the read path's timeout.
      return call('watch', 'GET', '/pro/stream', null, json)

    case 'answer':
    case 'approve':
    case 'deny':
    case 'snooze': {
      const action = verb === 'answer' ? str(flags.get('action')) || 'answer' : verb
      if (!ACTIONS.includes(action)) {
        return reject('bad-action', `unknown action: ${action || '(empty)'}`)
      }
      const item = str(flags.get('item'))
      const task = str(flags.get('task'))
      const first = positional[0] ?? ''
      if (!item && !task && !first) {
        return reject('needs-target', `${verb} needs an item id or a task id`)
      }
      const body: Record<string, unknown> = { action }
      if (item) body.itemId = item
      if (task) body.taskId = task
      if (!item && !task && first) {
        // An attention id is `taskId:kind:origin` and a task id can never hold a
        // colon, so the colon is the whole rule. Guessing wrong here would type
        // into a different agent's terminal.
        if (first.includes(':')) body.itemId = first
        else body.taskId = first
      }
      const pane = str(flags.get('pane'))
      const kind = str(flags.get('kind'))
      if (pane) body.paneId = pane
      if (kind) {
        if (!KINDS.includes(kind)) return reject('bad-kind', `unknown attention kind: ${kind}`)
        body.kind = kind
      }
      const text = str(flags.get('text')) || positional.slice(1).join(' ')
      if (text) body.text = text
      else if (action === 'answer') {
        return reject('needs-text', 'an answer needs text: codewaifu pro answer <id> "yes, go ahead"')
      }
      const minutes = num(flags.get('minutes'))
      if (minutes > 0) body.minutes = Math.trunc(minutes)
      return call('answer', 'POST', '/pro/answer', body, json)
    }

    case 'new':
    case 'create': {
      const title = positional.join(' ').trim() || str(flags.get('title'))
      if (!title) {
        return reject('needs-title', 'new needs a title: codewaifu pro new "fix the flaky test"')
      }
      const body: Record<string, unknown> = { op: 'create', title }
      // An empty workdir means "here", and only the runner knows where here is:
      // main/proCli.ts fills it from process.cwd() before the request goes out.
      body.workdir = str(flags.get('dir'))
      for (const key of ['goal', 'agent', 'branch', 'base', 'prompt'] as const) {
        const value = str(flags.get(key))
        if (value) body[key] = value
      }
      if (switches.has('worktree')) body.worktree = true
      if (switches.has('no-start')) body.start = false
      return call('new', 'POST', '/pro/tasks', body, json)
    }

    case 'park':
    case 'resume':
    case 'done': {
      const taskId = str(flags.get('task')) || positional[0] || ''
      if (!taskId) return reject('needs-target', `${verb} needs a task id`)
      return call(
        verb,
        'POST',
        '/pro/tasks',
        { op: 'status', taskId, status: STATUS_VERB[verb] },
        json
      )
    }

    case 'rm':
    case 'remove': {
      const taskId = str(flags.get('task')) || positional[0] || ''
      if (!taskId) return reject('needs-target', `${verb} needs a task id`)
      return call('remove', 'POST', '/pro/tasks', { op: 'remove', taskId }, json)
    }

    case 'adopt':
      return call('adopt', 'POST', '/pro/tasks', { op: 'adopt' }, json)

    case 'log':
    case 'ledger': {
      const taskId = str(flags.get('task')) || positional[0] || ''
      if (!taskId) return reject('needs-target', 'log needs a task id')
      if (switches.has('digest')) {
        return call('log', 'POST', '/pro/ledger', { op: 'digest', taskId }, json)
      }
      const limit = Math.min(200, Math.max(1, Math.trunc(num(flags.get('limit')) || 20)))
      return call('log', 'POST', '/pro/ledger', { op: 'read', taskId, limit }, json)
    }

    default:
      return reject('bad-verb', `unknown pro command: ${verb}`)
  }
}

/* ------------------------------------------------------------------ *
 * Terminal text
 * ------------------------------------------------------------------ */

/**
 * One glyph per row, so a wall of tasks reads as a picture down the left edge.
 * `!` wins over everything: a task that needs a decision is the reason this
 * command exists, and it must be findable without reading a single word.
 */
const MARK: Record<string, string> = {
  working: '>',
  blocked: '!',
  idle: '.',
  done: '+',
  unknown: '?'
}

/** Fixed columns: mark(2) + id (measured, see below) + state(12), plus the indent. */
const MARK_W = 2
/**
 * The id column is measured from the ids being printed, not fixed.
 *
 * A constant is wrong at both ends. `newTaskId` is `t` + base36 ms + 4 hex, so
 * every real id is 13 characters, and the column of 9 this used to be printed
 * `tmu37q...` on every row of the one verb you read ids from - a clipped id is
 * not a command anybody can type. A constant of 14 would then waste eleven
 * columns per row on a bench of short ids, at 60 columns, where the title is
 * already the tightest thing on the line. So: the longest id plus a gap, between
 * a floor and a ceiling that keeps a pathological id from eating the subject.
 */
const ID_MIN = 6
const ID_MAX = 20
const STATE_W = 12

/** A row always keeps this much title, so a long tail cannot erase the subject. */
const MIN_TITLE = 4

/**
 * Join prose segments with two spaces, dropping the tail until the line fits.
 * The summary lines are prose, not columns, so the honest way to honour a
 * narrow terminal is to lose the least actionable segment whole: a hard-wrapped
 * sentence reads as a broken table, and a mid-word `...` reads as a typo.
 */
export function fitSegments(parts: string[], width: number): string {
  const joined = parts.join('  ')
  if (joined.length <= width) return joined
  let head = parts[0] ?? ''
  let kept = 1
  for (let i = 1; i < parts.length; i++) {
    const next = `${head}  ${parts[i]}`
    // Reserve room for the ` ...` that says something was dropped.
    if (next.length + 4 > width) break
    head = next
    kept = i + 1
  }
  if (kept >= parts.length) return clip(head, width)
  return `${clip(head, width - 4)} ...`
}

/** The tail is the least load-bearing part of a row, so it is what gives way. */
function fitTail(text: string, room: number): string {
  return room < 6 ? '' : clipLeft(text, room)
}

/**
 * Truncate with `...`, the ASCII marker a terminal cannot mangle. Clipping
 * beats wrapping everywhere in here: a wrapped row destroys the alignment of
 * every row below it, and alignment is the whole reason this is a table.
 */
export function clip(text: string, max: number): string {
  const value = String(text ?? '')
  if (max <= 3 || value.length <= max) return value
  return `${value.slice(0, max - 3)}...`
}

/** Keep the end of a path: that is the part two checkouts differ in. */
export function clipLeft(text: string, max: number): string {
  const value = String(text ?? '')
  if (max <= 3 || value.length <= max) return value
  return `...${value.slice(value.length - max + 3)}`
}

export function pad(text: string, width: number): string {
  const value = String(text ?? '')
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

/** `4m`, not `4 minutes`: this lands in a fixed-width column. */
export function durShort(ms: number): string {
  const seconds = Math.max(0, Math.trunc(num(ms) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.trunc(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.trunc(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.trunc(hours / 24)}d`
}

/** Token totals are the one big number on a row, so they get a short form. */
export function kilo(value: number): string {
  const total = Math.max(0, num(value))
  if (total < 1000) return String(Math.trunc(total))
  if (total < 1_000_000) return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k`
  return `${(total / 1_000_000).toFixed(1)}M`
}

function clock(at: number): string {
  const stamp = new Date(num(at) || Date.now())
  return Number.isNaN(stamp.getTime()) ? '--:--:--' : stamp.toTimeString().slice(0, 8)
}

function markFor(task: TaskView): string {
  const open = num(task.needsMe)
  if (open > 0) return open > 1 ? `!${open}` : '!'
  if (task.status === 'lost') return 'x'
  if (task.status === 'parked') return 'z'
  if (task.status === 'done') return '+'
  return MARK[task.liveStatus] ?? '?'
}

/**
 * The state a row is in, as one word.
 *
 * Extracted from the row renderer because `watch` has to compare two frames and
 * say what changed: a parked task and a lost one are both "not what herdr
 * reports", and if the transition vocabulary lived in two places the tree and
 * the stream would name the same moment differently.
 */
function taskState(task: TaskView): string {
  return task.status === 'lost' || task.status === 'parked' ? task.status : task.liveStatus
}

function stateWord(task: TaskView): string {
  const base = taskState(task)
  return task.blockedMs > 0 ? `${base} ${durShort(task.blockedMs)}` : base
}

function taskTail(task: TaskView): string {
  const parts: string[] = []
  const agent = task.agentKind || task.panes[0]?.displayAgent || ''
  if (agent) parts.push(clip(agent, 8))
  if (task.branch) parts.push(clip(task.branch, 16) + (task.dirty > 0 ? `*${task.dirty}` : ''))
  if (num(task.tokens) > 0) parts.push(kilo(task.tokens))
  if (!task.alive) parts.push(task.status === 'lost' ? 'gone' : 'stale')
  return parts.join(' ')
}

function idColumnWidth(tasks: readonly TaskView[]): number {
  const longest = tasks.reduce((max, task) => Math.max(max, String(task.id || '').length), 0)
  return Math.max(ID_MIN, Math.min(ID_MAX, longest + 1))
}

function taskLine(task: TaskView, width: number, idW: number): string {
  // The head is measured after padding, not from a constant: an over-long id or
  // state word used to push every row past the width it was given.
  // Clip to one less than the column and pad to the column, the way the state
  // word does: an id past the ceiling still leaves the gap instead of butting
  // into the next column (`e2e-smoke-...unknown`).
  const head = `  ${pad(clip(markFor(task), MARK_W), MARK_W)} ${pad(clip(task.id, idW - 1), idW)}${pad(clip(stateWord(task), STATE_W - 1), STATE_W)}`
  const tail = fitTail(taskTail(task), width - head.length - 2 - MIN_TITLE)
  const budget = Math.max(MIN_TITLE, width - head.length - (tail ? tail.length + 2 : 0))
  const title = clip(task.title || '(untitled)', budget)
  return `${head}${pad(title, budget)}${tail ? `  ${tail}` : ''}`.trimEnd()
}

function groupHead(group: GroupView, open: number, width: number): string {
  const tasks = group.tasks.length
  const counts = [`${tasks} ${tasks === 1 ? 'task' : 'tasks'}`]
  if (open > 0) counts.push(`${open} need you`)
  const tail = counts.join('  ')
  const label = group.label || 'unknown'
  // A wrapped group head leaves the reader unable to tell which rows belong to
  // which directory, so the label is clipped before the counts are appended.
  const room = Math.max(8, width - tail.length - 2)
  const keyRoom = room - label.length - 2
  const where = group.key && group.key !== label && keyRoom >= 12
    ? `  ${clipLeft(group.key, Math.min(46, keyRoom))}`
    : ''
  return `${clip(label, room - where.length)}${where}  ${tail}`.trimEnd()
}

function fleetLine(
  counts: StateCounts | undefined,
  open: number,
  view: BenchView,
  width: number
): string {
  const total = num(counts?.total)
  const parts = [`${total} ${total === 1 ? 'task' : 'tasks'}`]
  if (open > 0) parts.push(`${open} need you`)
  for (const key of ['working', 'blocked', 'done'] as const) {
    const value = num(counts?.[key])
    if (value > 0) parts.push(`${value} ${key}`)
  }
  const herdr = view.herdr
  const herdrText = herdr?.online
    ? `herdr ${herdr.version || 'online'}  ${num(herdr.workspaces)} ws`
    : `herdr offline${herdr?.error ? `: ${herdr.error}` : ''}`
  // Counts first, herdr metadata last: that is the order they get dropped in.
  return fitSegments([...parts, herdrText], width)
}

/** What `GET /pro/state` answers. */
export interface ProStatePayload {
  ok?: boolean
  online?: boolean
  running?: boolean
  view?: BenchView | null
  /** Present when `ok` is false: the relay's own reason, which beats a guess. */
  error?: string
  detail?: string
}

/**
 * The tree, as text. Groups in the bench's own order (that order is derived, so
 * the CLI and the window cannot disagree), tasks in queue order inside them.
 *
 * "need you" is the badge number: `view.attention.length`, which the projection
 * has already filtered to unresolved, non-snoozed items. It is deliberately not
 * `counts.needsMe`, which counts *tasks* - one task holding two open decisions
 * is two things to do, and the tray says 2.
 */
export function renderProState(
  payload: ProStatePayload | null | undefined,
  width = 100
): string {
  const view = payload?.view ?? null
  if (!view) return noProjection(payload)
  const open = (view.attention ?? []).length
  const lines = [fleetLine(view.counts, open, view, width)]
  const groups = view.groups ?? []
  if (!groups.length) {
    lines.push(
      '',
      'no tasks yet. start one:',
      '  codewaifu pro new "fix the flaky test" --dir ~/dev/thing',
      '  codewaifu pro adopt     # pick up workspaces herdr already has'
    )
    return lines.join('\n')
  }
  // Measured once for the whole view, so rows in different groups still line up.
  const idW = idColumnWidth(view.tasks)
  for (const group of groups) {
    const groupOpen = group.tasks.reduce((sum, task) => sum + num(task.needsMe), 0)
    lines.push('', groupHead(group, groupOpen, width))
    for (const task of group.tasks) lines.push(taskLine(task, width, idW))
  }
  if (open > 0) lines.push('', `codewaifu pro attention   # the ${open} that need you`)
  // A reboot is the other thing that needs the human, and it is not in the
  // queue: triage only knows about live agents. Without this line `pro state`
  // reads as an all-clear while the recovery tab shows a badge.
  const broken = needsRecovery(view.recovery ?? []).length
  if (broken > 0) {
    lines.push('', `${recoveryCountText(broken)}   # codewaifu pro recovery`)
  }
  return lines.join('\n')
}

/** What to say when the projection itself never arrived. Every read verb agrees. */
function noProjection(payload: ProStatePayload | null | undefined): string {
  if (payload?.running === false) return 'the bench is starting up; no projection yet'
  // A 500 carries the server's own reason; answering "nothing to show" to it
  // would send the reader looking at their tasks instead of at the fault.
  const said = payloadError(payload)
  return said ? `the bench could not answer: ${said}` : 'the bench answered with nothing to show'
}

/** One sentence, same words in `pro state` and in `pro recovery`'s own header. */
function recoveryCountText(count: number): string {
  return `${count} ${count === 1 ? 'task needs' : 'tasks need'} recovery`
}

/**
 * The recovery tab, as text: what survived the last interruption, and what it
 * would take to put it back.
 *
 * Read-only, and the reason is provenance rather than policy. Applying a plan
 * creates workspaces, launches agents and types a re-prompt into a pane, and
 * every ledger line that writes records who asked; `recoveryOp` still says
 * `source: 'gui'`, so a script applying a plan would be filed as a click it did
 * not make. When origin becomes a parameter of the op, `restore` belongs here.
 * Until then the terminal reports the damage and the bench repairs it.
 */
export function renderProRecovery(
  payload: ProStatePayload | null | undefined,
  width = 100
): string {
  const view = payload?.view ?? null
  if (!view) return noProjection(payload)
  // The panel's own short-circuit: with no herdr nothing can be probed, so every
  // task would carry the same guess. One honest sentence beats a list of them.
  if (view.herdr && view.herdr.online === false) {
    return 'herdr is not connected, so nothing can be known about live tasks yet'
  }
  const plans = needsRecovery(view.recovery ?? [])
  if (!plans.length) return 'nothing needs recovery'
  const lines = [recoveryCountText(plans.length), '']
  plans.forEach((plan, index) => lines.push(...planLines(plan, index + 1, width)))
  if (plans.some((plan) => plan.actionable)) {
    lines.push('', 'the Bench window applies a plan (recovery tab)')
  }
  return lines.join('\n')
}

const VERDICT_W = 11

/**
 * One plan: verdict and title on the row, then why, then the steps in full.
 *
 * The steps are the point. `Apply` runs them, so a surface that offers recovery
 * has to show what recovery would do; the terminal is no exception, and
 * `recoveryStepText` is the same summary the panel prints.
 */
function planLines(plan: RecoveryPlan, ordinal: number, width: number): string[] {
  const out: string[] = []
  const head = `${pad(`${ordinal}.`, 4)}${pad(clip(plan.verdict, VERDICT_W - 1), VERDICT_W)}`
  // The id is what every other verb takes (`pro log <id>`, `pro resume <id>`), so
  // it is printed whole and the title gives way instead. A clipped id is a
  // command that cannot be typed.
  const id = plan.taskId || ''
  const room = Math.max(8, width - head.length - id.length - 2)
  out.push(`${head}${clip(plan.title || '(untitled)', room)}  ${id}`.trimEnd())
  if (plan.reason) out.push(`    ${clip(plan.reason, width - 4)}`)
  for (const step of plan.steps) {
    out.push(`    ${pad(clip(step.kind, 9), 10)}${clip(recoveryStepText(step), width - 14)}`)
  }
  return out
}

/** What `GET /pro/attention` answers. */
export interface ProAttentionPayload {
  ok?: boolean
  online?: boolean
  counts?: StateCounts
  attention?: AttentionItem[]
}

export function renderProAttention(
  payload: ProAttentionPayload | null | undefined,
  now: number,
  width = 100
): string {
  const items = payload?.attention ?? []
  if (!items.length) return 'nothing needs you'
  const lines = [`${items.length} ${items.length === 1 ? 'item needs' : 'items need'} you`, '']
  const body = Math.max(24, width - 4)
  items.forEach((item, index) => {
    // `taskTitle` is user text of unbounded length; unclipped it wrapped the
    // whole queue and hid the ids below, which are what an answer needs.
    const head = `${pad(`${index + 1}.`, 4)}${clip(item.kind, 14)}  waited ${durShort(waitedMs(item, now))}   `
    const group = item.groupLabel ? `  (${item.groupLabel})` : ''
    const where = item.taskTitle || item.taskId
    lines.push(`${head}${clip(where, Math.max(8, width - head.length - group.length))}${group}`)
    const ask = item.title || item.detail
    if (ask) lines.push(`    ${clip(ask, body)}`)
    if (item.command) lines.push(`    $ ${clip(item.command, body - 2)}`)
    else if (item.title && item.detail) lines.push(`    ${clip(item.detail, body)}`)
    lines.push(`    ${item.id}`)
  })
  const head = items[0]
  const verbs = attentionActions(head.kind)
  lines.push('')
  // The hints are commands to copy, not prose to read: they and the bare ids are
  // the only lines allowed to run past the width, because a clipped command is a
  // broken one.
  if (verbs.includes('answer')) {
    lines.push(`answer:   codewaifu pro answer ${head.id} "yes, go ahead"`)
  }
  for (const verb of ['approve', 'deny'] as const) {
    if (verbs.includes(verb)) lines.push(`${verb}:    codewaifu pro ${verb} ${head.id}`)
  }
  return lines.join('\n')
}

/**
 * The audit trail, or the digest of it. Both come back as a `ProResult` whose
 * `data` is `{taskId, entries}` or `{taskId, digest}`, so one function reads
 * whichever the runner asked for.
 */
export function renderProLedger(payload: unknown): string {
  const result = payload as ProResult | null
  if (!result || typeof result !== 'object') return 'the bench sent back something unreadable'
  if (!result.ok) return failureText(result)
  const data = (result.data ?? {}) as {
    taskId?: string
    entries?: LedgerEntry[]
    digest?: LedgerDigest | null
  }
  if (data.digest) return digestText(data.taskId ?? '', data.digest)
  const entries = data.entries ?? []
  if (!entries.length) return `no ledger entries for ${data.taskId || 'that task'}`
  return entries
    .map(
      (entry) =>
        `${clock(entry.at)}  ${pad(entry.kind, 11)}${pad(entry.source || '-', 6)}${clip(entry.text || '', 88)}`
    )
    .join('\n')
}

function digestText(taskId: string, digest: LedgerDigest): string {
  const lines = [`task     ${taskId}`]
  if (digest.goal) lines.push(`goal     ${clip(digest.goal, 96)}`)
  const branch = digest.branch
    ? `${digest.branch}${digest.dirty > 0 ? ` (${digest.dirty} dirty)` : ''}`
    : ''
  if (branch) lines.push(`branch   ${branch}`)
  if (digest.agent) {
    const session = digest.sessionValue
      ? `  ${digest.sessionKind} ${clip(digest.sessionValue, 40)}`
      : '  no session captured'
    lines.push(`agent    ${digest.agent}${session}`)
  }
  digest.plan.forEach((step, index) => {
    lines.push(`${index === 0 ? 'plan     ' : '         '}${index + 1}. ${clip(step, 88)}`)
  })
  if (digest.next) lines.push(`next     ${clip(digest.next, 96)}`)
  lines.push(
    `last     ${clock(digest.lastAt)}  ${digest.entries} ${digest.entries === 1 ? 'entry' : 'entries'}`
  )
  if (!digest.goal && !digest.plan.length && !digest.next) {
    lines.push('', 'nothing recorded yet beyond the entries themselves')
  }
  return lines.join('\n')
}

function failureText(result: ProResult): string {
  const raw = result as ProResult & { error?: string }
  const why = result.detail || raw.error || 'no reason given'
  return `${result.code || 'refused'}: ${why}`
}

/**
 * The line a mutating verb prints. Every shape here is one the service already
 * returns (`okResult` payloads in main/pro/service.ts), so this reads them
 * rather than inventing a second vocabulary for the same outcome.
 */
export function renderProResult(payload: unknown, verb: ProCliVerb): string {
  const result = payload as ProResult | null
  if (!result || typeof result !== 'object') return 'the bench sent back something unreadable'
  if (!result.ok) return failureText(result)
  const data = (result.data ?? {}) as Record<string, unknown>
  const task = data.task as TaskRecord | TaskView | undefined
  switch (verb) {
    case 'new': {
      if (!task) return result.detail || result.code || 'created'
      const where = task.workdir ? `  ${task.workdir}` : ''
      const lines = [`created ${task.id}  ${task.title || '(untitled)'}${where}`]
      if (data.workspaceId || data.paneId) {
        lines.push(`workspace ${data.workspaceId || '-'}  pane ${data.paneId || '-'}`)
      } else {
        lines.push('filed without a pane (herdr is offline, or --no-start)')
      }
      return lines.join('\n')
    }
    case 'answer': {
      const what = data.itemId || ''
      const detail = result.detail ? `  ${result.detail}` : ''
      return `${result.code || 'sent'}  ${what}${detail}`
    }
    case 'park':
    case 'resume':
    case 'done':
      return `${task?.id ?? ''} is now ${result.detail || STATUS_VERB[verb]}`
    case 'remove':
      return `removed ${data.taskId ?? ''} (its ledger stays on disk)`
    case 'adopt':
      return `adopted ${num(data.created)} tasks, rebound ${num(data.bindings)}`
    default:
      return result.detail || result.code || 'ok'
  }
}

/** Why there was nothing to talk to, in the words that lead to the fix. */
export type ProCliOffline = 'no-app' | 'pro-off' | 'no-herdr' | 'old-app'

export function offlineText(reason: ProCliOffline, detail = ''): string {
  const lines: string[] = []
  if (reason === 'no-app') {
    lines.push('CodeWaifu is not running, so there is no bench to ask.')
    lines.push('', 'start the app, then:', '  codewaifu pro state')
  } else if (reason === 'pro-off') {
    lines.push('CodeWaifu is running, but the bench is switched off.')
    lines.push('', 'turn on Pro in the widget settings, then:', '  codewaifu pro state')
  } else if (reason === 'old-app') {
    lines.push('that app has no /pro routes: it is older than the bench.')
    if (detail) lines.push(`  ${detail}`)
    lines.push('', 'quit it and start this build instead, then:', '  codewaifu pro state')
  } else {
    lines.push('the bench is up, but herdr is not reachable.')
    if (detail) lines.push(`  ${detail}`)
    lines.push('', 'install it with:', '  curl -fsSL https://herdr.dev/install.sh | sh')
    lines.push('', 'the Bench window shows the same card, and what it found.')
  }
  return lines.join('\n')
}

/**
 * The failures where the status code, not the body, carries the meaning.
 *
 * Pure and table-tested, because each one is a different fix for the person
 * reading it and getting one wrong sends them somewhere useless: a 401 is a
 * stale endpoint file, a 503 is Pro or herdr, and a 404 whose body says
 * `no route` is an app that predates the bench - not a task that does not exist,
 * which is what exit 4 would tell a script to go and look for.
 */
export function failureFor(status: number, json: unknown): { text: string; exit: number } | null {
  if (status === 401 || status === 403) return { text: tokenText(), exit: PRO_EXIT.token }
  const error = field(json, 'error')
  if (status === 404 && error.startsWith('no route')) {
    return { text: offlineText('old-app', error), exit: PRO_EXIT.offline }
  }
  if (status === 429) {
    return { text: watchersText(error), exit: PRO_EXIT.refused }
  }
  if (status === 503) {
    const detail = field(json, 'detail') || error
    const reason = field(json, 'code') === 'not-running' ? 'pro-off' : 'no-herdr'
    return { text: offlineText(reason, detail), exit: PRO_EXIT.offline }
  }
  return null
}

function field(json: unknown, key: string): string {
  const value = (json as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' ? value : ''
}

/** Whatever reason the bench gave, whichever of the two keys it put it in. */
function payloadError(payload: unknown): string {
  return field(payload, 'error') || field(payload, 'detail')
}

/** The endpoint file does not match the app that answered. */
export function tokenText(): string {
  return [
    'the running app refused our token: the endpoint file is older than the app.',
    '',
    'restart CodeWaifu (it rewrites ~/.codewaifu/endpoint.env), then try again.'
  ].join('\n')
}

/** The bench is already being watched by as many terminals as it will serve. */
export function watchersText(detail = ''): string {
  const lines = [detail || 'this bench already has the most watchers it will serve.']
  lines.push('', 'close one (ctrl-c in the terminal running it), then try again.')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * Watching: the projection, pushed
 * ------------------------------------------------------------------ */

/**
 * One thing that changed between two frames.
 *
 * A watcher that reprints the tree on every change is unreadable within a
 * minute, and one that prints "something changed" is useless, so the diff is a
 * named list. Six categories, and each is a fact the projection already
 * carries: nothing here infers a state the bench did not report.
 *
 * `change` is the discriminant rather than `kind` because `kind` already means
 * one of the five things an agent can need, and a union where both senses of the
 * word appear in one object is a bug waiting for a rename.
 */
export type ProChange =
  | { change: 'bench'; running: boolean }
  | { change: 'herdr'; online: boolean; version: string; error: string }
  | { change: 'task'; added: boolean; id: string; title: string }
  | { change: 'status'; id: string; title: string; from: string; to: string; needsMe: number }
  | {
      change: 'attention'
      arrived: boolean
      id: string
      kind: AttentionKind
      title: string
      taskId: string
    }
  | { change: 'recovery'; id: string; title: string; from: string; to: string }

/**
 * How many change lines one frame may print before it points at `pro state`.
 *
 * A burst is real - herdr reconnecting marks every task at once - and a wall of
 * forty identical transitions scrolls the one line you wanted off the screen.
 * The cap is not a lie about the bench, because the tree is one keystroke away
 * and says all of it.
 */
export const PRO_WATCH_MAX = 12

/** The line under the tree that says what this command is doing. */
export const PRO_WATCH_HINT =
  'watching: one line per change, until ctrl-c. codewaifu pro state redraws the tree.'

const CLOCK_W = 8
const TAG_W = 10
/** The head every change line starts with, so the tags line up down the page. */
const CHANGE_HEAD_W = CLOCK_W + 2 + TAG_W + 2

/**
 * What two frames differ in, in the order a person wants to read it.
 *
 * Infrastructure first, then what needs a decision, then what merely moved, and
 * the clears last: the last line on the screen should be the good news. `null`
 * on either side means there is no tree to compare, so the only honest report is
 * that the bench went away or came back.
 */
export function diffProViews(
  prev: ProStatePayload | null | undefined,
  next: ProStatePayload | null | undefined
): ProChange[] {
  const changes: ProChange[] = []
  const before = prev?.view ?? null
  const after = next?.view ?? null
  if ((before !== null) !== (after !== null)) changes.push({ change: 'bench', running: after !== null })
  if (!before || !after) return changes

  const herdr: ProChange[] = []
  if (Boolean(before.herdr?.online) !== Boolean(after.herdr?.online)) {
    herdr.push({
      change: 'herdr',
      online: Boolean(after.herdr?.online),
      version: after.herdr?.version ?? '',
      error: after.herdr?.error ?? ''
    })
  }

  const wasThere = new Map(before.tasks.map((task) => [task.id, task]))
  const isThere = new Set(after.tasks.map((task) => task.id))
  const added: ProChange[] = []
  const removed: ProChange[] = []
  const status: ProChange[] = []
  const recovery: ProChange[] = []
  for (const task of after.tasks) {
    const was = wasThere.get(task.id)
    if (!was) {
      added.push({ change: 'task', added: true, id: task.id, title: task.title })
      continue
    }
    const from = taskState(was)
    const to = taskState(task)
    if (from !== to) {
      status.push({
        change: 'status',
        id: task.id,
        title: task.title,
        from,
        to,
        needsMe: num(task.needsMe)
      })
    }
    const verdictFrom = was.recovery || ''
    const verdictTo = task.recovery || ''
    if (verdictFrom !== verdictTo) {
      recovery.push({
        change: 'recovery',
        id: task.id,
        title: task.title,
        from: verdictFrom,
        to: verdictTo
      })
    }
  }
  for (const task of before.tasks) {
    if (!isThere.has(task.id)) {
      removed.push({ change: 'task', added: false, id: task.id, title: task.title })
    }
  }

  // An attention id is stable across re-renders (`taskId:kind:origin`), which is
  // what makes "arrived" and "left" a set difference rather than a guess.
  const arrived: ProChange[] = []
  const left: ProChange[] = []
  const openBefore = new Map(before.attention.map((item) => [item.id, item]))
  const openAfter = new Set(after.attention.map((item) => item.id))
  for (const item of after.attention) {
    if (openBefore.has(item.id)) continue
    arrived.push({
      change: 'attention',
      arrived: true,
      id: item.id,
      kind: item.kind,
      title: item.taskTitle || item.title,
      taskId: item.taskId
    })
  }
  for (const item of before.attention) {
    if (openAfter.has(item.id)) continue
    left.push({
      change: 'attention',
      arrived: false,
      id: item.id,
      kind: item.kind,
      title: item.taskTitle || item.title,
      taskId: item.taskId
    })
  }

  return [...changes, ...herdr, ...arrived, ...status, ...recovery, ...added, ...removed, ...left]
}

/** The first frame: the whole tree, plus what the command will do next. */
export function renderProWatchStart(
  payload: ProStatePayload | null | undefined,
  width = 100
): string {
  return `${renderProState(payload, width)}\n\n${PRO_WATCH_HINT}`
}

/**
 * One change, one line: clock, tag, then the subject.
 *
 * Ids are printed whole and the title gives way, the rule the recovery list
 * already follows - a clipped id is a command nobody can type, and the whole
 * reason to watch from a terminal is to answer from the same terminal.
 */
export function renderProChange(change: ProChange, at: number, width = 100): string {
  const head = `${clock(at)}  ${pad(tagFor(change), TAG_W)}  `
  const body = bodyFor(change)
  const id = idFor(change)
  if (!id) return `${head}${clip(body, Math.max(8, width - head.length))}`.trimEnd()
  const room = Math.max(8, width - head.length - id.length - 2)
  return `${head}${clip(body, room)}  ${id}`.trimEnd()
}

/** A frame's worth of changes, capped, with the way to see the rest. */
export function renderProChanges(
  changes: readonly ProChange[],
  at: number,
  width = 100
): string {
  const shown = changes.slice(0, PRO_WATCH_MAX)
  const lines = shown.map((change) => renderProChange(change, at, width))
  const rest = changes.length - shown.length
  if (rest > 0) {
    lines.push(
      `${' '.repeat(CHANGE_HEAD_W)}+ ${rest} more ${rest === 1 ? 'change' : 'changes'}: codewaifu pro state`
    )
  }
  return lines.join('\n')
}

function tagFor(change: ProChange): string {
  switch (change.change) {
    case 'bench':
      return 'bench'
    case 'herdr':
      return 'herdr'
    case 'task':
      return change.added ? '+ task' : '- task'
    case 'status':
      return 'status'
    case 'recovery':
      return 'recovery'
    default:
      return change.arrived ? 'needs you' : 'cleared'
  }
}

function bodyFor(change: ProChange): string {
  switch (change.change) {
    case 'bench':
      return change.running ? 'the bench is back' : 'the bench stopped'
    case 'herdr':
      if (!change.online) return `offline${change.error ? `: ${change.error}` : ''}`
      return `online ${change.version || ''}`.trim()
    case 'task':
      return change.title || '(untitled)'
    case 'status':
      // The count rides along because it is the number the tray shows, and a
      // transition to `blocked` without it does not say how much is waiting.
      return `${change.from} -> ${change.to}${change.needsMe > 1 ? ` (${change.needsMe} need you)` : ''}  ${change.title || '(untitled)'}`
    case 'recovery':
      return `${change.from || 'intact'} -> ${change.to || 'intact'}  ${change.title || '(untitled)'}`
    default:
      return `${change.kind}  ${change.title || change.taskId || '(untitled)'}`
  }
}

/**
 * The id worth printing whole, or '' when the line is about the bench itself.
 * Every other category names a task or an item, and both are what the command
 * you type next takes as an argument.
 */
function idFor(change: ProChange): string {
  return change.change === 'bench' || change.change === 'herdr' ? '' : change.id
}
