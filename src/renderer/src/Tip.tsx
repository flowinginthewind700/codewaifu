/**
 * The in-app tooltip, shared by the widget and the Bench.
 *
 * Every icon-only control used to answer "what is this?" with the native
 * `title` attribute: an OS-grey bubble that arrives a second after the hover
 * started, and in the transparent stage window frequently not at all. A row
 * of icons nobody can name is a row nobody clicks, so the chrome now owns
 * its tooltips: they appear fast (faster still when one was on screen a
 * moment ago), are painted from the same tokens as the surface under them,
 * flip when the window edge leaves no room, and carry the keycap when the
 * control owns a key.
 *
 * The bubble is portaled to `document.body` because half the bars that need
 * it sit inside `overflow: hidden` grid areas, and it is `pointer-events:
 * none` so it never joins the stage's click-through hit-testing or steals
 * the pointer from the control it describes.
 */
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
import { createPortal } from 'react-dom'

/** First hover in a while: long enough to not flicker on the way past. */
const COLD_MS = 420
/** Hover right after another tip hid: the eye is already reading, be quick. */
const WARM_MS = 90
/** How long after a tip hid the next hover still counts as warm. */
const WARM_WINDOW_MS = 900
const GAP = 7
const EDGE = 6

let lastHiddenAt = 0

interface Box {
  x: number
  y: number
  place: 'top' | 'bottom'
  arrow: number
}

export interface TipProps {
  label: string
  /** The control's key, painted as a keycap and announced to screen readers. */
  kbd?: string
  /** Preferred side; flipped when the viewport has no room there. */
  side?: 'top' | 'bottom'
  children: ReactElement
}

export function Tip({ label, kbd, side = 'bottom', children }: TipProps): ReactElement {
  const id = useId()
  const nodeRef = useRef<HTMLElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const shown = useRef(false)
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState<Box | null>(null)

  const clear = (): void => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current)
      timer.current = undefined
    }
  }

  const hide = (): void => {
    clear()
    if (shown.current) lastHiddenAt = Date.now()
    shown.current = false
    setOpen(false)
    setBox(null)
  }

  const show = (delay: number): void => {
    clear()
    timer.current = window.setTimeout(() => {
      shown.current = true
      setOpen(true)
    }, delay)
  }

  useEffect(() => clear, [])

  // While a tip is on screen, anything that means "the pointer's story
  // changed" takes it down: a click (a menu may open under the bubble),
  // Escape, or the window losing focus.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide()
    }
    const away = (): void => hide()
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', away)
    window.addEventListener('blur', away)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', away)
      window.removeEventListener('blur', away)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Measured after mount, before paint: the bubble renders off-screen for one
  // layout pass so its real size can pick the side and the clamp, and nobody
  // ever sees it parked at the origin.
  useLayoutEffect(() => {
    if (!open) return
    const node = nodeRef.current
    const tip = tipRef.current
    if (!node || !tip) return
    const place = (): void => {
      const rect = node.getBoundingClientRect()
      const w = tip.offsetWidth
      const h = tip.offsetHeight
      let where: 'top' | 'bottom' = side
      let y = rect.bottom + GAP
      if (side === 'bottom' && y + h > window.innerHeight - EDGE) {
        y = rect.top - GAP - h
        where = 'top'
      } else if (side === 'top' && rect.top - GAP - h < EDGE) {
        y = rect.bottom + GAP
        where = 'bottom'
      }
      const center = rect.left + rect.width / 2
      const x = Math.min(
        Math.max(center - w / 2, EDGE),
        Math.max(EDGE, window.innerWidth - w - EDGE)
      )
      setBox({ x, y, place: where, arrow: Math.min(Math.max(center - x, 10), Math.max(10, w - 10)) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, side])

  if (!isValidElement(children)) return children

  // The trigger can be any host control (button, label, select), so the props
  // are read and written through a wide record rather than one element type.
  const child = children as ReactElement<Record<string, unknown> & { ref?: unknown }>
  const own = child.props as {
    ref?: unknown
    onMouseEnter?: (event: { target?: EventTarget | null }) => void
    onMouseLeave?: (event: { target?: EventTarget | null }) => void
    onFocus?: (event: { target?: EventTarget | null }) => void
    onBlur?: (event: { target?: EventTarget | null }) => void
  }
  const prevRef = own.ref
  // The trigger may already own a handler; a tooltip must never eat one.
  const through =
    <E,>(mine: (event: E) => void, theirs: ((event: E) => void) | undefined) =>
    (event: E): void => {
      mine(event)
      theirs?.(event)
    }

  return (
    <>
      {cloneElement(child, {
        ref: (node: HTMLElement | null) => {
          nodeRef.current = node
          if (typeof prevRef === 'function') (prevRef as (node: HTMLElement | null) => void)(node)
          else if (prevRef && typeof prevRef === 'object')
            (prevRef as { current: HTMLElement | null }).current = node
        },
        'aria-describedby': open ? id : undefined,
        'aria-keyshortcuts': kbd,
        onMouseEnter: through(
          () => show(Date.now() - lastHiddenAt < WARM_WINDOW_MS ? WARM_MS : COLD_MS),
          own.onMouseEnter
        ),
        onMouseLeave: through(hide, own.onMouseLeave),
        onFocus: through((event: { target?: EventTarget | null }) => {
          // Keyboard arrival shows the tip at once; a click that merely
          // focuses must not, or every click would flash a bubble over work.
          const el = event.target as HTMLElement | null
          let byKeyboard = true
          try {
            byKeyboard = el?.matches(':focus-visible') ?? true
          } catch {
            byKeyboard = true
          }
          if (byKeyboard) show(0)
        }, own.onFocus),
        onBlur: through(hide, own.onBlur)
      })}
      {open
        ? createPortal(
            <div
              ref={tipRef}
              id={id}
              role="tooltip"
              className="tip"
              data-place={box?.place ?? side}
              style={
                {
                  left: box ? `${box.x}px` : '-9999px',
                  top: box ? `${box.y}px` : '-9999px',
                  visibility: box ? 'visible' : 'hidden',
                  '--tip-arrow': `${box?.arrow ?? 12}px`
                } as CSSProperties
              }
            >
              <span className="tip-label">{label}</span>
              {kbd ? <kbd className="tip-kbd">{kbd}</kbd> : null}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
