/**
 * `codewaifu pro ...`: the runner.
 *
 * All the thinking lives in `shared/proCli.ts` (argv to typed call, payload to
 * text). What is left here is the three things a pure module must not do: read
 * the endpoint file, speak HTTP to the relay, and touch the two file
 * descriptors. That split is what lets the verb table be unit-tested without an
 * app running, and the round trip be tested against the real relay.
 */
import { cliStderr, cliStdout, readEndpoint } from '../cliIo'
import { log } from '../log'
import { isCodeWaifuPort, requestJson } from '../probe'
import {
  exitForStatus,
  failureFor,
  offlineText,
  parseProCli,
  PRO_CLI_USAGE,
  PRO_EXIT,
  renderProAttention,
  renderProLedger,
  renderProRecovery,
  renderProResult,
  renderProState,
  type ProAttentionPayload,
  type ProCliCall,
  type ProStatePayload
} from '../../shared/proCli'

/**
 * A mutating verb can provision a workspace and launch an agent, which is
 * seconds of work on a cold herdr; a GET is a cached projection. Two budgets,
 * because one number either cuts off `pro new` or makes `pro state` hang.
 */
const READ_TIMEOUT_MS = 5000
const WRITE_TIMEOUT_MS = 25000

export async function runProCli(args: readonly string[]): Promise<number> {
  const parsed = parseProCli(args)
  if (parsed.kind === 'help') {
    cliStdout(`${PRO_CLI_USAGE}\n`)
    return PRO_EXIT.ok
  }
  if (parsed.kind === 'reject') {
    // Usage text goes with the complaint: a script sees the exit code, a human
    // sees how to say it correctly without a second round trip.
    cliStderr(`${parsed.error}\n\n${PRO_CLI_USAGE}`)
    return PRO_EXIT.usage
  }

  const point = readEndpoint()
  const alive = point ? await isCodeWaifuPort(point.port, 1200) : null
  if (!point || !alive) {
    // Not a fault, and not silent: exit 3 is the documented "nobody home", so a
    // cron job can poll and wait rather than page anybody.
    cliStderr(`${offlineText('no-app')}\n`)
    return PRO_EXIT.offline
  }

  try {
    const { status, json } = await requestJson(parsed.method, point.port, parsed.path, {
      token: point.token,
      body: bodyFor(parsed),
      timeoutMs: parsed.method === 'GET' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS
    })
    // Refusals and "nobody home" get their words from the status code, not from
    // a renderer that would otherwise say "nothing to show" about a 404.
    const failure = failureFor(status, json)
    if (failure) {
      cliStderr(`${failure.text}\n`)
      return failure.exit
    }
    if (parsed.json) {
      cliStdout(`${JSON.stringify(json, null, 2)}\n`)
      return exitForStatus(status)
    }
    const text = render(parsed, json, terminalWidth())
    if (status >= 400) cliStderr(`${text}\n`)
    else cliStdout(`${text}\n`)
    return exitForStatus(status)
  } catch (error) {
    log('error', `pro ${parsed.verb} failed`, String(error))
    cliStderr(`could not reach the bench on 127.0.0.1:${point.port}: ${String(error)}\n`)
    return PRO_EXIT.fault
  }
}

/**
 * The one place the CLI knows where it is standing: `pro new` with no `--dir`
 * means the directory the command was typed in, and only this process can say
 * what that is.
 */
function bodyFor(parsed: ProCliCall): Record<string, unknown> | undefined {
  if (parsed.body === null) return undefined
  const body = { ...parsed.body }
  if (parsed.verb === 'new' && !String(body.workdir ?? '').trim()) body.workdir = process.cwd()
  return body
}

function render(parsed: ProCliCall, json: unknown, width: number): string {
  switch (parsed.verb) {
    case 'state':
      return renderProState(json as ProStatePayload, width)
    case 'attention':
      return renderProAttention(json as ProAttentionPayload, Date.now(), width)
    case 'recovery':
      // Same route as `state`, a different slice of it: the plans, not the tree.
      return renderProRecovery(json as ProStatePayload, width)
    case 'log':
      return renderProLedger(json)
    default:
      return renderProResult(json, parsed.verb)
  }
}

/**
 * Clamped on both ends: a 40-column terminal cannot hold the table, and a
 * 400-column one should not stretch a title into a paragraph.
 */
function terminalWidth(): number {
  const columns = Number(process.stdout.columns) || 0
  return Math.max(60, Math.min(160, columns || 100))
}
