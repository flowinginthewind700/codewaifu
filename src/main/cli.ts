import fs from 'node:fs'
import { parseEndpointEnv, type Endpoint } from '../shared/endpoint'
import { detectLang, toSpeakable } from '../shared/lang'
import type { RuntimeState } from '../shared/protocol'
import { endpointFile, envPinnedPort } from './env'
import { installAgentHooks, reportHooks, uninstallAgentHooks } from './hooksInstaller'
import { log } from './log'
import { isCodeWaifuPort, probeHealth, requestJson } from './probe'
import { readConfig } from './store'
import { Speaker } from './tts'

function endpoint(): Endpoint | null {
  try {
    return parseEndpointEnv(fs.readFileSync(endpointFile, 'utf8'))
  } catch {
    return null
  }
}

function out(value: unknown, asJson: boolean, human: string): void {
  if (asJson) stdout(`${JSON.stringify(value, null, 2)}\n`)
  else stdout(`${human}\n`)
}

/**
 * Synchronous stdout/stderr. The CLI path ends in `app.exit()`, and Node's async
 * pipe writes would be dropped by it - `install.sh` parses this output, so a
 * truncated line is a failed install.
 */
function stdout(text: string): void {
  try {
    fs.writeSync(1, text)
  } catch {
    process.stdout.write(text)
  }
}

export function stderr(text: string): void {
  try {
    fs.writeSync(2, text)
  } catch {
    process.stderr.write(text)
  }
}

const USAGE = `CodeWaifu CLI

Usage:
  CodeWaifu --cli <command> [--json]

Commands:
  install            Write the hook relay and register hooks for Codex + Claude Code
  uninstall          Remove CodeWaifu hooks and relay scripts (agent configs are backed up first)
  status             Show hook registration, relay port and whether the app is running
  say <text...>      Speak a line now (through the running app when possible)
  endpoint           Print the relay port and token
  help               Show this message
`

/**
 * Headless entry point. `install.sh` drives the whole install through this so
 * the config-merging logic exists exactly once, in tested TypeScript, instead of
 * being reimplemented in shell.
 */
export async function runCli(args: string[]): Promise<number> {
  const asJson = args.includes('--json')
  const positional = args.filter((a) => !a.startsWith('--'))
  const command = (positional[0] || 'help').toLowerCase()
  const rest = positional.slice(1)

  try {
    switch (command) {
      case 'install':
      case 'hooks-install': {
        const config = readConfig()
        // No live endpoint here: the app publishes its address when it binds.
        const report = installAgentHooks(config, null)
        const live = await isCodeWaifuPort(config.port, 600)
        const portLine = live
          ? `Hook relay live on 127.0.0.1:${live.port}`
          : envPinnedPort
            ? `Hook relay will listen on 127.0.0.1:${envPinnedPort} (pinned by CODEWAIFU_PORT)`
            : 'Hook relay port is chosen when the app starts (automatic, conflict-free)'
        out(
          report,
          asJson,
          [
            portLine,
            `  codex  : ${report.codex.installed ? report.codex.events.join(', ') || 'no events enabled' : `FAILED ${report.codex.error || ''}`}`,
            `  claude : ${report.claude.installed ? report.claude.events.join(', ') || 'no events enabled' : `FAILED ${report.claude.error || ''}`}`,
            ...report.warnings.map((w) => `  warning: ${w}`),
            report.codexTrustNeeded
              ? '  next: open Codex, run /hooks once, and trust the CodeWaifu entries (Codex gates non-managed hooks).'
              : ''
          ]
            .filter(Boolean)
            .join('\n')
        )
        return 0
      }
      case 'uninstall':
      case 'hooks-uninstall': {
        const report = uninstallAgentHooks()
        out(report, asJson, 'CodeWaifu hooks removed. Backups are in ~/.codewaifu/backups.')
        return 0
      }
      case 'hooks-status':
      case 'status': {
        const status = reportHooks()
        const point = endpoint()
        const alive = point ? await probeHealth(point.port) : null
        const live = Boolean(alive && alive.ok && alive.app === 'codewaifu')
        const runtime = live && point ? await fetchRuntime(point) : null
        const relay = runtime?.relay ?? null
        const payload = {
          ...status,
          endpoint: point,
          appRunning: live,
          version: alive?.version,
          relay,
          endpointStale: Boolean(point && !live)
        }
        out(
          payload,
          asJson,
          [
            `app        : ${live ? `running (v${alive?.version}, pid ${alive?.pid})` : 'not running'}`,
            `relay      : ${relay ? `127.0.0.1:${relay.port} (${relay.pinned ? 'pinned' : relay.reason})` : point ? `127.0.0.1:${point.port} (stale - nothing answering as CodeWaifu)` : 'no endpoint file'}`,
            relay?.conflict ? `port note  : ${relay.conflict.hint}` : '',
            relay?.duplicateOf ? `warning    : another CodeWaifu (pid ${relay.duplicateOf}) owns the endpoint` : '',
            `codex hooks: ${status.codex.installed ? status.codex.events.join(', ') || 'none' : 'not installed'}`,
            `claude hook: ${status.claude.installed ? status.claude.events.join(', ') || 'none' : 'not installed'}`,
            `runner     : ${status.runnerInstalled ? 'installed' : 'missing'}`
          ]
            .filter(Boolean)
            .join('\n')
        )
        return 0
      }
      case 'say': {
        const text = toSpeakable(rest.join(' '), 400)
        if (!text) {
          stderr('nothing to say\n')
          return 2
        }
        const point = endpoint()
        const alive = point ? await isCodeWaifuPort(point.port, 600) : null
        if (point && alive) {
          try {
            const { status } = await requestJson('POST', point.port, '/say', {
              token: point.token,
              body: { text }
            })
            if (status === 200) {
              out({ ok: true, via: 'app' }, asJson, 'spoken through the running app')
              return 0
            }
          } catch {
            /* fall through to local speech */
          }
        }
        const config = readConfig()
        const speaker = new Speaker(
          () => config,
          () => undefined
        )
        const lang = detectLang(text)
        speaker.force(text, lang)
        await waitForSpeech(speaker)
        out({ ok: true, via: 'local' }, asJson, 'spoken locally (app was not running)')
        return 0
      }
      case 'endpoint': {
        const point = endpoint()
        const alive = point ? await isCodeWaifuPort(point.port, 600) : null
        const payload = { ...(point || {}), live: Boolean(alive) }
        out(
          payload,
          asJson,
          point
            ? `127.0.0.1:${point.port} token=${point.token}${alive ? '' : '  (stale: app is not listening)'}`
            : 'no endpoint file yet'
        )
        return point ? 0 : 1
      }
      case 'help':
      case '':
        stdout(USAGE)
        return 0
      default:
        stderr(`unknown command: ${command}\n\n${USAGE}`)
        return 2
    }
  } catch (error) {
    log('error', `cli ${command} failed`, String(error))
    stderr(`${String(error)}\n`)
    return 1
  }
}

function waitForSpeech(speaker: Speaker, timeoutMs = 20000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      if (!speaker.speaking || Date.now() - started > timeoutMs) {
        clearInterval(tick)
        speaker.shutdown()
        resolve()
      }
    }, 120)
    tick.unref?.()
  })
}

async function fetchRuntime(point: Endpoint): Promise<RuntimeState | null> {
  try {
    const { status, json } = await requestJson('GET', point.port, '/state', { token: point.token, timeoutMs: 1500 })
    if (status !== 200) return null
    const runtime = json as RuntimeState
    return runtime && typeof runtime === 'object' && runtime.relay ? runtime : null
  } catch {
    return null
  }
}
