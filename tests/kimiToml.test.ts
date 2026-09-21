import { describe, expect, it } from 'vitest'
import {
  KIMI_HOOK_EVENTS,
  KIMI_HOOK_TIMEOUT_SECONDS,
  applyKimiHooks,
  isKimiManagedCommand,
  scanKimiEvents,
  stripKimiHooks
} from '../src/shared/kimiToml'

const SH = '/home/dev/.codewaifu/hooks/run-hook.sh'
const START = '# >>> codewaifu-managed-kimi-hooks (managed by CodeWaifu; do not edit) >>>'
const END = '# <<< codewaifu-managed-kimi-hooks <<<'

function command(event: string): string {
  return `if [ -f '${SH}' ]; then /bin/sh '${SH}' kimi ${event}; fi`
}

function commands(...events: string[]): Record<string, string> {
  return Object.fromEntries(events.map((event) => [event, command(event)]))
}

const USER_CONFIG = [
  'model = "k2"',
  '',
  '[hooks.custom]',
  'event = "Stop"',
  'command = "/usr/local/bin/my-own.sh"'
].join('\n')

/** How many `[[hooks]]` tables a config holds, ours or not. */
function tableCount(text: string): number {
  return text.split('\n').filter((line) => line.trim() === '[[hooks]]').length
}

describe('applyKimiHooks', () => {
  it('creates a config that does not exist yet', () => {
    const result = applyKimiHooks('', commands('Stop'))
    expect(result.changed).toBe(true)
    expect(result.text.startsWith(START)).toBe(true)
    expect(result.text.trimEnd().endsWith(END)).toBe(true)
    expect(result.text).toContain('event = "Stop"')
    expect(result.text).toContain(`timeout = ${KIMI_HOOK_TIMEOUT_SECONDS}`)
    expect(result.events).toEqual(['Stop'])
  })

  it('carries the user config through byte for byte, appending below it', () => {
    const result = applyKimiHooks(USER_CONFIG, commands('UserPromptSubmit'))
    expect(result.text.startsWith(`${USER_CONFIG}\n`)).toBe(true)
    expect(result.text).toContain('my-own.sh')
  })

  it('is idempotent: a second apply writes the same bytes', () => {
    const once = applyKimiHooks(USER_CONFIG, commands('UserPromptSubmit', 'PreToolUse', 'Stop'))
    expect(once.changed).toBe(true)
    const twice = applyKimiHooks(once.text, commands('UserPromptSubmit', 'PreToolUse', 'Stop'))
    expect(twice.changed).toBe(false)
    expect(twice.text).toBe(once.text)
    expect(twice.events).toEqual(once.events)
    expect(tableCount(twice.text)).toBe(3)
  })

  it('orders the tables by KIMI_HOOK_EVENTS, not by the argument order', () => {
    // A stable file order is what keeps install idempotent at all: the specs are
    // built from an object, whose key order the caller does not control.
    const result = applyKimiHooks('', commands('Stop', 'PreToolUse', 'UserPromptSubmit'))
    const at = (event: string): number => result.text.indexOf(`event = "${event}"`)
    expect(at('UserPromptSubmit')).toBeGreaterThan(-1)
    expect(at('UserPromptSubmit')).toBeLessThan(at('PreToolUse'))
    expect(at('PreToolUse')).toBeLessThan(at('Stop'))
    expect(result.events).toEqual(['PreToolUse', 'Stop', 'UserPromptSubmit'])
  })

  it('writes one table per subscribed event and no matcher key', () => {
    const all = applyKimiHooks('', commands(...KIMI_HOOK_EVENTS))
    expect(tableCount(all.text)).toBe(KIMI_HOOK_EVENTS.length)
    // Kimi reads `matcher` as a regex, so Claude's literal `*` would be invalid
    // there, and an absent matcher already matches every tool.
    expect(all.text).not.toContain('matcher')
    expect(all.events).toEqual([...KIMI_HOOK_EVENTS].sort())
  })

  it('ignores an event name it does not know, rather than inventing a table', () => {
    const result = applyKimiHooks('', { ...commands('Stop'), SessionStart: command('SessionStart') })
    expect(tableCount(result.text)).toBe(1)
    expect(result.text).not.toContain('SessionStart')
  })

  it('replaces the block wholesale when the hooks dir moved', () => {
    const once = applyKimiHooks(USER_CONFIG, commands('Stop'))
    // The command carries the path twice (the guard and the invocation), so a
    // single `replace` would leave half of it behind.
    const moved = applyKimiHooks(once.text, { Stop: command('Stop').split('/home/dev').join('/home/other') })
    expect(moved.changed).toBe(true)
    expect(tableCount(moved.text)).toBe(1)
    expect(moved.text).not.toContain('/home/dev')
    expect(moved.text).toContain('/home/other')
    expect(moved.text.startsWith(`${USER_CONFIG}\n`)).toBe(true)
  })

  it('removes the tables of an event the user unsubscribed from', () => {
    const once = applyKimiHooks('', commands('UserPromptSubmit', 'PreToolUse', 'Stop'))
    const fewer = applyKimiHooks(once.text, commands('Stop'))
    expect(tableCount(fewer.text)).toBe(1)
    expect(fewer.events).toEqual(['Stop'])
    expect(fewer.text).not.toContain('PreToolUse')
    // A dropped subscription must not take the file down to nothing.
    expect(fewer.text).toContain('event = "Stop"')
  })

  it('preserves CRLF line endings', () => {
    const crlf = USER_CONFIG.replace(/\n/g, '\r\n')
    const result = applyKimiHooks(crlf, commands('Stop'))
    expect(result.text.replace(/\r\n/g, '')).not.toContain('\n')
    expect(result.events).toEqual(['Stop'])
  })

  it('escapes the command so a path with a quote or backslash stays valid TOML', () => {
    const quoted = applyKimiHooks('', { Stop: 'if [ -f "/home/d"ev/.codewaifu/hooks/run-hook.sh" ]; then :; fi' })
    expect(quoted.text).toContain('\\"')
    expect(stripKimiHooks(quoted.text).text).toBe('')

    const backslashed = applyKimiHooks('', { Stop: 'C:\\Users\\dev\\.codewaifu\\hooks\\run-hook.sh' })
    expect(backslashed.text).toContain('\\\\')
    expect(backslashed.events).toEqual(['Stop'])
    expect(stripKimiHooks(backslashed.text).text).toBe('')
  })
})

describe('stripKimiHooks', () => {
  it('removes ours and leaves the user tables alone', () => {
    const installed = applyKimiHooks(USER_CONFIG, commands('UserPromptSubmit', 'PreToolUse', 'Stop')).text
    const stripped = stripKimiHooks(installed)
    expect(stripped.changed).toBe(true)
    expect(stripped.text.trim()).toBe(USER_CONFIG.trim())
    expect(stripped.text).not.toContain('.codewaifu')
  })

  it('returns an empty string when we were the whole file', () => {
    const installed = applyKimiHooks('', commands('Stop')).text
    expect(stripKimiHooks(installed)).toEqual({ text: '', changed: true })
  })

  it('is a no-op on a config that never had us', () => {
    expect(stripKimiHooks(USER_CONFIG)).toEqual({ text: USER_CONFIG, changed: false })
    expect(stripKimiHooks('').changed).toBe(false)
  })

  it('reclaims a table stranded outside the markers by recognising its command', () => {
    // Hand edits happen. The end marker is the only proof of the block's extent,
    // so once it is gone the tables themselves have to be the ownership signal:
    // a table we keep receiving events from must not be reported uninstalled.
    const installed = applyKimiHooks(USER_CONFIG, commands('UserPromptSubmit', 'Stop')).text
    const stranded = installed.replace(`${END}\n`, '')
    expect(stranded).not.toContain(END)
    expect(scanKimiEvents(stranded)).toEqual(['Stop', 'UserPromptSubmit'])
    const stripped = stripKimiHooks(stranded)
    expect(stripped.changed).toBe(true)
    expect(stripped.text.trim()).toBe(USER_CONFIG.trim())
  })

  it('lets a stranded start marker own only its own line', () => {
    // With no end marker the text below it is unknown; claiming it through EOF
    // would delete the user's own tables.
    const text = [START, '', '[hooks.custom]', 'event = "Stop"', 'command = "/usr/local/bin/my-own.sh"', ''].join('\n')
    const stripped = stripKimiHooks(text)
    expect(stripped.changed).toBe(true)
    expect(stripped.text).not.toContain(START)
    expect(stripped.text).toContain('[hooks.custom]')
    expect(stripped.text).toContain('my-own.sh')
  })

  it('fails closed when a table key run cannot be delimited', () => {
    // TOML allows blanks between the keys of one table, so a gap is not proof it
    // ended. Splicing only the part above the gap would strand the rest without
    // its header, so we touch nothing at all.
    const text = ['[[hooks]]', 'event = "Stop"', '', `command = "${command('Stop')}"`, ''].join('\n')
    expect(scanKimiEvents(text)).toEqual([])
    expect(stripKimiHooks(text)).toEqual({ text, changed: false })
  })

  it('removes a table whose event we cannot read but whose command is ours', () => {
    const text = ['[[hooks]]', `command = "${command('Stop')}"`, 'timeout = 5', ''].join('\n')
    expect(scanKimiEvents(text)).toEqual([])
    const stripped = stripKimiHooks(text)
    expect(stripped.changed).toBe(true)
    expect(stripped.text).toBe('')
  })

  it('round-trips: apply then strip restores the user file', () => {
    const installed = applyKimiHooks(USER_CONFIG, commands('UserPromptSubmit', 'PreToolUse', 'Stop')).text
    expect(stripKimiHooks(installed).text).toBe(`${USER_CONFIG}\n`)
  })
})

describe('scanKimiEvents', () => {
  it('reports nothing for a foreign, empty or malformed config', () => {
    expect(scanKimiEvents(USER_CONFIG)).toEqual([])
    expect(scanKimiEvents('')).toEqual([])
    expect(scanKimiEvents('[[hooks]]\nthis is not toml at all\n')).toEqual([])
    expect(scanKimiEvents('model = "k2"\n[[hooks]]\nevent = "Stop"\n')).toEqual([])
  })

  it('sorts, and counts a table wherever it sits in the file', () => {
    const installed = applyKimiHooks('', commands('Stop', 'PreToolUse', 'UserPromptSubmit')).text
    expect(scanKimiEvents(installed)).toEqual(['PreToolUse', 'Stop', 'UserPromptSubmit'])
    // Same tables, above a foreign `[[hooks]]` table instead of below the
    // user's own keys: recognition is per table, not per position.
    const moved = `${installed}\n[[hooks]]\nevent = "Stop"\ncommand = "/usr/local/bin/my-own.sh"\n`
    expect(scanKimiEvents(moved)).toEqual(['PreToolUse', 'Stop', 'UserPromptSubmit'])
  })

  it('ignores a table whose command is someone else\'s', () => {
    const text = [
      '[[hooks]]',
      'event = "Stop"',
      'command = "/usr/local/bin/my-own.sh"',
      '',
      '[[hooks]]',
      'event = "PreToolUse"',
      `command = "${command('PreToolUse')}"`,
      ''
    ].join('\n')
    expect(scanKimiEvents(text)).toEqual(['PreToolUse'])
  })
})

describe('isKimiManagedCommand', () => {
  it('recognises our runner and nothing that merely looks like it', () => {
    expect(isKimiManagedCommand(command('Stop'))).toBe(true)
    expect(isKimiManagedCommand('C:\\Users\\dev\\.codewaifu\\hooks\\run-hook.cmd')).toBe(true)
    expect(isKimiManagedCommand('/bin/sh /home/dev/.codewaifu-ish/hooks/run.sh')).toBe(false)
    expect(isKimiManagedCommand('/usr/local/bin/my-own.sh')).toBe(false)
    expect(isKimiManagedCommand(undefined)).toBe(false)
    expect(isKimiManagedCommand(42 as unknown as string)).toBe(false)
  })
})
