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
import { flightFrame, type FlightPoint } from '../../shared/benchFlight'

export interface BenchGeometry {
  width: number
  height: number
  /** -1 on either axis means "centre on the primary display". */
  x: number
  y: number
}

export interface BenchWindowDeps {
  geometry: () => BenchGeometry
  /**
   * Whether the window carries the system frame. Read at creation; when the
   * setting flips, main recreates the window rather than trying to re-frame a
   * live one, because Electron cannot change `frame` after the fact.
   */
  framed: () => boolean
  /** Persist a moved or resized frame. Called once per settle, not per pixel. */
  saveGeometry: (geometry: BenchGeometry) => void
  /**
   * Focus changed. The companion's summon policy reads this: an item that
   * arrives while the human is already looking at the fleet must not pop the
   * widget up over it.
   */
  onFocusChange: (focused: boolean) => void
  /**
   * The window came onto the screen or left it, from any path: this module's
   * show/hide, a flight landing, or the window manager doing it behind our
   * back. The stage's bench button is a switch and reads visibility, so a
   * switch that only updates on focus events can be pointing the wrong way.
   */
  onVisibility: (visible: boolean) => void
  /** The renderer is up. Replay a pending focus request into it. */
  onLoaded: () => void
  /** The window went away for real (quit), not merely hidden. */
  onClosed?: () => void
  /**
   * Where the flight comes from and goes to: the widget's centre, or `null`
   * when she is not on screen. The dart is the point of the animation - a
   * window that leaves toward nothing is a window that merely slid sideways.
   */
  anchor: () => FlightPoint | null
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
  /**
   * Show and hide with a short flight toward the widget, the "sucked in / spat
   * out" the stage button asks for. Both resolve once the window has settled,
   * and calling one while the other is mid-flight cancels the older flight, so
   * a human mashing the switch cannot strand the window in transit or left at
   * partial opacity.
   */
  showAnimated: () => Promise<void>
  hideAnimated: () => Promise<void>
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
    // Framed only when asked: the bench paints its own topbar, and a system bar
    // above it that carries nothing but the window name is dead chrome. The
    // frameless bench owns its chrome instead - topbar drags, its right end
    // minimises and closes, eight edge handles resize - so losing the WM frame
    // costs no gesture.
    frame: deps.framed(),
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
    // Mid-flight the frame is somewhere it was never meant to be saved: the
    // animation's whole effect is a temporary displacement. Writing it would
    // open the bench at the corner of a dart that finished a second ago.
    if (flying) return
    // A hidden frame belongs to the window manager, not to the human: GNOME
    // parks unmapped windows at its own slot and fires `move` for it, so
    // persisting that would reopen the bench where the WM put a corpse rather
    // than where the human left the window. The switch makes hide/show the
    // everyday path, so this is no longer a corner case.
    if (!win.isVisible()) return
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
  // Both fire from a flight landing and from the window manager hiding or
  // restoring the frame, which is the point: the switch reads whichever happened.
  win.on('show', () => deps.onVisibility(true))
  win.on('hide', () => deps.onVisibility(false))
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

  /*
   * The flight. It moves the frame and fades it; it never resizes it. A bounds
   * tween is the obvious way to draw "sucked in", and it is wrong here twice
   * over: every size change reflows the xterm instances inside (each reflow is
   * a PTY resize that redraws an agent's whole screen, so a 200ms animation
   * would cost a dozen redraws per pane), and `setOpacity` is documented to do
   * nothing on Linux, which is one of the three platforms this ships on. So the
   * motion is a translate toward the widget plus whatever fade the platform
   * gives us, and the numbers come from `shared/benchFlight.ts` where they are
   * testable.
   */
  const FLIGHT_MS = 200
  const STEP_MS = 16
  let flight: NodeJS.Timeout | null = null
  let flying = false
  /**
   * Where the window rests while a flight is running. Captured once per chain of
   * flights rather than per flight: a second press cancels the first mid-path,
   * and re-reading `getBounds()` then would adopt the displaced corner as the
   * resting one and walk the window a little further away every time.
   */
  let restCorner: FlightPoint | null = null
  /**
   * Resolves the flight in progress. Every way a flight can end goes through
   * this, because a caller awaiting `showAnimated` that is never settled is a
   * caller stuck behind an animation that is no longer running.
   */
  let settle: (() => void) | null = null

  const stopFlight = (): void => {
    if (flight) {
      clearInterval(flight)
      flight = null
    }
    flying = false
  }

  /**
   * Stop the running flight and settle whoever awaited it, without running its
   * `onDone`: "then hide the window" from a departure that was just cancelled by
   * an arrival is the wrong verb, and `show`/`hide` from the tray have no
   * business finishing an animation they interrupted.
   */
  const cancelFlight = (): void => {
    const pending = settle
    settle = null
    stopFlight()
    pending?.()
  }

  const setOpacity = (next: number): void => {
    if (!alive()) return
    try {
      win.setOpacity(next)
    } catch (error) {
      log('warn', 'bench setOpacity failed', String(error))
    }
  }

  const setPosition = (x: number, y: number): void => {
    if (!alive()) return
    try {
      win.setPosition(x, y, false)
    } catch (error) {
      log('warn', 'bench flight move failed', String(error))
      cancelFlight()
      setOpacity(1)
    }
  }

  /**
   * A maximised or full-screen window belongs to the window manager; moving it
   * is either ignored or, on some Linux compositors, un-maximises it. Those two
   * cases fall back to the plain show/hide, which is what a maximised window
   * did before there was an animation at all.
   */
  const canFly = (): boolean => alive() && !win.isMaximized() && !win.isFullScreen()

  /**
   * Run one flight and resolve when the frame is back where the human left it.
   * `direction: 'in'` is the arrival, `'out'` the departure; `onDone` runs once
   * the path has been walked, whether it finished or was cut short by a second
   * press or by the window going away.
   */
  const fly = (direction: 'in' | 'out', onDone: () => void): Promise<void> => {
    if (!canFly()) {
      // No path to walk: settle where we are rather than leave the caller's
      // promise open, and undo any pre-fade `showAnimated` already applied.
      if (alive()) setOpacity(1)
      onDone()
      return Promise.resolve()
    }
    // A press landing mid-flight wins outright. The resting corner is carried
    // over rather than re-read, because `getBounds()` mid-dart reports the
    // displacement and adopting it would walk the window further away on every
    // press.
    const displaced = flying ? restCorner : null
    cancelFlight()
    const bounds = win.getBounds()
    const rest: FlightPoint = displaced ?? { x: bounds.x, y: bounds.y }
    restCorner = rest
    let anchor: FlightPoint | null = null
    try {
      anchor = deps.anchor()
    } catch (error) {
      log('warn', 'bench flight anchor failed', String(error))
      anchor = null
    }
    const started = Date.now()
    flying = true
    return new Promise((resolve) => {
      settle = resolve
      const finish = (): void => {
        // Last frame is the resting corner at full opacity, whatever the clock
        // said: a flight that ends anywhere else leaves the window displaced.
        settle = null
        stopFlight()
        setPosition(rest.x, rest.y)
        setOpacity(1)
        restCorner = null
        onDone()
        resolve()
      }
      const step = (): void => {
        if (!alive()) {
          settle = null
          stopFlight()
          restCorner = null
          resolve()
          return
        }
        const t = Math.min(1, (Date.now() - started) / FLIGHT_MS)
        const frame = flightFrame({ rest, anchor }, t, direction)
        setPosition(frame.x, frame.y)
        setOpacity(frame.opacity)
        if (t >= 1) finish()
      }
      // The first frame is the launch, not the rest: without it an arrival
      // paints one frame of the window already home and the dart is gone.
      step()
      // `setPosition` throwing stops the flight from inside `step`; resolve so
      // the caller is not waiting on an animation that will never tick again.
      if (!flying) {
        restCorner = null
        resolve()
        return
      }
      flight = setInterval(step, STEP_MS)
      flight.unref?.()
    })
  }

  return {
    win,
    show(focus: boolean) {
      if (!alive()) return
      cancelFlight()
      if (win.isMinimized()) win.restore()
      win.show()
      if (focus) win.focus()
    },
    hide() {
      if (!alive() || !win.isVisible()) return
      cancelFlight()
      setOpacity(1)
      win.hide()
    },
    showAnimated() {
      if (!alive()) return Promise.resolve()
      if (win.isMinimized()) win.restore()
      // Spat out: launched at the far end of the path and (where the platform
      // allows it) transparent, so there is no flash of the resting frame.
      // Focus goes on straight away - a human just asked for this window, and
      // making them wait out a 200ms dart before they can type into it is a tax
      // on the animation rather than a benefit of it.
      // The pre-fade is only safe when a flight will actually run to undo it: a
      // maximised window takes the `canFly` bail-out below, and there the frame
      // would come up invisible and stay that way.
      if (canFly()) setOpacity(0)
      win.show()
      win.focus()
      return fly('in', () => undefined)
    },
    hideAnimated() {
      if (!alive() || !win.isVisible()) return Promise.resolve()
      if (!canFly()) {
        win.hide()
        return Promise.resolve()
      }
      // Sucked in: toward the widget that is about to be the only thing left on
      // screen saying what the fleet is doing.
      return fly('out', () => {
        if (alive() && win.isVisible()) win.hide()
      })
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
      cancelFlight()
      if (alive()) win.destroy()
    }
  }
}
