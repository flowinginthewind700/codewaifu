/**
 * The conversation of a task whose terminal the bench does not own.
 *
 * An imported session is still running in the human's own console. herdr has no
 * pane for it, so the pane grid's honest answer is "no panes" - which is a true
 * statement about the multiplexer and a useless one about the work. The agent
 * writes its own transcript either way (`~/.codex/sessions/<date>/rollout-<id>.jsonl`,
 * `~/.claude/projects/<slug>/<uuid>.jsonl`), and that file is the live surface: the
 * stage's chat view has always read it, so this panel reads the same thing
 * through the same reader and the two modes cannot disagree about what the
 * agent said.
 *
 * Answering goes through `steer` rather than through a PTY, for the same reason
 * and with the same honesty: Codex takes a queue write, every other flavor has
 * no injection API and gets the clipboard, and the panel reports which of those
 * happened instead of implying a delivery it cannot prove.
 *
 * Read-only against the transcript, always. Nothing here writes to an agent's
 * files, and the poll is an incremental byte-range read on the main side.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { CornerDownLeft, FolderOpen, RotateCw } from 'lucide-react'
import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  splitBlocks,
  type ChatMessage,
  type ChatTranscript
} from '@shared/chat'
import type { Lang, SteerResult } from '@shared/protocol'
import { agentLabel } from '@shared/phrases'
import type { TaskView } from '@shared/pro'
import { codeSpans, commandSpans, outputSpans } from '../highlight'
import { useImeEnter } from '../useIme'
import { useAttachField } from '../useAttach'
import { platform, proApi } from './api'
import { agentClass } from './agentTag'
import { fill, type StringKey, type Translate } from './i18n'
import type { Tone } from './toast'

/** A transcript that changed this recently is worth a `tail -f` cadence. */
const LIVE_POLL_MS = 1800
const IDLE_POLL_MS = 12000
/** Silence after which the poll backs off. */
const LIVE_WINDOW_MS = 45000
/** Lines of one message before it folds behind a "more". */
const FOLD_LINES = 14

const STEER_NOTICE: Partial<Record<NonNullable<SteerResult['reason']>, StringKey>> = {
  sent: 'steerSent',
  queued: 'steerQueued',
  undelivered: 'steerUndelivered',
  'no-cli': 'steerNoCli',
  failed: 'steerFailed',
  clipboard: 'steerClipboard'
}

/**
 * A human-facing name for the task's agent flavor.
 *
 * `agentKind` is whatever herdr reported - a bare `codex`, a suffixed binary
 * like `cursor-agent`, herdr's own `agy` for Antigravity, or a custom manifest
 * this build has never seen. `agentClass` already collapses that spread into
 * one family per agent for the colour tag, and the label table is keyed by
 * family, so reusing it keeps the notice and the tag saying the same thing. An
 * unrecognized family falls through to the label table's own honest answer
 * ("the agent") rather than to a guess.
 */
function agentName(agentKind: string, lang: Lang): string {
  const family = agentClass(agentKind) || String(agentKind || '').trim().toLowerCase()
  if (!family) return agentLabel('unknown', lang)
  const label = agentLabel(family, lang)
  // A family the label table has never been taught resolves to "the agent",
  // which is less useful than the kind itself sitting on screen.
  return label === agentLabel('unknown', lang) ? family : label
}

function steerNotice(result: SteerResult, sessionId: string, t: Translate, name: string): string {
  const key = result.reason ? STEER_NOTICE[result.reason] : undefined
  if (!key) return result.message || (result.ok ? t('convoSend') : t('steerFailed'))
  return fill(t, key, { id: sessionId.slice(0, 8), agent: name })
}

/** What the transcript reader could not do, in words that name the fix. */
function readFailure(code: string, detail: string, t: Translate): string {
  if (code === 'no-session') return t('convoNoSession')
  if (code === 'no-transcript') return t('convoMissing')
  return fill(t, 'convoFailed', { detail: detail || code || 'unknown' })
}

function clockAt(at: number): string {
  if (!at) return ''
  const stamp = new Date(at)
  if (Number.isNaN(stamp.getTime())) return ''
  return stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function roleLabel(message: ChatMessage, t: Translate): string {
  if (message.role === 'tool') return message.tool || t('convoTool')
  if (message.role === 'reasoning') return t('convoReasoning')
  return message.role
}

/** Prose and fenced code, kept apart: agent replies are mostly diffs. */
function Blocks({ text, unfold }: { text: string; unfold: boolean }): ReactElement {
  const blocks = useMemo(() => splitBlocks(text), [text])
  return (
    <div className="convo-blocks" data-unfold={unfold || undefined}>
      {blocks.map((block, index) =>
        block.kind === 'code' ? (
          <pre className="convo-code mono" key={index}>
            {codeSpans(block.lang, block.text)}
          </pre>
        ) : (
          <p className="convo-text" key={index}>
            {block.text}
          </p>
        )
      )}
    </div>
  )
}

function Message({ message, t }: { message: ChatMessage; t: Translate }): ReactElement {
  const [unfolded, setUnfolded] = useState(false)
  // A tool row that carries its command shows that command as the body: the
  // reader's `text` for such a row is the same line clipped to 120 chars, so
  // rendering both would print the command twice, once coloured and once not.
  const command = message.role === 'tool' ? message.command : undefined
  const lines = (command ?? message.text).split('\n').length
  const foldable = lines > FOLD_LINES
  const output = useMemo(() => (message.output ? outputSpans(message) : null), [message])
  return (
    <article className="convo-msg" data-role={message.role} data-side={message.sidechain || undefined}>
      <header className="convo-msg-head">
        <span className="convo-role">{roleLabel(message, t)}</span>
        {message.at ? <span className="convo-when">{clockAt(message.at)}</span> : null}
        {message.truncated ? <span className="pill quiet">{t('convoTruncated')}</span> : null}
      </header>
      {command ? (
        <pre className="convo-cmd mono" data-unfold={unfolded || undefined}>
          {commandSpans(command)}
        </pre>
      ) : null}
      {!command && message.text ? <Blocks text={message.text} unfold={unfolded || !foldable} /> : null}
      {output ? (
        <pre className="convo-output mono" data-unfold={unfolded || undefined}>
          {output}
        </pre>
      ) : null}
      {foldable ? (
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => setUnfolded((value) => !value)}
        >
          {unfolded ? t('convoLess') : t('convoMore')}
        </button>
      ) : null}
    </article>
  )
}

export interface ConversationPanelProps {
  task: TaskView
  t: Translate
  /** Resolved UI language; the agent names are bilingual in the table. */
  lang: Lang
  onNotify: (text: string, tone?: Tone) => void
}

export function ConversationPanel({ task, t, lang, onNotify }: ConversationPanelProps): ReactElement {
  const [transcript, setTranscript] = useState<ChatTranscript | null>(null)
  const [limit, setLimit] = useState(DEFAULT_MESSAGE_LIMIT)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [pinned, setPinned] = useState(true)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  // Enter-to-send that survives a Chinese IME: the commit Enter of a
  // composition must land in the textarea, not in the agent's queue.
  const ime = useImeEnter()
  const taskId = task.id
  /**
   * Drag a file in, or paste a screenshot, and its path lands at the caret.
   * This panel steers an agent that lives in somebody else's console, so a path
   * is the whole of what can be delivered - and the whole of what codex and
   * Claude Code need, since both open an image argument themselves.
   */
  const attach = useAttachField({
    fieldRef: inputRef,
    value: draft,
    onChange: setDraft,
    platform,
    strings: {
      attached: (n) => fill(t, 'attachPaths', { n }),
      failed: t('attachFailed'),
      dropHint: t('attachDropField')
    },
    notify: onNotify
  })

  const read = useCallback(
    async (fresh: boolean, wanted: number): Promise<void> => {
      const result = await proApi.task.transcript(taskId, { limit: wanted, fresh })
      if (!result.ok || !result.data) {
        setError(readFailure(result.code ?? '', result.detail ?? '', t))
        setTranscript(null)
        return
      }
      setError('')
      setTranscript(result.data)
    },
    [taskId, t]
  )

  // First read, and a fresh one whenever the selection moves to another task.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setTranscript(null)
    setError('')
    void read(true, limit).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
    // `limit` is deliberately not a dependency: "load older" re-reads itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, read])

  /**
   * Follow the file while it is moving, back off when it is not. The cadence is
   * driven by the transcript's own mtime rather than by the task's status,
   * because the whole reason this panel exists is a task whose status the bench
   * cannot see.
   */
  useEffect(() => {
    const recent = transcript ? Date.now() - transcript.mtimeMs < LIVE_WINDOW_MS : true
    const handle = window.setInterval(() => void read(false, limit), recent ? LIVE_POLL_MS : IDLE_POLL_MS)
    return () => window.clearInterval(handle)
  }, [limit, read, transcript?.mtimeMs])

  // Stay glued to the newest line, but only while the human has not scrolled up
  // to read something: yanking a page out from under a reader is how a live tail
  // becomes unreadable.
  useEffect(() => {
    const node = listRef.current
    if (!node || !pinned) return
    node.scrollTop = node.scrollHeight
  }, [pinned, transcript?.messages.length, transcript?.mtimeMs])

  const onScroll = useCallback((): void => {
    const node = listRef.current
    if (!node) return
    setPinned(node.scrollHeight - node.scrollTop - node.clientHeight < 40)
  }, [])

  const loadOlder = useCallback((): void => {
    const next = Math.min(limit * 2, MAX_MESSAGE_LIMIT)
    if (next === limit) return
    setLimit(next)
    setPinned(false)
    void read(true, next)
  }, [limit, read])

  const send = useCallback(async (): Promise<void> => {
    const message = draft.trim()
    if (!message || busy) return
    setBusy(true)
    const result = await proApi.task.steer(taskId, message)
    setBusy(false)
    if (!result.ok || !result.data) {
      onNotify(result.detail || result.code || t('steerFailed'), 'error')
      return
    }
    const delivered = result.data
    onNotify(
      steerNotice(delivered, task.agentSessionId || taskId, t, agentName(task.agentKind, lang)),
      delivered.ok ? 'info' : 'warn'
    )
    if (delivered.ok) {
      setDraft('')
      setPinned(true)
      void read(true, limit)
    }
  }, [busy, draft, lang, limit, onNotify, read, t, taskId, task.agentKind, task.agentSessionId])

  const messages = transcript?.messages ?? []
  const following = transcript ? Date.now() - transcript.mtimeMs < LIVE_WINDOW_MS : false

  return (
    <section className="convo">
      <header className="convo-head">
        <h2 className="convo-title">{t('convoTitle')}</h2>
        <span className={`tag ${task.agentKind}`.trim()} data-empty={!task.agentKind || undefined}>
          {task.agentKind || '?'}
        </span>
        <span className="dot" data-state={following ? 'working' : 'idle'} title={following ? t('convoLive') : t('convoIdle')} />
        <span className="spacer" />
        {transcript?.file ? (
          <button
            type="button"
            className="btn ghost sm icon"
            title={t('convoReveal')}
            aria-label={t('convoReveal')}
            onClick={() => void proApi.host.openPath(transcript.file)}
          >
            <FolderOpen />
          </button>
        ) : null}
        <button
          type="button"
          className="btn ghost sm icon"
          title={t('convoRefresh')}
          aria-label={t('convoRefresh')}
          disabled={busy}
          onClick={() => void read(true, limit)}
        >
          <RotateCw />
        </button>
      </header>

      <p className="convo-hint">{t('convoHint')}</p>

      <div className="convo-list" ref={listRef} onScroll={onScroll}>
        {loading ? <p className="empty-note">{t('convoLoading')}</p> : null}
        {!loading && error ? <p className="empty-note convo-error">{error}</p> : null}
        {!loading && !error && !messages.length ? (
          <p className="empty-note">{t('convoEmpty')}</p>
        ) : null}
        {!loading && !error && transcript && transcript.dropped > 0 ? (
          <button type="button" className="btn ghost sm convo-older" onClick={loadOlder}>
            {fill(t, 'convoOlder', { n: transcript.dropped })}
          </button>
        ) : null}
        {messages.map((message) => (
          <Message key={message.id} message={message} t={t} />
        ))}
      </div>

      <footer className="convo-foot">
        <textarea
          ref={inputRef}
          className="convo-input"
          data-dragging={attach.dragging || undefined}
          rows={2}
          value={draft}
          placeholder={attach.dragging ? attach.dropHint : t('convoPlaceholder')}
          title={attach.dragging ? attach.dropHint : t('convoSteerHint')}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={attach.onPaste}
          onDrop={attach.onDrop}
          onDragOver={attach.onDragOver}
          onDragEnter={attach.onDragEnter}
          onDragLeave={attach.onDragLeave}
          onKeyDown={(event) => {
            if (!ime.submits(event)) return
            event.preventDefault()
            void send()
          }}
          {...ime.composition}
        />
        <button type="button" className="btn primary" disabled={busy || !draft.trim()} onClick={() => void send()}>
          <CornerDownLeft />
          {t('convoSend')}
        </button>
      </footer>
    </section>
  )
}
