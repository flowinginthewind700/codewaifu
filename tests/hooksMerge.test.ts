import { describe, expect, it } from 'vitest'
import {
  hookCommand,
  hookCommandWindows,
  isOurHookCommand,
  runnerPaths
} from '../src/shared/hookScript'
import {
  ANTIGRAVITY_BUNDLE,
  mergeClaudeHooks,
  mergeCodexHooks,
  mergeAntigravityHooks,
  mergeCursorHooks,
  mergeZcodeHooks,
  scanFlatEvents,
  scanZcodeEvents,
  stripClaudeHooks,
  stripCodexHooks,
  stripAntigravityHooks,
  stripCursorHooks,
  stripZcodeHooks,
  type HookSpec
} from '../src/shared/hooksMerge'

const SH = '/Users/dev/.codewaifu/hooks/run-hook.sh'
const CMD = 'C:\\Users\\dev\\.codewaifu\\hooks\\hook-codex.cmd'
const ORCA = "if [ -x '/Users/dev/.orca/agent-hooks/claude-hook.sh' ]; then /bin/sh '/Users/dev/.orca/agent-hooks/claude-hook.sh'; fi"

function codexCommand(): string {
  return `if [ -f '${SH}' ]; then /bin/sh '${SH}' codex; fi`
}

function specs(): HookSpec[] {
  return [
    { event: 'SessionStart', matcher: 'startup|resume|clear|compact', command: codexCommand(), timeout: 5, async: true },
    { event: 'Stop', command: codexCommand(), timeout: 5, async: true }
  ]
}

/** The real shape of a machine that already runs orca's Claude Code hooks. */
function orcaClaudeSettings(): Record<string, unknown> {
  return {
    enabledPlugins: { 'some-plugin@marketplace': true },
    env: { ANTHROPIC_MODEL: 'x' },
    includeCoAuthoredBy: false,
    hooks: {
      PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: ORCA, timeout: 10 }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: ORCA, timeout: 10 }] }],
      PostToolUseFailure: [{ matcher: '*', hooks: [{ type: 'command', command: ORCA, timeout: 10 }] }],
      Stop: [{ hooks: [{ type: 'command', command: ORCA, timeout: 10 }] }],
      StopFailure: [{ hooks: [{ type: 'command', command: ORCA, timeout: 10 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: ORCA, timeout: 10 }] }]
    }
  }
}

type HookEntryJson = { type?: string; command?: string; timeout?: number }
type HookGroupJson = { matcher?: string; hooks: HookEntryJson[] }
type HooksJson = { hooks?: Record<string, HookGroupJson[]> }

function hookCommands(json: unknown, event: string): string[] {
  const hooks = (json as HooksJson).hooks
  return (hooks?.[event] || []).flatMap((group) => group.hooks.map((h) => h.command || ''))
}

describe('mergeClaudeHooks', () => {
  it('keeps every unrelated key and every other tool\'s hook entry', () => {
    const before = orcaClaudeSettings()
    const result = mergeClaudeHooks(before, specs())
    const json = result.json as Record<string, unknown>
    expect(json.enabledPlugins).toEqual(before.enabledPlugins)
    expect(json.env).toEqual(before.env)
    expect(json.includeCoAuthoredBy).toBe(false)
    // orca's entries survive in all six of its events, including the two we also use.
    for (const event of ['PermissionRequest', 'PreToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'UserPromptSubmit']) {
      expect(hookCommands(json, event), event).toContain(ORCA)
    }
    expect(hookCommands(json, 'Stop')).toContain(codexCommand())
    expect(hookCommands(json, 'SessionStart')).toEqual([codexCommand()])
  })

  it('is idempotent: installing twice changes nothing the second time', () => {
    const once = mergeClaudeHooks(orcaClaudeSettings(), specs())
    expect(once.changed).toBe(true)
    const twice = mergeClaudeHooks(once.json, specs())
    expect(twice.changed).toBe(false)
    expect(JSON.stringify(twice.json)).toBe(JSON.stringify(once.json))
    expect(twice.events).toEqual(once.events)
  })

  it('replaces a stale entry instead of stacking duplicates when the command changes', () => {
    const once = mergeClaudeHooks(orcaClaudeSettings(), specs())
    const moved = specs().map((spec) => ({ ...spec, command: spec.command.replace('/Users/dev', '/Users/other') }))
    const again = mergeClaudeHooks(once.json, moved)
    expect(again.changed).toBe(true)
    const ours = hookCommands(again.json, 'Stop').filter(isOurHookCommand)
    expect(ours).toHaveLength(1)
    expect(ours[0]).toContain('/Users/other')
  })

  it('reports the events it now owns', () => {
    const result = mergeClaudeHooks(orcaClaudeSettings(), specs())
    expect(result.events).toEqual(['SessionStart', 'Stop'])
  })

  it('creates a file that does not exist yet', () => {
    const result = mergeClaudeHooks(null, specs())
    expect(result.changed).toBe(true)
    expect(hookCommands(result.json, 'Stop')).toEqual([codexCommand()])
  })

  it('leaves a non-array event alone and warns instead of throwing', () => {
    const result = mergeClaudeHooks({ hooks: { Stop: 'not an array' } }, specs())
    expect(result.warnings.join(' ')).toContain('Stop')
    expect((result.json as { hooks: Record<string, unknown> }).hooks.Stop).toBe('not an array')
  })

  it('survives a config that is not an object', () => {
    for (const junk of [null, undefined, 42, 'text', []]) {
      const result = mergeClaudeHooks(junk, specs())
      expect(hookCommands(result.json, 'Stop')).toEqual([codexCommand()])
    }
  })
})

describe('stripClaudeHooks', () => {
  it('removes only our entries and deletes the hooks key when nothing is left', () => {
    const installed = mergeClaudeHooks(orcaClaudeSettings(), specs()).json
    const stripped = stripClaudeHooks(installed)
    expect(stripped.changed).toBe(true)
    expect(stripped.events).toEqual([])
    expect(hookCommands(stripped.json, 'Stop')).toEqual([ORCA])
    expect((stripped.json as Record<string, unknown>).hooks).toBeDefined()
    expect(JSON.stringify(stripped.json)).not.toContain('.codewaifu')
  })

  it('drops the empty hooks object when we were the only entry', () => {
    const installed = mergeClaudeHooks({}, specs()).json
    const stripped = stripClaudeHooks(installed)
    expect((stripped.json as Record<string, unknown>).hooks).toBeUndefined()
  })

  it('is a no-op on a config that never had us', () => {
    expect(stripClaudeHooks(orcaClaudeSettings()).changed).toBe(false)
    expect(stripClaudeHooks({}).changed).toBe(false)
  })

  it('round-trips: merge then strip restores the original file', () => {
    const before = orcaClaudeSettings()
    const after = stripClaudeHooks(mergeClaudeHooks(before, specs()).json)
    expect(JSON.parse(JSON.stringify(after.json))).toEqual(JSON.parse(JSON.stringify(before)))
  })
})

describe('mergeCodexHooks', () => {
  it('adds a description and only the two keys Codex accepts', () => {
    const result = mergeCodexHooks(null, specs())
    const json = result.json as Record<string, unknown>
    expect(Object.keys(json).sort()).toEqual(['description', 'hooks'])
    expect(typeof json.description).toBe('string')
  })

  it('keeps an existing description and warns about unexpected top-level keys', () => {
    const result = mergeCodexHooks({ description: 'mine', model_provider: 'x' }, specs())
    const json = result.json as Record<string, unknown>
    expect(json.description).toBe('mine')
    expect(json.model_provider).toBe('x')
    expect(result.warnings.join(' ')).toContain('model_provider')
  })

  it('carries the Windows command and async flag Codex needs', () => {
    const winSpecs: HookSpec[] = [
      { event: 'Stop', command: codexCommand(), commandWindows: `cmd /c "${CMD}"`, timeout: 5, async: true }
    ]
    const json = mergeCodexHooks(null, winSpecs).json as {
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>
    }
    const entry = json.hooks.Stop[0].hooks[0]
    expect(entry).toMatchObject({ type: 'command', async: true, timeout: 5 })
    expect(entry.commandWindows).toContain('hook-codex.cmd')
  })

  it('is idempotent and strips cleanly', () => {
    const once = mergeCodexHooks(null, specs())
    expect(mergeCodexHooks(once.json, specs()).changed).toBe(false)
    const stripped = stripCodexHooks(once.json)
    expect(stripped.changed).toBe(true)
    expect(JSON.stringify(stripped.json)).not.toContain('.codewaifu')
  })
})

describe('isOurHookCommand', () => {
  it('recognises our runners on both platforms and nothing else', () => {
    expect(isOurHookCommand(codexCommand())).toBe(true)
    expect(isOurHookCommand(`cmd /c "${CMD}"`)).toBe(true)
    expect(isOurHookCommand(ORCA)).toBe(false)
    expect(isOurHookCommand('/bin/true')).toBe(false)
    expect(isOurHookCommand(undefined)).toBe(false)
    expect(isOurHookCommand(42)).toBe(false)
    // A lookalike path must not be claimed, or uninstall would eat it.
    expect(isOurHookCommand("/bin/sh '/Users/dev/.codewaifu-ish/hooks/run.sh'")).toBe(false)
  })

  it('recognises every command shape a relocated state dir produces', () => {
    /*
     * `CODEWAIFU_HOME` moves the hooks dir, and then `.codewaifu` is not in the
     * command any more. Recognition by state-dir name alone called those
     * foreign, which is not cosmetic: `stripOurs` keeps them, so every install
     * appended another copy of each event and uninstall left them all behind -
     * and on Cursor and Antigravity each stale copy prints
     * `{"permission":"ask"}`, so N copies meant N prompts for one tool call.
     *
     * Built from `hookCommand`/`hookCommandWindows` rather than spelled out, so
     * this sweeps the shapes the installer actually writes - stub and stubless,
     * silent and decision-printing - instead of the ones remembered here.
     */
    const posix = runnerPaths('/data/cw-state/hooks', 'linux', ['cursor:preToolUse'])
    const win = runnerPaths('C:\\cw-state\\hooks', 'win32', ['cursor:preToolUse'])
    const generated = [
      hookCommand(posix, 'codex', 'linux', 'Stop'),
      hookCommand(posix, 'cursor', 'linux', 'preToolUse'),
      hookCommandWindows(win, 'codex', 'win32'),
      hookCommandWindows(win, 'cursor', 'win32', 'preToolUse')
    ]
    for (const command of generated) {
      // The point of the case: none of these carries the state-dir name.
      expect(command, `this one still says .codewaifu: ${command}`).not.toContain('.codewaifu')
      expect(isOurHookCommand(command), command).toBe(true)
    }
    // Still path-shaped, so another tool's runner of the same name is not ours.
    expect(isOurHookCommand("/bin/sh '/Users/dev/.orca/agent-hooks/run-hook.sh'")).toBe(false)
    expect(isOurHookCommand('/Users/dev/.superpowers/hooks/run-hook.shx')).toBe(false)
    expect(isOurHookCommand('/Users/dev/hooks/run-hook.sh.bak')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Flat-definition schemas. Cursor puts `command` straight on the definition and
// Antigravity does the same for its non-tool events, so the group-based merge
// above cannot see our entries there: `normalizeGroup` hands it an empty `hooks`
// array, which is also how it recognizes someone else's shape. Without these,
// our own entries would survive every strip and duplicate on every install.
// ---------------------------------------------------------------------------

function cursorCommand(event: string): string {
  return `if [ -f '${SH}' ]; then /bin/sh '${SH}' cursor ${event}; fi`
}

/** Same runner, ZCode's agent name. Ownership is by path, not by agent. */
function zcodeCommand(event: string): string {
  return `if [ -f '${SH}' ]; then /bin/sh '${SH}' zcode ${event}; fi`
}

/** Cursor specs, as `buildSpecs` emits them: flat, no matcher, one event each. */
function cursorSpecs(): HookSpec[] {
  return [
    { event: 'beforeSubmitPrompt', command: cursorCommand('beforeSubmitPrompt'), timeout: 5, flat: true },
    { event: 'preToolUse', command: cursorCommand('preToolUse'), timeout: 5, flat: true },
    { event: 'stop', command: cursorCommand('stop'), timeout: 5, flat: true }
  ]
}

type DefJson = Record<string, unknown>
type FlatJson = { version?: unknown; hooks?: Record<string, DefJson[]> }

function flatCommands(json: unknown, event: string): string[] {
  const hooks = (json as FlatJson).hooks
  return (hooks?.[event] || []).map((def) => String(def.command ?? ''))
}

describe('mergeCursorHooks', () => {
  it('writes the command onto the definition, not under a hooks array', () => {
    const result = mergeCursorHooks(null, cursorSpecs())
    const json = result.json as FlatJson
    expect(json.hooks?.preToolUse).toEqual([{ command: cursorCommand('preToolUse'), timeout: 5 }])
    expect(result.events).toEqual(['beforeSubmitPrompt', 'preToolUse', 'stop'])
    // The nested shape is what Cursor rejects, so assert it is really absent
    // rather than merely unexercised by the equality check above.
    expect(JSON.stringify(json)).not.toContain('"hooks":[{')
  })

  it('adds the required version only when it is absent', () => {
    // A hooks.json without `version` is rejected outright by Cursor.
    expect((mergeCursorHooks(null, cursorSpecs()).json as FlatJson).version).toBe(1)
    expect((mergeCursorHooks({ hooks: {} }, cursorSpecs()).json as FlatJson).version).toBe(1)
    const pinned = mergeCursorHooks({ version: 2 }, cursorSpecs())
    expect((pinned.json as FlatJson).version).toBe(2)
  })

  it('keeps another tool\'s flat definitions beside ours', () => {
    const other = { command: ORCA, timeout: 10 }
    const before = { version: 1, hooks: { stop: [other], preToolUse: [other] } }
    const json = mergeCursorHooks(before, cursorSpecs()).json as FlatJson
    expect(flatCommands(json, 'stop')).toEqual([ORCA, cursorCommand('stop')])
    expect(flatCommands(json, 'preToolUse')).toEqual([ORCA, cursorCommand('preToolUse')])
    expect(flatCommands(json, 'beforeSubmitPrompt')).toEqual([cursorCommand('beforeSubmitPrompt')])
  })

  it('is idempotent and never stacks a second definition', () => {
    const once = mergeCursorHooks(null, cursorSpecs())
    expect(once.changed).toBe(true)
    const twice = mergeCursorHooks(once.json, cursorSpecs())
    expect(twice.changed).toBe(false)
    expect(JSON.stringify(twice.json)).toBe(JSON.stringify(once.json))
    expect(flatCommands(twice.json, 'stop')).toHaveLength(1)
  })

  it('sweeps an event this build stopped subscribing to', () => {
    const once = mergeCursorHooks(null, cursorSpecs())
    const fewer = mergeCursorHooks(once.json, cursorSpecs().slice(0, 1))
    expect(fewer.changed).toBe(true)
    expect(Object.keys((fewer.json as FlatJson).hooks || {})).toEqual(['beforeSubmitPrompt'])
    expect(fewer.events).toEqual(['beforeSubmitPrompt'])
  })

  it('replaces a stale command when the hooks dir moved', () => {
    const once = mergeCursorHooks(null, cursorSpecs())
    const moved = cursorSpecs().map((spec) => ({
      ...spec,
      command: spec.command.split('/Users/dev').join('/Users/other')
    }))
    const again = mergeCursorHooks(once.json, moved)
    const ours = flatCommands(again.json, 'stop').filter(isOurHookCommand)
    expect(ours).toHaveLength(1)
    expect(ours[0]).toContain('/Users/other')
  })

  it('leaves a non-array event alone and warns', () => {
    const result = mergeCursorHooks({ version: 1, hooks: { stop: 'nope' } }, cursorSpecs())
    expect((result.json as FlatJson).hooks?.stop).toBe('nope')
    expect(result.warnings.join(' ')).toContain('stop')
    expect(flatCommands(result.json, 'preToolUse')).toEqual([cursorCommand('preToolUse')])
  })

  it('strips back to the user file and deletes the empty hooks key', () => {
    const other = { command: ORCA, timeout: 10 }
    const before = { version: 1, hooks: { stop: [other] } }
    const installed = mergeCursorHooks(before, cursorSpecs()).json
    const stripped = stripCursorHooks(installed)
    expect(stripped.changed).toBe(true)
    expect(stripped.events).toEqual([])
    expect(flatCommands(stripped.json, 'stop')).toEqual([ORCA])
    expect(JSON.stringify(stripped.json)).not.toContain('.codewaifu')

    const only = stripCursorHooks(mergeCursorHooks(null, cursorSpecs()).json)
    expect((only.json as FlatJson).hooks).toBeUndefined()
    // `version` is the user's key; removing our hooks does not remove it.
    expect((only.json as FlatJson).version).toBe(1)
  })

  it('round-trips and scans', () => {
    const before = { version: 1, hooks: { stop: [{ command: ORCA, timeout: 10 }] } }
    const installed = mergeCursorHooks(before, cursorSpecs()).json
    expect(scanFlatEvents(installed)).toEqual(['beforeSubmitPrompt', 'preToolUse', 'stop'])
    expect(stripCursorHooks(installed).json).toEqual(before)
  })

  it('survives junk in place of a config', () => {
    for (const junk of [null, undefined, 42, 'text', []]) {
      const result = mergeCursorHooks(junk, cursorSpecs())
      expect(flatCommands(result.json, 'stop')).toEqual([cursorCommand('stop')])
      expect(() => stripCursorHooks(junk)).not.toThrow()
    }
  })
})

/** Antigravity mixes both shapes: tool events nest, the rest do not. */
function antigravitySpecs(): HookSpec[] {
  return [
    { event: 'PreInvocation', command: cursorCommand('PreInvocation'), timeout: 5, flat: true, flatType: 'command' },
    { event: 'PreToolUse', matcher: '*', command: cursorCommand('PreToolUse'), timeout: 5 },
    { event: 'Stop', command: cursorCommand('Stop'), timeout: 5, flat: true, flatType: 'command' }
  ]
}

type BundleJson = Record<string, Record<string, DefJson[]>>

function bundleDefs(json: unknown, event: string): DefJson[] {
  return ((json as BundleJson)[ANTIGRAVITY_BUNDLE]?.[event] || []) as DefJson[]
}

describe('mergeAntigravityHooks', () => {
  it('lives entirely under the named bundle key', () => {
    const result = mergeAntigravityHooks(null, antigravitySpecs())
    const json = result.json as BundleJson
    expect(Object.keys(json)).toEqual([ANTIGRAVITY_BUNDLE])
    expect(json[ANTIGRAVITY_BUNDLE].PreInvocation).toEqual([
      { command: cursorCommand('PreInvocation'), type: 'command', timeout: 5 }
    ])
    expect(json[ANTIGRAVITY_BUNDLE].PreToolUse).toEqual([
      { matcher: '*', hooks: [{ type: 'command', command: cursorCommand('PreToolUse'), timeout: 5 }] }
    ])
    expect(result.events).toEqual(['PreInvocation', 'PreToolUse', 'Stop'])
  })

  it('leaves other top-level keys and other bundles untouched', () => {
    const before = {
      projectHooks: { Stop: [{ command: ORCA }] },
      superpowers: { Stop: [{ command: '/x/.superpowers/hooks/s.sh' }] }
    }
    const installed = mergeAntigravityHooks(before, antigravitySpecs())
    const json = installed.json as BundleJson
    expect(json.projectHooks).toEqual(before.projectHooks)
    expect(json.superpowers).toEqual(before.superpowers)
    expect(installed.events).toEqual(['PreInvocation', 'PreToolUse', 'Stop'])
  })

  it('keeps another tool inside our bundle key, and is idempotent', () => {
    const before = { [ANTIGRAVITY_BUNDLE]: { Stop: [{ command: ORCA, timeout: 10 }] } }
    const once = mergeAntigravityHooks(before, antigravitySpecs())
    expect(bundleDefs(once.json, 'Stop').map((def) => def.command)).toEqual([ORCA, cursorCommand('Stop')])
    const twice = mergeAntigravityHooks(once.json, antigravitySpecs())
    expect(twice.changed).toBe(false)
    expect(JSON.stringify(twice.json)).toBe(JSON.stringify(once.json))
  })

  it('deletes the bundle key outright once strip empties it', () => {
    const installed = mergeAntigravityHooks(null, antigravitySpecs()).json
    const stripped = stripAntigravityHooks(installed)
    expect(stripped.changed).toBe(true)
    expect(stripped.events).toEqual([])
    expect((stripped.json as BundleJson)[ANTIGRAVITY_BUNDLE]).toBeUndefined()
    expect(JSON.stringify(stripped.json)).not.toContain('.codewaifu')
  })

  it('keeps the bundle key when another tool still lives in it', () => {
    const before = { [ANTIGRAVITY_BUNDLE]: { Stop: [{ command: ORCA }] } }
    const stripped = stripAntigravityHooks(mergeAntigravityHooks(before, antigravitySpecs()).json)
    expect((stripped.json as BundleJson)[ANTIGRAVITY_BUNDLE].Stop).toEqual([{ command: ORCA }])
  })

  it('scans through the bundle key only', () => {
    const json = mergeAntigravityHooks(null, antigravitySpecs()).json
    expect(scanFlatEvents(json, ANTIGRAVITY_BUNDLE)).toEqual(['PreInvocation', 'PreToolUse', 'Stop'])
    // Without the key it reads `hooks`, which this schema does not have.
    expect(scanFlatEvents(json)).toEqual([])
    expect(scanFlatEvents(null, ANTIGRAVITY_BUNDLE)).toEqual([])
  })
})

describe('mergeClaudeHooks for Gemini', () => {
  // Gemini reads Claude's nested shape out of `~/.gemini/settings.json`, with
  // one difference that bites: its `timeout` is milliseconds, not seconds.
  const geminiSpecs: HookSpec[] = [
    { event: 'BeforeAgent', matcher: 'startup', command: cursorCommand('BeforeAgent'), timeout: 5000 },
    { event: 'AfterTool', command: cursorCommand('AfterTool'), timeout: 5000 }
  ]

  it('passes the millisecond timeout through untouched', () => {
    const json = mergeClaudeHooks(null, geminiSpecs).json as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>
    }
    expect(json.hooks.BeforeAgent[0]).toMatchObject({ matcher: 'startup' })
    expect(json.hooks.BeforeAgent[0].hooks[0]).toMatchObject({
      type: 'command',
      command: cursorCommand('BeforeAgent'),
      timeout: 5000
    })
    expect(json.hooks.AfterTool[0].matcher).toBeUndefined()
    expect(json.hooks.AfterTool[0].hooks[0].timeout).toBe(5000)
  })

  it('keeps Gemini user keys, is idempotent and strips cleanly', () => {
    const before = { theme: 'ansi', selectedAuthType: 'oauth-personal' }
    const once = mergeClaudeHooks(before, geminiSpecs)
    const json = once.json as Record<string, unknown>
    expect(json.theme).toBe('ansi')
    expect(json.selectedAuthType).toBe('oauth-personal')
    expect(mergeClaudeHooks(once.json, geminiSpecs).changed).toBe(false)
    expect(stripClaudeHooks(once.json).json).toEqual(before)
  })
})

describe('mergeZcodeHooks', () => {
  // `~/.zcode/cli/config.json` is ZCode's whole configuration - provider, model,
  // permission, storage - with hooks one level deeper than Claude's: under
  // `hooks.events.<Event>[].hooks[]`. Inside `events` the shape is Claude's
  // exactly, so what is worth pinning here is the wrapper: the keys around it,
  // the switch inside it, and what strip leaves behind.
  const zcodeSpecs: HookSpec[] = [
    { event: 'SessionStart', command: zcodeCommand('SessionStart'), timeout: 5, timeoutMs: 5000, async: true },
    { event: 'Stop', command: zcodeCommand('Stop'), timeout: 5, timeoutMs: 5000, async: true }
  ]

  /** The real shape of a machine that already configured ZCode, minus hooks. */
  function userConfig(): Record<string, unknown> {
    return {
      provider: 'glm',
      model: 'glm-4.6',
      hooks: { timeoutMs: 3000, maxOutputBytes: 4096 }
    }
  }

  function eventsOf(json: unknown): Record<string, HookGroupJson[]> {
    const hooks = (json as { hooks?: { events?: Record<string, HookGroupJson[]> } }).hooks
    return hooks?.events ?? {}
  }

  function zcodeCommands(json: unknown, event: string): string[] {
    return (eventsOf(json)[event] || []).flatMap((group) => group.hooks.map((h) => h.command || ''))
  }

  it('turns hooks on, because the default is off and nothing would run', () => {
    // The failure this prevents is invisible: a config that looks installed,
    // hooks ZCode never runs, and no error anywhere to find.
    const json = mergeZcodeHooks(userConfig(), zcodeSpecs).json as {
      hooks: { enabled?: boolean }
    }
    expect(json.hooks.enabled).toBe(true)
    expect((eventsOf(json).Stop[0].hooks[0] as Record<string, unknown>)).toMatchObject({
      type: 'command',
      command: zcodeCommand('Stop'),
      timeout: 5,
      timeoutMs: 5000,
      async: true
    })
  })

  it('keeps every root key and every wrapper key the user had', () => {
    const json = mergeZcodeHooks(userConfig(), zcodeSpecs).json as Record<string, unknown>
    expect(json.provider).toBe('glm')
    expect(json.model).toBe('glm-4.6')
    const hooks = json.hooks as Record<string, unknown>
    expect(hooks.timeoutMs).toBe(3000)
    expect(hooks.maxOutputBytes).toBe(4096)
  })

  it('keeps another tool inside the same event, and is idempotent', () => {
    const before = {
      hooks: {
        enabled: true,
        events: { Stop: [{ hooks: [{ type: 'command', command: ORCA, timeout: 10 }] }] }
      }
    }
    const once = mergeZcodeHooks(before, zcodeSpecs)
    expect(zcodeCommands(once.json, 'Stop')).toEqual([ORCA, zcodeCommand('Stop')])
    expect(mergeZcodeHooks(once.json, zcodeSpecs).changed).toBe(false)
    // Stripping takes ours and leaves theirs running.
    const after = stripZcodeHooks(once.json)
    expect(zcodeCommands(after.json, 'Stop')).toEqual([ORCA])
    expect((after.json as { hooks: { enabled?: boolean } }).hooks.enabled).toBe(true)
  })

  it('clears `enabled` only once no events are left, and drops `hooks` then', () => {
    const installed = mergeZcodeHooks(null, zcodeSpecs).json
    const stripped = stripZcodeHooks(installed)
    // A file we created goes back to ZCode's own default: no events, not enabled,
    // and no empty wrapper left behind to imply we configured something.
    expect(stripped.json).toEqual({})
    expect(stripped.changed).toBe(true)
    // A user who enabled hooks of their own keeps them enabled.
    const theirs = { hooks: { enabled: true, events: { Stop: [{ hooks: [{ type: 'command', command: ORCA }] }] } } }
    const mixed = stripZcodeHooks(mergeZcodeHooks(theirs, zcodeSpecs).json)
    expect((mixed.json as { hooks: { enabled?: boolean } }).hooks.enabled).toBe(true)
  })

  it('scans through the wrapper, and only for entries of ours', () => {
    expect(scanZcodeEvents(null)).toEqual([])
    expect(scanZcodeEvents({ provider: 'glm' })).toEqual([])
    expect(scanZcodeEvents(mergeZcodeHooks(null, zcodeSpecs).json)).toEqual(['SessionStart', 'Stop'])
    // A foreign hook in the same event is not ours to report.
    const foreign = { hooks: { events: { Stop: [{ hooks: [{ type: 'command', command: ORCA }] }] } } }
    expect(scanZcodeEvents(foreign)).toEqual([])
  })

  it('leaves a non-array event alone and warns, and survives junk', () => {
    const junk = { hooks: { events: { Stop: 'nope' } } }
    const result = mergeZcodeHooks(junk, zcodeSpecs)
    expect(result.warnings.join(' ')).toContain('Stop')
    expect((eventsOf(result.json).Stop as unknown)).toBe('nope')
    expect(mergeZcodeHooks('not a config', zcodeSpecs).json).toBeTruthy()
    expect(stripZcodeHooks('not a config').json).toEqual({})
  })

  it('round-trips: merge then strip restores the user file', () => {
    const before = userConfig()
    expect(stripZcodeHooks(mergeZcodeHooks(before, zcodeSpecs).json).json).toEqual({
      provider: 'glm',
      model: 'glm-4.6',
      hooks: { timeoutMs: 3000, maxOutputBytes: 4096 }
    })
  })
})
