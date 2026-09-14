// ============================================================
// Did the steer message actually reach the agent?
//
// `codex queue --thread <id> --message <t>` exits 0 and writes a row into
// `~/.codex/queue_1.sqlite::queued_items` for *every* thread — idle or mid-turn.
// A session that is already working never polls that queue (reproduced against a
// live `codex exec`: the row sat in `queued_items` and never reached the
// rollout), so treating exit 0 as success tells the user "sent" while the agent
// ignores them. Delivery is confirmed the only honest way available from
// outside: the message turns up in the agent's own transcript.
//
// ⛔ Keep this module free of node/electron imports — it is unit tested.
// ============================================================

/** Code points of the message used as the needle; long pastes need no more. */
export const NEEDLE_CHARS = 160

/**
 * The message as it appears inside a JSONL transcript row: JSON-escaped, minus
 * the surrounding quotes. Slicing by code point keeps surrogate pairs whole —
 * cutting one in half would escape to `\ud83d` and never match the file.
 */
export function jsonNeedle(text: string): string {
  const head = Array.from(String(text ?? '')).slice(0, NEEDLE_CHARS).join('')
  return JSON.stringify(head).slice(1, -1)
}

/**
 * True when a raw transcript body already carries this message as a complete
 * JSON string value.
 *
 * The quotes on both sides are the point: a bare substring match would call a
 * message delivered when the transcript merely contains a *longer* message that
 * starts the same way, and a false "delivered" is the exact failure this module
 * exists to remove. A paste longer than `NEEDLE_CHARS` is matched on its head
 * alone, because the cut means the closing quote is not in the needle.
 */
export function deliveryFound(body: string, text: string): boolean {
  const source = String(body ?? '')
  const points = Array.from(String(text ?? ''))
  const needle = jsonNeedle(text)
  if (!needle) return false
  if (source.includes(`"${needle}"`)) return true
  return points.length > NEEDLE_CHARS && source.includes(needle)
}
