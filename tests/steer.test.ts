import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { confirmDelivery, isActive, type Resolver } from '../src/main/delivery'
import { NEEDLE_CHARS, deliveryFound, jsonNeedle } from '../src/shared/steer'

// ============================================================
// "Did the steered message actually reach the agent?"
//
// `codex queue` exits 0 for idle *and* working threads, and a working session
// never reads the queue, so the exit code cannot be reported as success. These
// cover both halves of the replacement: the JSONL needle matching (pure) and the
// transcript polling that turns it into a verdict. The pollers take an injected
// resolver, so the fixtures live in a private temp dir instead of the shared
// fake CODEX_HOME other test files wipe mid-run.
// ============================================================

const THREAD = '01a09f9c-1513-7321-a85b-94d27140fed1'

/** Private fixture tree; nothing else in the suite looks here. */
let workdir = ''
let file = ''
const resolve: Resolver = () => file

function write(rows: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

function append(rows: Array<Record<string, unknown>>): void {
  fs.appendFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

/** The row shape a consumed queue item leaves in the transcript. */
const userRow = (text: string): Record<string, unknown> => ({
  timestamp: new Date().toISOString(),
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text, text_elements: [] }] }
})

const metaRow = (): Record<string, unknown> => ({
  timestamp: new Date().toISOString(),
  type: 'session_meta',
  payload: { type: 'session_meta', cwd: '/tmp/codewaifu-proj' }
})

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewaifu-steer-'))
  file = path.join(workdir, '2026', '09', '14', `rollout-2026-09-14T19-10-01-${THREAD}.jsonl`)
})

afterEach(() => {
  if (workdir.startsWith(os.tmpdir())) fs.rmSync(workdir, { recursive: true, force: true })
  workdir = ''
  file = ''
})

describe('jsonNeedle', () => {
  it('escapes the text the way JSONL stores it', () => {
    expect(jsonNeedle('say "hi"\nnow')).toBe('say \\"hi\\"\\nnow')
    expect(jsonNeedle('C:\\tmp\\x')).toBe('C:\\\\tmp\\\\x')
  })

  it('keeps a surrogate pair whole at the cut', () => {
    // Cutting by UTF-16 index would leave a lone half, which JSON escapes as
    // \ud83d and never matches the file.
    const head = 'a'.repeat(NEEDLE_CHARS - 1)
    expect(jsonNeedle(head + '😀 tail')).toBe(head + '😀')
  })

  it('is empty for an empty message', () => {
    expect(jsonNeedle('')).toBe('')
    expect(jsonNeedle(undefined as unknown as string)).toBe('')
  })
})

describe('deliveryFound', () => {
  it('finds the message inside a real transcript body', () => {
    const body = [metaRow(), userRow('对话面板能看到对话的历史了')].map((row) => JSON.stringify(row)).join('\n')
    expect(deliveryFound(body, '对话面板能看到对话的历史了')).toBe(true)
  })

  it('does not report another message as ours', () => {
    const body = JSON.stringify(userRow('fix the build'))
    expect(deliveryFound(body, 'ship it')).toBe(false)
    // A prefix is not a delivered message: reporting it as sent is the exact
    // false success this module exists to remove.
    expect(deliveryFound(body, 'fix the buil')).toBe(false)
    expect(deliveryFound(JSON.stringify(userRow('please fix the build now')), 'fix the build')).toBe(false)
  })

  it('matches a long paste by its head', () => {
    // Past a NEEDLE_CHARS cut the closing quote is gone, so the head alone has
    // to be enough — at 160 code points it is unique in any real transcript.
    const text = 'x'.repeat(4000)
    expect(deliveryFound(JSON.stringify(userRow(text)), text)).toBe(true)
  })

  it('never matches on an empty message', () => {
    expect(deliveryFound(JSON.stringify(userRow('anything')), '')).toBe(false)
  })
})

describe('isActive', () => {
  it('is true while the agent is still writing', () => {
    write([metaRow()])
    expect(isActive('codex', THREAD, Date.now(), resolve)).toBe(true)
  })

  it('is false once the transcript has gone quiet', () => {
    write([metaRow()])
    const old = new Date(Date.now() - 10 * 60 * 1000)
    fs.utimesSync(file, old, old)
    expect(isActive('codex', THREAD, Date.now(), resolve)).toBe(false)
  })

  it('is false for a thread with no transcript on disk', () => {
    expect(isActive('codex', '01a09db0-f138-71b3-81f4-128a8d4d4b79', Date.now(), () => null)).toBe(false)
  })
})

describe('confirmDelivery', () => {
  it('confirms a message that is already in the transcript', async () => {
    write([metaRow(), userRow('PING-RUNNING-EXEC')])
    await expect(confirmDelivery('codex', THREAD, 'PING-RUNNING-EXEC', 500, resolve)).resolves.toBe(true)
  })

  it('waits for the row to be appended', async () => {
    write([metaRow()])
    const landed = setTimeout(() => append([userRow('queued steer')]), 400)
    const found = await confirmDelivery('codex', THREAD, 'queued steer', 3000, resolve)
    clearTimeout(landed)
    expect(found).toBe(true)
  })

  it('gives up on a session that never reads the queue', async () => {
    write([metaRow(), userRow('something else')])
    const started = Date.now()
    // The real bug: exit 0, row written to queued_items, nothing in the rollout.
    await expect(confirmDelivery('codex', THREAD, 'PING-RUNNING-EXEC', 700, resolve)).resolves.toBe(false)
    expect(Date.now() - started).toBeGreaterThanOrEqual(700)
  })

  it('is false immediately when the thread has no transcript', async () => {
    const started = Date.now()
    const missing: Resolver = () => null
    await expect(confirmDelivery('codex', THREAD, 'hello', 0, missing)).resolves.toBe(false)
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('does not wait at all on a zero timeout', async () => {
    write([metaRow()])
    const landed = setTimeout(() => append([userRow('too late')]), 50)
    const started = Date.now()
    await expect(confirmDelivery('codex', THREAD, 'too late', 0, resolve)).resolves.toBe(false)
    expect(Date.now() - started).toBeLessThan(40)
    clearTimeout(landed)
  })
})
