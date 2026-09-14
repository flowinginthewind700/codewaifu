import { describe, expect, it } from 'vitest'
import { isOurHookCommand } from '../src/shared/hookScript'
import {
  mergeClaudeHooks,
  mergeCodexHooks,
  stripClaudeHooks,
  stripCodexHooks,
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
})
