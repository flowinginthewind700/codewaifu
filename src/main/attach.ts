/**
 * The clipboard's one job: become a file an agent can be pointed at.
 *
 * A screenshot copied from anywhere - the OS shortcut, a browser, Figma, a
 * PDF - has no path. The terminal on the far side of this app has no way to
 * carry bytes either, only text. So the image is written to a file we own and
 * the *path* is what travels, which is also the form codex and Claude Code
 * already accept: an image argument they open themselves, at their own pace,
 * from a transcript that still names the file a month later.
 *
 * Electron stays out of this file. `main/ipc.ts` hands over the platform
 * clipboard, and everything decided here - which format names a file, how a
 * plist is read, what a pasted image is called, when the directory is swept - is
 * a policy a test can drive with a fake clock, a fake directory and a fake
 * clipboard.
 */
import fs from 'node:fs'
import path from 'node:path'
import { cleanPaths, isStalePaste, pasteFileName } from '../shared/attach'
import { attachmentsDir } from './env'

/** Seven days: long enough for an agent to still be reading it, short enough to not be an archive. */
export const PASTE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Six hours between sweeps, so a paste costs one write and not one directory scan. */
export const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Below this an "image" is an empty clipboard read wearing a PNG header. */
const MIN_PNG_BYTES = 8
/** Above this it is not a screenshot, and writing it would be a disk decision the user did not make. */
const MAX_PNG_BYTES = 32 * 1024 * 1024
/** Names tried before giving up: one per paste in the same second, which is already absurd. */
const NAME_TRIES = 12

export interface AttachDeps {
  /** Defaults to `~/.codewaifu/attachments`. */
  dir?: string
  now?: () => number
  mkdir?: (dir: string) => boolean
  exists?: (file: string) => boolean
  write?: (file: string, bytes: Uint8Array) => boolean
  list?: (dir: string) => Array<{ name: string; mtimeMs: number }>
  unlink?: (file: string) => boolean
}

function clock(deps: AttachDeps): () => number {
  return deps.now ?? Date.now
}

function defaultMkdir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return true
  } catch {
    return false
  }
}

function defaultWrite(file: string, bytes: Uint8Array): boolean {
  try {
    // 0600: a screenshot of somebody's screen is not a world-readable file, and
    // the mode is set by the write rather than by a later chmod so there is no
    // window in which it is 0644.
    fs.writeFileSync(file, Buffer.from(bytes), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

function defaultList(dir: string): Array<{ name: string; mtimeMs: number }> {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: Array<{ name: string; mtimeMs: number }> = []
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(dir, name))
      if (stat.isFile()) out.push({ name, mtimeMs: stat.mtimeMs })
    } catch {
      /* a file that vanished mid-scan is already swept */
    }
  }
  return out
}

function defaultUnlink(file: string): boolean {
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/**
 * Write one pasted image and return its absolute path, or null with nothing
 * written.
 *
 * Null is the honest answer for every way this can fail - no bytes, an absurd
 * number of them, a directory we cannot create, a disk that refused - because
 * the caller's only two moves are "insert this path" and "say it did not
 * work", and a half-written file would leave the human with a path that names
 * nothing.
 */
export function savePastedImage(png: Uint8Array | null, deps: AttachDeps = {}): string | null {
  if (!png || png.byteLength < MIN_PNG_BYTES || png.byteLength > MAX_PNG_BYTES) return null
  const dir = deps.dir ?? attachmentsDir
  const mkdir = deps.mkdir ?? defaultMkdir
  const exists = deps.exists ?? ((file: string) => fs.existsSync(file))
  const write = deps.write ?? defaultWrite
  if (!mkdir(dir)) return null
  const now = clock(deps)()
  for (let seq = 0; seq < NAME_TRIES; seq += 1) {
    const file = path.join(dir, pasteFileName(now, seq))
    if (exists(file)) continue
    return write(file, png) ? file : null
  }
  return null
}

/**
 * Delete the pastes that outlived their usefulness, and report how many went.
 *
 * Only files this module could have written - the `cw-paste-*.png` shape - are
 * touched. The directory is ours, but "ours" is a claim about naming, not a
 * licence: a human who dropped something else in there keeps it.
 */
export function sweepPastedImages(deps: AttachDeps = {}): number {
  const dir = deps.dir ?? attachmentsDir
  const list = deps.list ?? defaultList
  const unlink = deps.unlink ?? defaultUnlink
  const now = clock(deps)()
  let removed = 0
  for (const entry of list(dir)) {
    if (!/^cw-paste-\d{8}-\d{6}(-\d+)?\.png$/.test(entry.name)) continue
    if (!isStalePaste(entry.mtimeMs, now, PASTE_MAX_AGE_MS)) continue
    if (unlink(path.join(dir, entry.name))) removed += 1
  }
  return removed
}

let lastSweepAt = 0

/** The sweep, at most once per interval. Returns 0 when it decided not to run. */
export function sweepDue(deps: AttachDeps = {}): number {
  const now = clock(deps)()
  if (lastSweepAt && now - lastSweepAt < SWEEP_INTERVAL_MS) return 0
  lastSweepAt = now
  return sweepPastedImages(deps)
}

/** For a test that has to see the throttle fire twice. */
export function resetSweepClock(): void {
  lastSweepAt = 0
}

/* ------------------------------------------------------------------ *
 * What the clipboard is holding
 * ------------------------------------------------------------------ */

/**
 * The clipboard formats that mean "a file is on the clipboard", in the order
 * worth asking.
 *
 * Electron 44 replaced the whole legacy clipboard module - `readImage()`,
 * `availableFormats()` and `read(format)` are gone at runtime, not merely from
 * the typings - with a W3C-shaped `read()` that answers with items listing their
 * own MIME types. Measured on macOS rather than assumed:
 *
 * - copy a file in Finder and the item offers `text/uri-list` holding
 *   `file:///tmp/x.png`, plus the platform's own `NSFilenamesPboardType` as a
 *   plist of the same path, and offers **no** `image/png`;
 * - copy a screenshot and the item offers `image/png` (and a 4 MB TIFF nobody
 *   wants) and offers **no** `text/uri-list`.
 *
 * The two lists do not overlap, which is what makes "paths first, image second"
 * a rule instead of a guess. Under the old API a copied file also exposed its
 * icon to `readImage()`, and the ordering was the only thing standing between a
 * paste and handing the agent a 4 KB thumbnail of the file it was told to open.
 */
const FILE_TYPES: readonly string[] = [
  'text/uri-list',
  'electron application/osclipboard;format="NSFilenamesPboardType"',
  'electron application/osclipboard;format="public.file-url"',
  'electron application/osclipboard;format="FileNameW"',
  'electron application/osclipboard;format="FileName"'
]

/** The one image format worth writing out; every platform offers PNG. */
const IMAGE_TYPE = 'image/png'

/**
 * The slice of Electron's clipboard this file needs: one method, no namespace.
 *
 * Deliberately `Promise<unknown>` rather than `Promise<Electron.ClipboardItem[]>`.
 * `ClipboardItem` is a class with a constructor signature, so no test fake could
 * ever satisfy it structurally, and the alternative is a cast at the call site -
 * which is exactly where a cast hides the thing most likely to be wrong: the
 * shape of what the platform handed back. Everything below narrows at runtime.
 */
export interface ClipboardReader {
  read(): Promise<unknown>
}

export interface ClipboardPayload {
  /** Absolute paths of the files the clipboard is holding, deduped and capped. */
  paths: string[]
  /** The PNG bytes of a clipboard image, or null when there is no image. */
  png: Uint8Array | null
}

function isItem(value: unknown): value is { types: string[]; getType(type: string): Promise<unknown> } {
  const item = value as { types?: unknown; getType?: unknown } | null
  return (
    !!item &&
    Array.isArray(item.types) &&
    item.types.every((type) => typeof type === 'string') &&
    typeof item.getType === 'function'
  )
}

function isBlob(value: unknown): value is { arrayBuffer(): Promise<ArrayBuffer> } {
  return !!value && typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function'
}

/**
 * Read the clipboard once and report both things it could be holding.
 *
 * One `read()` rather than one per format: the call is a round trip into the
 * window server, and a paste is a gesture whose latency the human feels.
 * Formats nobody asked for are never fetched, so copying a 4 MB TIFF costs a
 * listing and not a copy.
 */
export async function readClipboardPayload(reader: ClipboardReader): Promise<ClipboardPayload> {
  const wanted: readonly string[] = [...FILE_TYPES, IMAGE_TYPE]
  const found = new Map<string, Uint8Array>()
  let items: unknown = []
  try {
    items = await reader.read()
  } catch {
    // An empty clipboard rejects on some platforms, and Linux without a
    // clipboard manager has nothing to say at all. Both mean "nothing to
    // attach", which is an answer rather than an error.
    return { paths: [], png: null }
  }
  if (Array.isArray(items)) {
    for (const raw of items) {
      if (!isItem(raw)) continue
      for (const type of raw.types) {
        if (!wanted.includes(type) || found.has(type)) continue
        try {
          const value = await raw.getType(type)
          // `getType('electron application/bookmark')` answers with a
          // `{title,url}` object instead of a blob; nothing else we ask for does,
          // but the narrowing is free and the alternative is a TypeError.
          if (!isBlob(value)) continue
          found.set(type, new Uint8Array(await value.arrayBuffer()))
        } catch {
          /* a format that vanished between the listing and the read is absent */
        }
      }
    }
  }
  return { paths: clipboardPaths(found), png: found.get(IMAGE_TYPE) ?? null }
}

/**
 * Bytes to text, guessing the one encoding that would otherwise break silently.
 *
 * Windows' `FileNameW` is UTF-16LE. Decoded as UTF-8 it yields `C\u0000:\u0000\...`,
 * which fails every path check downstream and reports as "the clipboard had
 * nothing" - the hardest possible version of this bug to diagnose from the
 * outside, because the file really is there.
 */
export function decodeBytes(bytes: Uint8Array): string {
  const wide = bytes.length > 1 && bytes[1] === 0
  return new TextDecoder(wide ? 'utf-16le' : 'utf-8').decode(bytes)
}

const PLIST_STRING = /<string>([\s\S]*?)<\/string>/g

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  apos: "'",
  quot: '"'
}

/**
 * The `<string>` values of a plist, which is the shape macOS uses for
 * `NSFilenamesPboardType`. A regex rather than a parser because the document is
 * a flat array of paths that we did not write and cannot be made to nest, and
 * because a dependency that exists to read one clipboard format is a dependency
 * that runs on every paste.
 */
export function plistStrings(text: string): string[] {
  const out: string[] = []
  PLIST_STRING.lastIndex = 0
  let match = PLIST_STRING.exec(text)
  while (match) {
    const value = match[1].replace(/&([a-z]+);/g, (whole, name: string) => ENTITIES[name] ?? whole)
    if (value) out.push(value)
    match = PLIST_STRING.exec(text)
  }
  return out
}

/** One `file:` URL (or bare path) to an absolute path, or '' when it is neither. */
export function fileUrlToPath(value: string): string {
  const text = (value || '').trim()
  if (!text) return ''
  if (!/^file:/i.test(text)) {
    // Windows hands back `C:\path\to\it` under `FileNameW`: already a path,
    // not a URL, and nothing here should rewrite it.
    return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/') ? text : ''
  }
  // Parsed by hand, not by node's `fileURLToPath`: node parses a file URL for
  // the platform it is running on, so the same URL is a path on one runner and
  // a throw on another - the Windows CI died on POSIX URLs no Windows
  // clipboard will ever carry, and the reverse blind spot is a Windows
  // drive-letter URL pasted into a mac test run. A file URL's pathname *is*
  // the path, percent-decoded; the only platform knowledge left is spelling.
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return ''
  }
  if (url.protocol !== 'file:') return ''
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    // A lone percent is a legal character in a filename and an illegal escape
    // in a URL; the raw pathname is the honest reading of both.
    pathname = url.pathname
  }
  if (!pathname || pathname === '/') return ''
  // `file:///C:/x` arrives as `/C:/x`: the slash is the URL's, not the disk's.
  if (/^\/[A-Za-z]:/.test(pathname)) return pathname.slice(1)
  // `file://server/share/x` is a UNC path on the platform that has them.
  if (url.hostname && url.hostname !== 'localhost') {
    return `\\\\${url.hostname}${pathname.replace(/\//g, '\\')}`
  }
  return pathname
}

/**
 * The paths of the files a clipboard payload is holding.
 *
 * The first format that names a file wins and the rest are skipped, because
 * every remaining format is the same files spelled differently - and on macOS
 * they are spelled *worse*: `text/uri-list` percent-encodes a space in a
 * filename, where the plist does not.
 *
 * An `https://` URL on the clipboard also arrives as `text/uri-list`, and
 * `fileUrlToPath` rejects it. That rejection is the whole reason a copied link
 * stays a link instead of becoming an attachment.
 */
export function clipboardPaths(formats: ReadonlyMap<string, Uint8Array>): string[] {
  for (const type of FILE_TYPES) {
    const bytes = formats.get(type)
    if (!bytes || !bytes.length) continue
    const text = decodeBytes(bytes)
    // A URI list is one entry per line and may carry `#` comments; a plist is an
    // array of bare paths; a Windows filename is one path that fits either loop.
    const entries = type.includes('NSFilenamesPboardType') ? plistStrings(text) : text.split(/[\r\n]+/)
    const out: string[] = []
    for (const entry of entries) {
      const line = entry.trim()
      if (!line || line.startsWith('#')) continue
      const file = fileUrlToPath(line)
      if (file) out.push(file)
    }
    const cleaned = cleanPaths(out)
    if (cleaned.length) return cleaned
  }
  return []
}
