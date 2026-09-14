import { describe, expect, it } from 'vitest'
import { COMPOSITION_END_GRACE_MS, IME_KEYCODE, isImeKey, isSubmitEnter, type ImeKeyLike } from '../src/shared/ime'

// ============================================================
// Enter-to-send vs. the Enter that commits an IME candidate. The bug this pins:
// typing Chinese in the composer and pressing Enter to pick a candidate sent
// the half-typed draft to the agent. Pure predicates only — the renderer hook
// just wires them to compositionstart/compositionend.
// ============================================================

const enter = (extra: ImeKeyLike = {}): ImeKeyLike => ({ key: 'Enter', keyCode: 13, isComposing: false, ...extra })

describe('isSubmitEnter', () => {
  it('sends on a bare Enter', () => {
    expect(isSubmitEnter(enter())).toBe(true)
    expect(isSubmitEnter(enter(), false)).toBe(true)
  })

  it('does not send while the native event is composing', () => {
    expect(isSubmitEnter(enter({ isComposing: true }))).toBe(false)
  })

  it('does not send on the legacy IME keycode', () => {
    // Some Windows IMEs clear isComposing before the keydown reaches the page
    // and leave only keyCode 229 behind.
    expect(isSubmitEnter(enter({ keyCode: IME_KEYCODE }))).toBe(false)
    expect(isSubmitEnter({ key: 'Enter', keyCode: IME_KEYCODE })).toBe(false)
  })

  it('does not send while our own composition flag is set', () => {
    expect(isSubmitEnter(enter(), true)).toBe(false)
  })

  it('keeps Shift+Enter as a newline', () => {
    expect(isSubmitEnter(enter({ shiftKey: true }))).toBe(false)
  })

  it('ignores every other key', () => {
    expect(isSubmitEnter({ key: 'a', keyCode: 65 })).toBe(false)
    expect(isSubmitEnter({ key: 'Escape', keyCode: 27 })).toBe(false)
    expect(isSubmitEnter({ key: 'Process', keyCode: IME_KEYCODE })).toBe(false)
    expect(isSubmitEnter({})).toBe(false)
  })

  it('stands down inside the compositionend grace window', () => {
    // macOS dispatches the commit Enter after compositionend with every direct
    // signal clean; only the elapsed time since the composition ended tells it
    // apart from a deliberate send.
    expect(isSubmitEnter(enter(), false, 0)).toBe(false)
    expect(isSubmitEnter(enter(), false, COMPOSITION_END_GRACE_MS - 1)).toBe(false)
    expect(isSubmitEnter(enter(), false, COMPOSITION_END_GRACE_MS)).toBe(true)
    expect(isSubmitEnter(enter(), false, 400)).toBe(true)
    expect(isSubmitEnter(enter(), false, null)).toBe(true)
  })
})

describe('isImeKey', () => {
  it('stands global shortcuts down mid-composition', () => {
    // Esc while composing belongs to the IME (cancel the candidate), not to the
    // panel; without this, closing the chat ate the user's in-progress word.
    expect(isImeKey({ key: 'Escape', keyCode: 27, isComposing: true })).toBe(true)
    expect(isImeKey({ key: 'Escape', keyCode: IME_KEYCODE })).toBe(true)
    expect(isImeKey({ key: 'Escape', keyCode: 27 }, true)).toBe(true)
  })

  it('lets real keys through', () => {
    expect(isImeKey({ key: 'Escape', keyCode: 27, isComposing: false })).toBe(false)
    expect(isImeKey({ key: '/', keyCode: 191 })).toBe(false)
    expect(isImeKey({})).toBe(false)
  })
})
