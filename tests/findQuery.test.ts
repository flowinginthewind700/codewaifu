import { describe, expect, it } from 'vitest'
import { planFind, type FindOptions } from '../src/shared/findQuery'

const off: FindOptions = { regex: false, caseSensitive: false }
const regex = (caseSensitive = false): FindOptions => ({ regex: true, caseSensitive })

/** The half-typed patterns that used to reach `new RegExp` inside the addon. */
const BROKEN = ['(', 'err(or', '[a-', '*', 'x{2,1}', '\\', '(?<', 'a{1,0}', '[z-a]', '((((']

const messageOf = (term: string): string => {
  const plan = planFind(term, regex())
  if (plan.kind !== 'bad-pattern') throw new Error(`expected a refused pattern for ${term}`)
  return plan.message
}

describe('planFind', () => {
  it('has nothing to do with an empty term, whatever the toggles say', () => {
    // The bar opens empty. Planning a search there would either clear the
    // decorations of a find that just happened or, with regex on, compile `/(?:)/`
    // and report a match at every cell in the scrollback.
    expect(planFind('', off).kind).toBe('empty')
    expect(planFind('', regex(true)).kind).toBe('empty')
  })

  it('passes a literal term through untouched, metacharacters included', () => {
    for (const term of ['a+b', 'foo(bar', '[warn]', 'x{2,1}', '\\d', 'err(or']) {
      const plan = planFind(term, off)
      expect(plan.kind).toBe('search')
      if (plan.kind !== 'search') continue
      expect(plan.term).toBe(term)
      expect(plan.options.regex).toBe(false)
    }
  })

  it('keeps case sensitivity as the bar set it', () => {
    const plan = planFind('Error', regex(true))
    expect(plan).toEqual({ kind: 'search', term: 'Error', options: regex(true) })
  })

  it('reports an uncompilable pattern instead of throwing', () => {
    // These are the patterns the addon would hand straight to `new RegExp`, so
    // every one of them is a half-typed keystroke away from an uncaught throw
    // inside the debounce timer.
    for (const term of BROKEN) {
      const plan = planFind(term, regex())
      expect(plan.kind).toBe('bad-pattern')
      if (plan.kind !== 'bad-pattern') continue
      expect(plan.message.length).toBeGreaterThan(0)
      expect(plan.message.length).toBeLessThanOrEqual(161)
    }
  })

  it('shows the reason, not an echo of the pattern', () => {
    // The counter has a fixed floor and a cap; the pattern itself is still on
    // screen in the input, so the echo is the part that has to go and the reason
    // is the part that has to fit.
    expect(messageOf('(')).toBe('Unterminated group')
    expect(messageOf('[a-')).toBe('Unterminated character class')
    expect(messageOf('x{2,1}')).toBe('numbers out of order in {} quantifier')
    expect(messageOf('\\')).toBe('\\ at end of pattern')
    // A 200-character pattern echoes 200 characters back under V8's default
    // message. Stripping the echo is what keeps that inside the cap.
    expect(messageOf('('.repeat(200))).toBe('Unterminated group')
  })

  it('refuses a pattern that matches the empty string', () => {
    // Arithmetically right and useless: `a*` matches at every cell boundary, so
    // the counter would read five figures and the highlight would cover the pane.
    for (const term of ['a*', '(?:)', '^', '$', '\\d*', '(x)?']) {
      expect(planFind(term, regex()).kind).toBe('empty-match')
    }
  })

  it('accepts the patterns an agent log is actually searched with', () => {
    for (const term of ['error|fail', '\\bTODO\\b', 'FAIL(ED|URE)', 'panic:.+', '\\u4e2d\\u6587']) {
      const plan = planFind(term, regex())
      expect(plan.kind, term).toBe('search')
    }
  })

  it('validates against the flags the addon compiles with', () => {
    // `i` is what makes the case-insensitive pass legal; a planner that compiled
    // with `u` would reject `\d`-free patterns the addon accepts, and the bar
    // would call a working pattern broken.
    expect(planFind('FAIL', regex(false)).kind).toBe('search')
    expect(planFind('FAIL', regex(true)).kind).toBe('search')
  })
})
