import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../shared/config'
import { renderEndpointEnv, type Endpoint } from '../shared/endpoint'
import {
  isOurPluginFile,
  OPENCODE_PLUGIN_EVENTS,
  PI_EXTENSION_EVENTS,
  renderOpencodePlugin,
  renderPiExtension
} from '../shared/agentPlugins'
import {
  hookCommand,
  hookCommandWindows,
  renderHookCmd,
  renderHookCmdStub,
  renderHookPs1,
  renderHookSh,
  runnerPaths,
  stubSpecs,
  type RunnerPaths
} from '../shared/hookScript'
import {
  ANTIGRAVITY_BUNDLE,
  mergeAntigravityHooks,
  mergeClaudeHooks,
  mergeCodexHooks,
  mergeCursorHooks,
  mergeZcodeHooks,
  scanFlatEvents,
  scanZcodeEvents,
  stripAntigravityHooks,
  stripClaudeHooks,
  stripCodexHooks,
  stripCursorHooks,
  stripZcodeHooks,
  type HookSpec
} from '../shared/hooksMerge'
import { applyKimiHooks, stripKimiHooks, scanKimiEvents } from '../shared/kimiToml'
import type { AgentHookStatus, HooksReport } from '../shared/protocol'
import {
  antigravityHooksFile,
  claudeSettingsFile,
  codexHooksFile,
  cursorHooksFile,
  endpointFile,
  geminiSettingsFile,
  hooksDir,
  isWindows,
  kimiConfigToml,
  opencodeConfigDir,
  opencodeLegacyConfigDir,
  opencodePluginFile,
  opencodePluginName,
  piExtensionFile,
  piHome,
  platform,
  stateDir,
  zcodeHome,
  zcodeHooksFile
} from './env'
import { log } from './log'
import { backupFile } from './store'

const HOOK_TIMEOUT = 5
/** Gemini's `timeout` unit is milliseconds, unlike every other agent here. */
const HOOK_TIMEOUT_MS = HOOK_TIMEOUT * 1000

/**
 * Every agent we can install into. The first two are the ones we can also read a
 * transcript for; the rest are hook reporters whose events still drive speech,
 * bubbles, the ledger and the bench tree.
 *
 * Two integration shapes live here. Most agents read a config file that names a
 * command per event, so we merge a command in and the shared relay runs it.
 * `opencode` and `pi` have no config surface at all - they load *code* - so for
 * those we generate a plugin file each of them discovers, and that file relays
 * events to us over HTTP (see `shared/agentPlugins.ts`).
 */
export type HookAgent =
  | 'codex'
  | 'claude'
  | 'cursor'
  | 'gemini'
  | 'antigravity'
  | 'kimi'
  | 'zcode'
  | 'opencode'
  | 'pi'

/** Agents whose integration is a generated code file rather than a hook config. */
export type PluginAgent = 'opencode' | 'pi'

export function isPluginAgent(agent: HookAgent): agent is PluginAgent {
  return agent === 'opencode' || agent === 'pi'
}

/** The generated relay file for a plugin agent. */
export function renderPluginFile(agent: PluginAgent): string {
  return agent === 'opencode' ? renderOpencodePlugin() : renderPiExtension()
}

/**
 * Where a plugin agent's relay file goes on this machine.
 *
 * OpenCode reads `~/.config/opencode` today and `~/.opencode` on older installs,
 * and a plugin dropped into a directory the CLI does not scan is a plugin that
 * silently never loads. So: the current home when it exists, else the legacy one
 * when that exists, else the current one. Callers must only ever ask this after
 * `agentPresent` said the agent is installed, so the last branch is a home we
 * already found - creating `plugins/` inside it advertises nothing new.
 */
export function pluginFileFor(agent: PluginAgent): string {
  if (agent === 'pi') return piExtensionFile
  if (fs.existsSync(opencodeConfigDir)) return path.join(opencodeConfigDir, 'plugins', opencodePluginName)
  if (fs.existsSync(opencodeLegacyConfigDir)) {
    return path.join(opencodeLegacyConfigDir, 'plugins', opencodePluginName)
  }
  return opencodePluginFile
}

interface AgentTarget {
  name: HookAgent
  file: string
}

const TARGETS: AgentTarget[] = [
  { name: 'codex', file: codexHooksFile },
  { name: 'claude', file: claudeSettingsFile },
  { name: 'cursor', file: cursorHooksFile },
  { name: 'gemini', file: geminiSettingsFile },
  { name: 'antigravity', file: antigravityHooksFile },
  { name: 'kimi', file: kimiConfigToml },
  { name: 'zcode', file: zcodeHooksFile },
  // For the plugin agents this is the default home, not necessarily the one we
  // write: OpenCode has two legitimate homes and `pluginFileFor` picks the live
  // one. It is the path the settings panel shows before an install happens.
  { name: 'opencode', file: opencodePluginFile },
  { name: 'pi', file: piExtensionFile }
]

/**
 * Which config event each UI toggle maps to, per agent. The names are each
 * agent's own, and an agent missing from a row simply has no equivalent - we
 * never invent an event a CLI does not emit, because an unknown name is at best
 * ignored and at worst makes the agent reject the whole config file.
 *
 * Notable shapes: Cursor has no session-boundary event we can use (its
 * process-level hooks reset the submitted-turn prompt cache, so we stay off
 * them); Antigravity splits tool events from the rest; Kimi has no
 * `sessionStart`.
 *
 * ⛔ Gemini's `BeforeAgent`/`AfterAgent` are *turn* brackets, not session ones
 * (BeforeAgent fires "after a user submits a prompt", AfterAgent "once per turn
 * after the model generates its final response"), so they belong on the `prompt`
 * and `stop` rows. Gemini has genuine `SessionStart`/`SessionEnd`/`Notification`
 * /`PreCompress` events for everything else. Mapping AfterAgent to the session
 * kind used to leave a Gemini finish installed but never announced: `session_end`
 * has no toggle, so it is always silent.
 *
 * ZCode's `events` object is a closed set of exactly seven names
 * (SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse,
 * PostToolUseFailure, Stop), so it has no compact, subagent or notification row:
 * a name it does not know would be rejected with the whole config file.
 */
const EVENT_MAP: Record<keyof AppConfig['events'], Partial<Record<HookAgent, string[]>>> = {
  sessionStart: {
    codex: ['SessionStart'],
    claude: ['SessionStart'],
    gemini: ['SessionStart'],
    antigravity: ['PreInvocation'],
    zcode: ['SessionStart']
  },
  stop: {
    codex: ['Stop'],
    claude: ['Stop'],
    cursor: ['stop', 'afterAgentResponse'],
    gemini: ['AfterAgent'],
    antigravity: ['PostInvocation', 'Stop'],
    kimi: ['Stop', 'StopFailure'],
    zcode: ['Stop']
  },
  permission: {
    codex: ['PermissionRequest'],
    claude: [],
    cursor: ['preToolUse'],
    antigravity: ['PreToolUse'],
    kimi: ['PermissionRequest'],
    zcode: ['PermissionRequest']
  },
  notification: { claude: ['Notification'], gemini: ['Notification'] },
  tool: {
    codex: ['PostToolUse'],
    claude: ['PostToolUse'],
    cursor: ['postToolUse', 'postToolUseFailure', 'beforeShellExecution', 'beforeMCPExecution'],
    gemini: ['BeforeTool', 'AfterTool'],
    antigravity: ['PostToolUse'],
    kimi: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'],
    zcode: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']
  },
  compact: { codex: ['PreCompact'], claude: ['PreCompact'], gemini: ['PreCompress'] },
  subagent: { codex: ['SubagentStop'], claude: ['SubagentStop'] },
  prompt: {
    codex: ['UserPromptSubmit'],
    claude: ['UserPromptSubmit'],
    cursor: ['beforeSubmitPrompt'],
    gemini: ['BeforeAgent'],
    kimi: ['UserPromptSubmit'],
    zcode: ['UserPromptSubmit']
  }
}

const SESSION_MATCHER = 'startup|resume|clear|compact'

/** Every event name this build can ask for, per agent. Derived, so it cannot drift. */
function allEventsByAgent(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const toggle of Object.keys(EVENT_MAP) as Array<keyof typeof EVENT_MAP>) {
    for (const [agent, events] of Object.entries(EVENT_MAP[toggle])) {
      for (const event of events || []) {
        if (!out[agent]) out[agent] = []
        if (!out[agent].includes(event)) out[agent].push(event)
      }
    }
  }
  return out
}

const EVENTS_BY_AGENT = allEventsByAgent()

/**
 * Windows stub keys, one per command we may emit. Cursor and Antigravity answer
 * differently per event, so those get a stub each rather than sharing one. Kimi
 * is excluded: it runs its hook through a shell even on Windows (Git Bash), so
 * its command is always the POSIX form and never touches cmd.exe.
 */
const STUB_AGENTS: HookAgent[] = ['codex', 'claude', 'cursor', 'gemini', 'antigravity']
const STUB_KEYS = stubSpecs(STUB_AGENTS, EVENTS_BY_AGENT).map((spec) => spec.key)

const paths: RunnerPaths = runnerPaths(hooksDir, platform, STUB_KEYS)

/**
 * Kimi's paths with forward slashes, on every platform. Kimi executes hook
 * commands through its shell - Git Bash on Windows - so a backslash path would
 * be eaten as escapes. On POSIX this is a no-op.
 */
const kimiPaths: RunnerPaths = runnerPaths(hooksDir.split('\\').join('/'), 'linux')

/** The command for one agent+event, on the platform that agent's shell is. */
function commandFor(agent: HookAgent, event: string): string {
  if (agent === 'kimi') return hookCommand(kimiPaths, agent, 'linux', event)
  return hookCommand(paths, agent, platform, event)
}

/**
 * The hook definitions one agent wants for the enabled toggles. Three agents are
 * not covered here: Kimi's config is TOML (see `buildKimiCommands`) and OpenCode
 * and Pi have no config at all (see `renderPluginFile`).
 */
export function buildSpecs(config: AppConfig, agent: Exclude<HookAgent, 'kimi' | PluginAgent>): HookSpec[] {
  const specs: HookSpec[] = []
  const toggles = config.events
  for (const key of Object.keys(EVENT_MAP) as Array<keyof typeof EVENT_MAP>) {
    if (!toggles[key]) continue
    const events = EVENT_MAP[key][agent] || []
    for (const event of events) {
      const spec: HookSpec = {
        event,
        command: commandFor(agent, event),
        timeout: agent === 'gemini' ? HOOK_TIMEOUT_MS : HOOK_TIMEOUT
      }
      // ZCode accepts both spellings and prefers the millisecond one, so write
      // both and keep our intent out of a unit conversion. It also ignores a
      // hook's stdout, which makes `async: true` free: the agent never waits on
      // us, and a slow relay cannot stall a session.
      if (agent === 'zcode') {
        spec.timeoutMs = HOOK_TIMEOUT_MS
        spec.async = true
      }
      // Codex and Claude read a SessionStart `matcher` as a regex, so one
      // pattern covers startup/resume/clear. Gemini reads the same field as an
      // *exact string* for lifecycle events, where that pattern matches nothing
      // and the greeting would silently never fire - so Gemini gets no matcher,
      // which means every source.
      // ZCode is like Gemini here: its SessionStart takes no matcher, and an
      // unknown key on a strict schema risks the whole config being rejected.
      if (event === 'SessionStart' && agent !== 'gemini' && agent !== 'zcode') spec.matcher = SESSION_MATCHER
      // Cursor puts `command` straight on the definition; Antigravity only does
      // that for its non-tool events and wants a `type` when it does.
      if (agent === 'cursor') spec.flat = true
      if (agent === 'antigravity') {
        if (event === 'PreToolUse' || event === 'PostToolUse') spec.matcher = '*'
        else {
          spec.flat = true
          spec.flatType = 'command'
        }
      }
      if (agent === 'codex') {
        // Codex hooks are advisory for us: never make the agent wait on TTS.
        spec.async = true
        if (isWindows) spec.commandWindows = hookCommandWindows(paths, agent, event)
      }
      specs.push(spec)
    }
  }
  return specs
}

/**
 * Kimi's commands, keyed by its own event name. Only the toggles that map to a
 * Kimi event appear, so a user who turned tool events off gets no tool tables.
 */
export function buildKimiCommands(config: AppConfig): Record<string, string> {
  const commands: Record<string, string> = {}
  for (const key of Object.keys(EVENT_MAP) as Array<keyof typeof EVENT_MAP>) {
    if (!config.events[key]) continue
    for (const event of EVENT_MAP[key].kimi || []) {
      commands[event] = commandFor('kimi', event)
    }
  }
  return commands
}

/** Merge a config value with the right schema for this agent. */
function mergeFor(agent: HookAgent, value: unknown, specs: HookSpec[]) {
  switch (agent) {
    case 'codex':
      return mergeCodexHooks(value, specs)
    case 'cursor':
      return mergeCursorHooks(value, specs)
    case 'antigravity':
      return mergeAntigravityHooks(value, specs)
    case 'zcode':
      // Claude's nested shape, one level deeper under `hooks.events`, plus the
      // `hooks.enabled` switch that defaults to false.
      return mergeZcodeHooks(value, specs)
    default:
      // Claude and Gemini share the nested `hooks.<Event>[].hooks[]` shape.
      return mergeClaudeHooks(value, specs)
  }
}

function stripFor(agent: HookAgent, value: unknown) {
  switch (agent) {
    case 'codex':
      return stripCodexHooks(value)
    case 'cursor':
      return stripCursorHooks(value)
    case 'antigravity':
      return stripAntigravityHooks(value)
    case 'zcode':
      return stripZcodeHooks(value)
    default:
      return stripClaudeHooks(value)
  }
}

/** Event names in a parsed config that carry a hook of ours, per agent schema. */
function scanEventsFor(agent: HookAgent, value: unknown): string[] {
  if (agent === 'cursor') return scanFlatEvents(value)
  if (agent === 'antigravity') return scanFlatEvents(value, ANTIGRAVITY_BUNDLE)
  if (agent === 'zcode') return scanZcodeEvents(value)
  return scanOurEvents(value)
}

function readJson(file: string): { value: unknown; exists: boolean; error?: string } {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { value: null, exists: false }
    return { value: null, exists: true, error: `unreadable: ${String(error)}` }
  }
  if (!text.trim()) return { value: {}, exists: true }
  try {
    return { value: JSON.parse(text), exists: true }
  } catch (error) {
    // A malformed config is the user's to fix; we refuse to guess and overwrite.
    return { value: null, exists: true, error: `invalid JSON, left untouched: ${String(error)}` }
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/** (Re)write the relay scripts. Idempotent; safe to call on every launch. */
export function ensureRunnerScripts(): void {
  fs.mkdirSync(paths.dir, { recursive: true })
  const files: Array<[string, string, number]> = [
    [paths.sh, renderHookSh(), 0o755],
    [paths.cmd, renderHookCmd(), 0o755],
    [paths.ps1, renderHookPs1(), 0o755]
  ]
  // One stub per stubKey. Cursor and Antigravity answer differently per event,
  // so their keys read `agent:event` and each stub carries its own decision -
  // a shared stub would print the wrong JSON for half the events.
  for (const [key, file] of Object.entries(paths.cmdByAgent)) {
    const colon = key.indexOf(':')
    const agent = colon === -1 ? key : key.slice(0, colon)
    const event = colon === -1 ? undefined : key.slice(colon + 1)
    files.push([file, renderHookCmdStub(agent, event), 0o755])
  }
  for (const [file, body, mode] of files) {
    const current = (() => {
      try {
        return fs.readFileSync(file, 'utf8')
      } catch {
        return null
      }
    })()
    if (current === body) continue
    fs.writeFileSync(file, body, { encoding: 'utf8', mode })
    if (!isWindows) {
      try {
        fs.chmodSync(file, mode)
      } catch {
        /* chmod is best-effort; the runner is invoked via `sh` anyway */
      }
    }
  }
}

/**
 * Publish the live relay address. Written *after* the socket is bound, so the
 * file never advertises a port we do not own, and rewritten whenever the port
 * moves. Runners re-read it on every hook, so a move needs no agent config edit.
 */
export function writeEndpoint(endpoint: Endpoint): void {
  fs.mkdirSync(stateDir, { recursive: true })
  const body = renderEndpointEnv(endpoint)
  const current = (() => {
    try {
      return fs.readFileSync(endpointFile, 'utf8')
    } catch {
      return null
    }
  })()
  if (current === body) return
  const tmp = `${endpointFile}.${process.pid}.tmp`
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, endpointFile)
  try {
    if (!isWindows) fs.chmodSync(endpointFile, 0o600)
  } catch {
    /* best effort */
  }
  log('info', `endpoint published on 127.0.0.1:${endpoint.port}`, { boot: endpoint.boot || '' })
}

export interface InstallReport {
  /** One entry per target, in menu order. */
  agents: Record<string, AgentHookStatus>
  /** Mirrors of `agents`, kept because the CLI and older renderers read them. */
  codex: AgentHookStatus
  claude: AgentHookStatus
  runnerInstalled: boolean
  codexTrustNeeded: boolean
  warnings: string[]
}

/** Blank status for every target, so no caller has to rebuild the shape. */
function emptyAgents(): Record<string, AgentHookStatus> {
  const out: Record<string, AgentHookStatus> = {}
  for (const target of TARGETS) out[target.name] = { path: target.file, installed: false, events: [] }
  return out
}

/** Read a config file as text, telling "absent" apart from "unreadable". */
function readText(file: string): { text: string; exists: boolean; error?: string } {
  try {
    return { text: fs.readFileSync(file, 'utf8'), exists: true }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { text: '', exists: false }
    return { text: '', exists: true, error: `unreadable: ${String(error)}` }
  }
}

function writeTextAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * True when this agent is actually installed here. We never create a config or a
 * home directory for an agent the user does not have: a fresh `~/.gemini` is
 * exactly what makes the bench offer Gemini as a runner, so writing one would
 * advertise a CLI that is not on the machine.
 *
 * The agents that name their own home are listed explicitly, because for them
 * `dirname(file)` is a directory the CLI creates lazily: OpenCode's `plugins/`
 * and Pi's `agent/extensions/` do not exist on a working install until someone
 * puts a file in them, so the generic test would report both as absent.
 */
function agentPresent(name: HookAgent, file: string): boolean {
  try {
    if (fs.existsSync(file)) return true
    // Codex and Claude Code are the two we always report on, present or not:
    // the settings panel lists them unconditionally and says "not installed".
    if (name === 'codex' || name === 'claude') return true
    if (name === 'zcode') return fs.existsSync(zcodeHome)
    if (name === 'opencode') return fs.existsSync(opencodeConfigDir) || fs.existsSync(opencodeLegacyConfigDir)
    if (name === 'pi') return fs.existsSync(piHome)
    return fs.existsSync(path.dirname(file))
  } catch {
    return false
  }
}

/**
 * The file a plugin agent's relay lives in, right now. Re-resolved on every
 * call rather than pinned at import: an OpenCode user who moves their config
 * dir between launches gets the file rewritten in the new home, and a stale
 * absolute path would keep reporting the old one.
 */
function pluginTarget(name: PluginAgent): string {
  return pluginFileFor(name)
}

/** The event names a plugin relay reports, once it is on disk. */
function pluginEvents(name: PluginAgent): string[] {
  return [...(name === 'opencode' ? OPENCODE_PLUGIN_EVENTS : PI_EXTENSION_EVENTS)]
}

/**
 * Write (or confirm) a generated relay file.
 *
 * Unlike the config merges this is a whole file we own end to end: identical
 * bytes already on disk means nothing to do, and a file that differs is backed
 * up before it is replaced, whether it was ours or something the user wrote at
 * the same path.
 */
function installPlugin(name: PluginAgent, entry: AgentHookStatus, warnings: string[]): void {
  const file = pluginTarget(name)
  entry.path = file
  const body = renderPluginFile(name)
  const { text, exists, error } = readText(file)
  if (error) {
    entry.error = error
    warnings.push(`${name}: ${error}`)
    return
  }
  entry.events = pluginEvents(name)
  if (exists && text === body) {
    entry.installed = true
    return
  }
  if (exists) backupFile(file)
  writeTextAtomic(file, body)
  entry.installed = true
  log('info', `plugin installed for ${name}`, { events: entry.events, file })
}

/**
 * Merge our hooks into every agent that is installed. Never destructive: unknown
 * keys and other tools' hook entries are preserved, and every file we are about
 * to change is backed up first (both next to the original and under
 * ~/.codewaifu/backups).
 */
/**
 * @param endpoint the live relay address, when the caller has one. `codewaifu
 *   --cli install` runs before the app ever bound a port, so it passes nothing
 *   and leaves any existing endpoint.env alone: hooks fail open until the app
 *   publishes its address.
 */
export function installAgentHooks(config: AppConfig, endpoint?: Endpoint | null): InstallReport {
  const warnings: string[] = []
  try {
    ensureRunnerScripts()
    if (endpoint && endpoint.port > 0) {
      writeEndpoint(endpoint)
    } else if (!fs.existsSync(endpointFile)) {
      warnings.push('relay address not published yet; it appears as soon as the app starts')
    }
  } catch (error) {
    log('error', 'failed to write hook runner scripts', String(error))
    warnings.push(`runner scripts not written: ${String(error)}`)
  }

  const agents = emptyAgents()
  const report: InstallReport = {
    agents,
    codex: agents.codex,
    claude: agents.claude,
    runnerInstalled: true,
    codexTrustNeeded: false,
    warnings
  }

  for (const target of TARGETS) {
    const entry = agents[target.name]
    if (!agentPresent(target.name, target.file)) continue
    try {
      installOne(target.name, target.file, config, entry, warnings)
    } catch (error) {
      entry.error = String(error)
      warnings.push(`${target.name}: ${String(error)}`)
    }
  }

  // Codex gates non-managed hooks behind a one-time /hooks trust confirmation.
  report.codexTrustNeeded = agents.codex.installed && agents.codex.events.length > 0
  return report
}

/** Install into one target. Kimi's TOML takes a separate path from the JSON ones. */
function installOne(
  name: HookAgent,
  file: string,
  config: AppConfig,
  entry: AgentHookStatus,
  warnings: string[]
): void {
  // OpenCode and Pi have no config to merge into: the integration *is* the file.
  if (isPluginAgent(name)) {
    installPlugin(name, entry, warnings)
    return
  }

  if (name === 'kimi') {
    const commands = buildKimiCommands(config)
    if (Object.keys(commands).length === 0) return
    const { text, error } = readText(file)
    if (error) {
      entry.error = error
      warnings.push(`${name}: ${error}`)
      return
    }
    const applied = applyKimiHooks(text, commands)
    entry.events = applied.events
    if (!applied.changed) {
      entry.installed = true
      return
    }
    backupFile(file)
    writeTextAtomic(file, applied.text)
    entry.installed = true
    log('info', `hooks installed for ${name}`, { events: applied.events, file })
    return
  }

  const specs = buildSpecs(config, name)
  if (specs.length === 0) return
  const { value, exists, error } = readJson(file)
  if (error) {
    entry.error = error
    warnings.push(`${name}: ${error}`)
    return
  }
  const merge = mergeFor(name, value, specs)
  warnings.push(...merge.warnings.map((w) => `${name}: ${w}`))
  entry.events = merge.events
  if (!merge.changed) {
    entry.installed = true
    return
  }
  if (exists) backupFile(file)
  writeJsonAtomic(file, merge.json)
  entry.installed = true
  log('info', `hooks installed for ${name}`, { events: merge.events, file })
}

export function uninstallAgentHooks(): InstallReport {
  const warnings: string[] = []
  const agents = emptyAgents()
  const report: InstallReport = {
    agents,
    codex: agents.codex,
    claude: agents.claude,
    runnerInstalled: false,
    codexTrustNeeded: false,
    warnings
  }
  for (const target of TARGETS) {
    const entry = agents[target.name]
    try {
      uninstallOne(target.name, target.file, entry, warnings)
    } catch (error) {
      entry.error = String(error)
      warnings.push(`${target.name}: ${String(error)}`)
    }
  }
  for (const file of [paths.sh, paths.cmd, paths.ps1, ...Object.values(paths.cmdByAgent)]) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      warnings.push(`could not remove ${file}`)
    }
  }
  try {
    fs.rmSync(endpointFile, { force: true })
  } catch {
    /* ignore */
  }
  return report
}

function uninstallOne(name: HookAgent, file: string, entry: AgentHookStatus, warnings: string[]): void {
  if (isPluginAgent(name)) {
    const target = pluginTarget(name)
    const { text, exists, error } = readText(target)
    if (error) {
      entry.error = error
      warnings.push(`${name}: ${error}`)
      return
    }
    // A plugins directory holds whatever the user wrote. Removing a file we do
    // not recognise as ours would delete someone else's integration.
    if (!exists || !isOurPluginFile(text)) return
    backupFile(target)
    try {
      fs.rmSync(target, { force: true })
      log('info', `plugin removed for ${name}`, target)
    } catch (removeError) {
      warnings.push(`${name}: could not remove ${target}: ${String(removeError)}`)
    }
    return
  }

  if (name === 'kimi') {
    const { text, exists, error } = readText(file)
    if (error) {
      entry.error = error
      warnings.push(`${name}: ${error}`)
      return
    }
    if (!exists) return
    const stripped = stripKimiHooks(text)
    if (!stripped.changed) return
    backupFile(file)
    writeTextAtomic(file, stripped.text)
    log('info', `hooks removed for ${name}`, file)
    return
  }

  const { value, exists, error } = readJson(file)
  if (error || !exists) {
    if (error) {
      entry.error = error
      warnings.push(`${name}: ${error}`)
    }
    return
  }
  const strip = stripFor(name, value)
  if (!strip.changed) return
  backupFile(file)
  writeJsonAtomic(file, strip.json)
  log('info', `hooks removed for ${name}`, file)
}

/** Read-only status for the settings panel; does not write anything. */
export function reportHooks(): Pick<HooksReport, 'agents' | 'codex' | 'claude' | 'runnerInstalled'> {
  const agents = emptyAgents()
  const out: Pick<HooksReport, 'agents' | 'codex' | 'claude' | 'runnerInstalled'> = {
    agents,
    codex: agents.codex,
    claude: agents.claude,
    runnerInstalled: false
  }
  try {
    out.runnerInstalled = fs.existsSync(paths.sh) || fs.existsSync(paths.cmd)
  } catch {
    out.runnerInstalled = false
  }
  for (const target of TARGETS) {
    reportOne(target.name, target.file, agents[target.name])
  }
  return out
}

function reportOne(name: HookAgent, file: string, entry: AgentHookStatus): void {
  if (isPluginAgent(name)) {
    const target = pluginTarget(name)
    entry.path = target
    const { text, error } = readText(target)
    if (error) {
      entry.error = error
      return
    }
    // Present and ours. A foreign file at our path is reported as "not
    // installed" rather than adopted, so the panel never claims someone else's
    // plugin and uninstall never eats it.
    entry.installed = isOurPluginFile(text)
    entry.events = entry.installed ? pluginEvents(name) : []
    return
  }

  if (name === 'kimi') {
    const { text, error } = readText(file)
    if (error) {
      entry.error = error
      return
    }
    entry.events = scanKimiEvents(text)
    entry.installed = entry.events.length > 0
    return
  }
  const { value, error } = readJson(file)
  if (error) {
    entry.error = error
    return
  }
  // Merging zero specs strips ours, so "changed" tells us we were installed.
  entry.installed = mergeFor(name, value, []).changed
  entry.events = scanEventsFor(name, value)
}

function scanOurEvents(value: unknown): string[] {
  const events: string[] = []
  const hooks = (value && typeof value === 'object' ? (value as Record<string, unknown>).hooks : null) as
    | Record<string, unknown>
    | null
  if (!hooks || typeof hooks !== 'object') return events
  for (const [name, groups] of Object.entries(hooks)) {
    const json = JSON.stringify(groups ?? '')
    if (json.includes('.codewaifu')) events.push(name)
  }
  return events.sort()
}
