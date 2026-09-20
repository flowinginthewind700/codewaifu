/**
 * Reading an agent's menu off its own screen, and compiling a row into one key.
 *
 * This is the fix for "I pressed Approve in the popup and nothing happened on
 * the conversation side". Two halves, both of which fail silently if wrong:
 *
 * - Which rows are on screen. The fixtures below are verbatim captures of codex's
 * own TUI snapshots, so the parser is tested against what the agent really
 * draws rather than against a hand-typed idea of it.
 * - Which key settles a row. Exactly one key, never a key plus Enter: a digit
 * selects *and accepts* in codex's list widget, so an appended Enter lands on
 * whatever the agent draws next, and the next view is usually another menu.
 */
import { describe, expect, it } from 'vitest'
import {
  dismissOption,
  firstOptionKeys,
  keysForOption,
  optionAction,
  parsePaneOptions,
  planAttentionAction
} from '../src/shared/pro'
import { attentionItem } from './helpers/pro'

const NOW = 1_700_000_000_000

/** codex `exec` approval: two approvals of different scope, and a refusal. */
const EXEC_APPROVAL = [
  '  Would you like to run the following command?',
  '',
  '  Reason: this is a test reason such as one that would be produced by the model',
  '',
  '  $ echo hello world',
  '',
  '',
  '\u203a 1. Yes, proceed (y)                                                        ',
  '  2. Yes, and don\'t ask again for commands that start with `echo hello world` (p)',
  '  3. No, and tell Codex what to do differently (esc)',
  '',
  '  Press enter to confirm or esc to cancel'
].join('\n')

/** codex permissions prompt: four rows, where the *last* one is the refusal. */
const PERMISSIONS = [
  '  Would you like to grant these permissions?',
  '',
  '  Reason: need workspace access',
  '',
  '  Permission rule: network; read `/tmp/readme.txt`; write `/tmp/out.txt`',
  '',
  '',
  '\u203a 1. Yes, grant these permissions for this turn (y)',
  '  2. Yes, grant for this turn with strict auto review (r)',
  '  3. Yes, grant these permissions for this session (a)',
  '  4. No, continue without permissions (d)',
  '',
  '  Press enter to confirm or esc to cancel'
].join('\n')

/**
 * codex `/model` style picker: no letter accelerators at all, and descriptions
 * wrapped onto continuation lines indented under the row above.
 */
const WRAPPED_PICKER = [
  '  Update Model Permissions',
  '',
  '',
  '\u203a 1. Ask for approval  Codex can read and edit files in the current workspace,',
  '                       and run commands. Approval is required to access the',
  '                       internet or edit other files.',
  '  2. Full Access       Codex can edit files outside this workspace and access',
  '                       the internet without asking for approval. Exercise',
  '                       caution when using.',
  '',
  '  enter select \u00b7 esc back'
].join('\n')

describe('parsePaneOptions: codex\'s own screens', () => {
  it('reads the exec approval as three rows with their accelerators', () => {
    const options = parsePaneOptions(EXEC_APPROVAL)
    expect(options.map((option) => option.index)).toEqual([1, 2, 3])
    expect(options.map((option) => option.shortcut)).toEqual(['y', 'p', 'esc'])
    // The second row is the one nobody may guess at: "don't ask again" is a
    // much bigger grant than "proceed", and its scope is in the label.
    expect(options[1].label).toContain("don't ask again for commands that start with")
    expect(options[0].label).toBe('Yes, proceed')
  })

  it('reads the permissions prompt as four rows, the refusal being the last', () => {
    const options = parsePaneOptions(PERMISSIONS)
    expect(options.map((option) => option.shortcut)).toEqual(['y', 'r', 'a', 'd'])
    // No row advertises `esc`, so "the deny row" is undecidable from the menu:
    // position is where the agent happened to put it, not what it means.
    expect(dismissOption(options)).toBeNull()
  })

  it('merges wrapped descriptions into the row they belong to', () => {
    const options = parsePaneOptions(WRAPPED_PICKER)
    expect(options).toHaveLength(2)
    expect(options[0].label).toContain('Codex can read and edit files in the current workspace,')
    expect(options[0].label).toContain('internet or edit other files.')
    expect(options[1].label).toContain('caution when using.')
    // No accelerators here at all, so the digit is the only key we can send.
    expect(options.every((option) => option.shortcut === undefined)).toBe(true)
    expect(keysForOption(options[1])).toEqual(['2'])
  })

  it('keeps trailing padding out of a label, since a padded row is a padded button', () => {
    const options = parsePaneOptions(EXEC_APPROVAL)
    expect(options[0].label.endsWith(' ')).toBe(false)
  })
})

describe('parsePaneOptions: what is not a menu', () => {
  it('reads nothing out of prose that happens to number a sentence', () => {
    // A single `1.` is a list in the agent's own summary, not a prompt with a
    // button in it. Two rows is the floor.
    expect(parsePaneOptions('1. First, install the toolchain and run the build')).toEqual([])
  })

  it('reads nothing out of a run that does not count up from 1', () => {
    expect(parsePaneOptions('  3. No\n  4. Maybe')).toEqual([])
  })

  it('treats `(default)` as an annotation, not as a seven-keystroke shortcut', () => {
    // codex prints `(default)`, `(current)` and `(recommended)` beside model and
    // effort rows. Sending the letters would type the word into the input line.
    const options = parsePaneOptions('  1. gpt-5-codex (default)\n  2. gpt-5-mini')
    expect(options).toHaveLength(2)
    expect(options[0].shortcut).toBeUndefined()
    expect(options[0].label).toBe('gpt-5-codex (default)')
    expect(keysForOption(options[0])).toEqual(['1'])
  })

  it('returns the last menu only, because the scrollback holds every old one', () => {
    const both = `${EXEC_APPROVAL}\n\n${PERMISSIONS}`
    const options = parsePaneOptions(both)
    expect(options).toHaveLength(4)
    expect(options[0].label).toBe('Yes, grant these permissions for this turn')
  })

  it('takes input that is not a string, because it arrives over IPC', () => {
    expect(parsePaneOptions(null)).toEqual([])
    expect(parsePaneOptions(undefined)).toEqual([])
    expect(parsePaneOptions('')).toEqual([])
  })

  it('accepts CRLF, which is what a pty on Windows hands us', () => {
    expect(parsePaneOptions(EXEC_APPROVAL.replace(/\n/g, '\r\n'))).toHaveLength(3)
  })
})

describe('keysForOption: one key, and never an Enter', () => {
  it('sends the accelerator when the row advertised one', () => {
    expect(keysForOption({ index: 1, label: 'Yes, proceed', shortcut: 'y' })).toEqual(['y'])
    expect(keysForOption({ index: 3, label: 'No', shortcut: 'esc' })).toEqual(['esc'])
  })

  it('sends the digit when the row advertised nothing', () => {
    expect(keysForOption({ index: 2, label: 'Full Access' })).toEqual(['2'])
  })

  it('sends nothing for a row we cannot address', () => {
    expect(keysForOption(null)).toEqual([])
    expect(keysForOption(undefined)).toEqual([])
    expect(keysForOption({ index: 0, label: 'odd' })).toEqual([])
  })

  it('never appends enter: a digit already accepts in codex', () => {
    // The failure this pins is quiet and expensive. A stray Enter confirms row 1
    // of whatever the agent draws *next*, and the next view is usually another
    // menu (pick a model, then pick an effort level).
    for (const option of parsePaneOptions(EXEC_APPROVAL)) {
      expect(keysForOption(option)).toHaveLength(1)
      expect(keysForOption(option)).not.toContain('enter')
    }
  })

  it('falls back to the first row for approve, and only to an `esc` row for deny', () => {
    const options = parsePaneOptions(EXEC_APPROVAL)
    expect(firstOptionKeys(options)).toEqual(['y'])
    expect(dismissOption(options)?.index).toBe(3)
    expect(dismissOption(parsePaneOptions(WRAPPED_PICKER))).toBeNull()
  })
})

describe('optionAction: which verb a row belongs to', () => {
  it('calls the `esc` row a denial and everything else an approval', () => {
    const options = parsePaneOptions(EXEC_APPROVAL)
    expect(options.map((option) => optionAction(option, options))).toEqual([
      'approve',
      'approve',
      'deny'
    ])
  })

  it('does not promote the last row to a denial when nothing says `esc`', () => {
    const options = parsePaneOptions(PERMISSIONS)
    // Row 4 reads "No, continue without permissions", but by our rule it is a
    // row we can only classify by position. Colour and ledger say approve-scope;
    // the *label* is what tells the human it is a refusal, and the key sent is
    // the row's own `d` either way.
    expect(options.map((option) => optionAction(option, options))).toEqual([
      'approve',
      'approve',
      'approve',
      'approve'
    ])
  })
})

describe('planAttentionAction: an explicit row', () => {
  const rows = parsePaneOptions(EXEC_APPROVAL)

  it('presses the row the human named, not the first one', () => {
    const plan = planAttentionAction({
      item: attentionItem({ options: rows }),
      action: 'approve',
      option: 2,
      now: NOW
    })
    expect(plan).toEqual({
      kind: 'keys',
      itemId: plan.kind === 'keys' ? plan.itemId : '',
      taskId: 't1',
      paneId: 'pane-1',
      keys: ['p'],
      preview: 'p'
    })
  })

  it('refuses a row that is not on screen rather than pressing the nearest one', () => {
    // Clamping 9 down to 3 would grant a scope the agent never offered, and
    // would do it in response to a click the human made on a stale card.
    const plan = planAttentionAction({
      item: attentionItem({ options: rows }),
      action: 'approve',
      option: 9,
      now: NOW
    })
    expect(plan).toMatchObject({ kind: 'none', code: 'no-option' })
  })

  it('falls back to the first row when approve carries no pick', () => {
    const plan = planAttentionAction({
      item: attentionItem({ options: rows }),
      action: 'approve',
      now: NOW
    })
    expect(plan.kind).toBe('keys')
    if (plan.kind === 'keys') expect(plan.keys).toEqual(['y'])
  })

  it('falls back to the `esc` row when deny carries no pick', () => {
    const plan = planAttentionAction({
      item: attentionItem({ options: rows }),
      action: 'deny',
      now: NOW
    })
    expect(plan.kind).toBe('keys')
    if (plan.kind === 'keys') expect(plan.keys).toEqual(['esc'])
  })

  it('falls back to the recipe when deny has no `esc` row to mean it', () => {
    const plan = planAttentionAction({
      item: attentionItem({ agentKind: 'codex', options: parsePaneOptions(PERMISSIONS) }),
      action: 'deny',
      now: NOW
    })
    expect(plan.kind).toBe('keys')
    if (plan.kind === 'keys') expect(plan.keys).not.toContain('4')
  })

  it('uses the recipe when no menu was read at all', () => {
    const plan = planAttentionAction({
      item: attentionItem({ agentKind: 'codex' }),
      action: 'approve',
      now: NOW
    })
    expect(plan.kind).toBe('keys')
    if (plan.kind === 'keys') expect(plan.keys.length).toBeGreaterThan(0)
  })

  it('still refuses to act on a pane that is gone', () => {
    const plan = planAttentionAction({
      item: attentionItem({ paneId: '', options: rows }),
      action: 'approve',
      option: 1,
      now: NOW
    })
    expect(plan).toMatchObject({ kind: 'none', code: 'no-pane' })
  })
})
