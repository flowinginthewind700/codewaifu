/**
 * The name Pro hands `agent.start`, pinned against the grammar herdr enforces.
 *
 * The shipped bug: `createTask` passed the task title through as the agent name
 * and dropped whatever came back (`.catch(() => null)`). herdr validates that
 * name - a lowercase ASCII letter first, `[a-z0-9_-]` only, 32 bytes, unique
 * among live agents - so a CJK or capitalized title was refused, and the bench
 * showed a task with an agent over a pane that was a plain shell. Nothing
 * upstream could see why, because the refusal was swallowed on the way out.
 *
 * These cases assert against a transcription of herdr's own predicate rather
 * than a list of expected strings: the contract lives in Rust, and a
 * golden-value test would keep passing if the validator changed underneath it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_NAME_MAX, agentName } from '../src/shared/herdr'

/** `thirdparty/herdr/src/app/agents.rs::valid_agent_name`, transcribed. */
function herdrAccepts(name: string): boolean {
  // `name.len()` in Rust is bytes, not characters, so the length check has to
  // be one too: 20 CJK characters are 60 bytes and already too long.
  const bytes = new TextEncoder().encode(name)
  if (!bytes.length || bytes.length > AGENT_NAME_MAX) return false
  if (bytes[0] < 0x61 || bytes[0] > 0x7a) return false
  return bytes.every(
    (b) => (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x5f
  )
}

/** Titles a real bench has held, plus the shapes that break a naive slug. */
const TITLES = [
  '论文采集',
  'Fix Login',
  'wire up /api/v2',
  'fix the flaky test in the renderer harness that keeps timing out on windows',
  '99 problems',
  'Ünïcödé Tïtle',
  '__init__',
  '---',
  '   ',
  '',
  'a'.repeat(80)
]

const IDS = ['tm1', 'tmu5m3b8yab76', '9abc', 'a'.repeat(40)]

describe('agentName', () => {
  it('produces a name herdr accepts, for every title and id shape', () => {
    for (const title of TITLES) {
      for (const id of IDS) {
        const name = agentName(title, id)
        const label = `${title.slice(0, 12)}/${id.slice(0, 8)} -> ${name}`
        expect(herdrAccepts(name), label).toBe(true)
        expect(name.endsWith('-') || name.endsWith('_'), label).toBe(false)
      }
    }
  })

  it('keeps the title readable when there is room for it', () => {
    expect(agentName('Fix Login', 'tm1')).toBe('fix-login-tm1')
    expect(agentName('wire up /api/v2', 'tm1')).toBe('wire-up-api-v2-tm1')
    expect(agentName('Ünïcödé Tïtle', 'tm1')).toBe('unicode-title-tm1')
  })

  it('falls back to the id alone when the title slugifies to nothing', () => {
    // The task that started this: a CJK title has no ASCII slug, and the id on
    // its own is already a valid name.
    expect(agentName('论文采集', 'tmu5m3b8yab76')).toBe('tmu5m3b8yab76')
    expect(agentName('---', 'tmu5m3b8yab76')).toBe('tmu5m3b8yab76')
  })

  it('spends the truncation on the title, never on the id', () => {
    const id = 'tmu5m3b8yab76'
    const name = agentName('fix the flaky test in the renderer harness', id)
    expect(name.endsWith(`-${id}`)).toBe(true)
    expect(herdrAccepts(name)).toBe(true)
  })

  it('gives two tasks with the same title two names', () => {
    // `agent_name_taken` is the other refusal, and the one a shape test cannot
    // see: both names below are individually valid.
    expect(agentName('fix the flaky test', 'aaa111')).not.toBe(
      agentName('fix the flaky test', 'bbb222')
    )
  })

  it('prepends a letter to a digit-first id rather than dropping digits', () => {
    // Dropping them is what the obvious fallback amounts to: every all-digit id
    // would arrive as the same name, and the second start would be refused as a
    // duplicate - the same bug wearing a different error code.
    expect(agentName('', '12345')).toBe('t12345')
    expect(agentName('Paper Run', '9abc')).toBe('paper-run-t9abc')
    expect(agentName('', '')).toBe('task')
  })

  it('mirrors the length herdr itself enforces', (ctx) => {
    // The 32 in `AGENT_NAME_MAX` is copied out of vendored Rust, so the copy is
    // checked against the original. Skipped rather than failed when herdr's
    // source is not checked out: such a machine has nothing to compare against,
    // and this package builds fine there.
    const source = path.join(__dirname, '..', 'thirdparty', 'herdr', 'src', 'app', 'agents.rs')
    // `thirdparty/` is gitignored, so CI has no herdr source and this reports
    // skipped. Returning instead would report *passed*, and a green suite that
    // never compared anything is worse than an honest hole in it.
    if (!fs.existsSync(source)) return ctx.skip()
    const limit = /name\.len\(\)\s*<=\s*(\d+)/.exec(fs.readFileSync(source, 'utf8'))
    expect(limit, 'valid_agent_name no longer states a byte limit').not.toBeNull()
    expect(AGENT_NAME_MAX).toBe(Number(limit?.[1]))
  })

  it('names the two refusals herdr actually emits', (ctx) => {
    // The codes quoted in `agentName`'s docs and in the notice a refused start
    // raises. An invented one reads as a typo right up to the moment someone
    // greps herdr for it and finds nothing - which is how
    // `duplicate_agent_name` came to be written down here in the first place.
    // Nothing in `src/` branches on these codes (the notice surfaces herdr's own
    // text verbatim), so drift here is a documentation bug, not a behaviour one.
    const source = path.join(__dirname, '..', 'thirdparty', 'herdr', 'src', 'app', 'agents.rs')
    if (!fs.existsSync(source)) return ctx.skip()
    const rust = fs.readFileSync(source, 'utf8')
    for (const code of ['invalid_agent_name', 'agent_name_taken']) {
      expect(rust, `herdr no longer emits ${code}`).toContain(`code: "${code}".into()`)
    }
    expect(rust).not.toContain('duplicate_agent_name')
  })
})
