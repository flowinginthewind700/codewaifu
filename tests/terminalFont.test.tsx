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
import { MONO_FALLBACK, monoStack } from '../src/renderer/src/pro/terminalFont'

describe('monoStack', () => {
  it('falls back when there is no stylesheet to read', () => {
    expect(monoStack(undefined)).toBe(MONO_FALLBACK)
    expect(monoStack(null)).toBe(MONO_FALLBACK)
  })

  it('uses the stack the UI declares, so terminal and code blocks agree', () => {
    expect(monoStack("ui-monospace, 'JetBrains Mono', monospace")).toBe(
      "ui-monospace, 'JetBrains Mono', monospace"
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
  it('is a literal list: no var(), a CJK mono, and the generic keyword last', () => {
    expect(MONO_FALLBACK).not.toContain('var(')
    expect(MONO_FALLBACK).toContain('Noto Sans Mono CJK SC')
    expect(MONO_FALLBACK.trimEnd().endsWith('monospace')).toBe(true)
  })
})
