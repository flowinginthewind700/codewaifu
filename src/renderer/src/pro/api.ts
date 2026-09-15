/**
 * The Bench's typed view of the bridge.
 *
 * Every call answers with a `ProResult`, failures included: main never throws
 * across IPC, so the renderer has exactly one shape to handle and one place
 * that turns a rejection into a toast. Nothing here holds state - the
 * projection is pushed, and a second copy of it in the renderer is how a badge
 * starts lying.
 */
import type { ProConfig } from '@shared/config'
import { DEFAULT_SNOOZE_MINUTES } from '@shared/pro'
import type {
  AttentionAction,
  BenchView,
  LedgerDigest,
  LedgerEntry,
  LedgerKind,
  RecoveryPlan,
  TaskRecord,
  TaskStatus
} from '@shared/pro'
import type {
  ProBridgePush,
  ProCompanionPush,
  ProFocusPush,
  ProFramesPush,
  ProNoticePush,
  ProResult
} from '@shared/proIpc'
import type { Lang, RedactedConfig, RuntimeState, UiSnapshot } from '@shared/protocol'

const bridge = window.codewaifu

export const CH = bridge.channels
export const platform = bridge.platform

async function call<T = unknown>(channel: string, payload?: unknown): Promise<ProResult<T>> {
  try {
    const result = (await bridge.invoke(channel, payload)) as ProResult<T> | undefined
    if (!result || typeof result !== 'object') {
      return { ok: false, detail: 'the bench service did not answer', code: 'internal', data: null }
    }
    return result
  } catch (error) {
    return { ok: false, detail: String(error), code: 'internal', data: null }
  }
}

/** Config and interface language come from the app's own snapshot channel. */
async function snapshot(): Promise<UiSnapshot | null> {
  try {
    const result = (await bridge.invoke(CH.getState)) as UiSnapshot | undefined
    return result ?? null
  } catch {
    return null
  }
}

export interface BenchBootstrap {
  view: BenchView | null
  config: RedactedConfig | null
  runtime: RuntimeState | null
}

export const proApi = {
  /** Everything the first paint needs, in one pair of round trips. */
  async bootstrap(): Promise<BenchBootstrap> {
    const [state, snap] = await Promise.all([call<BenchView | null>(CH.proState), snapshot()])
    return {
      view: state.data ?? null,
      config: snap?.config ?? null,
      runtime: snap?.runtime ?? null
    }
  },

  /** One attention action: the same verb the widget's bubble issues. */
  act: (
    itemId: string,
    action: AttentionAction,
    extra: { text?: string; minutes?: number } = {}
  ): Promise<ProResult> =>
    call(CH.proAction, {
      itemId,
      action,
      text: extra.text ?? '',
      minutes: extra.minutes ?? 0,
      origin: 'bench'
    }),

  /**
   * Snooze the whole queue in one call.
   *
   * This goes over the *command* channel rather than looping `act`, because the
   * widget uses the same channel for the same verb: one implementation of
   * "quiet everything for ten minutes", and one audit trail for it.
   */
  snoozeAll: (minutes = DEFAULT_SNOOZE_MINUTES): Promise<ProResult> =>
    call(CH.proCommand, { type: 'snoozeAll', minutes }),

  task: {
    create: (input: {
      title: string
      goal: string
      workdir: string
      branch?: string
      base?: string
      worktree?: boolean
      agent?: string
      start?: boolean
      prompt?: string
    }): Promise<ProResult<TaskRecord>> => call<TaskRecord>(CH.proTask, { op: 'create', ...input }),
    patch: (
      taskId: string,
      patch: { title?: string; goal?: string; branch?: string }
    ): Promise<ProResult<TaskRecord>> =>
      call<TaskRecord>(CH.proTask, { op: 'patch', taskId, ...patch }),
    setStatus: (taskId: string, status: TaskStatus): Promise<ProResult<TaskRecord>> =>
      call<TaskRecord>(CH.proTask, { op: 'status', taskId, status }),
    remove: (taskId: string): Promise<ProResult> => call(CH.proTask, { op: 'remove', taskId }),
    adopt: (): Promise<ProResult> => call(CH.proTask, { op: 'adopt' })
  },

  ledger: {
    read: async (taskId: string, limit = 200): Promise<LedgerEntry[]> =>
      (await call<LedgerEntry[]>(CH.proLedger, { op: 'read', taskId, limit })).data ?? [],
    digest: async (taskId: string): Promise<LedgerDigest | null> =>
      (await call<LedgerDigest | null>(CH.proLedger, { op: 'digest', taskId })).data ?? null,
    append: (taskId: string, kind: LedgerKind, text: string): Promise<ProResult<LedgerEntry>> =>
      call<LedgerEntry>(CH.proLedger, { op: 'append', taskId, kind, text, origin: 'bench' })
  },

  recovery: {
    plans: async (): Promise<RecoveryPlan[]> =>
      (await call<RecoveryPlan[]>(CH.proRecovery, { op: 'plans' })).data ?? [],
    apply: (taskId: string): Promise<ProResult> => call(CH.proRecovery, { op: 'apply', taskId }),
    applyAll: (): Promise<ProResult> => call(CH.proRecovery, { op: 'applyAll' }),
    handoff: (taskId: string): Promise<ProResult<{ text: string }>> =>
      call<{ text: string }>(CH.proRecovery, { op: 'handoff', taskId }),
    reprompt: (taskId: string): Promise<ProResult> => call(CH.proRecovery, { op: 'reprompt', taskId })
  },

  pane: {
    attach: (paneId: string, cols: number, rows: number, takeover = false): Promise<ProResult> =>
      call(CH.proPane, { op: 'attach', paneId, cols, rows, takeover }),
    detach: (paneId: string): Promise<ProResult> => call(CH.proPane, { op: 'detach', paneId }),
    input: (paneId: string, text: string): Promise<ProResult> =>
      call(CH.proPane, { op: 'input', paneId, text }),
    resize: (paneId: string, cols: number, rows: number): Promise<ProResult> =>
      call(CH.proPane, { op: 'resize', paneId, cols, rows }),
    focus: (paneId: string): Promise<ProResult> => call(CH.proPane, { op: 'focus', paneId }),
    zoom: (paneId: string, mode: 'toggle' | 'on' | 'off' = 'toggle'): Promise<ProResult> =>
      call(CH.proPane, { op: 'zoom', paneId, mode }),
    send: (paneId: string, text: string, enter = true): Promise<ProResult> =>
      call(CH.proPane, { op: 'send', paneId, text, enter }),
    keys: (paneId: string, keys: string[]): Promise<ProResult> =>
      call(CH.proPane, { op: 'keys', paneId, keys }),
    read: (paneId: string, lines = 40): Promise<ProResult<{ text: string }>> =>
      call<{ text: string }>(CH.proPane, { op: 'read', paneId, lines })
  },

  host: {
    discovery: (): Promise<ProResult> => call(CH.proHost, { op: 'discovery' }),
    agents: (): Promise<ProResult<{ agents: string[] }>> =>
      call<{ agents: string[] }>(CH.proHost, { op: 'agents' }),
    pickDir: (): Promise<ProResult<{ path: string }>> =>
      call<{ path: string }>(CH.proHost, { op: 'pickDir' }),
    openPath: (path: string): Promise<ProResult> => call(CH.proHost, { op: 'openPath', path }),
    openExternal: (url: string): Promise<ProResult> =>
      call(CH.proHost, { op: 'openExternal', url })
  },

  companion: {
    summon: (): Promise<ProResult> => call(CH.proCompanion, { op: 'summon' }),
    dismiss: (): Promise<ProResult> => call(CH.proCompanion, { op: 'dismiss' }),
    toggle: (): Promise<ProResult> => call(CH.proCompanion, { op: 'toggle' }),
    announce: (text: string, lang: Lang): Promise<ProResult> =>
      call(CH.proCompanion, { op: 'announce', text, lang })
  },

  setConfig: (patch: Partial<ProConfig>): Promise<ProResult<{ pro: ProConfig }>> =>
    call<{ pro: ProConfig }>(CH.proConfig, patch),

  /** Push subscriptions; each returns its unsubscribe function. */
  onState: (listener: (view: BenchView) => void): (() => void) =>
    bridge.on(CH.pushProState, (payload) => {
      if (payload) listener(payload as BenchView)
    }),
  onFrames: (listener: (push: ProFramesPush) => void): (() => void) =>
    bridge.on(CH.pushProFrames, (payload) => listener(payload as ProFramesPush)),
  onBridge: (listener: (push: ProBridgePush) => void): (() => void) =>
    bridge.on(CH.pushProBridge, (payload) => listener(payload as ProBridgePush)),
  onFocus: (listener: (push: ProFocusPush) => void): (() => void) =>
    bridge.on(CH.pushProFocus, (payload) => listener(payload as ProFocusPush)),
  onNotice: (listener: (push: ProNoticePush) => void): (() => void) =>
    bridge.on(CH.pushProNotice, (payload) => listener(payload as ProNoticePush)),
  onCompanion: (listener: (push: ProCompanionPush) => void): (() => void) =>
    bridge.on(CH.pushProCompanion, (payload) => listener(payload as ProCompanionPush)),
  onConfig: (listener: (config: RedactedConfig) => void): (() => void) =>
    bridge.on(CH.pushConfig, (payload) => {
      if (payload) listener(payload as RedactedConfig)
    })
}
