import { spawn } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  ok: boolean
}

export interface RunOptions {
  timeoutMs?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Feed this to the child's stdin, then close it. */
  input?: string
  /** Do not log a failure as an error (expected misses, e.g. app not installed). */
  quiet?: boolean
}

/**
 * Single place that shells out. Arguments are always passed as an array so no
 * user-controlled string is ever interpolated into a shell command line.
 */
export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 5000
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error), ok: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, ok: code === 0 })
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish(-1)
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 200_000) stderr += chunk
    })
    child.once('error', (error) => {
      stderr += String(error)
      finish(-1)
    })
    child.once('exit', (code) => finish(code ?? -1))
    if (options.input !== undefined) {
      try {
        child.stdin?.end(options.input)
      } catch {
        try {
          child.stdin?.end()
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        child.stdin?.end()
      } catch {
        /* ignore */
      }
    }
  })
}

/** `true` when the binary exists on PATH. */
export async function hasCommand(cmd: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'command'
  const args = process.platform === 'win32' ? [cmd] : ['-v', cmd]
  const shell = process.platform === 'win32' ? undefined : '/bin/sh'
  const result = shell
    ? await run(shell, ['-c', `command -v ${cmd}`], { timeoutMs: 1500 })
    : await run(probe, args, { timeoutMs: 1500 })
  return result.ok && result.stdout.trim().length > 0
}
