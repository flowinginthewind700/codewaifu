import { spawnSync } from 'node:child_process'
import {
  compositorProbeCommand,
  parseCompositorProbe,
  parseStatusNotifier,
  sessionInfo,
  statusNotifierProbe,
  trayAdvice,
  type CompositorProbe,
  type LinuxSession
} from '../shared/linuxRuntime'
import { log } from './log'

/**
 * Desktop probes, synchronous on purpose: the window surface is decided in the
 * same tick as `new BrowserWindow()` and there is nothing useful to await. Each
 * one is a local X11 or D-Bus round trip (single-digit milliseconds) behind a
 * hard timeout, and every failure resolves to "unknown" instead of throwing.
 */
interface ProbeResult {
  ok: boolean
  stdout: string
  stderr: string
}

function probe(cmd: string, args: string[], timeoutMs: number): ProbeResult {
  try {
    const result = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (result.error) return { ok: false, stdout: '', stderr: String(result.error) }
    return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } catch (error) {
    return { ok: false, stdout: '', stderr: String(error) }
  }
}

/** Is a compositing manager running? Drives the transparency decision. */
export function compositorProbe(): CompositorProbe {
  const { cmd, args } = compositorProbeCommand()
  return parseCompositorProbe(probe(cmd, args, 1500))
}

/** Is a tray host listening for StatusNotifier items? */
export function statusNotifierPresent(): boolean {
  const { cmd, args } = statusNotifierProbe()
  return parseStatusNotifier(probe(cmd, args, 1500))
}

export function currentSession(): LinuxSession {
  return sessionInfo(process.env)
}

/**
 * One boot-time log line describing the desktop we are on, plus the fix when a
 * tray icon cannot appear. The tray failing silently is the single most
 * confusing Linux failure mode here: the companion hides and there is nothing
 * left to click, so the advice has to be somewhere the user will find it.
 */
export function logDesktop(session: LinuxSession = currentSession(), surface?: string): void {
  const watcher = statusNotifierPresent()
  const advice = trayAdvice(watcher, session.desktop)
  log('info', 'linux session', {
    display: session.display,
    desktop: session.desktop || 'unknown',
    x11: session.x11,
    surface: surface ?? '',
    tray: watcher
  })
  if (advice) log('warn', 'tray', advice)
}
