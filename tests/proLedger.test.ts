/**
 * The intent ledger (F5, acceptance 6.6).
 *
 * This is the file that has to survive a power cut, because it is the only
 * place where "what was this task for" is written down. Two of its properties
 * pull in opposite directions and both get pinned here: an append is fsync'd
 * before it counts as written, and a reader treats a truncated tail as a normal
 * state rather than a fatal one. The third is compaction, which is a rewrite, so
 * the test that matters is not "the file got smaller" but "the recovery brief is
 * still in it".
 *
 * Task ids become filenames, so the path gate comes first: a ledger named
 * `../config.json` is not a ledger, it is a config overwrite.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ledgerDigest, parseLedger, type LedgerEntry, type LedgerKind } from '../src/shared/pro'
import {
  DEFAULT_LEDGER_LIMIT,
  LedgerStore,
  appendEntry,
  compactEntries,
  compactLedger,
  entryLine,
  newEntry,
  newEntryId,
  readEntries,
  writeLedger,
  type LedgerInput
} from '../src/main/pro/ledger'
import { isSafeTaskId, ledgerFileFor, tasksDir } from '../src/main/pro/env'

/** Every id this file mints, so cleanup only ever touches what it created. */
const minted = new Set<string>()
/** Files created directly in tasksDir, which no task id points at. */
const extras: string[] = []
let serial = 0

function taskId(prefix = 'ledger'): string {
  serial += 1
  // The pid is in there because vitest runs files in parallel workers that
  // share one temp home: two files minting `ledger1x<same ms>` would fight over
  // one ledger, and the readdir assertions below would read each other's files.
  const id = `${prefix}${serial}p${process.pid.toString(36)}x${Date.now().toString(36)}`
  minted.add(id)
  return id
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const id of minted) {
    const file = ledgerFileFor(id)
    if (file && file.startsWith(os.tmpdir())) fs.rmSync(file, { force: true })
  }
  minted.clear()
  for (const file of extras.splice(0)) {
    if (file.startsWith(os.tmpdir())) fs.rmSync(file, { force: true })
  }
})

/** Build an entry the way the service does, and fail loudly if it is refused. */
function entry(
  id: string,
  kind: LedgerKind,
  text = '',
  patch: Partial<LedgerInput> = {}
): LedgerEntry {
  const built = newEntry({ taskId: id, kind, text, ...patch })
  if (!built) throw new Error(`newEntry refused what should be a safe task id: ${id}`)
  return built
}

/** Count entries by kind: compaction is a policy about kinds, not about lines. */
function byKind(entries: readonly LedgerEntry[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of entries) out[item.kind] = (out[item.kind] ?? 0) + 1
  return out
}

/**
 * A ledger shaped like a long session: the whole brief near the front, where
 * compaction is most likely to lose it, and a wall of noise after it.
 */
function briefed(id: string, noise = 900): LedgerEntry[] {
  const head: LedgerEntry[] = [
    entry(id, 'goal', 'make the bench survive a reboot', { at: 1 }),
    entry(id, 'plan', 'read herdr snapshots', { at: 2 }),
    entry(id, 'session', '', { at: 3, agent: 'codex', sessionKind: 'id', sessionValue: 'sess-old' }),
    entry(id, 'session', '', { at: 4, agent: 'codex', sessionKind: 'id', sessionValue: 'sess-new' }),
    entry(id, 'git', 'head moved', { at: 5, gitHead: 'abc123', branch: 'main', dirty: 2 }),
    entry(id, 'checkpoint', 'marked done', { at: 6 }),
    entry(id, 'next', 'write the recovery plan', { at: 7 })
  ]
  for (let index = 0; index < 24; index += 1) {
    head.push(entry(id, 'plan', `plan ${index}`, { at: 10 + index }))
  }
  for (let index = 0; index < 40; index += 1) {
    head.push(entry(id, 'decision', `decision ${index}`, { at: 40 + index }))
  }
  const tail: LedgerEntry[] = []
  for (let index = 0; index < noise; index += 1) {
    tail.push(entry(id, 'event', `tick ${index}`, { at: 1000 + index }))
  }
  return [...head, ...tail]
}

describe('the task id that becomes a filename', () => {
  const safe: string[] = ['a', 'task-1', 'T_2.3', 'x'.repeat(64)]
  const unsafe: unknown[] = [
    '',
    '   ',
    '../etc/passwd',
    'a..b',
    '/abs/path',
    'has space',
    'a/b',
    'x'.repeat(65),
    null,
    42
  ]

  it.each(safe)('accepts %j and resolves it inside tasks/', (id) => {
    expect(isSafeTaskId(id)).toBe(true)
    expect(ledgerFileFor(id)).toBe(path.join(tasksDir, `${id}.jsonl`))
  })

  it.each(unsafe)('refuses %j before it can become a path', (id) => {
    expect(isSafeTaskId(id)).toBe(false)
    // The gate and the path builder must agree. If the gate let `a..b` through
    // and `ledgerFileFor` normalised it away, the writer and the reader would
    // end up looking at two different files.
    expect(ledgerFileFor(id as string)).toBeNull()
  })

  it('trims the same id to the same file on both sides', () => {
    expect(isSafeTaskId('  task-1  ')).toBe(true)
    expect(ledgerFileFor('  task-1  ')).toBe(ledgerFileFor('task-1'))
  })
})

describe('newEntry', () => {
  it('stamps the envelope and defaults every field a reader expects', () => {
    const id = taskId()
    const built = newEntry({ taskId: id, kind: 'goal', text: 'ship the bench' }, 1700000000000)
    expect(built).toEqual({
      v: 1,
      at: 1700000000000,
      id: expect.stringMatching(/^[a-z0-9]+-goal-[0-9a-f]{6}$/),
      taskId: id,
      kind: 'goal',
      text: 'ship the bench',
      agent: '',
      sessionKind: '',
      sessionValue: '',
      gitHead: '',
      branch: '',
      dirty: 0,
      paneId: '',
      workspaceId: '',
      source: 'gui'
    })
  })

  it('refuses an unsafe task id instead of writing somewhere else', () => {
    expect(newEntry({ taskId: '../evil', kind: 'goal', text: 'nope' })).toBeNull()
  })
})

describe('newEntry normalises what a hook hands it', () => {
  const clockFallbacks: (number | undefined)[] = [undefined, 0, -5, Number.NaN]

  it.each(clockFallbacks)('falls back to the clock when at is %s', (at) => {
    const before = Date.now()
    const built = newEntry({ taskId: taskId(), kind: 'event', at })
    expect(built?.at).toBeGreaterThanOrEqual(before)
  })

  it('truncates a fractional timestamp, because sort order must be integral', () => {
    expect(newEntry({ taskId: taskId(), kind: 'event', at: 12.9 })?.at).toBe(12)
  })

  it('keeps an id the caller minted, since hooks dedupe on it', () => {
    expect(newEntry({ taskId: taskId(), kind: 'event', at: 7, id: 'hook-42' })?.id).toBe('hook-42')
  })

  it('normalises the agent name so one CLI is not two agents', () => {
    expect(newEntry({ taskId: taskId(), kind: 'session', agent: '  Codex ' })?.agent).toBe('codex')
  })

  const sessionKinds: [string, 'id' | 'path' | ''][] = [
    ['path', 'path'],
    ['id', 'id'],
    ['uuid', '']
  ]

  it.each(sessionKinds)('coerces sessionKind %s to %s', (input, expected) => {
    const built = newEntry({
      taskId: taskId(),
      kind: 'session',
      sessionKind: input as LedgerInput['sessionKind'],
      sessionValue: 'sess-1'
    })
    expect(built?.sessionKind).toBe(expected)
  })
})

describe('entry budgets', () => {
  it('clips each field to its own limit', () => {
    const built = newEntry({
      taskId: taskId(),
      kind: 'event',
      text: 't'.repeat(5000),
      sessionValue: 's'.repeat(500),
      gitHead: 'g'.repeat(80),
      branch: 'b'.repeat(300),
      paneId: 'p'.repeat(200),
      workspaceId: 'w'.repeat(200),
      source: 'agent-cli-wrapper'.repeat(4)
    })
    // An agent pasting a whole diff into `text` is the realistic case. Without a
    // clip one line can outgrow the projection that has to render it, and the
    // ledger stops being cheap enough to re-read on every herdr event.
    expect(built?.text).toHaveLength(4000)
    expect(built?.sessionValue).toHaveLength(400)
    expect(built?.gitHead).toHaveLength(64)
    expect(built?.branch).toHaveLength(200)
    expect(built?.paneId).toHaveLength(120)
    expect(built?.workspaceId).toHaveLength(120)
    expect(built?.source).toHaveLength(24)
  })

  const dirtyCounts: [number, number][] = [
    [-3, 0],
    [2.7, 2],
    [Number.NaN, 0]
  ]

  it.each(dirtyCounts)('coerces a dirty count of %s to %s', (input, expected) => {
    expect(newEntry({ taskId: taskId(), kind: 'git', dirty: input })?.dirty).toBe(expected)
  })

  it('never mints the same entry id twice in one millisecond', () => {
    const seen = new Set<string>()
    for (let index = 0; index < 500; index += 1) seen.add(newEntryId(1700000000000, 'event'))
    expect(seen.size).toBe(500)
  })
})

describe('the line format', () => {
  it('is exactly one JSON object and one newline', () => {
    const built = entry(taskId(), 'note', 'one line')
    const line = entryLine(built)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(line)).toEqual(built)
  })

  it('round-trips through the reader recovery uses', () => {
    const built = entry(taskId(), 'decision', 'herdr owns every PTY', {
      agent: 'codex',
      source: 'gui'
    })
    expect(parseLedger(entryLine(built))).toEqual([built])
  })
})

describe('appending to disk', () => {
  it('fsyncs, because an append that can be lost is not an append', () => {
    const sync = vi.spyOn(fs, 'fsyncSync')
    expect(appendEntry(entry(taskId(), 'goal', 'survive a reboot'))).toBe(true)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('appends without rewriting what is already there', () => {
    const id = taskId()
    const first = entry(id, 'goal', 'first', { at: 1 })
    const second = entry(id, 'next', 'second', { at: 2 })
    expect(appendEntry(first)).toBe(true)
    expect(appendEntry(second)).toBe(true)
    const file = ledgerFileFor(id) as string
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw.startsWith(entryLine(first))).toBe(true)
    expect(raw.trimEnd().split('\n')).toHaveLength(2)
    expect(readEntries(id)).toEqual([first, second])
  })

  it('refuses a forged entry whose taskId escaped after construction', () => {
    // `newEntry` gates the id, but the entry is a plain object that crosses an
    // IPC boundary on its way here. The writer has to gate it again.
    const forged: LedgerEntry = { ...entry(taskId(), 'goal', 'first'), taskId: '../evil' }
    expect(appendEntry(forged)).toBe(false)
    expect(fs.existsSync(path.join(tasksDir, '..', 'evil.jsonl'))).toBe(false)
  })

  it('reads what another process appended, since hooks write too', () => {
    const id = taskId()
    fs.mkdirSync(tasksDir, { recursive: true })
    const file = ledgerFileFor(id) as string
    fs.writeFileSync(file, entryLine(entry(id, 'note', 'from a hook', { source: 'hook' })), 'utf8')
    const read = readEntries(id)
    expect(read).toHaveLength(1)
    expect(read[0]?.text).toBe('from a hook')
  })
})

/** Write a ledger body by hand, the way a crash or a hook would leave it. */
function laid(id: string, body: string): LedgerEntry[] {
  const file = ledgerFileFor(id)
  if (!file) throw new Error(`unsafe task id reached the writer: ${id}`)
  fs.mkdirSync(tasksDir, { recursive: true })
  fs.writeFileSync(file, body, 'utf8')
  return readEntries(id)
}

describe('a crash mid-write is a normal state', () => {
  it('drops a corrupt line in the middle and keeps reading', () => {
    const id = taskId()
    const read = laid(
      id,
      `${entryLine(entry(id, 'goal', 'first', { at: 1 }))}{this is not json\n${entryLine(
        entry(id, 'next', 'last', { at: 2 })
      )}`
    )
    // The alternative is a task that refuses to open because one line of its
    // history is unreadable, which loses the brief to save a byte.
    expect(read.map((item) => item.text)).toEqual(['first', 'last'])
  })

  it('drops a truncated tail, which is what a power cut leaves', () => {
    const id = taskId()
    const read = laid(
      id,
      `${entryLine(entry(id, 'goal', 'survived', { at: 1 }))}{"v":1,"at":2,"kind":"next","te`
    )
    expect(read.map((item) => item.text)).toEqual(['survived'])
  })

  it('drops an unknown kind instead of inventing one', () => {
    const id = taskId()
    const read = laid(
      id,
      `${JSON.stringify({ at: 1, kind: 'banana', taskId: id, text: 'nope' })}\n${JSON.stringify({
        at: 2,
        kind: 'goal',
        taskId: id,
        text: 'real'
      })}\n`
    )
    expect(read.map((item) => item.kind)).toEqual(['goal'])
  })

  it('folds a shouted kind to lower case, since hooks are shell scripts', () => {
    const read = laid(taskId(), `${JSON.stringify({ at: 2, kind: 'GOAL', text: 'shout it' })}\n`)
    expect(read[0]?.kind).toBe('goal')
    expect(read[0]?.text).toBe('shout it')
  })

  it('sorts by at, because two writers append in whatever order they woke up', () => {
    const id = taskId()
    const read = laid(
      id,
      entryLine(entry(id, 'event', 'third', { at: 30 })) +
        entryLine(entry(id, 'goal', 'first', { at: 10 })) +
        entryLine(entry(id, 'next', 'second', { at: 20 }))
    )
    expect(read.map((item) => item.text)).toEqual(['first', 'second', 'third'])
  })

  it('defaults the fields a hand-written line omits', () => {
    const read = laid(taskId(), `${JSON.stringify({ at: 5, kind: 'note', text: 'by hand' })}\n`)
    const only = read[0]
    expect(only).toMatchObject({
      v: 1,
      at: 5,
      // A line written by `echo >>` has no id, and the reader still needs one to
      // key a row in the UI, so the timestamp does the job.
      id: '5-note',
      kind: 'note',
      text: 'by hand',
      agent: '',
      sessionKind: '',
      sessionValue: '',
      dirty: 0,
      source: 'hook'
    })
  })

  it('reads a ledger that is not there yet as empty, not as an error', () => {
    expect(readEntries(taskId())).toEqual([])
  })

  it('reads nothing at all for an id that would escape tasks/', () => {
    expect(readEntries('../evil')).toEqual([])
  })
})

describe('compaction keeps the recovery brief', () => {
  it('returns a copy when there is nothing to compact', () => {
    const short = briefed(taskId(), 3)
    const kept = compactEntries(short)
    expect(kept).not.toBe(short)
    expect(kept).toEqual(short)
    // A copy, not the cached array: the store hands its cache straight to
    // callers, and a compaction that mutated it in place would rewrite history
    // for every reader holding the old reference.
    kept.pop()
    expect(short).toHaveLength(kept.length + 1)
  })

  it('lands on the limit with the goal still first', () => {
    const id = taskId()
    const entries = briefed(id)
    expect(entries.length).toBeGreaterThan(DEFAULT_LEDGER_LIMIT)
    const kept = compactEntries(entries)
    expect(kept).toHaveLength(DEFAULT_LEDGER_LIMIT)
    expect(kept[0]?.kind).toBe('goal')
    expect(kept[0]?.text).toBe('make the bench survive a reboot')
    expect(kept.some((item) => item.kind === 'next')).toBe(true)
  })

  it('keeps the kinds a digest reads and drops the wall of events', () => {
    const kept = compactEntries(briefed(taskId()))
    expect(byKind(kept)).toEqual({
      goal: 1,
      plan: 24,
      session: 2,
      git: 1,
      checkpoint: 1,
      next: 1,
      decision: 40,
      event: 330
    })
  })

  it('keeps the newest entry and stays in chronological order', () => {
    const entries = briefed(taskId())
    const kept = compactEntries(entries)
    expect(kept[kept.length - 1]).toEqual(entries[entries.length - 1])
    const ats = kept.map((item) => item.at)
    expect([...ats].sort((a, b) => a - b)).toEqual(ats)
  })

  it('keeps the two newest sessions, because only those can be resumed', () => {
    const id = taskId()
    const entries: LedgerEntry[] = [entry(id, 'goal', 'g', { at: 1 })]
    for (let index = 0; index < 4; index += 1) {
      entries.push(
        entry(id, 'session', '', {
          at: 2 + index,
          agent: 'codex',
          sessionKind: 'id',
          sessionValue: `sess-${index}`
        })
      )
    }
    for (let index = 0; index < 900; index += 1) {
      entries.push(entry(id, 'event', `tick ${index}`, { at: 100 + index }))
    }
    const kept = compactEntries(entries)
    const sessions = kept.filter((item) => item.kind === 'session').map((item) => item.sessionValue)
    expect(sessions).toEqual(['sess-2', 'sess-3'])
  })

  it('overshoots a limit smaller than the brief instead of dropping the brief', () => {
    const kept = compactEntries(briefed(taskId(), 3), 5)
    // The per-kind quotas are the whole point: a limit of 5 honoured literally
    // would keep five events and throw away the goal, the session id and the
    // next action - a smaller file with nothing worth reading in it.
    expect(kept.length).toBeGreaterThan(5)
    expect(kept[0]?.kind).toBe('goal')
    expect(kept.some((item) => item.kind === 'session')).toBe(true)
    expect(kept.some((item) => item.kind === 'next')).toBe(true)
  })

  it('is idempotent, so compacting the same file twice changes nothing', () => {
    const once = compactEntries(briefed(taskId(), 3), 5)
    expect(compactEntries(once, 5)).toEqual(once)
  })

  it('leaves the digest unchanged apart from the entry count', () => {
    const id = taskId()
    const entries = briefed(id)
    const before = ledgerDigest(id, entries)
    const after = ledgerDigest(id, compactEntries(entries))
    // The assertion the feature rests on. Compaction rewrites the only file
    // that records what a task was for, so the contract is not "the file got
    // smaller" but "recovery cannot tell the difference".
    expect(after).toEqual({ ...before, entries: DEFAULT_LEDGER_LIMIT })
    expect(after.goal).toBe('make the bench survive a reboot')
    expect(after.sessionValue).toBe('sess-new')
    expect(after.next).toBe('write the recovery plan')
  })
})

describe('compaction on disk', () => {
  it('rewrites the ledger in place and reports the new size', () => {
    const id = taskId()
    expect(writeLedger(id, briefed(id))).toBe(true)
    expect(compactLedger(id)).toBe(DEFAULT_LEDGER_LIMIT)
    expect(readEntries(id)).toHaveLength(DEFAULT_LEDGER_LIMIT)
  })

  it('leaves no temp file behind, because the rename is the commit point', () => {
    const id = taskId()
    writeLedger(id, briefed(id))
    compactLedger(id)
    // A leftover <id>.<pid>.tmp is not just litter: it means a rewrite died
    // between write and rename, and the next reader must still find the real
    // ledger untouched.
    const siblings = fs.readdirSync(tasksDir).filter((name) => name.startsWith(`${id}.`))
    expect(siblings).toEqual([`${id}.jsonl`])
  })

  it('keeps a ledger that is already small byte for byte', () => {
    const id = taskId()
    const entries = briefed(id, 3)
    writeLedger(id, entries)
    const file = ledgerFileFor(id) as string
    const before = fs.readFileSync(file, 'utf8')
    expect(compactLedger(id)).toBe(entries.length)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('refuses an id that would escape tasks/', () => {
    expect(compactLedger('../evil')).toBe(0)
    expect(writeLedger('../evil', [])).toBe(false)
  })
})

describe('LedgerStore', () => {
  it('serves the cache until it is told the file changed underneath', () => {
    const id = taskId()
    const store = new LedgerStore(tasksDir)
    store.append({ taskId: id, kind: 'goal', text: 'cached goal', at: 1 })
    expect(store.entries(id).map((item) => item.text)).toEqual(['cached goal'])
    // Another process - a hook, or a second Bench window - rewrites the file.
    writeLedger(id, [entry(id, 'goal', 'rewritten from outside', { at: 2 })])
    expect(store.entries(id).map((item) => item.text)).toEqual(['cached goal'])
    expect(store.digest(id)?.goal).toBe('cached goal')
    store.invalidate(id)
    expect(store.entries(id).map((item) => item.text)).toEqual(['rewritten from outside'])
    expect(store.digest(id)?.goal).toBe('rewritten from outside')
  })

  it('has no digest for a task that has never been written', () => {
    expect(new LedgerStore(tasksDir).digest(taskId())).toBeNull()
  })

  it('follows the latest goal and next action', () => {
    const id = taskId()
    const store = new LedgerStore(tasksDir)
    store.append({ taskId: id, kind: 'goal', text: 'first goal', at: 1 })
    store.append({ taskId: id, kind: 'goal', text: 'second goal', at: 2 })
    store.append({ taskId: id, kind: 'next', text: 'do the thing', at: 3 })
    const digest = store.digest(id)
    expect(digest?.goal).toBe('second goal')
    expect(digest?.next).toBe('do the thing')
    expect(digest?.entries).toBe(3)
    expect(digest?.lastAt).toBe(3)
  })

  it('digests a batch of task ids, nulls included', () => {
    const id = taskId()
    const missing = taskId()
    const store = new LedgerStore(tasksDir)
    store.append({ taskId: id, kind: 'goal', text: 'g', at: 1 })
    const all = store.allDigests([id, missing])
    // The bench renders one row per task, so a key must exist for every id it
    // asked about: an absent key and a null digest render differently.
    expect(Object.keys(all)).toEqual([id, missing])
    expect(all[missing]).toBeNull()
    expect(all[id]?.goal).toBe('g')
  })

  it('lists only real ledgers, not stray files dropped in tasks/', () => {
    const id = taskId()
    const store = new LedgerStore(tasksDir)
    store.append({ taskId: id, kind: 'goal', text: 'g', at: 1 })
    const note = path.join(tasksDir, 'notes.txt')
    const traversal = path.join(tasksDir, 'bad..id.jsonl')
    fs.writeFileSync(note, 'not a ledger', 'utf8')
    fs.writeFileSync(traversal, '', 'utf8')
    extras.push(note, traversal)
    const known = store.knownTaskIds()
    expect(known).toContain(id)
    expect(known).not.toContain('notes')
    // Anything that could travel out of tasks/ must not become an addressable
    // task just because it happens to end in .jsonl.
    expect(known).not.toContain('bad..id')
  })

  it('refuses an unsafe task id on append', () => {
    expect(new LedgerStore(tasksDir).append({ taskId: '../evil', kind: 'goal' })).toBeNull()
  })

  it('compacts itself once a ledger grows past twice the limit', () => {
    const id = taskId()
    const store = new LedgerStore(tasksDir)
    // 801 real fsyncs would make this the slowest test in the suite for no
    // reason; that the append fsyncs at all is pinned by the append test above.
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => undefined)
    store.append({ taskId: id, kind: 'goal', text: 'the goal', at: 1 })
    for (let index = 0; index < DEFAULT_LEDGER_LIMIT * 2; index += 1) {
      store.append({ taskId: id, kind: 'event', text: `tick ${index}`, at: 100 + index })
    }
    const entries = store.entries(id)
    expect(entries).toHaveLength(DEFAULT_LEDGER_LIMIT)
    expect(entries[0]?.kind).toBe('goal')
    // Cache and disk have to agree, or a restart would read the 801-line file
    // back and compact again on the very next append, forever.
    expect(readEntries(id)).toHaveLength(DEFAULT_LEDGER_LIMIT)
    expect(store.digest(id)?.goal).toBe('the goal')
  })
})

describe('the append that follows a hook', () => {
  it('does not duplicate the entry the hook already wrote', () => {
    const id = taskId()
    // The shape this bug actually arrives in: a hook appends while Pro is
    // closed, then the GUI starts with a cold cache and appends once. The
    // write lands on disk before the cache-miss read, so the read came back
    // holding the new line and the concat added a second copy of it.
    appendEntry(entry(id, 'goal', 'from a hook', { at: 1, source: 'hook' }))
    const store = new LedgerStore(tasksDir)
    store.append({ taskId: id, kind: 'next', text: 'from the gui', at: 2 })
    expect(store.entries(id).map((item) => item.text)).toEqual(['from a hook', 'from the gui'])
    expect(store.digest(id)?.entries).toBe(2)
    expect(readEntries(id)).toHaveLength(2)
  })

  it('does not duplicate the first entry of a brand new ledger either', () => {
    const id = taskId()
    const store = new LedgerStore(tasksDir)
    store.append({ taskId: id, kind: 'goal', text: 'only line', at: 1 })
    expect(store.entries(id).map((item) => item.text)).toEqual(['only line'])
    expect(store.digest(id)?.entries).toBe(1)
  })
})
