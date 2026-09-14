import fs from 'node:fs'
import { logFile } from './env'

const MAX_BYTES = 512 * 1024
let stream: fs.WriteStream | null = null
let disabled = process.env.CODEWAIFU_NO_LOG === '1'

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(logFile)
    if (stat.size <= MAX_BYTES) return
  } catch {
    return
  }
  try {
    stream?.end()
    stream = null
    fs.renameSync(logFile, `${logFile}.1`)
  } catch {
    /* a failed rotation must never break the app */
  }
}

export function log(level: 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${meta === undefined ? '' : ` ${safe(meta)}`}\n`
  if (process.env.CODEWAIFU_DEBUG || process.env.NODE_ENV !== 'production') process.stderr.write(line)
  if (disabled) return
  try {
    rotateIfNeeded()
    if (!stream) stream = fs.createWriteStream(logFile, { flags: 'a' })
    stream.write(line)
  } catch {
    disabled = true
  }
}

function safe(meta: unknown): string {
  try {
    return typeof meta === 'string' ? meta : JSON.stringify(meta)
  } catch {
    return String(meta)
  }
}

export function closeLog(): void {
  try {
    stream?.end()
  } catch {
    /* ignore */
  }
  stream = null
}
