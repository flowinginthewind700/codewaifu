/**
 * `codewaifu pro`: the verb table, the terminal text, and the round trip.
 *
 * Three layers, in that order, because they fail for different reasons and a
 * test that mixes them cannot say which one broke:
 *
 * 1. Parsing is pure, so the whole table is pinned here rather than one happy
 *    path per verb. The cases worth reading are the two discriminators: a bare
 *    id is an *item* when it holds a colon and a *task* when it does not (a
 *    wrong guess types into the wrong agent's terminal), and text after `--` is
 *    literal (a prompt is allowed to start with a dash).
 * 2. Rendering is pinned against a view built by the real `buildBench`, never a
 *    hand-written one: a fixture that cannot occur in production makes the
 *    renderer's alignment and clipping untestable in the only place it matters.
 * 3. The round trip runs the real relay on a real port with the real endpoint
 *    file, and asserts on the *typed request the service received*. That is the
 *    proof the CLI invents no authority of its own: `pro new --agent Codex`
 *    arrives folded to `codex` because the server folds it, not because the CLI
 *    knows the vocabulary.
 *
 * Exit codes are asserted as numbers from `PRO_EXIT`, never as literals, so the
 * documented contract and the tested one are the same object.
 */
import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { endpointFile, stateDir } from '../src/main/env'
import { cliArgsFrom, runCli } from '../src/main/cli'
import { runProCli } from '../src/main/pro/cli'
import { renderEndpointEnv } from '../src/shared/endpoint'
import { parseSnapshot, type Snapshot } from '../src/shared/herdr'
import { portAttempts } from '../src/shared/portPolicy'
import {
  buildBench,
  DEFAULT_SNOOZE_MINUTES,
  needsMeCount,
  needsRecovery,
  parseLedgerEntry,
  parseTaskRecord,
  planRecovery,
  recoveryStepText,
  type BenchView,
  type LedgerEntry,
  type RecoveryFacts,
  type RecoveryPlan,
  type TaskRecord
} from '../src/shared/pro'
import { failResult, okResult } from '../src/shared/proIpc'
import {
  clip,
  clipLeft,
  durShort,
  exitForStatus,
  failureFor,
  kilo,
  offlineText,
  pad,
  parseProCli,
  PRO_CLI_USAGE,
  PRO_EXIT,
  renderProAttention,
  renderProLedger,
  renderProRecovery,
  renderProResult,
  renderProState,
  tokenText,
  type ProCliCall,
  type ProCliVerb,
  type ProStatePayload
} from '../src/shared/proCli'
import { attentionItem, benchView, fakePro } from './helpers/pro'
import { createTestRelay, occupyPort, type TestRelay } from './helpers/relay'

const NOW = 1_700_000_000_000
const TOKEN = 'test-token-0123456789abcdef'
const REPO = '/home/dev/codewaifu'
const OTHER = '/home/dev/robotworld'

/* ------------------------------------------------------------------ *
 * Output capture
 * ------------------------------------------------------------------ */

/**
 * The CLI writes with `fs.writeSync`, not `process.stdout.write`: its last act
 * is `app.exit()`, which drops queued async writes, and `install.sh` parses this
 * output. So the spy goes on the synchronous call, which is also the call the
 * production path makes.
 */
const written: Record<number, string[]> = { 1: [], 2: [] }

function outText(): string {
  return written[1].join('')
}

function errText(): string {
  return written[2].join('')
}

beforeEach(() => {
  written[1] = []
  written[2] = []
  vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, text: unknown): number => {
    const bucket = written[fd]
    const body = String(text)
    if (bucket) bucket.push(body)
    return Buffer.byteLength(body)
  }) as unknown as typeof fs.writeSync)
})

/* ------------------------------------------------------------------ *
 * The endpoint file, the relay, and a bench worth printing
 * ------------------------------------------------------------------ */

let relays: TestRelay[] = []
let blockers: Array<{ close: () => Promise<void> }> = []
let savedEndpoint: string | null = null

beforeEach(() => {
  try {
    savedEndpoint = fs.readFileSync(endpointFile, 'utf8')
  } catch {
    savedEndpoint = null
  }
})

afterEach(async () => {
  for (const relay of relays) await relay.shutdown()
  relays = []
  for (const blocker of blockers) await blocker.close()
  blockers = []
  // The state dir is shared with every other test file in this run, so leave it
  // exactly as we found it: a leftover endpoint.env turns a later "nobody home"
  // assertion into a flake.
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    if (savedEndpoint === null) fs.writeFileSync(endpointFile, '', 'utf8')
    else fs.writeFileSync(endpointFile, savedEndpoint, 'utf8')
  } catch {
    /* the tmp home may not exist at all, which is the state we want anyway */
  }
  vi.restoreAllMocks()
})

/** Publish the handshake the app writes when it binds. */
function publish(port: number, token: string): void {
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(
    endpointFile,
    renderEndpointEnv({
      port,
      token,
      pid: process.pid,
      boot: 'cli-test',
      version: '9.9.9-test',
      writtenAt: NOW
    }),
    'utf8'
  )
}

async function startRelay(pro?: Parameters<typeof createTestRelay>[1]): Promise<TestRelay> {
  const relay = createTestRelay(undefined, pro)
  await relay.server.start(portAttempts({ pinned: 0, sticky: relay.config.port }))
  relays.push(relay)
  return relay
}

function taskRecord(patch: Record<string, unknown>): TaskRecord {
  const record = parseTaskRecord(patch)
  if (!record) throw new Error(`task fixture did not parse: ${JSON.stringify(patch)}`)
  return record
}

function ledgerEntry(patch: Record<string, unknown>): LedgerEntry {
  const entry = parseLedgerEntry(patch)
  if (!entry) throw new Error(`ledger fixture did not parse: ${JSON.stringify(patch)}`)
  return entry
}

interface PaneRow {
  paneId: string
  workspaceId: string
  cwd: string
  status: string
  tokens?: Record<string, string>
}

/** A herdr snapshot, wire-shaped and run through the real parser. */
function herdrSnapshot(rows: readonly PaneRow[]): Snapshot {
  const workspaceIds = [...new Set(rows.map((row) => row.workspaceId))]
  const parsed = parseSnapshot({
    version: '0.0.0-test',
    protocol: 1,
    workspaces: workspaceIds.map((workspaceId, index) => ({
      workspace_id: workspaceId,
      number: index + 1,
      label: workspaceId,
      agent_status: 'idle'
    })),
    panes: rows.map((row) => ({
      pane_id: row.paneId,
      workspace_id: row.workspaceId,
      tab_id: `${row.workspaceId}-tab-1`,
      cwd: row.cwd,
      foreground_cwd: row.cwd,
      agent: 'codex',
      display_agent: 'codex',
      agent_status: row.status,
      tokens: row.tokens ?? {},
      revision: NOW
    }))
  })
  if (!parsed) throw new Error('snapshot fixture did not parse')
  return parsed
}

/**
 * Two tasks in two directories; the first is blocked and holds *two* open
 * decisions. That shape is the whole reason the counts below differ: the badge
 * counts items (2) and `counts.needsMe` counts tasks (1), and the CLI has to say
 * which one it is saying.
 */
function twoTaskBench(): BenchView {
  const tasks = [
    taskRecord({
      id: 't1',
      title: 'ship the bench',
      workdir: REPO,
      repoRoot: REPO,
      branch: 'main',
      agentKind: 'codex',
      workspaceId: 'ws-1',
      paneIds: ['p1'],
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW
    }),
    taskRecord({
      id: 't2',
      title: 'write the handoff',
      workdir: OTHER,
      repoRoot: OTHER,
      workspaceId: 'ws-2',
      paneIds: ['p2'],
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW
    })
  ]
  return buildBench({
    now: NOW,
    herdr: benchView().herdr,
    snapshot: herdrSnapshot([
      { paneId: 'p1', workspaceId: 'ws-1', cwd: REPO, status: 'blocked', tokens: { total: '12400' } },
      { paneId: 'p2', workspaceId: 'ws-2', cwd: OTHER, status: 'working' }
    ]),
    tasks,
    attention: [
      attentionItem({ taskId: 't1', kind: 'permission', paneId: 'p1' }),
      attentionItem({
        taskId: 't1',
        kind: 'question',
        paneId: 'p1',
        title: 'Which box do we ship to?',
        detail: 'linux or mac',
        command: ''
      })
    ],
    blockedSince: { t1: NOW - 5 * 60_000 }
  })
}

const LOST_ID = 'tmu37q87c7256'

/**
 * A recovery plan from the real planner, never a hand-written one.
 *
 * What the terminal has to lay out is exactly what `planRecovery` emits: a
 * multi-step rebuild, a worktree command, and a re-prompt long enough to wrap. A
 * fixture that could not occur in production would make the clipping testable
 * only against itself.
 */
function planned(
  patch: {
    id?: string
    title?: string
    status?: string
    agent?: string
    session?: string
    branch?: string
    facts?: Partial<RecoveryFacts>
  } = {}
): RecoveryPlan {
  const task = taskRecord({
    id: patch.id ?? LOST_ID,
    title: patch.title ?? 'ship the bench',
    goal: 'make the bench the one place work is visible',
    workdir: REPO,
    repoRoot: REPO,
    branch: patch.branch ?? '',
    status: patch.status ?? 'active',
    agentKind: patch.agent ?? '',
    agentSessionId: patch.session ?? '',
    createdAt: NOW,
    updatedAt: NOW
  })
  return planRecovery({
    task,
    digest: null,
    facts: {
      herdrOnline: true,
      dirExists: true,
      workspaceId: 'ws-1',
      paneId: '',
      sessionRef: null,
      ...patch.facts
    }
  })
}

/** Intent-only: the pane and the conversation are gone, the goal survived. */
function lostPlan(patch: { id?: string; title?: string } = {}): RecoveryPlan {
  return planned({ ...patch, facts: { dirExists: false, workspaceId: '' } })
}

/** A live pane: nothing to recover, and both surfaces hide it. */
function intactPlan(patch: { id?: string } = {}): RecoveryPlan {
  return planned({ ...patch, agent: 'codex', session: 'sess-1', facts: { paneId: 'p1' } })
}

/** Stopped on purpose: recovery is contractually forbidden to touch it. */
function parkedPlan(patch: { id?: string } = {}): RecoveryPlan {
  return planned({ ...patch, status: 'parked' })
}

/** The checkout is gone but the conversation survived: recreate, then resume. */
function rebuildPlan(patch: { id?: string } = {}): RecoveryPlan {
  return planned({
    ...patch,
    agent: 'codex',
    session: 'sess-9999',
    branch: 'fix/bench',
    facts: { dirExists: false, workspaceId: 'ws-1' }
  })
}

function recoveryBench(plans: readonly RecoveryPlan[], herdr = benchView().herdr): BenchView {
  return buildBench({
    now: NOW,
    herdr,
    snapshot: null,
    tasks: plans.map((plan) =>
      taskRecord({ id: plan.taskId, title: plan.title, workdir: REPO, status: 'active' })
    ),
    attention: [],
    recovery: plans
  })
}

function call(
  verb: ProCliVerb,
  method: 'GET' | 'POST',
  path: string,
  body: Record<string, unknown> | null,
  json = false
): ProCliCall {
  return { kind: 'call', verb, json, method, path, body }
}

function parsedCall(argv: readonly string[]): ProCliCall {
  const parsed = parseProCli(argv)
  if (parsed.kind !== 'call') throw new Error(`expected a call, got ${JSON.stringify(parsed)}`)
  return parsed
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

const READS: Array<[string, string[], ProCliCall]> = [
  ['state', ['pro', 'state'], call('state', 'GET', '/pro/state', null)],
  ['ls', ['pro', 'ls'], call('state', 'GET', '/pro/state', null)],
  ['attention', ['pro', 'attention'], call('attention', 'GET', '/pro/attention', null)],
  ['queue', ['pro', 'queue'], call('attention', 'GET', '/pro/attention', null)],
  // The plans ride along in the projection, so the read is the same route.
  ['recovery', ['pro', 'recovery'], call('recovery', 'GET', '/pro/state', null)],
  [
    'recovery --json',
    ['pro', 'recovery', '--json'],
    call('recovery', 'GET', '/pro/state', null, true)
  ],
  [
    'state --json',
    ['--cli', 'pro', 'state', '--json'],
    call('state', 'GET', '/pro/state', null, true)
  ],
  [
    '--json before the verb',
    ['pro', '--json', 'state'],
    call('state', 'GET', '/pro/state', null, true)
  ]
]

describe('parseProCli: reading the bench', () => {
  it.each(READS)('%s', (_name, argv, expected) => {
    expect(parseProCli(argv)).toEqual(expected)
  })

  it('is a GET with no body, so the relay never sees a payload it did not ask for', () => {
    expect(parsedCall(['pro', 'state']).body).toBeNull()
  })
})

const DECISIONS: Array<[string, string[], Record<string, unknown>]> = [
  [
    'an item id, because it holds a colon',
    ['pro', 'answer', 't1:permission:hook', 'yes,', 'go ahead'],
    { action: 'answer', itemId: 't1:permission:hook', text: 'yes, go ahead' }
  ],
  [
    'a task id, because it does not',
    ['pro', 'answer', 't1', 'use the linux box'],
    { action: 'answer', taskId: 't1', text: 'use the linux box' }
  ],
  ['--item', ['pro', 'answer', '--item', 't1:question:hook', '--text', 'linux'], { action: 'answer', itemId: 't1:question:hook', text: 'linux' }],
  ['--task', ['pro', 'answer', '--task', 't1', '--text', 'linux'], { action: 'answer', taskId: 't1', text: 'linux' }],
  ['approve', ['pro', 'approve', 't1:permission:hook'], { action: 'approve', itemId: 't1:permission:hook' }],
  ['deny', ['pro', 'deny', 't1:permission:hook'], { action: 'deny', itemId: 't1:permission:hook' }],
  ['snooze with minutes', ['pro', 'snooze', 't1:permission:hook', '--minutes', '30'], { action: 'snooze', itemId: 't1:permission:hook', minutes: 30 }],
  ['snooze without minutes', ['pro', 'snooze', 't1:permission:hook'], { action: 'snooze', itemId: 't1:permission:hook' }],
  ['--action done needs no text', ['pro', 'answer', 't1', '--action', 'done'], { action: 'done', taskId: 't1' }],
  ['narrowed to one pane', ['pro', 'answer', 't1', '--pane', 'p1', 'go'], { action: 'answer', taskId: 't1', paneId: 'p1', text: 'go' }],
  ['narrowed to one kind', ['pro', 'answer', 't1', '--kind', 'question', 'go'], { action: 'answer', taskId: 't1', kind: 'question', text: 'go' }],
  ['text after -- is literal', ['pro', 'answer', 't1', '--', '--force the issue'], { action: 'answer', taskId: 't1', text: '--force the issue' }]
]

describe('parseProCli: acting on the queue', () => {
  it.each(DECISIONS)('%s', (_name, argv, body) => {
    expect(parseProCli(argv)).toEqual(call('answer', 'POST', '/pro/answer', body))
  })

  it('truncates a fractional snooze rather than rounding it up', () => {
    expect(parsedCall(['pro', 'snooze', 't1', '--minutes', '2.9']).body).toMatchObject({ minutes: 2 })
  })

  it('drops a zero snooze so the server default applies', () => {
    expect(parsedCall(['pro', 'snooze', 't1', '--minutes', '0']).body).not.toHaveProperty('minutes')
  })
})

/** Name, argv, the verb it reports, the route it hits, the body it sends. */
const WORK: Array<[string, string[], ProCliVerb, string, Record<string, unknown>]> = [
  [
    'new joins its title',
    ['pro', 'new', 'fix', 'the', 'flaky', 'test'],
    'new',
    '/pro/tasks',
    { op: 'create', title: 'fix the flaky test', workdir: '' }
  ],
  [
    'create is an alias',
    ['pro', 'create', 'fix it'],
    'new',
    '/pro/tasks',
    { op: 'create', title: 'fix it', workdir: '' }
  ],
  [
    '--dir= inline',
    ['pro', 'new', 'fix it', '--dir=/repo/x'],
    'new',
    '/pro/tasks',
    { op: 'create', title: 'fix it', workdir: '/repo/x' }
  ],
  [
    '-d short form',
    ['pro', 'new', 'fix it', '-d', '/repo/x'],
    'new',
    '/pro/tasks',
    { op: 'create', title: 'fix it', workdir: '/repo/x' }
  ],
  [
    'the launch flags',
    ['pro', 'new', 'fix it', '--agent', 'Codex', '--goal', 'ship it', '--branch', 'fix/x', '--worktree'],
    'new',
    '/pro/tasks',
    {
      op: 'create',
      title: 'fix it',
      workdir: '',
      agent: 'Codex',
      goal: 'ship it',
      branch: 'fix/x',
      worktree: true
    }
  ],
  [
    '--no-start files without launching',
    ['pro', 'new', 'fix it', '--no-start'],
    'new',
    '/pro/tasks',
    { op: 'create', title: 'fix it', workdir: '', start: false }
  ],
  [
    'a prompt may start with a dash',
    ['pro', 'new', 'fix it', '--prompt=--verbose now'],
    'new',
    '/pro/tasks',
    { op: 'create', title: 'fix it', workdir: '', prompt: '--verbose now' }
  ],
  [
    'park',
    ['pro', 'park', 't1'],
    'park',
    '/pro/tasks',
    { op: 'status', taskId: 't1', status: 'parked' }
  ],
  [
    'resume',
    ['pro', 'resume', 't1'],
    'resume',
    '/pro/tasks',
    { op: 'status', taskId: 't1', status: 'active' }
  ],
  ['done', ['pro', 'done', 't1'], 'done', '/pro/tasks', { op: 'status', taskId: 't1', status: 'done' }],
  ['rm', ['pro', 'rm', 't1'], 'remove', '/pro/tasks', { op: 'remove', taskId: 't1' }],
  [
    'remove --task',
    ['pro', 'remove', '--task', 't1'],
    'remove',
    '/pro/tasks',
    { op: 'remove', taskId: 't1' }
  ],
  ['adopt', ['pro', 'adopt'], 'adopt', '/pro/tasks', { op: 'adopt' }],
  [
    'log reads the trail',
    ['pro', 'log', 't1'],
    'log',
    '/pro/ledger',
    { op: 'read', taskId: 't1', limit: 20 }
  ],
  [
    'log -n',
    ['pro', 'log', 't1', '-n', '5'],
    'log',
    '/pro/ledger',
    { op: 'read', taskId: 't1', limit: 5 }
  ],
  [
    'ledger --digest',
    ['pro', 'ledger', 't1', '--digest'],
    'log',
    '/pro/ledger',
    { op: 'digest', taskId: 't1' }
  ]
]

describe('parseProCli: starting and filing work', () => {
  it.each(WORK)('%s', (_name, argv, verb, path, body) => {
    expect(parseProCli(argv)).toEqual(call(verb, 'POST', path, body))
  })

  it('caps a silly limit instead of asking for the whole ledger', () => {
    expect(parsedCall(['pro', 'log', 't1', '--limit', '99999']).body).toMatchObject({ limit: 200 })
  })

  it('leaves workdir empty for the runner to fill, because only the runner knows cwd', () => {
    expect(parsedCall(['pro', 'new', 'fix it']).body).toMatchObject({ workdir: '' })
  })
})

const REJECTS: Array<[string, string[], string]> = [
  ['an unknown verb', ['pro', 'launch', 'the', 'rockets'], 'bad-verb'],
  ['a send-keys verb, which does not exist', ['pro', 'send-keys', 't1', 'ls'], 'bad-verb'],
  ['answer with no target', ['pro', 'answer'], 'needs-target'],
  ['answer with no text', ['pro', 'answer', 't1'], 'needs-text'],
  ['an action nobody can perform', ['pro', 'answer', 't1', '--action', 'nuke', 'go'], 'bad-action'],
  ['a kind that is not one of the five', ['pro', 'approve', 't1', '--kind', 'weather'], 'bad-kind'],
  ['new with no title', ['pro', 'new'], 'needs-title'],
  ['park with no task', ['pro', 'park'], 'needs-target'],
  ['log with no task', ['pro', 'log'], 'needs-target'],
  ['rm with no task', ['pro', 'rm'], 'needs-target']
]

describe('parseProCli: refusing', () => {
  it.each(REJECTS)('%s', (_name, argv, code) => {
    expect(parseProCli(argv)).toMatchObject({ kind: 'reject', code })
  })

  it('answers a bare `pro` with the usage, not with an error', () => {
    expect(parseProCli(['pro'])).toEqual({ kind: 'help', json: false })
    expect(parseProCli([])).toEqual({ kind: 'help', json: false })
    expect(parseProCli(['pro', 'state', '-h'])).toEqual({ kind: 'help', json: false })
  })

  it('names the command it did not understand, so the message is not a mystery', () => {
    const parsed = parseProCli(['pro', 'launch'])
    expect(parsed.kind).toBe('reject')
    if (parsed.kind === 'reject') expect(parsed.error).toContain('launch')
  })
})

describe('exitForStatus', () => {
  const table: Array<[number, number]> = [
    [200, PRO_EXIT.ok],
    [204, PRO_EXIT.ok],
    [400, PRO_EXIT.usage],
    [401, PRO_EXIT.token],
    [403, PRO_EXIT.token],
    [404, PRO_EXIT.missing],
    [409, PRO_EXIT.refused],
    [418, PRO_EXIT.fault],
    [500, PRO_EXIT.fault],
    [503, PRO_EXIT.offline]
  ]

  it.each(table)('%s -> %s', (status, expected) => {
    expect(exitForStatus(status)).toBe(expected)
  })

  it('keeps the six codes distinct, because a script branches on them', () => {
    const codes = Object.values(PRO_EXIT)
    expect(new Set(codes).size).toBe(codes.length)
  })
})

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

describe('renderProState', () => {
  it('says "need you" with the badge number, not the task number', () => {
    const view = twoTaskBench()
    // One task holds two open decisions. The tray says 2; counts.needsMe says 1.
    expect(view.counts.needsMe).toBe(1)
    expect(needsMeCount(view.attention, view.generatedAt)).toBe(2)
    const text = renderProState({ ok: true, online: true, running: true, view }, 100)
    expect(text).toContain('2 need you')
    expect(text).not.toContain('1 need you')
  })

  it('draws the fleet, the groups and the rows', () => {
    const view = twoTaskBench()
    const text = renderProState({ view }, 100)
    const lines = text.split('\n')
    expect(lines[0]).toContain('2 tasks')
    expect(lines[0]).toContain('1 working')
    expect(lines[0]).toContain('1 blocked')
    expect(lines[0]).toContain('herdr 0.0.0-test')
    expect(text).toContain('codewaifu')
    expect(text).toContain('robotworld')
    // A task holding two decisions gets the doubled mark; that is the point of
    // the glyph column: findable without reading a word.
    expect(text).toContain('!2')
    expect(text).toContain('blocked 5m')
    expect(text).toContain('ship the bench')
    expect(text).toContain('12k')
    expect(text).toContain('codewaifu pro attention   # the 2 that need you')
  })

  it('keeps every line inside the width it was given', () => {
    const view = twoTaskBench()
    for (const width of [60, 66, 80, 100, 160]) {
      const lines = renderProState({ view }, width).split('\n')
      for (const line of lines) {
        expect(line.length, JSON.stringify(line)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('drops the herdr metadata before the counts, because the counts are what you act on', () => {
    const view = twoTaskBench()
    expect(renderProState({ view }, 100)).toContain('herdr 0.0.0-test')
    const narrow = renderProState({ view }, 60).split('\n')[0]
    expect(narrow).toContain('2 tasks')
    expect(narrow).toContain('2 need you')
    expect(narrow).not.toContain('herdr')
    // Dropping a segment whole, not mid-word: `...` is the only marker.
    expect(narrow.endsWith(' ...')).toBe(true)
  })

  it('passes a fault through in the bench\u2019s own words rather than saying "nothing to show"', () => {
    expect(renderProState({ ok: false, error: 'herdr socket closed mid-call' }, 80)).toContain(
      'herdr socket closed mid-call'
    )
    expect(renderProState({ ok: true, running: false }, 80)).toContain('starting up')
    expect(renderProState(null, 80)).toContain('nothing to show')
  })

  it('clips a long title rather than wrapping it, because a wrapped row destroys the table', () => {
    const view = buildBench({
      now: NOW,
      herdr: benchView().herdr,
      snapshot: null,
      tasks: [taskRecord({ id: 't3', title: 'x'.repeat(200), workdir: REPO, status: 'active' })],
      attention: []
    })
    const text = renderProState({ view }, 72)
    expect(text).toContain('...')
    expect(text).not.toContain('x'.repeat(200))
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(72)
  })

  it('offers the two ways out of an empty bench', () => {
    const text = renderProState({ view: benchView() }, 100)
    expect(text).toContain('no tasks yet')
    expect(text).toContain('codewaifu pro new')
    expect(text).toContain('codewaifu pro adopt')
  })

  it('tells a booting bench from an empty answer', () => {
    expect(renderProState({ running: false, view: null }, 100)).toContain('starting up')
    expect(renderProState({ running: true, view: null }, 100)).toContain('nothing to show')
    expect(renderProState(null, 100)).toContain('nothing to show')
  })

  it('says herdr is offline rather than printing a tree that cannot move', () => {
    const view = benchView({ herdr: { ...benchView().herdr, online: false, error: 'socket refused' } })
    const text = renderProState({ view }, 100)
    expect(text).toContain('herdr offline: socket refused')
  })

  it('prints a real task id whole, because it is what the next command takes', () => {
    // `newTaskId` is 13 characters every time. A column narrower than that put
    // `tmu37q...` on every row of the one verb you read ids from.
    const text = renderProState({ view: recoveryBench([lostPlan()]) }, 100)
    expect(text).toContain(LOST_ID)
    expect(text).not.toContain('tmu37q...')
  })

  it('measures the id column rather than guessing at one width for every bench', () => {
    const rowOf = (text: string, id: string): string =>
      text.split('\n').find((line) => line.includes(id)) ?? ''
    // Two-character ids get a narrow column: at 60 the title is the tightest
    // thing on the row, and eleven wasted columns come out of it.
    expect(rowOf(renderProState({ view: twoTaskBench() }, 60), 't1')).toContain('t1    blocked')
    // A real 13-character id still fits whole, with its gap.
    expect(rowOf(renderProState({ view: recoveryBench([lostPlan()]) }, 60), LOST_ID)).toContain(
      `${LOST_ID} unknown`
    )
  })

  it('clips an id past the ceiling, but never into the column beside it', () => {
    const row = renderProState({ view: recoveryBench([lostPlan({ id: 'a'.repeat(30) })]) }, 100)
      .split('\n')
      .find((line) => line.includes('aaa'))
    expect(row).toContain('... unknown')
    expect(row).not.toContain('...unknown')
  })

  it('says a reboot is waiting, because the queue is not the only thing that needs you', () => {
    // Triage only knows about live agents, so a task that needs recreating is
    // invisible to the queue. Without this line `pro state` reads as an
    // all-clear while the recovery tab shows a badge.
    const text = renderProState({ view: recoveryBench([lostPlan()]) }, 100)
    expect(text).toContain('1 task needs recovery   # codewaifu pro recovery')
  })

  it('stays quiet about recovery when nothing is broken, so the line means something', () => {
    const view = recoveryBench([intactPlan({ id: 'tintact' }), parkedPlan({ id: 'tparked' })])
    expect(needsRecovery(view.recovery)).toEqual([])
    expect(renderProState({ view }, 100)).not.toContain('# codewaifu pro recovery')
  })
})

describe('renderProRecovery', () => {
  it('says nothing needs recovery, which is the good news', () => {
    expect(renderProRecovery({ view: recoveryBench([]) }, 100)).toBe('nothing needs recovery')
  })

  it('hides an intact pane and a parked task, exactly like the tab badge', () => {
    const view = recoveryBench([intactPlan({ id: 'tintact' }), parkedPlan({ id: 'tparked' })])
    // The badge, the panel rows and this list are three renders of one
    // predicate. A second filter written inside the renderer is how a badge
    // ends up saying 1 while the list below it says 0.
    expect(needsRecovery(view.recovery)).toEqual([])
    expect(renderProRecovery({ view }, 100)).toBe('nothing needs recovery')
  })

  it('prints the verdict, the reason, and every step in the panel\u2019s own words', () => {
    const lost = lostPlan()
    const rebuild = rebuildPlan({ id: 'trebuild' })
    const view = recoveryBench([lost, rebuild, intactPlan({ id: 'tintact' })])
    const text = renderProRecovery({ view }, 160)
    expect(needsRecovery(view.recovery)).toHaveLength(2)
    expect(text.split('\n')[0]).toBe('2 tasks need recovery')
    expect(text).not.toContain('tintact')
    expect(text).toContain('1.  lost')
    expect(text).toContain('no agent session id was ever captured')
    expect(text).toContain('2.  rebuild')
    expect(text).toContain('workdir is gone')
    expect(text).toContain(LOST_ID)
    expect(text).toContain('trebuild')
    // The steps are what `Apply` runs, so they are printed in full and in the
    // same words the panel prints: a summary of a command is not a command.
    for (const plan of [lost, rebuild]) {
      for (const step of plan.steps) expect(text).toContain(recoveryStepText(step))
    }
    expect(text).toContain('the Bench window applies a plan (recovery tab)')
  })

  it('says herdr is offline in one sentence rather than guessing once per task', () => {
    const herdr = { ...benchView().herdr, online: false, error: 'socket refused' }
    const view = recoveryBench([lostPlan()], herdr)
    expect(renderProRecovery({ view }, 100)).toBe(
      'herdr is not connected, so nothing can be known about live tasks yet'
    )
  })

  it('answers a missing projection with the same words `pro state` uses', () => {
    const payloads: Array<ProStatePayload | null> = [
      null,
      { running: false, view: null },
      { ok: false, error: 'herdr socket closed mid-call' }
    ]
    for (const payload of payloads) {
      expect(renderProRecovery(payload, 100)).toBe(renderProState(payload, 100))
    }
  })

  it('keeps every line inside the width it was given', () => {
    const view = recoveryBench([lostPlan(), rebuildPlan({ id: 'trebuild' })])
    for (const width of [60, 66, 80, 100, 160]) {
      for (const line of renderProRecovery({ view }, width).split('\n')) {
        expect(line.length, JSON.stringify(line)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('prints a long id whole and lets the title give way instead', () => {
    const id = 'a'.repeat(30)
    const text = renderProRecovery({ view: recoveryBench([lostPlan({ id })]) }, 60)
    expect(text).toContain(id)
    expect(text).toContain('...')
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(60)
  })
})

describe('renderProAttention', () => {
  it('says nothing needs you, which is the good news', () => {
    expect(renderProAttention({ attention: [] }, NOW)).toBe('nothing needs you')
    expect(renderProAttention(null, NOW)).toBe('nothing needs you')
  })

  it('prints the id an answer needs, what was asked, and how to answer it', () => {
    const items = [attentionItem({ taskId: 't1', kind: 'permission' })]
    const text = renderProAttention({ attention: items }, NOW + 90_000)
    expect(text).toContain('1 item needs you')
    expect(text).toContain('permission  waited 1m')
    expect(text).toContain('ship the bench')
    expect(text).toContain('(codewaifu)')
    expect(text).toContain('$ npm test')
    expect(text).toContain('t1:permission:hook')
    expect(text).toContain('codewaifu pro answer t1:permission:hook "yes, go ahead"')
    expect(text).toContain('codewaifu pro approve t1:permission:hook')
    expect(text).toContain('codewaifu pro deny t1:permission:hook')
  })

  it('does not offer approve for a question, because the service would refuse it', () => {
    const text = renderProAttention({ attention: [attentionItem({ kind: 'question' })] }, NOW)
    expect(text).toContain('codewaifu pro answer')
    expect(text).not.toContain('pro approve')
  })

  it('counts items, and plurals them', () => {
    const items = [
      attentionItem({ taskId: 't1', kind: 'permission' }),
      attentionItem({ taskId: 't1', kind: 'question' })
    ]
    expect(renderProAttention({ attention: items }, NOW)).toContain('2 items need you')
  })

  it('clips a long command instead of letting it wrap', () => {
    const text = renderProAttention(
      { attention: [attentionItem({ command: 'npm run build -- ' + 'x'.repeat(200) })] },
      NOW
    )
    expect(text).toContain('...')
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(102)
  })

  it('clips a long task title, because the id underneath is what you have to copy', () => {
    const items = [
      attentionItem({ id: 't1:question:hook', taskTitle: 'x'.repeat(120), kind: 'question' })
    ]
    for (const width of [60, 80, 100]) {
      const text = renderProAttention({ attention: items }, NOW, width)
      // Two deliberate exceptions, both things you copy rather than read: the
      // bare id, and the `codewaifu pro answer ...` hints. A clipped command is
      // a broken command, so they are allowed to run long.
      for (const line of text.split('\n')) {
        if (line.trim() === 't1:question:hook') continue
        if (line.includes('codewaifu pro ')) continue
        expect(line.length, JSON.stringify(line)).toBeLessThanOrEqual(width)
      }
      expect(text).toContain('t1:question:hook')
    }
  })
})

describe('renderProLedger', () => {
  it('prints the trail, one entry per line', () => {
    const entries = [
      ledgerEntry({ taskId: 't1', kind: 'goal', text: 'ship the bench', at: NOW, source: 'gui' }),
      ledgerEntry({ taskId: 't1', kind: 'decision', text: 'answered approve', at: NOW + 1000, source: 'api' })
    ]
    const text = renderProLedger(okResult({ taskId: 't1', entries }, '', 'ledger'))
    const lines = text.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('goal')
    expect(lines[0]).toContain('ship the bench')
    expect(lines[1]).toContain('api')
  })

  it('prints the digest when that is what came back', () => {
    const digest = {
      taskId: 't1',
      goal: 'ship the bench',
      plan: ['write the CLI', 'test the CLI'],
      decisions: [],
      next: 'answer the queue',
      agent: 'codex',
      sessionKind: 'id' as const,
      sessionValue: 'sess-1',
      gitHead: 'abc1234',
      branch: 'main',
      dirty: 2,
      lastAt: NOW,
      entries: 5
    }
    const text = renderProLedger(okResult({ taskId: 't1', digest }, '', 'digest'))
    expect(text).toContain('goal     ship the bench')
    expect(text).toContain('branch   main (2 dirty)')
    expect(text).toContain('agent    codex  id sess-1')
    expect(text).toContain('1. write the CLI')
    expect(text).toContain('2. test the CLI')
    expect(text).toContain('next     answer the queue')
    expect(text).toContain('5 entries')
  })

  it('says so when the ledger is empty, and when it is unreadable', () => {
    expect(renderProLedger(okResult({ taskId: 't1', entries: [] }, '', 'ledger'))).toContain(
      'no ledger entries for t1'
    )
    expect(renderProLedger(null)).toContain('unreadable')
    expect(renderProLedger('nope')).toContain('unreadable')
  })

  it('prints a failure as its code and its reason', () => {
    expect(renderProLedger(failResult('no-task', 'no such task t9'))).toBe('no-task: no such task t9')
  })
})

describe('renderProResult', () => {
  it('reports a created task with the pane it landed in', () => {
    const task = taskRecord({ id: 't9', title: 'fix it', workdir: REPO })
    const text = renderProResult(
      okResult({ taskId: 't9', workspaceId: 'ws-9', paneId: 'p9', task }, '', 'created'),
      'new'
    )
    expect(text).toContain('created t9  fix it')
    expect(text).toContain(REPO)
    expect(text).toContain('workspace ws-9  pane p9')
  })

  it('says a filed task has no pane, which is not an error', () => {
    const task = taskRecord({ id: 't9', title: 'fix it', workdir: REPO })
    const text = renderProResult(okResult({ taskId: 't9', task }, '', 'filed'), 'new')
    expect(text).toContain('filed without a pane')
  })

  it('reports the new state of a task in words', () => {
    const task = taskRecord({ id: 't1', title: 'ship it', workdir: REPO })
    expect(renderProResult(okResult({ task }, '', 'parked'), 'park')).toBe('t1 is now parked')
    expect(renderProResult(okResult({ task }, '', 'active'), 'resume')).toBe('t1 is now active')
  })

  it('reports what an answer did, and what removing costs', () => {
    expect(
      renderProResult(okResult({ itemId: 't1:permission:hook' }, '', 'answered'), 'answer')
    ).toContain('answered')
    expect(renderProResult(okResult({ taskId: 't1' }, '', 'removed'), 'remove')).toContain(
      'removed t1 (its ledger stays on disk)'
    )
    expect(renderProResult(okResult({ created: 2, bindings: 1 }, '', 'adopted'), 'adopt')).toBe(
      'adopted 2 tasks, rebound 1'
    )
  })

  it('prints a refusal as its code and reason, and garbage as garbage', () => {
    expect(renderProResult(failResult('no-herdr-binary', 'herdr not found'), 'park')).toBe(
      'no-herdr-binary: herdr not found'
    )
    expect(renderProResult(null, 'park')).toContain('unreadable')
  })
})

describe('the words for "there is nothing to talk to"', () => {
  it('leads with the fix in all three cases', () => {
    expect(offlineText('no-app')).toContain('not running')
    expect(offlineText('pro-off')).toContain('switched off')
    expect(offlineText('no-herdr', 'socket refused')).toContain('herdr.dev/install.sh')
    expect(offlineText('no-herdr', 'socket refused')).toContain('socket refused')
  })

  it('says the endpoint file is stale, which is the actual cause of a refused token', () => {
    expect(tokenText()).toContain('endpoint file is older than the app')
  })

  it('names an app that has no /pro routes, and says to start this build', () => {
    expect(offlineText('old-app')).toContain('no /pro routes')
    expect(offlineText('old-app')).toContain('start this build')
  })
})

/**
 * The status codes that mean something other than "here is the answer".
 *
 * Pinned as a table because each row is a different fix for the reader, and the
 * expensive mistake is silent: a pre-bench app answers 404 for `/pro/state`, and
 * reading that as "no such task" (exit 4) sends a script hunting for a task that
 * never existed instead of telling a human their app is old.
 */
describe('failureFor', () => {
  it('reads a refused token as a stale endpoint file, not as a missing task', () => {
    for (const status of [401, 403]) {
      const failure = failureFor(status, { ok: false, error: 'missing or invalid X-CodeWaifu-Token' })
      expect(failure?.exit).toBe(PRO_EXIT.token)
      expect(failure?.text).toContain('endpoint file is older than the app')
    }
  })

  it('reads a route-less 404 as an old app, and exits "nobody home"', () => {
    const failure = failureFor(404, { ok: false, error: 'no route for GET /pro/state' })
    expect(failure?.exit).toBe(PRO_EXIT.offline)
    expect(failure?.text).toContain('older than the bench')
    expect(failure?.text).toContain('no route for GET /pro/state')
  })

  it('leaves a real 404 alone, because that one is a task that does not exist', () => {
    expect(failureFor(404, { ok: false, code: 'no-task', error: 'no such task t9' })).toBeNull()
    expect(exitForStatus(404)).toBe(PRO_EXIT.missing)
  })

  it('tells Pro being off and herdr being missing apart', () => {
    expect(failureFor(503, { ok: false, code: 'not-running' })?.text).toContain('switched off')
    const herdr = failureFor(503, { ok: false, error: 'herdr socket refused' })
    expect(herdr?.text).toContain('herdr.dev/install.sh')
    expect(herdr?.text).toContain('herdr socket refused')
    expect(herdr?.exit).toBe(PRO_EXIT.offline)
  })

  it('stays out of the way of a status the renderer can handle', () => {
    expect(failureFor(200, { ok: true, view: null })).toBeNull()
    expect(failureFor(409, { ok: false, code: 'refused', error: 'no' })).toBeNull()
    expect(failureFor(500, { ok: false, error: 'boom' })).toBeNull()
    expect(failureFor(500, null)).toBeNull()
  })
})

describe('the column helpers', () => {
  it('clips with an ASCII marker and never grows a string', () => {
    expect(clip('abcdefgh', 6)).toBe('abc...')
    expect(clip('ab', 6)).toBe('ab')
    expect(clip('abcdef', 3)).toBe('abcdef')
    expect(clipLeft('/home/dev/codewaifu', 12)).toBe('...codewaifu')
    expect(clipLeft('short', 12)).toBe('short')
  })

  it('pads to a fixed width so the columns line up', () => {
    expect(pad('ab', 5)).toBe('ab   ')
    expect(pad('abcdef', 3)).toBe('abcdef')
  })

  it('shortens durations and token totals for a fixed column', () => {
    expect(durShort(-1)).toBe('0s')
    expect(durShort(59_999)).toBe('59s')
    expect(durShort(60_000)).toBe('1m')
    expect(durShort(3_600_000)).toBe('1h')
    expect(durShort(86_400_000)).toBe('1d')
    expect(kilo(999)).toBe('999')
    expect(kilo(1200)).toBe('1.2k')
    expect(kilo(12_400)).toBe('12k')
    expect(kilo(1_500_000)).toBe('1.5M')
  })
})

/* ------------------------------------------------------------------ *
 * The round trip: real relay, real port, real endpoint file
 * ------------------------------------------------------------------ */

describe('runProCli against the real relay', () => {
  it('prints the tree the bench is showing', async () => {
    const view = twoTaskBench()
    const pro = fakePro({ view })
    const relay = await startRelay(() => pro.api)
    publish(relay.port, TOKEN)
    expect(await runProCli(['pro', 'state'])).toBe(PRO_EXIT.ok)
    expect(pro.viewCalls()).toBe(1)
    expect(outText()).toContain('2 tasks')
    expect(outText()).toContain('2 need you')
    expect(outText()).toContain('ship the bench')
    expect(errText()).toBe('')
  })

  it('prints the recovery tab, read off the same route the tree came in on', async () => {
    const pro = fakePro({ view: recoveryBench([lostPlan()]) })
    const relay = await startRelay(() => pro.api)
    publish(relay.port, TOKEN)
    expect(await runProCli(['pro', 'recovery'])).toBe(PRO_EXIT.ok)
    expect(pro.viewCalls()).toBe(1)
    expect(outText()).toContain('1 task needs recovery')
    expect(outText()).toContain(LOST_ID)
    expect(outText()).toContain('the Bench window applies a plan')
    expect(errText()).toBe('')
  })

  it('--json prints the payload instead of the rendering', async () => {
    const pro = fakePro({ view: twoTaskBench() })
    const relay = await startRelay(() => pro.api)
    publish(relay.port, TOKEN)
    expect(await runProCli(['pro', 'state', '--json'])).toBe(PRO_EXIT.ok)
    const payload = JSON.parse(outText()) as { ok: boolean; view: BenchView }
    expect(payload.ok).toBe(true)
    expect(payload.view.tasks.map((task) => task.id)).toEqual(['t1', 't2'])
    expect(outText()).not.toContain('need you')
  })

  it('reaches the same routes through the top-level CLI', async () => {
    const pro = fakePro({ view: twoTaskBench() })
    const relay = await startRelay(() => pro.api)
    publish(relay.port, TOKEN)
    expect(await runCli(['pro', 'state'])).toBe(PRO_EXIT.ok)
    expect(outText()).toContain('2 tasks')
  })

  it('answers a bare `pro` with the usage, without touching the wire', async () => {
    expect(await runCli(['pro'])).toBe(PRO_EXIT.ok)
    expect(outText()).toContain('codewaifu pro <verb>')
    expect(outText()).toContain('answer <id> <text...>')
  })

  it('answers the head of the queue with the text it was given', async () => {
    const view = twoTaskBench()
    const pro = fakePro({ view })
    pro.setResult(okResult({ itemId: view.attention[0].id }, '', 'answered'))
    const relay = await startRelay(() => pro.api)
    publish(relay.port, TOKEN)
    const id = view.attention[0].id
    expect(await runProCli(['pro', 'answer', id, 'yes,', 'go ahead'])).toBe(PRO_EXIT.ok)
    expect(pro.recorded.actions).toEqual([
      { itemId: id, action: 'answer', text: 'yes, go ahead', origin: 'api', minutes: DEFAULT_SNOOZE_MINUTES }
    ])
    expect(outText()).toContain('answered')
  })

  it('answers by task id and lets the server choose the item', async () => {
    const view = twoTaskBench()
    const pro = fakePro({ view })
    pro.setResult(okResult({ itemId: view.attention[0].id }, '', 'approved'))
    const relay = await startRelay(() => pro.api)
    publish(relay.port, TOKEN)
    expect(await runProCli(['pro', 'approve', 't1'])).toBe(PRO_EXIT.ok)
    // The CLI sent a task id; the server matched it to the open item. That match
    // is the server's business, which is why the CLI does not attempt it.
    expect(pro.recorded.actions).toEqual([
      {
        itemId: view.attention[0].id,
        action: 'approve',
        text: '',
        origin: 'api',
        minutes: DEFAULT_SNOOZE_MINUTES
      }
    ])
  })

  it('creates a task where the command was typed, and the server folds the agent', async () => {
    const pro = fakePro({ view: twoTaskBench() })
    pro.setResult(
      okResult(
        {
          taskId: 't9',
          workspaceId: 'ws-9',
          paneId: 'p9',
          task: taskRecord({ id: 't9', title: 'fix the flaky test', workdir: process.cwd() })
        },
        '',
        'created'
      )
    )
    const relay = await startRelay(() => pro.api)
    publish(relay.port, TOKEN)
    expect(await runProCli(['pro', 'new', 'fix the flaky test', '--agent', 'Codex'])).toBe(PRO_EXIT.ok)
    expect(pro.recorded.tasks).toEqual([
      expect.objectContaining({
        op: 'create',
        title: 'fix the flaky test',
        workdir: process.cwd(),
        agent: 'codex',
        start: true
      })
    ])
    expect(outText()).toContain('created t9')
  })

  it('parks a task and says so in words', async () => {
    const pro = fakePro({ view: twoTaskBench() })
    pro.setResult(
      okResult({ task: taskRecord({ id: 't1', title: 'ship it', workdir: REPO, status: 'parked' }) }, '', 'parked')
    )
    const relay = await startRelay(() => pro.api)
    publish(relay.port, TOKEN)
    expect(await runProCli(['pro', 'park', 't1'])).toBe(PRO_EXIT.ok)
    expect(pro.recorded.tasks).toEqual([{ op: 'status', taskId: 't1', status: 'parked' }])
    expect(outText()).toContain('t1 is now parked')
  })

  it('adopts workspaces', async () => {
    const pro = fakePro({ view: twoTaskBench() })
    pro.setResult(okResult({ created: 2, bindings: 1 }, '', 'adopted'))
    const relay = await startRelay(() => pro.api)
    publish(relay.port, TOKEN)
    expect(await runProCli(['pro', 'adopt'])).toBe(PRO_EXIT.ok)
    expect(pro.recorded.tasks).toEqual([{ op: 'adopt' }])
    expect(outText()).toContain('adopted 2 tasks, rebound 1')
  })

  it('reads the ledger, and the digest when asked', async () => {
    const pro = fakePro({ view: twoTaskBench() })
    pro.setResult(
      okResult(
        {
          taskId: 't1',
          entries: [ledgerEntry({ taskId: 't1', kind: 'decision', text: 'answered approve', source: 'api', at: NOW })]
        },
        '',
        'ledger'
      )
    )
    const relay = await startRelay(() => pro.api)
    publish(relay.port, TOKEN)
    expect(await runProCli(['pro', 'log', 't1'])).toBe(PRO_EXIT.ok)
    expect(pro.recorded.ledger).toEqual([{ op: 'read', taskId: 't1', limit: 20 }])
    expect(outText()).toContain('answered approve')
    expect(await runProCli(['pro', 'log', 't1', '--digest'])).toBe(PRO_EXIT.ok)
    expect(pro.recorded.ledger[1]).toEqual({ op: 'digest', taskId: 't1' })
  })

  it('exits 2 on a verb it does not have, with the usage beside the complaint', async () => {
    const relay = await startRelay()
    publish(relay.port, TOKEN)
    expect(await runProCli(['pro', 'launch'])).toBe(PRO_EXIT.usage)
    expect(errText()).toContain('unknown pro command: launch')
    expect(errText()).toContain('codewaifu pro <verb>')
    expect(outText()).toBe('')
  })

  it('exits 4 when the service has no such item, and prints the reason', async () => {
    const pro = fakePro({ view: twoTaskBench() })
    pro.setResult(failResult('no-item', 'no open attention item nope:permission:hook'))
    const relay = await startRelay(() => pro.api)
    publish(relay.port, TOKEN)
    expect(await runProCli(['pro', 'answer', 'nope:permission:hook', 'go'])).toBe(PRO_EXIT.missing)
    expect(errText()).toContain('no-item')
    expect(outText()).toBe('')
  })

  it('--json passes a failure through as JSON, on stdout, with the failing exit code', async () => {
    const pro = fakePro({ view: twoTaskBench() })
    pro.setResult(failResult('no-task', 'no such task t9'))
    const relay = await startRelay(() => pro.api)
    publish(relay.port, TOKEN)
    expect(await runProCli(['pro', 'log', 't9', '--json'])).toBe(PRO_EXIT.missing)
    expect(JSON.parse(outText())).toMatchObject({ ok: false, code: 'no-task' })
  })

  it('exits 6 when the running app refuses our token', async () => {
    const pro = fakePro({ view: twoTaskBench() })
    const relay = await startRelay(() => pro.api)
    publish(relay.port, 'z'.repeat(TOKEN.length))
    expect(await runProCli(['pro', 'state'])).toBe(PRO_EXIT.token)
    expect(errText()).toContain('refused our token')
    expect(pro.viewCalls()).toBe(0)
  })

  it('exits 3 when Pro is switched off, and says where the switch is', async () => {
    const relay = await startRelay()
    publish(relay.port, TOKEN)
    expect(await runProCli(['pro', 'state'])).toBe(PRO_EXIT.offline)
    expect(errText()).toContain('the bench is switched off')
    expect(errText()).toContain('turn on Pro in the widget settings')
  })

  it('exits 3 when herdr is gone, and says how to get it back', async () => {
    const pro = fakePro({ view: twoTaskBench() })
    pro.setResult(failResult('no-herdr-binary', 'herdr not found on PATH'))
    const relay = await startRelay(() => pro.api)
    publish(relay.port, TOKEN)
    expect(await runProCli(['pro', 'park', 't1'])).toBe(PRO_EXIT.offline)
    expect(errText()).toContain('herdr is not reachable')
    expect(errText()).toContain('herdr not found on PATH')
    expect(errText()).toContain('herdr.dev/install.sh')
  })

  it('exits 3 when the endpoint file is missing or unreadable', async () => {
    fs.mkdirSync(stateDir, { recursive: true })
    // A half-written file must degrade to "nobody home", not to a stack trace:
    // this is what a crash during the app's own write leaves behind.
    fs.writeFileSync(endpointFile, 'CODEWAIFU_PORT=\nCODEWAIFU_TO', 'utf8')
    expect(await runProCli(['pro', 'state'])).toBe(PRO_EXIT.offline)
    expect(errText()).toContain('CodeWaifu is not running')
  })

  it('exits 3 when the endpoint file points at a port somebody else owns now', async () => {
    const blocker = await occupyPort()
    blockers.push(blocker)
    publish(blocker.port, TOKEN)
    expect(await runProCli(['pro', 'state'])).toBe(PRO_EXIT.offline)
    // The probe, not the file, decides: an unrelated dev server on a recycled
    // port would otherwise receive our token and our task titles.
    expect(errText()).toContain('CodeWaifu is not running')
  })
})

describe('the usage text', () => {
  it('documents every verb the parser accepts', () => {
    // A verb that parses but is not in the usage is a feature nobody can find;
    // a verb in the usage that does not parse is a lie printed on every mistake.
    for (const verb of [
      'state',
      'attention',
      'recovery',
      'answer',
      'approve',
      'deny',
      'new',
      'adopt',
      'park',
      'resume',
      'done',
      'rm',
      'log'
    ]) {
      expect(PRO_CLI_USAGE).toMatch(new RegExp(`\\b${verb}\\b`))
      expect(parseProCli(['pro', verb, 't1', 'text']).kind).not.toBe('reject')
    }
  })

  it('documents the exit codes it actually returns', () => {
    // 0 (ok) and 1 (our own fault) are the two a script needs no legend for.
    for (const code of [PRO_EXIT.usage, PRO_EXIT.offline, PRO_EXIT.missing, PRO_EXIT.refused, PRO_EXIT.token]) {
      expect(PRO_CLI_USAGE).toContain(`${code} `)
    }
  })

  it('says out loud that there is no send-keys', () => {
    expect(parseProCli(['pro', 'send-keys', 't1', 'ls'])).toMatchObject({ code: 'bad-verb' })
  })
})

/* ------------------------------------------------------------------ *
 * Entry point: which argv reaches the CLI at all
 * ------------------------------------------------------------------ */

describe('cliArgsFrom', () => {
  const BIN = '/home/dev/.local/bin/codewaifu'

  it('boots the companion when there is nothing to run', () => {
    expect(cliArgsFrom([BIN])).toEqual({ cli: false, args: [] })
    expect(cliArgsFrom([BIN, '--allow-file-access'])).toEqual({ cli: false, args: [] })
  })

  it('keeps the flag form working exactly as install.sh calls it', () => {
    expect(cliArgsFrom([BIN, '--cli', 'install'])).toEqual({ cli: true, args: ['install'] })
    expect(cliArgsFrom([BIN, '--cli', 'pro', 'state', '--json'])).toEqual({
      cli: true,
      args: ['pro', 'state', '--json']
    })
  })

  it('takes the bench verbs with no flag, because that is how a shell alias reads', () => {
    expect(cliArgsFrom([BIN, 'pro', 'state'])).toEqual({ cli: true, args: ['pro', 'state'] })
    expect(cliArgsFrom([BIN, 'pro'])).toEqual({ cli: true, args: ['pro'] })
    expect(cliArgsFrom([BIN, 'PRO', 'ls'])).toEqual({ cli: true, args: ['PRO', 'ls'] })
  })

  it('does not mistake a binary living in a directory called pro for the verb', () => {
    expect(cliArgsFrom(['/opt/pro'])).toEqual({ cli: false, args: [] })
    expect(cliArgsFrom(['/opt/pro', '--hidden'])).toEqual({ cli: false, args: [] })
  })

  it('leaves install to the flag, since bare "codewaifu install" reads as "install the app"', () => {
    expect(cliArgsFrom([BIN, 'install'])).toEqual({ cli: false, args: [] })
    expect(cliArgsFrom([BIN, 'status'])).toEqual({ cli: false, args: [] })
  })
})
