import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../shared/config'
import { renderEndpointEnv, type Endpoint } from '../shared/endpoint'
import {
  hookCommand,
  hookCommandWindows,
  renderHookCmd,
  renderHookCmdStub,
  renderHookPs1,
  renderHookSh,
  runnerPaths,
  type RunnerPaths
} from '../shared/hookScript'
import { mergeClaudeHooks, mergeCodexHooks, stripClaudeHooks, stripCodexHooks, type HookSpec } from '../shared/hooksMerge'
import type { HooksReport } from '../shared/protocol'
import { claudeSettingsFile, codexHooksFile, endpointFile, hooksDir, isWindows, platform, stateDir } from './env'
import { log } from './log'
import { backupFile } from './store'

const HOOK_TIMEOUT = 5

const paths: RunnerPaths = runnerPaths(hooksDir, platform)

interface AgentTarget {
  name: 'codex' | 'claude'
  file: string
  flavor: 'codex' | 'claude'
}

const TARGETS: AgentTarget[] = [
  { name: 'codex', file: codexHooksFile, flavor: 'codex' },
  { name: 'claude', file: claudeSettingsFile, flavor: 'claude' }
]

/** Which config event each UI toggle maps to, per agent flavor. */
const EVENT_MAP: Record<keyof AppConfig['events'], { codex?: string[]; claude?: string[] }> = {
  sessionStart: { codex: ['SessionStart'], claude: ['SessionStart'] },
  stop: { codex: ['Stop'], claude: ['Stop'] },
  permission: { codex: ['PermissionRequest'], claude: [] },
  notification: { claude: ['Notification'] },
  tool: { codex: ['PostToolUse'], claude: ['PostToolUse'] },
  compact: { codex: ['PreCompact'], claude: ['PreCompact'] },
  subagent: { codex: ['SubagentStop'], claude: ['SubagentStop'] },
  prompt: { codex: ['UserPromptSubmit'], claude: ['UserPromptSubmit'] }
}

const SESSION_MATCHER = 'startup|resume|clear|compact'

export function buildSpecs(config: AppConfig, agent: 'codex' | 'claude'): HookSpec[] {
  const specs: HookSpec[] = []
  const toggles = config.events
  for (const key of Object.keys(EVENT_MAP) as Array<keyof typeof EVENT_MAP>) {
    if (!toggles[key]) continue
    const events = EVENT_MAP[key][agent] || []
    for (const event of events) {
      const spec: HookSpec = {
        event,
        command: hookCommand(paths, agent, platform),
        timeout: HOOK_TIMEOUT
      }
      if (event === 'SessionStart') spec.matcher = SESSION_MATCHER
      if (agent === 'codex') {
        // Codex hooks are advisory for us: never make the agent wait on TTS.
        spec.async = true
        if (isWindows) spec.commandWindows = hookCommandWindows(paths, agent)
      }
      specs.push(spec)
    }
  }
  return specs
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
  for (const [agent, file] of Object.entries(paths.cmdByAgent)) {
    files.push([file, renderHookCmdStub(agent), 0o755])
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
  codex: HooksReport['codex']
  claude: HooksReport['claude']
  runnerInstalled: boolean
  codexTrustNeeded: boolean
  warnings: string[]
}

/**
 * Merge our hooks into both agents. Never destructive: unknown keys and other
 * tools' hook entries are preserved, and every file we are about to change is
 * backed up first (both next to the original and under ~/.codewaifu/backups).
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

  const report: InstallReport = {
    codex: { path: codexHooksFile, installed: false, events: [] },
    claude: { path: claudeSettingsFile, installed: false, events: [] },
    runnerInstalled: true,
    codexTrustNeeded: false,
    warnings
  }

  for (const target of TARGETS) {
    const entry = report[target.name]
    const specs = buildSpecs(config, target.name)
    if (specs.length === 0) {
      entry.events = []
      entry.installed = false
      continue
    }
    const { value, exists, error } = readJson(target.file)
    if (error) {
      entry.error = error
      warnings.push(`${target.name}: ${error}`)
      continue
    }
    const merge = target.flavor === 'codex' ? mergeCodexHooks(value, specs) : mergeClaudeHooks(value, specs)
    warnings.push(...merge.warnings.map((w) => `${target.name}: ${w}`))
    entry.events = merge.events
    if (!merge.changed) {
      entry.installed = true
      continue
    }
    if (exists) backupFile(target.file)
    try {
      writeJsonAtomic(target.file, merge.json)
      entry.installed = true
      log('info', `hooks installed for ${target.name}`, { events: merge.events, file: target.file })
    } catch (writeError) {
      entry.error = String(writeError)
      warnings.push(`${target.name}: write failed: ${String(writeError)}`)
    }
  }

  // Codex gates non-managed hooks behind a one-time /hooks trust confirmation.
  report.codexTrustNeeded = report.codex.installed && report.codex.events.length > 0
  return report
}

export function uninstallAgentHooks(): InstallReport {
  const warnings: string[] = []
  const report: InstallReport = {
    codex: { path: codexHooksFile, installed: false, events: [] },
    claude: { path: claudeSettingsFile, installed: false, events: [] },
    runnerInstalled: false,
    codexTrustNeeded: false,
    warnings
  }
  for (const target of TARGETS) {
    const entry = report[target.name]
    const { value, exists, error } = readJson(target.file)
    if (error || !exists) {
      if (error) {
        entry.error = error
        warnings.push(`${target.name}: ${error}`)
      }
      continue
    }
    const strip = target.flavor === 'codex' ? stripCodexHooks(value) : stripClaudeHooks(value)
    if (!strip.changed) continue
    backupFile(target.file)
    try {
      writeJsonAtomic(target.file, strip.json)
      log('info', `hooks removed for ${target.name}`, target.file)
    } catch (writeError) {
      entry.error = String(writeError)
      warnings.push(`${target.name}: write failed: ${String(writeError)}`)
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

/** Read-only status for the settings panel; does not write anything. */
export function reportHooks(): Pick<HooksReport, 'codex' | 'claude' | 'runnerInstalled'> {
  const out: Pick<HooksReport, 'codex' | 'claude' | 'runnerInstalled'> = {
    codex: { path: codexHooksFile, installed: false, events: [] },
    claude: { path: claudeSettingsFile, installed: false, events: [] },
    runnerInstalled: false
  }
  try {
    out.runnerInstalled = fs.existsSync(paths.sh) || fs.existsSync(paths.cmd)
  } catch {
    out.runnerInstalled = false
  }
  for (const target of TARGETS) {
    const entry = out[target.name]
    const { value, error } = readJson(target.file)
    if (error) {
      entry.error = error
      continue
    }
    const merge = target.flavor === 'codex' ? mergeCodexHooks(value, []) : mergeClaudeHooks(value, [])
    // Merging zero specs strips ours, so "changed" tells us we were installed.
    entry.installed = merge.changed
    entry.events = scanOurEvents(value)
  }
  return out
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
