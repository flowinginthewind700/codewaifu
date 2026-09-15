import { describe, expect, it } from 'vitest'
import { clipboardAction, type TermKeyEvent } from '../src/shared/termKeys'

const key = (over: Partial<TermKeyEvent> = {}): TermKeyEvent => ({
  type: 'keydown',
  key: '',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over
})

/** The chord a real browser reports: Shift held means the letter arrives upper. */
const shifted = (letter: string, over: Partial<TermKeyEvent> = {}): TermKeyEvent =>
  key({ key: letter.toUpperCase(), shiftKey: true, ...over })

describe('clipboardAction', () => {
  it('never claims the plain Ctrl chords the agent depends on', () => {
    // This is the whole reason the table is pure code under test. If any of
    // these returned 'copy' or 'paste', the key would stop reaching the PTY and
    // the human would lose SIGINT - with a selection on screen, which is exactly
    // when somebody has just highlighted the log line of a runaway loop.
    for (const platform of ['linux', 'win32']) {
      for (const letter of ['c', 'v', 'x', 'z', 'd', 'a', 'l', 'r', 'w', 'u']) {
        for (const hasSelection of [true, false]) {
          expect(clipboardAction(platform, key({ key: letter, ctrlKey: true }), hasSelection)).toBe(
            'ignore'
          )
        }
      }
    }
  })

  it('leaves bare typing alone, selection or not', () => {
    // A highlighted pane plus ordinary typing is the common case while an agent
    // runs, so the copy chord has to need a modifier: otherwise every keystroke
    // into the shell would be swallowed.
    for (const letter of ['c', 'v', 'y', 'n']) {
      expect(clipboardAction('linux', key({ key: letter }), true)).toBe('ignore')
      expect(clipboardAction('linux', key({ key: letter }), false)).toBe('ignore')
    }
  })

  it('copies and pastes on Ctrl+Shift outside macOS', () => {
    for (const platform of ['linux', 'win32']) {
      expect(clipboardAction(platform, shifted('c', { ctrlKey: true }), true)).toBe('copy')
      expect(clipboardAction(platform, shifted('v', { ctrlKey: true }), false)).toBe('paste')
    }
  })

  it('matches the chord case-insensitively', () => {
    // With Shift down the DOM reports 'C', not 'c'. Comparing the raw `key`
    // would silently disable copy on every platform while paste kept working,
    // which reads like a flaky clipboard rather than a typo.
    expect(clipboardAction('linux', shifted('c', { ctrlKey: true }), true)).toBe('copy')
    expect(clipboardAction('linux', key({ key: 'c', ctrlKey: true, shiftKey: true }), true)).toBe(
      'copy'
    )
    expect(clipboardAction('darwin', shifted('c', { metaKey: true }), true)).toBe('copy')
  })

  it('refuses a copy with nothing selected', () => {
    // No text to move, so the chord goes back to the terminal instead of being
    // consumed for nothing.
    expect(clipboardAction('linux', shifted('c', { ctrlKey: true }), false)).toBe('ignore')
    expect(clipboardAction('darwin', key({ key: 'c', metaKey: true }), false)).toBe('ignore')
    expect(clipboardAction('linux', key({ key: 'Insert', ctrlKey: true }), false)).toBe('ignore')
  })

  it('honours the console-style Insert chords', () => {
    expect(clipboardAction('linux', key({ key: 'Insert', ctrlKey: true }), true)).toBe('copy')
    // Shift+Insert pastes with no Ctrl held, so it cannot sit behind a Ctrl gate.
    expect(clipboardAction('linux', key({ key: 'Insert', shiftKey: true }), false)).toBe('paste')
    expect(clipboardAction('win32', key({ key: 'Insert', shiftKey: true }), false)).toBe('paste')
    // Both at once is neither, and a bare Insert belongs to the terminal.
    expect(
      clipboardAction('linux', key({ key: 'Insert', ctrlKey: true, shiftKey: true }), true)
    ).toBe('ignore')
    expect(clipboardAction('linux', key({ key: 'Insert' }), true)).toBe('ignore')
  })

  it('gives macOS the Cmd chords and nothing else', () => {
    expect(clipboardAction('darwin', key({ key: 'c', metaKey: true }), true)).toBe('copy')
    expect(clipboardAction('darwin', key({ key: 'v', metaKey: true }), false)).toBe('paste')
    // Ctrl+C on a Mac is still SIGINT, not copy.
    expect(clipboardAction('darwin', key({ key: 'c', ctrlKey: true }), true)).toBe('ignore')
    // Ctrl+Cmd+C belongs to the system, so Cmd has to arrive alone.
    expect(clipboardAction('darwin', key({ key: 'c', metaKey: true, ctrlKey: true }), true)).toBe(
      'ignore'
    )
    // Shift is irrelevant to the Cmd family. No terminal program ever sees a Cmd
    // chord, so unlike Ctrl there is nothing to protect by being strict, and
    // Cmd+Shift+C copies the way it does in iTerm2 and Ghostty.
    expect(clipboardAction('darwin', shifted('c', { metaKey: true }), true)).toBe('copy')
    expect(clipboardAction('darwin', shifted('v', { metaKey: true }), false)).toBe('paste')
    // The rest of the Cmd block (Cmd+K clear, Cmd+A select) stays with xterm.
    for (const letter of ['k', 'a', 'f', 'x', 'z']) {
      expect(clipboardAction('darwin', key({ key: letter, metaKey: true }), true)).toBe('ignore')
    }
  })

  it('does not read Ctrl+Shift as a clipboard chord on macOS', () => {
    // macOS never uses Ctrl+Shift for copy, and TUIs do bind it.
    expect(clipboardAction('darwin', shifted('c', { ctrlKey: true }), true)).toBe('ignore')
    expect(clipboardAction('darwin', shifted('v', { ctrlKey: true }), false)).toBe('ignore')
  })

  it('leaves the other Ctrl+Shift letters to the terminal', () => {
    const letters = 'abdefghklnopqrstuwxyz'.split('')
    for (const letter of letters) {
      expect(clipboardAction('linux', shifted(letter, { ctrlKey: true }), true)).toBe('ignore')
    }
  })

  it('ignores everything that is not a keydown', () => {
    // Claiming the keyup as well would leave xterm watching a chord that never
    // completed on the way down.
    expect(clipboardAction('linux', shifted('c', { ctrlKey: true, type: 'keyup' }), true)).toBe(
      'ignore'
    )
    expect(clipboardAction('darwin', key({ key: 'v', metaKey: true, type: 'keyup' }), false)).toBe(
      'ignore'
    )
  })
})
