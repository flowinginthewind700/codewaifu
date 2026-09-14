import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOTKEY,
  acceleratorFromCombo,
  formatAccelerator,
  hotkeyAction,
  type KeyCombo
} from '../src/shared/hotkey'

const combo = (over: Partial<KeyCombo> = {}): KeyCombo => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  code: '',
  key: '',
  ...over
})

describe('hotkeyAction', () => {
  it('summons when hidden and hides when visible', () => {
    expect(hotkeyAction({ inputActive: false, visible: false })).toBe('summon')
    expect(hotkeyAction({ inputActive: false, visible: true })).toBe('hide')
  })

  it('is a no-op while a non-empty input holds focus', () => {
    // The draft (often mid-IME composition) outranks the shortcut, whether
    // she is on screen or not.
    expect(hotkeyAction({ inputActive: true, visible: false })).toBe('ignore')
    expect(hotkeyAction({ inputActive: true, visible: true })).toBe('ignore')
  })
})

describe('acceleratorFromCombo', () => {
  it('builds an accelerator from modifiers plus a key', () => {
    expect(acceleratorFromCombo(combo({ metaKey: true, shiftKey: true, code: 'KeyK', key: 'K' }))).toBe(
      'Command+Shift+K'
    )
    expect(acceleratorFromCombo(combo({ ctrlKey: true, altKey: true, code: 'Digit3', key: '3' }))).toBe(
      'Control+Alt+3'
    )
    expect(acceleratorFromCombo(combo({ metaKey: true, code: 'F5', key: 'F5' }))).toBe('Command+F5')
    expect(acceleratorFromCombo(combo({ ctrlKey: true, code: 'Space', key: ' ' }))).toBe('Control+Space')
    expect(acceleratorFromCombo(combo({ ctrlKey: true, code: 'NumpadEnter', key: 'Enter' }))).toBe(
      'Control+Enter'
    )
  })

  it('refuses bare keys: a global grab of a plain letter would eat typing', () => {
    expect(acceleratorFromCombo(combo({ code: 'KeyK', key: 'k' }))).toBeNull()
    expect(acceleratorFromCombo(combo({ code: 'Space', key: ' ' }))).toBeNull()
  })

  it('refuses modifier-only presses and unknown keys', () => {
    expect(acceleratorFromCombo(combo({ metaKey: true, code: 'MetaLeft', key: 'Meta' }))).toBeNull()
    expect(acceleratorFromCombo(combo({ shiftKey: true, code: 'ShiftLeft', key: 'Shift' }))).toBeNull()
    expect(acceleratorFromCombo(combo({ ctrlKey: true, code: 'KeyL', key: 'Control' }))).toBeNull()
    expect(acceleratorFromCombo(combo({ ctrlKey: true, code: 'ArrowUp', key: 'ArrowUp' }))).toBeNull()
    expect(acceleratorFromCombo(combo({ ctrlKey: true, code: 'F25', key: 'F25' }))).toBeNull()
  })
})

describe('formatAccelerator', () => {
  it('joins mac modifiers into symbols', () => {
    expect(formatAccelerator(DEFAULT_HOTKEY, true)).toBe('⌘⇧K')
    expect(formatAccelerator('Control+Alt+F12', true)).toBe('⌃⌥F12')
  })

  it('spells modifiers out elsewhere', () => {
    expect(formatAccelerator(DEFAULT_HOTKEY, false)).toBe('Ctrl+Shift+K')
    expect(formatAccelerator('Command+Space', false)).toBe('Cmd+Space')
  })
})
