import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeProjectsDir, codexSessionsDir } from '../src/main/env'
import {
  clearTranscriptCache,
  findClaudeTranscript,
  findCodexRollout,
  readTranscript,
  transcriptFile
} from '../src/main/transcript'

// ============================================================
// Transcript discovery + byte-level tailing.
//
// The fixtures live under the redirected CODEX_HOME / CLAUDE_CONFIG_DIR from
// vitest.config.ts, so `readTranscript` exercises the same default roots the
// app uses without touching a real agent install.
// ============================================================

const CODEX_ID = '01a09d95-46b4-7a81-9ded-8fbc189c5f83'
const CLAUDE_ID = 'faa87ccd-6229-471b-9b79-b303d2b2fa4b'
/** Where Codex would put today's rollout: sessions/YYYY/MM/DD. */
const CODEX_DAY = path.join(codexSessionsDir, '2026', '09', '14')
const CODEX_FILE = path.join(CODEX_DAY, `rollout-2026-09-14T09-43-21-${CODEX_ID}.jsonl`)
const CLAUDE_PROJECT = path.join(claudeProjectsDir, '-tmp-codewaifu-proj')
const CLAUDE_FILE = path.join(CLAUDE_PROJECT, `${CLAUDE_ID}.jsonl`)

function write(file: string, rows: Array<Record<string, unknown> | string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n')
}

function append(file: string, rows: Array<Record<string, unknown> | string>): void {
  fs.appendFileSync(file, rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n')
}

const at = (second: number): string => new Date(Date.UTC(2026, 8, 14, 9, 43, second)).toISOString()

function codexRows(): Array<Record<string, unknown>> {
  return [
    { timestamp: at(0), type: 'session_meta', payload: { type: 'session_meta', cwd: '/tmp/codewaifu-proj' } },
    {
      timestamp: at(1),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the build' }] }
    },
    {
      timestamp: at(2),
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', call_id: 'call_1', arguments: '{"cmd":["npm","run","build"]}' }
    },
    {
      timestamp: at(3),
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_1', output: 'built in 4.2s' }
    },
    {
      timestamp: at(4),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Build is green.' }] }
    }
  ]
}

function claudeRows(): Array<Record<string, unknown>> {
  return [
    {
      type: 'user',
      timestamp: at(0),
      cwd: '/tmp/codewaifu-proj',
      message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] }
    },
    {
      type: 'assistant',
      timestamp: at(1),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }]
      }
    },
    {
      type: 'user',
      timestamp: at(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '230 passed' }] }] }
    },
    {
      type: 'assistant',
      timestamp: at(3),
      message: { role: 'assistant', content: [{ type: 'text', text: 'All tests pass.' }] }
    }
  ]
}

beforeEach(() => {
  clearTranscriptCache()
  write(CODEX_FILE, codexRows())
  write(CLAUDE_FILE, claudeRows())
})

afterEach(() => {
  clearTranscriptCache()
  for (const dir of [codexSessionsDir, claudeProjectsDir]) {
    // Only ever remove the fixture tree we created under the temp home.
    if (dir.startsWith(os.tmpdir())) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('findCodexRollout', () => {
  it('walks the full sessions/YYYY/MM/DD nesting', () => {
    // Regression: the day listing used to be built as `root/month`, which does
    // not exist, so no Codex thread could ever resolve its transcript and the
    // chat view said "no transcript file" for all 48 of them.
    expect(findCodexRollout(CODEX_ID)).toBe(CODEX_FILE)
    expect(transcriptFile('codex', CODEX_ID)).toBe(CODEX_FILE)
  })

  it('returns null for an id with no rollout, and for an id that is not an id', () => {
    expect(findCodexRollout('01a09d95-0000-0000-0000-000000000000')).toBeNull()
    expect(transcriptFile('codex', '../../etc/passwd')).toBeNull()
    expect(transcriptFile('codex', '')).toBeNull()
  })

  it('searches an explicit root, so a relocated CODEX_HOME still resolves', () => {
    const root = path.join(os.tmpdir(), 'codewaifu-other-codex', 'sessions')
    const file = path.join(root, '2026', '01', '02', `rollout-2026-01-02T00-00-00-${CODEX_ID}.jsonl`)
    write(file, codexRows())
    try {
      expect(findCodexRollout(CODEX_ID, root)).toBe(file)
    } finally {
      fs.rmSync(path.join(os.tmpdir(), 'codewaifu-other-codex'), { recursive: true, force: true })
    }
  })
})

describe('findClaudeTranscript', () => {
  it('finds <project>/<uuid>.jsonl across project directories', () => {
    expect(findClaudeTranscript(CLAUDE_ID)).toBe(CLAUDE_FILE)
  })

  it('returns null when the session was cleaned up', () => {
    expect(findClaudeTranscript('00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})

describe('readTranscript', () => {
  it('normalizes a Codex rollout and folds the tool output onto its call', () => {
    const found = readTranscript('codex', CODEX_ID)
    expect(found).not.toBeNull()
    expect(found?.cwd).toBe('/tmp/codewaifu-proj')
    expect(found?.file).toBe(CODEX_FILE)
    expect(found?.steerable).toBe(true)
    expect(found?.messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'fix the build'],
      ['tool', 'npm run build'],
      ['assistant', 'Build is green.']
    ])
    expect(found?.messages[1].output).toBe('built in 4.2s')
  })

  it('normalizes a Claude transcript and marks it non-steerable', () => {
    const found = readTranscript('claude', CLAUDE_ID)
    expect(found?.steerable).toBe(false)
    expect(found?.messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'ship it'],
      ['tool', 'npm test'],
      ['assistant', 'All tests pass.']
    ])
    expect(found?.messages[1].output).toBe('230 passed')
  })

  it('picks up rows appended after the first read without re-reading the file', () => {
    const first = readTranscript('codex', CODEX_ID)
    expect(first?.messages).toHaveLength(3)
    append(CODEX_FILE, [
      {
        timestamp: at(5),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'and the tests?' }] }
      }
    ])
    const second = readTranscript('codex', CODEX_ID)
    expect(second?.messages).toHaveLength(4)
    expect(second?.messages[3].text).toBe('and the tests?')
    expect(second?.bytes).toBeGreaterThan(first?.bytes ?? 0)
  })

  it('holds back a half-written last line until the agent finishes it', () => {
    fs.appendFileSync(CODEX_FILE, '{"timestamp":"' + at(6) + '","type":"response_item","payload":{"type":"mes')
    const torn = readTranscript('codex', CODEX_ID)
    expect(torn?.messages).toHaveLength(3)
    fs.appendFileSync(CODEX_FILE, 'sage","role":"user","content":[{"type":"input_text","text":"done"}]}}\n')
    expect(readTranscript('codex', CODEX_ID)?.messages).toHaveLength(4)
  })

  it('caps the window at `limit` and reports how much was dropped', () => {
    const many = codexRows()
    for (let index = 0; index < 40; index += 1) {
      many.push({
        timestamp: at(10 + index),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `turn ${index}` }] }
      })
    }
    write(CODEX_FILE, many)
    clearTranscriptCache()
    const found = readTranscript('codex', CODEX_ID, { limit: 20 })
    expect(found?.messages).toHaveLength(20)
    expect(found?.dropped).toBe(23)
    // "Load older" widens the window instead of re-reading the same tail.
    const wider = readTranscript('codex', CODEX_ID, { limit: 60 })
    expect(wider?.messages).toHaveLength(43)
    expect(wider?.dropped).toBe(0)
    expect(wider?.messages[0].text).toBe('fix the build')
  })

  it('returns null when the session has no transcript on disk', () => {
    expect(readTranscript('codex', '01a09d95-0000-0000-0000-000000000000')).toBeNull()
  })

  it('starts over when the file was rotated underneath us', () => {
    expect(readTranscript('codex', CODEX_ID)?.messages).toHaveLength(3)
    write(CODEX_FILE, codexRows().slice(0, 2))
    const shrunk = readTranscript('codex', CODEX_ID)
    expect(shrunk?.messages).toHaveLength(1)
    expect(shrunk?.messages[0].text).toBe('fix the build')
  })
})
