import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from './exec'
import { isWindows, platform } from './env'
import { log } from './log'

/**
 * A GUI app on macOS is launched by launchd and inherits a PATH of
 * `/usr/bin:/bin:/usr/sbin:/sbin`, so `codex`, `claude` or a Homebrew `curl`
 * are invisible. We rebuild a usable PATH once, from well-known locations plus
 * the user's login shell, and hand it to every child process.
 */
const CANDIDATE_DIRS_UNIX = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.bun', 'bin'),
  path.join(os.homedir(), '.deno', 'bin'),
  path.join(os.homedir(), '.cargo', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  path.join(os.homedir(), '.volta', 'bin'),
  path.join(os.homedir(), 'bin'),
  '/opt/local/bin'
]

const CANDIDATE_DIRS_WIN = [
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'codex'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
  path.join(os.homedir(), '.local', 'bin'),
  'C:\\Program Files\\nodejs'
]

let cachedPath: string | null = null
let cachedBinaries = new Map<string, string | null>()
let shellProbe: Promise<string> | null = null

export function separator(): string {
  return isWindows ? ';' : ':'
}

function dedupe(dirs: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of dirs) {
    if (!dir) continue
    const key = isWindows ? dir.toLowerCase() : dir
    if (seen.has(key)) continue
    seen.add(key)
    out.push(dir)
  }
  return out
}

/** Ask the login shell what PATH it would use. Best-effort and time-boxed. */
function probeShellPath(): Promise<string> {
  if (isWindows) return Promise.resolve('')
  if (shellProbe) return shellProbe
  const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL : '/bin/zsh'
  shellProbe = run(shell, ['-l', '-i', '-c', 'printf %s "$PATH"'], { timeoutMs: 6000 })
    .then((result) => {
      if (!result.ok) return ''
      // Interactive shells can emit motd noise; keep only a PATH-looking line.
      const line = result.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.includes('/') && !l.includes(' '))
        .pop()
      return line || ''
    })
    .catch(() => '')
  return shellProbe
}

export async function effectivePath(): Promise<string> {
  if (cachedPath) return cachedPath
  const current = (process.env.PATH || '').split(separator()).filter(Boolean)
  const candidates = isWindows ? CANDIDATE_DIRS_WIN : CANDIDATE_DIRS_UNIX
  const shell = await probeShellPath()
  const shellDirs = shell ? shell.split(separator()).filter(Boolean) : []
  const merged = dedupe([...current, ...shellDirs, ...candidates.filter((d) => exists(d))])
  cachedPath = merged.join(separator())
  return cachedPath
}

function exists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** Env for child processes, with the repaired PATH. */
export async function childEnv(extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  const PATH = await effectivePath()
  return { ...process.env, PATH, [isWindows ? 'Path' : 'PATH']: PATH, ...extra }
}

const WINDOWS_EXTS = ['', '.exe', '.cmd', '.bat', '.ps1']

/** Absolute path to a binary on the repaired PATH, or null. */
export async function findBinary(name: string): Promise<string | null> {
  if (cachedBinaries.has(name)) return cachedBinaries.get(name) ?? null
  const PATH = await effectivePath()
  const exts = isWindows ? WINDOWS_EXTS : ['']
  let found: string | null = null
  outer: for (const dir of PATH.split(separator())) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`)
      try {
        const stat = fs.statSync(candidate)
        if (!stat.isFile()) continue
        if (!isWindows && platform !== 'win32') {
          // eslint-disable-next-line no-bitwise
          if ((stat.mode & 0o111) === 0) continue
        }
        found = candidate
        break outer
      } catch {
        /* not here */
      }
    }
  }
  if (!found) log('info', `binary not found on PATH: ${name}`)
  cachedBinaries.set(name, found)
  return found
}

export function resetPathCache(): void {
  cachedPath = null
  cachedBinaries = new Map()
  shellProbe = null
}
