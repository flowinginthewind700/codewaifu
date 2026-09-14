/**
 * Global summon hotkey: pure decisions and accelerator string handling.
 *
 * The shortcut lives in main (Electron `globalShortcut`), but both the
 * settings recorder (renderer) and the unit tests need the same rules, so
 * everything testable sits here with no electron import.
 */

/** Safe system-wide default: modifier + letter, free on macOS and Windows. */
export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+K'

export type HotkeyAction = 'summon' | 'hide' | 'ignore'

/**
 * What the hotkey should do right now.
 *
 * A focused, non-empty input wins over everything: the user is mid-sentence
 * (often mid-IME composition), and yanking the window away — or hiding it —
 * would eat the context of their draft. So the hotkey is a no-op while typing.
 */
export function hotkeyAction(state: { inputActive: boolean; visible: boolean }): HotkeyAction {
  if (state.inputActive) return 'ignore'
  return state.visible ? 'hide' : 'summon'
}

export interface KeyCombo {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  code: string
  key: string
}

const NAMED_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter'
}

/**
 * Turn one recorded keydown into an Electron accelerator, or `null` when the
 * press is not a usable shortcut. A bare key (no modifier) is refused: a
 * global grab of a plain letter would swallow typing in every other app.
 */
export function acceleratorFromCombo(combo: KeyCombo): string | null {
  const mods: string[] = []
  if (combo.metaKey) mods.push('Command')
  if (combo.ctrlKey) mods.push('Control')
  if (combo.altKey) mods.push('Alt')
  if (combo.shiftKey) mods.push('Shift')
  if (mods.length === 0) return null
  if (combo.key === 'Meta' || combo.key === 'Control' || combo.key === 'Alt' || combo.key === 'Shift') return null

  const code = combo.code
  let key = ''
  const letter = /^Key([A-Z])$/.exec(code)
  const digit = /^Digit([0-9])$/.exec(code)
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)
  if (letter) key = letter[1]
  else if (digit) key = digit[1]
  else if (fn) key = `F${fn[1]}`
  else key = NAMED_KEYS[code] || ''
  if (!key) return null
  return [...mods, key].join('+')
}

/** Human-readable form for the settings row: symbols on mac, words elsewhere. */
export function formatAccelerator(accelerator: string, mac: boolean): string {
  const parts = accelerator.split('+').filter(Boolean)
  const mapped = parts.map((part) => {
    switch (part) {
      case 'CommandOrControl':
        return mac ? '⌘' : 'Ctrl'
      case 'Command':
        return mac ? '⌘' : 'Cmd'
      case 'Control':
        return mac ? '⌃' : 'Ctrl'
      case 'Alt':
        return mac ? '⌥' : 'Alt'
      case 'Shift':
        return mac ? '⇧' : 'Shift'
      default:
        return part
    }
  })
  return mac ? mapped.join('') : mapped.join('+')
}
