import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ChevronsUpDown, EyeOff, Volume2, VolumeX } from 'lucide-react'
import type { ConfigPatch } from '@shared/config'
import { EMPTY_MEDIA, type MediaCommand, type MediaState } from '@shared/media'
import type {
  EventKind,
  EventPlan,
  HookEvent,
  RedactedConfig,
  RelayStatus,
  RuntimeState,
  SteerResult,
  ThreadInfo,
  UiSnapshot
} from '@shared/protocol'
import { expressionForKind, type BubbleMessage, type PanelTab } from '@shared/ui'
import { api, CH } from './api'
import { Avatar } from './Avatar'
import { Bubble } from './Bubble'
import { makeTranslator, type Translate } from './i18n'
import { MediaBar } from './MediaBar'
import { Panel } from './Panel'

const THREAD_POLL_MS = 8000
const TOAST_MS = 4200

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

  const bubbleTimer = useRef<number | null>(null)
  const toastTimer = useRef<number | null>(null)
  const clickThrough = useRef(false)

  const lang = config?.lang === 'en' ? 'en' : 'zh'
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

  /* ---- main -> renderer pushes ---------------------------------------- */
  useEffect(() => {
    const offs = [
      api.on(CH.pushEvent, (payload) => {
        const plan = payload as EventPlan
        if (!plan?.event) return
        setEvents((prev) => [plan.event, ...prev].slice(0, 200))
        setLastKind(plan.event.kind)
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

  /* ---- threads: refresh while the tab is open, and after any event ----- */
  useEffect(() => {
    if (!expanded || tab !== 'threads') return
    let alive = true
    const load = (): void => {
      void api.threads().then((list) => {
        if (alive) setThreads(list)
      })
    }
    load()
    const timer = window.setInterval(load, THREAD_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [expanded, tab, events.length])

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

  const onPickImage = useCallback(async () => {
    const result = await api.pickImage()
    if (result?.ok && result.path) {
      await patch({ avatar: { ...(config?.avatar ?? { mode: 'builtin', imagePath: '', expression: 'idle' }), mode: 'image', imagePath: result.path } })
    }
  }, [config?.avatar, patch])

  const toggleExpanded = useCallback((next: boolean) => {
    setExpanded(next)
    void api.setExpanded(next)
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

  return (
    <div className="app">
      <div className="shell">
        <div className="card" data-solid="1">
          <div className="stage drag">
            <Bubble message={bubble} />
            <div className="avatar-wrap drag" title={t('dragHint')}>
              <Avatar
                expression={expression}
                speaking={speaking}
                scale={config.scale}
                imagePath={config.avatar.imagePath}
                imageMode={config.avatar.mode === 'image'}
              />
              <div className="ground" />
            </div>
          </div>

          <MediaBar media={media} onCommand={(command) => void onMediaCommand(command)} unavailableText={t('mediaUnavailable')} />

          <div className="statusbar">
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
              media={media}
              t={t}
              onChange={(next) => void patch(next)}
              onSay={(text) => void api.say(text, lang)}
              onPickImage={() => void onPickImage()}
              onOpenPath={(path) => void api.openPath(path)}
              onHooksInstall={() => void onHooks(true)}
              onHooksUninstall={() => void onHooks(false)}
              onQuit={() => void api.quit()}
              onCollapse={() => toggleExpanded(false)}
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
