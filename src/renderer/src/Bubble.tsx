/**
 * The bubble: one line of speech, and - when it stands for something the Bench
 * can act on - the verbs that settle it without opening a window (F7).
 *
 * `message.route` is what makes this more than a toast. Main fills it from the
 * attention item, so the bubble already knows its task, its pane and which
 * actions are legal for its kind; nothing here re-derives any of it. A hook
 * bubble carries no route and renders exactly as it always did.
 *
 * Verbs that need no words get a chip. `answer` needs words and gets a composer
 * instead, because "which environment should I use?" is not a question anyone
 * can settle by clicking Approve - and the alternative was a window switch, which
 * is exactly the cost the widget exists to remove. It is one line wide and one
 * line deep on purpose: the text becomes keystrokes in a TUI's input line, so
 * `answerText` folds it flat and caps it, and a paragraph belongs in the Bench.
 * `reprompt` stays in the Bench too, where the queue shows the task it re-sends.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { BubbleMessage, BubbleRoute } from '@shared/ui'
import { ANSWER_MAX_CHARS, answerText } from '@shared/pro'
import { routeCanAnswer } from '@shared/companionLink'
import { useImeEnter } from './useIme'

/** Labels for the bubble eyebrow; the spoken text carries everything else. */
const KIND_LABEL: Record<string, { zh: string; en: string }> = {
  greeting: { zh: '问候', en: 'hello' },
  notice: { zh: '提示', en: 'notice' },
  alert: { zh: '注意', en: 'alert' },
  session_start: { zh: '会话开始', en: 'session start' },
  session_end: { zh: '会话结束', en: 'session end' },
  stop: { zh: '完成', en: 'finished' },
  permission: { zh: '待授权', en: 'permission' },
  notification: { zh: '通知', en: 'notification' },
  tool: { zh: '工具', en: 'tool' },
  compact: { zh: '压缩上下文', en: 'compacting' },
  subagent: { zh: '子任务', en: 'subagent' },
  interrupt: { zh: '已中断', en: 'interrupted' },
  prompt: { zh: '输入', en: 'prompt' },
  /** The status read-out she composes when you tap the report button. */
  report: { zh: '状态汇报', en: 'status' },
  /* Attention kinds, which reach the widget from the Bench (F7). */
  question: { zh: '提问', en: 'question' },
  review: { zh: '待 review', en: 'review' },
  failed: { zh: '失败', en: 'failed' },
  stalled: { zh: '卡住', en: 'stalled' }
}

/** Chip copy. Its keys double as the set of verbs a bubble may offer inline. */
const ACTION_LABEL: Record<string, { zh: string; en: string }> = {
  approve: { zh: '批准', en: 'Approve' },
  deny: { zh: '拒绝', en: 'Deny' },
  done: { zh: '已看', en: 'Reviewed' },
  dismiss: { zh: '忽略', en: 'Dismiss' },
  snooze: { zh: '稍后', en: 'Snooze' }
}

/**
 * The composer's own copy. Localized off `message.lang` like everything else
 * here: the bubble is drawn from a push, and the panel's translator is not
 * mounted in the stage.
 */
const ANSWER_COPY = {
  chip: { zh: '回答', en: 'Answer' },
  chipHint: { zh: 'Enter 发送 · Esc 取消', en: 'Enter sends · Esc cancels' },
  placeholder: { zh: '回一句给它…', en: 'Answer it in words…' },
  send: { zh: '发送', en: 'Send' },
  clipped: { zh: `太长了，只会发送前 ${ANSWER_MAX_CHARS} 字`, en: `Too long; only the first ${ANSWER_MAX_CHARS} characters go` }
} as const

/** Three chips is what fits one line of a 196px bubble without wrapping. */
const MAX_CHIPS = 3

/**
 * How long a composer may sit open before it closes itself.
 *
 * While it is open the bubble is pinned (App suspends both its hold timer and
 * the push-driven clear), so an abandoned composer would otherwise leave a
 * stale question on screen - and her face frozen on it - for the rest of the
 * session.
 */
const COMPOSE_MAX_MS = 120000

/** Amber border: an agent is sitting still waiting for a human. */
const ALERT_KINDS: ReadonlySet<string> = new Set(['alert', 'permission', 'question', 'failed'])

interface BubbleProps {
  message: BubbleMessage | null
  /** The bubble text was clicked: take me to that task and pane. */
  onOpen?: (route: BubbleRoute) => void
  /** One chip was clicked: settle the item right here, no window switch. */
  onAct?: (route: BubbleRoute, action: string) => void
  /** A sentence was typed into the bubble: deliver it as an `answer` act. */
  onAnswer?: (route: BubbleRoute, text: string) => void
  /**
   * The composer opened or closed. App pins the bubble while it is open, so
   * neither its own timer nor a bench push can take a half-typed answer away.
   */
  onCompose?: (open: boolean) => void
}

export function Bubble({ message, onOpen, onAct, onAnswer, onCompose }: BubbleProps): ReactElement | null {
  /*
   * The draft is keyed by the bubble id it was written for, not stored beside
   * it. A bubble can be replaced while the composer is open, and a draft that
   * outlives its item would be sent to whichever task is on screen when Enter
   * lands - an answer to a question nobody asked, delivered confidently.
   */
  const [answer, setAnswer] = useState<{ id: string; draft: string } | null>(null)
  // Enter sends only outside an IME composition: the Enter that commits a
  // Chinese candidate must not fire a half-typed answer at an agent.
  const ime = useImeEnter()

  const route = message?.route ?? null
  const canAnswer = routeCanAnswer(route) && Boolean(onAnswer)
  const open = Boolean(message && answer && answer.id === message.id)
  const draft = open ? (answer?.draft ?? '') : ''
  const normalized = answerText(draft)

  const closeComposer = useCallback((): void => {
    setAnswer(null)
    onCompose?.(false)
  }, [onCompose])

  /* An abandoned composer must not pin the bubble forever. */
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(closeComposer, COMPOSE_MAX_MS)
    return () => window.clearTimeout(timer)
  }, [open, closeComposer])

  if (!message) return null
  const label = KIND_LABEL[message.kind] || KIND_LABEL.notice
  const tone = ALERT_KINDS.has(message.kind)
    ? 'alert'
    : message.kind === 'greeting'
      ? 'greeting'
      : 'plain'
  // The route's own order, which `attentionActions` already ranks by urgency.
  const chips = route
    ? route.actions.filter((action) => action in ACTION_LABEL).slice(0, MAX_CHIPS)
    : []

  const send = (): void => {
    if (!route || !normalized.text) return
    onAnswer?.(route, normalized.text)
    closeComposer()
  }

  return (
    <div
      className="bubble"
      data-solid="1"
      data-tone={tone}
      data-compose={open ? '1' : undefined}
      role="status"
      aria-live="polite"
    >
      <div className="bubble-meta">
        {message.agent && message.agent !== 'codewaifu' ? <span>{message.agent}</span> : null}
        <span>{label[message.lang] || label.en}</span>
      </div>
      {route && onOpen ? (
        <button type="button" className="bubble-text link" onClick={() => onOpen(route)}>
          {message.text}
        </button>
      ) : (
        <div className="bubble-text">{message.text}</div>
      )}
      {open && route ? (
        <div className="bubble-answer">
          <div className="bubble-answer-row">
            <input
              className="bubble-input"
              type="text"
              autoFocus
              value={draft}
              placeholder={ANSWER_COPY.placeholder[message.lang]}
              onChange={(event) => setAnswer({ id: message.id, draft: event.target.value })}
              onKeyDown={(event) => {
                // Escape belongs to the IME first: mid-composition it cancels
                // the candidate, and only a clean one closes the composer.
                if (event.key === 'Escape' && !ime.swallows(event)) {
                  event.preventDefault()
                  // The window-level Esc handlers (chat view backs out of the
                  // thread, stage menus close) must not also fire: this Escape
                  // was addressed to the composer.
                  event.stopPropagation()
                  closeComposer()
                  return
                }
                if (!ime.submits(event)) return
                event.preventDefault()
                send()
              }}
              {...ime.composition}
            />
            <button
              type="button"
              className="bubble-chip primary"
              disabled={!normalized.text}
              onClick={send}
            >
              {ANSWER_COPY.send[message.lang]}
            </button>
          </div>
          {normalized.clipped ? (
            <p className="bubble-answer-warn">{ANSWER_COPY.clipped[message.lang]}</p>
          ) : null}
        </div>
      ) : null}
      {route && (chips.length > 0 || canAnswer || onOpen) && (
        <div className="bubble-actions">
          {chips.map((action) => (
            <button
              type="button"
              className="bubble-chip"
              key={action}
              onClick={() => onAct?.(route, action)}
            >
              {ACTION_LABEL[action][message.lang] || action}
            </button>
          ))}
          {canAnswer && !open ? (
            <button
              type="button"
              className="bubble-chip"
              title={ANSWER_COPY.chipHint[message.lang]}
              onClick={() => {
                setAnswer({ id: message.id, draft: '' })
                onCompose?.(true)
              }}
            >
              {ANSWER_COPY.chip[message.lang]}
            </button>
          ) : null}
          {onOpen && (
            <button type="button" className="bubble-chip primary" onClick={() => onOpen(route)}>
              {route.benchLabel}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
