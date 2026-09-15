import type { ConfigPatch } from '@shared/config'
import type { ChatTranscript } from '@shared/chat'
import type { BenchCommand } from '@shared/companionLink'
import type { RegionRect } from '@shared/linuxRuntime'
import type { MediaCommand, MediaState } from '@shared/media'
import type { ProResult } from '@shared/proIpc'
import type {
  Agent,
  HooksReport,
  NeuralStatus,
  RedactedConfig,
  RelayStatus,
  SteerResult,
  ThreadInfo,
  UiSnapshot,
  VoiceInfo
} from '@shared/protocol'

const bridge = window.codewaifu

export const CH = bridge.channels
export const platform = bridge.platform
export const versions = bridge.versions

export interface HooksReportWithWarnings extends HooksReport {
  warnings: string[]
}

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  return (await bridge.invoke(channel, payload)) as T
}

/**
 * Typed surface over the bridge. Every call is a plain request/response; the
 * push channels are subscribed separately in `usePush`.
 */
export const api = {
  state: () => call<UiSnapshot>(CH.getState),

  setConfig: (patch: ConfigPatch) =>
    call<{ ok: boolean; config: RedactedConfig; relay: RelayStatus }>(CH.setConfig, patch),

  threads: async () => {
    const result = await call<{ ok?: boolean; threads?: ThreadInfo[] }>(CH.threads)
    return result.threads ?? []
  },

  /** Conversation of one thread, read from the agent's own transcript file. */
  transcript: async (agent: Agent, threadId: string, opts?: { limit?: number; fresh?: boolean }) => {
    const result = await call<{ ok?: boolean; transcript?: ChatTranscript | null; error?: string }>(CH.transcript, {
      agent,
      threadId,
      limit: opts?.limit,
      fresh: opts?.fresh
    })
    return result.transcript ?? null
  },

  /** Widen the widget while the chat is open. */
  setChatMode: (on: boolean) => call<{ ok: boolean }>(CH.chatMode, on),

  steer: (agent: Agent, threadId: string, message: string) =>
    call<SteerResult>(CH.steer, { agent, threadId, message }),

  say: (text: string, lang?: 'zh' | 'en') => call<{ ok: boolean }>(CH.say, { text, lang }),

  mediaState: async () => {
    const result = await call<{ media?: MediaState }>(CH.mediaState)
    return result.media ?? null
  },

  mediaCommand: async (command: MediaCommand) => {
    const result = await call<{ media?: MediaState }>(CH.mediaCommand, command)
    return result.media ?? null
  },

  /**
   * The widget's half of the companion link (F7): ask the Bench to focus a task
   * or settle an attention item. Main resolves the command against live state
   * and answers with a reason, so a stale bubble degrades instead of lying.
   */
  proCommand: (command: BenchCommand) => call<ProResult>(CH.proCommand, command),

  hooksInstall: () => call<{ ok: boolean; report: HooksReportWithWarnings }>(CH.hooksInstall),
  hooksUninstall: () => call<{ ok: boolean; report: HooksReportWithWarnings }>(CH.hooksUninstall),

  /** Ask main to try the neural voice weights again; returns the new status. */
  neuralRetry: async () => {
    const result = await call<{ neural?: NeuralStatus }>(CH.neuralRetry)
    return result.neural ?? null
  },

  voices: async () => {
    const result = await call<{ voices?: VoiceInfo[] }>(CH.voices)
    return result.voices ?? []
  },

  setExpanded: (expanded: boolean) => call<{ ok: boolean }>(CH.expanded, expanded),
  setClickThrough: (through: boolean) => call<{ ok: boolean }>(CH.clickThrough, through),
  /**
   * Linux only: report which parts of the frame are actually ours, so main can
   * shape the window's input region around them.
   */
  setSolidRegion: (rects: readonly RegionRect[]) => call<{ ok: boolean }>(CH.solidRegion, rects),
  /** Drag the frame; deltas are screen pixels since the last pointer sample. */
  moveWindow: (dx: number, dy: number) => call<{ ok: boolean }>(CH.moveWindow, { dx, dy }),
  hide: () => call<{ ok: boolean }>(CH.hide),
  quit: () => call<{ ok: boolean }>(CH.quit),

  pickImage: () =>
    call<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>(CH.pickImage),

  openPath: (path: string) => call<{ ok: boolean }>(CH.openPath, path),

  /**
   * Raw invoke for channels that carry no payload worth typing twice (the
   * voice acks). Still allow-listed by the preload, so this is not an escape
   * hatch into main.
   */
  invoke: <T = unknown>(channel: string, payload?: unknown) => call<T>(channel, payload),

  on: (channel: string, listener: (payload: unknown) => void) => bridge.on(channel, listener)
}
