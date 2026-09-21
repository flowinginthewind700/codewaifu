import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement
} from 'react'
import {
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerDownLeft,
  FolderOpen,
  RotateCw,
  Terminal,
  Volume2,
  Wrench
} from 'lucide-react'
import { DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT, splitBlocks, type ChatMessage, type ChatTranscript } from '@shared/chat'
import { isImeKey } from '@shared/ime'
import type { SteerResult, ThreadInfo } from '@shared/protocol'
import { api, platform } from './api'
import { codeSpans, outputSpans } from './highlight'
import { useAttachField } from './useAttach'
import { useImeEnter } from './useIme'
import type { StringKey, Translate } from './i18n'
import { Tip } from './Tip'

/**
 * The conversation of one agent thread, read straight off the agent's own
 * transcript file, with a composer that steers it (Codex via `codex queue`,
 * Claude via the clipboard — it has no injection API and we say so).
 *
 * Everything here is read-only against the transcript: we never write to the
 * agents' files, and the poll is an incremental byte-range read on the main
 * side, so keeping it open costs about as much as one `tail -f`.
 */

const LIVE_POLL_MS = 1800
const IDLE_POLL_MS = 12000
/** Lines before an assistant bubble folds behind a "more" affordance. */
const FOLD_LINES = 12
/** Minutes of silence that earn a timestamp divider. */
const TIME_GAP_MS = 5 * 60 * 1000

/**
 * Steer outcome -> panel copy. Main also returns an English `message`, which is
 * the fallback (and what ends up in the log), but the panel speaks the user's
 * language: `codex queue` exits 0 even when nobody reads the queue, and the
 * difference between "delivered" and "queued, not read" is exactly what the
 * user has to act on.
 */
const STEER_NOTICE: Partial<Record<NonNullable<SteerResult['reason']>, StringKey>> = {
  sent: 'steerSent',
  queued: 'steerQueued',
  undelivered: 'steerUndelivered',
  'no-cli': 'steerNoCli',
  failed: 'steerFailed',
  clipboard: 'steerClaudeClipboard'
}

function steerNotice(result: SteerResult, threadId: string, t: Translate): string {
  const key = result.reason ? STEER_NOTICE[result.reason] : undefined
  if (!key) return result.message || (result.ok ? t('steerSend') : t('steerFailed'))
  return t(key).replace('{id}', threadId.slice(0, 8))
}

interface ChatViewProps {
  thread: ThreadInfo
  t: Translate
  onBack: () => void
  onSteer: (agent: ThreadInfo['agent'], threadId: string, message: string) => Promise<SteerResult>
  onNotice: (text: string) => void
  onSay: (text: string) => void
  onOpenPath: (path: string) => void
}

export function ChatView({ thread, t, onBack, onSteer, onNotice, onSay, onOpenPath }: ChatViewProps): ReactElement {
  const [transcript, setTranscript] = useState<ChatTranscript | null>(null)
  const [limit, setLimit] = useState(DEFAULT_MESSAGE_LIMIT)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [pending, setPending] = useState(0)
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({})
  const [openReasoning, setOpenReasoning] = useState<Record<string, boolean>>({})
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({})

  // Enter sends only outside an IME composition: the Enter that commits a
  // Chinese candidate must not fire a half-typed steer at the agent.
  const ime = useImeEnter()

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const stickRef = useRef(true)
  const firstIdRef = useRef<string | null>(null)
  const countRef = useRef(0)
  /**
   * Drag a file onto the composer, or paste a screenshot, and its path is typed
   * in at the caret. The agent on the other end reads the file itself - both
   * codex and Claude Code take an image as a path - so nothing has to leave
   * this machine as bytes.
   */
  const attach = useAttachField({
    fieldRef: textareaRef,
    value: draft,
    onChange: setDraft,
    platform,
    strings: {
      attached: (n) => t('attachPaths').replace('{n}', String(n)),
      failed: t('attachFailed'),
      dropHint: t('attachDropField')
    },
    notify: (text) => onNotice(text)
  })

  const load = useCallback(
    async (nextLimit: number, fresh: boolean): Promise<void> => {
      const found = await api.transcript(thread.agent, thread.id, { limit: nextLimit, fresh })
      if (!found) {
        setFailed(true)
        setLoading(false)
        return
      }
      setFailed(false)
      setLoading(false)
      setTranscript(found)
      const previousCount = countRef.current
      countRef.current = found.messages.length
      if (stickRef.current) {
        setPending(0)
        bottomRef.current?.scrollIntoView({ block: 'end' })
      } else if (found.messages.length > previousCount) {
        setPending(found.messages.length - previousCount)
      }
    },
    [thread.agent, thread.id]
  )

  /* ---- first load, then poll while the thread is live ------------------ */
  useEffect(() => {
    stickRef.current = true
    countRef.current = 0
    setLoading(true)
    setTranscript(null)
    setLimit(DEFAULT_MESSAGE_LIMIT)
    setOpenTools({})
    setOpenReasoning({})
    setUnfolded({})
    setDraft('')
    void load(DEFAULT_MESSAGE_LIMIT, true)
  }, [load])

  useEffect(() => {
    const every = thread.live ? LIVE_POLL_MS : IDLE_POLL_MS
    const timer = window.setInterval(() => void load(limit, false), every)
    return () => window.clearInterval(timer)
  }, [limit, load, thread.live])

  /* ---- scroll: stick to the tail until the user scrolls up ------------- */
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const stick = distance < 48
    stickRef.current = stick
    setAtBottom(stick)
    if (stick) setPending(0)
  }, [])

  // Keep the tail pinned across re-renders while we are following it.
  useLayoutEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [transcript?.messages.length])

  /* ---- keyboard: Esc backs out, Cmd/Ctrl+K jumps to the composer ------- */
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      // While composing, Esc belongs to the IME (it cancels the candidate),
      // not to the panel.
      if (isImeKey(event)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onBack()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        textareaRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  const loadOlder = useCallback(async () => {
    const el = scrollRef.current
    firstIdRef.current = el?.querySelector<HTMLElement>('[data-mid]')?.dataset.mid ?? null
    const next = Math.min(MAX_MESSAGE_LIMIT, limit * 4)
    setLimit(next)
    await load(next, true)
    // Restore the reading position: without this, "load older" looks like a
    // jump to the top of a much longer list.
    const anchor = firstIdRef.current
    if (anchor) scrollRef.current?.querySelector(`[data-mid="${anchor}"]`)?.scrollIntoView({ block: 'start' })
    stickRef.current = false
    setAtBottom(false)
  }, [limit, load])

  const send = useCallback(async () => {
    const message = draft.trim()
    if (!message || busy) return
    setBusy(true)
    try {
      const result = await onSteer(thread.agent, thread.id, message)
      // Keep the draft when the agent never received it — the text is on the
      // clipboard now and the user still wants to paste it into the terminal.
      if (result.ok && result.method === 'queue') setDraft('')
      onNotice(steerNotice(result, thread.id, t))
      // A queued steer shows up in the transcript a moment later; nudge it.
      window.setTimeout(() => void load(limit, false), 900)
    } finally {
      setBusy(false)
    }
  }, [busy, draft, limit, load, onNotice, onSteer, t, thread.agent, thread.id])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (!ime.submits(event)) return
      event.preventDefault()
      void send()
    },
    [ime, send]
  )

  const messages = transcript?.messages ?? []
  const lastAssistant = useMemo(() => [...messages].reverse().find((m) => m.role === 'assistant')?.text ?? '', [messages])
  const cwd = transcript?.cwd || thread.cwd
  const canSteer = thread.steerable

  return (
    <div className="chat" data-solid="1">
      <header className="chat-head">
        <Tip label={t('chatBack')}>
          <button className="icon-btn" type="button" aria-label={t('chatBack')} onClick={onBack}>
            <ChevronLeft size={16} />
          </button>
        </Tip>
        <div className="chat-id">
          <div className="chat-title">{thread.title || thread.id.slice(0, 8)}</div>
          <div className="chat-sub">
            <span className={`tag ${thread.agent}`}>{thread.agent}</span>
            {thread.live ? <span className="live-dot" title={t('live')} /> : null}
            <span className="chat-cwd" title={cwd}>{shortCwd(cwd) || thread.id.slice(0, 8)}</span>
          </div>
        </div>
        <div className="chat-actions">
          <Tip label={t('chatReadAloud')}>
            <button
              className="icon-btn"
              type="button"
              aria-label={t('chatReadAloud')}
              disabled={!lastAssistant}
              onClick={() => lastAssistant && onSay(lastAssistant)}
            >
              <Volume2 size={14} />
            </button>
          </Tip>
          <Tip label={t('chatReveal')}>
            <button
              className="icon-btn"
              type="button"
              aria-label={t('chatReveal')}
              disabled={!transcript?.file}
              onClick={() => transcript?.file && onOpenPath(transcript.file)}
            >
              <FolderOpen size={14} />
            </button>
          </Tip>
          <Tip label={t('chatRefresh')}>
            <button
              className="icon-btn"
              type="button"
              aria-label={t('chatRefresh')}
              onClick={() => void load(limit, true)}
            >
              <RotateCw size={14} />
            </button>
          </Tip>
        </div>
      </header>

      <div className="chat-body">
        <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
          {loading ? (
            <div className="chat-state">{t('chatLoading')}</div>
          ) : failed ? (
            <div className="chat-state">
              <p>{t('chatMissing')}</p>
              <button className="mini-btn" type="button" onClick={() => void load(limit, true)}>
                {t('chatRefresh')}
              </button>
            </div>
          ) : messages.length === 0 ? (
            <div className="chat-state">{t('chatEmpty')}</div>
          ) : (
            <>
              {transcript && transcript.dropped > 0 ? (
                <button className="load-older" type="button" onClick={() => void loadOlder()}>
                  {t('chatLoadOlder').replace('{n}', String(transcript.dropped))}
                </button>
              ) : null}
              {messages.map((message, index) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  previous={messages[index - 1]}
                  open={Boolean(openTools[message.id])}
                  reasoningOpen={Boolean(openReasoning[message.id])}
                  unfolded={Boolean(unfolded[message.id])}
                  t={t}
                  onToggleTool={() => setOpenTools((prev) => ({ ...prev, [message.id]: !prev[message.id] }))}
                  onToggleReasoning={() => setOpenReasoning((prev) => ({ ...prev, [message.id]: !prev[message.id] }))}
                  onUnfold={() => setUnfolded((prev) => ({ ...prev, [message.id]: true }))}
                  onCopy={() => onNotice(t('copied'))}
                  onSpeak={onSay}
                />
              ))}
              {thread.live ? (
                <div className="chat-typing" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              ) : null}
            </>
          )}
          <div ref={bottomRef} />
        </div>

        {!atBottom && !loading && !failed && messages.length > 0 ? (
          <button
            className="chat-jump"
            type="button"
            onClick={() => {
              stickRef.current = true
              setAtBottom(true)
              setPending(0)
              bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
            }}
          >
            <ArrowDown size={13} strokeWidth={2.4} />
            {pending > 0 ? t('chatNewMessages').replace('{n}', String(pending)) : t('chatToBottom')}
          </button>
        ) : null}
      </div>

      <div className="chat-foot">
        {!canSteer ? <div className="hint">{t('steerUnsupported')}</div> : null}
        <div className="composer" data-dragging={attach.dragging || undefined}>
          <textarea
            ref={textareaRef}
            value={draft}
            placeholder={
              attach.dragging
                ? attach.dropHint
                : canSteer
                  ? t('steerPlaceholder')
                  : t('steerClipboardPlaceholder')
            }
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={attach.onPaste}
            onDrop={attach.onDrop}
            onDragOver={attach.onDragOver}
            onDragEnter={attach.onDragEnter}
            onDragLeave={attach.onDragLeave}
            {...ime.composition}
          />
          <button
            className="icon-btn primary"
            type="button"
            title={canSteer ? t('steerSend') : t('copy')}
            aria-label={canSteer ? t('steerSend') : t('copy')}
            disabled={busy || !draft.trim()}
            onClick={() => void send()}
          >
            <CornerDownLeft size={15} strokeWidth={2.4} />
          </button>
        </div>
      </div>
    </div>
  )
}

interface RowProps {
  message: ChatMessage
  previous?: ChatMessage
  open: boolean
  reasoningOpen: boolean
  unfolded: boolean
  t: Translate
  onToggleTool: () => void
  onToggleReasoning: () => void
  onUnfold: () => void
  onCopy: () => void
  onSpeak: (text: string) => void
}

function MessageRow({ message, previous, open, reasoningOpen, unfolded, t, onToggleTool, onToggleReasoning, onUnfold, onCopy, onSpeak }: RowProps): ReactElement | null {
  const showTime = Boolean(message.at) && (!previous?.at || message.at - previous.at > TIME_GAP_MS)
  const folded = message.role === 'assistant' && !unfolded && message.text.split('\n').length > FOLD_LINES

  if (message.role === 'reasoning') {
    return (
      <>
        {showTime ? <TimeDivider at={message.at} /> : null}
        <div className="msg reasoning" data-mid={message.id}>
          <button className="msg-fold" type="button" onClick={onToggleReasoning} aria-expanded={reasoningOpen}>
            <ChevronRight size={12} className={reasoningOpen ? 'rot' : ''} />
            <span>{message.sidechain ? t('chatSubagentThinking') : t('chatThinking')}</span>
          </button>
          {reasoningOpen ? <p className="msg-reasoning-body">{message.text}</p> : null}
        </div>
      </>
    )
  }

  if (message.role === 'tool') {
    return (
      <>
        {showTime ? <TimeDivider at={message.at} /> : null}
        <div className="msg tool" data-mid={message.id}>
          <button className="msg-fold" type="button" onClick={onToggleTool} aria-expanded={open}>
            <ChevronRight size={12} className={open ? 'rot' : ''} />
            {message.tool === 'output' ? <Wrench size={11} /> : <Terminal size={11} />}
            <span className="tool-name">{message.tool}</span>
            {message.text ? <span className="tool-args">{message.text}</span> : null}
            {message.output ? <span className="tool-badge">{message.output.length > 999 ? `${Math.round(message.output.length / 1000)}k` : message.output.length}</span> : null}
          </button>
          {open && message.output ? (
            <pre className="tool-output">{outputSpans(message)}</pre>
          ) : null}
        </div>
      </>
    )
  }

  const isUser = message.role === 'user'
  return (
    <>
      {showTime ? <TimeDivider at={message.at} /> : null}
      <div className={`msg ${isUser ? 'user' : 'assistant'}${message.sidechain ? ' sidechain' : ''}`} data-mid={message.id}>
        <div className="msg-bubble">
          {splitBlocks(message.text).map((block, index) =>
            block.kind === 'code' ? (
              <pre key={index} className="code">{codeSpans(block.lang, block.text)}</pre>
            ) : (
              <p key={index} className={folded ? 'clamp' : undefined}>{block.text}</p>
            )
          )}
          {message.truncated ? <span className="msg-truncated">{t('chatTruncated')}</span> : null}
          {folded ? (
            <button className="msg-more" type="button" onClick={onUnfold}>{t('chatMore')}</button>
          ) : null}
        </div>
        <div className="msg-tools">
          {!isUser ? (
            <button className="icon-btn ghost" type="button" title={t('chatReadAloud')} aria-label={t('chatReadAloud')} onClick={() => onSpeak(message.text)}>
              <Volume2 size={12} />
            </button>
          ) : null}
          <button
            className="icon-btn ghost"
            type="button"
            title={t('copy')}
            aria-label={t('copy')}
            onClick={() => {
              void navigator.clipboard?.writeText(message.text)
              onCopy()
            }}
          >
            <Copy size={12} />
          </button>
        </div>
      </div>
    </>
  )
}

function TimeDivider({ at }: { at: number }): ReactElement {
  return (
    <div className="chat-divider">
      <span>{new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </div>
  )
}

function shortCwd(cwd: string): string {
  if (!cwd) return ''
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/')
}
