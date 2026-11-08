/**
 * The shell entry that keeps CodeWaifu reachable.
 *
 * A tray is not a window-manager feature: Electron can construct a Tray even
 * when Linux has no StatusNotifier host or macOS chooses not to render the
 * status item. The app therefore has to treat "the tray was constructed" and
 * "the user can click something" as two different facts.
 */

export type PresenceMode = 'tray' | 'dock' | 'taskbar'
export type MacActivationPolicy = 'regular' | 'accessory'

export interface PresenceFacts {
  platform: string
  trayCreated: boolean
  /** Linux only: whether a StatusNotifier watcher owns the session-bus name. */
  statusNotifierHost?: boolean
}

export interface DesktopPresence {
  mode: PresenceMode
  /** Whether the frame should stay out of the taskbar/Dock-window list. */
  hideFromTaskbar: boolean
  /** macOS policy to apply after the tray has been created. */
  macActivationPolicy: MacActivationPolicy | null
  /**
   * Whether closing the last window should leave the process running. A Dock
   * or tray can summon it again; a taskbar fallback cannot once its window is
   * destroyed, so it closes normally.
   */
  keepAliveWithoutWindows: boolean
  reason: 'tray-ready' | 'tray-construction-failed' | 'linux-no-status-notifier'
}

/**
 * Choose the one dependable shell entry for this run.
 *
 * Linux is special because `new Tray()` succeeds without a host. macOS is
 * special because construction also succeeds when the menu bar omits the item,
 * so the Dock remains the dependable entry even when a tray exists. Windows
 * keeps its historical tray lifecycle; if construction fails, it falls back
 * to the taskbar.
 */
export function desktopPresence(facts: PresenceFacts): DesktopPresence {
  const trayUsable =
    facts.trayCreated &&
    (facts.platform !== 'linux' || facts.statusNotifierHost === true)

  if (facts.platform === 'darwin') {
    return {
      mode: 'dock',
      hideFromTaskbar: false,
      macActivationPolicy: 'regular',
      keepAliveWithoutWindows: true,
      reason: facts.trayCreated ? 'tray-ready' : 'tray-construction-failed'
    }
  }

  if (trayUsable) {
    return {
      mode: 'tray',
      hideFromTaskbar: true,
      macActivationPolicy: null,
      // Windows has no app-level activation event equivalent to macOS Dock
      // activation, and this tray's callbacks close over the existing window.
      // Keep the historical Windows lifecycle: once that window is destroyed,
      // quit rather than leave a tray whose "show" action has no window.
      keepAliveWithoutWindows: facts.platform !== 'win32',
      reason: 'tray-ready'
    }
  }

  const reason =
    facts.platform === 'linux' && facts.trayCreated
      ? 'linux-no-status-notifier'
      : 'tray-construction-failed'

  return {
    mode: 'taskbar',
    hideFromTaskbar: false,
    macActivationPolicy: null,
    keepAliveWithoutWindows: false,
    reason
  }
}
