/** Window geometry shared by main (resize) and renderer (layout). */
export const WINDOW_WIDTH = 320
export const HEIGHT_COLLAPSED = 340
export const HEIGHT_EXPANDED = 640
export const WINDOW_MIN_MARGIN = 8

export type PanelTab = 'threads' | 'log' | 'settings'

export interface BubbleMessage {
  id: string
  text: string
  lang: 'zh' | 'en'
  agent: string
  kind: string
  at: number
}

export type Expression = 'idle' | 'talk' | 'happy' | 'alert' | 'sleepy'

/** Which face the avatar should wear for a given event. */
export function expressionForKind(kind: string, speaking: boolean): Expression {
  if (kind === 'permission' || kind === 'notification') return 'alert'
  if (kind === 'stop' || kind === 'session_start') return speaking ? 'talk' : 'happy'
  if (kind === 'compact') return 'sleepy'
  return speaking ? 'talk' : 'idle'
}
