// ============================================================
// The Live2D companion, ported from robotworld's AvatarStage.
//
// Three jobs, same as the web version: assemble the model onto a canvas, feed
// the TTS level into her mouth, and tell the truth about downloading / failing
// / losing the GL context. Three things are different because this canvas lives
// in a frameless window instead of a page:
//
//   * Dragging her moves the window. A CSS `app-region: drag` region cannot be
//     used here — it would swallow the pointer events that tapping her
//     expressions needs — so the drag is done in JS over `IPC.moveWindow`.
//   * The audio level comes from the widget's own Web Audio graph
//     (`widgetVoice`), which is the only place an analyser can sit.
//   * The box she stands in is invisible and still catches the pointer, so it
//     shows itself as glass wherever the pointer is (see stageVeil.ts). On the
//     web the page underneath is the answer to "what did my click hit"; in a
//     transparent frameless window the answer is nothing, and nothing reads as
//     a frozen app.
//
// This module pulls in host.ts -> the vendored Cubism framework (~720KB), so
// App.tsx reaches it through React.lazy and the first bundle stays small.
// ============================================================
import { memo, useEffect, useRef, useState, type ReactElement } from 'react'
import { characterTotalBytes, findCharacter, prefetchCharacter } from './live2d/assets'
import { Live2DHost } from './live2d/host'
import { stageCanvasKey } from './live2d/stage'
import { api } from './api'
import { attachStageVeil } from './stageVeil'
import type { Translate } from './i18n'
import { widgetVoice } from './voice'
import type { Live2DCharacter } from '@shared/live2dCatalog'

type Status = 'loading' | 'ready' | 'error'

/**
 * Pixels of pointer travel before a press becomes a window drag. host.ts calls
// anything under 12px a tap, so this sits just above it: a tap always reaches
// her, a drag always moves the window, and neither eats the other.
 */
const DRAG_THRESHOLD = 14

/** What the parent gets once she is on screen: enough to make her react. */
export interface AvatarHandle {
  host: Live2DHost
  character: Live2DCharacter
}

interface Props {
  characterId: string
  t: Translate
  /** Mouth gain; undefined uses lip.ts's default. */
  lipGain?: number
  /** Stop the frame loop (widget hidden, panel closed, display asleep). */
  paused?: boolean
  /** Called once the first frame paints, and with null on teardown. */
  onHostChange?: (handle: AvatarHandle | null) => void
}

function Live2DAvatarBase({ characterId, t, lipGain, paused = false, onHostChange }: Props): ReactElement {
  const character = findCharacter(characterId)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<Live2DHost | null>(null)
  const hostChangeRef = useRef(onHostChange)
  const pausedRef = useRef(paused)
  hostChangeRef.current = onHostChange
  pausedRef.current = paused

  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [progress, setProgress] = useState(() => ({ loaded: 0, total: character ? characterTotalBytes(character) : 0 }))

  /* ---- assemble the model ---------------------------------------------- */
  useEffect(() => {
    if (!character) {
      setError(`unknown character: ${characterId}`)
      setStatus('error')
      return
    }
    let cancelled = false
    let created: Live2DHost | null = null
    setStatus('loading')
    setError(null)
    setProgress({ loaded: 0, total: characterTotalBytes(character) })
    void (async () => {
      try {
        // Prefetch and assembly share one asset cache, so a warm start runs the
        // bar to 100% instantly instead of pretending to download.
        await prefetchCharacter(character, (next) => {
          if (!cancelled) setProgress(next)
        })
        if (cancelled) return
        const canvas = canvasRef.current
        if (!canvas) throw new Error('canvas is not mounted')
        created = await Live2DHost.create({
          canvas,
          character,
          lipGain,
          getAudioLevel: () => widgetVoice.getLevel(),
          onFirstFrame: () => {
            if (!cancelled) setStatus('ready')
          },
          onFatal: (fatal) => {
            if (cancelled) return
            setError(fatal.message)
            setStatus('error')
          }
        })
        if (cancelled) {
          created.release()
          return
        }
        hostRef.current = created
        if (pausedRef.current) created.setPaused(true)
        hostChangeRef.current?.({ host: created, character })
      } catch (cause) {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setStatus('error')
      }
    })()
    return () => {
      cancelled = true
      const host = hostRef.current
      hostRef.current = null
      hostChangeRef.current?.(null)
      host?.release()
    }
    // getAudioLevel and onHostChange are read through refs: otherwise every
    // parent render would tear down and rebuild the model.
  }, [character, characterId, attempt, lipGain])

  /* ---- stop drawing while nobody can see her ----------------------------
     Not before the first frame, though: `onFirstFrame` is the only readiness
     signal, so pausing early would wedge the widget in its loading state. */
  useEffect(() => {
    hostRef.current?.setPaused(status === 'ready' ? paused : false)
  }, [paused, status])

  useEffect(() => {
    const onVisibility = (): void => {
      if (status !== 'ready') return
      hostRef.current?.setPaused(pausedRef.current || document.hidden)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [status])

  /* ---- drag the window by her -------------------------------------------
     The pointer sequence is shared with host.ts (it listens on the canvas for
     the same events, and they bubble here). Under the threshold we stay out of
     the way so her head can follow the cursor and a quick release registers as
     a tap. Past it we take over: ask host to drop the pointer (which also
     releases the canvas capture) so it neither follows the cursor nor fires a
     tap, then move the frame by screen deltas.

     ⛔ The handover must not be a synthetic `pointercancel` on the canvas.
     This effect listens for `pointercancel` on `window`, so the event it
     dispatches lands in its own `onUp`: the drag ended after one frame of
     follow-through and the window felt immovable. `host.cancelPointer()` is
     the same state change without the DOM round trip. */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let pointerId: number | null = null
    let lastX = 0
    let lastY = 0
    let startX = 0
    let startY = 0
    let dragging = false
    let pendingX = 0
    let pendingY = 0
    let frame = 0

    const flush = (): void => {
      frame = 0
      const dx = pendingX
      const dy = pendingY
      pendingX = 0
      pendingY = 0
      if (dx || dy) void api.moveWindow(dx, dy)
    }

    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0 || pointerId !== null) return
      pointerId = event.pointerId
      startX = event.screenX
      startY = event.screenY
      lastX = event.screenX
      lastY = event.screenY
      dragging = false
    }

    const onMove = (event: PointerEvent): void => {
      if (pointerId === null || event.pointerId !== pointerId) return
      const dx = event.screenX - lastX
      const dy = event.screenY - lastY
      lastX = event.screenX
      lastY = event.screenY
      if (!dragging) {
        const travelled = Math.hypot(event.screenX - startX, event.screenY - startY)
        if (travelled < DRAG_THRESHOLD) return
        dragging = true
        hostRef.current?.cancelPointer()
        try {
          stage.setPointerCapture(event.pointerId)
        } catch {
          /* capture is a nicety; deltas still arrive while the button is down */
        }
      }
      // One IPC per animation frame, not per pointer event: a 120Hz trackpad
      // would otherwise queue hundreds of setBounds calls mid-drag.
      pendingX += dx
      pendingY += dy
      if (!frame) frame = window.requestAnimationFrame(flush)
    }

    const onUp = (event: PointerEvent): void => {
      if (pointerId === null || event.pointerId !== pointerId) return
      pointerId = null
      dragging = false
      if (frame) {
        window.cancelAnimationFrame(frame)
        frame = 0
      }
      flush()
      try {
        stage.releasePointerCapture(event.pointerId)
      } catch {
        /* already released */
      }
    }

    stage.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      stage.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (frame) window.cancelAnimationFrame(frame)
      if (pendingX || pendingY) void api.moveWindow(pendingX, pendingY)
    }
  }, [])

  /**
   * The glass that answers the pointer. Detached on unmount along with every
   * other listener; nothing here touches React state, so a mouse move costs a
   * style write on one element and not a render of the avatar tree.
   */
  useEffect(() => attachStageVeil(stageRef.current), [])

  const total = progress.total
  const pct = total > 0 ? Math.min(100, Math.round((progress.loaded / total) * 100)) : 0
  const fromCache = status === 'loading' && pct >= 100
  const mb = (n: number): string => (n / 1e6).toFixed(1)

  return (
    <div className="l2d" ref={stageRef} data-status={status} data-solid="1">
      {/* The canvas always takes part in layout: `display:none` would zero its
          clientWidth and the projection matrix would divide by it. The key
          carries the character id *and* the attempt count, because releasing a
          host calls WEBGL_lose_context — reusing that canvas would hand the
          next host a dead context and the retry button would spin forever. */}
      <canvas
        key={stageCanvasKey(characterId, attempt)}
        ref={canvasRef}
        className="l2d-canvas"
        data-testid="live2d-canvas"
        style={{ opacity: status === 'ready' ? 1 : 0 }}
      />
      {status !== 'ready' ? (
        <div className="l2d-veil">
          {status === 'loading' ? (
            <div className="l2d-loading">
              <span className="l2d-spin" aria-hidden="true" />
              <span className="l2d-label">{fromCache ? t('l2dCached') : t('l2dPreparing')}</span>
              <span className="l2d-track">
                <span className="l2d-fill" style={{ width: `${pct}%` }} />
              </span>
              <span className="l2d-bytes">
                {mb(progress.loaded)} / {mb(total)} MB · {pct}%
              </span>
              {character && !fromCache ? (
                <span className="l2d-note">{t('l2dFirstRun').replace('{mb}', mb(character.bytes))}</span>
              ) : null}
            </div>
          ) : (
            <div className="l2d-failed">
              <span className="l2d-failed-title">{t('l2dFailed')}</span>
              {error ? <span className="l2d-error">{error}</span> : null}
              <button className="l2d-retry" type="button" data-testid="live2d-retry" onClick={() => setAttempt((n) => n + 1)}>
                {t('l2dRetry')}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** Dragging and resizing re-render the parent every frame; keep her out of it. */
export const Live2DAvatar = memo(Live2DAvatarBase)
