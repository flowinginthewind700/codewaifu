/**
 * IPC channel names, shared by main, preload and renderer.
 *
 * They live in `shared` (plain strings, no Electron import) so the preload can
 * allow-list them without pulling main-process modules into the renderer bundle.
 */
export const IPC = {
  getState: 'cw:get-state',
  setConfig: 'cw:set-config',
  threads: 'cw:threads',
  transcript: 'cw:transcript',
  steer: 'cw:steer',
  say: 'cw:say',
  mediaState: 'cw:media-state',
  mediaCommand: 'cw:media-command',
  hooksInstall: 'cw:hooks-install',
  hooksUninstall: 'cw:hooks-uninstall',
  voices: 'cw:voices',
  expanded: 'cw:expanded',
  clickThrough: 'cw:click-through',
  hide: 'cw:hide',
  quit: 'cw:quit',
  pickImage: 'cw:pick-image',
  /**
   * Whatever is on the system clipboard that can become a path: files copied in
   * a file manager, or an image written to a file we own. The only form of an
   * attachment a PTY can carry, and used by both windows, so it lives here
   * rather than under `cw-pro:`.
   */
  clipboardAttach: 'cw:clipboard-attach',
  openPath: 'cw:open-path',
  chatMode: 'cw:chat-mode',
  /** Renderer reports whether a non-empty input is focused (hotkey guard). */
  inputActive: 'cw:input-active',
  /**
   * Window chrome for the frameless Bench: minimise and close.
   *
   * Only needed when `pro.benchFrame` is off, because then the system frame
   * that used to carry these two verbs is gone and the bench's own topbar has
   * to provide them. Dragging and resizing are not here: both are native on
   * every platform we ship, via `-webkit-app-region: drag` on the topbar and
   * the frame's own edge cursors, so nothing has to be driven from JS.
   *
   * Close means hide, matching the bench's whole lifecycle: a cockpit that
   * re-spawns on every open loses the terminal scrollback being read, so only
   * quitting destroys the window.
   */
  benchControl: 'cw:bench-control',
  /**
   * Drag the frame by a screen-space delta. The Live2D canvas has to keep
   * receiving pointer events (tapping her triggers motions), so CSS
   * `app-region: drag` cannot cover it; the renderer drags with JS instead.
   */
  moveWindow: 'cw:move-window',
  /** Settings asked for another attempt at the neural voice weights. */
  neuralRetry: 'cw:neural-retry',
  /** Renderer measured the card; main resizes the frame to fit it exactly. */
  fitHeight: 'cw:fit-height',
  /**
   * Linux only: the renderer's measured `[data-solid]` boxes, which main turns
   * into the window's input shape. This is the stand-in for
   * `setIgnoreMouseEvents(..., { forward: true })`, an option Linux does not
   * implement: without forwarding, a click-through window never hears the
   * pointer come back and stays unclickable for the rest of the session.
   */
  solidRegion: 'cw:solid-region',
  /** Renderer's Web Audio player is mounted and can accept speech bytes. */
  voiceReady: 'cw:voice-ready',
  /** Renderer finished (or failed) playing one line of speech. */
  speechAck: 'cw:speech-ack',
  pushEvent: 'cw:event',
  pushSpeaking: 'cw:speaking',
  pushConfig: 'cw:config',
  /**
   * The interface-zoom rung main just applied, as a number. Pushed on its own
   * channel rather than read off `pushConfig`: the config write is debounced so
   * a held-down key does not write thirty times a second, and the HUD has to
   * appear on the first step, not four hundred ms after the last one.
   */
  pushZoom: 'cw:zoom',
  pushMedia: 'cw:media',
  pushBubble: 'cw:bubble',
  pushRelay: 'cw:relay',
  pushExpanded: 'cw:expanded-changed',
  /** Neural voice bring-up: download progress, engine load, readiness. */
  pushNeural: 'cw:neural',
  pushSpeech: 'cw:speech',
  pushSpeechStop: 'cw:speech-stop',
  openPanel: 'cw:open-panel',

  /* ------------------------------------------------------------------ *
   * Pro (the Bench). Prefixed `cw-pro:` so a channel list read at a glance
   * separates the companion's own plumbing from the workbench's, and so
   * turning Pro off cannot accidentally un-register a widget channel.
   *
   * Both windows load the same preload and therefore see the same allow-list:
   * the Bench uses `pro*` invokes and `pushProState`, the widget uses
   * `proCommand` and `pushProCompanion`. That is deliberate — one bridge, two
   * surfaces, no second implementation of "send this to main".
   * ------------------------------------------------------------------ */

  /** The whole projection: `BenchView`. Called once on open, then pushed. */
  proState: 'cw-pro:state',
  /** One attention action (approve/deny/answer/snooze/open/done/reprompt). */
  proAction: 'cw-pro:action',
  /** Task lifecycle: create, patch, park, done, remove. */
  proTask: 'cw-pro:task',
  /** Intent ledger: read a task's entries, or append one. */
  proLedger: 'cw-pro:ledger',
  /** Recovery: plan, apply, handoff text, re-prompt. */
  proRecovery: 'cw-pro:recovery',
  /** Terminal bridges: attach/detach a pane, input, resize, scroll. */
  proPane: 'cw-pro:pane',
  /** The widget, driven from the Bench: summon/dismiss/toggle/announce. */
  proCompanion: 'cw-pro:companion',
  /** A `BenchCommand` coming *from* the widget (bubble click, spoken answer). */
  proCommand: 'cw-pro:command',
  /** Pro's own knobs (`pro.*` in config), patched from the Bench stage bar. */
  proConfig: 'cw-pro:config',
  /** Directory picker + discovery report, for the install card and New task. */
  proHost: 'cw-pro:host',
  /**
   * SSH and local terminals: the roster, a reachability probe, pinning a
   * machine, and opening a session (which is a pane plus a task record).
   */
  proSsh: 'cw-pro:ssh',

  /** Main -> Bench: the projection changed. Payload is `BenchView`. */
  pushProState: 'cw-pro:state-changed',
  /** Main -> Bench: base64 ANSI frames for attached panes. */
  pushProFrames: 'cw-pro:frames',
  /** Main -> Bench: one bridge's phase/size/drop counters. */
  pushProBridge: 'cw-pro:bridge',
  /** Main -> Bench: select this task/pane (a bubble click landed here). */
  pushProFocus: 'cw-pro:focus',
  /** Main -> Bench: a transient line about an action that could not run. */
  pushProNotice: 'cw-pro:notice',
  /** Main -> widget: badge count, resting expression, fleet counts. */
  pushProCompanion: 'cw-pro:companion-state'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Renderer -> main requests the preload is willing to forward. */
export const INVOKE_CHANNELS: readonly IpcChannel[] = [
  IPC.getState,
  IPC.setConfig,
  IPC.threads,
  IPC.transcript,
  IPC.steer,
  IPC.say,
  IPC.mediaState,
  IPC.mediaCommand,
  IPC.hooksInstall,
  IPC.hooksUninstall,
  IPC.voices,
  IPC.expanded,
  IPC.clickThrough,
  IPC.hide,
  IPC.quit,
  IPC.pickImage,
  IPC.clipboardAttach,
  IPC.openPath,
  IPC.chatMode,
  IPC.inputActive,
  IPC.benchControl,
  IPC.moveWindow,
  IPC.neuralRetry,
  IPC.fitHeight,
  IPC.solidRegion,
  IPC.voiceReady,
  IPC.speechAck,
  IPC.proState,
  IPC.proAction,
  IPC.proTask,
  IPC.proLedger,
  IPC.proRecovery,
  IPC.proPane,
  IPC.proCompanion,
  IPC.proCommand,
  IPC.proConfig,
  IPC.proHost,
  IPC.proSsh
]

/** Main -> renderer pushes the preload is willing to subscribe to. */
export const PUSH_CHANNELS: readonly IpcChannel[] = [
  IPC.pushEvent,
  IPC.pushSpeaking,
  IPC.pushConfig,
  IPC.pushZoom,
  IPC.pushMedia,
  IPC.pushBubble,
  IPC.pushRelay,
  IPC.pushExpanded,
  IPC.pushNeural,
  IPC.pushSpeech,
  IPC.pushSpeechStop,
  IPC.openPanel,
  IPC.pushProState,
  IPC.pushProFrames,
  IPC.pushProBridge,
  IPC.pushProFocus,
  IPC.pushProNotice,
  IPC.pushProCompanion
]
