/**
 * Fence info string -> grammar name.
 *
 * The failure this guards is a colour that is confidently wrong: a grammar
 * picked for a fence it does not actually match paints prose as if it were
 * code, which is worse than leaving it plain. So the cases that matter most
 * are the ones that must resolve to null (no info string) or to a grammar
 * whose output is unstyled by design (a log dump, a tree listing), not just the
 * happy path where `ts` becomes `typescript`.
 */
import { describe, expect, it } from 'vitest'
import { isStylableLanguage, resolveLanguage } from '../src/shared/highlightLang'

describe('resolveLanguage', () => {
  it('passes a name highlight.js already knows straight through', () => {
    expect(resolveLanguage('python')).toBe('python')
    expect(resolveLanguage('bash')).toBe('bash')
    expect(resolveLanguage('diff')).toBe('diff')
    expect(resolveLanguage('json')).toBe('json')
  })

  it('normalizes the spellings highlight.js does not alias', () => {
    expect(resolveLanguage('tsx')).toBe('typescript')
    expect(resolveLanguage('jsx')).toBe('javascript')
    expect(resolveLanguage('typescriptreact')).toBe('tsx')
    expect(resolveLanguage('python3')).toBe('python')
    expect(resolveLanguage('htm')).toBe('xml')
    expect(resolveLanguage('sh')).toBe('bash')
    expect(resolveLanguage('zsh')).toBe('bash')
    expect(resolveLanguage('unified')).toBe('diff')
    expect(resolveLanguage('docker')).toBe('dockerfile')
    expect(resolveLanguage('containerfile')).toBe('dockerfile')
    expect(resolveLanguage('env')).toBe('properties')
  })

  it('keeps the aliases highlight.js owns instead of second-guessing them', () => {
    // `ts` and `py` are already highlight.js aliases; the table must not
    // rewrite them into a different grammar, or a future highlight.js rename
    // would silently change which colours a fence gets.
    expect(resolveLanguage('ts')).toBe('ts')
    expect(resolveLanguage('py')).toBe('py')
  })

  it('takes only the first token, so ```bash title=x.sh still reads bash', () => {
    // Fences carry attributes after the language in the wild; the language is
    // the first token and nothing else.
    expect(resolveLanguage('bash title=example.sh')).toBe('bash')
    expect(resolveLanguage('ts {1,3}')).toBe('ts')
    expect(resolveLanguage('json filename=pkg.json')).toBe('json')
  })

  it('is case-insensitive', () => {
    expect(resolveLanguage('TypeScript')).toBe('typescript')
    expect(resolveLanguage('PY')).toBe('py')
    expect(resolveLanguage('Bash')).toBe('bash')
  })

  it('returns null for an empty or missing info string', () => {
    expect(resolveLanguage('')).toBeNull()
    expect(resolveLanguage('   ')).toBeNull()
    expect(resolveLanguage(undefined)).toBeNull()
    expect(resolveLanguage(null)).toBeNull()
  })

  it('routes prose-ish and log fences to plaintext, which is unstyled on purpose', () => {
    // These resolve to a real grammar, but isStylableLanguage filters them out
    // so a CI log or a `tree` dump is not tokenized into rainbow soup.
    expect(resolveLanguage('log')).toBe('plaintext')
    expect(resolveLanguage('text')).toBe('plaintext')
    expect(resolveLanguage('output')).toBe('plaintext')
  })
})

describe('isStylableLanguage', () => {
  it('rejects null and the grammars that produce no colours', () => {
    expect(isStylableLanguage(null)).toBe(false)
    expect(isStylableLanguage('plaintext')).toBe(false)
    expect(isStylableLanguage('text')).toBe(false)
  })

  it('accepts a real grammar and narrows it to a string', () => {
    const language = resolveLanguage('typescript')
    expect(isStylableLanguage(language)).toBe(true)
    if (isStylableLanguage(language)) {
      // The guard is a type predicate, so this branch sees a string, not
      // string | null - that narrowing is what lets the render site call
      // lowlight.registered() without a non-null assertion.
      expect(language.toUpperCase()).toBe('TYPESCRIPT')
    }
  })
})
