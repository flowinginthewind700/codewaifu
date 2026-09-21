import { describe, expect, it } from 'vitest'
import {
  isInjectedContext,
  normalizeMessages,
  parseClaudeRow,
  parseCodexRow,
  splitBlocks,
  summarizeArgs
} from '../src/shared/chat'

// ============================================================
// Transcript rows -> chat bubbles. Pure functions only: file discovery and
// tailing are covered in tests/transcript.test.ts.
// ============================================================

describe('summarizeArgs', () => {
  it('reads the command out of a Codex shell call', () => {
    expect(summarizeArgs('{"cmd":"npm run build","yield_time_ms":30000}')).toBe('npm run build')
  })

  it('reads Claude Code Bash input', () => {
    expect(summarizeArgs({ command: 'npm test', description: 'Run tests' })).toBe('npm test')
  })

  it('flattens an argv array instead of showing nothing', () => {
    // Codex `prefix_rule` is an array; before this the row rendered empty.
    expect(summarizeArgs('{"cmd":"ssh box","prefix_rule":["ssh","bxi"]}')).toBe('ssh box')
    expect(summarizeArgs({ prefix_rule: ['python3', '-m', 'server'] })).toBe('python3 -m server')
  })

  it('summarizes a plan by its steps', () => {
    const args = { plan: [{ step: 'Fix the build', status: 'in_progress' }, { step: 'Ship it', status: 'pending' }] }
    expect(summarizeArgs(args)).toBe('Fix the build · Ship it')
  })

  it('falls back to the first text field when no preferred key is present', () => {
    expect(summarizeArgs({ status: 'complete' })).toBe('complete')
    expect(summarizeArgs({ session_id: 123, tty: true })).toBe('')
  })

  it('keeps a raw patch body, cut to the cap', () => {
    const patch = '*** Begin Patch\n' + '+x'.repeat(200)
    const summary = summarizeArgs(patch)
    expect(summary.startsWith('*** Begin Patch')).toBe(true)
    expect(summary.length).toBeLessThanOrEqual(121)
    expect(summary.endsWith('…')).toBe(true)
  })
})

describe('parseCodexRow', () => {
  const row = (payload: Record<string, unknown>, timestamp = '2026-09-14T09:43:21.000Z'): Record<string, unknown> => ({
    timestamp,
    type: 'response_item',
    payload
  })

  it('keeps user and assistant messages', () => {
    expect(parseCodexRow(row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }), 0)).toMatchObject({
      role: 'user',
      text: 'hi'
    })
    expect(parseCodexRow(row({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'yo' }] }), 1)).toMatchObject({
      role: 'assistant',
      text: 'yo'
    })
  })

  it('drops prompt scaffolding that Codex stores under role "user"', () => {
    const injected = row({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context><cwd>/tmp</cwd></environment_context>' }]
    })
    expect(parseCodexRow(injected, 0)).toBeNull()
    expect(parseCodexRow(row({ type: 'message', role: 'developer', content: [{ type: 'text', text: 'rules' }] }), 1)).toBeNull()
    expect(isInjectedContext('# AGENTS.md instructions for /tmp/x')).toBe(true)
  })

  it('renders a tool call as a tool row carrying its detail', () => {
    const call = row({ type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"ls -la"}' })
    expect(parseCodexRow(call, 2)).toMatchObject({ role: 'tool', tool: 'exec_command', text: 'ls -la' })
  })
})

describe('parseClaudeRow', () => {
  it('prefers the assistant text over the thinking block in the same row', () => {
    const row = {
      type: 'assistant',
      timestamp: '2026-09-14T09:43:21.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me look' },
          { type: 'text', text: 'Done.' }
        ]
      }
    }
    expect(parseClaudeRow(row, 0)).toMatchObject({ role: 'assistant', text: 'Done.' })
  })

  it('marks sub-agent traffic so the view can dim it', () => {
    const row = {
      type: 'assistant',
      isSidechain: true,
      timestamp: '2026-09-14T09:43:22.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] }
    }
    expect(parseClaudeRow(row, 0)).toMatchObject({ sidechain: true })
  })

  it('drops the user row that only carries a tool result', () => {
    const row = {
      type: 'user',
      timestamp: '2026-09-14T09:43:23.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }] }
    }
    expect(parseClaudeRow(row, 0)).toBeNull()
  })
})

describe('normalizeMessages', () => {
  it('pairs a tool output with its call, and keeps an orphan output visible', () => {
    const rows = [
      { timestamp: '2026-09-14T09:43:21.000Z', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{"cmd":"ls"}' } },
      { timestamp: '2026-09-14T09:43:22.000Z', payload: { type: 'function_call_output', call_id: 'c1', output: 'a.txt' } },
      { timestamp: '2026-09-14T09:43:23.000Z', payload: { type: 'function_call_output', call_id: 'nope', output: 'orphan' } }
    ]
    const { messages } = normalizeMessages({ agent: 'codex', rows })
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'tool', tool: 'shell', output: 'a.txt' })
    expect(messages[1]).toMatchObject({ role: 'tool', tool: 'output', output: 'orphan' })
  })

  it('marks a message truncated when it was cut to the cap', () => {
    const rows = [
      {
        timestamp: '2026-09-14T09:43:21.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(5000) }] }
      }
    ]
    const [message] = normalizeMessages({ agent: 'codex', rows }).messages
    expect(message.truncated).toBe(true)
    expect(message.text.length).toBeLessThan(5000)
  })
})

describe('splitBlocks', () => {
  it('splits a fence that opens mid-message, not only at offset zero', () => {
    // The regression this pins: the opening-fence regex lacked the `m` flag, so
    // `^` matched only at the very start of the text and every fence an agent
    // wrote after a lead-in sentence rendered as raw white prose.
    const text = 'Design for the parity harness:\n\n```ts\ninterface Solved {\n  readonly what: string;\n}\n```\nNow write the file.'
    const blocks = splitBlocks(text)
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toMatchObject({ kind: 'text' })
    expect(blocks[1]).toMatchObject({ kind: 'code', lang: 'ts', text: 'interface Solved {\n  readonly what: string;\n}' })
    expect(blocks[2]).toMatchObject({ kind: 'text', text: 'Now write the file.' })
  })

  it('splits a fence at the very start of the message', () => {
    const blocks = splitBlocks('```sh\nnpm test\n```\ndone')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ kind: 'code', lang: 'sh', text: 'npm test' })
    expect(blocks[1]).toMatchObject({ kind: 'text', text: 'done' })
  })

  it('splits several fences in one message, in order', () => {
    const text = 'a\n```ts\nconst a = 1\n```\nb\n```diff\n-x\n+y\n```\nc'
    const blocks = splitBlocks(text)
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'code', 'text', 'code', 'text'])
    expect(blocks[1].lang).toBe('ts')
    expect(blocks[3].lang).toBe('diff')
    expect(blocks.map((b) => b.text).join('|')).toBe('a|const a = 1|b|-x\n+y|c')
  })

  it('keeps an unterminated fence as code - the agent is still streaming', () => {
    const blocks = splitBlocks('intro\n```python\nprint(1)')
    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toMatchObject({ kind: 'code', lang: 'python', text: 'print(1)' })
  })

  it('honours the ~~~ marker and a fence with no info string', () => {
    const blocks = splitBlocks('~~~\nplain dump\n~~~')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'code', text: 'plain dump', lang: undefined })
  })

  it('does not treat a fence marker inside a line as an opening fence', () => {
    const blocks = splitBlocks('the ``` marker is inline here\nand this is prose')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'text' })
  })
})
