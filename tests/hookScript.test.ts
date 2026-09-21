import { describe, expect, it } from 'vitest'
import { HEALTH_MARKER } from '../src/shared/endpoint'
import {
  RESPONSE_AGENTS,
  hookCommand,
  hookCommandWindows,
  hookResponse,
  isOurHookCommand,
  renderHookCmd,
  renderHookCmdStub,
  renderHookPs1,
  renderHookSh,
  runnerPaths,
  stubFileName,
  stubKey,
  stubSpecs
} from '../src/shared/hookScript'

const POSIX = runnerPaths('/Users/dev/.codewaifu/hooks', 'darwin')
const WIN = runnerPaths('C:\\Users\\dev\\.codewaifu\\hooks', 'win32')

describe('run-hook.sh', () => {
  const sh = renderHookSh()

  it('is fail-open: the only exit codes it can produce are 0', () => {
    const exits = [...sh.matchAll(/exit\s+(-?\d+)/g)].map((m) => m[1])
    expect(exits.length).toBeGreaterThan(3)
    expect(new Set(exits)).toEqual(new Set(['0']))
    expect(sh.trimEnd().endsWith('exit 0')).toBe(true)
  })

  it('drains stdin before any early exit, so the agent never gets EPIPE', () => {
    const drain = sh.indexOf('BODY=`cat')
    expect(drain).toBeGreaterThan(-1)
    expect(sh.indexOf('exit 0', drain)).toBeGreaterThan(drain)
    // Nothing may bail out before stdin has been read.
    expect(sh.slice(0, drain)).not.toContain('exit 0')
  })

  it('verifies the port is really a CodeWaifu relay before POSTing session data', () => {
    expect(sh).toContain('/health')
    expect(sh).toContain(HEALTH_MARKER)
    const probe = sh.indexOf('/health')
    const post = sh.indexOf('/hook/')
    expect(probe).toBeGreaterThan(-1)
    expect(post).toBeGreaterThan(probe)
  })

  it('bounds every network call so a hung relay cannot stall the agent', () => {
    const curls = sh.split('\n').filter((line) => line.includes('curl -s'))
    expect(curls.length).toBe(2)
    expect(curls[0]).toContain('-m 1')
    expect(curls[1]).toContain('-m 2')
  })

  it('forwards stdin verbatim and sends the token header', () => {
    expect(sh).toContain('--data-binary "$BODY"')
    expect(sh).toContain('X-CodeWaifu-Token')
  })

  it('reports the pane it ran in, defaulted so an unset variable stays empty', () => {
    // Nothing in a hook payload names a terminal, so without this the app can
    // only match on cwd - and every task in one checkout then looks like every
    // other. `${HERDR_PANE_ID:-}` and not `${HERDR_PANE_ID}`: under `set -u`
    // agents, an unset variable would abort the relay before the POST.
    expect(sh).toContain('-H "X-CodeWaifu-Pane: ${HERDR_PANE_ID:-}"')
    expect(sh).not.toContain('${HERDR_PANE_ID}"')
  })

  it('names the event in a header, because half the agents never say it', () => {
    // Cursor, Gemini, Antigravity and Kimi name the event in their config
    // rather than in the payload, so without this every event from them would
    // arrive unnamed and land in the "other" bucket. The event is $2 and the
    // header goes out unconditionally: an empty value just means "unknown".
    expect(sh).toContain('CODEWAIFU_EVENT="${2:-}"')
    expect(sh).toContain('-H "X-CodeWaifu-Event: ${CODEWAIFU_EVENT}"')
    expect(sh).not.toContain('${CODEWAIFU_EVENT:-}"')
  })

  it('never defaults the body with ${BODY:-{}} — POSIX closes at the first brace', () => {
    // That form yields `$BODY` + a literal `}` for every non-empty payload, so
    // the relay receives invalid JSON and logs an empty event. Guard the string
    // here; tests/hookRunnerExec.test.ts proves it by running the script.
    // Comments are prose: the script documents the trap by naming it. Only the
    // executable lines may contain it.
    const code = sh
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(code).not.toContain('${BODY:-{}}')
    expect(sh).toMatch(/case "\$BODY" in\s*\n\s*''\) BODY='\{\}' ;;/)
  })

  it('bails when endpoint.env is missing or names no port', () => {
    expect(sh).toContain('[ -f "$STATE" ] || exit 0')
    expect(sh).toContain('[ -n "${CODEWAIFU_PORT:-}" ] || exit 0')
    expect(sh).toContain('command -v curl')
  })

  it('defaults to the conventional home when CODEWAIFU_HOME is unset', () => {
    expect(sh).toContain('${CODEWAIFU_HOME:-$HOME/.codewaifu}/endpoint.env')
  })
})

describe('Windows runners', () => {
  const cmd = renderHookCmd()
  const ps1 = renderHookPs1()

  it('never returns a failing exit code to the agent', () => {
    expect(cmd).toContain('exit /b 0')
    expect(ps1.trimEnd().endsWith('exit 0')).toBe(true)
    expect(cmd).toContain('if errorlevel 1 exit /b 0')
  })

  it('uses CRLF line endings, which cmd.exe needs', () => {
    expect(cmd).toContain('\r\n')
    expect(ps1).toContain('\r\n')
    expect(renderHookCmdStub('codex')).toContain('\r\n')
  })

  it('probes /health and checks the marker exactly like the POSIX runner', () => {
    expect(ps1).toContain('/health')
    expect(ps1).toContain('"app"')
    expect(ps1).toContain('codewaifu')
  })

  it('stubs keep nested quoting out of the hook command', () => {
    expect(renderHookCmdStub('claude')).toContain('run-hook.cmd" claude')
    expect(hookCommandWindows(WIN, 'claude')).toBe(`cmd /c "${WIN.cmdByAgent.claude}"`)
    expect(hookCommand(WIN, 'claude', 'win32')).not.toContain('run-hook.cmd')
  })

  it('reads all three endpoint fields with tolerant regexes', () => {
    for (const field of ['CODEWAIFU_PORT', 'CODEWAIFU_TOKEN', 'CODEWAIFU_BASE']) {
      expect(ps1).toContain(field)
    }
  })

  it('sends the pane header only when herdr supplied one', () => {
    // An empty header value is a request some stacks refuse, so the Windows
    // relay omits the header entirely instead of sending a blank one.
    expect(ps1).toContain('if ($env:HERDR_PANE_ID) { $headers["X-CodeWaifu-Pane"] = $env:HERDR_PANE_ID }')
  })

  it('takes the event as a parameter and sends it under the same guard', () => {
    expect(ps1).toContain('[string]$Event = ""')
    expect(ps1).toContain('if ($Event) { $headers["X-CodeWaifu-Event"] = $Event }')
    expect(cmd).toContain('-Event "%~2"')
  })
})

describe('hookCommand', () => {
  it('bakes in an absolute, quoted path so a username with spaces still works', () => {
    const spaced = runnerPaths('/Users/Ada Lovelace/.codewaifu/hooks', 'darwin')
    const command = hookCommand(spaced, 'codex', 'darwin')
    expect(command).toContain(`'/Users/Ada Lovelace/.codewaifu/hooks/run-hook.sh'`)
    expect(command).toContain('codex')
    // Guarded, so a removed runner cannot make the agent fail.
    expect(command.startsWith('if [ -f ')).toBe(true)
  })

  it('names the agent for both flavors and is recognised as ours', () => {
    expect(hookCommand(POSIX, 'codex', 'darwin')).toContain(' codex;')
    expect(hookCommand(POSIX, 'claude', 'darwin')).toContain(' claude;')
    expect(isOurHookCommand(hookCommand(POSIX, 'codex', 'darwin'))).toBe(true)
    expect(isOurHookCommand(hookCommand(WIN, 'codex', 'win32'))).toBe(true)
  })

  it('falls back to the generic runner when there is no per-agent stub', () => {
    const bare = runnerPaths('/tmp/cw-hooks', 'win32')
    bare.cmdByAgent = {}
    expect(hookCommand(bare, 'codex', 'win32')).toBe(`cmd /c "${bare.cmd}" codex`)
  })
})

// ---------------------------------------------------------------------------
// Decision-reading agents. Cursor and Antigravity fail *closed* on empty
// stdout: Cursor's permission hooks deny the tool call when they cannot parse
// an answer, and Antigravity reads silence on PreToolUse as a deny. So for
// those the answer is printed by the hook command itself, before the relay even
// runs - a deleted runner then costs us an event, never a blocked agent.
// ---------------------------------------------------------------------------

const CURSOR_STUBS = runnerPaths('C:\\Users\\dev\\.codewaifu\\hooks', 'win32', [
  'cursor:beforeSubmitPrompt',
  'cursor:preToolUse'
])

describe('hookResponse', () => {
  it('is silent for agents that read nothing off stdout', () => {
    // Codex and Claude parse no hook stdout, so their commands must stay
    // byte-identical to what older installs wrote.
    expect(hookResponse('codex')).toBe('')
    expect(hookResponse('codex', 'Stop')).toBe('')
    expect(hookResponse('claude', 'PreToolUse')).toBe('')
    expect(hookResponse('kimi', 'Stop')).toBe('')
    expect(hookResponse('brandnew', 'Stop')).toBe('')
  })

  it('answers per event for the agents that read stdout', () => {
    expect(hookResponse('cursor', 'preToolUse')).toBe('{"permission":"ask"}')
    expect(hookResponse('cursor', 'beforeSubmitPrompt')).toBe('{"continue":true}')
    expect(hookResponse('cursor', 'stop')).toBe('{}')
    expect(hookResponse('antigravity', 'PreToolUse')).toBe('{"decision":"ask"}')
    expect(hookResponse('antigravity', 'Stop')).toBe('{"decision":""}')
    expect(hookResponse('gemini', 'BeforeTool')).toBe('{}')
  })

  it('falls back to a neutral object for an event it was not told about', () => {
    expect(hookResponse('cursor')).toBe('{}')
    expect(hookResponse('cursor', 'SomeNewEvent')).toBe('{}')
  })

  it('never grants permission, only defers to the user', () => {
    // CodeWaifu observes approvals; it does not hand them out. An `allow` here
    // would silently auto-approve every tool call on a user's machine.
    const events = [undefined, 'preToolUse', 'PreToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'Stop']
    for (const agent of RESPONSE_AGENTS) {
      for (const event of events) {
        const answer = hookResponse(agent, event)
        expect(answer, `${agent}:${event}`).not.toContain('allow')
        expect(answer, `${agent}:${event}`).not.toContain('approve')
        expect(() => JSON.parse(answer || '{}'), `${agent}:${event}`).not.toThrow()
      }
    }
    expect(RESPONSE_AGENTS).toEqual(expect.arrayContaining(['cursor', 'antigravity', 'gemini']))
    expect(RESPONSE_AGENTS).not.toContain('codex')
  })
})

describe('stubKey / stubFileName', () => {
  it('keys a stub per event when the answer differs per event', () => {
    expect(stubKey('cursor', 'preToolUse')).toBe('cursor:preToolUse')
    expect(stubKey('cursor', 'beforeSubmitPrompt')).toBe('cursor:beforeSubmitPrompt')
    expect(stubFileName('cursor', 'preToolUse')).toBe('hook-cursor-preToolUse.cmd')
    expect(stubKey('antigravity', 'PreToolUse')).toBe('antigravity:PreToolUse')
  })

  it('shares one stub across events for agents with no per-event answer', () => {
    // A shared stub would print the wrong JSON for half of Cursor's events, so
    // the split is the point; but codex/claude/kimi must not multiply files.
    expect(stubKey('codex', 'Stop')).toBe('codex')
    expect(stubKey('claude')).toBe('claude')
    expect(stubKey('kimi', 'PreToolUse')).toBe('kimi')
    expect(stubFileName('codex', 'Stop')).toBe('hook-codex.cmd')
  })

  it('lists one stub per command it may emit, and one for a table-less agent', () => {
    const specs = stubSpecs(['codex', 'cursor'], { codex: ['Stop'], cursor: ['preToolUse', 'stop'] })
    expect(specs).toEqual([
      { key: 'codex', agent: 'codex' },
      { key: 'cursor:preToolUse', agent: 'cursor', event: 'preToolUse' },
      { key: 'cursor:stop', agent: 'cursor', event: 'stop' }
    ])
    // No events known yet: still one stub, so an old install keeps working.
    expect(stubSpecs(['claude'], {})).toEqual([{ key: 'claude', agent: 'claude' }])
  })

  it('maps every stub key runnerPaths was given to a file', () => {
    expect(Object.keys(CURSOR_STUBS.cmdByAgent).sort()).toEqual(['cursor:beforeSubmitPrompt', 'cursor:preToolUse'])
    expect(CURSOR_STUBS.cmdByAgent['cursor:preToolUse']).toBe(
      'C:\\Users\\dev\\.codewaifu\\hooks\\hook-cursor-preToolUse.cmd'
    )
  })
})

describe('Windows stubs for decision-reading agents', () => {
  it('prints the decision before calling the relay', () => {
    const lines = renderHookCmdStub('cursor', 'preToolUse').split('\r\n')
    expect(lines[0]).toBe('@echo off')
    expect(lines[1]).toBe('echo {"permission":"ask"}')
    expect(lines[2]).toContain('run-hook.cmd" cursor preToolUse')
    expect(lines[3]).toBe('exit /b 0')
  })

  it('stays silent for an agent that reads nothing', () => {
    const stub = renderHookCmdStub('codex', 'Stop')
    expect(stub).not.toContain('echo {')
    expect(stub.split('\r\n')[1]).toContain('run-hook.cmd" codex Stop')
  })

  it('carries no cmd.exe metacharacter that would need escaping', () => {
    // `echo` writes the literal, so a `%`, `&`, `|`, `<`, `>` or `^` in an
    // answer would be interpreted by cmd.exe and corrupt the JSON.
    const events = ['preToolUse', 'PreToolUse', 'beforeSubmitPrompt', 'Stop', 'BeforeTool']
    for (const agent of RESPONSE_AGENTS) {
      for (const event of events) {
        expect(hookResponse(agent, event), `${agent}:${event}`).not.toMatch(/[&|<>^%]/)
      }
    }
  })
})

describe('POSIX hookCommand for decision-reading agents', () => {
  it('prints the answer first, then guards the relay', () => {
    const command = hookCommand(POSIX, 'cursor', 'darwin', 'preToolUse')
    expect(command.startsWith(`printf '%s\\n' '{"permission":"ask"}';`)).toBe(true)
    expect(command.indexOf('if [ -f ')).toBeGreaterThan(command.indexOf('printf'))
    expect(command).toContain(' cursor preToolUse;')
    expect(isOurHookCommand(command)).toBe(true)
  })

  it('keeps codex and claude byte-identical to the old silent form', () => {
    // These two read no stdout, so no answer may appear at all: any change here
    // rewrites every existing install on upgrade for no reason.
    expect(hookCommand(POSIX, 'codex', 'darwin', 'Stop')).toBe(
      `if [ -f '${POSIX.sh}' ]; then /bin/sh '${POSIX.sh}' codex Stop; fi`
    )
    expect(hookCommand(POSIX, 'claude', 'darwin')).toBe(
      `if [ -f '${POSIX.sh}' ]; then /bin/sh '${POSIX.sh}' claude; fi`
    )
    for (const command of [hookCommand(POSIX, 'codex', 'darwin', 'Stop'), hookCommand(POSIX, 'claude', 'darwin', 'PreToolUse')]) {
      expect(command).not.toContain('printf')
      expect(command).not.toContain('echo')
    }
  })

  it('still answers on Windows when a stub is missing from an old install', () => {
    expect(hookCommand(CURSOR_STUBS, 'cursor', 'win32', 'preToolUse')).toBe(
      `cmd /c "${CURSOR_STUBS.cmdByAgent['cursor:preToolUse']}"`
    )
    const bare = runnerPaths('C:\\Users\\dev\\.codewaifu\\hooks', 'win32')
    expect(hookCommand(bare, 'cursor', 'win32', 'preToolUse')).toBe(
      `echo {"permission":"ask"} & cmd /c "${bare.cmd}" cursor preToolUse`
    )
  })
})

describe('runnerPaths', () => {
  it('uses the platform separator', () => {
    expect(POSIX.sh).toBe('/Users/dev/.codewaifu/hooks/run-hook.sh')
    expect(WIN.sh).toBe('C:\\Users\\dev\\.codewaifu\\hooks\\run-hook.sh')
    expect(Object.keys(WIN.cmdByAgent).sort()).toEqual(['claude', 'codex'])
  })
})
