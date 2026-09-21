import { describe, expect, it } from 'vitest'
import { parseConfig, type AppConfig } from '../src/shared/config'
import { agentFromPath, kindForEvent, normalizeHook, planEvent } from '../src/shared/hookEvent'

const rng = (): number => 0

function config(patch?: Partial<AppConfig>): AppConfig {
  return parseConfig({ token: 'x'.repeat(20), ...patch })
}

describe('kindForEvent', () => {
  it.each([
    ['SessionStart', 'session_start'],
    ['session_start', 'session_start'],
    ['SESSION-START', 'session_start'],
    ['UserPromptSubmit', 'prompt'],
    ['PreToolUse', 'tool'],
    ['PostToolUse', 'tool'],
    ['PostToolUseFailure', 'tool'],
    ['PermissionRequest', 'permission'],
    ['Notification', 'notification'],
    ['Stop', 'stop'],
    ['StopFailure', 'stop'],
    ['SubagentStop', 'subagent'],
    ['PreCompact', 'compact'],
    ['PostCompact', 'compact'],
    ['Interrupt', 'interrupt'],
    ['SessionEnd', 'session_end']
  ])('maps %s to %s', (raw, kind) => {
    expect(kindForEvent(raw)).toBe(kind)
  })

  // Cursor names the same moments differently, and Gemini/Antigravity use their
  // own verbs again. All of them fold into kinds the UI already knows, so a
  // Cursor prompt still drives the prompt toggle and a Gemini tool call still
  // reads as a tool call rather than landing in "other".
  it.each([
    ['beforeSubmitPrompt', 'prompt'],
    ['afterAgentResponse', 'stop'],
    ['stop', 'stop'],
    ['postToolUse', 'tool'],
    ['postToolUseFailure', 'tool'],
    ['beforeShellExecution', 'tool'],
    ['beforeMCPExecution', 'tool'],
    ['preToolUse', 'tool'],
    ['BeforeTool', 'tool'],
    ['AfterTool', 'tool'],
    // Gemini brackets a *turn* with these two, not a session: BeforeAgent fires
    // once the user submits a prompt, AfterAgent once per turn when the model has
    // its final response. Gemini has real SessionStart/SessionEnd for the session
    // boundaries, so a turn event landing in a session kind is a bug, not a
    // synonym.
    ['BeforeAgent', 'prompt'],
    ['AfterAgent', 'stop'],
    ['PreCompress', 'compact'],
    ['PreInvocation', 'session_start'],
    ['PostInvocation', 'session_end']
  ])('maps the %s spelling to %s', (raw, kind) => {
    expect(kindForEvent(raw)).toBe(kind)
  })

  it('degrades to "other" for an event name it has never seen', () => {
    expect(kindForEvent('BrandNewAgentEvent')).toBe('other')
    expect(kindForEvent('')).toBe('other')
    expect(kindForEvent(undefined as unknown as string)).toBe('other')
  })
})

describe('agentFromPath', () => {
  it('reads the agent off the trailing path segment', () => {
    expect(agentFromPath('/hook/codex')).toBe('codex')
    expect(agentFromPath('/hook/claude')).toBe('claude')
    expect(agentFromPath('claude')).toBe('claude')
    expect(agentFromPath('/hook/CODEX')).toBe('codex')
    expect(agentFromPath('/hook/unknown')).toBe('unknown')
    expect(agentFromPath('')).toBe('unknown')
  })
})

describe('normalizeHook', () => {
  it('reads the fields both agents share', () => {
    const event = normalizeHook('claude', {
      hook_event_name: 'Stop',
      session_id: 'abc-123',
      cwd: '/Users/dev/project',
      transcript_path: '/tmp/t.jsonl',
      last_assistant_message: 'All tests pass.'
    })
    expect(event).toMatchObject({
      agent: 'claude',
      kind: 'stop',
      rawEvent: 'Stop',
      sessionId: 'abc-123',
      cwd: '/Users/dev/project',
      transcriptPath: '/tmp/t.jsonl',
      sourceText: 'All tests pass.',
      title: 'Agent finished'
    })
    expect(event.id).toBeTruthy()
  })

  it('builds a tool detail from tool_name plus the command', () => {
    const event = normalizeHook('codex', {
      hook_event_name: 'PostToolUse',
      tool_name: 'exec_command',
      tool_input: { command: 'npm test' }
    })
    expect(event.kind).toBe('tool')
    expect(event.toolName).toBe('exec_command')
    expect(event.detail).toContain('exec_command')
    expect(event.detail).toContain('npm test')
  })

  it('marks a resumed session so the greeting says "welcome back"', () => {
    expect(normalizeHook('codex', { hook_event_name: 'SessionStart', source: 'resume' }).matcher).toBe('resume')
    const event = normalizeHook('codex', { hook_event_name: 'SessionStart', matcher: 'startup' })
    expect(planEvent(config(), event, { rng }).text.length).toBeGreaterThan(0)
  })

  it('accepts the camelCase aliases and a payload that is not an object', () => {
    expect(normalizeHook('claude', { hookEventName: 'Notification', sessionId: 's1' }).sessionId).toBe('s1')
    for (const junk of [null, undefined, 'text', 42, []]) {
      expect(() => normalizeHook('codex', junk)).not.toThrow()
    }
    expect(normalizeHook('codex', null).kind).toBe('other')
  })

  it('recovers the agent from the event name when the path said nothing useful', () => {
    expect(normalizeHook('unknown', { hook_event_name: 'Stop' }).agent).toBe('unknown')
  })

  it('carries the pane the relay reported, and none when it did not', () => {
    // The pane is the one identity a payload cannot carry, so it arrives beside
    // the body rather than inside it. Absent has to stay absent: an invented
    // pane is worse than none, because resolution believes it first.
    const payload = { hook_event_name: 'Stop', session_id: 'abc', cwd: '/tmp/p' }
    expect(normalizeHook('codex', payload, 5, 'w5:p1').paneId).toBe('w5:p1')
    expect(normalizeHook('codex', payload, 5).paneId).toBe('')
    expect(normalizeHook('codex', payload, 5, '   ').paneId).toBe('')
  })

  it('hands out unique ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => normalizeHook('codex', { hook_event_name: 'Stop' }).id))
    expect(ids.size).toBe(500)
  })

  it('uses the event the installer named when the payload says nothing', () => {
    // Cursor, Gemini, Antigravity and Kimi do not repeat the event in the body;
    // the config-side name the relay sends in a header is what says what fired.
    const event = normalizeHook('cursor', { cwd: '/tmp/x' }, 5, 'w1:p2', 'beforeShellExecution')
    expect(event).toMatchObject({ agent: 'cursor', rawEvent: 'beforeShellExecution', kind: 'tool' })
    expect(event.title).toBe('Tool call')
  })

  it('still lets the agent\'s own payload win over the fallback', () => {
    // The fallback is a guess from the config; the body is the agent's account.
    const event = normalizeHook('claude', { hook_event_name: 'Stop' }, 5, '', 'PreToolUse')
    expect(event.rawEvent).toBe('Stop')
    expect(event.kind).toBe('stop')
  })

  it('falls back to "other" when neither the payload nor the config names an event', () => {
    const event = normalizeHook('gemini', {}, 5, '', '')
    expect(event.rawEvent).toBe('')
    expect(event.kind).toBe('other')
    expect(event.title).toBe('Event')
  })

  it('narrows an agent name it has never seen to unknown', () => {
    expect(normalizeHook('cursor', {}, 5, '', 'preToolUse').agent).toBe('cursor')
    expect(normalizeHook('antigravity', {}, 5, '', 'Stop').agent).toBe('antigravity')
    expect(normalizeHook('kimi', {}, 5, '', 'Stop').agent).toBe('kimi')
    expect(normalizeHook('herdr-agent-17', {}, 5, '', 'Stop').agent).toBe('unknown')
    expect(normalizeHook('', {}, 5, '', 'Stop').agent).toBe('unknown')
  })

  it('plans the new agents\' events exactly like the codex events they stand for', () => {
    const toolsOn = config({ events: { ...config().events, tool: true } })
    // Each new spelling next to the codex/claude spelling it means, so a mapping
    // change on one side cannot pass silently while the other keeps its old plan.
    const pairs: Array<[string, string, string, string]> = [
      ['cursor', 'beforeSubmitPrompt', 'codex', 'UserPromptSubmit'],
      ['cursor', 'afterAgentResponse', 'claude', 'Stop'],
      ['cursor', 'beforeShellExecution', 'codex', 'PostToolUse'],
      ['gemini', 'BeforeTool', 'codex', 'PostToolUse'],
      ['gemini', 'BeforeAgent', 'codex', 'UserPromptSubmit'],
      ['gemini', 'AfterAgent', 'codex', 'Stop'],
      ['gemini', 'PreCompress', 'claude', 'PreCompact'],
      ['antigravity', 'PreInvocation', 'codex', 'SessionStart'],
      ['antigravity', 'PostInvocation', 'codex', 'SessionEnd'],
      ['kimi', 'Stop', 'claude', 'Stop']
    ]
    for (const [agent, event, peer, peerEvent] of pairs) {
      const ours = planEvent(toolsOn, normalizeHook(agent, {}, 5, '', event), { rng })
      const theirs = planEvent(toolsOn, normalizeHook(peer, {}, 5, '', peerEvent), { rng })
      expect([ours.speak, ours.lang, ours.popWindow], `${agent}:${event}`).toEqual([
        theirs.speak,
        theirs.lang,
        theirs.popWindow
      ])
    }

    // Two of them spelled out, so the loop above is not comparing silence to
    // silence: a Cursor tool call is announced, an Antigravity session start
    // still pops the window forward.
    const shell = normalizeHook('cursor', { tool_name: 'shell' }, 5, '', 'beforeShellExecution')
    expect(planEvent(toolsOn, shell, { rng }).speak).toBe(true)
    expect(planEvent(config(), normalizeHook('antigravity', {}, 5, '', 'PreInvocation'), { rng }).popWindow).toBe(true)

    // The regression this parity loop exists for: a Gemini turn finishing is a
    // `stop`, so it is announced under the stop toggle rather than being filed
    // under a session kind that no toggle owns (which is always silent).
    const geminiDone = normalizeHook('gemini', { prompt_response: 'All done.' }, 5, '', 'AfterAgent')
    expect(geminiDone.kind).toBe('stop')
    expect(planEvent(config(), geminiDone, { rng }).speak).toBe(true)
    expect(planEvent(config(), geminiDone, { rng }).popWindow).toBe(false)
    // And a Gemini prompt does not drag the window forward the way a greeting
    // does: `BeforeAgent` fires on every turn, so popping would be a nuisance.
    const geminiPrompt = normalizeHook('gemini', { prompt: 'hi' }, 5, '', 'BeforeAgent')
    expect(geminiPrompt.kind).toBe('prompt')
    expect(planEvent(config(), geminiPrompt, { rng }).popWindow).toBe(false)
  })
})

describe('planEvent', () => {
  const stop = normalizeHook('codex', { hook_event_name: 'Stop', last_assistant_message: 'Done.' })

  it('speaks only when the app is enabled, unmuted and the event is toggled on', () => {
    expect(planEvent(config(), stop, { rng }).speak).toBe(true)
    expect(planEvent(config({ speak: false }), stop, { rng }).speak).toBe(false)
    expect(planEvent(config({ enabled: false }), stop, { rng }).speak).toBe(false)
    expect(planEvent(config({ events: { ...config().events, stop: false } }), stop, { rng }).speak).toBe(false)
  })

  it('appends what the agent actually said to the phrase', () => {
    const plan = planEvent(config(), stop, { rng })
    expect(plan.text).toContain('Done.')
    expect(plan.lang).toBe('en')
  })

  it('follows the payload language when the preference is auto', () => {
    const zh = normalizeHook('codex', { hook_event_name: 'Stop', last_assistant_message: '全部完成了' })
    expect(planEvent(config(), zh, { rng }).lang).toBe('zh')
    const forced = planEvent(config({ lang: 'en' }), zh, { rng })
    expect(forced.lang).toBe('en')
  })

  it('greets in the UI language for a session start, because the payload is empty', () => {
    const start = normalizeHook('codex', { hook_event_name: 'SessionStart', matcher: 'startup' })
    const at = new Date(2026, 8, 14, 9, 0, 0)
    const plan = planEvent(config(), start, { now: at, rng })
    expect(plan.speak).toBe(true)
    expect(plan.lang).toBe('zh')
    expect(plan.text.length).toBeGreaterThan(0)
    expect(planEvent(config({ lang: 'en' }), start, { now: at, rng }).lang).toBe('en')
  })

  it('says "welcome back" for a resume instead of a time-of-day greeting', () => {
    const resume = normalizeHook('codex', { hook_event_name: 'SessionStart', matcher: 'resume' })
    const plan = planEvent(config({ lang: 'en' }), resume, { rng })
    expect(plan.text.toLowerCase()).toContain('back')
  })

  it('pops the window forward only for a session start, and only when asked to', () => {
    expect(planEvent(config(), stop, { rng }).popWindow).toBe(false)
    const start = normalizeHook('codex', { hook_event_name: 'SessionStart' })
    expect(planEvent(config(), start, { rng }).popWindow).toBe(true)
    expect(planEvent(config({ popOnSessionStart: false }), start, { rng }).popWindow).toBe(false)
    expect(planEvent(config({ enabled: false }), start, { rng }).popWindow).toBe(false)
  })

  it('stays silent for an event kind with no toggle, and for "other"', () => {
    const end = normalizeHook('codex', { hook_event_name: 'SessionEnd' })
    expect(planEvent(config(), end, { rng }).speak).toBe(false)
    const weird = normalizeHook('codex', { hook_event_name: 'SomethingNew' })
    const plan = planEvent(config(), weird, { rng })
    expect(plan.speak).toBe(false)
    expect(plan.text).toBe('')
  })

  it('mentions the tool for a permission request and the tool name for a tool call', () => {
    const permission = normalizeHook('codex', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'exec_command',
      tool_input: { command: 'rm -rf build' }
    })
    const plan = planEvent(config({ events: { ...config().events, permission: true } }), permission, { rng })
    expect(plan.speak).toBe(true)
    expect(plan.text.length).toBeLessThanOrEqual(320)

    const tool = normalizeHook('codex', { hook_event_name: 'PostToolUse', tool_name: 'apply_patch' })
    const toolPlan = planEvent(config({ events: { ...config().events, tool: true } }), tool, { rng })
    expect(toolPlan.speak).toBe(true)
  })

  it('honours the notification toggle and prefers the agent\'s own message', () => {
    const note = normalizeHook('claude', { hook_event_name: 'Notification', message: 'Claude needs your permission' })
    const plan = planEvent(config(), note, { rng })
    expect(plan.speak).toBe(true)
    expect(plan.text).toContain('Claude needs your permission')
  })

  it('never returns text longer than the spoken budget', () => {
    const long = normalizeHook('codex', { hook_event_name: 'Stop', last_assistant_message: 'word '.repeat(400) })
    expect(planEvent(config(), long, { rng }).text.length).toBeLessThanOrEqual(320)
  })

  it('varies the wording between two identical events', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 40; i += 1) {
      seen.add(planEvent(config(), stop, { rng: Math.random }).text)
    }
    expect(seen.size).toBeGreaterThan(1)
  })
})
