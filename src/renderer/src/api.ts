import type { ConfigPatch } from '@shared/config'
import type { MediaCommand, MediaState } from '@shared/media'
import type {
  Agent,
  HooksReport,
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

  hooksInstall: () => call<{ ok: boolean; report: HooksReportWithWarnings }>(CH.hooksInstall),
  hooksUninstall: () => call<{ ok: boolean; report: HooksReportWithWarnings }>(CH.hooksUninstall),

  voices: async () => {
    const result = await call<{ voices?: VoiceInfo[] }>(CH.voices)
    return result.voices ?? []
  },

  setExpanded: (expanded: boolean) => call<{ ok: boolean }>(CH.expanded, expanded),
  setClickThrough: (through: boolean) => call<{ ok: boolean }>(CH.clickThrough, through),
  hide: () => call<{ ok: boolean }>(CH.hide),
  quit: () => call<{ ok: boolean }>(CH.quit),

  pickImage: () =>
    call<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>(CH.pickImage),

  openPath: (path: string) => call<{ ok: boolean }>(CH.openPath, path),

  on: (channel: string, listener: (payload: unknown) => void) => bridge.on(channel, listener)
}
