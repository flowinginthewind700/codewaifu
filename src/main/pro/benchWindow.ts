/**
 * The Bench window: a real, framed, resizable window, because a cockpit that
 * contains live terminals has to behave like one.
 *
 * Everything the widget window does deliberately (transparent, frameless,
 * sized to its content, shaped for click-through) is wrong here, so this is a
 * second window module rather than a mode of the first. What the two share is
 * the preload and the display clamping, both imported from `../window` so
 * there is one copy of each.
 *
 * The window is created on first open and kept afterwards: a bench that
 * re-spawns on every bubble click loses the terminal scrollback the human was
 * reading. Closing it hides it; only quitting destroys it.
 */
import path from 'node:path'
import { BrowserWindow, nativeImage, screen } from 'electron'
import { isMac } from '../env'
import { here } from '../here'
import { log } from '../log'
import { waifuIconPng } from '../png'
import { clampToDisplay, preloadEntry } from '../window'

export interface BenchGeometry {
  width: number
  height: number
  /** -1 on either axis means "centre on the primary display". */
  x: number
  y: number
}

export interface BenchWindowDeps {
  geometry: () => BenchGeometry
  /** Persist a moved or resized frame. Called once per settle, not per pixel. */
  saveGeometry: (geometry: BenchGeometry) => void
  /**
   * Focus changed. The companion's summon policy reads this: an item that
   * arrives while the human is already looking at the fleet must not pop the
   * widget up over it.
   */
  onFocusChange: (focused: boolean) => void
  /** The renderer is up. Replay a pending focus request into it. */
  onLoaded: () => void
  /** The window went away for real (quit), not merely hidden. */
  onClosed?: () => void
  /**
   * The interface-zoom rung main is applying right now. Read at creation and
   * again on every load, because Chromium resets page zoom to 1 on navigation
   * and a bench that came up at 130% would otherwise draw at 100% after a dev
   * reload - or after being opened for the first time.
   */
  zoom: () => number
}

export interface BenchHandle {
  readonly win: BrowserWindow
  /** `focus: false` shows without taking the keyboard. */
  show: (focus: boolean) => void
  hide: () => void
  isVisible: () => boolean
  isFocused: () => boolean
  send: (channel: string, payload: unknown) => void
  /**
   * Re-read main's rung into the page. The value is not passed in: main already
   * owns the persisted `uiZoom`, and a second copy handed per call is a second
   * place to keep in step with it.
   */
  setZoom: () => void
  destroy: () => void
}

const MIN_WIDTH = 760
const MIN_HEIGHT = 440
/** Long enough to swallow a drag's worth of move events, short enough to feel saved. */
const SAVE_DEBOUNCE_MS = 400

function benchEntry(): string {
  return path.join(here, '../renderer/pro.html')
}

function centred(width: number, height: number): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2)
  }
}

export function createBenchWindow(deps: BenchWindowDeps): BenchHandle {
  const wanted = deps.geometry()
  const width = Math.max(MIN_WIDTH, Math.trunc(wanted.width) || MIN_WIDTH)
  const height = Math.max(MIN_HEIGHT, Math.trunc(wanted.height) || MIN_HEIGHT)
  const at =
    wanted.x >= 0 && wanted.y >= 0
      ? clampToDisplay(wanted.x, wanted.y, width, height)
      : centred(width, height)

  const win = new BrowserWindow({
    width,
    height,
    x: at.x,
    y: at.y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // One app, two modes: the window is named after the product, not after the
    // mode it happens to be showing. A second product name in the title bar is
    // how a mode starts feeling like a separate install.
    title: 'CodeWaifu',
    // A framed window: the human has to be able to move it, resize it, minimise
    // it and Alt-Tab to it without learning a new set of gestures.
    frame: true,
    transparent: false,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    skipTaskbar: false,
    show: false,
    autoHideMenuBar: true,
    // Matches the renderer's own background so the first paint is not a white
    // flash over a dark workbench.
    backgroundColor: '#111214',
    icon: isMac ? undefined : nativeImage.createFromBuffer(waifuIconPng(256)),
    webPreferences: {
      preload: preloadEntry(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Terminal frames keep arriving while the bench is behind another window,
      // and a throttled renderer would let them pile up into what the human
      // experiences as a frozen pane.
      backgroundThrottling: false
    }
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void win.loadURL(`${devUrl.replace(/\/$/, '')}/pro.html`)
  } else {
    void win.loadFile(benchEntry())
  }

  /**
   * Push main's rung into the page. Unlike the widget, the bench is a normal
   * framed window whose bounds the human chose, so zooming scales the content
   * inside a frame that stays put - exactly what a browser does, and no
   * measurement of the renderer's CSS pixels comes back here to be converted.
   */
  const applyZoom = (): void => {
    if (win.isDestroyed()) return
    try {
      win.webContents.setZoomFactor(deps.zoom())
    } catch (error) {
      log('warn', 'bench setZoomFactor failed', String(error))
    }
  }
  if (deps.zoom() !== 1) applyZoom()
  win.webContents.on('did-finish-load', applyZoom)

  /*
   * Geometry is saved on a debounce and once more on close: `move` and `resize`
   * fire per pixel during a drag on Linux, and a config write in the middle of
   * the gesture is a write the user did not ask for.
   */
  let saveTimer: NodeJS.Timeout | null = null
  const persist = (): void => {
    if (win.isDestroyed()) return
    try {
      const bounds = win.getBounds()
      deps.saveGeometry({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y
      })
    } catch (error) {
      log('warn', 'bench geometry save failed', String(error))
    }
  }
  const saveSoon = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      persist()
    }, SAVE_DEBOUNCE_MS)
    saveTimer.unref?.()
  }

  win.on('move', saveSoon)
  win.on('resize', saveSoon)
  win.on('focus', () => deps.onFocusChange(true))
  win.on('blur', () => deps.onFocusChange(false))
  win.webContents.on('did-finish-load', () => deps.onLoaded())
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    persist()
  })
  win.on('closed', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    deps.onClosed?.()
  })

  const alive = (): boolean => !win.isDestroyed()

  return {
    win,
    show(focus: boolean) {
      if (!alive()) return
      if (win.isMinimized()) win.restore()
      win.show()
      if (focus) win.focus()
    },
    hide() {
      if (alive() && win.isVisible()) win.hide()
    },
    isVisible: () => alive() && win.isVisible(),
    isFocused: () => alive() && win.isFocused(),
    send(channel: string, payload: unknown) {
      if (alive()) win.webContents.send(channel, payload)
    },
    setZoom() {
      applyZoom()
    },
    destroy() {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = null
      if (alive()) win.destroy()
    }
  }
}
