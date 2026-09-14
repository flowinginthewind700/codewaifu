import { isOurHookCommand } from './hookScript'

export interface HookSpec {
  event: string
  /** Matcher string, or undefined for events that take no matcher. */
  matcher?: string
  command: string
  /** Codex-only: alternate command for Windows. */
  commandWindows?: string
  timeout?: number
  /** Codex-only: do not block the agent on this hook. */
  async?: boolean
  statusMessage?: string
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
