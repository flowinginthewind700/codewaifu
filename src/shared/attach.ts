/**
 * Turning "a file arrived" into the only thing a terminal can carry: text.
 *
 * Two doors into a prompt - a drag from the desktop and a paste from the
 * clipboard - and on the far side of both is a PTY that accepts bytes and
 * nothing else. So an attachment is not an upload, not a blob and not a
 * thumbnail; it is an absolute path, quoted for the shell that is about to read
 * it, inserted where the caret already was. That is also what the agent wants:
 * codex and Claude Code both take an image as a path they can open themselves,
 * and a path survives a queue write, a scrollback and a transcript verbatim in
 * a way a base64 blob does not.
 *
 * Everything here is pure and platform-aware, because the two rules that decide
 * whether the feature works are exactly the two a test can pin: which paths
 * need quoting, and where the caret lands afterwards.
 */

/** The two shell dialects the inserted text can be read by. */
export type AttachPlatform = 'posix' | 'windows'

/**
 * How many paths one gesture may insert. Dragging a folder by accident is four
 * thousand files, and four thousand quoted paths in a prompt is not an
 * attachment - it is a denial of the input box. The cap is on the gesture, not
 * on the roster: a second drop appends.
 */
export const MAX_ATTACHMENTS = 24

/** A path longer than this is not a path anybody can use, and it is a prompt's worth of room. */
export const MAX_PATH_LEN = 4096

/**
 * Characters that survive an unquoted POSIX word. Deliberately narrower than
 * what bash would tolerate: `~` is expansion, `#` starts a comment mid-word in
 * some shells, and a path with a `*` in it is a glob whether or not the file
 * exists. Quoting a path that did not need it costs two characters and cannot
 * be wrong.
 */
const POSIX_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

/** Same idea for `cmd`/PowerShell, where `%`, `^`, `&` and `(` are the sharp edges. */
const WINDOWS_SAFE = /^[A-Za-z0-9_@+=:,.[\]\\/-]+$/

/**
 * The paths of one gesture, in order, with the noise removed.
 *
 * A drag carries entries that have no path at all - dragged text, a dragged
 * selection from a browser, an image copied from a screenshot tool - and those
 * arrive as `''` from the preload's `getPathForFile`. Dropping them here keeps
 * every caller honest about the case that matters most: a dropped folder is one
 * path, a dropped screenshot is none, and "none" has to be distinguishable from
 * "the clipboard had an image instead".
 */
export function cleanPaths(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    if (typeof raw !== 'string') continue
    const value = raw.trim()
    if (!value || value.length > MAX_PATH_LEN) continue
    // One drop of the same file twice is one path. Two drops are the user's
    // business and are not this function's to judge.
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (out.length >= MAX_ATTACHMENTS) break
  }
  return out
}

/** Quote one path for the shell that will read it, and only when it must be. */
export function quotePath(raw: string, platform: AttachPlatform): string {
  const value = raw.trim()
  if (!value) return "''"
  if (platform === 'windows') {
    if (WINDOWS_SAFE.test(value)) return value
    // A Windows path cannot contain a quote, so there is nothing to escape:
    // the pair is the whole job.
    return `"${value}"`
  }
  if (POSIX_SAFE.test(value)) return value
  // The one POSIX quoting that cannot be surprised by the content: everything
  // inside single quotes is literal, and an embedded quote is closed, escaped
  // beside the pair, and reopened.
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export interface PathsToTextOptions {
  /**
   * A trailing space, which is what makes the insertion feel typed rather than
   * pasted: the next character the human types is a new word instead of the
   * tail of a filename. Off for the textarea, where the caret is already after
   * the insertion and a space would be a stray one at the end of a line.
   */
  trailing?: boolean
  /** Between two paths. A space is what a shell argument list wants. */
  separator?: string
}

/** The text one gesture inserts: every path quoted, space separated. */
export function pathsToText(
  paths: readonly string[],
  platform: AttachPlatform,
  options: PathsToTextOptions = {}
): string {
  const { trailing = true, separator = ' ' } = options
  const body = paths.map((value) => quotePath(value, platform)).join(separator)
  if (!body) return ''
  return trailing ? `${body} ` : body
}

export interface Insertion {
  value: string
  /** Where the caret belongs after the insertion, which is not `start + length` in general. */
  caret: number
}

/**
 * Insert at a textarea's caret, replacing whatever was selected.
 *
 * A paste that lands at the end of the field is the common case and the wrong
 * one to hard-code: the human puts the caret where the sentence is, and an
 * attachment appended after a signature reads as if it belonged to nobody.
 */
export function insertAtCursor(
  value: string,
  insertion: string,
  start: number,
  end: number
): Insertion {
  const text = value ?? ''
  const from = clamp(start, text.length)
  const to = clamp(end, text.length, from)
  const next = `${text.slice(0, from)}${insertion}${text.slice(to)}`
  return { value: next, caret: from + insertion.length }
}

function clamp(value: number, max: number, min = 0): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.trunc(value), min), max)
}

/**
 * The name of a pasted image, from the moment it was pasted.
 *
 * A timestamp rather than a random id because the point of the file is that the
 * human can find it again: `cw-paste-20260917-113004.png` says which screenshot
 * it was without opening it, and sorts into the order it happened. `seq` only
 * appears when two pastes land in the same second, so the common case stays
 * short.
 */
export function pasteFileName(now: number, seq = 0): string {
  const stamp = new Date(now)
  const part = (value: number): string => String(value).padStart(2, '0')
  const base =
    `${stamp.getFullYear()}${part(stamp.getMonth() + 1)}${part(stamp.getDate())}` +
    `-${part(stamp.getHours())}${part(stamp.getMinutes())}${part(stamp.getSeconds())}`
  return seq > 0 ? `cw-paste-${base}-${seq + 1}.png` : `cw-paste-${base}.png`
}

/**
 * Whether a pasted image is old enough to sweep.
 *
 * The file has to outlive the moment it was made - an agent reads it seconds
 * later, and a long build may read it minutes later - but a directory of every
 * screenshot ever pasted is a leak with the human's own pictures in it. Age is
 * the whole rule; nothing else about the file is ours to interpret.
 */
export function isStalePaste(mtimeMs: number, now: number, maxAgeMs: number): boolean {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return true
  return now - mtimeMs > maxAgeMs
}
