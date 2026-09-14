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
  /** Per-agent Windows stubs, so hook commands never need nested quoting. */
  cmdByAgent: Record<string, string>
}

export function runnerPaths(hooksDir: string, platform: Platform): RunnerPaths {
  const sep = platform === 'win32' ? '\\' : '/'
  const join = (...parts: string[]): string => parts.join(sep)
  return {
    dir: hooksDir,
    sh: join(hooksDir, 'run-hook.sh'),
    cmd: join(hooksDir, 'run-hook.cmd'),
    ps1: join(hooksDir, 'run-hook.ps1'),
    cmdByAgent: {
      codex: join(hooksDir, 'hook-codex.cmd'),
      claude: join(hooksDir, 'hook-claude.cmd')
    }
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
    '# Drain stdin first so an early exit never leaves the agent with EPIPE.',
    'BODY=`cat 2>/dev/null`',
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
    'curl -s -m 2 -o /dev/null \\',
    '  -X POST "${BASE}/hook/${CODEWAIFU_AGENT}" \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "X-CodeWaifu-Token: ${CODEWAIFU_TOKEN:-}" \\',
    "  --data-binary \"${BODY:-{}}\" 2>/dev/null || true",
    'exit 0',
    ''
  ].join('\n')
}

/** Windows stub: keeps the hook command free of nested quoting. */
export function renderHookCmdStub(agent: string): string {
  return ['@echo off', `call "%~dp0run-hook.cmd" ${agent}`, 'exit /b 0', ''].join('\r\n')
}

export function renderHookCmd(): string {
  return [
    '@echo off',
    'rem CodeWaifu hook relay (Windows). Generated file - do not edit.',
    'setlocal',
    'where powershell >nul 2>&1',
    'if errorlevel 1 exit /b 0',
    'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0run-hook.ps1" -Agent "%~1"',
    'exit /b 0',
    ''
  ].join('\r\n')
}

export function renderHookPs1(): string {
  return [
    '# CodeWaifu hook relay (Windows). Generated file - do not edit.',
    'param([string]$Agent = "unknown")',
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
 */
export function hookCommand(paths: RunnerPaths, agent: string, platform: Platform): string {
  if (platform === 'win32') {
    const stub = paths.cmdByAgent[agent]
    return stub ? `cmd /c "${stub}"` : `cmd /c "${paths.cmd}" ${agent}`
  }
  return `if [ -f '${paths.sh}' ]; then /bin/sh '${paths.sh}' ${agent}; fi`
}

export function hookCommandWindows(paths: RunnerPaths, agent: string): string {
  const stub = paths.cmdByAgent[agent]
  return stub ? `cmd /c "${stub}"` : `cmd /c "${paths.cmd}" ${agent}`
}

/**
 * Owns-entries marker. Anything whose command points inside our hooks dir is
 * ours, which is what makes merge/uninstall idempotent and safe next to other
 * tools' hooks (orca, superpowers, ...) living in the same config files.
 */
export const HOOK_MARKER = /\.codewaifu[\\/]+hooks[\\/]/

export function isOurHookCommand(command: unknown): boolean {
  return typeof command === 'string' && HOOK_MARKER.test(command)
}
