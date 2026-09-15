/**
 * Pro's slice of disk, and the only two ways it is written.
 *
 * The bench registry (`bench.json`) and one JSONL ledger per task
 * (`tasks/<taskId>.jsonl`) are the durable half of the design: the GUI is
 * disposable and must be re-derivable from these plus herdr. That claim is only
 * true if a crash mid-write cannot corrupt them, so every write here goes
 * through a temp file, an fsync, a rename and a read-back.
 *
 * Task ids come from user input, from a config file and from the HTTP API, so
 * they are also filenames. `isSafeTaskId` is the gate: anything that could
 * escape `tasks/` never becomes a path.
 */
import fs from 'node:fs'
import path from 'node:path'
import { stateDir } from '../env'

/** Everything Pro owns lives under here; nothing else on disk is ours. */
export const proDir = path.join(stateDir, 'pro')
/** The task registry: durable task records, never live state. */
export const benchFile = path.join(proDir, 'bench.json')
/** One `<taskId>.jsonl` ledger per task. */
export const tasksDir = path.join(proDir, 'tasks')

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * A task id is a filename, so it must not be able to travel. Length-capped and
 * charset-capped; `..` is rejected explicitly because the charset alone would
 * allow it and a ledger named `../config.json` is a config overwrite.
 */
export function isSafeTaskId(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const id = value.trim()
  if (!id || id.includes('..')) return false
  return TASK_ID.test(id)
}

/** `null` for an unsafe id, so a caller cannot accidentally `path.join` one. */
export function ledgerFileFor(taskId: string): string | null {
  return isSafeTaskId(taskId) ? path.join(tasksDir, `${taskId.trim()}.jsonl`) : null
}

export function ensureProDirs(): void {
  fs.mkdirSync(tasksDir, { recursive: true })
}

/**
 * Crash-proof write. The read-back is not paranoia: a full disk produces a
 * rename that succeeds with a truncated file, and discovering that at boot
 * (when the registry is being parsed) is far worse than discovering it here.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  ensureProDirs()
  const body = `${JSON.stringify(value, null, 2)}\n`
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, body, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  const back = fs.readFileSync(file, 'utf8')
  if (back !== body) throw new Error(`write verification failed for ${file}`)
}

/** Read a JSON file we wrote. Missing or corrupt reads as absent, never throws. */
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}
