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
import { clearCodeCache, codeSpans, MAX_HIGHLIGHT_CHARS } from '../src/renderer/src/highlight'

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
