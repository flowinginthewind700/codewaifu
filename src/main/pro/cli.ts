/**
 * `codewaifu pro ...`: the runner.
 *
 * All the thinking lives in `shared/proCli.ts` (argv to typed call, payload to
 * text). What is left here is the three things a pure module must not do: read
 * the endpoint file, speak HTTP to the relay, and touch the two file
 * descriptors. That split is what lets the verb table be unit-tested without an
 * app running, and the round trip be tested against the real relay.
 */
import { cliStderr, cliStdout, readEndpoint, readSecret } from '../cliIo'
import { log } from '../log'
import { isCodeWaifuPort, requestJson, streamNdjson } from '../probe'
import type { Endpoint } from '../../shared/endpoint'
import {
  clip,
  diffProViews,
  exitForStatus,
  failureFor,
  offlineText,
  parseProCli,
  PRO_CLI_USAGE,
  PRO_EXIT,
  renderProAttention,
  renderProChanges,
  renderProLedger,
  renderProRecovery,
  renderProResult,
  renderProSsh,
  renderProState,
  renderProWatchStart,
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

/** What the relay ending the stream means, in the words that lead to the fix. */
const WATCH_ENDED = 'the bench closed the stream: CodeWaifu quit, or Pro was switched off.'

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

  // `watch` is the one verb that does not finish, so it leaves the request path
  // here: the read timeout that protects `pro state` from a hung relay would cut
  // a quiet watcher off after five seconds and report a fault where nothing went
  // wrong.
  if (parsed.verb === 'watch') return await runProWatch(point, parsed.path, parsed.json)

  // The one value that is deliberately not in argv, read here because the
  // parser is pure and read before the request because a body without its
  // secret is a body the far side rejects - and asking twice for a password is
  // how a human ends up typing it as an argument instead.
  const secret = parsed.secret === 'password' ? await readSecret(promptFor(parsed)) : null
  if (parsed.secret === 'password' && !secret) {
    cliStderr(
      secret === ''
        ? 'an empty password is not one, so nothing was stored: --clear forgets a stored one\n'
        : 'nothing was read, so nothing was stored\n'
    )
    return PRO_EXIT.usage
  }

  try {
    const { status, json } = await requestJson(parsed.method, point.port, parsed.path, {
      token: point.token,
      body: bodyFor(parsed, secret),
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
 * means the directory the command was typed in, and `pro term` with no `--dir`
 * means a shell there rather than one in the home directory. Only this process
 * can say where that is, so the field is filled on this side of the socket.
 */
function bodyFor(parsed: ProCliCall, secret: string | null): Record<string, unknown> | undefined {
  if (parsed.body === null) return undefined
  const body = { ...parsed.body }
  if (parsed.verb === 'new' && !String(body.workdir ?? '').trim()) body.workdir = process.cwd()
  if (parsed.verb === 'term' && !String(body.cwd ?? '').trim()) body.cwd = process.cwd()
  // Joined to the body this late, and only in memory: the secret never rides in
  // the parsed call a test snapshots, never in a log line, and never back out.
  if (secret) body.secret = secret
  return body
}

/**
 * The prompt names the machine, so a mistyped target is caught before the
 * typing rather than after the storing. Clipped because a pasted `ssh ...`
 * line is a legal target and is not a label.
 */
function promptFor(parsed: ProCliCall): string {
  const target = String(parsed.body?.target ?? '').trim()
  return target ? `password for ${clip(target, 40)}: ` : 'password: '
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
    case 'ssh':
    case 'term':
      // One route, many ops, and every one of them answers with a payload this
      // renderer reads by shape - so the subcommand does not have to be carried
      // through the call just to be able to print the reply.
      return renderProSsh(json, width)
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

/**
 * `codewaifu pro watch`: the tree once, then one line per change.
 *
 * Everything decided here is about *printing*, never about the bench: the diff
 * and its words live in `shared/proCli.ts` with the rest of the rendering, so
 * this stays the three impure things a pure module may not be (a socket, two
 * signals, one file descriptor).
 *
 * `--json` prints the frames verbatim, pings included. A script that wants the
 * push route should not have to reverse-engineer which parts of the stream we
 * decided humans do not need.
 */
async function runProWatch(point: Endpoint, path: string, raw: boolean): Promise<number> {
  const width = terminalWidth()
  let previous: ProStatePayload | null = null
  let shown = false
  let interrupted = false
  /**
   * Frames that land before `ready` has been awaited. The relay writes its first
   * frame before it subscribes, so this is normally empty; holding them anyway
   * means a reordering inside the client cannot silently drop the tree.
   */
  const early: unknown[] = []
  let live = false

  const print = (text: string): void => cliStdout(`${text}\n`)

  const onState = (payload: ProStatePayload): void => {
    const before = previous
    previous = payload
    if (!shown) {
      shown = true
      print(renderProWatchStart(payload, width))
      return
    }
    const changes = diffProViews(before, payload)
    if (!changes.length) return
    // A bench that came back is a new world, and the diff would report it as
    // every task arriving at once. The tree says the same thing usefully.
    if (changes.some((change) => change.change === 'bench' && change.running)) {
      print(renderProWatchStart(payload, width))
      return
    }
    print(renderProChanges(changes, Date.now(), width))
  }

  const consume = (frame: unknown): void => {
    if (raw) {
      print(JSON.stringify(frame))
      return
    }
    // A ping is liveness for the socket, not news for the human: one every
    // twenty seconds would fill the screen with lines saying nothing happened,
    // which is the noise a watcher exists to remove.
    if ((frame as { kind?: unknown } | null)?.kind !== 'state') return
    onState(frame as ProStatePayload)
  }

  const handle = streamNdjson(point.port, path, {
    token: point.token,
    onFrame: (frame) => {
      if (live) consume(frame)
      else early.push(frame)
    }
  })

  let ready
  try {
    ready = await handle.ready
  } catch (error) {
    // The socket died before the headers: the same "nobody home" the probe above
    // can miss when the app quits in between.
    log('error', 'pro watch could not connect', String(error))
    cliStderr(`${offlineText('no-app')}\n`)
    return PRO_EXIT.offline
  }
  if (ready.status !== 200) {
    const failure = failureFor(ready.status, ready.json)
    if (failure) {
      cliStderr(`${failure.text}\n`)
      return failure.exit
    }
    cliStderr(`the bench refused the stream (${ready.status})\n`)
    return exitForStatus(ready.status)
  }

  live = true
  for (const frame of early.splice(0)) consume(frame)

  /**
   * Ctrl-c is the documented way out, so it ends as an exit 0 rather than as a
   * signal death: a watcher a human stopped has to be distinguishable from one
   * that broke, or `while codewaifu pro watch; do ...` cannot be written.
   */
  const stop = (): void => {
    interrupted = true
    handle.close()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  /**
   * `pro watch | head -40` is a normal thing to type. Without this, the reader
   * leaving surfaces as an EPIPE on stdout, which Node turns into an uncaught
   * exception and a stack trace over the last line we printed.
   */
  process.stdout.once('error', stop)

  const closed = await handle.closed
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  process.stdout.removeListener('error', stop)

  if (interrupted) {
    // A newline, so the shell prompt does not land on the last change line.
    cliStdout('\n')
    return PRO_EXIT.ok
  }
  if (closed.reason === 'error') {
    log('error', 'pro watch stream broke', closed.detail)
    cliStderr(`the stream broke: ${closed.detail}\n`)
    return PRO_EXIT.offline
  }
  cliStderr(`${WATCH_ENDED}\n`)
  return PRO_EXIT.offline
}
