import { detectLang, toSpeakable } from '../shared/lang'
import type { Endpoint } from '../shared/endpoint'
import type { RuntimeState } from '../shared/protocol'
import { envPinnedPort } from './env'
import { cliStderr as stderr, cliStdout as stdout, readEndpoint as endpoint } from './cliIo'
import { installAgentHooks, reportHooks, uninstallAgentHooks } from './hooksInstaller'
import { log } from './log'
import { runProCli } from './pro/cli'
import { isCodeWaifuPort, probeHealth, requestJson } from './probe'
import { readConfig } from './store'
import { Speaker } from './tts'

function out(value: unknown, asJson: boolean, human: string): void {
  if (asJson) stdout(`${JSON.stringify(value, null, 2)}\n`)
  else stdout(`${human}\n`)
}

const USAGE = `CodeWaifu CLI

Usage:
  CodeWaifu --cli <command> [--json]
  codewaifu pro <verb>          (driving the bench needs no --cli)

Commands:
  pro <verb>         Drive the bench: state, attention, answer, new, log (see below)
  install            Write the hook relay and register hooks for Codex + Claude Code
  uninstall          Remove CodeWaifu hooks and relay scripts (agent configs are backed up first)
  status             Show hook registration, relay port and whether the app is running
  say <text...>      Speak a line now (through the running app when possible)
  endpoint           Print the relay port and token
  help               Show this message

Run \`codewaifu pro help\` for the bench's own verbs.
`

/**
 * Commands that also work with no `--cli` in front of them.
 *
 * A control surface you have to remember a flag to reach is not a control
 * surface, and the bench is the part of this app an agent or a shell alias
 * drives. The installer verbs keep the flag: `install.sh` already passes it, and
 * `codewaifu install` reading as "install the app" is a confusion worth keeping.
 */
const BARE_CLI_COMMANDS = new Set(['pro'])

/**
 * Decide CLI mode from `process.argv`, and hand back the args to run.
 *
 * `--cli` wins when both are present, so nothing that works today changes
 * meaning. The bare form starts at argv[1] rather than argv[0]: argv[0] is the
 * binary path, and a checkout directory called `pro` must not turn a launch into
 * a CLI call.
 */
export function cliArgsFrom(argv: readonly string[]): { cli: boolean; args: string[] } {
  const flagAt = argv.indexOf('--cli')
  if (flagAt >= 0) return { cli: true, args: argv.slice(flagAt + 1) }
  const bareAt = argv.findIndex((arg, index) => index > 0 && BARE_CLI_COMMANDS.has(arg.toLowerCase()))
  if (bareAt >= 0) return { cli: true, args: argv.slice(bareAt) }
  return { cli: false, args: [] }
}

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
      case 'pro': {
        // The whole argv goes in: `shared/proCli.ts` finds `pro` itself, so a
        // flag order we did not anticipate here still parses the same way there.
        return runProCli(args)
      }
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
