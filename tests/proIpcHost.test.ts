/**
 * The host-op parser.
 *
 * Small file, small surface, and the only place in Pro where a parsed value
 * ends up in `shell.openExternal`. The URL does not come from us: it comes out
 * of a terminal pane, which means it was printed by whatever an agent decided
 * to print. So the interesting assertions here are the rejections, and the
 * reason the allow-list is three schemes long rather than "anything with a
 * colon".
 */
import { describe, expect, it } from 'vitest'
import { isProReject, parseProHost, type ProHostRequest } from '../src/shared/proIpc'

/** Narrow a parse to a request, failing the test if it was rejected. */
function parsed(payload: unknown): ProHostRequest {
  const result = parseProHost(payload)
  if (isProReject(result)) {
    throw new Error(`expected a request, got ${result.code}: ${result.error}`)
  }
  return result
}

/** The rejection side of a parse, as a code/message pair. */
function refused(payload: unknown): { code: string; error: string } {
  const result = parseProHost(payload)
  if (!isProReject(result)) throw new Error(`expected a rejection, got ${JSON.stringify(result)}`)
  return { code: result.code, error: result.error }
}

/** The url a parsed openExternal carries, without repeating the cast. */
function urlOf(payload: unknown): string {
  const request = parsed(payload)
  if (request.op !== 'openExternal') throw new Error(`expected openExternal, got ${request.op}`)
  return request.url
}

describe('the ops that take no arguments', () => {
  it.each(['discovery', 'agents', 'threads', 'pickDir'])('accepts %s', (op) => {
    expect(parsed({ op })).toEqual({ op })
  })

  const empties: unknown[] = [{}, null, undefined, 'nonsense', 42, []]

  it.each(empties)('reads %j as discovery, since asking is the default', (payload) => {
    expect(parsed(payload)).toEqual({ op: 'discovery' })
  })

  it('trims and folds the op, because it arrives in JSON we did not write', () => {
    expect(parsed({ op: '  AGENTS ' })).toEqual({ op: 'agents' })
  })

  it('names the op it refused', () => {
    const bad = refused({ op: 'rmEverything' })
    expect(bad.code).toBe('bad-op')
    expect(bad.error).toContain('rmEverything')
  })
})

describe('openPath', () => {
  it('trims the path it hands to the opener', () => {
    expect(parsed({ op: 'openPath', path: '  /tmp/x  ' })).toEqual({
      op: 'openPath',
      path: '/tmp/x'
    })
  })

  const missing: unknown[] = [
    { op: 'openPath' },
    { op: 'openPath', path: '   ' },
    { op: 'openPath', path: 7 }
  ]

  it.each(missing)('refuses %j rather than opening the cwd', (payload) => {
    // An empty path is not a no-op for every opener, and "open whichever
    // directory this process happens to be in" is a confusing thing to do in
    // response to a click.
    expect(refused(payload).code).toBe('bad-payload')
  })
})

describe('openExternal', () => {
  const allowed: string[] = [
    'https://example.com/a?b=1#c',
    'http://127.0.0.1:5173/',
    'mailto:someone@example.com',
    'HTTPS://Example.COM/Path',
    '  https://example.com  '
  ]

  it.each(allowed)('opens %j', (url) => {
    expect(urlOf({ op: 'openExternal', url })).toBe(url.trim())
  })

  const refusedUrls: string[] = [
    // Reads local state through whatever is registered for the scheme.
    'file:///etc/passwd',
    // Executes in whatever opened it.
    'javascript:alert(1)',
    // Launches whichever app claimed the vendor scheme.
    'vscode://file/etc/passwd',
    'data:text/html;base64,PHNjcmlwdD4=',
    'ftp://host/x',
    'smb://share/x',
    // No scheme at all: an opener is free to guess, and guessing is the risk.
    'example.com/no-scheme',
    '//example.com',
    '',
    '   '
  ]

  it.each(refusedUrls)('refuses %j', (url) => {
    expect(refused({ op: 'openExternal', url }).code).toBe('bad-payload')
  })

  it('refuses a url that is not a string', () => {
    expect(refused({ op: 'openExternal', url: 12345 }).code).toBe('bad-payload')
  })

  it('says the argument was wrong, not the op, because the op is allowed', () => {
    // A UI branches on this to choose between "that link is not openable" and
    // "this build does not know that verb", and the two read very differently.
    expect(refused({ op: 'openExternal', url: 'file:///x' }).code).toBe('bad-payload')
  })

  it('clips a runaway url and validates what survives the clip', () => {
    expect(urlOf({ op: 'openExternal', url: `https://${'a'.repeat(4000)}` })).toHaveLength(2000)
    // The clip runs before the scheme check, so length cannot be used to move
    // the part a prefix-anchored regex looks at.
    expect(refused({ op: 'openExternal', url: `x${'a'.repeat(4000)}` }).code).toBe('bad-payload')
  })
})

describe('isProReject', () => {
  it('separates a rejection from a request', () => {
    expect(isProReject(parseProHost({ op: 'nope' }))).toBe(true)
    expect(isProReject(parseProHost({ op: 'agents' }))).toBe(false)
  })

  const notRejections: unknown[] = [null, undefined, 0, '', [], {}, { ok: true }, { ok: 'false' }]

  it.each(notRejections)('is false for %j', (value) => {
    expect(isProReject(value)).toBe(false)
  })
})
