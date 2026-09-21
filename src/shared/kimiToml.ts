// Kimi Code keeps every preference in TOML (`~/.kimi-code/config.toml`) and reads
// lifecycle hooks from an array of `[[hooks]]` tables. There is no JSON settings
// file to reuse the installer above with, and no TOML library is vendored here,
// so we manage only what we can prove is ours:
//
//   1. the marker-delimited block we append, and
//   2. any `[[hooks]]` table whose `command` points into our hooks dir, wherever
//      in the file that table ended up.
//
// (2) is what makes this safe against hand edits. The end marker is the only
// proof of the block's extent, so once someone deletes it the text below is
// unknown - claiming it would delete the user's own tables through EOF. An
// orphaned marker therefore owns nothing but its own stray line, while the
// tables we actually wrote are reclaimed by recognition instead.

import { HOOK_MARKER } from './hookScript'

/**
 * The lifecycle events Kimi emits. Same names Claude uses for the four we care
 * about, which is why `hookEvent.ts` needs no Kimi-specific mapping.
 */
export const KIMI_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure'
] as const

/** Host-level backstop. The relay's own curl budget is the normal bound. */
export const KIMI_HOOK_TIMEOUT_SECONDS = 5

const START_MARKER = '# >>> codewaifu-managed-kimi-hooks (managed by CodeWaifu; do not edit) >>>'
const END_MARKER = '# <<< codewaifu-managed-kimi-hooks <<<'
const TABLE_HEADER = '[[hooks]]'

/** A command pointing into our hooks dir is ours, however it is quoted. */
export function isKimiManagedCommand(command: string | undefined): boolean {
  return typeof command === 'string' && HOOK_MARKER.test(command)
}

interface ScannedLine {
  /** Line text without its terminator. */
  text: string
  /** Offset of the first byte of the line in the raw text. */
  offset: number
  /** Offset one past the terminator, so CRLF is spliced back verbatim. */
  endOffset: number
}

function scanLines(text: string): ScannedLine[] {
  const lines: ScannedLine[] = []
  let offset = 0
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset)
    const endOffset = newline === -1 ? text.length : newline + 1
    lines.push({ text: text.slice(offset, endOffset).replace(/\r?\n$/, ''), offset, endOffset })
    offset = endOffset
  }
  return lines
}

interface Region {
  /** First removable offset, including the blank run above the content. */
  startOffset: number
  /** Offset one past the last owned line, terminator included. */
  endOffset: number
}

/** Absorb the blanks above so install/remove cycles do not pile up whitespace. */
function startAbsorbingBlanksAbove(lines: readonly ScannedLine[], index: number): number {
  let start = index
  while (start > 0 && lines[start - 1].text.trim() === '') start--
  return lines[start].offset
}

function markerBlocks(text: string): Region[] {
  const lines = scanLines(text)
  // Exact match, not startsWith: a user quoting a marker in a comment of their
  // own would otherwise open or close a region and take every byte between the
  // two quoted lines. We always write the marker as its own line.
  const isStart = (i: number): boolean => lines[i].text.trim() === START_MARKER
  const isEnd = (i: number): boolean => lines[i].text.trim() === END_MARKER

  const regions: Region[] = []
  for (let index = 0; index < lines.length; index++) {
    if (!isStart(index)) continue
    let last = index
    let terminated = false
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      // A second start marker never belongs to the block already open.
      if (isStart(cursor)) break
      if (isEnd(cursor)) {
        last = cursor
        terminated = true
        break
      }
    }
    // Unterminated: `last` stays on the marker line, so the orphan owns only the
    // stray marker and its body is reclaimed by table recognition below.
    regions.push({
      startOffset: startAbsorbingBlanksAbove(lines, index),
      endOffset: lines[last].endOffset
    })
    if (terminated) index = last
  }
  return regions
}

/** True when a key line follows the gap, meaning the table extends past it. */
function keysFollowGap(lines: readonly string[], from: number): boolean {
  for (let cursor = from; cursor < lines.length; cursor++) {
    const line = lines[cursor].trim()
    if (line === '' || line.startsWith('#')) continue
    return !line.startsWith('[')
  }
  return false
}

/** Basic or literal TOML string, ignoring any inline comment after it. */
function readTomlString(value: string | undefined): string | undefined {
  return value?.match(/^"((?:[^"\\]|\\.)*)"/)?.[1] ?? value?.match(/^'([^']*)'/)?.[1]
}

/**
 * Parse one `[[hooks]]` table at `index`. Returns its line count and event name,
 * or null when the table is not ours or its extent cannot be determined.
 *
 * The key run is parsed strictly on purpose: an unrecognized line shape (a
 * multi-line array or string, say) means the extent is unknown, and guessing it
 * would splice the wrong bytes. That case fails closed.
 */
function matchTable(lines: readonly string[], index: number): { lineCount: number; event: string | null } | null {
  if (lines[index].trim() !== TABLE_HEADER) return null
  const pairs = new Map<string, string>()
  let cursor = index + 1
  while (cursor < lines.length) {
    const line = lines[cursor].trim()
    // A blank, the next table header or a comment (the end marker included)
    // ends the table's key run.
    if (line === '' || line.startsWith('[') || line.startsWith('#')) break
    const pair = line.match(/^([A-Za-z_][\w-]*)\s*=\s*(.*)$/)
    if (!pair || pairs.has(pair[1])) return null
    pairs.set(pair[1], pair[2].trim())
    cursor++
  }
  // TOML allows blanks and comments between the keys of one table, so a gap is
  // not proof it ended. More keys after it means the run above covered only part
  // of the table, and splicing that would strand the rest without its header.
  if (keysFollowGap(lines, cursor)) return null
  const command = readTomlString(pairs.get('command'))
  if (!isKimiManagedCommand(command)) return null
  // Ownership keys on the command, so a table whose event we cannot read still
  // registers: reporting it absent while strip() removes it is the exact split
  // recognition exists to close.
  const rawEvent = pairs.get('event')
  const event = rawEvent === undefined ? null : readTomlString(rawEvent) ?? rawEvent.trim() ?? null
  return { lineCount: cursor - index, event }
}

interface OwnedTable extends Region {
  event: string | null
}

function recognizedTables(text: string): OwnedTable[] {
  const lines = scanLines(text)
  const texts = lines.map((line) => line.text)
  const tables: OwnedTable[] = []
  for (let index = 0; index < lines.length; index++) {
    const match = matchTable(texts, index)
    if (!match || match.lineCount <= 0) continue
    const last = Math.min(index + match.lineCount, lines.length) - 1
    tables.push({
      startOffset: startAbsorbingBlanksAbove(lines, index),
      endOffset: lines[last].endOffset,
      event: match.event
    })
    index = last
  }
  return tables
}

/** Splice every owned region out in one pass, merging overlaps and nesting. */
function stripRegions(text: string, regions: readonly Region[]): { text: string; changed: boolean } {
  if (regions.length === 0) return { text, changed: false }
  const ordered = [...regions].sort((a, b) => a.startOffset - b.startOffset)
  let out = ''
  let cursor = 0
  for (const region of ordered) {
    if (region.endOffset <= cursor) continue
    out += text.slice(cursor, Math.max(cursor, region.startOffset))
    cursor = region.endOffset
  }
  out += text.slice(cursor)
  return { text: out, changed: out !== text }
}

function ownedRegions(text: string): Region[] {
  return [...markerBlocks(text), ...recognizedTables(text)]
}

/** TOML basic string: control chars would make Kimi's parser reject the file. */
function tomlBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * The managed block. One `[[hooks]]` table per event, each carrying its own
 * command so the relay can name the event in a header (Kimi's payload has no
 * `hook_event_name` we can rely on).
 *
 * `matcher` is omitted on purpose: Kimi reads it as a regex, so Claude's literal
 * `*` would be invalid there, and an absent matcher already matches every tool.
 */
function buildBlock(commands: Record<string, string>, eol: string): string {
  const entries: string[] = []
  for (const event of KIMI_HOOK_EVENTS) {
    const command = commands[event]
    if (!command) continue
    entries.push(
      [TABLE_HEADER, `event = "${event}"`, `command = ${tomlBasicString(command)}`, `timeout = ${KIMI_HOOK_TIMEOUT_SECONDS}`].join(eol)
    )
  }
  return [START_MARKER, ...entries, END_MARKER].join(eol)
}

export interface KimiApplyResult {
  text: string
  changed: boolean
  /** Events that now carry a table of ours, in file order. */
  events: string[]
}

/**
 * Rewrite our block for the given per-event commands. Appending table headers is
 * always valid TOML, so the block can live at the end of any existing file, and
 * the user's own config is carried through byte for byte.
 */
export function applyKimiHooks(configText: string, commands: Record<string, string>): KimiApplyResult {
  const eol = detectEol(configText)
  const without = stripRegions(configText, ownedRegions(configText)).text.replace(/\s+$/, '')
  const block = buildBlock(commands, eol)
  const text = without.length > 0 ? `${without}${eol}${eol}${block}${eol}` : `${block}${eol}`
  return { text, changed: text !== configText, events: scanKimiEvents(text) }
}

export function stripKimiHooks(configText: string): { text: string; changed: boolean } {
  const stripped = stripRegions(configText, ownedRegions(configText))
  if (!stripped.changed) return { text: configText, changed: false }
  const eol = detectEol(configText)
  const trimmed = stripped.text.replace(/\s+$/, '')
  return { text: trimmed.length > 0 ? `${trimmed}${eol}` : '', changed: true }
}

/**
 * Events a managed table is live for, counted wherever the table sits. Tables
 * stranded outside the markers still fire, so reporting them absent would tell
 * the user a hook is uninstalled while we keep receiving its events.
 */
export function scanKimiEvents(configText: string): string[] {
  const events: string[] = []
  for (const table of recognizedTables(configText)) {
    if (table.event) events.push(table.event)
  }
  return events.sort()
}
