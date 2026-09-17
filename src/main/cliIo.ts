/**
 * The CLI's primitives: where the app is, the two file descriptors it writes,
 * and the one thing it may read off the third.
 *
 * They live together because every CLI surface needs all three and none of them
 * may be implemented twice. The write helpers are synchronous on purpose: the
 * CLI path ends in `app.exit()`, and Node's async pipe writes would be dropped
 * by it - `install.sh` parses this output, so a truncated line is a failed
 * install.
 */
import fs from 'node:fs'
import { parseEndpointEnv, type Endpoint } from '../shared/endpoint'
import { endpointFile } from './env'

export function cliStdout(text: string): void {
  try {
    fs.writeSync(1, text)
  } catch {
    process.stdout.write(text)
  }
}

export function cliStderr(text: string): void {
  try {
    fs.writeSync(2, text)
  } catch {
    process.stderr.write(text)
  }
}

/**
 * The handshake the app writes when it binds, or null.
 *
 * Null means "no app has ever started here" and a stale file means "one did and
 * it is gone"; the two are told apart by probing `/health`, never by trusting
 * the file - a port we used last week can be owned by an unrelated dev server
 * today.
 */
export function readEndpoint(): Endpoint | null {
  try {
    return parseEndpointEnv(fs.readFileSync(endpointFile, 'utf8'))
  } catch {
    return null
  }
}

/** The cap the IPC layer enforces on a stored secret, applied before it travels. */
const SECRET_MAX = 512

/**
 * Read one secret off fd 0, and never put it anywhere it can be read back.
 *
 * This exists because a password is the one value the CLI cannot accept as an
 * argument: argv is world-readable in `ps` for as long as the process lives and
 * is written into shell history, so a `--password` flag would publish the
 * secret to two audiences nobody invited. Typed input is therefore the only
 * way in, and it is handled two ways because a terminal and a pipe are not the
 * same instrument:
 *
 * - a terminal goes raw and echoes nothing, the way `ssh` and `sudo` behave.
 *   Backspace edits, Ctrl-C and Ctrl-D abandon, and a cursor escape sequence is
 *   swallowed whole - its trailing letters are not typed text and appending
 *   them would put `[A` into somebody's password.
 * - a pipe is read to EOF, which is what makes `gpg -dq pass.gpg | codewaifu
 *   pro ssh passwd prod` work: a script has no terminal to mask against, and
 *   refusing it would send it straight back to argv.
 *
 * null means "abandoned or nothing arrived", which the caller reports as
 * nothing stored. An empty line is '' and is the caller's to reject: only the
 * caller knows whether empty means clear or means mistake.
 */
export async function readSecret(prompt: string): Promise<string | null> {
  const stdin = process.stdin
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return await readPipedSecret()
  return await readMaskedSecret(prompt, stdin)
}

/** A non-terminal fd 0: whatever is piped in, minus one trailing newline. */
async function readPipedSecret(): Promise<string | null> {
  return await new Promise((resolve) => {
    let text = ''
    const stdin = process.stdin
    const finish = (): void => resolve(text ? text.replace(/\r?\n$/, '') : null)
    stdin.setEncoding('utf8')
    stdin.on('data', (chunk) => {
      text += String(chunk)
    })
    stdin.once('end', finish)
    stdin.once('error', finish)
    stdin.resume()
  })
}

/** A terminal fd 0: raw mode, no echo, line editing that never prints. */
async function readMaskedSecret(
  prompt: string,
  stdin: NodeJS.ReadStream
): Promise<string | null> {
  return await new Promise((resolve) => {
    let buffer = ''
    let settled = false
    const onData = (chunk: Buffer | string): void => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      for (let i = 0; i < text.length; i += 1) {
        const char = text[i]
        if (char === '\r' || char === '\n') return void finish(buffer)
        // Ctrl-C abandons rather than storing a half-typed secret, and Ctrl-D
        // is EOF: with text it ends the line, with none it is a cancellation.
        if (char === '\u0003') return void finish(null)
        if (char === '\u0004') return void finish(buffer || null)
        if (char === '\u007f' || char === '\u0008') {
          buffer = buffer.slice(0, -1)
          continue
        }
        if (char === '\u001b') {
          i = skipEscape(text, i)
          continue
        }
        // Any other control character is not something a password prompt
        // should be storing on somebody's behalf.
        if (char < ' ') continue
        if (buffer.length < SECRET_MAX) buffer += char
      }
    }
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      stdin.off('error', onEnd)
      try {
        stdin.setRawMode(false)
      } catch {
        // The terminal went away mid-read. The answer we have is still the
        // answer, and there is nothing left to restore.
      }
      stdin.pause()
      // The newline the suppressed echo would have printed: without it the
      // shell prompt lands on the same line as our report.
      cliStderr('\n')
      resolve(value)
    }
    const onEnd = (): void => finish(buffer || null)
    cliStderr(prompt)
    try {
      stdin.setRawMode(true)
    } catch {
      // Echoed input is worse than masked input, but it is better than a
      // command that cannot be run at all on a terminal that will not go raw.
    }
    stdin.on('data', onData)
    stdin.once('end', onEnd)
    stdin.once('error', onEnd)
    stdin.resume()
  })
}

/**
 * Index of the last character of a CSI/SS3 escape sequence starting at `at`, or
 * of the ESC itself when it is a lone one. Cursor keys arrive as three
 * characters and only the first of them is a control code.
 */
function skipEscape(text: string, at: number): number {
  const next = text[at + 1]
  if (next !== '[' && next !== 'O') return at
  let i = at + 2
  while (i < text.length && !/[a-zA-Z~]/.test(text[i])) i += 1
  return i
}
