import crypto from 'node:crypto'
import fs from 'node:fs'
import { applyPatch, type AppConfig, type ConfigPatch } from '../shared/config'
import { planEvent } from '../shared/hookEvent'
import { greetingKeyForHour, pickPhrase } from '../shared/phrases'
import { parseEndpointEnv, type Endpoint } from '../shared/endpoint'
import { portAttempts, type PortAttempt, type RelayConflict } from '../shared/portPolicy'
import type {
  Agent,
  EventPlan,
  HookEvent,
  HooksReport,
  RelayStatus,
  RuntimeState,
  SteerResult,
  ThreadInfo,
  VoiceInfo
} from '../shared/protocol'
import type { MediaCommand, MediaState } from '../shared/media'
import { detectLang, toSpeakable } from '../shared/lang'
import { claudeHome, codexHome, endpointFile, envPinnedPort } from './env'
import {
  installAgentHooks,
  reportHooks,
  uninstallAgentHooks,
  writeEndpoint,
  type InstallReport
} from './hooksInstaller'
import { log } from './log'
import { getMediaState, sendMediaCommand } from './media'
import { isCodeWaifuPort } from './probe'
import { HookServer, type BindFailure, type StartResult } from './server'
import { readConfig, writeConfig } from './store'
import { steer as steerThread } from './steer'
import { ThreadTracker } from './threads'
import { Speaker } from './tts'

const LOG_LIMIT = 200

export type EventListener = (plan: EventPlan) => void
export type StateListener = (speaking: boolean, queueLength: number) => void

/**
 * Everything that is not windowing lives here so the GUI path and the headless
 * `--cli` path share one implementation of config, TTS, hooks and the relay.
 */
export class Core {
  config: AppConfig
  readonly tracker = new ThreadTracker()
  readonly speaker: Speaker
  readonly server: HookServer
  hooksReport: InstallReport | null = null
  version = '0.0.0'
  /** Per-launch id, written into endpoint.env and served on /health. */
  boot = ''
  /** Set when a preferred port was taken; surfaced in Settings, never fatal. */
  conflict: RelayConflict | null = null
  /** Pid of another live CodeWaifu owning our endpoint file, 0 when alone. */
  duplicateOf = 0

  private readonly events: EventPlan[] = []
  private readonly eventListeners = new Set<EventListener>()
  private readonly stateListeners = new Set<StateListener>()
  private speaking = false
  private queueLength = 0
  private started = false
  private binding: Promise<void> | null = null

  constructor(version?: string) {
    this.config = readConfig()
    if (version) this.version = version
    this.speaker = new Speaker(
      () => this.config,
      (speaking, queueLength) => {
        this.speaking = speaking
        this.queueLength = queueLength
        for (const listener of this.stateListeners) listener(speaking, queueLength)
      }
    )
    this.server = new HookServer({
      getConfig: () => this.config,
      setConfig: (patch) => this.updateConfig(patch as ConfigPatch),
      onEvent: (event) => this.ingest(event),
      onSay: (text, lang) => this.speaker.force(text, lang),
      onShow: () => this.showHandler?.(),
      runtimeState: () => this.runtimeState(),
      listThreads: () => this.tracker.list(),
      steer: (agent, threadId, message) => steerThread(agent, threadId, message),
      mediaState: () => getMediaState(),
      mediaCommand: (command) => sendMediaCommand(command)
    })
  }

  private showHandler: (() => void) | null = null

  onShow(handler: () => void): void {
    this.showHandler = handler
  }

  addEventListener(listener: EventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  addStateListener(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  recentEvents(limit = 60): HookEvent[] {
    return this.events.slice(-limit).reverse().map((plan) => plan.event)
  }

  async start(): Promise<RelayStatus> {
    if (this.started) return this.relayStatus()
    this.started = true
    this.boot = crypto.randomBytes(6).toString('hex')
    this.server.setIdentity({ boot: this.boot, pid: process.pid, version: this.version })

    const duplicate = await this.findDuplicateOwner()
    if (duplicate) {
      // Another CodeWaifu already owns this endpoint file. Binding a second
      // relay would make the two instances fight over it and silently break
      // each other's hooks, so we stay quiet and tell the user instead.
      this.duplicateOf = duplicate
      log('warn', `another CodeWaifu is already running (pid ${duplicate}); relay not started`)
      this.hooksReport = { ...this.readOnlyReport(), warnings: [] }
      return this.relayStatus()
    }

    await this.bind()
    this.installHooks()
    void this.speaker.refreshVoices()
    log('info', 'core started', { port: this.server.listeningPort, boot: this.boot, version: this.version })
    return this.relayStatus()
  }

  /** Port the user asked for, if any. Env beats config so a shell can override. */
  requestedPort(): number {
    return envPinnedPort || this.config.port
  }

  isPinned(): boolean {
    return Boolean(envPinnedPort) || (this.config.pinPort && this.config.port > 0)
  }

  attempts(): PortAttempt[] {
    return portAttempts({ pinned: envPinnedPort || (this.config.pinPort ? this.config.port : 0), sticky: this.config.port })
  }

  /**
   * Bind, remember the working port and publish it. The kernel-chosen fallback
   * means this only throws when loopback itself is unusable.
   */
  private async bind(): Promise<StartResult> {
    const result = await this.server.start(this.attempts())
    this.conflict = conflictFrom(result.failures, this.isPinned())
    if (!this.isPinned() && result.port !== this.config.port) {
      // Sticky: next launch tries this port first, so endpoint.env is stable.
      this.config = writeConfig({ ...this.config, port: result.port })
    }
    this.publishEndpoint()
    return result
  }

  /** Re-bind after a Settings change; hooks pick the new port up on their own. */
  async rebind(): Promise<RelayStatus> {
    if (!this.started || this.duplicateOf) return this.relayStatus()
    if (!this.binding) {
      this.binding = this.bind()
        .then(() => undefined)
        .catch((error) => {
          log('error', 'relay rebind failed', String(error))
        })
        .finally(() => {
          this.binding = null
        })
    }
    await this.binding
    if (this.config.autoInstallHooks) this.installHooks()
    return this.relayStatus()
  }

  /** The address the runners will read; null until a socket is bound. */
  endpoint(): Endpoint | null {
    const port = this.server.listeningPort
    if (!port) return null
    return {
      port,
      token: this.config.token,
      pid: process.pid,
      boot: this.boot,
      version: this.version,
      writtenAt: Date.now()
    }
  }

  private publishEndpoint(): void {
    const endpoint = this.endpoint()
    if (!endpoint) return
    try {
      writeEndpoint(endpoint)
    } catch (error) {
      log('error', 'could not publish endpoint.env; hooks will stay silent', String(error))
    }
  }

  private installHooks(): void {
    this.hooksReport = this.config.autoInstallHooks
      ? installAgentHooks(this.config, this.endpoint())
      : { ...this.readOnlyReport(), warnings: [] }
  }

  /**
   * Detect a second live instance through the endpoint file. `pid` alone is not
   * enough (ids get recycled), so the port has to answer as CodeWaifu *and* the
   * reported process has to exist.
   */
  private async findDuplicateOwner(): Promise<number> {
    let stale: Endpoint | null = null
    try {
      stale = parseEndpointEnv(fs.readFileSync(endpointFile, 'utf8'))
    } catch {
      return 0
    }
    if (!stale || !stale.port) return 0
    const health = await isCodeWaifuPort(stale.port, 600)
    if (!health) return 0
    const pid = Number(health.pid) || 0
    if (!pid || pid === process.pid) return 0
    return processAlive(pid) ? pid : 0
  }

  relayStatus(): RelayStatus {
    const port = this.server.listeningPort
    return {
      port,
      requested: this.requestedPort(),
      pinned: this.isPinned(),
      reason: port ? this.server.bindReason : 'none',
      boot: this.boot,
      endpointFile,
      conflict: this.conflict,
      duplicateOf: this.duplicateOf
    }
  }

  private readOnlyReport(): HooksReport & { warnings: string[] } {
    const status = reportHooks()
    return { ...status, codexTrustNeeded: status.codex.installed, warnings: [] }
  }

  /**
   * Random greeting once per launch, so a fresh install proves TTS works
   * without the user having to trigger an agent event. Returns the line so the
   * window can show it as a bubble; null when speech is off.
   */
  greet(): { text: string; lang: 'zh' | 'en' } | null {
    if (!this.config.enabled || !this.config.speak) return null
    const lang = this.config.lang === 'auto' ? 'zh' : this.config.lang
    const text = pickPhrase(greetingKeyForHour(new Date().getHours()), lang, { agent: 'codex' })
    this.speaker.force(text, lang)
    return { text, lang }
  }

  /**
   * Persist a dragged window position without going through `updateConfig`:
   * a move must not re-merge the agents' hook files or touch the relay.
   */
  setWindowPosition(position: { x: number; y: number }): void {
    const x = Math.round(position.x)
    const y = Math.round(position.y)
    if (this.config.window.x === x && this.config.window.y === y) return
    this.config = writeConfig({ ...this.config, window: { x, y } })
  }

  ingest(event: HookEvent): void {
    this.tracker.record(event)
    const plan = planEvent(this.config, event)
    this.events.push(plan)
    if (this.events.length > LOG_LIMIT) this.events.splice(0, this.events.length - LOG_LIMIT)
    for (const listener of this.eventListeners) listener(plan)
    if (plan.speak && plan.text) this.speaker.say(plan.text, plan.lang)
    if (plan.popWindow) this.showHandler?.()
    log('info', `hook ${event.agent}/${event.rawEvent}`, { session: event.sessionId.slice(0, 8), speak: plan.speak })
  }

  say(text: string, lang?: 'zh' | 'en'): void {
    const clean = toSpeakable(text, 400)
    if (!clean) return
    this.speaker.force(clean, lang || detectLang(clean))
  }

  async updateConfig(patch: unknown): Promise<AppConfig> {
    const next = applyPatch(this.config, patch)
    const portChanged = next.port !== this.config.port || next.pinPort !== this.config.pinPort
    this.config = writeConfig(next)
    if (portChanged) await this.rebind()
    // Event toggles change which hooks must exist in the agent configs.
    if (this.config.autoInstallHooks) this.installHooks()
    if (!this.config.speak || !this.config.enabled) this.speaker.stop()
    return this.config
  }

  reinstallHooks(): InstallReport {
    this.hooksReport = installAgentHooks(this.config, this.endpoint())
    return this.hooksReport
  }

  removeHooks(): InstallReport {
    this.hooksReport = uninstallAgentHooks()
    return this.hooksReport
  }

  hooksStatus(): HooksReport {
    if (this.hooksReport) {
      return {
        codex: this.hooksReport.codex,
        claude: this.hooksReport.claude,
        runnerInstalled: this.hooksReport.runnerInstalled,
        codexTrustNeeded: this.hooksReport.codexTrustNeeded
      }
    }
    const status = reportHooks()
    return { ...status, codexTrustNeeded: status.codex.installed }
  }

  async threads(): Promise<ThreadInfo[]> {
    return this.tracker.list()
  }

  async steer(agent: Agent, threadId: string, message: string): Promise<SteerResult> {
    const result = await steerThread(agent, threadId, message)
    const lang = this.config.lang === 'auto' ? detectLang(message) : this.config.lang
    const phraseKey = result.method === 'queue' ? 'steer_queued' : 'steer_copied'
    this.speaker.force(pickPhrase(phraseKey, lang, { agent }), lang)
    return result
  }

  async mediaState(): Promise<MediaState> {
    return getMediaState()
  }

  async mediaCommand(command: MediaCommand): Promise<MediaState> {
    return sendMediaCommand(command)
  }

  async voices(): Promise<VoiceInfo[]> {
    return this.speaker.refreshVoices()
  }

  runtimeState(): RuntimeState {
    return {
      version: this.version,
      relay: this.relayStatus(),
      speaking: this.speaking,
      queueLength: this.queueLength,
      hooks: this.hooksStatus(),
      agents: { codex: exists(codexHome), claude: exists(claudeHome) },
      voices: this.speaker.listVoices()
    }
  }

  shutdown(): void {
    this.speaker.shutdown()
    this.server.stop()
    this.eventListeners.clear()
    this.stateListeners.clear()
    // endpoint.env is deliberately left behind: it records the last working port
    // for the next launch, and its /health preflight makes a stale file harmless.
  }
}

/**
 * The first preferred port that failed is the one worth explaining; the
 * kernel-chosen attempt never fails, so it is never the interesting one.
 */
function conflictFrom(failures: BindFailure[], pinned: boolean): RelayConflict | null {
  if (failures.length === 0) return null
  const failure = failures.find((f) => f.port > 0) ?? failures[failures.length - 1]
  return {
    port: failure.port,
    kind: failure.kind,
    owner: failure.owner,
    pid: failure.pid,
    hint: pinned ? `${failure.hint} (this port is pinned in settings)` : failure.hint
  }
}

function processAlive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function exists(dir: string): boolean {
  try {
    return fs.existsSync(dir)
  } catch {
    return false
  }
}
