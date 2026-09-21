export type Platform = 'darwin' | 'win32' | 'linux'

export interface RunnerPaths {
  /** Directory that holds every generated runner. */
  dir: string
  /** Generic POSIX relay; takes the agent name as $1. */
  sh: string
  /** Generic Windows relay; takes the agent name as %1. */
  cmd: string
  /** PowerShell implementation behind the .cmd stub. */
  ps1: string
  /**
   * Windows stubs, keyed by `stubKey(agent, event)`, so a hook command never
   * needs nested quoting and never has to carry a JSON literal through cmd.exe.
   */
  cmdByAgent: Record<string, string>
}

/**
 * What an agent expects on stdout for a given hook event, and why it matters.
 *
 * Codex and Claude Code read nothing from a hook's stdout, so their commands
 * stay silent and byte-identical to what older installs wrote. Cursor and
 * Antigravity are the opposite: they *fail closed* on empty stdout. Cursor's
 * permission hooks deny the tool call when they cannot parse an answer, and
 * Antigravity reads silence on `PreToolUse` as a deny. So for those two the
 * answer is printed by the hook command itself, before the relay even runs -
 * a deleted runner then costs us an event, never a blocked agent.
 *
 * ⛔ The answers are deliberately the most conservative ones each agent
 * documents: `"ask"` defers to the user's own permission prompt. Never `allow`
 * - CodeWaifu observes approvals, it does not grant them.
 */
const HOOK_RESPONSES: Record<string, Record<string, string>> = {
  cursor: {
    beforeSubmitPrompt: '{"continue":true}',
    preToolUse: '{"permission":"ask"}',
    beforeShellExecution: '{"permission":"ask"}',
    beforeMCPExecution: '{"permission":"ask"}',
    postToolUse: '{}',
    postToolUseFailure: '{}',
    stop: '{}',
    afterAgentResponse: '{}'
  },
  antigravity: {
    PreToolUse: '{"decision":"ask"}',
    Stop: '{"decision":""}',
    PreInvocation: '{}',
    PostInvocation: '{}',
    PostToolUse: '{}'
  },
  gemini: {
    BeforeAgent: '{}',
    AfterAgent: '{}',
    BeforeTool: '{}',
    AfterTool: '{}'
  }
}

/** The neutral answer for an event of a response-reading agent we did not list. */
const NEUTRAL_RESPONSE = '{}'

/** Agents whose stdout is parsed as a decision, so silence would be a deny. */
export const RESPONSE_AGENTS: readonly string[] = Object.keys(HOOK_RESPONSES)

/**
 * The stdout an agent expects for this hook, or `''` when the agent reads
 * nothing from stdout and the command must stay silent.
 */
export function hookResponse(agent: string, event?: string): string {
  const table = HOOK_RESPONSES[agent]
  if (!table) return ''
  if (!event) return NEUTRAL_RESPONSE
  return table[event] ?? NEUTRAL_RESPONSE
}

/**
 * Windows stub key. One stub per hook command, because the response differs per
 * event for Cursor and Antigravity: `cursor:beforeSubmitPrompt`. Agents with no
 * per-event answer keep a single stub (`gemini`, `codex`).
 */
export function stubKey(agent: string, event?: string): string {
  const table = HOOK_RESPONSES[agent]
  const perEvent = Boolean(table && event && event in table)
  return perEvent ? `${agent}:${event}` : agent
}

/** Stub file name for an agent+event pair (`hook-cursor-preToolUse.cmd`). */
export function stubFileName(agent: string, event?: string): string {
  return `hook-${stubKey(agent, event).replace(':', '-')}.cmd`
}

/** Every stub this build knows how to write, keyed by `stubKey`. */
export function stubSpecs(agents: readonly string[], eventsByAgent: Record<string, readonly string[]>): Array<{
  key: string
  agent: string
  event?: string
}> {
  const specs: Array<{ key: string; agent: string; event?: string }> = []
  for (const agent of agents) {
    const events = eventsByAgent[agent] || []
    const table = HOOK_RESPONSES[agent]
    if (!table || events.length === 0) {
      specs.push({ key: agent, agent })
      continue
    }
    for (const event of events) specs.push({ key: stubKey(agent, event), agent, event })
  }
  return specs
}

export function runnerPaths(hooksDir: string, platform: Platform, stubs?: readonly string[]): RunnerPaths {
  const sep = platform === 'win32' ? '\\' : '/'
  const join = (...parts: string[]): string => parts.join(sep)
  const cmdByAgent: Record<string, string> = {}
  for (const key of stubs ?? ['codex', 'claude']) {
    cmdByAgent[key] = join(hooksDir, stubFileName(key))
  }
  return {
    dir: hooksDir,
    sh: join(hooksDir, 'run-hook.sh'),
    cmd: join(hooksDir, 'run-hook.cmd'),
    ps1: join(hooksDir, 'run-hook.ps1'),
    cmdByAgent
  }
}

/**
 * The POSIX relay. Rules it must never break:
 * - exit 0 on every path (a hook that fails would block the agent),
 * - always drain stdin, even when bailing early (an unread pipe makes the agent
 *   log a write error),
 * - hard 2s network timeout,
 * - no dependency beyond /bin/sh + curl (both ship with macOS and every
 *   mainstream Linux),
 * - stdin is forwarded verbatim as the JSON body,
 * - never POST to a port that does not answer as CodeWaifu. The port in
 *   endpoint.env was free when we bound it; by now anything could own it, and
 *   the payload carries session data.
 */
export function renderHookSh(): string {
  return [
    '#!/bin/sh',
    '# CodeWaifu hook relay. Generated file - do not edit; the app rewrites it.',
    '# Fail-open: whatever happens here, the agent must not be blocked.',
    'CODEWAIFU_AGENT="${1:-unknown}"',
    '# The hook event, when the caller knows it. Antigravity names the event in',
    '# the config rather than in the payload, so without this its events would all',
    '# arrive unnamed and land in the "other" bucket.',
    'CODEWAIFU_EVENT="${2:-}"',
    '# Drain stdin first so an early exit never leaves the agent with EPIPE.',
    'BODY=`cat 2>/dev/null`',
    '# ⛔ Not `${BODY:-{}}`: POSIX ends the expansion at the first `}`, so that',
    '# form appends a stray brace to every non-empty payload and the relay logs an',
    '# empty event. Default it on its own line instead.',
    'case "$BODY" in',
    "  '') BODY='{}' ;;",
    'esac',
    'STATE="${CODEWAIFU_HOME:-$HOME/.codewaifu}/endpoint.env"',
    '[ -f "$STATE" ] || exit 0',
    '# shellcheck disable=SC1090',
    '. "$STATE" 2>/dev/null || exit 0',
    '[ -n "${CODEWAIFU_PORT:-}" ] || exit 0',
    'BASE="${CODEWAIFU_BASE:-http://127.0.0.1:${CODEWAIFU_PORT}}"',
    'command -v curl >/dev/null 2>&1 || exit 0',
    '# Identity preflight: confirm a CodeWaifu relay owns this port right now.',
    'PROBE=`curl -s -m 1 "${BASE}/health" 2>/dev/null`',
    'case "$PROBE" in',
    "  *'\"app\":\"codewaifu\"'*) ;;",
    '  *) exit 0 ;;',
    'esac',
    '# Which terminal this came from, stated rather than guessed. Nothing in the',
    '# payload names a pane, so the app was left matching on cwd - and three tasks',
    '# in one checkout are indistinguishable that way. herdr exports HERDR_PANE_ID',
    '# into every pane; outside herdr it is empty, which is the fallback we had.',
    'curl -s -m 2 -o /dev/null \\',
    '  -X POST "${BASE}/hook/${CODEWAIFU_AGENT}" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "X-CodeWaifu-Token: ${CODEWAIFU_TOKEN:-}" \\',
    '  -H "X-CodeWaifu-Pane: ${HERDR_PANE_ID:-}" \\',
    '  -H "X-CodeWaifu-Event: ${CODEWAIFU_EVENT}" \\',
    '  --data-binary "$BODY" 2>/dev/null || true',
    'exit 0',
    ''
  ].join('\n')
}

/**
 * Windows stub: keeps the hook command free of nested quoting, and prints the
 * decision this agent+event expects before the relay runs (see HOOK_RESPONSES).
 */
export function renderHookCmdStub(agent: string, event?: string): string {
  const response = hookResponse(agent, event)
  const args = [agent, ...(event ? [event] : [])].join(' ')
  const lines = ['@echo off']
  // `echo` writes the literal, quotes included; the JSON answers carry no `%`,
  // `&`, `|`, `<`, `>` or `^`, so no cmd.exe escaping is needed.
  if (response) lines.push(`echo ${response}`)
  lines.push(`call "%~dp0run-hook.cmd" ${args}`, 'exit /b 0', '')
  return lines.join('\r\n')
}

export function renderHookCmd(): string {
  return [
    '@echo off',
    'rem CodeWaifu hook relay (Windows). Generated file - do not edit.',
    'setlocal',
    'where powershell >nul 2>&1',
    'if errorlevel 1 exit /b 0',
    'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0run-hook.ps1" -Agent "%~1" -Event "%~2"',
    'exit /b 0',
    ''
  ].join('\r\n')
}

export function renderHookPs1(): string {
  return [
    '# CodeWaifu hook relay (Windows). Generated file - do not edit.',
    'param([string]$Agent = "unknown", [string]$Event = "")',
    '$ErrorActionPreference = "SilentlyContinue"',
    'try {',
    '  [Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    '  $body = "{}"',
    '  if ([Console]::IsInputRedirected) { $raw = [Console]::In.ReadToEnd(); if ($raw) { $body = $raw } }',
    '  $base = if ($env:CODEWAIFU_HOME) { $env:CODEWAIFU_HOME } else { Join-Path $env:USERPROFILE ".codewaifu" }',
    '  $state = Join-Path $base "endpoint.env"',
    '  if (-not (Test-Path -LiteralPath $state)) { exit 0 }',
    '  $port = ""; $token = ""; $url = ""',
    '  foreach ($line in (Get-Content -LiteralPath $state)) {',
    '    if ($line -match "^\\s*#") { continue }',
    '    if ($line -match "^\\s*CODEWAIFU_PORT\\s*=\\s*(.*)$") { $port = $matches[1].Trim().Trim(\'"\') }',
    '    elseif ($line -match "^\\s*CODEWAIFU_TOKEN\\s*=\\s*(.*)$") { $token = $matches[1].Trim().Trim(\'"\') }',
    '    elseif ($line -match "^\\s*CODEWAIFU_BASE\\s*=\\s*(.*)$") { $url = $matches[1].Trim().Trim(\'"\') }',
    '  }',
    '  if (-not $url) { if (-not $port) { exit 0 }; $url = "http://127.0.0.1:$port" }',
    '  $probe = Invoke-WebRequest -UseBasicParsing -Uri "$url/health" -TimeoutSec 1',
    '  if ($probe.Content -notmatch \'"app"\\s*:\\s*"codewaifu"\') { exit 0 }',
    '  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)',
    '  $headers = @{ "X-CodeWaifu-Token" = $token }',
    '  # The same self-reported pane id the POSIX relay sends. An empty header',
    '  # value is a request some stacks refuse, so only set it when herdr did.',
    '  if ($env:HERDR_PANE_ID) { $headers["X-CodeWaifu-Pane"] = $env:HERDR_PANE_ID }',
    '  # The hook event, for agents that name it in their config instead of in the',
    '  # payload (Antigravity). Same rule: only send it when there is something.',
    '  if ($Event) { $headers["X-CodeWaifu-Event"] = $Event }',
    '  $uri = "$url/hook/$Agent"',
    '  Invoke-RestMethod -Method Post -Uri $uri -ContentType "application/json; charset=utf-8" -Headers $headers -Body $bytes -TimeoutSec 2 | Out-Null',
    '} catch { }',
    'exit 0',
    ''
  ].join('\r\n')
}

/**
 * The exact command string written into the agent hook config. Absolute paths
 * are baked in (both agents run the command through a shell in the user's home,
 * not ours) and single-quoted so spaces in the username are safe.
 *
 * When the agent reads a decision off stdout, that decision is printed first and
 * unconditionally: the relay is guarded by `[ -f ]`, so an install whose runner
 * was deleted must still leave the agent unblocked.
 */
export function hookCommand(paths: RunnerPaths, agent: string, platform: Platform, event?: string): string {
  const response = hookResponse(agent, event)
  if (platform === 'win32') {
    return hookCommandWindows(paths, agent, event, response)
  }
  const args = [agent, ...(event ? [event] : [])].join(' ')
  const relay = `if [ -f '${paths.sh}' ]; then /bin/sh '${paths.sh}' ${args}; fi`
  return response ? `printf '%s\\n' '${response}'; ${relay}` : relay
}

export function hookCommandWindows(paths: RunnerPaths, agent: string, event?: string, response?: string): string {
  const answer = response ?? hookResponse(agent, event)
  const stub = paths.cmdByAgent[stubKey(agent, event)]
  if (stub) return `cmd /c "${stub}"`
  const args = [agent, ...(event ? [event] : [])].join(' ')
  const call = `cmd /c "${paths.cmd}" ${args}`
  // No stub for this pair (a hand-built RunnerPaths, an old install): echo the
  // decision here so a decision-reading agent still gets an answer.
  return answer ? `echo ${answer} & ${call}` : call
}

/**
 * Owns-entries markers. Anything whose command points at a runner we generated
 * is ours, which is what makes merge/uninstall idempotent and safe next to
 * other tools' hooks (orca, superpowers, ...) living in the same config files.
 *
 * Two patterns, because one is not enough:
 *
 * - `HOOK_MARKER` is the default state dir. It matches every install that never
 *   set `CODEWAIFU_HOME`, which is nearly all of them.
 * - `RUNNER_MARKER` is the shape of the files `runnerPaths` writes: a `hooks/`
 *   directory holding `run-hook.sh|cmd|ps1` or a per-event `hook-*.cmd` stub.
 *   Without it, a relocated state dir produces commands that look foreign, and
 *   the consequences are not cosmetic. `stripOurs` keeps them, so every install
 *   appends another copy of each event, and uninstall leaves them all behind.
 *   For Cursor and Antigravity that is worse than noise: their commands print
 *   `{"permission":"ask"}` unconditionally, so N stale copies mean the user
 *   answers N permission prompts for one tool call.
 *
 * Both stay path-shaped rather than name-shaped on purpose. A basename alone
 * would claim another tool's `run-hook.sh`, and uninstall would then eat it.
 */
export const HOOK_MARKER = /\.codewaifu[\\/]+hooks[\\/]/

/**
 * Our runner basenames, anchored to a `hooks/` directory and to a terminating
 * quote, space or end of string, so a lookalike such as `agent-hooks/run.sh` or
 * `hooks/run-hook.shx` is not claimed.
 */
export const RUNNER_MARKER =
  /[\\/]hooks[\\/](?:run-hook\.(?:sh|cmd|ps1)|hook-[\w-]+\.cmd)(?=['"\s]|$)/

export function isOurHookCommand(command: unknown): boolean {
  return typeof command === 'string' && (HOOK_MARKER.test(command) || RUNNER_MARKER.test(command))
}
