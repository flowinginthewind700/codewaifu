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
  Lang,
  NeuralStatus,
  RelayStatus,
  RuntimeState,
  SteerResult,
  ThreadInfo,
  VoiceInfo
} from '../shared/protocol'
import type { ChatTranscript } from '../shared/chat'
import type { MediaCommand, MediaState } from '../shared/media'
import { detectLang, resolveUiLang, systemLangFromLocales, toSpeakable } from '../shared/lang'
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
import * as neuralTts from './neuralTts'
import { isCodeWaifuPort } from './probe'
import { HookServer, type BindFailure, type StartResult } from './server'
import { readConfig, writeConfig } from './store'
import { steer as steerThread } from './steer'
import { ThreadTracker } from './threads'
import { readTranscript, type ReadOptions } from './transcript'
import { Speaker } from './tts'

const LOG_LIMIT = 200

export type EventListener = (plan: EventPlan) => void
export type StateListener = (speaking: boolean, queueLength: number) => void
export type NeuralListener = (status: NeuralStatus) => void
export type ConfigListener = (config: AppConfig) => void
/**
 * "This hook event is mine now." Returning true tells Core to keep the event in
 * its log but stay silent about it, which is what lets the Bench own the
 * announcement without two voices reading one permission prompt.
 */
export type EventClaim = (event: HookEvent) => boolean

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
  /**
   * OS language, set by the Electron entry point from
   * `app.getPreferredSystemLanguages()`. Core deliberately stays free of an
   * `electron` import so the CLI and the tests can construct it, hence the
   * env-derived default.
   */
  systemLang: Lang = systemLangFromLocales([])

  private readonly events: EventPlan[] = []
  private readonly eventListeners = new Set<EventListener>()
  private readonly stateListeners = new Set<StateListener>()
  private readonly neuralListeners = new Set<NeuralListener>()
  private readonly configListeners = new Set<ConfigListener>()
  private eventClaim: EventClaim | null = null
  private speaking = false
  private queueLength = 0
  private started = false
  private binding: Promise<void> | null = null
  /** Last download progress seen, so `runtimeState()` can report it. */
  private neuralReceived = 0
  private neuralFile = ''
  private neuralJob: Promise<void> | null = null

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

  addNeuralListener(listener: NeuralListener): () => void {
    this.neuralListeners.add(listener)
    // Hand the subscriber the current phase immediately: Settings can open
    // long after the download started and must not show a stale "not started".
    listener(this.neuralStatus())
    return () => this.neuralListeners.delete(listener)
  }

  /** Fired after every persisted config change, whichever call made it. */
  addConfigListener(listener: ConfigListener): () => void {
    this.configListeners.add(listener)
    return () => this.configListeners.delete(listener)
  }

  /** Hand the hook event path to another owner (Pro). `null` takes it back. */
  setEventClaim(claim: EventClaim | null): void {
    this.eventClaim = claim
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
    this.prepareNeural()
    log('info', 'core started', { port: this.server.listeningPort, boot: this.boot, version: this.version })
    return this.relayStatus()
  }

  private neuralStatus(): NeuralStatus {
    return neuralTts.status(this.neuralReceived, this.neuralFile)
  }

  private emitNeural(): void {
    const status = this.neuralStatus()
    for (const listener of this.neuralListeners) listener(status)
  }

  /** Settings -> "try the download again". Idempotent while a job is running. */
  retryNeural(): NeuralStatus {
    if (!this.neuralJob) neuralTts.resetForRetry()
    // A retry is an explicit user action, so it downloads even when the
    // background auto-download toggle is off.
    const previous = this.config.voice.autoDownload
    if (!previous) this.config = writeConfig({ ...this.config, voice: { ...this.config.voice, autoDownload: true } })
    this.prepareNeural()
    if (!previous) this.emitNeural()
    return this.neuralStatus()
  }

  /**
   * Bring the neural voice up, if that is what the user asked for. Fire and
   * forget on purpose: the 134MB weight download must never delay the relay,
   * the hooks or the first greeting. While it runs the OS voice speaks, and
   * once it lands Matcha takes over from the next sentence.
   */
  prepareNeural(): void {
    const voice = this.config.voice
    if (voice.engine !== 'matcha') return
    if (this.neuralJob) return
    this.neuralJob = (async () => {
      if (voice.autoDownload && !neuralTts.available()) {
        const ok = await neuralTts.ensureModels((progress) => {
          this.neuralReceived = progress.received
          this.neuralFile = progress.file
          this.emitNeural()
        })
        this.neuralReceived = ok ? neuralTts.MODEL_TOTAL_BYTES : this.neuralReceived
        this.neuralFile = ''
        this.emitNeural()
        if (!ok) {
          log('warn', 'neural voice weights unavailable; staying on the system voice')
          return
        }
      } else if (!(await neuralTts.modelsInstalled())) {
        // Auto-download is off and the weights are not on disk: do not touch the
        // network behind the user's back. The system voice keeps speaking.
        this.emitNeural()
        return
      }
      // Warm the engine now so the first notice is not the one paying the
      // ~600ms cold load.
      const handle = await neuralTts.engine()
      this.emitNeural()
      if (handle) log('info', 'neural voice ready', { loadMs: neuralTts.engineLoadMs() })
    })()
      .catch((error) => {
        log('warn', 'neural voice preparation failed', String(error))
        this.emitNeural()
      })
      .finally(() => {
        this.neuralJob = null
      })
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
    // An explicit speech language wins; otherwise greet in the language the
    // window itself is written in, so her first line matches what she reads.
    const lang = this.config.lang === 'auto' ? this.uiLang() : this.config.lang
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

  /**
   * Same rule as `setWindowPosition`, for the Bench frame: a drag or a resize
   * settles into a config write that must not re-merge the agents' hook files,
   * touch the relay, or wake Pro's config diff. Geometry is not behaviour.
   */
  setBenchGeometry(geometry: { width: number; height: number; x: number; y: number }): void {
    const bench = {
      width: Math.round(geometry.width),
      height: Math.round(geometry.height),
      x: Math.round(geometry.x),
      y: Math.round(geometry.y)
    }
    const current = this.config.pro.bench
    if (
      current.width === bench.width &&
      current.height === bench.height &&
      current.x === bench.x &&
      current.y === bench.y
    ) {
      return
    }
    this.config = writeConfig({ ...this.config, pro: { ...this.config.pro, bench } })
  }

  ingest(event: HookEvent): void {
    this.tracker.record(event)
    let plan = planEvent(this.config, event)
    // The claimant sees *every* event, not only one we were about to speak for:
    // activity events are what clear a stall timer, and the ledger is written
    // from the same call. The claim only decides who announces it. The plan
    // keeps its text and its place in the log either way, so the history still
    // reads as a sentence; only the side effects that would double up go.
    if (this.claimEvent(event) && (plan.speak || plan.popWindow)) {
      plan = { ...plan, speak: false, popWindow: false }
    }
    this.events.push(plan)
    if (this.events.length > LOG_LIMIT) this.events.splice(0, this.events.length - LOG_LIMIT)
    for (const listener of this.eventListeners) listener(plan)
    if (plan.speak && plan.text) this.speaker.say(plan.text, plan.lang)
    if (plan.popWindow) this.showHandler?.()
    log('info', `hook ${event.agent}/${event.rawEvent}`, { session: event.sessionId.slice(0, 8), speak: plan.speak })
  }

  /**
   * Ask the claimant whether it will announce this event instead of us. A
   * claimant that throws must not silence the companion, so the failure is
   * logged and the event falls back to the legacy path.
   */
  private claimEvent(event: HookEvent): boolean {
    const claim = this.eventClaim
    if (!claim) return false
    try {
      return claim(event) === true
    } catch (error) {
      log('warn', 'event claim failed', String(error))
      return false
    }
  }

  say(text: string, lang?: 'zh' | 'en'): void {
    const clean = toSpeakable(text, 400)
    if (!clean) return
    this.speaker.force(clean, lang || detectLang(clean))
  }

  async updateConfig(patch: unknown): Promise<AppConfig> {
    const next = applyPatch(this.config, patch)
    const portChanged = next.port !== this.config.port || next.pinPort !== this.config.pinPort
    const engineChanged =
      next.voice.engine !== this.config.voice.engine ||
      next.voice.autoDownload !== this.config.voice.autoDownload
    this.config = writeConfig(next)
    if (portChanged) await this.rebind()
    // Event toggles change which hooks must exist in the agent configs.
    if (this.config.autoInstallHooks) this.installHooks()
    if (!this.config.speak || !this.config.enabled) this.speaker.stop()
    // Switching to Matcha from Settings starts the same background bring-up
    // that launch does; switching away leaves the loaded engine alone (it is
    // idle memory, and switching back should be instant).
    if (engineChanged) {
      this.prepareNeural()
      this.emitNeural()
    }
    this.emitConfig()
    return this.config
  }

  /**
   * Tell the subscribers the persisted config changed. Pro is the main one: it
   * has to react to `pro.*` edits made from the widget's stage bar, from the
   * HTTP relay and from a hand-edited file alike, and it cannot tell those
   * apart from inside. A subscriber that throws must not fail the write.
   */
  private emitConfig(): void {
    for (const listener of this.configListeners) {
      try {
        listener(this.config)
      } catch (error) {
        log('warn', 'config listener failed', String(error))
      }
    }
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

  /**
   * Transcript for the chat view. Read-only and synchronous on purpose: it is
   * a bounded byte-range read, and keeping it off the event queue means the
   * renderer can poll it while a TTS child process is running.
   */
  transcript(agent: Agent, threadId: string, options: ReadOptions = {}): ChatTranscript | null {
    const found = readTranscript(agent, threadId, options)
    if (!found) return null
    const known = this.tracker.peek(agent, threadId)
    return { ...found, title: known?.title || '', cwd: found.cwd || known?.cwd || '', steerable: Boolean(known?.steerable ?? found.steerable) }
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
      voices: this.speaker.listVoices(),
      neural: this.neuralStatus(),
      systemLang: this.systemLang
    }
  }

  /** Language the interface is written in, and therefore the greeting's. */
  uiLang(): Lang {
    return resolveUiLang(this.config.uiLang, this.systemLang)
  }

  shutdown(): void {
    this.speaker.shutdown()
    neuralTts.shutdown()
    this.server.stop()
    this.eventListeners.clear()
    this.stateListeners.clear()
    this.neuralListeners.clear()
    this.configListeners.clear()
    this.eventClaim = null
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
