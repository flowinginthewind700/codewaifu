import * as fs from 'node:fs'
import type { Agent } from '../shared/protocol'
import { deliveryFound } from '../shared/steer'
import { transcriptFile } from './transcript'

/** Session id -> transcript path. Injectable so tests need no agent home. */
export type Resolver = (agent: Agent, threadId: string) => string | null

/**
 * Delivery confirmation for a steered message.
 *
 * Nothing the CLIs return can be trusted as proof of delivery — `codex queue`
 * exits 0 for a session that will never read the queue — so the only truthful
 * signal available from outside is the agent's own transcript: the message
 * shows up there when the session actually took it. Both helpers here read the
 * file directly and never touch the agents' state.
 *
 * Split out from steer.ts on purpose: that module needs Electron's clipboard,
 * these need only fs, and the confirmation logic is the part worth testing.
 */

/** How often the tail is re-read while waiting for the queue to be consumed. */
export const POLL_MS = 300
/** A session that is going to take the message does it within a turn boundary. */
export const CONFIRM_MS = 3000
/** Transcript writes newer than this mean the agent is working right now. */
export const ACTIVE_MS = 120_000
/** Bytes re-read per poll — the row we are looking for is always at the end. */
const TAIL_BYTES = 128 * 1024

/** True when the agent has written to this transcript recently, i.e. it is working. */
export function isActive(
  agent: Agent,
  threadId: string,
  now: number = Date.now(),
  resolve: Resolver = transcriptFile
): boolean {
  const file = resolve(agent, threadId)
  if (!file) return false
  try {
    return now - fs.statSync(file).mtimeMs < ACTIVE_MS
  } catch {
    return false
  }
}

/** Poll the transcript tail until the steered text shows up, or give up. */
export async function confirmDelivery(
  agent: Agent,
  threadId: string,
  text: string,
  timeoutMs: number = CONFIRM_MS,
  resolve: Resolver = transcriptFile
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const file = resolve(agent, threadId)
    if (file && deliveryFound(tailOf(file), text)) return true
    if (Date.now() >= deadline) return false
    await new Promise((rest) => setTimeout(rest, POLL_MS))
  }
}

/** Last `TAIL_BYTES` of a file as text; empty string when it is unreadable. */
export function tailOf(file: string): string {
  let handle: number | null = null
  try {
    const { size } = fs.statSync(file)
    const start = Math.max(0, size - TAIL_BYTES)
    const length = size - start
    if (length <= 0) return ''
    handle = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(length)
    fs.readSync(handle, buffer, 0, length, start)
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle)
      } catch {
        /* already gone */
      }
    }
  }
}
