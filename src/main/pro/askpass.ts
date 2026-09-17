/**
 * Handing ssh a password without ever putting it where somebody can read it.
 *
 * `ssh` has exactly one supported way to take a password from a program: it runs
 * the executable named by `SSH_ASKPASS` and reads the answer from its stdout.
 * So the password cannot be an argument (that is `ps` output and shell history),
 * cannot be piped to ssh's stdin (ssh insists on a tty for prompts unless
 * askpass is in play) and cannot be typed into a pane (that is the scrollback,
 * which the app renders and the ledger may quote).
 *
 * What is left, and what this does:
 *
 * - a tiny helper script that prints one file's contents. It is generated once
 *   per install, holds no secret, and is 0700.
 * - the password in a 0600 file whose *path* travels to the helper through
 *   `CW_ASKPASS_FILE`. The file lives for the length of one probe and is
 *   deleted in a `finally`, so an interrupted run leaves at most one orphan
 *   that the next call sweeps.
 * - `SSH_ASKPASS_REQUIRE=force` in the child's environment, which is what makes
 *   ssh use the helper even with a terminal attached. It is an *environment*
 *   variable rather than `-o SSH_ASKPASS_REQUIRE=force` on purpose: an ssh too
 *   old to know the option (pre-8.4) ignores an unknown env var and simply
 *   falls back to failing, where an unknown `-o` makes it exit 255 with
 *   "Bad configuration option" and turns a missing feature into a scary error.
 *
 * The child gets `env` rather than a shell string, so no quoting rule of any
 * platform is load-bearing here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { proDir } from './env'
// `runSsh` is the one real child runner in this subsystem, and it is the thing
// that knows how an `execFile` failure folds into a probe verdict. Importing it
// keeps that knowledge in one file; ssh.ts only ever sees this module's
// structural interface, so the dependency stays one-directional
// (ssh.ts -> askpass.ts -> child.ts, never back).
import { runSsh, type SshRunResult } from './child'

/** The posix helper: print the file the environment names, and nothing else. */
const POSIX_HELPER = '#!/bin/sh\nexec cat "$CW_ASKPASS_FILE"\n'
/** The Windows helper. `type` writes the file verbatim; `exit /b` keeps ssh's exit code ours. */
const WINDOWS_HELPER = '@echo off\r\ntype "%CW_ASKPASS_FILE%" 2>nul\r\n'

const ENV_NAME = 'SSH_ASKPASS'
const FILE_ENV = 'CW_ASKPASS_FILE'

export interface AskpassDeps {
  /** Where the helper and the one-probe password file live. Defaults to proDir. */
  dir?: string
  platform?: 'posix' | 'windows'
  /** Injectable child runner; the real one is `execFile` with an env override. */
  exec?: (
    cmd: string,
    args: readonly string[],
    timeoutMs: number,
    env: Record<string, string>
  ) => Promise<SshRunResult>
  now?: () => number
}

export class Askpass {
  private readonly dir: string
  private readonly platform: 'posix' | 'windows'
  private readonly exec: (
    cmd: string,
    args: readonly string[],
    timeoutMs: number,
    env: Record<string, string>
  ) => Promise<SshRunResult>
  private readonly now: () => number
  private counter = 0

  constructor(deps: AskpassDeps = {}) {
    this.dir = deps.dir ?? proDir
    this.platform = deps.platform ?? (process.platform === 'win32' ? 'windows' : 'posix')
    this.exec = deps.exec ?? runSsh
    this.now = deps.now ?? (() => Date.now())
  }

  /** The helper's path, writing it when it is missing or stale. '' when it cannot be made. */
  helper(): string {
    const body = this.platform === 'windows' ? WINDOWS_HELPER : POSIX_HELPER
    const file = path.join(this.dir, this.platform === 'windows' ? 'askpass.cmd' : 'askpass.sh')
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      // Rewritten only when the bytes differ: this runs on every password probe,
      // and a write per probe is a write that can fail mid-run.
      if (readOrNull(file) !== body) {
        fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o700 })
      }
      fs.chmodSync(file, 0o700)
      return file
    } catch {
      return ''
    }
  }

  /**
   * Run `argv` (an `ssh` probe) with the password available to ssh's askpass
   * helper and to nothing else. The result is the child's own, so the caller
   * classifies it exactly as it classifies a key probe: exit 0 means the
   * password was accepted.
   */
  async run(
    argv: readonly string[],
    password: string,
    timeoutMs: number
  ): Promise<SshRunResult> {
    const [cmd, ...args] = argv
    const helper = this.helper()
    if (!cmd || !helper || !password) {
      return { code: 127, stdout: '', stderr: 'no askpass helper could be written', timedOut: false }
    }
    this.sweep()
    const file = path.join(
      this.dir,
      `askpass-${process.pid}-${this.now().toString(36)}-${(this.counter += 1)}.tmp`
    )
    try {
      // 0600 at creation, not after: the window between the two is the window
      // in which a plaintext password is readable by another local user.
      const fd = fs.openSync(file, 'w', 0o600)
      try {
        fs.writeFileSync(fd, password, 'utf8')
      } finally {
        fs.closeSync(fd)
      }
      fs.chmodSync(file, 0o600)
      return await this.exec(cmd, args, timeoutMs, {
        [ENV_NAME]: helper,
        SSH_ASKPASS_REQUIRE: 'force',
        [FILE_ENV]: file
      })
    } catch (error) {
      return { code: 127, stdout: '', stderr: `askpass failed: ${String(error)}`, timedOut: false }
    } finally {
      removeQuietly(file)
    }
  }

  /** Drop password files an earlier crash left behind. They are always stale. */
  private sweep(): void {
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.startsWith('askpass-') || !name.endsWith('.tmp')) continue
        removeQuietly(path.join(this.dir, name))
      }
    } catch {
      // No directory yet, or no permission to list it: nothing to sweep.
    }
  }
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    // Already gone, or never written. Either way there is nothing left to do.
  }
}
