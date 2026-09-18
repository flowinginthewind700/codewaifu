import type { AppConfig } from './config'
import type { MediaState } from './media'
import type { RelayConflict } from './portPolicy'

export type Agent = 'codex' | 'claude' | 'unknown'

export type EventKind =
  | 'session_start'
  | 'session_end'
  | 'prompt'
  | 'tool'
  | 'permission'
  | 'notification'
  | 'stop'
  | 'subagent'
  | 'compact'
  | 'interrupt'
  | 'other'

export interface HookEvent {
  /** Locally generated, unique per delivery. */
  id: string
  agent: Agent
  kind: EventKind
  /** The raw `hook_event_name` reported by the agent, unchanged. */
  rawEvent: string
  /** The raw matcher value when the agent sent one. */
  matcher: string
  sessionId: string
  cwd: string
  /**
   * The terminal the agent was running in, self-reported by the hook runner
   * (`HERDR_PANE_ID`, sent as `X-CodeWaifu-Pane`). Empty outside herdr, and
   * empty is the honest answer: `cwd` alone cannot tell two tasks in one
   * checkout apart, so a hook that knows its pane is a hook that needs no
   * guess. See `ProService.resolveTaskRef`.
   */
  paneId: string
  /** Short human label, e.g. "Codex asked for permission". */
  title: string
  /** Longer explanation shown in the log; may be empty. */
  detail: string
  /** Verbatim text the agent handed us (assistant message, notification...). */
  sourceText: string
  at: number
  transcriptPath: string
  model: string
  toolName: string
}

/** What the app decided to do with a normalized event. */
export interface EventPlan {
  event: HookEvent
  speak: boolean
  text: string
  lang: Lang
  popWindow: boolean
}

export type Lang = 'zh' | 'en'

export interface ThreadInfo {
  /** `${agent}:${id}` — stable identity across restarts. */
  key: string
  agent: Agent
  id: string
  title: string
  cwd: string
  updatedAt: number
  /** True when we saw a live hook event for it in this app session. */
  live: boolean
  lastKind: EventKind | ''
  lastDetail: string
  /** True when we know a steer command exists for this agent. */
  steerable: boolean
}

export interface VoiceInfo {
  name: string
  lang: string
}

/**
 * Which voice renders the notices.
 *
 * `matcha` is a local neural engine (Matcha-TTS + vocos via sherpa-onnx) — the
 * same weights robotworld.top serves, so mixed Chinese/English reads as one
 * voice instead of two engines fighting over a sentence. It needs a 134MB
 * one-time download. `system` is the zero-install path: macOS `say`, Windows
 * SAPI, Linux espeak-ng.
 */
export type VoiceEngine = 'matcha' | 'system'

export type NeuralPhase =
  | 'unavailable'
  | 'missing'
  | 'downloading'
  | 'extracting'
  | 'loading'
  | 'ready'
  | 'error'

/** Snapshot of the neural engine, surfaced in Settings and on the status chip. */
export interface NeuralStatus {
  phase: NeuralPhase
  received: number
  total: number
  /** File currently being fetched. */
  file: string
  error: string
  dir: string
  sampleRate: number
  /** Milliseconds the cold load took; 0 before the first load. */
  loadMs: number
}

/**
 * One audio push from main to the widget. Speech is streamed sentence by
 * sentence, so a notice arrives as several chunks sharing an `id`; `end` marks
 * the last one. A chunk may carry no `wav` at all when it is only the end
 * marker (the producer failed mid-line and is closing the session).
 */
export interface SpeechChunk {
  id: string
  wav?: Uint8Array
  ms: number
  end: boolean
}

/** The widget's report on one line of speech. */
export interface SpeechAck {
  id: string
  ok: boolean
  error?: string
}

export interface RuntimeState {
  version: string
  relay: RelayStatus
  speaking: boolean
  queueLength: number
  hooks: HooksReport
  agents: { codex: boolean; claude: boolean }
  voices: VoiceInfo[]
  neural: NeuralStatus
  /**
   * Whether the workbench mode exists in this process. The stage renders its
   * "switch to the bench" door off this: one app with two modes, so a mode that
   * is not running must not offer a button that does nothing when clicked.
   */
  pro: boolean
  /**
   * OS language, resolved once per launch. `config.uiLang === 'auto'` reads this
   * instead of asking the renderer for `navigator.language`, so the widget and
   * the CLI agree and a sandboxed renderer cannot drift from the desktop.
   */
  systemLang: Lang
}

/** Everything the UI needs to explain where the relay ended up and why. */
export interface RelayStatus {
  /** Port currently bound; 0 while not listening. */
  port: number
  /** What the user asked for; 0 = automatic. */
  requested: number
  pinned: boolean
  /** Which attempt succeeded. */
  reason: 'pinned' | 'sticky' | 'os-assigned' | 'none'
  /** Per-launch id, also written to endpoint.env. */
  boot: string
  endpointFile: string
  /** Set when a preferred port could not be bound. */
  conflict: RelayConflict | null
  /** Pid of another live CodeWaifu that already owns the endpoint, 0 = none. */
  duplicateOf: number
}

/** Config as the renderer may see it: the token is replaced by `***`. */
export type RedactedConfig = Omit<AppConfig, 'token'> & { token: '***' | '' }

/** One-shot answer to `cw:get-state`, so the widget paints without a round of requests. */
export interface UiSnapshot {
  config: RedactedConfig
  runtime: RuntimeState
  events: HookEvent[]
  media: MediaState
}

export interface HooksReport {
  codex: { path: string; installed: boolean; events: string[]; error?: string }
  claude: { path: string; installed: boolean; events: string[]; error?: string }
  runnerInstalled: boolean
  codexTrustNeeded: boolean
}

/**
 * What actually happened to a steer message. `codex queue` exits 0 for every
 * thread, running or idle, so the exit code cannot tell the user whether the
 * agent ever saw the text — this can. The renderer localizes off `reason`;
 * `message` stays as the English log line and the fallback.
 */
export type SteerReason =
  /** Confirmed inside the agent's own transcript. */
  | 'sent'
  /** Accepted by the CLI; an idle session picks it up when it resumes. */
  | 'queued'
  /** Accepted, but the working session never read the queue — clipboard instead. */
  | 'undelivered'
  /** No `codex` binary on PATH. */
  | 'no-cli'
  /** The CLI itself failed. */
  | 'failed'
  /** Nothing to send. */
  | 'empty'
  /** Claude Code has no injection API: clipboard by design, not by failure. */
  | 'clipboard'

export interface SteerResult {
  ok: boolean
  method: 'queue' | 'clipboard' | 'none'
  message: string
  reason?: SteerReason
}
