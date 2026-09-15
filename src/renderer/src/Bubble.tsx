/**
 * The bubble: one line of speech, and - when it stands for something the Bench
 * can act on - the verbs that settle it without opening a window (F7).
 *
 * `message.route` is what makes this more than a toast. Main fills it from the
 * attention item, so the bubble already knows its task, its pane and which
 * actions are legal for its kind; nothing here re-derives any of it. A hook
 * bubble carries no route and renders exactly as it always did.
 *
 * Only text-free verbs get a chip. `answer` and `reprompt` need words, and a
 * 196px bubble is not where anyone wants to type a paragraph, so those go to the
 * Bench instead: the text itself is the click target for that, and one click
 * lands on the pane that asked.
 */
import type { ReactElement } from 'react'
import type { BubbleMessage, BubbleRoute } from '@shared/ui'

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

/** Three chips is what fits one line of a 196px bubble without wrapping. */
const MAX_CHIPS = 3

/** Amber border: an agent is sitting still waiting for a human. */
const ALERT_KINDS: ReadonlySet<string> = new Set(['alert', 'permission', 'question', 'failed'])

interface BubbleProps {
  message: BubbleMessage | null
  /** The bubble text was clicked: take me to that task and pane. */
  onOpen?: (route: BubbleRoute) => void
  /** One chip was clicked: settle the item right here, no window switch. */
  onAct?: (route: BubbleRoute, action: string) => void
}

export function Bubble({ message, onOpen, onAct }: BubbleProps): ReactElement | null {
  if (!message) return null
  const label = KIND_LABEL[message.kind] || KIND_LABEL.notice
  const tone = ALERT_KINDS.has(message.kind)
    ? 'alert'
    : message.kind === 'greeting'
      ? 'greeting'
      : 'plain'
  const route = message.route ?? null
  // The route's own order, which `attentionActions` already ranks by urgency.
  const chips = route
    ? route.actions.filter((action) => action in ACTION_LABEL).slice(0, MAX_CHIPS)
    : []
  return (
    <div className="bubble" data-solid="1" data-tone={tone} role="status" aria-live="polite">
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
      {route && (chips.length > 0 || onOpen) && (
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
