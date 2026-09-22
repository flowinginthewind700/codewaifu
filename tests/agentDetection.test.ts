/**
 * Every agent we can name must be an agent we can detect.
 *
 * The shipped gap: Antigravity was wired through the hook installer, the event
 * normalizer, the Pro bench and the settings rows, but was missing from
 * `detectionHomes`. Nothing failed loudly - `runtimeState()` simply never
 * reported `agents.antigravity`, so the settings panel showed it as "none"
 * even on a machine that had it, and its hook row lost the "already installed"
 * signal the other ten had. A missing key is invisible in TypeScript because
 * `detectionHomes` is a `Record<string, ...>`, not a `Record<Agent, ...>`:
 * the cast at the call site erases the requirement. So this test is the
 * requirement.
 *
 * Asserted both ways, because each direction catches a different mistake:
 * one-way coverage lets a dead key linger (a typo'd agent nobody reads), and
 * it would not notice if `HOOK_AGENTS` itself grew a flavor the map forgot.
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { antigravityHome, detectionHomes, geminiHome } from '../src/main/env'
import { HOOK_AGENTS } from '../src/shared/protocol'

const detected = Object.keys(detectionHomes)

describe('detectionHomes', () => {
  it('has a home to probe for every hookable agent', () => {
    const missing = HOOK_AGENTS.filter((agent) => !detected.includes(agent))
    expect(missing).toEqual([])
  })

  it('detects no agent we cannot name', () => {
    const extra = detected.filter(
      (name) => !(HOOK_AGENTS as readonly string[]).includes(name)
    )
    expect(extra).toEqual([])
  })

  it('gives every agent at least one absolute candidate path', () => {
    for (const [name, dirs] of Object.entries(detectionHomes)) {
      expect(dirs.length, name).toBeGreaterThan(0)
      for (const dir of dirs) {
        expect(path.isAbsolute(dir), dir).toBe(true)
      }
    }
  })

  it('probes inside Gemini home for Antigravity, which lives there', () => {
    // Antigravity has no home dir of its own. Probing Gemini's root would be
    // true on any machine with Gemini alone, so its marker is one level down.
    expect(antigravityHome).toBe(path.join(geminiHome, 'config'))
    expect(antigravityHome).not.toBe(geminiHome)
    expect(detectionHomes.antigravity).toEqual([antigravityHome])
  })
})
