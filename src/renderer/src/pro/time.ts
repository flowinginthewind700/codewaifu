/**
 * Two clocks the bench shows, and nothing else.
 *
 * `dur` is a *span* ("blocked 4m"), `ago` is that span anchored to now
 * ("4m ago"). They share one unit ladder because a row that says "blocked 4m"
 * next to a row that says "5 minutes ago" is two vocabularies for one idea.
 *
 * Everything rounds *down* to the coarse unit that still carries information.
 * A tree full of "0m" is worse than one full of "45s": the first reads as
 * broken, the second as recent.
 */
import { fill, type Translate } from './i18n'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A span in the coarsest unit that still says something. */
export function dur(ms: number, t: Translate): string {
  const value = Math.max(0, Math.floor(Number(ms) || 0))
  if (value < 5_000) return t('timeNow')
  if (value < MINUTE) return fill(t, 'timeSeconds', { n: Math.round(value / 1000) })
  if (value < HOUR) return fill(t, 'timeMinutes', { n: Math.floor(value / MINUTE) })
  if (value < DAY) return fill(t, 'timeHours', { n: Math.floor(value / HOUR) })
  return fill(t, 'timeDays', { n: Math.floor(value / DAY) })
}

/**
 * "How long since". `0` / NaN means "we have no timestamp", which renders as an
 * em-dash rather than as "just now" - claiming freshness for data we never got
 * is exactly the kind of lie a cockpit must not tell.
 */
export function ago(ts: number, now: number, t: Translate): string {
  const at = Number(ts) || 0
  if (!at) return t('never')
  return fill(t, 'timeAgo', { t: dur(Math.max(0, now - at), t) })
}

/** Compact clock for ledger rows, where a date is noise and a time is not. */
export function clock(ts: number): string {
  const at = Number(ts) || 0
  if (!at) return ''
  const date = new Date(at)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}
