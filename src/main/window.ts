import path from 'node:path'
import { BrowserWindow, Menu, Tray, nativeImage, screen, type Display } from 'electron'
import { HEIGHT_COLLAPSED, HEIGHT_EXPANDED, WINDOW_WIDTH } from '../shared/ui'
import { IPC } from '../shared/ipcChannels'
import type { AppConfig } from '../shared/config'
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
  setClickThrough: (through: boolean) => void
  applyConfig: (config: AppConfig) => void
  isVisible: () => boolean
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
  const height = HEIGHT_COLLAPSED
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
      backgroundThrottling: false
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
  const setExpanded = (next: boolean): void => {
    if (expanded === next) {
      handlers.onExpanded(next)
      return
    }
    expanded = next
    const targetHeight = next ? HEIGHT_EXPANDED : HEIGHT_COLLAPSED
    const [x, y] = win.getPosition()
    const display = screen.getDisplayNearestPoint({ x, y })
    const area = display.workArea
    // Grow downward when there is room, otherwise slide up so nothing is cut off.
    let nextY = y
    if (y + targetHeight > area.y + area.height) {
      nextY = Math.max(area.y, area.y + area.height - targetHeight)
    }
    win.setBounds({ x, y: nextY, width: WINDOW_WIDTH, height: targetHeight })
    handlers.onExpanded(next)
    handlers.onMoved({ x, y: nextY })
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

  const tray = createTray(win, handlers, show)

  return {
    win,
    tray,
    show,
    hide: () => {
      if (!win.isDestroyed()) win.hide()
    },
    setExpanded,
    setClickThrough,
    isVisible: () => !win.isDestroyed() && win.isVisible(),
    applyConfig: (next: AppConfig) => {
      if (win.isDestroyed()) return
      try {
        win.setAlwaysOnTop(next.alwaysOnTop, next.alwaysOnTop ? 'floating' : undefined)
        win.setOpacity(next.opacity)
      } catch (error) {
        log('warn', 'applyConfig failed', String(error))
      }
    }
  }
}

function createTray(
  win: BrowserWindow,
  handlers: WindowHandlers,
  show: (focus: boolean) => void
): Tray | null {
  try {
    const size = isMac ? 22 : 32
    const image = nativeImage.createFromBuffer(waifuIconPng(size * 4)).resize({ width: size, height: size })
    const tray = new Tray(image)
    tray.setToolTip('CodeWaifu')
    const build = (): void => {
      const muted = handlers.isMuted()
      const menu = Menu.buildFromTemplate([
        {
          label: win.isVisible() ? 'Hide companion' : 'Show companion',
          click: () => {
            if (win.isDestroyed()) return
            if (win.isVisible()) win.hide()
            else show(true)
          }
        },
        { label: 'Open panel', click: () => win.webContents.send(IPC.openPanel) },
        { type: 'separator' },
        { label: muted ? 'Unmute voice' : 'Mute voice', click: () => handlers.onToggleMute() },
        { label: 'Repair agent hooks', click: () => handlers.onReinstallHooks() },
        { type: 'separator' },
        { label: 'Quit CodeWaifu', click: () => handlers.onQuit() }
      ])
      tray.setContextMenu(menu)
    }
    build()
    tray.on('click', () => show(true))
    // Rebuild on open so the mute label reflects the current state.
    tray.on('right-click', build)
    return tray
  } catch (error) {
    log('warn', 'tray unavailable (headless session?)', String(error))
    return null
  }
}
