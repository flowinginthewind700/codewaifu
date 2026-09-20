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
import { DEFAULT_MESSAGE_LIMIT, type ChatTranscript } from '@shared/chat'
import { DEFAULT_SNOOZE_MINUTES } from '@shared/pro'
import type {
  AttentionAction,
  BenchView,
  LedgerDigest,
  LedgerEntry,
  LedgerKind,
  RecoveryPlan,
  TaskStatus
} from '@shared/pro'
import type {
  ProBridgePush,
  ProAgentsData,
  ProCompanionPush,
  ProFocusPush,
  ProFramesPush,
  ProNoticePush,
  ProResult,
  ProSessionOpened,
  ProSshKeys,
  ProSshProbe,
  ProSshRoster,
  ProSshSetup,
  ProTaskCreated,
  ProTaskEnvelope,
  ImportCandidate
} from '@shared/proIpc'
import type { HiddenMachine, MachineEdit, SshMachine } from '@shared/ssh'
import type { PaneScroll } from '@shared/herdr'
import type { Lang, RedactedConfig, RuntimeState, SteerResult, UiSnapshot } from '@shared/protocol'

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
    extra: { text?: string; minutes?: number; option?: number } = {}
  ): Promise<ProResult> =>
    call(CH.proAction, {
      itemId,
      action,
      text: extra.text ?? '',
      minutes: extra.minutes ?? 0,
      option: extra.option ?? 0,
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
    /**
     * The record is nested, not the payload: `data.task` is the row and
     * `data.paneId` is the terminal it landed in. Reading `data.id` here is
     * exactly how the bench came to select nothing after a create.
     */
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
    }): Promise<ProResult<ProTaskCreated>> =>
      call<ProTaskCreated>(CH.proTask, { op: 'create', ...input }),
    patch: (
      taskId: string,
      patch: { title?: string; goal?: string; branch?: string }
    ): Promise<ProResult<ProTaskEnvelope>> =>
      call<ProTaskEnvelope>(CH.proTask, { op: 'patch', taskId, ...patch }),
    setStatus: (taskId: string, status: TaskStatus): Promise<ProResult<ProTaskEnvelope>> =>
      call<ProTaskEnvelope>(CH.proTask, { op: 'status', taskId, status }),
    /**
     * Drop the row, and - when `closeShell` is set - the terminal underneath it.
     *
     * The bench always sends an explicit answer because a human just read a
     * checkbox; the default stays false so a caller that means "hide this"
     * cannot kill a shell by accident.
     */
    remove: (
      taskId: string,
      closeShell = false
    ): Promise<ProResult<{ taskId: string; closed: boolean }>> =>
      call<{ taskId: string; closed: boolean }>(CH.proTask, { op: 'remove', taskId, closeShell }),
    adopt: (): Promise<ProResult> => call(CH.proTask, { op: 'adopt' }),
    /**
     * Close every terminal a removal left running in herdr. This is the verb
     * behind the topbar chip, and the only way to reach those shells from here
     * once their rows are gone.
     */
    purgeDeclined: (): Promise<ProResult<{ closed: number; remaining: number }>> =>
      call<{ closed: number; remaining: number }>(CH.proTask, { op: 'purge' }),
    /**
     * Turn sessions the companion already sees into bench tasks.
     *
     * `attach` decides the landing status: false parks them (the default, and
     * the honest one - we have not proven a workspace exists for them), true
     * runs the recovery plan immediately so the terminal comes back with them.
     */
    import: (
      keys: readonly string[],
      attach: boolean
    ): Promise<ProResult<{ imported: number; attached: number; skipped: string[] }>> =>
      call(CH.proTask, { op: 'import', keys, attach }),
    /**
     * The conversation behind a task, read from the agent's own transcript
     * file. This is what a task with no pane has to show: an imported session
     * is still running in somebody else's terminal, so herdr has nothing to
     * draw and the transcript is the only live surface the bench can offer.
     */
    transcript: (
      taskId: string,
      opts: { limit?: number; fresh?: boolean } = {}
    ): Promise<ProResult<ChatTranscript | null>> =>
      call<ChatTranscript | null>(CH.proTask, {
        op: 'transcript',
        taskId,
        limit: opts.limit ?? DEFAULT_MESSAGE_LIMIT,
        fresh: opts.fresh ?? false
      }),
    /** Answer that session. Codex gets a queue write, Claude the clipboard. */
    steer: (taskId: string, message: string): Promise<ProResult<SteerResult>> =>
      call<SteerResult>(CH.proTask, { op: 'steer', taskId, message })
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
    /**
     * Relative scroll, the way herdr's own TUI scrolls: the pane moves and
     * herdr repaints the viewport back over the bridge. `source` only affects
     * herdr's own logging, so a wheel and a page key are told apart there.
     */
    scroll: (
      paneId: string,
      direction: 'up' | 'down',
      lines: number,
      source: 'wheel' | 'page_key' = 'wheel'
    ): Promise<ProResult> => call(CH.proPane, { op: 'scroll', paneId, direction, lines, source }),
    /**
     * Jump to the live edge. Answered with herdr's own post-scroll offsets so
     * the "n lines back" chip clears on the same tick as the repaint.
     */
    scrollBottom: (paneId: string): Promise<ProResult<{ paneId: string; scroll?: PaneScroll }>> =>
      call<{ paneId: string; scroll?: PaneScroll }>(CH.proPane, { op: 'scrollBottom', paneId }),
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
    agents: (): Promise<ProResult<ProAgentsData>> =>
      call<ProAgentsData>(CH.proHost, { op: 'agents' }),
    /**
     * The codex/claude sessions on this machine, with the ones already claimed
     * marked. Answered as an envelope, not as a bare list: the picker has to be
     * able to tell nothing-to-import from the-tracker-did-not-answer.
     */
    threads: (): Promise<ProResult<{ threads: ImportCandidate[] }>> =>
      call<{ threads: ImportCandidate[] }>(CH.proHost, { op: 'threads' }),
    pickDir: (): Promise<ProResult<{ path: string }>> =>
      call<{ path: string }>(CH.proHost, { op: 'pickDir' }),
    openPath: (path: string): Promise<ProResult> => call(CH.proHost, { op: 'openPath', path }),
    openExternal: (url: string): Promise<ProResult> =>
      call(CH.proHost, { op: 'openExternal', url })
  },

  /**
   * SSH and local terminals. Every verb answers with an envelope, because
   * "the roster is empty" and "herdr is not connected" have to render
   * differently and only the code can tell them apart.
   */
  ssh: {
    list: (query = ''): Promise<ProResult<ProSshRoster>> =>
      call<ProSshRoster>(CH.proSsh, { op: 'list', query }),
    keys: (): Promise<ProResult<ProSshKeys>> => call<ProSshKeys>(CH.proSsh, { op: 'keys' }),
    probe: (machine: SshMachine | null, target = ''): Promise<ProResult<ProSshProbe>> =>
      call<ProSshProbe>(CH.proSsh, { op: 'probe', machine, target }),
    save: (machine: SshMachine | null, target = ''): Promise<ProResult<{ machine: SshMachine }>> =>
      call<{ machine: SshMachine }>(CH.proSsh, { op: 'save', machine, target }),
    remove: (id: string): Promise<ProResult> => call(CH.proSsh, { op: 'remove', id }),
    /**
     * Change a row. For a row we do not own this forks it into our roster and
     * hides the original, so the palette never grows a second row for one box.
     * A field left out of `patch` is left alone; one sent as '' is cleared.
     */
    edit: (
      machine: SshMachine | null,
      patch: MachineEdit,
      target = ''
    ): Promise<ProResult<{ machine: SshMachine }>> =>
      call<{ machine: SshMachine }>(CH.proSsh, { op: 'edit', machine, target, patch }),
    /**
     * Put a password in the OS keychain, or take one out (`null`).
     *
     * Its own verb rather than a field of `edit`, because a password is not a
     * field of the row: it is kept under the row's id in a store no renderer can
     * read back. The form sends one once and never sees it again, so `id` is the
     * whole addressing this call needs.
     */
    setPassword: (
      id: string,
      secret: string | null
    ): Promise<ProResult<{ id: string; cleared: boolean }>> =>
      call<{ id: string; cleared: boolean }>(CH.proSsh, { op: 'set-password', id, secret }),
    /**
     * Dismiss a row: delete when it is ours, hide when its source is a file we
     * only read. `code` tells the two apart, and the toast says so.
     */
    hide: (
      machine: SshMachine | null,
      target = ''
    ): Promise<ProResult<{ machine: SshMachine; hidden: boolean }>> =>
      call<{ machine: SshMachine; hidden: boolean }>(CH.proSsh, { op: 'hide', machine, target }),
    /** Bring a dismissed row back. `key` is the `machineKey` the list carried. */
    unhide: (key: string): Promise<ProResult> => call(CH.proSsh, { op: 'unhide', key }),
    /**
     * The dismissed rows on their own. The roster already carries them; this is
     * for a caller that has a roster and needs the list to be current.
     */
    hidden: (): Promise<ProResult<{ hidden: HiddenMachine[] }>> =>
      call<{ hidden: HiddenMachine[] }>(CH.proSsh, { op: 'hidden' }),
    /** Open a session: a pane, a task row, and the connect line typed into it. */
    connect: (input: {
      machine?: SshMachine | null
      target?: string
      save?: boolean
      cwd?: string
    }): Promise<ProResult<ProSessionOpened>> =>
      call<ProSessionOpened>(CH.proSsh, { op: 'connect', save: true, ...input }),
    /**
     * Passwordless setup. `run: false` only asks what would be typed, which is
     * what a tooltip or a confirmation line wants.
     */
    setup: (input: {
      machine?: SshMachine | null
      target?: string
      key?: string
      run?: boolean
    }): Promise<ProResult<ProSshSetup & Partial<ProSessionOpened>>> =>
      call<ProSshSetup & Partial<ProSessionOpened>>(CH.proSsh, { op: 'setup', run: true, ...input }),
    /** A plain local shell. Empty `cwd` means home. */
    terminal: (cwd = ''): Promise<ProResult<ProSessionOpened>> =>
      call<ProSessionOpened>(CH.proSsh, { op: 'terminal', cwd })
  },

  companion: {
    summon: (): Promise<ProResult> => call(CH.proCompanion, { op: 'summon' }),
    dismiss: (): Promise<ProResult> => call(CH.proCompanion, { op: 'dismiss' }),
    toggle: (): Promise<ProResult> => call(CH.proCompanion, { op: 'toggle' }),
    /**
     * Put the bench away and bring the stage forward. A mode switch, not a
     * quit: the projection keeps running and the badge keeps counting.
     */
    stage: (): Promise<ProResult> => call(CH.proCompanion, { op: 'stage' }),
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
    }),
  onZoom: (listener: (rung: number) => void): (() => void) =>
    bridge.on(CH.pushZoom, (payload) => {
      listener(Number(payload))
    })
}
