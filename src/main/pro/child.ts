/**
 * The one way this subsystem starts a child process.
 *
 * Both ssh runners - the key probe in `ssh.ts` and the password probe in
 * `askpass.ts` - end up here, so `execFile`'s two awkward failure shapes are
 * folded exactly once: a timeout arrives as a killed child rather than an exit
 * code, and a spawn failure (no `ssh` on PATH) arrives as a string `code`
 * rather than a number. `classifyProbe` reads the result, so getting this wrong
 * would mislabel a missing client as an authentication failure.
 */
import { execFile } from 'node:child_process'

export interface SshRunResult {
  code: number
  stdout: string
  stderr: string
  /** True when we killed the child for exceeding the timeout. */
  timedOut: boolean
}

export type ChildRunner = (
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
  env?: Record<string, string>
) => Promise<SshRunResult>

/**
 * `env` is merged into the parent's rather than replacing it: a probe that lost
 * `PATH` or `HOME` would fail for a reason that has nothing to do with the box
 * being probed. It is an environment and never a shell string, so no platform's
 * quoting rules get a say in what a password means.
 */
export const runSsh: ChildRunner = (cmd, args, timeoutMs, env) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      [...args],
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        ...(env ? { env: { ...process.env, ...env } } : {})
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : ''
        const err = typeof stderr === 'string' ? stderr : ''
        if (!error) {
          resolve({ code: 0, stdout: out, stderr: err, timedOut: false })
          return
        }
        const e = error as NodeJS.ErrnoException & {
          code?: number | string
          killed?: boolean
          signal?: string
        }
        if (e.killed || e.signal === 'SIGTERM' || e.signal === 'SIGKILL') {
          resolve({
            code: typeof e.code === 'number' ? e.code : 255,
            stdout: out,
            stderr: err,
            timedOut: true
          })
          return
        }
        if (typeof e.code === 'number') {
          resolve({ code: e.code, stdout: out, stderr: err, timedOut: false })
          return
        }
        resolve({
          code: 127,
          stdout: out,
          stderr: err || String(error.message || error),
          timedOut: false
        })
      }
    )
  })
