import { describe, expect, it } from 'vitest'
import { clipAtBoundary, detectLang, hasCjk, resolveLang, toSpeakable } from '../src/shared/lang'

describe('detectLang', () => {
  it('switches to Chinese on a single CJK character, because mixed output reads better in a zh voice', () => {
    expect(detectLang('正在运行 npm test')).toBe('zh')
    expect(detectLang('all tests pass')).toBe('en')
    expect(detectLang('build 成功')).toBe('zh')
    expect(detectLang('こんにちは')).toBe('zh')
    expect(detectLang('안녕')).toBe('zh')
  })

  it('falls back for empty input', () => {
    expect(detectLang('')).toBe('en')
    expect(detectLang('   ')).toBe('en')
    expect(detectLang('', 'zh')).toBe('zh')
    expect(detectLang(undefined as unknown as string)).toBe('en')
  })

  it('resolveLang only consults the text when the preference is auto', () => {
    expect(resolveLang('auto', '你好')).toBe('zh')
    expect(resolveLang('en', '你好')).toBe('en')
    expect(resolveLang('zh', 'hello')).toBe('zh')
  })

  it('hasCjk is the single source of truth for the check', () => {
    expect(hasCjk('漢字')).toBe(true)
    expect(hasCjk('kanji')).toBe(false)
  })
})

describe('toSpeakable', () => {
  it('strips what a TTS engine reads aloud as noise', () => {
    expect(toSpeakable('see `config.ts` now')).toBe('see config.ts now')
    expect(toSpeakable('run ```\nnpm test\n``` please')).toBe('run please')
    expect(toSpeakable('open https://example.com/a?b=1 today')).toBe('open today')
    expect(toSpeakable('![alt](img.png) and [label](http://x)')).toBe('and label')
    expect(toSpeakable('# Heading **bold** _it_ > quote ~x~ | pipe')).toBe('Heading bold it quote x pipe')
    expect(toSpeakable('red\u001b[31m text\u001b[0m')).toBe('red text')
  })

  it('keeps underscores inside identifiers, which are names and not emphasis', () => {
    expect(toSpeakable('tool exec_command ran npm test')).toBe('tool exec_command ran npm test')
    expect(toSpeakable('PostToolUse exec_command npm test')).toBe('PostToolUse exec_command npm test')
  })

  it('collapses whitespace and control characters', () => {
    expect(toSpeakable('a\n\n\n  b\t c\u0007')).toBe('a b c')
  })

  it('clamps to the budget at a word boundary', () => {
    const out = toSpeakable('alpha beta gamma delta epsilon', 14)
    expect(out.length).toBeLessThanOrEqual(15)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toContain('delt')
  })

  it('returns short text untouched', () => {
    expect(toSpeakable('all good')).toBe('all good')
    expect(toSpeakable('')).toBe('')
  })
})

describe('clipAtBoundary', () => {
  it('is a no-op under the limit', () => {
    expect(clipAtBoundary('short', 50)).toBe('short')
  })

  it('cuts at the last word boundary inside the window, never mid-word', () => {
    const text = 'The first sentence ends here. The second one keeps going well past the limit.'
    const out = clipAtBoundary(text, 45)
    expect(out).toBe('The first sentence ends here. The second one…')
    expect(out).not.toContain('keep')
  })

  it('cuts at a word boundary when there is no punctuation at all', () => {
    const out = clipAtBoundary('one two three four five six seven', 17)
    expect(out).toBe('one two three…')
  })

  it('ignores a boundary in the first 45% of the window, which would waste the budget', () => {
    // The only break is at index 3 of a 40-char window: too early to be useful.
    const out = clipAtBoundary('abc defghijklmnopqrstuvwxyz0123456789ABCDEFG', 40)
    expect(out).toBe('abc defghijklmnopqrstuvwxyz0123456789ABC…')
  })

  it('never leaves a dangling connector before the ellipsis', () => {
    for (const text of [
      'alpha beta, gamma delta epsilon zeta',
      'alpha beta; gamma delta epsilon zeta',
      'alpha beta：gamma delta epsilon zeta',
      'alpha beta、gamma delta epsilon zeta',
      'alpha beta - gamma delta epsilon zeta'
    ]) {
      const out = clipAtBoundary(text, 18)
      expect(out, text).toMatch(/[^,;:、\-—–\s]…$/)
    }
  })

  it('keeps CJK punctuation as a boundary, so a Chinese sentence is not chopped mid-clause', () => {
    const out = clipAtBoundary('第一段话到这里结束。第二段话还在继续说下去，一直说到超出我们设定的长度限制为止。', 24)
    expect(out).toBe('第一段话到这里结束。第二段话还在继续说下去…')
  })

  it('falls back to a hard cut when no boundary exists in the window', () => {
    const out = clipAtBoundary('supercalifragilisticexpialidocious', 10)
    expect(out).toBe('supercalif…')
  })
})
