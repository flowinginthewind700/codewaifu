/**
 * NDJSON framing for herdr's three streams (acceptance §6.6).
 *
 * One decoder serves the API reply, the event subscription and the terminal
 * bridge. They fail identically - a JSON parse error on a line that a read
 * boundary cut in half - and only one of them fails at 60 frames a second, so
 * the framing gets pinned on its own before anything builds on it.
 */
import { describe, expect, it } from 'vitest'
import { LineDecoder, encodeRequest, nextRequestId } from '../src/main/pro/herdr/ndjson'

describe('LineDecoder', () => {
  it('keeps a partial tail instead of parsing half a line', () => {
    const decoder = new LineDecoder()
    expect(decoder.push('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
    expect(decoder.pending).toBe('{"b"'.length)
    // The rest of the line arrives in a later read and still parses whole.
    expect(decoder.push(':2}\n')).toEqual(['{"b":2}'])
    expect(decoder.pending).toBe(0)
  })

  it('splits one chunk into several lines, in order', () => {
    const decoder = new LineDecoder()
    expect(decoder.push('one\ntwo\nthree\n')).toEqual(['one', 'two', 'three'])
  })

  it('rebuilds a frame whose base64 body straddles a read boundary', () => {
    const decoder = new LineDecoder()
    const line = JSON.stringify({ type: 'terminal.frame', seq: 7, bytes: 'A'.repeat(200) })
    const cut = 40
    expect(decoder.push(`${line.slice(0, cut)}`)).toEqual([])
    expect(decoder.push(`${line.slice(cut)}\n`)).toEqual([line])
    // Nothing is left over: the frame arrived complete, just in two pieces.
    expect(decoder.pending).toBe(0)
    expect(decoder.end()).toEqual([])
  })

  it('strips CRLF, because a Windows herdr speaks the same protocol', () => {
    const decoder = new LineDecoder()
    expect(decoder.push('{"a":1}\r\n{"b":2}\r\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('ignores blank lines and whitespace-only lines', () => {
    const decoder = new LineDecoder()
    expect(decoder.push('\n\n   \n{"a":1}\n')).toEqual(['{"a":1}'])
    expect(decoder.push('')).toEqual([])
  })

  it('flushes a trailing line at EOF, which is how a crash mid-write reads', () => {
    const decoder = new LineDecoder()
    decoder.push('{"a":1}\n{"tail":true}')
    expect(decoder.end()).toEqual(['{"tail":true}'])
    // A second end() must not replay the line: the caller appends what it gets.
    expect(decoder.end()).toEqual([])
  })

  it('flushes nothing when the stream ended on a newline', () => {
    const decoder = new LineDecoder()
    decoder.push('{"a":1}\n')
    expect(decoder.end()).toEqual([])
    expect(decoder.end()).toEqual([])
  })

  it('drops a runaway tail so one broken peer cannot eat the process', () => {
    const decoder = new LineDecoder(64)
    expect(decoder.push('x'.repeat(200))).toEqual([])
    expect(decoder.pending).toBe(0)
    // The next *complete* line still parses: the guard drops the junk, not the
    // stream. A decoder that wedged here would black out every pane at once.
    expect(decoder.push('{"ok":true}\n')).toEqual(['{"ok":true}'])
  })

  it('keeps a long frame that fits the limit', () => {
    const decoder = new LineDecoder(8 * 1024)
    const big = JSON.stringify({ bytes: 'A'.repeat(4000) })
    expect(decoder.push(`${big}\n`)).toEqual([big])
  })
})

describe('nextRequestId', () => {
  it('is unique per call and carries the prefix and the pid', () => {
    const seen = new Set<string>()
    for (let index = 0; index < 500; index += 1) seen.add(nextRequestId('session.snapshot'))
    expect(seen.size).toBe(500)
    const id = nextRequestId('ping')
    expect(id.startsWith('ping:')).toBe(true)
    expect(id).toContain(process.pid.toString(36))
  })

  it('defaults the prefix so a caller cannot mint an id-less request', () => {
    expect(nextRequestId().startsWith('cw:')).toBe(true)
  })
})

describe('encodeRequest', () => {
  it('writes exactly one newline-terminated JSON object', () => {
    const line = encodeRequest('cw:1', 'session.snapshot', { workspace_id: 'wA' })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(line)).toEqual({
      id: 'cw:1',
      method: 'session.snapshot',
      params: { workspace_id: 'wA' }
    })
  })

  it('sends an empty params object rather than null: herdr rejects a missing one', () => {
    expect(JSON.parse(encodeRequest('cw:2', 'ping'))).toEqual({ id: 'cw:2', method: 'ping', params: {} })
    expect(JSON.parse(encodeRequest('cw:3', 'ping', null))).toEqual({
      id: 'cw:3',
      method: 'ping',
      params: {}
    })
    expect(JSON.parse(encodeRequest('cw:4', 'ping', undefined)).params).toEqual({})
  })
})
