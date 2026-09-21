import { clipboard } from 'electron'
import { agentLabel } from '../shared/phrases'
import type { Agent, SteerResult } from '../shared/protocol'
import { CONFIRM_MS, confirmDelivery, isActive } from './delivery'
import { run } from './exec'
import { log } from './log'
import { childEnv, findBinary } from './shellPath'

/**
 * Codex can be steered from outside: `codex queue --thread <id> --message <t>`
 * drops the message into `~/.codex/queue_1.sqlite`, and a session reads that
 * queue when it is at a turn boundary. The catch — verified against a live
 * `codex exec` — is that the CLI exits 0 whether or not anyone ever reads the
 * row: a session that is mid-turn keeps working and the message just sits in
 * `queued_items`. So every Codex result here is confirmed against the agent's
 * own transcript, and an unconfirmed one says so and also copies the text to
 * the clipboard, which is the one path that always works.
 *
 * Every other agent has no injection API at all - Claude Code, Cursor, Gemini,
 * Antigravity, Kimi all talk to their own TUI and nothing else - so the honest
 * fallback there is the clipboard plus a line telling the user to paste it.
 */
export async function steer(agent: Agent, threadId: string, message: string): Promise<SteerResult> {
  const text = String(message || '').trim()
  if (!text) return { ok: false, method: 'none', reason: 'empty', message: 'Nothing to send.' }

  if (agent === 'codex') {
    if (!threadId) return { ok: false, method: 'none', reason: 'empty', message: 'Pick a Codex thread first.' }
    const binary = await findBinary(process.env.CODEWAIFU_CODEX_BIN || 'codex')
    if (!binary) {
      copyToClipboard(text)
      return {
        ok: false,
        method: 'clipboard',
        reason: 'no-cli',
        message: 'Could not find the codex CLI, so the message is on your clipboard.'
      }
    }
    const env = await childEnv()
    const result = await run(binary, ['queue', '--thread', threadId, '--message', text], {
      timeoutMs: 15000,
      env
    })
    if (!result.ok) {
      log('warn', 'codex queue failed', result.stderr.slice(0, 400))
      copyToClipboard(text)
      return {
        ok: false,
        method: 'clipboard',
        reason: 'failed',
        message: `codex queue failed (${result.stderr.trim().slice(0, 80) || `exit ${result.code}`}); copied instead.`
      }
    }

    const short = threadId.slice(0, 8)
    // An idle session will not read the queue now, so polling it would only
    // burn three seconds: one look, then the clipboard. The row stays queued in
    // case a Codex client picks it up when the thread resumes.
    const active = isActive('codex', threadId)
    if (await confirmDelivery('codex', threadId, text, active ? CONFIRM_MS : 0)) {
      return { ok: true, method: 'queue', reason: 'sent', message: `Delivered to Codex thread ${short}.` }
    }

    log('warn', 'steer queued but never read', `thread=${threadId} active=${active} — left in queued_items, copied instead`)
    copyToClipboard(text)
    return {
      ok: false,
      method: 'clipboard',
      reason: active ? 'undelivered' : 'queued',
      message: active
        ? `Codex accepted the queue but the working session did not read it within ${CONFIRM_MS / 1000}s; copied to your clipboard.`
        : `Queued for idle Codex thread ${short}, with no confirmation it will be read; copied to your clipboard.`
    }
  }

  copyToClipboard(text)
  const name = agentLabel(agent, 'en')
  return {
    ok: true,
    method: 'clipboard',
    reason: 'clipboard',
    message: `${name} cannot be injected from outside; the message is on your clipboard, paste it in.`
  }
}

function copyToClipboard(text: string): void {
  try {
    clipboard.writeText(text)
  } catch (error) {
    log('warn', 'clipboard write failed', String(error))
  }
}
