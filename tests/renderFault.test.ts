import { describe, expect, it } from 'vitest'
import {
  FAULT_FRAME_MAX,
  FAULT_MESSAGE_MAX,
  FAULT_STACK_LINES,
  describeFault,
  formatFault
} from '../src/shared/renderFault'

/** A V8 shaped stack: `Name: message`, then indented `at ` frames. */
function v8Stack(header: string, frames: string[]): string {
  return [header, ...frames.map((frame) => `    at ${frame}`)].join('\n')
}

function frameList(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `Frame${index} (file:///app/out/renderer.js:${index}:1)`
  )
}

/** Values that are legal to throw and are not Errors. */
const NOT_ERRORS: ReadonlyArray<readonly [unknown, string]> = [
  [null, 'null'],
  [undefined, 'undefined'],
  [42, 'number'],
  [true, 'boolean'],
  [{}, 'object'],
  [[1, 2], 'array']
]

describe('describeFault', () => {
  it('keeps the error own name and message', () => {
    const fault = describeFault(new TypeError('cannot read paneId of undefined'))
    expect(fault.kind).toBe('TypeError')
    expect(fault.message).toBe('cannot read paneId of undefined')
  })

  it('flattens a multi-line message into the one line the card has', () => {
    // An assertion diff or a CLI error thrown verbatim arrives with newlines and
    // runs of spaces; unflattened it would wrap the card and blur the boundary
    // between message and frames in the copied payload.
    const fault = describeFault(new Error('expected:\n  4\nactual:\t5'))
    expect(fault.message).toBe('expected: 4 actual: 5')
  })

  it('caps a runaway message and says so in ASCII', () => {
    const fault = describeFault(new Error('x'.repeat(FAULT_MESSAGE_MAX * 3)))
    expect(fault.message).toHaveLength(FAULT_MESSAGE_MAX + 3)
    expect(fault.message.endsWith('...')).toBe(true)
  })

  it('drops the stack header line and keeps only real frames', () => {
    const error = new Error('boom')
    error.stack = v8Stack('Error: boom', frameList(FAULT_STACK_LINES + 3))
    const fault = describeFault(error)
    expect(fault.stack).toHaveLength(FAULT_STACK_LINES)
    expect(fault.stack[0]).toBe(`at ${frameList(1)[0]}`)
    expect(fault.stack.some((frame) => frame.includes('Error: boom'))).toBe(false)
  })

  it('caps a single frame, which in a bundle is a data URL', () => {
    const error = new Error('boom')
    error.stack = v8Stack('Error: boom', [
      `Module.foo (data:text/javascript;base64,${'A'.repeat(4000)})`
    ])
    const fault = describeFault(error)
    expect(fault.stack).toHaveLength(1)
    expect(fault.stack[0]).toHaveLength(FAULT_FRAME_MAX + 3)
  })

  it('reports no frames rather than guessing on a non-V8 stack', () => {
    const error = new Error('boom')
    error.stack = 'foo@file:///app/out/renderer.js:12:3\nbar@file:///app/out/renderer.js:40:1'
    expect(describeFault(error).stack).toEqual([])
  })

  it('survives a missing stack', () => {
    const error = new Error('boom')
    error.stack = undefined
    expect(describeFault(error).stack).toEqual([])
  })

  it('treats a thrown string as its own message', () => {
    expect(describeFault('no herdr socket')).toEqual({
      kind: 'string',
      message: 'no herdr socket',
      stack: []
    })
  })

  it.each(NOT_ERRORS)('names a thrown %s by its type', (value, kind) => {
    const fault = describeFault(value)
    expect(fault.kind).toBe(kind)
    expect(fault.message).toBe('')
    expect(fault.stack).toEqual([])
  })

  it('falls back to Error when the name is not an identifier', () => {
    const error = new Error('boom')
    error.name = 'not an identifier!'
    expect(describeFault(error).kind).toBe('Error')
  })

  it('takes the name from a duck-typed error across a realm boundary', () => {
    // `instanceof Error` is false for an error built in another vm context, which
    // is what a preload or a worker hands back; the name is still the useful part.
    expect(describeFault({ name: 'RangeError', message: 'out of range' }).kind).toBe('RangeError')
  })

  it('does not throw on a value whose getters throw', () => {
    // There is no boundary behind the boundary: a throw here is the blank frame
    // this module exists to prevent.
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('nope')
        }
      }
    )
    expect(() => describeFault(hostile)).not.toThrow()
    expect(describeFault(hostile)).toEqual({ kind: 'object', message: '', stack: [] })
  })

  it('does not serialise a circular value', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => describeFault(circular)).not.toThrow()
    expect(describeFault(circular).message).toBe('')
  })
})

describe('formatFault', () => {
  it('prints the head line and indents the frames', () => {
    const text = formatFault(
      { kind: 'TypeError', message: 'boom', stack: ['at Foo (a.js:1:1)', 'at Bar (b.js:2:2)'] },
      'unknown'
    )
    expect(text).toBe('TypeError: boom\n  at Foo (a.js:1:1)\n  at Bar (b.js:2:2)')
  })

  it('says something when the error had no message', () => {
    const text = formatFault({ kind: 'object', message: '', stack: [] }, 'an error with no message')
    expect(text).toBe('object: an error with no message')
  })
})
