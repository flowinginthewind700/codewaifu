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
  openPath: 'cw:open-path',
  pushEvent: 'cw:event',
  pushSpeaking: 'cw:speaking',
  pushConfig: 'cw:config',
  pushMedia: 'cw:media',
  pushBubble: 'cw:bubble',
  pushRelay: 'cw:relay',
  pushExpanded: 'cw:expanded-changed',
  openPanel: 'cw:open-panel'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Renderer -> main requests the preload is willing to forward. */
export const INVOKE_CHANNELS: readonly IpcChannel[] = [
  IPC.getState,
  IPC.setConfig,
  IPC.threads,
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
  IPC.openPath
]

/** Main -> renderer pushes the preload is willing to subscribe to. */
export const PUSH_CHANNELS: readonly IpcChannel[] = [
  IPC.pushEvent,
  IPC.pushSpeaking,
  IPC.pushConfig,
  IPC.pushMedia,
  IPC.pushBubble,
  IPC.pushRelay,
  IPC.pushExpanded,
  IPC.openPanel
]
