/**
 * The tray menu, as pure data.
 *
 * Linux's tray is not a widget, it is a D-Bus endpoint: StatusNotifierItem,
 * which GNOME and KDE both serve through an appindicator host. There is no
 * click event to deliver, and `Tray.popUpContextMenu` is documented
 * `@platform darwin,win32` - so on Linux a tray that never called
 * `setContextMenu` has an icon and no behaviour at all. Both buttons are dead,
 * which reads as a hung app rather than as an unimplemented one. The menu is
 * therefore the tray's entire UI there, and a gesture on mac and Windows.
 *
 * What appears, in what order, and what each row says in each language is
 * platform-free and lives here; `main/window.ts` turns it into Electron
 * template objects and owns the memo that keeps the published menu current.
 */
import type { Lang } from './protocol'

export type TrayAction =
  | 'stage'
  | 'hide'
  | 'bench'
  | 'panel'
  | 'mute'
  | 'unmute'
  | 'hooks'
  | 'quit'

export type TrayEntry =
  | { kind: 'item'; action: TrayAction; label: string }
  | { kind: 'separator' }

export interface TrayMenuState {
  /** The stage window is on screen right now, so the first row hides it. */
  visible: boolean
  muted: boolean
  /**
   * Pro is on and herdr is reachable, i.e. there is a bench to open. A door to
   * a room that is not there reads as an ignored click, not as a feature off.
   */
  bench: boolean
  /** Attention count - the same number the badge draws on the icon. */
  badge: number
  lang: Lang
}

/** Which half of the tray's mouse contract a platform actually implements. */
export type TrayInteraction = 'menu' | 'gesture'

export function trayInteraction(platform: string): TrayInteraction {
  return platform === 'linux' ? 'menu' : 'gesture'
}

/**
 * The mode vocabulary is the product's, not the tray's: 舞台/Stage is her,
 * 工作台/Bench is the cockpit. One app, two modes - so no row here says "Pro",
 * which would claim a second application.
 */
const LABELS: Record<TrayAction, Record<Lang, string>> = {
  stage: { zh: '显示舞台', en: 'Show the stage' },
  hide: { zh: '收起舞台', en: 'Hide the stage' },
  bench: { zh: '打开工作台', en: 'Open the bench' },
  panel: { zh: '打开面板', en: 'Open the panel' },
  mute: { zh: '静音', en: 'Mute voice' },
  unmute: { zh: '取消静音', en: 'Unmute voice' },
  hooks: { zh: '修复 agent hooks', en: 'Repair agent hooks' },
  quit: { zh: '退出 CodeWaifu', en: 'Quit CodeWaifu' }
}

export function trayLabel(action: TrayAction, lang: Lang): string {
  return LABELS[action][lang]
}

/**
 * The count travels in the label because the icon's badge is 3 pixels of
 * glyph: the menu can say whether opening the bench is worth it before the
 * click rather than after.
 */
function benchLabel(state: TrayMenuState): string {
  const base = trayLabel('bench', state.lang)
  return state.badge > 0 ? `${base} (${state.badge})` : base
}

function item(action: TrayAction, lang: Lang): TrayEntry {
  return { kind: 'item', action, label: trayLabel(action, lang) }
}

const separator: TrayEntry = { kind: 'separator' }

/**
 * Rows top to bottom. The two ways back to her come first, because the tray is
 * clicked in a hurry; the bench next, since a badge on the icon is a question
 * the menu answers; then the panel; then the two repairs; then quit, alone at
 * the bottom where a destructive row belongs.
 */
export function trayMenu(state: TrayMenuState): TrayEntry[] {
  const rows: TrayEntry[] = [item(state.visible ? 'hide' : 'stage', state.lang)]
  if (state.bench) {
    rows.push({ kind: 'item', action: 'bench', label: benchLabel(state) })
  }
  rows.push(
    item('panel', state.lang),
    separator,
    item(state.muted ? 'unmute' : 'mute', state.lang),
    item('hooks', state.lang),
    separator,
    item('quit', state.lang)
  )
  return rows
}

/**
 * Identity of the published menu, for the memo in front of `setContextMenu`.
 * Labels are the whole content - the click handlers close over nothing that a
 * label does not already describe - so two states with the same signature
 * produce the same menu, and re-publishing one is pure D-Bus churn.
 */
export function trayMenuKey(state: TrayMenuState): string {
  return JSON.stringify(trayMenu(state))
}
