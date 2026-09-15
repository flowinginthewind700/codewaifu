import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
import { ChevronsUpDown, EyeOff, Volume2, VolumeX } from 'lucide-react'
import { DEFAULT_CONFIG, type ConfigPatch } from '@shared/config'
import { EMPTY_MEDIA, MEDIA_UI_ENABLED, type MediaCommand, type MediaState } from '@shared/media'
import { composeStatusReport } from '@shared/report'
import type {
  EventKind,
  EventPlan,
  HookEvent,
  Lang,
  NeuralStatus,
  RedactedConfig,
  RelayStatus,
  RuntimeState,
  SteerResult,
  ThreadInfo,
  UiSnapshot
} from '@shared/protocol'
import {
  WINDOW_PADDING,
  expressionForKind,
  panelHeight,
  stageHeight,
  widgetView,
  type BubbleMessage,
  type PanelTab
} from '@shared/ui'
import { resolveUiLang } from '@shared/lang'
import { expressionForMood } from '@shared/live2dMood'
import type { Live2DMotionRef } from '@shared/live2dCatalog'
import type { RegionRect } from '@shared/linuxRuntime'
import { api, CH, platform } from './api'
import { Avatar } from './Avatar'
import { Bubble } from './Bubble'
import { makeTranslator, type Translate } from './i18n'
import { MediaBar } from './MediaBar'
import { Panel } from './Panel'
import { StageTools } from './StageTools'
import { widgetVoice } from './voice'
import type { AvatarHandle } from './Live2DAvatar'

/**
 * The Live2D runtime pulls in the vendored Cubism framework (~720KB), so it is
 * split out of the first bundle: the widget paints its chrome immediately and
 * she arrives a moment later, from disk cache on every run after the first.
 */
const Live2DAvatar = lazy(() =>
  import('./Live2DAvatar').then((module) => ({ default: module.Live2DAvatar }))
)

const THREAD_POLL_MS = 8000
/** How often Linux re-measures its solid boxes (see the shape reporter below). */
const SOLID_POLL_MS = 200
const TOAST_MS = 4200
/** Events worth a gesture, not just a face. */
const GESTURE_KINDS: ReadonlySet<string> = new Set(['stop', 'session_start', 'permission'])

/** Per-line hold for the status report bubble: it is read, not glanced at. */
const REPORT_MS_PER_LINE = 2600
/** How long a hand-picked face wins over the event-driven mood. */
const MANUAL_FACE_MS = 8000

/**
 * OS language as the renderer can see it, used only for the frames before
 * main's snapshot lands so the first paint is not a flash of the wrong
 * language. Main's value wins as soon as it arrives.
 */
function browserLang(): Lang {
  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function App(): ReactElement {
  const [config, setConfig] = useState<RedactedConfig | null>(null)
  const [runtime, setRuntime] = useState<RuntimeState | null>(null)
  const [events, setEvents] = useState<HookEvent[]>([])
  const [media, setMedia] = useState<MediaState>(EMPTY_MEDIA)
  const [threads, setThreads] = useState<ThreadInfo[]>([])
  const [bubble, setBubble] = useState<BubbleMessage | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [speaking, setSpeaking] = useState(false)
  const [queueLength, setQueueLength] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<PanelTab>('threads')
  const [lastKind, setLastKind] = useState<EventKind | 'other'>('other')
  /** Thread drilled into in the chat view; null = tabbed panel. */
  const [chatThread, setChatThread] = useState<ThreadInfo | null>(null)
  /** Live2D runtime, once her first frame has painted. */
  const [avatar, setAvatar] = useState<AvatarHandle | null>(null)

  const bubbleTimer = useRef<number | null>(null)
  const toastTimer = useRef<number | null>(null)
  const clickThrough = useRef(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  /** Mirror of `avatar` for listeners that must not resubscribe on every build. */
  const avatarRef = useRef<AvatarHandle | null>(null)
  /** Deadline until a face you picked by hand outranks the event mood. */
  const manualFaceUntil = useRef(0)

  const onAvatarHost = useCallback((handle: AvatarHandle | null) => {
    avatarRef.current = handle
    setAvatar(handle)
  }, [])

  /**
   * Interface language. `uiLang: 'auto'` follows the OS, which main resolves
   * from `app.getPreferredSystemLanguages()`. Independent of `config.lang`,
   * which decides what voice a notice is *spoken* in.
   */
  const lang = resolveUiLang(config?.uiLang ?? 'auto', runtime?.systemLang ?? browserLang())
  const t: Translate = useMemo(() => makeTranslator(lang), [lang])

  const showBubble = useCallback((message: BubbleMessage, holdMs: number) => {
    setBubble(message)
    if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current)
    bubbleTimer.current = window.setTimeout(() => setBubble(null), Math.max(1200, holdMs))
  }, [])

  const notice = useCallback((text: string) => {
    if (!text) return
    setToast(text)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  /* ---- initial snapshot ------------------------------------------------ */
  useEffect(() => {
    let alive = true
    void api.state().then((snapshot: UiSnapshot) => {
      if (!alive) return
      setConfig(snapshot.config)
      setRuntime(snapshot.runtime)
      setEvents(snapshot.events)
      setMedia(snapshot.media)
      setSpeaking(snapshot.runtime.speaking)
      setQueueLength(snapshot.runtime.queueLength)
    })
    return () => {
      alive = false
    }
  }, [])

  /* ---- hotkey guard -----------------------------------------------------
   * While a non-empty input of ours holds focus, the system-wide summon
   * shortcut must stay idle: the user is mid-sentence and the window must not
   * move under their hands. Reported on change only. */
  useEffect(() => {
    let active = false
    const compute = (): void => {
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null
      const isField = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      const next = isField && (el.value ?? '').length > 0
      if (next === active) return
      active = next
      void api.invoke(CH.inputActive, next)
    }
    window.addEventListener('focusin', compute)
    window.addEventListener('focusout', compute)
    window.addEventListener('input', compute, true)
    compute()
    return () => {
      window.removeEventListener('focusin', compute)
      window.removeEventListener('focusout', compute)
      window.removeEventListener('input', compute, true)
    }
  }, [])

  /* ---- main -> renderer pushes ---------------------------------------- */
  useEffect(() => {
    const offs = [
      api.on(CH.pushEvent, (payload) => {
        const plan = payload as EventPlan
        if (!plan?.event) return
        setEvents((prev) => [plan.event, ...prev].slice(0, 200))
        setLastKind(plan.event.kind)
        // A gesture on the beats that matter; her face is handled separately so
        // it also tracks `speaking`.
        const live2d = avatarRef.current
        if (live2d && GESTURE_KINDS.has(plan.event.kind)) {
          try {
            live2d.host.playMotion()
          } catch {
            /* the model can be mid-rebuild; a missed wave is not an error */
          }
        }
        if (plan.speak && plan.text) {
          showBubble(
            {
              id: plan.event.id,
              text: plan.text,
              lang: plan.lang,
              agent: plan.event.agent,
              kind: plan.event.kind,
              at: plan.event.at
            },
            config?.bubbleMs ?? 7000
          )
        }
      }),
      api.on(CH.pushSpeaking, (payload) => {
        const state = payload as { speaking?: boolean; queueLength?: number }
        setSpeaking(Boolean(state?.speaking))
        setQueueLength(Number(state?.queueLength) || 0)
      }),
      api.on(CH.pushConfig, (payload) => setConfig(payload as RedactedConfig)),
      api.on(CH.pushMedia, (payload) => setMedia((payload as MediaState) || EMPTY_MEDIA)),
      api.on(CH.pushBubble, (payload) => {
        const message = payload as BubbleMessage
        if (message?.text) showBubble(message, config?.bubbleMs ?? 7000)
      }),
      api.on(CH.pushRelay, (payload) => {
        const relay = payload as RelayStatus
        if (!relay) return
        setRuntime((prev) => (prev ? { ...prev, relay } : prev))
      }),
      api.on(CH.pushNeural, (payload) => {
        const neural = payload as NeuralStatus
        if (!neural?.phase) return
        setRuntime((prev) => (prev ? { ...prev, neural } : prev))
      }),
      api.on(CH.pushExpanded, (payload) => setExpanded(Boolean(payload))),
      api.on(CH.openPanel, () => {
        setExpanded(true)
        void api.setExpanded(true)
      })
    ]
    return () => offs.forEach((off) => off())
    // `config.bubbleMs` is read inside the listeners; resubscribing on every
    // slider tick would drop pushes mid-flight, so the ref-free read is fine
    // because a stale hold time is harmless.
  }, [showBubble, config?.bubbleMs])

  /* ---- click-through: only the card catches the pointer ---------------- */
  useEffect(() => {
    // Linux is exempt on purpose: forwarding mouse events through a
    // click-through window is `@platform darwin,win32`, so a window we made
    // click-through there would never hear the pointer come back over the card
    // and would stay unclickable until the app restarted. Main shapes the
    // window's input region instead, fed by the reporter below.
    if (platform === 'linux') return
    const onMove = (event: globalThis.MouseEvent): void => {
      const target = event.target as Element | null
      const solid = Boolean(target?.closest?.('[data-solid]'))
      if (solid === !clickThrough.current) return
      clickThrough.current = !solid
      void api.setClickThrough(!solid)
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  /* ---- Linux: hand main the part of the frame that is really ours -------
     `getBoundingClientRect()` is CSS pixels, and a frameless Electron window
     maps CSS pixels 1:1 onto the device-independent pixels `setShape` wants,
     so viewport-relative boxes are already window-relative.

     Polled rather than observed because the boxes come from a dozen components
     (card, panel, stage tools, bubble, the Live2D canvas, toasts) and none of
     them announce themselves. 200ms is comfortably inside a bubble's fade-in,
     and the key string keeps an unchanged layout from costing an IPC round
     trip five times a second for the life of the process. */
  useEffect(() => {
    if (platform !== 'linux') return
    let last = ''
    const report = (): void => {
      const rects: RegionRect[] = []
      for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-solid]'))) {
        const box = node.getBoundingClientRect()
        // A display:none branch measures 0x0; shaping the window to that would
        // hide her, so collapsed elements are simply not part of the region.
        if (!(box.width > 0) || !(box.height > 0)) continue
        rects.push({ x: box.left, y: box.top, width: box.width, height: box.height })
      }
      const key = rects
        .map((rect) => `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`)
        .join(';')
      if (key === last) return
      last = key
      void api.setSolidRegion(rects)
    }
    const timer = window.setInterval(report, SOLID_POLL_MS)
    window.addEventListener('resize', report)
    report()
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('resize', report)
    }
  }, [])

  /* ---- the widget owns the audible path --------------------------------
     Her mouth is driven by an analyser, and an analyser can only sit in this
     process's Web Audio graph. Main renders the WAV and streams it here, then
     waits for the per-line ack before it advances its queue. */
  useEffect(() => {
    widgetVoice.attach()
    return () => widgetVoice.detach()
  }, [])

  /* ---- the frame is exactly as tall as the card ------------------------
     Main sizes the window from `estimatedHeight` until we report a real
     measurement. The card's height is content-driven (stage height from
     shared/ui plus the fixed panel height), never window-driven, so this
     converges instead of feeding itself. */
  useEffect(() => {
    const card = cardRef.current
    if (!card || typeof ResizeObserver !== 'function') return
    let frame = 0
    let last = 0
    const report = (): void => {
      frame = 0
      const height = Math.round(card.offsetHeight + WINDOW_PADDING * 2)
      if (!Number.isFinite(height) || Math.abs(height - last) < 2) return
      last = height
      void api.invoke(CH.fitHeight, height)
    }
    const observer = new ResizeObserver(() => {
      if (frame) return
      frame = window.requestAnimationFrame(report)
    })
    observer.observe(card)
    report()
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  /* ---- her face follows the event -------------------------------------- */
  useEffect(() => {
    if (!avatar) return
    // A face picked from the stage tools wins for a few seconds; without this
    // the next `speaking` tick would wipe it before you saw it change.
    if (Date.now() < manualFaceUntil.current) return
    const name = expressionForMood(avatar.character, expressionForKind(lastKind, speaking))
    if (!name) return
    try {
      avatar.host.setExpression(name)
    } catch {
      /* model released between the render and this effect */
    }
  }, [avatar, lastKind, speaking])

  /* ---- threads: refresh while the panel is open, and after any event ----
     The chat view reads this too — it is where the "live" dot and the fast
     transcript poll rate come from. */
  useEffect(() => {
    if (!expanded) return
    let alive = true
    const load = (): void => {
      void api.threads().then((list) => {
        if (!alive) return
        setThreads(list)
        // Follow the open thread so a session that ends stops fast-polling.
        setChatThread((current) => {
          if (!current) return current
          const next = list.find((thread) => thread.key === current.key)
          return next && next.live !== current.live ? { ...current, live: next.live, title: next.title || current.title } : current
        })
      })
    }
    load()
    const timer = window.setInterval(load, THREAD_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [expanded, events.length])

  /* ---- voice list only matters while Settings is open ------------------ */
  useEffect(() => {
    if (!expanded || tab !== 'settings') return
    let alive = true
    void api.voices().then((voices) => {
      if (alive) setRuntime((prev) => (prev ? { ...prev, voices } : prev))
    })
    return () => {
      alive = false
    }
  }, [expanded, tab])

  useEffect(() => {
    return () => {
      if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current)
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [])

  /* ---- actions --------------------------------------------------------- */
  const patch = useCallback(async (next: ConfigPatch) => {
    setConfig((prev) => (prev ? ({ ...prev, ...next } as RedactedConfig) : prev))
    const result = await api.setConfig(next)
    if (result?.config) setConfig(result.config)
    if (result?.relay) setRuntime((prev) => (prev ? { ...prev, relay: result.relay } : prev))
  }, [])

  const onMediaCommand = useCallback(async (command: MediaCommand) => {
    const state = await api.mediaCommand(command)
    if (state) setMedia(state)
  }, [])

  /**
   * 「汇报一下现在的 coding 状态」 — one tap, two outputs. The bubble lists the
   * threads (readable, multi-line); the voice gets a single flowing sentence
   * from the same data, because reading a bullet list aloud is unbearable.
   */
  const onReport = useCallback(async () => {
    const list = await api.threads()
    setThreads(list)
    const at = Date.now()
    const report = composeStatusReport({ threads: list, now: at }, lang)
    const hold = Math.max(config?.bubbleMs ?? 7000, report.lines.length * REPORT_MS_PER_LINE)
    showBubble({ id: `report-${at}`, text: report.bubble, lang, agent: 'codewaifu', kind: 'report', at }, hold)
    const live2d = avatarRef.current
    if (live2d) {
      try {
        live2d.host.playMotion()
      } catch {
        /* a missed wave is not an error */
      }
    }
    void api.say(report.speak, lang)
  }, [config?.bubbleMs, lang, showBubble])

  /** `null` asks for a random face; the menu only shows when the model ships any. */
  const onExpression = useCallback((name: string | null) => {
    const live2d = avatarRef.current
    if (!live2d) return
    manualFaceUntil.current = Date.now() + MANUAL_FACE_MS
    try {
      if (name) live2d.host.setExpression(name)
      else live2d.host.setRandomExpression()
    } catch {
      /* model released between the click and this call */
    }
  }, [])

  /**
   * Same idea for the body: `null` waves at random, a named entry plays exactly
   * the motion the user picked. No `manualFaceUntil` counterpart — a motion runs
   * its few seconds and the idle loop takes over by itself, whereas a face would
   * otherwise be overwritten by the next event mood.
   */
  const onMotion = useCallback((motion: Live2DMotionRef | null) => {
    const live2d = avatarRef.current
    if (!live2d) return
    try {
      if (motion) live2d.host.playMotionAt(motion.group, motion.index)
      else live2d.host.playMotion()
    } catch {
      /* model released between the click and this call */
    }
  }, [])

  const onSteer = useCallback(
    async (agent: ThreadInfo['agent'], threadId: string, message: string): Promise<SteerResult> => {
      const result = await api.steer(agent, threadId, message)
      void api.threads().then(setThreads)
      return result
    },
    []
  )

  const onHooks = useCallback(async (install: boolean) => {
    const result = install ? await api.hooksInstall() : await api.hooksUninstall()
    const report = result?.report
    if (report) {
      setRuntime((prev) => (prev ? { ...prev, hooks: report } : prev))
      notice(report.warnings?.[0] || (install ? t('hooksRepair') : t('hooksRemove')))
    }
  }, [notice, t])

  const onNeuralRetry = useCallback(async () => {
    const neural = await api.neuralRetry()
    if (neural) setRuntime((prev) => (prev ? { ...prev, neural } : prev))
  }, [])

  const onPickImage = useCallback(async () => {
    const result = await api.pickImage()
    if (result?.ok && result.path) {
      await patch({
        avatar: { ...(config?.avatar ?? DEFAULT_CONFIG.avatar), mode: 'image', imagePath: result.path }
      })
    }
  }, [config?.avatar, patch])

  const toggleExpanded = useCallback((next: boolean) => {
    setExpanded(next)
    if (!next) {
      setChatThread(null)
      void api.setChatMode(false)
    }
    void api.setExpanded(next)
  }, [])

  const openThread = useCallback((thread: ThreadInfo) => {
    setChatThread(thread)
    setExpanded(true)
    void api.setExpanded(true)
    void api.setChatMode(true)
  }, [])

  const closeChat = useCallback(() => {
    setChatThread(null)
    void api.setChatMode(false)
  }, [])

  /* ---- derived --------------------------------------------------------- */
  if (!config || !runtime) {
    return (
      <div className="app">
        <div className="shell">
          <div className="card" data-solid="1" />
        </div>
      </div>
    )
  }

  const expression = expressionForKind(lastKind, speaking)
  const relay = runtime.relay
  const relayState = relay.duplicateOf || relay.conflict ? 'warn' : speaking ? 'live' : relay.port ? 'ok' : 'warn'
  const muted = !config.speak || !config.enabled
  const view = widgetView(expanded, Boolean(chatThread))
  const live2d = config.avatar.mode === 'live2d'
  /**
   * Bare: she stands on the desktop with no card behind her, and the chrome
   * floats as a pill. Only the canvas and the pill catch the pointer, so the
   * empty space around her still belongs to whatever is underneath.
   * Opt-out lives in Settings (`appearance.clearStage`) for anybody who would
   * rather she stood on a sheet of glass.
   */
  const bare = live2d && view === 'collapsed' && config.appearance.clearStage

  return (
    <div className="app" data-view={view}>
      <div className="shell">
        <div
          className="card"
          ref={cardRef}
          data-bare={bare ? '1' : undefined}
          data-surface={config.appearance.surface}
          data-solid={bare ? undefined : '1'}
          /* The panel needs a definite height for its inner scroll containers to
             be real; shared/ui owns the number so main sizes the frame from the
             same value the renderer lays out with. */
          style={{ '--panel-h': `${panelHeight(config.avatar.mode, view)}px` } as CSSProperties}
        >
          <div
            className={live2d ? 'stage' : 'stage drag'}
            data-live2d={live2d ? '1' : undefined}
            data-compact={chatThread ? '1' : undefined}
            style={{ height: stageHeight(config.avatar.mode, view) }}
          >
            <Bubble message={bubble} />
            {live2d ? (
              <Suspense fallback={<span className="l2d-slot" />}>
                <Live2DAvatar
                  characterId={config.avatar.character}
                  t={t}
                  paused={false}
                  onHostChange={onAvatarHost}
                />
              </Suspense>
            ) : (
              <div className="avatar-wrap drag" title={t('dragHint')}>
                <Avatar
                  expression={expression}
                  speaking={speaking}
                  scale={config.scale}
                  imagePath={config.avatar.imagePath}
                  imageMode={config.avatar.mode === 'image'}
                  compact={Boolean(chatThread)}
                />
                <div className="ground" />
              </div>
            )}
            <StageTools
              t={t}
              lang={lang}
              expressions={avatar?.character.expressions ?? []}
              motions={avatar?.character.motions ?? []}
              onReport={() => void onReport()}
              onExpression={onExpression}
              onMotion={onMotion}
            />
          </div>

          {/* Parked: mac cannot see non-scriptable players yet (see
              MEDIA_UI_ENABLED). The row stays in the tree behind the flag so
              the geometry and the tests keep covering it. */}
          {MEDIA_UI_ENABLED ? (
            <MediaBar
              media={media}
              onCommand={(command) => void onMediaCommand(command)}
              unavailableText={t('mediaUnavailable')}
            />
          ) : null}

          <div className="statusbar" data-solid="1">
            <span className="chip" data-state={relayState} title={relay.port ? `127.0.0.1:${relay.port}` : 'relay offline'}>
              <span className={speaking || relayState === 'live' ? 'dot pulse' : 'dot'} />
              {relay.port || '—'}
              {queueLength > 1 ? ` +${queueLength - 1}` : ''}
            </span>
            {runtime.hooks.codex.installed ? <span className="tag codex">codex</span> : null}
            {runtime.hooks.claude.installed ? <span className="tag claude">claude</span> : null}
            <span className="statusbar-spacer" />
            <button
              className="icon-btn"
              type="button"
              title={muted ? t('unmute') : t('mute')}
              aria-label={muted ? t('unmute') : t('mute')}
              onClick={() => void patch({ speak: muted })}
            >
              {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
            <button
              className="icon-btn"
              type="button"
              title={expanded ? t('collapse') : t('expand')}
              aria-label={expanded ? t('collapse') : t('expand')}
              aria-expanded={expanded}
              onClick={() => toggleExpanded(!expanded)}
            >
              <ChevronsUpDown size={15} />
            </button>
            <button
              className="icon-btn"
              type="button"
              title={t('hide')}
              aria-label={t('hide')}
              onClick={() => void api.hide()}
            >
              <EyeOff size={15} />
            </button>
          </div>

          {expanded ? (
            <Panel
              tab={tab}
              onTab={setTab}
              config={config}
              runtime={runtime}
              events={events}
              threads={threads}
              chatThread={chatThread}
              t={t}
              lang={lang}
              onChange={(next) => void patch(next)}
              onSay={(text) => void api.say(text, lang)}
              onPickImage={() => void onPickImage()}
              onOpenPath={(path) => void api.openPath(path)}
              onHooksInstall={() => void onHooks(true)}
              onHooksUninstall={() => void onHooks(false)}
              onNeuralRetry={() => void onNeuralRetry()}
              onQuit={() => void api.quit()}
              onCollapse={() => toggleExpanded(false)}
              onOpenThread={openThread}
              onCloseChat={closeChat}
              onSteer={onSteer}
              onNotice={notice}
            />
          ) : null}

          {toast ? <div className="toast" data-solid="1">{toast}</div> : null}
        </div>
      </div>
    </div>
  )
}
