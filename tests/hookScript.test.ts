import { describe, expect, it } from 'vitest'
import { HEALTH_MARKER } from '../src/shared/endpoint'
import {
  hookCommand,
  hookCommandWindows,
  isOurHookCommand,
  renderHookCmd,
  renderHookCmdStub,
  renderHookPs1,
  renderHookSh,
  runnerPaths
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
    expect(sh).toContain('--data-binary "${BODY:-{}}"')
    expect(sh).toContain('X-CodeWaifu-Token')
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

describe('runnerPaths', () => {
  it('uses the platform separator', () => {
    expect(POSIX.sh).toBe('/Users/dev/.codewaifu/hooks/run-hook.sh')
    expect(WIN.sh).toBe('C:\\Users\\dev\\.codewaifu\\hooks\\run-hook.sh')
    expect(Object.keys(WIN.cmdByAgent).sort()).toEqual(['claude', 'codex'])
  })
})
