import path from 'node:path'
import { BrowserWindow, Menu, Tray, globalShortcut, nativeImage, screen, type Display } from 'electron'
import {
  HEIGHT_CHAT,
  WINDOW_WIDTH,
  WIDTH_CHAT,
  estimatedHeight,
  widgetView,
  type AvatarMode,
  type WidgetView
} from '../shared/ui'
import { IPC } from '../shared/ipcChannels'
import type { AppConfig } from '../shared/config'
import { hotkeyAction } from '../shared/hotkey'
import { isMac } from './env'
import { here } from './here'
import { log } from './log'
import { waifuIconPng } from './png'

export interface WindowHandlers {
  onExpanded: (expanded: boolean) => void
  onMoved: (position: { x: number; y: number }) => void
  onQuit: () => void
  isMuted: () => boolean
  onToggleMute: () => void
  onReinstallHooks: () => void
}

export interface WindowHandle {
  win: BrowserWindow
  tray: Tray | null
  show: (focus: boolean) => void
  hide: () => void
  setExpanded: (expanded: boolean) => void
  /** Widen the widget while a thread chat is open; ignored when collapsed. */
  setChatMode: (on: boolean) => void
  setClickThrough: (through: boolean) => void
  applyConfig: (config: AppConfig) => void
  isVisible: () => boolean
  /** Move the frame by a screen-space delta (renderer-driven drag). */
  moveBy: (dx: number, dy: number) => void
  /**
   * The renderer measured its own card and reported the height it needs. The
   * frame follows, so the window is never a pixel taller than its content.
   */
  fitHeight: (height: number) => void
  /** Hotkey guard: a non-empty focused input in our window suspends the hotkey. */
  setInputActive: (active: boolean) => void
}

function rendererEntry(): string {
  return path.join(here, '../renderer/index.html')
}

function preloadEntry(): string {
  // Built as CommonJS on purpose: a sandboxed preload cannot be ESM.
  const cjs = path.join(here, '../preload/index.cjs')
  return cjs
}

function clampToDisplay(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const display: Display = screen.getDisplayNearestPoint({ x: Math.max(0, x), y: Math.max(0, y) })
  const area = display.workArea
  const nextX = Math.min(Math.max(x, area.x), Math.max(area.x, area.x + area.width - width))
  const nextY = Math.min(Math.max(y, area.y), Math.max(area.y, area.y + area.height - height))
  return { x: Math.round(nextX), y: Math.round(nextY) }
}

function defaultPosition(width: number, height: number): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return { x: area.x + area.width - width - 24, y: area.y + area.height - height - 24 }
}

export function createWindow(config: AppConfig, handlers: WindowHandlers): WindowHandle {
  const height = estimatedHeight(config.avatar.mode, 'collapsed')
  const stored = config.window.x >= 0 && config.window.y >= 0 ? config.window : null
  const wanted = stored || defaultPosition(WINDOW_WIDTH, height)
  const position = clampToDisplay(wanted.x, wanted.y, WINDOW_WIDTH, height)

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    hasShadow: false,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    focusable: true,
    show: false,
    alwaysOnTop: config.alwaysOnTop,
    opacity: config.opacity,
    backgroundColor: '#00000000',
    roundedCorners: false,
    title: 'CodeWaifu',
    webPreferences: {
      preload: preloadEntry(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // The widget animates constantly; throttling would stall the lipsync.
      backgroundThrottling: false,
      // Speech is pushed from main after a hook fires; there is no click to
      // satisfy Chromium's autoplay gate, so it has to be lifted up front.
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  if (config.alwaysOnTop) win.setAlwaysOnTop(true, 'floating')
  if (isMac) {
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    } catch (error) {
      log('warn', 'setVisibleOnAllWorkspaces failed', String(error))
    }
  }

  win.setMenuBarVisibility(false)
  win.on('page-title-updated', (event) => event.preventDefault())

  let moveTimer: NodeJS.Timeout | null = null
  win.on('moved', () => {
    if (moveTimer) clearTimeout(moveTimer)
    moveTimer = setTimeout(() => {
      const [x, y] = win.getPosition()
      handlers.onMoved({ x, y })
    }, 250)
    moveTimer.unref?.()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(rendererEntry())
  }

  let expanded = false
  let chatMode = false
  let avatarMode: AvatarMode = config.avatar.mode
  /**
   * Height the renderer last measured, per view. Starting from an estimate and
   * converging on the measurement keeps the very first paint from jumping: the
   * frame opens at `estimatedHeight`, then snaps to the real card height once
   * React has laid out — usually within a frame or two.
   */
  const fitted = new Map<WidgetView, number>()

  /** Size for the current mode. The chat is a wider, taller panel. */
  const targetSize = (): { width: number; height: number } => {
    const view = widgetView(expanded, chatMode)
    const width = view === 'chat' ? Math.max(WINDOW_WIDTH, WIDTH_CHAT) : WINDOW_WIDTH
    const height = view === 'chat'
      ? Math.max(fitted.get(view) ?? 0, HEIGHT_CHAT)
      : fitted.get(view) ?? estimatedHeight(avatarMode, view)
    return { width, height }
  }

  const applyGeometry = (): void => {
    const size = targetSize()
    const [x, y] = win.getPosition()
    const area = screen.getDisplayNearestPoint({ x, y }).workArea
    const width = Math.round(Math.min(size.width, area.width))
    const height = Math.round(Math.min(size.height, area.height))
    // Grow right/down when there is room, otherwise slide back so the widget
    // never hangs off the display (a taller panel must not lose its composer).
    const nextX = Math.round(x + width > area.x + area.width ? Math.max(area.x, area.x + area.width - width) : x)
    const nextY = Math.round(y + height > area.y + area.height ? Math.max(area.y, area.y + area.height - height) : y)
    win.setBounds({ x: nextX, y: nextY, width, height })
    handlers.onMoved({ x: nextX, y: nextY })
  }

  const setExpanded = (next: boolean): void => {
    if (expanded === next) {
      handlers.onExpanded(next)
      return
    }
    expanded = next
    // Collapsing always leaves chat mode, so the next expand starts at the list.
    if (!next) chatMode = false
    applyGeometry()
    handlers.onExpanded(next)
  }

  const setChatMode = (on: boolean): void => {
    if (!expanded || chatMode === on) return
    chatMode = on
    applyGeometry()
  }

  const fitHeight = (next: number): void => {
    const view = widgetView(expanded, chatMode)
    const height = Math.round(next)
    if (!Number.isFinite(height) || height < 80 || height > 4000) return
    const previous = fitted.get(view)
    // A 1px wobble from sub-pixel text would re-setBounds every frame.
    if (previous !== undefined && Math.abs(previous - height) < 2) return
    fitted.set(view, height)
    applyGeometry()
  }

  /**
   * Renderer-driven drag. `setPosition` (not `setBounds`) so the size the
   * fit-height loop settled on is untouched, and clamped to the display so a
   * fast flick cannot throw her off-screen where the tray is the only way back.
   */
  const moveBy = (dx: number, dy: number): void => {
    if (win.isDestroyed()) return
    const stepX = Number(dx)
    const stepY = Number(dy)
    if (!Number.isFinite(stepX) || !Number.isFinite(stepY)) return
    if (Math.abs(stepX) < 1 && Math.abs(stepY) < 1) return
    const [x, y] = win.getPosition()
    const size = win.getSize()
    const next = clampToDisplay(x + stepX, y + stepY, size[0], size[1])
    if (next.x === x && next.y === y) return
    win.setPosition(next.x, next.y)
  }

  let clickThrough = false
  const setClickThrough = (through: boolean): void => {
    if (through === clickThrough) return
    clickThrough = through
    try {
      // forward:true keeps mousemove flowing so the page can re-enable hits.
      win.setIgnoreMouseEvents(through, { forward: true })
    } catch (error) {
      log('warn', 'setIgnoreMouseEvents failed', String(error))
    }
  }
  setClickThrough(false)

  const show = (focus: boolean): void => {
    if (!win.isDestroyed()) {
      win.show()
      win.moveTop()
      if (focus) win.focus()
    }
  }

  // Summon = appear on the simple stage. The panel is a deliberate detour, so
  // coming back from the tray always collapses it instead of restoring it.
  const summon = (focus: boolean): void => {
    show(focus)
    setExpanded(false)
  }

  const tray = createTray(win, handlers, summon, show)

  /* ---- system-wide summon hotkey (rules in shared/hotkey.ts) ------------- */
  let inputActive = false
  let registeredHotkey = ''
  const onHotkey = (): void => {
    const action = hotkeyAction({ inputActive, visible: !win.isDestroyed() && win.isVisible() })
    if (action === 'ignore') return
    if (action === 'hide') win.hide()
    else summon(true)
  }
  const syncHotkey = (wanted: string): void => {
    if (registeredHotkey === wanted) return
    if (registeredHotkey) {
      try {
        globalShortcut.unregister(registeredHotkey)
      } catch (error) {
        log('warn', 'hotkey unregister failed', String(error))
      }
      registeredHotkey = ''
    }
    try {
      // false = another app owns the combo or the string is not an accelerator.
      if (globalShortcut.register(wanted, onHotkey)) registeredHotkey = wanted
      else log('warn', 'hotkey registration refused (taken or invalid)', wanted)
    } catch (error) {
      log('warn', 'hotkey registration failed', String(error))
    }
  }
  syncHotkey(config.hotkey)

  return {
    win,
    tray,
    show,
    hide: () => {
      if (!win.isDestroyed()) win.hide()
    },
    setExpanded,
    setChatMode,
    setClickThrough,
    isVisible: () => !win.isDestroyed() && win.isVisible(),
    moveBy,
    fitHeight,
    setInputActive: (active: boolean) => {
      inputActive = active
    },
    applyConfig: (next: AppConfig) => {
      if (win.isDestroyed()) return
      try {
        win.setAlwaysOnTop(next.alwaysOnTop, next.alwaysOnTop ? 'floating' : undefined)
        win.setOpacity(next.opacity)
        syncHotkey(next.hotkey)
        // Switching avatar kind changes the stage height, so re-fit the frame.
        if (next.avatar.mode !== avatarMode) {
          avatarMode = next.avatar.mode
          fitted.clear()
          applyGeometry()
        }
      } catch (error) {
        log('warn', 'applyConfig failed', String(error))
      }
    }
  }
}

function createTray(
  win: BrowserWindow,
  handlers: WindowHandlers,
  summon: (focus: boolean) => void,
  show: (focus: boolean) => void
): Tray | null {
  try {
    const size = isMac ? 22 : 32
    const image = nativeImage.createFromBuffer(waifuIconPng(size * 4)).resize({ width: size, height: size })
    const tray = new Tray(image)
    tray.setToolTip('CodeWaifu')
    const build = (): Menu => {
      const muted = handlers.isMuted()
      return Menu.buildFromTemplate([
        {
          label: win.isVisible() ? 'Hide companion' : 'Show stage',
          click: () => {
            if (win.isDestroyed()) return
            if (win.isVisible()) win.hide()
            else summon(true)
          }
        },
        {
          label: 'Open panel',
          click: () => {
            // The window may be hidden; opening the panel must reveal it too.
            show(true)
            win.webContents.send(IPC.openPanel)
          }
        },
        { type: 'separator' },
        { label: muted ? 'Unmute voice' : 'Mute voice', click: () => handlers.onToggleMute() },
        { label: 'Repair agent hooks', click: () => handlers.onReinstallHooks() },
        { type: 'separator' },
        { label: 'Quit CodeWaifu', click: () => handlers.onQuit() }
      ])
    }
    /*
     * Left click is the summon gesture on every platform: she appears on the
     * simple stage. A tray with `setContextMenu` makes macOS swallow the left
     * click into the menu, which put the full panel one mis-click away from a
     * casual click; popping the menu on right click only keeps the left click
     * for her.
     */
    tray.on('click', () => summon(true))
    tray.on('double-click', () => summon(true))
    // Rebuilt on open so the mute label reflects the current state.
    tray.on('right-click', () => tray.popUpContextMenu(build()))
    return tray
  } catch (error) {
    log('warn', 'tray unavailable (headless session?)', String(error))
    return null
  }
}
