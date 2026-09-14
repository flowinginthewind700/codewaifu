import { clipboard } from 'electron'
import type { Agent, SteerResult } from '../shared/protocol'
import { run } from './exec'
import { log } from './log'
import { childEnv, findBinary } from './shellPath'

/**
 * Codex can be steered from outside: `codex queue --thread <id> --message <t>`
 * hands the message to the running session through the local app-server daemon.
 * Claude Code has no equivalent injection API, so the honest fallback is the
 * clipboard plus a line telling the user to paste it.
 */
export async function steer(agent: Agent, threadId: string, message: string): Promise<SteerResult> {
  const text = String(message || '').trim()
  if (!text) return { ok: false, method: 'none', message: 'Nothing to send.' }

  if (agent === 'codex') {
    if (!threadId) return { ok: false, method: 'none', message: 'Pick a Codex thread first.' }
    const binary = await findBinary(process.env.CODEWAIFU_CODEX_BIN || 'codex')
    if (!binary) {
      copyToClipboard(text)
      return {
        ok: false,
        method: 'clipboard',
        message: 'Could not find the codex CLI, so the message is on your clipboard.'
      }
    }
    const env = await childEnv()
    const result = await run(binary, ['queue', '--thread', threadId, '--message', text], {
      timeoutMs: 15000,
      env
    })
    if (result.ok) {
      return { ok: true, method: 'queue', message: `Queued for Codex thread ${threadId.slice(0, 8)}.` }
    }
    log('warn', 'codex queue failed', result.stderr.slice(0, 400))
    copyToClipboard(text)
    return {
      ok: false,
      method: 'clipboard',
      message: `codex queue failed (${result.stderr.trim().slice(0, 80) || `exit ${result.code}`}); copied instead.`
    }
  }

  copyToClipboard(text)
  return {
    ok: true,
    method: 'clipboard',
    message: 'Claude Code cannot be injected from outside; the message is on your clipboard, paste it in.'
  }
}

function copyToClipboard(text: string): void {
  try {
    clipboard.writeText(text)
  } catch (error) {
    log('warn', 'clipboard write failed', String(error))
  }
}
