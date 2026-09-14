import { describe, expect, it } from 'vitest'
import {
  bindFailureHint,
  classifyBindError,
  describeAttempts,
  hasFallback,
  isAutomaticPort,
  isValidPort,
  normalizeRequestedPort,
  portAttempts
} from '../src/shared/portPolicy'

describe('normalizeRequestedPort', () => {
  it('accepts an unprivileged TCP port as typed', () => {
    expect(normalizeRequestedPort(4321)).toBe(4321)
    expect(normalizeRequestedPort('4321')).toBe(4321)
    expect(normalizeRequestedPort(1024)).toBe(1024)
    expect(normalizeRequestedPort(65535)).toBe(65535)
  })

  it('collapses junk to automatic instead of clamping into a port we cannot own', () => {
    for (const bad of [0, '', 'auto', 'AUTO', null, undefined, NaN, Infinity, -1, 80, 1023, 70000, 1.5, '12abc', {}, []]) {
      expect(normalizeRequestedPort(bad), String(bad)).toBe(0)
    }
  })

  it('agrees with the predicates', () => {
    expect(isValidPort(4321)).toBe(true)
    expect(isValidPort(80)).toBe(false)
    expect(isValidPort('4321')).toBe(false)
    expect(isAutomaticPort(0)).toBe(true)
    expect(isAutomaticPort('')).toBe(true)
    expect(isAutomaticPort(4321)).toBe(false)
  })
})

describe('portAttempts', () => {
  it('always ends with a kernel-chosen port, so binding cannot fail on a busy machine', () => {
    for (const pref of [{}, { pinned: 4321 }, { sticky: 4321 }, { pinned: 4321, sticky: 4322 }]) {
      const attempts = portAttempts(pref)
      expect(attempts[attempts.length - 1]).toEqual({ port: 0, reason: 'os-assigned' })
    }
  })

  it('tries the pinned port first and remembers the reason', () => {
    expect(portAttempts({ pinned: 4321, sticky: 5555 })).toEqual([
      { port: 4321, reason: 'pinned' },
      { port: 5555, reason: 'sticky' },
      { port: 0, reason: 'os-assigned' }
    ])
  })

  it('never lists the same port twice', () => {
    const attempts = portAttempts({ pinned: 4321, sticky: 4321 })
    expect(attempts).toEqual([
      { port: 4321, reason: 'pinned' },
      { port: 0, reason: 'os-assigned' }
    ])
  })

  it('drops an unusable preference rather than scheduling a doomed bind', () => {
    expect(portAttempts({ pinned: 80, sticky: -5 })).toEqual([{ port: 0, reason: 'os-assigned' }])
  })

  it('reports whether a failed attempt still has a fallback', () => {
    const attempts = portAttempts({ pinned: 4321 })
    expect(hasFallback(attempts, 0)).toBe(true)
    expect(hasFallback(attempts, attempts.length - 1)).toBe(false)
    expect(hasFallback(attempts, -1)).toBe(false)
  })

  it('describes the ladder for logs', () => {
    expect(describeAttempts(portAttempts({ pinned: 4321 }))).toBe('4321 -> kernel-chosen')
  })
})

describe('classifyBindError', () => {
  const cases: Array<[string, string]> = [
    ['EADDRINUSE', 'in-use'],
    ['EACCES', 'forbidden'],
    ['EPERM', 'forbidden'],
    ['EADDRNOTAVAIL', 'unavailable'],
    ['EAFNOSUPPORT', 'unavailable'],
    ['EWOULDBLOCK', 'unknown']
  ]

  it.each(cases)('maps %s to %s', (code, kind) => {
    expect(classifyBindError(Object.assign(new Error('boom'), { code }))).toBe(kind)
  })

  it('survives values that are not errors at all', () => {
    expect(classifyBindError(null)).toBe('unknown')
    expect(classifyBindError('EADDRINUSE')).toBe('unknown')
    expect(classifyBindError({ code: 42 })).toBe('unknown')
  })
})

describe('bindFailureHint', () => {
  it('names the port and says the relay moved on', () => {
    const hint = bindFailureHint('in-use', 4321, 'darwin')
    expect(hint).toContain('4321')
    expect(hint).toContain('moved to a free port')
  })

  it('explains the Windows reserved-range case, which looks free but is not', () => {
    const win = bindFailureHint('forbidden', 5000, 'win32')
    const posix = bindFailureHint('forbidden', 5000, 'darwin')
    expect(win).toContain('Windows')
    expect(posix).not.toContain('Windows')
  })

  it('falls back to a generic line for an unknown code', () => {
    expect(bindFailureHint('unknown', 0, 'linux')).toContain('could not be bound')
  })
})
