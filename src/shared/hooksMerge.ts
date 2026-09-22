import { isOurHookCommand } from './hookScript'

export interface HookSpec {
  event: string
  /** Matcher string, or undefined for events that take no matcher. */
  matcher?: string
  command: string
  /** Codex-only: alternate command for Windows. */
  commandWindows?: string
  timeout?: number
  /**
   * Millisecond timeout, for agents that spell it that way. Gemini's `timeout`
   * is already milliseconds; ZCode accepts both and prefers this one when
   * present, so writing it keeps our intent out of a unit-conversion trap.
   */
  timeoutMs?: number
  /** Codex-only: do not block the agent on this hook. */
  async?: boolean
  statusMessage?: string
  /**
   * Write `command`/`timeout` straight onto the definition object instead of
   * nesting them under `hooks: [...]`. That is Cursor's schema, and
   * Antigravity's for its non-tool events.
   */
  flat?: boolean
  /** `type` written onto a flat definition when the agent wants one. */
  flatType?: string
}

export interface MergeResult {
  json: unknown
  changed: boolean
  /** Event names that now contain a CodeWaifu hook. */
  events: string[]
  warnings: string[]
}

interface HookEntry {
  type: string
  command?: string
  timeout?: number
  timeoutMs?: number
  async?: boolean
  statusMessage?: string
  commandWindows?: string
  shell?: string
  [key: string]: unknown
}

interface HookGroup {
  matcher?: string
  hooks: HookEntry[]
  [key: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeEntry(raw: unknown): HookEntry | null {
  if (!isRecord(raw)) return null
  const entry = { ...raw } as HookEntry
  if (typeof entry.type !== 'string') entry.type = 'command'
  return entry
}

function normalizeGroup(raw: unknown): HookGroup | null {
  if (!isRecord(raw)) return null
  const group = { ...raw } as HookGroup
  const hooks = Array.isArray(raw.hooks) ? raw.hooks.map(normalizeEntry).filter(Boolean) : []
  if (typeof group.matcher !== 'string' || !group.matcher) delete group.matcher
  return { ...group, hooks: hooks as HookEntry[] }
}

interface ParsedEvents {
  events: Record<string, HookGroup[]>
  /**
   * Events whose value is not an array. We cannot read them, so we must not
   * write them either: they are carried through byte-for-byte and our hook is
   * not installed into that event (warned about instead).
   */
  opaque: Record<string, unknown>
  warnings: string[]
}

function normalizeEvents(raw: unknown): ParsedEvents {
  const warnings: string[] = []
  const events: Record<string, HookGroup[]> = {}
  const opaque: Record<string, unknown> = {}
  if (!isRecord(raw)) return { events, opaque, warnings }
  for (const [name, groups] of Object.entries(raw)) {
    if (!Array.isArray(groups)) {
      opaque[name] = groups
      warnings.push(`hooks.${name} is not an array; left untouched`)
      continue
    }
    const normalized = groups.map(normalizeGroup).filter((g): g is HookGroup => g !== null)
    events[name] = normalized
  }
  return { events, opaque, warnings }
}

interface Rebuilt {
  /** Final `hooks` value: opaque entries plus everything we manage. */
  hooks: Record<string, unknown>
  /** Event names that carry a CodeWaifu hook. */
  events: string[]
  warnings: string[]
}

/** Strip ours, apply the specs, then put back whatever we could not parse. */
function rebuild(parsed: ParsedEvents, specs: HookSpec[]): Rebuilt {
  const blocked = [...new Set(specs.map((s) => s.event).filter((event) => event in parsed.opaque))].sort()
  for (const event of blocked) {
    parsed.warnings.push(`hooks.${event} is not an array; CodeWaifu did not install into it`)
  }
  const wanted = specs.filter((spec) => !(spec.event in parsed.opaque))
  const ours = pruneEmpty(applySpecs(stripOurs(pruneEmpty(parsed.events)), wanted))
  return {
    hooks: { ...parsed.opaque, ...ours },
    events: eventsWithOurs(ours),
    warnings: parsed.warnings
  }
}

/** Drop only entries that point into our hooks dir; other tools' hooks survive. */
function stripOurs(events: Record<string, HookGroup[]>): Record<string, HookGroup[]> {
  const out: Record<string, HookGroup[]> = {}
  for (const [name, groups] of Object.entries(events)) {
    const kept: HookGroup[] = []
    for (const group of groups) {
      const hooks = group.hooks.filter(
        (h) => !isOurHookCommand(h.command) && !isOurHookCommand(h.commandWindows)
      )
      // A group that never had hooks of its own is someone else's shape; keep it.
      if (hooks.length === 0 && group.hooks.length > 0) continue
      kept.push({ ...group, hooks })
    }
    if (kept.length > 0) out[name] = kept
  }
  return out
}

function entryFor(spec: HookSpec): HookEntry {
  const entry: HookEntry = { type: 'command', command: spec.command }
  if (typeof spec.timeout === 'number') entry.timeout = spec.timeout
  if (typeof spec.timeoutMs === 'number') entry.timeoutMs = spec.timeoutMs
  if (typeof spec.async === 'boolean') entry.async = spec.async
  if (typeof spec.statusMessage === 'string') entry.statusMessage = spec.statusMessage
  if (typeof spec.commandWindows === 'string') entry.commandWindows = spec.commandWindows
  return entry
}

function applySpecs(events: Record<string, HookGroup[]>, specs: HookSpec[]): Record<string, HookGroup[]> {
  const out: Record<string, HookGroup[]> = {}
  for (const [name, groups] of Object.entries(events)) out[name] = groups.map((g) => ({ ...g, hooks: [...g.hooks] }))

  for (const spec of specs) {
    const list = out[spec.event] || (out[spec.event] = [])
    const matcher = typeof spec.matcher === 'string' && spec.matcher ? spec.matcher : undefined
    let group = list.find((g) => (matcher ? g.matcher === matcher : g.matcher === undefined))
    if (!group) {
      group = matcher ? { matcher, hooks: [] } : { hooks: [] }
      list.push(group)
    }
    group.hooks.push(entryFor(spec))
  }
  return out
}

function eventsWithOurs(events: Record<string, HookGroup[]>): string[] {
  return Object.entries(events)
    .filter(([, groups]) =>
      groups.some((g) => g.hooks.some((h) => isOurHookCommand(h.command) || isOurHookCommand(h.commandWindows)))
    )
    .map(([name]) => name)
    .sort()
}

function pruneEmpty(events: Record<string, HookGroup[]>): Record<string, HookGroup[]> {
  const out: Record<string, HookGroup[]> = {}
  for (const [name, groups] of Object.entries(events)) {
    const kept = groups.filter((g) => g.hooks.length > 0 || !Array.isArray(g.hooks))
    if (kept.length > 0) out[name] = kept
  }
  return out
}

function stable(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/**
 * Codex `~/.codex/hooks.json`. Top level accepts only `description` and `hooks`
 * (anything else makes Codex reject the file with "expected description or
 * hooks"), so unknown keys are preserved but reported.
 */
export function mergeCodexHooks(existing: unknown, specs: HookSpec[]): MergeResult {
  const root = isRecord(existing) ? existing : {}
  const warnings: string[] = []
  for (const key of Object.keys(root)) {
    if (key !== 'description' && key !== 'hooks') {
      warnings.push(`unexpected top-level key "${key}" (Codex accepts only description/hooks); preserved as-is`)
    }
  }
  const rebuilt = rebuild(normalizeEvents(root.hooks), specs)
  warnings.push(...rebuilt.warnings)
  const json: Record<string, unknown> = { ...root }
  if (typeof json.description !== 'string') {
    json.description = 'Agent hook configuration. CodeWaifu entries are managed by the CodeWaifu app.'
  }
  json.hooks = rebuilt.hooks
  const changed = stable(root) !== stable(json)
  return { json, changed, events: rebuilt.events, warnings }
}

/**
 * Claude Code `~/.claude/settings.json`. The whole file is the user's, so every
 * unrelated key (`env`, `enabledPlugins`, ...) is carried through untouched and
 * only `hooks` is rewritten.
 */
export function mergeClaudeHooks(existing: unknown, specs: HookSpec[]): MergeResult {
  const root = isRecord(existing) ? { ...existing } : {}
  const rebuilt = rebuild(normalizeEvents(root.hooks), specs)
  root.hooks = rebuilt.hooks
  const changed = stable(isRecord(existing) ? existing : {}) !== stable(root)
  return { json: root, changed, events: rebuilt.events, warnings: rebuilt.warnings }
}

export function stripCodexHooks(existing: unknown): MergeResult {
  const root = isRecord(existing) ? { ...existing } : {}
  const parsed = normalizeEvents(root.hooks)
  const after = { ...parsed.opaque, ...pruneEmpty(stripOurs(parsed.events)) }
  root.hooks = after
  const changed = stable(existing ?? {}) !== stable(root)
  return { json: root, changed, events: [], warnings: parsed.warnings }
}

export function stripClaudeHooks(existing: unknown): MergeResult {
  const root = isRecord(existing) ? { ...existing } : {}
  const parsed = normalizeEvents(root.hooks)
  const after = { ...parsed.opaque, ...pruneEmpty(stripOurs(parsed.events)) }
  if (Object.keys(after).length > 0) root.hooks = after
  else delete root.hooks
  const changed = stable(existing ?? {}) !== stable(root)
  return { json: root, changed, events: [], warnings: parsed.warnings }
}

// ---------------------------------------------------------------------------
// ZCode: Claude's nested event shape, one level deeper.
//
// `~/.zcode/cli/config.json` is ZCode's whole configuration - provider, model,
// permission, storage and dozens of keys we have no business reading - with
// hooks under `hooks.events.<Event>[].hooks[]`. Inside `hooks` the shape is
// Claude's exactly, so the group-based merge above does the work; what ZCode
// adds is the wrapper and one switch we must flip.
//
// ⛔ `hooks.enabled` defaults to `false`, so merging our events without
// setting it writes hooks that are silently never run - the file looks
// installed, the bench never hears anything, and there is no error to find.
// Setting it is the whole point of having a ZCode-specific merge.
// ---------------------------------------------------------------------------

/** ZCode's own `hooks` wrapper keys, carried through untouched. */
function zcodeHooksRoot(root: Record<string, unknown>): Record<string, unknown> {
  return isRecord(root.hooks) ? root.hooks : {}
}

export function mergeZcodeHooks(existing: unknown, specs: HookSpec[]): MergeResult {
  const before = isRecord(existing) ? existing : {}
  const root: Record<string, unknown> = { ...before }
  const wrapper = zcodeHooksRoot(root)
  const rebuilt = rebuild(normalizeEvents(wrapper.events), specs)
  root.hooks = { ...wrapper, enabled: true, events: rebuilt.hooks }
  const changed = stable(before) !== stable(root)
  return { json: root, changed, events: rebuilt.events, warnings: rebuilt.warnings }
}

/**
 * Undo `mergeZcodeHooks`. The wrapper keys (`timeoutMs`, `maxOutputBytes`,
 * `enabled`) are the user's, so `enabled` is only cleared once no events are
 * left at all: a user who enabled hooks of their own keeps them enabled, and a
 * file we created goes back to ZCode's default of "no events, not enabled".
 */
export function stripZcodeHooks(existing: unknown): MergeResult {
  const root = isRecord(existing) ? { ...existing } : {}
  const wrapper = zcodeHooksRoot(root)
  const parsed = normalizeEvents(wrapper.events)
  const after = { ...parsed.opaque, ...pruneEmpty(stripOurs(parsed.events)) }
  const empty = Object.keys(after).length === 0
  if (isRecord(root.hooks)) {
    const next = { ...root.hooks }
    if (empty) {
      delete next.events
      delete next.enabled
      if (Object.keys(next).length === 0) delete root.hooks
      else root.hooks = next
    } else {
      next.events = after
      root.hooks = next
    }
  }
  const changed = stable(existing ?? {}) !== stable(root)
  return { json: root, changed, events: [], warnings: parsed.warnings }
}

/** Event names under `hooks.events` that currently carry a hook of ours. */
export function scanZcodeEvents(value: unknown): string[] {
  const root = isRecord(value) ? value : {}
  return eventsWithOurs(normalizeEvents(zcodeHooksRoot(root).events).events)
}

// ---------------------------------------------------------------------------
// Flat-definition schemas: Cursor and Antigravity.
//
// Claude and Codex put the command inside `{ hooks: [ ... ] }`. Cursor puts
// `command` and `timeout` directly on the definition object, and Antigravity
// mixes both shapes in one file (tool events nest, the rest do not). The
// group-based merge above cannot see a flat command - `normalizeGroup` hands it
// an empty `hooks` array, which is also how it recognizes someone else's shape,
// so our own entries would survive every strip and duplicate on every install.
// These two functions understand both shapes at once.
// ---------------------------------------------------------------------------

interface FlatDefinition {
  command?: string
  hooks?: Array<{ command?: string; [key: string]: unknown }>
  [key: string]: unknown
}

/** True when either shape of this definition points into our hooks dir. */
function definitionIsOurs(raw: unknown): boolean {
  if (!isRecord(raw)) return false
  const def = raw as FlatDefinition
  if (isOurHookCommand(def.command)) return true
  return Array.isArray(def.hooks) && def.hooks.some((h) => isOurHookCommand(h?.command))
}

function definitionFor(spec: HookSpec): FlatDefinition {
  if (spec.flat) {
    const def: FlatDefinition = { command: spec.command }
    if (spec.flatType) def.type = spec.flatType
    if (typeof spec.timeout === 'number') def.timeout = spec.timeout
    return def
  }
  const entry: Record<string, unknown> = { type: 'command', command: spec.command }
  if (typeof spec.timeout === 'number') entry.timeout = spec.timeout
  const group: FlatDefinition = { hooks: [entry] }
  if (typeof spec.matcher === 'string' && spec.matcher) group.matcher = spec.matcher
  return group
}

interface FlatRebuild {
  events: Record<string, unknown>
  installed: string[]
  warnings: string[]
}

/**
 * Remove every definition of ours from every event, then write the specs back.
 * Sweeping events we no longer subscribe to matters: without it a user who
 * upgrades keeps firing hooks for events this build dropped.
 */
function rebuildFlat(raw: unknown, specs: HookSpec[]): FlatRebuild {
  const warnings: string[] = []
  const events: Record<string, unknown> = {}
  const opaque = new Set<string>()
  if (isRecord(raw)) {
    for (const [name, defs] of Object.entries(raw)) {
      if (!Array.isArray(defs)) {
        events[name] = defs
        opaque.add(name)
        warnings.push(`${name} is not an array; left untouched`)
        continue
      }
      events[name] = defs.filter((def) => !definitionIsOurs(def))
    }
  }
  for (const spec of specs) {
    if (opaque.has(spec.event)) {
      warnings.push(`${spec.event} is not an array; CodeWaifu did not install into it`)
      continue
    }
    const list = Array.isArray(events[spec.event]) ? [...(events[spec.event] as unknown[])] : []
    list.push(definitionFor(spec))
    events[spec.event] = list
  }
  for (const [name, defs] of Object.entries(events)) {
    if (Array.isArray(defs) && defs.length === 0) delete events[name]
  }
  return { events, installed: eventsWithFlatOurs(events), warnings }
}

function eventsWithFlatOurs(events: Record<string, unknown>): string[] {
  return Object.entries(events)
    .filter(([, defs]) => Array.isArray(defs) && defs.some(definitionIsOurs))
    .map(([name]) => name)
    .sort()
}

/**
 * Cursor `~/.cursor/hooks.json`. Same `hooks.<Event>` layout, flat definitions,
 * and a required `version: 1` at the top - a file without it is rejected, so we
 * add it when absent and never touch a value the user pinned.
 */
export function mergeCursorHooks(existing: unknown, specs: HookSpec[]): MergeResult {
  const before = isRecord(existing) ? existing : {}
  const root: Record<string, unknown> = { ...before }
  const rebuilt = rebuildFlat(root.hooks, specs)
  root.hooks = rebuilt.events
  if (root.version === undefined) root.version = 1
  const changed = stable(before) !== stable(root)
  return { json: root, changed, events: rebuilt.installed, warnings: rebuilt.warnings }
}

export function stripCursorHooks(existing: unknown): MergeResult {
  const root = isRecord(existing) ? { ...existing } : {}
  const rebuilt = rebuildFlat(root.hooks, [])
  if (Object.keys(rebuilt.events).length > 0) root.hooks = rebuilt.events
  else delete root.hooks
  const changed = stable(existing ?? {}) !== stable(root)
  return { json: root, changed, events: [], warnings: rebuilt.warnings }
}

/**
 * Antigravity `~/.gemini/config/hooks.json`. Global hooks live under a *named
 * bundle* so several tools can share the file: everything outside our key is
 * carried through untouched, and uninstalling removes our key outright once the
 * bundle is empty.
 */
export const ANTIGRAVITY_BUNDLE = 'codewaifu'

export function mergeAntigravityHooks(existing: unknown, specs: HookSpec[]): MergeResult {
  const before = isRecord(existing) ? existing : {}
  const root: Record<string, unknown> = { ...before }
  const rebuilt = rebuildFlat(root[ANTIGRAVITY_BUNDLE], specs)
  if (Object.keys(rebuilt.events).length > 0) root[ANTIGRAVITY_BUNDLE] = rebuilt.events
  else delete root[ANTIGRAVITY_BUNDLE]
  const changed = stable(before) !== stable(root)
  return { json: root, changed, events: rebuilt.installed, warnings: rebuilt.warnings }
}

export function stripAntigravityHooks(existing: unknown): MergeResult {
  const root = isRecord(existing) ? { ...existing } : {}
  const rebuilt = rebuildFlat(root[ANTIGRAVITY_BUNDLE], [])
  if (Object.keys(rebuilt.events).length > 0) root[ANTIGRAVITY_BUNDLE] = rebuilt.events
  else delete root[ANTIGRAVITY_BUNDLE]
  const changed = stable(existing ?? {}) !== stable(root)
  return { json: root, changed, events: [], warnings: rebuilt.warnings }
}

/** Event names in a flat-schema file that currently carry a hook of ours. */
export function scanFlatEvents(value: unknown, key?: string): string[] {
  const root = isRecord(value) ? value : {}
  const source = key ? root[key] : root.hooks
  return eventsWithFlatOurs(isRecord(source) ? source : {})
}
