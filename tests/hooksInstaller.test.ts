import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, parseConfig, type AppConfig, type EventToggles } from '../src/shared/config'
import { normalizeHook, planEvent } from '../src/shared/hookEvent'
import {
  buildKimiCommands,
  buildSpecs,
  type HookAgent,
  type PluginAgent
} from '../src/main/hooksInstaller'

const rng = (): number => 0

// Derived from the config defaults, not a hand-written list: a toggle added to
// `EventToggles` without an EVENT_MAP row would otherwise pass this file while
// installing nothing, which is exactly the failure mode worth catching here.
const TOGGLES = Object.keys(DEFAULT_CONFIG.events) as Array<keyof EventToggles>

// Kimi's config is TOML and OpenCode/Pi have no config at all, so the agents that
// go through `buildSpecs` are the rest. Keeping this derived from the exported
// types means a new plugin-shaped agent cannot slip into the list unnoticed.
const JSON_AGENTS: Array<Exclude<HookAgent, 'kimi' | PluginAgent>> = [
  'codex',
  'claude',
  'cursor',
  'gemini',
  'antigravity',
  'zcode',
  'kiro',
  'trae'
]

/** Kinds that are logged and never read aloud; see the assertion that uses them. */
const UNSPOKEN_KINDS = new Set(['session_end', 'prompt'])

/** Config with exactly one toggle on, so a toggle can only be tested by itself. */
function onlyToggle(toggle: keyof EventToggles): AppConfig {
  return parseConfig({ token: 'x'.repeat(20), events: togglesOn(toggle) })
}

/** Every toggle off except the named one (or none named, for all-off). */
function togglesOn(only?: keyof EventToggles): EventToggles {
  const events = {} as EventToggles
  for (const key of TOGGLES) events[key] = key === only
  return events
}

describe('buildSpecs', () => {
  it('installs nothing when every toggle is off', () => {
    const off = parseConfig({ token: 'x'.repeat(20), events: togglesOn() })
    for (const agent of JSON_AGENTS) expect(buildSpecs(off, agent)).toEqual([])
    expect(buildKimiCommands(off)).toEqual({})
  })

  it('gives every toggle that installs events a voice', () => {
    // Half of the invariant both mapping bugs broke. Installing a hook under a
    // toggle and then announcing it under a kind that no toggle owns leaves the
    // event written into the config and permanently mute: that was Gemini's
    // `AfterAgent` mapped to `session_end`, so a Gemini turn finishing was
    // installed under `stop` and never spoken while the UI said stop events were
    // on. One toggle at a time is what makes the silence attributable.
    //
    // `prompt` is exempt by design - the human just typed it, so it is logged
    // rather than read back to them - but every other row has to speak.
    const mute: string[] = []
    for (const toggle of TOGGLES) {
      if (toggle === 'prompt') continue
      const config = onlyToggle(toggle)
      for (const agent of JSON_AGENTS) {
        const specs = buildSpecs(config, agent)
        if (specs.length === 0) continue
        const voiced = specs.some((spec) => planEvent(config, normalizeHook(agent, {}, 5, '', spec.event), { rng }).speak)
        if (voiced) continue
        mute.push(`${agent} (${toggle}): ${specs.map((spec) => spec.event).join(', ')}`)
      }
    }
    expect(mute).toEqual([])
  })

  it('announces each event under the toggle that installed it', () => {
    // The other half. An event whose kind belongs to a *different* row is not
    // governed by the toggle that installs it: Cursor's `preToolUse` under
    // `permission` read as a tool call, so turning permission off silenced
    // nothing and the tool toggle (off by default) could not reach it either.
    // Deliberately unspoken kinds are named here so the exemption cannot grow:
    // `session_end` has no toggle, and `prompt` is never read aloud.
    const stray: string[] = []
    for (const toggle of TOGGLES) {
      const config = onlyToggle(toggle)
      for (const agent of JSON_AGENTS) {
        for (const spec of buildSpecs(config, agent)) {
          const event = normalizeHook(agent, {}, 5, '', spec.event)
          if (UNSPOKEN_KINDS.has(event.kind)) continue
          if (planEvent(config, event, { rng }).speak) continue
          stray.push(`${agent}:${spec.event} (${toggle} -> ${event.kind})`)
        }
      }
    }
    expect(stray).toEqual([])
  })

  it('installs the moment an agent finishes under the stop toggle', () => {
    // The reported regression: Gemini's `AfterAgent` was mapped to `session_end`,
    // so a Gemini turn finishing was written into settings.json and then never
    // announced, while the UI said stop events were on.
    const config = onlyToggle('stop')
    const events = buildSpecs(config, 'gemini').map((spec) => spec.event)
    expect(events).toContain('AfterAgent')
    const finished = normalizeHook('gemini', { prompt_response: 'All done.' }, 5, '', 'AfterAgent')
    expect(finished.kind).toBe('stop')
    expect(planEvent(config, finished, { rng }).speak).toBe(true)
  })

  it('installs a Gemini prompt under the prompt toggle, not the session one', () => {
    // `BeforeAgent` fires after every submitted prompt, so filing it under
    // `sessionStart` greeted on every turn and popped the window forward with it.
    expect(buildSpecs(onlyToggle('sessionStart'), 'gemini').map((s) => s.event)).toEqual(['SessionStart'])
    expect(buildSpecs(onlyToggle('prompt'), 'gemini').map((s) => s.event)).toEqual(['BeforeAgent'])
    const prompt = normalizeHook('gemini', { prompt: 'hi' }, 5, '', 'BeforeAgent')
    expect(prompt.kind).toBe('prompt')
    expect(planEvent(onlyToggle('prompt'), prompt, { rng }).popWindow).toBe(false)
  })

  it('gives Gemini a matcher-free SessionStart, because its matcher is exact', () => {
    // Codex and Claude read a SessionStart matcher as a regex, so one pattern
    // covers startup/resume/clear. Gemini compares the same field as an exact
    // string, where that pattern matches nothing and the greeting never fires.
    const config = onlyToggle('sessionStart')
    const gemini = buildSpecs(config, 'gemini').find((spec) => spec.event === 'SessionStart')
    expect(gemini).toBeDefined()
    expect(gemini?.matcher).toBeUndefined()
    for (const agent of ['codex', 'claude'] as const) {
      const spec = buildSpecs(config, agent).find((s) => s.event === 'SessionStart')
      expect(spec?.matcher, agent).toBe('startup|resume|clear|compact')
    }
  })

  it('uses milliseconds for Gemini and seconds for everyone else', () => {
    const config = onlyToggle('stop')
    for (const spec of buildSpecs(config, 'gemini')) expect(spec.timeout).toBe(5000)
    for (const spec of buildSpecs(config, 'codex')) expect(spec.timeout).toBe(5)
  })

  it('spells ZCode timeouts both ways and never blocks its agent', () => {
    // ZCode reads `timeout` in seconds and prefers `timeoutMs`; writing only one
    // would leave the other path to guess. `async: true` is free because ZCode
    // ignores a hook's stdout, and it means a slow relay cannot stall a session.
    for (const spec of buildSpecs(onlyToggle('stop'), 'zcode')) {
      expect(spec.timeout).toBe(5)
      expect(spec.timeoutMs).toBe(5000)
      expect(spec.async).toBe(true)
    }
  })

  it('gives ZCode a matcher-free SessionStart too', () => {
    // Like Gemini, ZCode has no SessionStart matcher, and an unknown key on its
    // strict schema risks the whole config being rejected.
    const spec = buildSpecs(onlyToggle('sessionStart'), 'zcode').find((s) => s.event === 'SessionStart')
    expect(spec).toBeDefined()
    expect(spec?.matcher).toBeUndefined()
  })

  it('writes Kiro and Trae no matcher at all, on any trigger', () => {
    // Both read `matcher` as a filter rather than as a hint. Kiro documents it
    // as "not evaluated" on SessionStart/Stop and as tool-name or prompt-text
    // elsewhere, where `startup|resume|clear|compact` would match nothing; Trae
    // accepts the key on PreToolUse, PostToolUse and Notification only. An
    // omitted matcher means always-match on both, which is what we want, so the
    // session pattern must not reach either file under any toggle.
    const withMatcher: string[] = []
    for (const toggle of TOGGLES) {
      const config = onlyToggle(toggle)
      for (const agent of ['kiro', 'trae'] as const) {
        for (const spec of buildSpecs(config, agent)) {
          if (spec.matcher !== undefined) withMatcher.push(`${agent}:${spec.event}`)
        }
      }
    }
    expect(withMatcher).toEqual([])
  })

  it('installs only the moments Kiro and Trae really emit', () => {
    // Inventing an event name is not a harmless no-op here: Kiro loads every
    // file in its hooks directory, so a trigger it does not know makes the whole
    // file unreadable, and with it every hook the user had beside ours.
    expect(buildSpecs(onlyToggle('sessionStart'), 'kiro').map((s) => s.event)).toEqual(['SessionStart'])
    expect(buildSpecs(onlyToggle('stop'), 'kiro').map((s) => s.event)).toEqual(['Stop'])
    expect(buildSpecs(onlyToggle('prompt'), 'kiro').map((s) => s.event)).toEqual(['UserPromptSubmit'])
    expect(buildSpecs(onlyToggle('tool'), 'kiro').map((s) => s.event)).toEqual([
      'PreToolUse',
      'PostToolUse'
    ])
    // Neither CLI has a permission, compact or subagent moment, and Trae's
    // notification is the one row Kiro lacks.
    for (const agent of ['kiro', 'trae'] as const) {
      for (const toggle of ['permission', 'compact', 'subagent'] as const) {
        expect(buildSpecs(onlyToggle(toggle), agent), `${agent}:${toggle}`).toEqual([])
      }
    }
    expect(buildSpecs(onlyToggle('notification'), 'kiro')).toEqual([])
    expect(buildSpecs(onlyToggle('notification'), 'trae').map((s) => s.event)).toEqual(['Notification'])
  })

  it('announces Kiro under the trigger names its CLI actually sends', () => {
    // The config side says `SessionStart`, but Kiro's payload still carries the
    // older `agentSpawn`/`agentStop` spellings. Folded in, a Kiro session is
    // greeted and its finish is announced under the stop toggle; unmapped, both
    // land in `other`, which no toggle owns and so is permanently mute.
    const spawned = normalizeHook('kiro', { hook_event_name: 'agentSpawn' }, 5, '', 'SessionStart')
    expect(spawned.kind).toBe('session_start')
    expect(planEvent(onlyToggle('sessionStart'), spawned, { rng }).speak).toBe(true)
    const stopped = normalizeHook('kiro', { hook_event_name: 'agentStop' }, 5, '', 'Stop')
    expect(stopped.kind).toBe('stop')
    expect(planEvent(onlyToggle('stop'), stopped, { rng }).speak).toBe(true)
  })
})

describe('buildKimiCommands', () => {
  it('builds only the events of the toggles that are on', () => {
    expect(Object.keys(buildKimiCommands(onlyToggle('stop'))).sort()).toEqual(['Stop', 'StopFailure'])
    expect(Object.keys(buildKimiCommands(onlyToggle('tool'))).sort()).toEqual([
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse'
    ])
    // Kimi has no session-boundary event, so this toggle builds nothing rather
    // than inventing a name its CLI would reject.
    expect(buildKimiCommands(onlyToggle('sessionStart'))).toEqual({})
  })

  it('announces every Kimi event it installs', () => {
    const silent: string[] = []
    for (const toggle of TOGGLES) {
      const config = onlyToggle(toggle)
      for (const event of Object.keys(buildKimiCommands(config))) {
        const normalized = normalizeHook('kimi', {}, 5, '', event)
        if (UNSPOKEN_KINDS.has(normalized.kind)) continue
        if (planEvent(config, normalized, { rng }).speak) continue
        silent.push(`kimi:${event} (${toggle})`)
      }
    }
    expect(silent).toEqual([])
  })
})
