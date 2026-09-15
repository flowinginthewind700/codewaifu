/**
 * Window geometry shared by main (resize) and the renderer (layout).
 *
 * One rule keeps the two sides from drifting: every pixel the window is sized
 * to is derived from a value in this file. The renderer turns the same numbers
 * into CSS custom properties, then reports the measured card height back to
 * main (`IPC.fitHeight`) so the frame is exactly as tall as its content — no
 * dead transparent strip below the card, no clipped panel.
 */
export const WINDOW_WIDTH = 320
export const WINDOW_MIN_MARGIN = 8
/** Transparent margin around the card; also `.shell { padding }`. */
export const WINDOW_PADDING = 10

/**
 * Geometry while the thread chat is open. A conversation needs width more than
 * it needs height: 320px wraps assistant prose into a tall thin column, and the
 * extra 100px is what keeps a tool call and its one-line summary on one row.
 * Main clamps this to the display work area, so it never grows off-screen.
 */
export const WIDTH_CHAT = 420
/** Floor for the chat window; the fitted height wins when it is taller. */
export const HEIGHT_CHAT = 720

export type AvatarMode = 'builtin' | 'image' | 'live2d'
/** What the widget is showing right now — the only input to its geometry. */
export type WidgetView = 'collapsed' | 'panel' | 'chat'

/**
 * Room the tabbed panel needs to be usable. It is a fixed height (not
 * content-driven) on purpose: a card whose height depended on how many events
 * are in the log would make the window resize as content arrived, and the
 * fit-height loop would never settle.
 */
export const PANEL_H = 388

/** Floor for a squeezed panel; mirrors `.panel { min-height }` in styles.css. */
export const PANEL_MIN_H = 140

/**
 * Stage height per avatar kind and view. A Live2D character is a half-body
 * figure that reads as a presence, so she gets the whole collapsed window;
 * once the panel or the chat is open she steps back to a cameo.
 */
const STAGE: Record<AvatarMode, Record<WidgetView, number>> = {
  builtin: { collapsed: 172, panel: 172, chat: 108 },
  image: { collapsed: 172, panel: 172, chat: 108 },
  live2d: { collapsed: 300, panel: 132, chat: 112 }
}

export function stageHeight(mode: AvatarMode, view: WidgetView): number {
  const row = STAGE[mode] ?? STAGE.builtin
  return row[view] ?? row.collapsed
}

/**
 * Panel height per view. The renderer turns this into `--panel-h` on the card
 * and main turns it into the frame's height, so both sides read one number.
 *
 * The chat is derived rather than fixed: a conversation is read top to bottom
 * and typed into at the bottom, so it gets whatever is left of `HEIGHT_CHAT`
 * once the cameo stage and the chrome have taken their share. That keeps the
 * card exactly as tall as the frame in chat view, for either avatar kind.
 */
export function panelHeight(mode: AvatarMode, view: WidgetView): number {
  if (view === 'collapsed') return 0
  if (view !== 'chat') return PANEL_H
  const chrome = CHROME_ESTIMATE - WINDOW_PADDING * 2
  return Math.max(PANEL_MIN_H, HEIGHT_CHAT - WINDOW_PADDING * 2 - stageHeight(mode, view) - chrome)
}

export function widgetView(expanded: boolean, chat: boolean): WidgetView {
  if (!expanded) return 'collapsed'
  return chat ? 'chat' : 'panel'
}

/**
 * First-paint estimate of the window height, used before the renderer has
 * measured anything. Chrome (media bar + status bar + card border + shell
 * padding) is ~92px; the fitted height replaces this within a frame or two.
 */
export const CHROME_ESTIMATE = 92

export function estimatedHeight(mode: AvatarMode, view: WidgetView): number {
  return stageHeight(mode, view) + panelHeight(mode, view) + CHROME_ESTIMATE
}

export type PanelTab = 'threads' | 'log' | 'settings'

export interface BubbleMessage {
  id: string
  text: string
  lang: 'zh' | 'en'
  agent: string
  kind: string
  at: number
  /**
   * Set when the bubble stands for something the Bench can act on. Clicking it
   * routes back to that task and pane instead of doing nothing, and `actions`
   * are the verbs the bubble may offer without opening the Bench at all.
   *
   * Deliberately typed as plain strings (`kind`, `actions`) rather than
   * importing `pro.ts`: the widget must not depend on the bench model to draw a
   * bubble, and a hook bubble with no route stays exactly as cheap as before.
   */
  route?: BubbleRoute
}

/** Where a bubble came from, and what it lets the widget do about it. */
export interface BubbleRoute {
  taskId: string
  paneId: string
  /** Attention item id, '' for a notice that is not an attention item. */
  itemId: string
  /** AttentionKind as a string; '' for info/recovery notices. */
  kind: string
  /** AttentionAction names this bubble may offer as buttons. */
  actions: string[]
  /** What the button says, e.g. "Open in Bench". Already localized. */
  benchLabel: string
}

export type Expression = 'idle' | 'talk' | 'happy' | 'alert' | 'sleepy'

/** Which face the avatar should wear for a given event. */
export function expressionForKind(kind: string, speaking: boolean): Expression {
  if (kind === 'permission' || kind === 'notification') return 'alert'
  if (kind === 'stop' || kind === 'session_start') return speaking ? 'talk' : 'happy'
  if (kind === 'compact') return 'sleepy'
  return speaking ? 'talk' : 'idle'
}
