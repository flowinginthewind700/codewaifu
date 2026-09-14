import fs from 'node:fs'
import path from 'node:path'
import {
  EMPTY_MEDIA,
  linuxMediaInvocation,
  macCommandScript,
  macStateScript,
  MAC_PLAYERS,
  parseLinuxState,
  parseMacState,
  prettyApp,
  windowsMediaScript,
  type MediaCommand,
  type MediaState
} from '../shared/media'
import { isLinux, isMac, isWindows, stateDir } from './env'
import { hasCommand, run } from './exec'
import { log } from './log'

const SCRIPT_DIR = path.join(stateDir, 'media')
const WINDOWS_SCRIPT = path.join(SCRIPT_DIR, 'media-control.ps1')
const TIMEOUT = 4000

let linuxHasPlayerctl: boolean | null = null
let lastWrittenScript = ''

/**
 * Read the current media session. Every backend is best-effort: a missing
 * player, a denied Automation permission or a WinRT failure all resolve to
 * `available:false` rather than throwing into the UI.
 */
export async function getMediaState(): Promise<MediaState> {
  try {
    if (isMac) return await macState()
    if (isWindows) return await windowsState('state')
    if (isLinux) return await linuxState()
  } catch (error) {
    log('warn', 'media state failed', String(error))
    return { ...EMPTY_MEDIA, error: String(error) }
  }
  return EMPTY_MEDIA
}

export async function sendMediaCommand(command: MediaCommand): Promise<MediaState> {
  try {
    if (isMac) {
      const app = await activeMacPlayer()
      if (app) {
        await run('osascript', ['-e', macCommandScript(app, command)], { timeoutMs: TIMEOUT })
      }
      return await macState()
    }
    if (isWindows) {
      await windowsState(command)
      return await windowsState('state')
    }
    if (isLinux) {
      if (await ensurePlayerctl()) {
        const invocation = linuxMediaInvocation(command)
        await run(invocation.cmd, invocation.args, { timeoutMs: TIMEOUT, quiet: true })
      }
      return await linuxState()
    }
  } catch (error) {
    log('warn', 'media command failed', String(error))
    return { ...EMPTY_MEDIA, error: String(error) }
  }
  return EMPTY_MEDIA
}

async function macState(): Promise<MediaState> {
  for (const app of MAC_PLAYERS) {
    const result = await run('osascript', ['-e', macStateScript(app)], { timeoutMs: TIMEOUT })
    const parsed = parseMacState(result.stdout)
    if (parsed) return { ...parsed, app: prettyApp(parsed.app) }
  }
  return { ...EMPTY_MEDIA }
}

/** The player that is actually playing, else the first one that is open. */
async function activeMacPlayer(): Promise<'Music' | 'Spotify' | null> {
  let fallback: 'Music' | 'Spotify' | null = null
  for (const app of MAC_PLAYERS) {
    const result = await run('osascript', ['-e', macStateScript(app)], { timeoutMs: TIMEOUT })
    const parsed = parseMacState(result.stdout)
    if (!parsed) continue
    if (parsed.playing) return app
    if (!fallback) fallback = app
  }
  if (fallback) return fallback
  // Nothing reported a track yet; ask without launching anything.
  for (const app of MAC_PLAYERS) {
    const running = await run('osascript', ['-e', `application "${app}" is running`], { timeoutMs: 2000 })
    if (/true/i.test(running.stdout)) return app
  }
  return null
}

async function windowsState(action: MediaCommand | 'state'): Promise<MediaState> {
  const script = ensureWindowsScript()
  if (!script) return { ...EMPTY_MEDIA }
  const result = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action],
    { timeoutMs: TIMEOUT + 2000 }
  )
  if (action !== 'state') return { ...EMPTY_MEDIA }
  const text = result.stdout.trim()
  if (!text) return { ...EMPTY_MEDIA, error: result.stderr.trim().slice(0, 200) || undefined }
  try {
    const parsed = JSON.parse(text.split(/\r?\n/).filter(Boolean).pop() || '{}') as Partial<MediaState>
    if (!parsed.available) return { ...EMPTY_MEDIA, error: parsed.error }
    return {
      available: true,
      playing: Boolean(parsed.playing),
      app: prettyApp(parsed.app || ''),
      title: String(parsed.title || ''),
      artist: String(parsed.artist || ''),
      album: String(parsed.album || '')
    }
  } catch (error) {
    return { ...EMPTY_MEDIA, error: String(error) }
  }
}

/**
 * Written once (or whenever the generated body changes) so the PowerShell call
 * stays a plain `-File` invocation with no inline quoting to get wrong.
 */
function ensureWindowsScript(): string | null {
  const body = windowsMediaScript()
  if (lastWrittenScript === body && fs.existsSync(WINDOWS_SCRIPT)) return WINDOWS_SCRIPT
  try {
    fs.mkdirSync(SCRIPT_DIR, { recursive: true })
    fs.writeFileSync(WINDOWS_SCRIPT, body, 'utf8')
    lastWrittenScript = body
    return WINDOWS_SCRIPT
  } catch (error) {
    log('warn', 'could not write media script', String(error))
    return null
  }
}

async function ensurePlayerctl(): Promise<boolean> {
  if (linuxHasPlayerctl === null) linuxHasPlayerctl = await hasCommand('playerctl')
  return linuxHasPlayerctl
}

async function linuxState(): Promise<MediaState> {
  if (!(await ensurePlayerctl())) return { ...EMPTY_MEDIA, error: 'playerctl not installed' }
  const invocation = linuxMediaInvocation('state')
  const result = await run(invocation.cmd, invocation.args, { timeoutMs: TIMEOUT })
  if (!result.ok) return { ...EMPTY_MEDIA }
  const parsed = parseLinuxState(result.stdout)
  if (!parsed) return { ...EMPTY_MEDIA }
  return { ...parsed, app: prettyApp(parsed.app) }
}

export function platformSupportsMedia(): boolean {
  return isMac || isWindows || isLinux
}
