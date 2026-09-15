/**
 * NDJSON framing for herdr's socket.
 *
 * Small and separate because three different streams need it (API replies, the
 * event subscription, the terminal bridge) and a framing bug in any of them
 * looks identical: a JSON parse error on a line that was simply cut in half by
 * the read boundary.
 */

/** Splits a byte stream into complete lines, keeping the partial tail. */
export class LineDecoder {
  private buffer = ''
  /** Guard against a peer that never sends a newline: 8 MB is not a line. */
  private readonly limit: number

  constructor(limitBytes = 8 * 1024 * 1024) {
    this.limit = limitBytes
  }

  push(chunk: string): string[] {
    if (!chunk) return []
    this.buffer += chunk
    const out: string[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim()) out.push(line)
      newline = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > this.limit) {
      // Drop the runaway tail instead of growing without bound; the next
      // complete line still parses, so one bad peer cannot kill the bench.
      this.buffer = ''
    }
    return out
  }

  /** Flush a trailing line that never got its newline (EOF mid-write). */
  end(): string[] {
    const line = this.buffer.replace(/\r$/, '').trim()
    this.buffer = ''
    return line ? [line] : []
  }

  get pending(): number {
    return this.buffer.length
  }
}

let counter = 0

/** Request ids are per-connection unique and readable in a log. */
export function nextRequestId(prefix = 'cw'): string {
  counter = (counter + 1) % 1e9
  return `${prefix}:${process.pid.toString(36)}:${counter.toString(36)}`
}

export function encodeRequest(id: string, method: string, params: unknown): string {
  return `${JSON.stringify({ id, method, params: params ?? {} })}\n`
}
