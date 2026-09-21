// @vitest-environment jsdom
/**
 * The code an agent prints, coloured.
 *
 * Three things can only go wrong in ways a unit test catches cheaply:
 *
 * 1. Text loss. The coloured spans must concatenate back to exactly the source.
 *    A grammar that eats a character - or a walker that drops a text node - is
 *    invisible in a screenshot and obvious when the human copies the block.
 * 2. Colours where there should be none. A fence with no info string, a grammar
 *    we do not ship, a plaintext dump and an enormous block all have to render
 *    as a single unstyled string node, because a wrong grammar is worse than no
 *    grammar and a 200KB dump is not worth 100ms of the main thread.
 * 3. Re-tokenizing on every render. The widget polls and the bench repaints, so
 *    the same block is asked for constantly; the cache is what keeps that from
 *    being a visible stutter while an agent streams.
 */
import { describe, expect, it } from 'vitest'
import {
  clearCodeCache,
  codeSpans,
  commandSpans,
  MAX_HIGHLIGHT_CHARS,
  outputSpans
} from '../src/renderer/src/highlight'

/** Concatenate a ReactNode tree the way the DOM would, ignoring span nesting. */
function textOf(nodes: unknown): string {
  if (typeof nodes === 'string' || typeof nodes === 'number') return String(nodes)
  if (Array.isArray(nodes)) return nodes.map(textOf).join('')
  const element = nodes as { props?: { children?: unknown } }
  if (element?.props && 'children' in element.props) return textOf(element.props.children)
  return ''
}

/** Every className in the tree, flattened - what the theme will actually see. */
function classesOf(nodes: unknown, acc: string[] = []): string[] {
  if (!nodes || typeof nodes === 'string' || typeof nodes === 'number') return acc
  const list = Array.isArray(nodes) ? nodes : [nodes]
  for (const node of list) {
    const element = node as { props?: { className?: string; children?: unknown } }
    if (element?.props?.className) acc.push(element.props.className)
    if (element?.props && 'children' in element.props) classesOf(element.props.children, acc)
  }
  return acc
}

const TS_SOURCE = [
  'import { useState } from "react"',
  '',
  '// a comment',
  'export function Row({ id }: { id: string }) {',
  '  const [open, setOpen] = useState(false)',
  '  return <div onClick={() => setOpen(!open)}>{id}</div>',
  '}'
].join('\n')

describe('codeSpans', () => {
  it('colours TypeScript and keeps every character', () => {
    clearCodeCache()
    const spans = codeSpans('tsx', TS_SOURCE)
    expect(textOf(spans)).toBe(TS_SOURCE)
    const classes = classesOf(spans)
    expect(classes.some((c) => c.includes('hljs-keyword'))).toBe(true)
    expect(classes.some((c) => c.includes('hljs-string'))).toBe(true)
    expect(classes.some((c) => c.includes('hljs-comment'))).toBe(true)
  })

  it('colours a diff, and marks the added and removed lines', () => {
    clearCodeCache()
    const patch = ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-const a = 1', '+const a = 2'].join('\n')
    const spans = codeSpans('diff', patch)
    expect(textOf(spans)).toBe(patch)
    const classes = classesOf(spans).join(' ')
    expect(classes).toContain('hljs-deletion')
    expect(classes).toContain('hljs-addition')
  })

  it('keeps an unterminated fence intact - the agent is still streaming', () => {
    clearCodeCache()
    // splitBlocks() hands over the half-received body; the colours must not
    // swallow the tail just because the grammar never saw a closing brace.
    const partial = 'export function f() {\n  const a = 1'
    const spans = codeSpans('ts', partial)
    expect(textOf(spans)).toBe(partial)
  })

  it('renders plain text when the fence carries no language', () => {
    clearCodeCache()
    const source = 'some text\nthat is not obviously code'
    const spans = codeSpans(undefined, source)
    expect(spans).toEqual([source])
  })

  it('renders plain text for a grammar we do not ship', () => {
    clearCodeCache()
    const source = 'MODULE Foo := 1'
    expect(codeSpans('tlaplus', source)).toEqual([source])
  })

  it('does not tokenize a plaintext fence', () => {
    clearCodeCache()
    const source = '2026-09-20 12:00:01 INFO started\n2026-09-20 12:00:02 WARN slow'
    expect(codeSpans('log', source)).toEqual([source])
    expect(codeSpans('text', source)).toEqual([source])
  })

  it('gives up on a block too large to be worth the main thread', () => {
    clearCodeCache()
    const source = 'const a = 1\n'.repeat(Math.ceil(MAX_HIGHLIGHT_CHARS / 12) + 10)
    expect(source.length).toBeGreaterThan(MAX_HIGHLIGHT_CHARS)
    const spans = codeSpans('javascript', source)
    expect(spans).toEqual([source])
  })

  it('returns the identical node list for the same block twice (cache hit)', () => {
    clearCodeCache()
    const first = codeSpans('python', 'def f(x):\n    return x + 1')
    const second = codeSpans('python', 'def f(x):\n    return x + 1')
    expect(second).toBe(first)
  })

  it('re-tokenizes when the source changes, which is what a stream does', () => {
    clearCodeCache()
    const first = codeSpans('python', 'def f(x):')
    const second = codeSpans('python', 'def f(x):\n    return x')
    expect(second).not.toBe(first)
    expect(textOf(second)).toBe('def f(x):\n    return x')
  })

  it('keeps an empty block empty instead of throwing', () => {
    clearCodeCache()
    expect(textOf(codeSpans('json', ''))).toBe('')
  })

  it('treats a null-ish source as empty rather than throwing', () => {
    clearCodeCache()
    // A highlighted empty block has no children, so the tree is empty rather
    // than one empty string node; what matters is that it renders no text and
    // does not throw on the way there.
    expect(textOf(codeSpans('json', undefined as unknown as string))).toBe('')
  })
})

/**
 * The wrapper this app's own harness prints around a command's stdout, exactly
 * as it reaches the renderer. `Chunk ID: 4ae44c` and `Process exited with code
 * 0` are not TypeScript, and the tests below pin that they stay uncoloured.
 */
const HARNESS_HEAD = [
  'Chunk ID: 4ae44c',
  'Wall time: 0.0123 seconds',
  'Process exited with code 0',
  'Original token count: 96',
  'Output:'
].join('\n')

const TS_FILE = 'import { x } from "./y"\n\nexport const n: number = 1\n'

describe('outputSpans', () => {
  it('colours the file a reader printed and keeps every character', () => {
    clearCodeCache()
    const raw = `${HARNESS_HEAD}\n${TS_FILE}`
    const spans = outputSpans({ tool: 'exec_command', command: 'cat src/app.ts', output: raw })
    expect(textOf(spans)).toBe(raw)
    expect(classesOf(spans).some((c) => c.includes('hljs-keyword'))).toBe(true)
    expect(classesOf(spans).some((c) => c.includes('hljs-string'))).toBe(true)
  })

  it('leaves the harness wrapper plain - it is not the agent\'s output', () => {
    clearCodeCache()
    const raw = `${HARNESS_HEAD}\n${TS_FILE}`
    const spans = outputSpans({ tool: 'exec_command', command: 'cat src/app.ts', output: raw })
    // The wrapper is handed over as one bare string node, so the theme cannot
    // paint `Chunk ID:` as a type or the exit code as a number.
    expect(spans[0]).toBe(`${HARNESS_HEAD}\n`)
    expect(classesOf(spans[0])).toEqual([])
    expect(classesOf(spans.slice(1)).some((c) => c.includes('hljs-'))).toBe(true)
  })

  it('colours a command with no wrapper, because nothing was stripped', () => {
    clearCodeCache()
    const raw = 'export const a = 1\n'
    const spans = outputSpans({ tool: 'local_shell_call', command: 'head -20 src/a.ts', output: raw })
    expect(textOf(spans)).toBe(raw)
    expect(classesOf(spans).some((c) => c.includes('hljs-keyword'))).toBe(true)
  })

  it('colours a JSON body on the strength of the parser alone', () => {
    clearCodeCache()
    const raw = `${HARNESS_HEAD}\n{"ok":true,"n":2}\n`
    // No command at all: a `tool_output` row whose bytes parse as JSON.
    const spans = outputSpans({ output: raw })
    expect(textOf(spans)).toBe(raw)
    expect(classesOf(spans).some((c) => c.includes('hljs-attr'))).toBe(true)
  })

  it('renders plain when nothing vouches for the bytes', () => {
    clearCodeCache()
    const raw = `${HARNESS_HEAD}\n2026-09-20 12:00:01 INFO started\nok\n`
    const spans = outputSpans({ tool: 'exec_command', command: 'npm test', output: raw })
    expect(spans).toEqual([raw])
  })

  it('renders plain when the command rewrites what it prints', () => {
    clearCodeCache()
    // `nl` line numbers are *shaped* like source without being it; painting
    // them would be a confident wrong answer.
    const raw = '     1\timport { x } from "./y"\n'
    const spans = outputSpans({ tool: 'exec_command', command: 'nl -ba src/app.ts', output: raw })
    expect(spans).toEqual([raw])
  })

  it('renders plain when a non-shell tool prints a path', () => {
    clearCodeCache()
    const raw = 'Patch applied successfully.'
    const spans = outputSpans({ tool: 'apply_patch', command: '', output: raw })
    expect(spans).toEqual([raw])
  })

  it('gives up on an output too large to be worth the main thread', () => {
    clearCodeCache()
    const raw = 'const a = 1\n'.repeat(Math.ceil(MAX_HIGHLIGHT_CHARS / 12) + 10)
    const spans = outputSpans({ tool: 'exec_command', command: 'cat big.ts', output: raw })
    expect(spans).toEqual([raw])
  })

  it('keeps an empty output empty instead of rendering a stray newline', () => {
    clearCodeCache()
    expect(outputSpans({ tool: 'exec_command', command: 'cat a.ts', output: '' })).toEqual([])
  })

  it('treats null-ish fields as an empty output rather than throwing', () => {
    clearCodeCache()
    expect(outputSpans({})).toEqual([])
    expect(textOf(outputSpans({ tool: null, command: null, output: null }))).toBe('')
  })

  it('returns the identical node list for the same row twice (cache hit)', () => {
    clearCodeCache()
    const row = { tool: 'exec_command', command: 'cat src/app.ts', output: `${HARNESS_HEAD}\n${TS_FILE}` }
    const first = outputSpans(row)
    const second = outputSpans(row)
    // `outputSpans()` rebuilds its own array each call, but the coloured body
    // comes out of the cache, so the nodes it holds are the same objects: the
    // body is not re-tokenized on every poll tick of the widget.
    expect(second.length).toBe(first.length)
    expect(second[1]).toBe(first[1])
  })
})

describe('commandSpans', () => {
  it('colours a shell command line and keeps every character', () => {
    clearCodeCache()
    const line = 'cd /srv/app && grep -rn "TODO" src | head -20'
    const spans = commandSpans(line)
    expect(textOf(spans)).toBe(line)
    // A string node would mean "no colour at all"; a real command line has to
    // tokenize into at least one scoped span.
    expect(classesOf(spans).length).toBeGreaterThan(0)
  })

  it('survives the 120-character clip with a trailing ellipsis', () => {
    clearCodeCache()
    const line = `sed -n '1,40p' ${'very/long/'.repeat(12)}src/app.ts…`
    const spans = commandSpans(line)
    expect(textOf(spans)).toBe(line)
  })

  it('returns nothing for an empty or missing command', () => {
    clearCodeCache()
    expect(commandSpans('')).toEqual([])
    expect(commandSpans(null)).toEqual([])
    expect(commandSpans(undefined)).toEqual([])
  })

  it('returns the identical node list for the same line twice (cache hit)', () => {
    clearCodeCache()
    const line = 'git log --oneline -5'
    const first = commandSpans(line)
    const second = commandSpans(line)
    expect(second).toBe(first)
  })
})
