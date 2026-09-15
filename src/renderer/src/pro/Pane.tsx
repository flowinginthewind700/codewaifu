/**
 * One rented terminal (F4).
 *
 * The pane does not own its PTY. herdr does, through
 * `herdr terminal session control <pane>`, and main hands us base64 ANSI frames
 * over `cw-pro:frames`. Three consequences shape this file:
 *
 * - Frames never enter React state. They go from the IPC listener straight into
 *   `term.write` via the pane bus, so a chatty build cannot re-render the tree.
 * - The decoder is per pane and streaming. A multi-byte UTF-8 character split
 *   across two frames would otherwise render as two replacement characters, and
 *   `full:true` is the only moment we reset it (a full repaint starts a new
 *   byte stream).
 * - Unmounting releases the bridge, and releasing the bridge kills nothing. The
 *   agent keeps running in herdr; we only stop paying for its output.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { Crosshair, Maximize2, Minimize2, Plug, PlugZap } from 'lucide-react'
import type { PaneView } from '@shared/pro'
import type { ProBridgePush, ProFramePush } from '@shared/proIpc'
import { proApi } from './api'
import { fill, type Translate } from './i18n'
import { bridgeOf, registerPane } from './paneBus'
import type { Tone } from './toast'

/** The bench's terminal palette: the shared accents, mapped onto ANSI. */
const THEME = {
  background: '#0f0d14',
  foreground: '#e6e0ef',
  cursor: '#ff7d96',
  cursorAccent: '#14121a',
  selectionBackground: 'rgba(255,125,150,0.3)',
  selectionInactiveBackground: 'rgba(255,255,255,0.12)',
  black: '#241f2e',
  red: '#ff6b81',
  green: '#59d7b3',
  yellow: '#f5b45c',
  blue: '#82aaff',
  magenta: '#ff7d96',
  cyan: '#7fd4e8',
  white: '#d9d2e3',
  brightBlack: '#5b5268',
  brightRed: '#ff8b9c',
  brightGreen: '#7ce3c5',
  brightYellow: '#f8c781',
  brightBlue: '#9dbcff',
  brightMagenta: '#ff9cae',
  brightCyan: '#a0e2f0',
  brightWhite: '#f4eff8'
}

/** base64 -> bytes. `atob` is Latin-1, so every char becomes exactly one byte. */
function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

export interface PaneProps {
  pane: PaneView
  active: boolean
  zoomed: boolean
  t: Translate
  onSelect: (paneId: string) => void
  onZoom: (paneId: string) => void
  onNotify: (text: string, tone?: Tone) => void
}

const PHASE_KEYS = {
  idle: 'phaseIdle',
  starting: 'phaseStarting',
  live: 'phaseLive',
  respawning: 'phaseRespawning',
  closed: 'phaseClosed',
  error: 'phaseError'
} as const

/** Agent colour classes, matching the widget's thread list. */
function agentClass(agent: string): string {
  const key = String(agent || '').toLowerCase()
  if (key.includes('codex')) return 'codex'
  if (key.includes('claude')) return 'claude'
  return ''
}

export function Pane({
  pane,
  active,
  zoomed,
  t,
  onSelect,
  onZoom,
  onNotify
}: PaneProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const sizeRef = useRef({ cols: 0, rows: 0 })
  const [phase, setPhase] = useState<ProBridgePush['phase']>(bridgeOf(pane.paneId)?.phase ?? 'idle')
  const [dropped, setDropped] = useState(0)
  const [error, setError] = useState('')
  /** True when the human released this pane on purpose; no auto re-attach. */
  const [released, setReleased] = useState(false)

  const paneId = pane.paneId

  useEffect(() => {
    const host = hostRef.current
    if (!host || released) return

    const term = new Terminal({
      fontFamily: 'var(--mono)',
      fontSize: 12.5,
      lineHeight: 1.22,
      cursorBlink: true,
      scrollback: 4000,
      allowProposedApi: false,
      theme: THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term

    // One streaming decoder per pane, reset whenever herdr sends a full frame.
    let decoder = new TextDecoder('utf-8', { fatal: false })

    const measure = (): void => {
      try {
        fit.fit()
      } catch {
        // A zero-size container throws; the ResizeObserver below retries.
        return
      }
      const { cols, rows } = term
      if (!cols || !rows) return
      const prev = sizeRef.current
      sizeRef.current = { cols, rows }
      if (prev.cols === cols && prev.rows === rows) return
      // Only a *changed* size is worth a round trip: herdr relays it to the PTY,
      // and a resize storm reflows the agent's whole screen each time.
      void proApi.pane.resize(paneId, cols, rows).then((result) => {
        if (!result.ok && prev.cols) onNotify(result.detail || t('phaseError'), 'error')
      })
    }

    measure()
    const unsub = registerPane(paneId, {
      frame(frame: ProFramePush): void {
        if (frame.full) {
          decoder = new TextDecoder('utf-8', { fatal: false })
          term.reset()
        }
        if (frame.bytes) term.write(decoder.decode(b64ToBytes(frame.bytes), { stream: !frame.full }))
      },
      bridge(push: ProBridgePush): void {
        setPhase(push.phase)
        setDropped(push.dropped)
        setError(push.error)
        // herdr may have resized the PTY under us while we were away.
        if (push.phase === 'live' && push.cols && push.rows) measure()
      }
    })

    const dataSub = term.onData((text) => {
      void proApi.pane.input(paneId, text)
    })

    // Debounced: a window drag fires dozens of resize events, and each fit is a
    // layout pass over the whole scrollback viewport.
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(measure, 70)
    })
    observer.observe(host)

    void proApi.pane
      .attach(paneId, sizeRef.current.cols || 80, sizeRef.current.rows || 24)
      .then((result) => {
        if (!result.ok) onNotify(result.detail || t('phaseError'), 'error')
      })

    return () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
      unsub()
      dataSub.dispose()
      termRef.current = null
      term.dispose()
      void proApi.pane.detach(paneId)
    }
    // `active` and `zoomed` are read by the parent's CSS, not by us: re-running
    // this effect on a selection change would detach and repaint for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, released])

  const release = useCallback(() => {
    setReleased(true)
    setPhase('idle')
  }, [])

  const label = pane.title || pane.cwd || pane.paneId
  const live = phase === 'live'
  const agent = pane.displayAgent || pane.agent || 'sh'

  return (
    <section
      className="pane"
      data-active={active}
      data-zoom-hidden={zoomed && !active}
      onMouseDown={() => onSelect(paneId)}
    >
      <header className="pane-head">
        <span className={`tag ${agentClass(agent)}`.trim()}>{agent}</span>
        <span className="pane-title" title={label}>
          {label}
        </span>
        <span className="pane-flag" data-live={live} data-phase={phase} title={error || undefined}>
          {dropped > 0 && <span>{fill(t, 'droppedFrames', { n: dropped })}</span>}
          <span>{t(PHASE_KEYS[phase] ?? 'phaseIdle')}</span>
        </span>
        <button
          type="button"
          className="btn icon ghost"
          title={t('paneFocusHerdr')}
          aria-label={t('paneFocusHerdr')}
          onClick={() => void proApi.pane.focus(paneId)}
        >
          <Crosshair />
        </button>
        <button
          type="button"
          className="btn icon ghost"
          title={zoomed ? t('paneZoomOff') : t('paneZoomOn')}
          aria-label={zoomed ? t('paneZoomOff') : t('paneZoomOn')}
          onClick={() => onZoom(paneId)}
        >
          {zoomed ? <Minimize2 /> : <Maximize2 />}
        </button>
        <button
          type="button"
          className="btn icon ghost"
          title={released ? t('verbAttach') : t('paneDetach')}
          aria-label={released ? t('verbAttach') : t('paneDetach')}
          onClick={() => (released ? setReleased(false) : release())}
        >
          {released ? <Plug /> : <PlugZap />}
        </button>
      </header>
      <div className="pane-body" ref={hostRef} />
      {released && (
        <div className="pane-overlay">
          <span>{t('paneDetachedNote')}</span>
          <button type="button" className="btn" onClick={() => setReleased(false)}>
            <Plug />
            {t('verbAttach')}
          </button>
        </div>
      )}
      {phase === 'error' && error && (
        <div className="pane-overlay">
          <span>{error}</span>
          <button type="button" className="btn" onClick={() => setReleased(false)}>
            {t('installRetry')}
          </button>
        </div>
      )}
    </section>
  )
}
