import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseConfig, type AppConfig } from '../shared/config'
import { isSafeToken } from '../shared/endpoint'
import { normalizeRequestedPort } from '../shared/portPolicy'
import { configFile, stateDir } from './env'
import { log } from './log'

export function newToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

export function readConfig(): AppConfig {
  let raw: unknown = {}
  try {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  } catch {
    raw = {}
  }
  return ensureIdentity(parseConfig(raw))
}

export function writeConfig(config: AppConfig): AppConfig {
  const next = ensureIdentity(config)
  fs.mkdirSync(stateDir, { recursive: true })
  const tmp = `${configFile}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, configFile)
  return next
}

/**
 * The token is generated once and reused, so hook runners keep working across
 * restarts without re-touching the agents' config files. The port is *not*
 * generated here: 0 means "let the kernel choose at bind time", and a port we
 * picked without binding it is exactly the kind of guess that collides later.
 */
export function ensureIdentity(config: AppConfig): AppConfig {
  let changed = false
  const next = { ...config }
  if (!isSafeToken(next.token)) {
    next.token = newToken()
    changed = true
  }
  const port = normalizeRequestedPort(next.port)
  if (port !== next.port) {
    next.port = port
    changed = true
  }
  if (changed) {
    try {
      return writeConfigRaw(next)
    } catch (error) {
      log('warn', 'could not persist generated identity', String(error))
      return next
    }
  }
  return next
}

function writeConfigRaw(config: AppConfig): AppConfig {
  fs.mkdirSync(stateDir, { recursive: true })
  const tmp = `${configFile}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, configFile)
  return config
}

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** Backup next to the original plus a timestamped copy in our state dir. */
export function backupFile(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null
    fs.mkdirSync(path.join(stateDir, 'backups'), { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const copy = path.join(stateDir, 'backups', `${path.basename(file)}.${stamp}`)
    fs.copyFileSync(file, copy)
    fs.copyFileSync(file, `${file}.codewaifu.bak`)
    return copy
  } catch (error) {
    log('warn', `backup failed for ${file}`, String(error))
    return null
  }
}
