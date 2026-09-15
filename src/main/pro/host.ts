/**
 * The two decisions Pro's host makes that are easy to get wrong and invisible
 * from a test of the service, kept pure so they can be pinned.
 *
 * `ProService` reaches the app through `ProHost`, and `main/index.ts` is where
 * that interface meets real `BrowserWindow`s. Everything else about the host is
 * plumbing; what is policy lives here.
 */
import { IPC } from '../../shared/ipcChannels'

/** Which renderer a main -> renderer push belongs to. */
export type ProAudience = 'widget' | 'bench'

/**
 * The companion channel is the widget's; everything else is the Bench's.
 *
 * The split is by channel rather than by payload inspection, because one bridge
 * serves two audiences that must not see each other's traffic: the widget has no
 * pane grid to draw terminal frames into, and the Bench renders the same numbers
 * from the projection it already holds. Getting this backwards does not throw -
 * it silently routes frame traffic into a transparent always-on-top window.
 */
export function proAudience(channel: string): ProAudience {
  return channel === IPC.pushProCompanion ? 'widget' : 'bench'
}

export type ProLogLevel = 'info' | 'warn' | 'error'

/** Pro logs with a free-form level; this app writes three. */
export function narrowLogLevel(level: string): ProLogLevel {
  return level === 'error' || level === 'warn' ? level : 'info'
}
