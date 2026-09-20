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
import { clampZoom } from '../shared/zoom'
import {
  shapeForRegion,
  sameRegion,
  unionRect,
  windowSurface,
  type RegionRect
} from '../shared/linuxRuntime'
import { isLinux, isMac } from './env'
import { here } from './here'
import { compositorProbe, currentSession, logDesktop } from './linux'
import { log } from './log'
import { badgeDigits, waifuIconPng } from './png'
import {
  trayInteraction,
  trayMenu,
  trayMenuKey,
  type TrayAction,
  type TrayMenuState
} from '../shared/trayMenu'
import type { Lang } from '../shared/protocol'

export interface WindowHandlers {
  onExpanded: (expanded: boolean) => void
  onMoved: (position: { x: number; y: number }) => void
  onQuit: () => void
  isMuted: () => boolean
  /**
   * Language the tray's copy is written in, read live: it follows the UI
   * language setting, which can change while the tray is already published.
   */
  lang: () => Lang
  onToggleMute: () => void
  onReinstallHooks: () => void
  /**
   * The widget appeared or went away, from any path: tray, hotkey, `hide` IPC,
   * or a window manager doing it behind our back. Pro's summon policy reads
   * visibility, so the Bench has to hear when it changes rather than poll it.
   */
  onVisibility?: (visible: boolean) => void
  /**
   * Bring the Bench forward. Without this the cockpit has no door: the only
   * other ways in are `pro.openBenchOnLaunch` in the config file and an
   * attention bubble carrying no task, so a quiet fleet is a fleet you cannot
   * open. The tray is the one control surface that exists whether or not she
   * is on screen.
   */
  onOpenBench?: () => void
  /**
   * Live, and read every time the menu is built: Pro can be switched off at
   * runtime, and a door to a room that is not there reads as an ignored click
   * rather than as a feature that is off.
   */
  benchAvailable?: () => boolean
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
  /**
   * Linux only: the renderer's measured solid region, used as the window's
   * input shape. Ignored everywhere else, where mouse-event forwarding works.
   */
  setSolidRegion: (rects: readonly RegionRect[]) => void
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
  /**
   * Mirror the live attention count onto the tray icon (F7). `0` restores the
   * plain mark. A no-op where the platform gave us no tray at all.
   */
  setBadge: (count: number) => void
  /**
   * Re-publish the tray menu from the current state. Needed on Linux, where the
   * menu is the tray's only behaviour and is published once rather than built on
   * open; a no-op elsewhere and whenever nothing a label depends on changed.
   */
  refreshTray: () => void
}

function rendererEntry(): string {
  return path.join(here, '../renderer/index.html')
}

/**
 * Shared with the Bench window: there is exactly one preload in this app, and a
 * second copy of this path is how the two windows drift apart.
 */
export function preloadEntry(): string {
  // Built as CommonJS on purpose: a sandboxed preload cannot be ESM.
  const cjs = path.join(here, '../preload/index.cjs')
  return cjs
}

/**
 * Keep a restored frame on a screen that exists. A saved position from a
 * monitor that is no longer plugged in would otherwise open the window
 * somewhere the user cannot reach it.
 */
export function clampToDisplay(
  x: number,
  y: number,
  width: number,
  height: number
): { x: number; y: number } {
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
  /*
   * Interface zoom: device-independent pixels per CSS pixel, applied with
   * `webContents.setZoomFactor`.
   *
   * Zooming scales the page, so every length the renderer measures or lays out
   * with - `offsetHeight`, `getBoundingClientRect`, `window.innerWidth`, and
   * the constants in shared/ui.ts that it turns into CSS - is in CSS pixels,
   * while every length Electron wants (`setBounds`, `setShape`, the initial
   * frame size) is in DIPs. The two differ by exactly this factor, and this
   * closure is the one place that knows it, so the renderer never has to.
   *
   * One deliberate exception, measured on Electron 44 rather than assumed:
   * `MouseEvent.screenX/screenY` stay in DIPs under zoom (a pointer at CSS
   * x=80 in a frame at DIP x=100 reports screenX 260 = 100 + 80*2 at zoom 2).
   * The drag path turns those into deltas handed straight to `setPosition`, so
   * `moveBy` must NOT convert - dividing it would make her outrun the cursor.
   */
  let zoom = clampZoom(config.uiZoom)
  /** A CSS-pixel length from the renderer, in the DIPs Electron sizes with. */
  const toDip = (css: number): number => Math.round(css * zoom)

  const height = toDip(estimatedHeight(config.avatar.mode, 'collapsed'))
  const stored = config.window.x >= 0 && config.window.y >= 0 ? config.window : null
  const wanted = stored || defaultPosition(toDip(WINDOW_WIDTH), height)
  const position = clampToDisplay(wanted.x, wanted.y, toDip(WINDOW_WIDTH), height)

  /*
   * Transparency is a constructor argument, so the desktop has to be probed
   * before the window exists. Off Linux this is the plain frameless-alpha
   * behaviour the app has always had.
   */
  const surface = isLinux
    ? windowSurface(process.env, currentSession(), compositorProbe())
    : { transparent: true, backgroundColor: '#00000000', reason: 'native' }
  if (isLinux) log('info', 'window surface', { reason: surface.reason })

  const win = new BrowserWindow({
    width: toDip(WINDOW_WIDTH),
    height,
    x: position.x,
    y: position.y,
    frame: false,
    transparent: surface.transparent,
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
    backgroundColor: surface.backgroundColor,
    roundedCorners: false,
    title: 'CodeWaifu',
    // The taskbar / Alt-Tab icon comes from the window on X11 and Windows, not
    // from the bundle, so without this Linux shows the stock Electron atom.
    icon: isMac ? undefined : nativeImage.createFromBuffer(waifuIconPng(256)),
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
  if (isMac || isLinux) {
    // Keep her on every workspace: a companion that disappears when you switch
    // to another desktop is a companion nobody looks at.
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

  /**
   * Push the zoom ladder rung into the page. Every navigation resets Chromium's
   * zoom back to 1, so this is re-applied on load rather than only on change —
   * otherwise a reload in dev (or any future in-window navigation) would leave
   * the renderer drawing at 100% inside a frame sized for, say, 130%.
   */
  const applyZoom = (): void => {
    if (win.isDestroyed()) return
    try {
      win.webContents.setZoomFactor(zoom)
    } catch (error) {
      log('warn', 'setZoomFactor failed', String(error))
    }
  }

  if (zoom !== 1) applyZoom()
  win.webContents.on('did-finish-load', applyZoom)

  let expanded = false
  let chatMode = false
  let avatarMode: AvatarMode = config.avatar.mode
  /**
   * Height the renderer last measured, per view. Starting from an estimate and
   * converging on the measurement keeps the very first paint from jumping: the
   * frame opens at `estimatedHeight`, then snaps to the real card height once
   * React has laid out — usually within a frame or two.
   *
   * Stored in DIPs, not in the CSS pixels the renderer reports: `fitHeight`
   * converts at the boundary, so this map and every constant in `targetSize`
   * are in the one unit `setBounds` wants, and zooming cannot leave a stale
   * CSS-pixel height being read back as a DIP height.
   */
  const fitted = new Map<WidgetView, number>()

  /** Size for the current mode. The chat is a wider, taller panel. */
  const targetSize = (): { width: number; height: number } => {
    const view = widgetView(expanded, chatMode)
    // The shared/ui constants are authored in CSS pixels; `toDip` puts them in
    // the frame's unit. `fitted` already holds DIPs, so it is not converted.
    const width = view === 'chat' ? toDip(Math.max(WINDOW_WIDTH, WIDTH_CHAT)) : toDip(WINDOW_WIDTH)
    const height = view === 'chat'
      ? Math.max(fitted.get(view) ?? 0, toDip(HEIGHT_CHAT))
      : fitted.get(view) ?? toDip(estimatedHeight(avatarMode, view))
    return { width, height }
  }

  /**
   * Last input shape applied on Linux, so an unchanged measurement costs
   * nothing. Declared above `applyGeometry` because that function clears it:
   * the shape is window-relative, so a resized frame invalidates the one we
   * have and the renderer's next report must be taken at its word.
   */
  let shaped: RegionRect | null = null

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
    shaped = null
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
    // The renderer measures CSS pixels; the frame is sized in DIPs.
    const height = toDip(Math.round(next))
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

  /**
   * Letting the empty margins pass clicks through, per platform.
   *
   * macOS and Windows use `setIgnoreMouseEvents(through, { forward: true })`:
   * forwarding is what lets the page see the pointer come back over the card and
   * undo it. Linux has no forwarding — the option is documented
   * `@platform darwin,win32` — so a click-through window there never receives
   * another mousemove and would stay unclickable for the rest of the session.
   * Linux gets an input shape instead (`setSolidRegion`), which is strictly
   * better: outside the region nothing is drawn and nothing is caught, inside it
   * everything works, and no forwarding is needed.
   */
  let clickThrough = false
  const setClickThrough = (through: boolean): void => {
    if (isLinux) return
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

  const setSolidRegion = (rects: readonly RegionRect[]): void => {
    if (!isLinux || win.isDestroyed()) return
    const bounds = win.getBounds()
    // The rects arrive as CSS pixels (the renderer's getBoundingClientRect) and
    // `bounds` is DIPs, so the union has to cross the same boundary fitHeight
    // does before it is clamped against the frame - otherwise, zoomed in, the
    // shape covers only part of the card and the rest of her clicks through.
    const union = unionRect(rects)
    const solid = union
      ? { x: toDip(union.x), y: toDip(union.y), width: toDip(union.width), height: toDip(union.height) }
      : null
    const next = shapeForRegion(solid, {
      x: 0,
      y: 0,
      width: bounds.width,
      height: bounds.height
    })
    // null means "do not trust this measurement": keep the shape we have. An
    // empty `setShape([])` is not a reset on Linux, it is a zero-area window.
    if (!next || sameRegion(next, shaped)) return
    try {
      win.setShape([next])
      shaped = next
    } catch (error) {
      log('warn', 'setShape failed', String(error))
    }
  }

  // Bound to the window's own events, not to our show/hide helpers, so a
  // visibility change we did not cause still reaches the listeners. The tray's
  // first row is that same fact, so it re-publishes from here too: a window
  // manager hiding us is exactly the case a `hide()`-side hook would miss.
  win.on('show', () => {
    handlers.onVisibility?.(true)
    trayHandle.refresh()
  })
  win.on('hide', () => {
    handlers.onVisibility?.(false)
    trayHandle.refresh()
  })

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

  const trayHandle = createTray(win, handlers, summon, show)
  const tray = trayHandle.tray

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
    setSolidRegion,
    isVisible: () => !win.isDestroyed() && win.isVisible(),
    moveBy,
    fitHeight,
    setInputActive: (active: boolean) => {
      inputActive = active
    },
    setBadge: (count: number) => trayHandle.setBadge(count),
    refreshTray: () => trayHandle.refresh(),
    applyConfig: (next: AppConfig) => {
      if (win.isDestroyed()) return
      trayHandle.refresh()
      try {
        win.setAlwaysOnTop(next.alwaysOnTop, next.alwaysOnTop ? 'floating' : undefined)
        win.setOpacity(next.opacity)
        syncHotkey(next.hotkey)
        // Zoom changes the CSS-pixels-per-DIP ratio, so every measurement the
        // renderer has already reported is now in the wrong unit: drop them and
        // let the frame re-fit from the estimate until the next report lands.
        const nextZoom = clampZoom(next.uiZoom)
        if (nextZoom !== zoom) {
          zoom = nextZoom
          applyZoom()
          fitted.clear()
          applyGeometry()
        }
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

/** The tray, plus the two things the rest of main needs from it. */
interface TrayHandle {
  tray: Tray | null
  setBadge: (count: number) => void
  refresh: () => void
}

/** Tray icon edge in device-independent pixels, per platform convention. */
function trayIconSize(): number {
  return isMac ? 22 : 32
}

/**
 * Rendered at 4x and downscaled on purpose. A badge digit drawn straight at
 * 32px is three pixels wide and reads as a smudge; the same glyph drawn at
 * 128px and resampled stays a number.
 */
function trayImage(size: number, badge: number): Electron.NativeImage {
  return nativeImage
    .createFromBuffer(waifuIconPng(size * 4, badge))
    .resize({ width: size, height: size })
}

function createTray(
  win: BrowserWindow,
  handlers: WindowHandlers,
  summon: (focus: boolean) => void,
  show: (focus: boolean) => void
): TrayHandle {
  const dead: TrayHandle = { tray: null, setBadge: () => {}, refresh: () => {} }
  try {
    const size = trayIconSize()
    const tray = new Tray(trayImage(size, 0))
    let badgeCount = 0
    if (isLinux) {
      // A Tray object is created even when no host will ever show it, so the
      // bus probe is the only way to tell the user why the icon is missing.
      logDesktop()
    }
    tray.setToolTip('CodeWaifu')

    const state = (): TrayMenuState => ({
      visible: !win.isDestroyed() && win.isVisible(),
      muted: handlers.isMuted(),
      bench: Boolean(handlers.onOpenBench && handlers.benchAvailable?.()),
      badge: badgeCount,
      lang: handlers.lang()
    })

    const run = (action: TrayAction): void => {
      const alive = !win.isDestroyed()
      switch (action) {
        case 'stage':
          if (alive) summon(true)
          break
        case 'hide':
          if (alive) win.hide()
          break
        case 'bench':
          handlers.onOpenBench?.()
          break
        case 'panel':
          if (!alive) break
          // The window may be hidden; opening the panel must reveal it too.
          show(true)
          win.webContents.send(IPC.openPanel)
          break
        case 'mute':
        case 'unmute':
          handlers.onToggleMute()
          break
        case 'hooks':
          handlers.onReinstallHooks()
          break
        case 'quit':
          handlers.onQuit()
          break
      }
    }

    const template = (current: TrayMenuState): Electron.MenuItemConstructorOptions[] =>
      trayMenu(current).map((entry) =>
        entry.kind === 'separator'
          ? { type: 'separator' as const }
          : { label: entry.label, click: () => run(entry.action) }
      )

    /*
     * `setContextMenu` publishes a menu over D-Bus; on Linux that publication
     * *is* the tray's behaviour, so it has to be redone whenever a label
     * changes rather than built on open. The memo is what makes that cheap:
     * appindicator re-registers the whole layout on every call, and a badge
     * tick during a busy hour would otherwise be hundreds of identical
     * registrations.
     */
    const interaction = trayInteraction(process.platform)
    let published = ''
    const refresh = (): void => {
      if (interaction !== 'menu') return
      const current = state()
      const key = trayMenuKey(current)
      if (key === published) return
      published = key
      try {
        tray.setContextMenu(Menu.buildFromTemplate(template(current)))
      } catch (error) {
        log('warn', 'tray menu failed', String(error))
      }
    }
    refresh()

    if (interaction === 'gesture') {
      /*
       * Left click is the summon gesture on mac and Windows: she appears on the
       * simple stage. A tray with `setContextMenu` makes macOS swallow the left
       * click into the menu, which put the full panel one mis-click away from a
       * casual click; popping the menu on right click only keeps the left click
       * for her. Linux gets neither handler: its host has no click event to
       * deliver and `popUpContextMenu` is a mac/Windows API, so the menu above
       * is the whole interaction.
       */
      tray.on('click', () => summon(true))
      tray.on('double-click', () => summon(true))
      tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate(template(state()))))
    } else {
      win.on('show', refresh)
      win.on('hide', refresh)
    }

    /**
     * One number, three renders: tray icon, tray tooltip, Bench header. The
     * icon is re-encoded rather than picked from cached variants because the
     * count is a range, not a set.
     */
    const setBadge = (count: number): void => {
      const next = Math.max(0, Math.trunc(Number(count)) || 0)
      if (next === badgeCount) return
      badgeCount = next
      try {
        tray.setImage(trayImage(size, next))
        tray.setToolTip(next > 0 ? `CodeWaifu - ${next} need you` : 'CodeWaifu')
        // macOS can put the number beside the icon as text, which is the only
        // tray badge readable at 22px; elsewhere the glyph carries it.
        if (isMac) tray.setTitle(next > 0 ? ` ${badgeDigits(next)}` : '')
      } catch (error) {
        log('warn', 'tray badge failed', String(error))
      }
      // The bench row carries the same count, so it is part of the menu's state.
      refresh()
    }
    return { tray, setBadge, refresh }
  } catch (error) {
    log('warn', 'tray unavailable (headless session?)', String(error))
    return dead
  }
}
