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

export interface RuntimeState {
  version: string
  relay: RelayStatus
  speaking: boolean
  queueLength: number
  hooks: HooksReport
  agents: { codex: boolean; claude: boolean }
  voices: VoiceInfo[]
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

export interface SteerResult {
  ok: boolean
  method: 'queue' | 'clipboard' | 'none'
  message: string
}
