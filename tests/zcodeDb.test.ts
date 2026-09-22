import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { readZcodeTranscript, zcodeSession, zcodeThreads } from '../src/main/zcodeDb'

// ============================================================
// ZCode's SQLite history.
//
// Fixtures are real databases built in a temp dir, not mocked rows: the point
// of this module is that its SQL agrees with the schema ZCode actually writes,
// and a stub would happily pass against a column name that does not exist.
//
// ⛔ Every call passes an explicit path. `vitest.config.ts` redirects the Codex
//    and Claude homes but not `ZCODE_STORAGE_DIR`, so the default would be the
//    developer's own ~/.zcode.
// ============================================================

const SESSION_ID = 'sess_21d099bd-cdb6-4a09-8949-c5d13981e743'

let workdir = ''

function dbFile(name: string = 'db.sqlite'): string {
  workdir = workdir || fs.mkdtempSync(path.join(os.tmpdir(), 'codewaifu-zcode-'))
  const dir = path.join(workdir, path.basename(name, '.sqlite'))
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, name)
}

/** The three tables ZCode writes, with only the columns this reader touches. */
function open(file: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    create table session (
      id text primary key, directory text not null, title text not null,
      parent_id text, time_created integer not null, time_updated integer not null,
      time_archived integer, task_type text not null default 'interactive'
    );
    create table message (
      id text primary key, session_id text not null, time_created integer not null,
      data text not null, sequence integer
    );
    create table part (
      id text primary key, message_id text not null, session_id text not null,
      time_created integer not null, data text not null, sequence integer
    );
    create index message_session_sequence_idx on message (session_id, sequence, time_created, id);
  `)
  return db
}

interface SessionSpec {
  id?: string
  title?: string
  directory?: string
  parent?: string | null
  archived?: number | null
  taskType?: string
  at?: number
}

function addSession(db: DatabaseSync, spec: SessionSpec = {}): string {
  const id = spec.id ?? SESSION_ID
  db.prepare(
    'insert into session (id, directory, title, parent_id, time_created, time_updated, time_archived, task_type) values (?,?,?,?,?,?,?,?)'
  ).run(
    id,
    spec.directory ?? '/tmp/codewaifu-proj',
    spec.title ?? 'untitled',
    spec.parent ?? null,
    spec.at ?? 1_788_900_000_000,
    spec.at ?? 1_788_900_000_000,
    spec.archived ?? null,
    spec.taskType ?? 'interactive'
  )
  return id
}

let messageSeq = 0
let partSeq = 0

function addMessage(
  db: DatabaseSync,
  sessionId: string,
  data: Record<string, unknown>,
  at: number = 1_788_900_000_000
): string {
  const id = `msg_${++messageSeq}`
  db.prepare(
    'insert into message (id, session_id, time_created, data, sequence) values (?,?,?,?,?)'
  ).run(id, sessionId, at, JSON.stringify(data), messageSeq)
  return id
}

function addPart(
  db: DatabaseSync,
  sessionId: string,
  messageId: string,
  data: Record<string, unknown>,
  at: number = 1_788_900_000_000
): void {
  db.prepare(
    'insert into part (id, message_id, session_id, time_created, data, sequence) values (?,?,?,?,?,?)'
  ).run(`part_${++partSeq}`, messageId, sessionId, at, JSON.stringify(data), partSeq)
}

/** A user turn plus an assistant turn, the shape every test starts from. */
function addTurn(db: DatabaseSync, sessionId: string, user: string, assistant: string): void {
  const at = 1_788_900_000_000 + messageSeq * 1000
  const userMsg = addMessage(db, sessionId, { role: 'user' }, at)
  addPart(db, sessionId, userMsg, { type: 'text', text: user, time: { start: at } }, at)
  const reply = addMessage(db, sessionId, { role: 'assistant' }, at + 500)
  addPart(db, sessionId, reply, { type: 'text', text: assistant, time: { start: at + 500 } }, at + 500)
}

const openHandles: DatabaseSync[] = []

function fixture(name: string = 'db.sqlite'): { file: string; db: DatabaseSync; session: string } {
  const file = dbFile(name)
  const db = open(file)
  openHandles.push(db)
  const session = addSession(db)
  return { file, db, session }
}

afterEach(() => {
  for (const db of openHandles.splice(0)) {
    try {
      db.close()
    } catch {
      /* a handle already closed by the test itself */
    }
  }
  if (workdir) {
    fs.rmSync(workdir, { recursive: true, force: true })
    workdir = ''
  }
  messageSeq = 0
  partSeq = 0
})

describe('zcodeThreads', () => {
  it('lists interactive sessions, newest first', () => {
    const file = dbFile('list.sqlite')
    const db = open(file)
    openHandles.push(db)
    addSession(db, { id: 'sess_old', title: 'first task', at: 1_788_000_000_000 })
    addSession(db, { id: 'sess_new', title: 'second task', at: 1_788_900_000_000 })

    const threads = zcodeThreads(file)
    expect(threads.map((thread) => thread.id)).toEqual(['sess_new', 'sess_old'])
    expect(threads[0]).toMatchObject({
      key: 'zcode:sess_new',
      agent: 'zcode',
      title: 'second task',
      cwd: '/tmp/codewaifu-proj',
      live: false,
      // ZCode has no injection API: steering falls back to the clipboard.
      steerable: false
    })
  })

  it('leaves out sub-agent sessions and archived ones', () => {
    const file = dbFile('filtered.sqlite')
    const db = open(file)
    openHandles.push(db)
    addSession(db, { id: 'sess_parent', title: 'the conversation' })
    addSession(db, {
      id: 'sess_subagent_agent_child',
      title: 'a sub-agent ran',
      parent: 'sess_parent',
      taskType: 'subagent_child'
    })
    addSession(db, { id: 'sess_gone', title: 'archived', archived: 1_788_910_000_000 })

    expect(zcodeThreads(file).map((thread) => thread.id)).toEqual(['sess_parent'])
  })

  it('falls back to the directory, then the id, when there is no title', () => {
    const file = dbFile('titles.sqlite')
    const db = open(file)
    openHandles.push(db)
    addSession(db, {
      id: 'sess_aaaaaaaaaa',
      title: '',
      directory: '/home/me/dev/robotworld',
      at: 1_788_900_000_000
    })
    addSession(db, { id: 'sess_bbbbbbbbbb', title: '', directory: '', at: 1_788_910_000_000 })

    const byName = Object.fromEntries(zcodeThreads(file).map((thread) => [thread.id, thread.title]))
    expect(byName['sess_aaaaaaaaaa']).toBe('robotworld')
    expect(byName['sess_bbbbbbbbbb']).toBe('bbbbbbbb')
  })

  it('breaks a tie on time deterministically, so the board does not churn', () => {
    const file = dbFile('tie.sqlite')
    const db = open(file)
    openHandles.push(db)
    const at = 1_788_900_000_000
    addSession(db, { id: 'sess_11111111', title: 'a', at })
    addSession(db, { id: 'sess_22222222', title: 'b', at })
    addSession(db, { id: 'sess_33333333', title: 'c', at })

    // Same millisecond on all three: two reads must not disagree, or the thread
    // list reorders under the user between polls.
    const first = zcodeThreads(file).map((thread) => thread.id)
    expect(first).toEqual(['sess_33333333', 'sess_22222222', 'sess_11111111'])
    expect(zcodeThreads(file).map((thread) => thread.id)).toEqual(first)
  })

  it('answers [] for a missing database and for a file that is not one', () => {
    expect(zcodeThreads(path.join(os.tmpdir(), 'codewaifu-nope', 'db.sqlite'))).toEqual([])
    const notADb = dbFile('garbage.sqlite')
    fs.mkdirSync(path.dirname(notADb), { recursive: true })
    fs.writeFileSync(notADb, 'this is not a sqlite file at all')
    expect(zcodeThreads(notADb)).toEqual([])
  })
})

describe('zcodeSession', () => {
  it('resolves both the sess_ spelling and the bare uuid', () => {
    const { file, session } = fixture('session.sqlite')
    const bare = session.replace(/^sess_/, '')

    expect(zcodeSession(file, session)?.id).toBe(session)
    // A hook payload reports the bare uuid; the board must land on the same
    // row, or one conversation shows up twice.
    expect(zcodeSession(file, bare)?.id).toBe(session)
    expect(zcodeSession(file, 'sess_does-not-exist')).toBeNull()
    expect(zcodeSession(file, '')).toBeNull()
  })
})

describe('readZcodeTranscript', () => {
  it('reads a conversation in order, with roles and tool calls', () => {
    const { file, db, session } = fixture('transcript.sqlite')
    addTurn(db, session, 'fix the build', 'looking at it now')
    const at = 1_788_900_010_000
    const working = addMessage(db, session, { role: 'assistant' }, at)
    addPart(db, session, working, { type: 'reasoning', text: 'the lockfile disagrees', time: { start: at } }, at)
    addPart(
      db,
      session,
      working,
      {
        type: 'tool',
        callID: 'call_1',
        tool: 'Bash',
        state: {
          status: 'completed',
          input: { command: 'npm run build' },
          output: 'built in 4.2s',
          title: 'Bash',
          time: { start: at + 1 }
        }
      },
      at + 1
    )
    addPart(
      db,
      session,
      working,
      {
        type: 'tool',
        callID: 'call_2',
        tool: 'Edit',
        state: { status: 'error', input: { file_path: '/tmp/x.ts' }, error: 'modified since read' }
      },
      at + 2
    )
    addPart(db, session, working, { type: 'text', text: 'fixed it', time: { start: at + 3 } }, at + 3)
    // Not conversation: the step markers ZCode writes around every turn.
    addPart(db, session, working, { type: 'step-start' }, at + 4)
    addPart(db, session, working, { type: 'step-finish', finishReason: 'stop' }, at + 5)

    const found = readZcodeTranscript(file, session)
    expect(found).not.toBeNull()
    expect(found?.title).toBe('untitled')
    expect(found?.cwd).toBe('/tmp/codewaifu-proj')
    expect(found?.file).toBe(file)
    expect(found?.dropped).toBe(0)
    expect(found?.messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'fix the build'],
      ['assistant', 'looking at it now'],
      ['reasoning', 'the lockfile disagrees'],
      ['tool', 'npm run build'],
      ['tool', '/tmp/x.ts'],
      ['assistant', 'fixed it']
    ])

    const shell = found?.messages[3]
    expect(shell?.tool).toBe('Bash')
    // `command` stays whole so the output's language can be detected.
    expect(shell?.command).toBe('npm run build')
    expect(shell?.output).toBe('built in 4.2s')

    // A failed tool keeps its error text: that is the only account of it.
    const failed = found?.messages[4]
    expect(failed?.tool).toBe('Edit')
    expect(failed?.output).toBe('modified since read')
  })

  it('skips synthetic scaffolding messages', () => {
    const { file, db, session } = fixture('synthetic.sqlite')
    addTurn(db, session, 'hello', 'hi')
    const hidden = addMessage(
      db,
      session,
      { role: 'user', synthetic: 1, semantics: { transcriptVisibility: 'hidden' } },
      1_788_900_020_000
    )
    addPart(
      db,
      session,
      hidden,
      { type: 'text', text: '<system-reminder>the todo list is empty</system-reminder>' },
      1_788_900_020_000
    )
    addTurn(db, session, 'keep going', 'done')

    const found = readZcodeTranscript(file, session)
    expect(found?.messages.map((message) => message.text)).toEqual([
      'hello',
      'hi',
      'keep going',
      'done'
    ])
  })

  it('does not draw injected context as something a human said', () => {
    const { file, db, session } = fixture('injected.sqlite')
    const at = 1_788_900_030_000
    const injected = addMessage(db, session, { role: 'user' }, at)
    addPart(
      db,
      session,
      injected,
      { type: 'text', text: '<environment_context>cwd is /tmp</environment_context>' },
      at
    )
    addTurn(db, session, 'a real question', 'a real answer')

    const found = readZcodeTranscript(file, session)
    expect(found?.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(found?.messages[0].text).toBe('a real question')
  })

  it('drops empty text parts and unknown roles', () => {
    const { file, db, session } = fixture('empty.sqlite')
    const at = 1_788_900_040_000
    const msg = addMessage(db, session, { role: 'assistant' }, at)
    addPart(db, session, msg, { type: 'text', text: '   ' }, at)
    addPart(db, session, msg, { type: 'timeline', entries: [] }, at + 1)
    addTurn(db, session, 'still there?', 'yes')

    const found = readZcodeTranscript(file, session)
    expect(found?.messages.map((message) => message.text)).toEqual(['still there?', 'yes'])
  })

  it('windows to the newest parts and reports what it left out', () => {
    const { file, db, session } = fixture('window.sqlite')
    // In one transaction: 120 autocommit inserts fsync 120 times, and the
    // second this test takes is SQLite's journal, not the reader.
    db.exec('begin')
    for (let index = 0; index < 30; index += 1) addTurn(db, session, `q${index}`, `a${index}`)
    db.exec('commit')

    const found = readZcodeTranscript(file, session, { limit: 20 })
    expect(found?.messages).toHaveLength(20)
    // 60 chat parts in the session, 20 shown.
    expect(found?.dropped).toBe(40)
    // The window is the tail, not the head.
    expect(found?.messages.at(-1)?.text).toBe('a29')
    expect(found?.messages[0].text).toBe('q20')
  })

  it('clips a pathological tool output instead of shipping it whole', () => {
    const { file, db, session } = fixture('clip.sqlite')
    const at = 1_788_900_050_000
    const msg = addMessage(db, session, { role: 'assistant' }, at)
    addPart(
      db,
      session,
      msg,
      {
        type: 'tool',
        callID: 'call_big',
        tool: 'Bash',
        state: { status: 'completed', input: { command: 'cat huge.log' }, output: 'x'.repeat(40_000) }
      },
      at
    )

    const found = readZcodeTranscript(file, session)
    const tool = found?.messages[0]
    expect(tool?.truncated).toBe(true)
    expect((tool?.output ?? '').length).toBeLessThan(5000)
  })

  it('answers null for a session that is not there, and for a broken database', () => {
    const { file } = fixture('missing-session.sqlite')
    expect(readZcodeTranscript(file, 'sess_nope')).toBeNull()
    expect(readZcodeTranscript(file, '')).toBeNull()
    expect(readZcodeTranscript(path.join(os.tmpdir(), 'codewaifu-nope', 'db.sqlite'), SESSION_ID)).toBeNull()

    const notADb = dbFile('corrupt.sqlite')
    fs.mkdirSync(path.dirname(notADb), { recursive: true })
    fs.writeFileSync(notADb, 'not a database')
    expect(readZcodeTranscript(notADb, SESSION_ID)).toBeNull()
    expect(zcodeSession(notADb, SESSION_ID)).toBeNull()
  })

  it('reads a bare uuid, and reports freshness from the WAL sidecars', () => {
    const { file, db, session } = fixture('wal.sqlite')
    addTurn(db, session, 'hello', 'hi')
    const bare = session.replace(/^sess_/, '')

    const before = readZcodeTranscript(file, bare)
    expect(before?.messages).toHaveLength(2)

    // ZCode runs in WAL mode, so the main file's mtime can sit still while new
    // parts land in `-wal`. The newest of the three is what says "live".
    const sidecar = `${file}-wal`
    fs.writeFileSync(sidecar, 'wal bytes')
    const bumped = new Date(Date.now() + 5_000)
    fs.utimesSync(sidecar, bumped, bumped)

    const after = readZcodeTranscript(file, bare)
    // Compared with a 2ms floor rather than exactly: APFS stores nanoseconds,
    // so a millisecond written through `utimesSync` can read back a hair under
    // what was set (`...615.999` for `...616`, seen on a macOS runner). ext4
    // rounds the same value up instead. The production reader only ever asks
    // "newer than the last read?", where a sub-millisecond artifact means
    // nothing, so the assertion is about the sidecar winning and not about the
    // filesystem's float representation.
    expect(after?.mtimeMs).toBeGreaterThanOrEqual(bumped.getTime() - 2)
    expect(after?.bytes).toBeGreaterThan(0)
    // The sidecar is 5s in the future and the database is not, so the sidecar
    // is what the freshness number came from - the actual claim under test.
    expect(after?.mtimeMs).toBeGreaterThan(before?.mtimeMs ?? 0)
  })
})
