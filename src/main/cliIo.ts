/**
 * The CLI's three primitives: where the app is, and the two file descriptors.
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
