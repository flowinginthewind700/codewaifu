import { describe, expect, it } from 'vitest'
import {
  agentLabel,
  fillPhrase,
  greetingKeyForHour,
  PHRASES,
  phraseCount,
  pickPhrase,
  type PhraseKey
} from '../src/shared/phrases'

const KEYS = Object.keys(PHRASES) as PhraseKey[]

describe('phrase pools', () => {
  it('has at least three variants per language per key, so repeats stay rare', () => {
    for (const key of KEYS) {
      expect(PHRASES[key].zh.length, `${key}.zh`).toBeGreaterThanOrEqual(3)
      expect(PHRASES[key].en.length, `${key}.en`).toBeGreaterThanOrEqual(3)
      expect(phraseCount(key)).toBe(PHRASES[key].zh.length + PHRASES[key].en.length)
    }
  })

  it('has no empty string in any pool', () => {
    for (const key of KEYS) {
      for (const line of [...PHRASES[key].zh, ...PHRASES[key].en]) {
        expect(line.trim().length, `${key}: "${line}"`).toBeGreaterThan(0)
      }
    }
  })

  it('only uses placeholders that fillPhrase understands', () => {
    const allowed = new Set(['{agent}', '{tool}', '{detail}'])
    for (const key of KEYS) {
      for (const line of [...PHRASES[key].zh, ...PHRASES[key].en]) {
        for (const match of line.matchAll(/\{[^}]*\}/g)) {
          expect(allowed.has(match[0]), `${key}: ${match[0]}`).toBe(true)
        }
      }
    }
  })

  it('phraseCount is 0 for a key that does not exist', () => {
    expect(phraseCount('nope' as PhraseKey)).toBe(0)
    expect(pickPhrase('nope' as PhraseKey, 'en')).toBe('')
  })
})

describe('greetingKeyForHour', () => {
  it.each([
    [0, 'greeting_night'],
    [4, 'greeting_night'],
    [5, 'greeting_morning'],
    [11, 'greeting_morning'],
    [12, 'greeting_afternoon'],
    [17, 'greeting_afternoon'],
    [18, 'greeting_evening'],
    [22, 'greeting_evening'],
    [23, 'greeting_night']
  ])('%i:00 -> %s', (hour, key) => {
    expect(greetingKeyForHour(hour)).toBe(key)
  })
})

describe('agentLabel', () => {
  it('names the agents and has a neutral fallback', () => {
    expect(agentLabel('codex', 'en')).toBe('Codex')
    expect(agentLabel('claude', 'zh')).toBe('Claude Code')
    expect(agentLabel('unknown', 'zh')).toBe('agent')
    expect(agentLabel('unknown', 'en')).toBe('the agent')
    // Hook-only flavors still get a name to be spoken as: she says "Cursor
    // Agent needs a decision", not "the agent needs a decision".
    expect(agentLabel('cursor', 'en')).toBe('Cursor Agent')
    expect(agentLabel('gemini', 'zh')).toBe('Gemini CLI')
    expect(agentLabel('kimi', 'en')).toBe('Kimi CLI')
    // A flavor nobody named still falls back instead of reading a raw id aloud.
    expect(agentLabel('aider', 'en')).toBe('the agent')
  })
})

describe('fillPhrase', () => {
  it('substitutes every placeholder', () => {
    expect(fillPhrase('{agent} called {tool}: {detail}', 'en', { agent: 'codex', tool: 'shell', detail: 'npm test' })).toBe(
      'Codex called shell: npm test'
    )
  })

  it('degrades gracefully when a variable is missing', () => {
    expect(fillPhrase('{agent} used {tool}', 'en', {})).toBe('the agent used a tool')
    expect(fillPhrase('failed: {detail}', 'en', {})).toBe('failed:')
  })

  it('replaces repeated placeholders and collapses the gap they leave', () => {
    expect(fillPhrase('{agent} and {agent}', 'zh', { agent: 'codex' })).toBe('Codex and Codex')
    expect(fillPhrase('a {detail} b', 'en', {})).toBe('a  b'.replace(/\s{2,}/g, ' '))
  })
})

describe('pickPhrase', () => {
  it('is deterministic for a given rng and always stays inside the pool', () => {
    const always = (value: number) => () => value
    for (const key of KEYS) {
      for (const value of [0, 0.5, 0.999]) {
        for (const lang of ['zh', 'en'] as const) {
          const text = pickPhrase(key, lang, { agent: 'codex' }, always(value))
          expect(text.trim().length, `${key}/${lang}@${value}`).toBeGreaterThan(0)
          expect(text).not.toContain('{')
        }
      }
    }
  })

  it('clamps an rng that returns exactly 1', () => {
    const text = pickPhrase('stop', 'en', { agent: 'codex' }, () => 1)
    expect(PHRASES.stop.en.some((line) => text.includes(line.slice(0, 6)))).toBe(true)
  })

  it('covers the whole pool over many draws', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 400; i += 1) seen.add(pickPhrase('greeting_morning', 'zh'))
    expect(seen.size).toBe(PHRASES.greeting_morning.zh.length)
  })
})
