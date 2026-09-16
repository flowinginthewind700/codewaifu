/**
 * The terminal font has to reach xterm as a literal family list.
 *
 * `var(--mono)` in `Terminal({ fontFamily })` looked correct in the source and
 * rendered as ragged, letter-spaced noise on screen: canvas never substitutes
 * custom properties, so the metrics fell back to the default 10px sans-serif
 * while the DOM around the pane kept using the real stack. These cases pin the
 * two halves of the fix - read the declared stack when a stylesheet exists,
 * and never hand a `var(` reference to a canvas, from any path.
 */
import { describe, expect, it } from 'vitest'
import {
  MONO_FALLBACK,
  monoStack,
  terminalFontsReady
} from '../src/renderer/src/pro/terminalFont'

describe('monoStack', () => {
  it('falls back when there is no stylesheet to read', () => {
    expect(monoStack(undefined)).toBe(MONO_FALLBACK)
    expect(monoStack(null)).toBe(MONO_FALLBACK)
  })

  it('uses the stack the UI declares, so terminal and code blocks agree', () => {
    expect(monoStack("'JetBrains Mono', ui-monospace, monospace")).toBe(
      "'JetBrains Mono', ui-monospace, monospace"
    )
  })

  it('falls back when the property is empty', () => {
    expect(monoStack('   ')).toBe(MONO_FALLBACK)
  })

  it('refuses a value canvas could not resolve anyway', () => {
    expect(monoStack('var(--something-else)')).toBe(MONO_FALLBACK)
  })
})

describe('MONO_FALLBACK', () => {
  it('leads with the bundled face: rendering must not depend on the host', () => {
    // A host-only stack silently degrades: on a stock Linux box every modern
    // face is absent and `ui-monospace` falls through fontconfig to DejaVu
    // Sans Mono, which is the "weird font" a human sees. The shipped face has
    // to be first, on every machine.
    expect(MONO_FALLBACK.startsWith("'JetBrains Mono'")).toBe(true)
  })

  it('is a literal list: no var(), a CJK mono, and the generic keyword last', () => {
    expect(MONO_FALLBACK).not.toContain('var(')
    expect(MONO_FALLBACK).toContain('Noto Sans Mono CJK SC')
    expect(MONO_FALLBACK.trimEnd().endsWith('monospace')).toBe(true)
  })
})

describe('terminalFontsReady', () => {
  it('resolves without a document instead of rejecting', async () => {
    // The vitest environment here is node: no document at all. A pane that
    // awaited a rejecting gate would never open, which on screen is
    // indistinguishable from herdr having died.
    await expect(terminalFontsReady()).resolves.toBeUndefined()
  })
})
