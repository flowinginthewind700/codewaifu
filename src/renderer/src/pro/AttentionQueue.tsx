/**
 * The attention queue (F3): the one screen that matters.
 *
 * Two invariants, both of which are the reason this panel exists rather than the
 * terminal being the answer:
 *
 * 1. Every item can be decided *in place*. Approve, deny, answer, snooze - none
 *    of them require the pane to be focused, because "go find the terminal
 *    first" is exactly the latency a cockpit is supposed to remove.
 * 2. A keystroke decision shows the keys it is about to press. `decisionKeys`
 *    returns `null` for an agent with no recipe, and then the button is not
 *    rendered at all: guessing at someone's TUI and pressing the wrong key
 *    confidently is worse than not offering the button.
 *
 * Order comes from the service (`rankAttention`), never from here. If this file
 * sorted the list too, the badge and the queue would eventually disagree.
 */
import { useState, type ReactElement } from 'react'
import {
  Check,
  CheckCheck,
  Clock,
  CornerUpRight,
  EyeOff,
  MessageSquare,
  RotateCcw,
  X
} from 'lucide-react'
import {
  ANSWER_MAX_CHARS,
  DEFAULT_SNOOZE_MINUTES,
  answerText,
  attentionActions,
  decisionKeys,
  type AttentionAction,
  type AttentionItem,
  type KeyOverrides
} from '@shared/pro'
import { fill, type Translate } from './i18n'
import { dur } from './time'
import type { Tone } from './toast'
import { useImeEnter } from '../useIme'

export interface AttentionQueueProps {
  /** readonly: the queue renders the service's ranking; it never reorders or edits it. */
  items: readonly AttentionItem[]
  cursorId: string
  now: number
  keys: KeyOverrides | null
  t: Translate
  onAct: (itemId: string, action: AttentionAction, extra?: { text?: string; minutes?: number }) => void
  onOpen: (item: AttentionItem) => void
  onNotify: (text: string, tone?: Tone) => void
}

const KIND_KEY = {
  permission: 'kindPermission',
  question: 'kindQuestion',
  review: 'kindReview',
  stalled: 'kindStalled',
  failed: 'kindFailed'
} as const

const ACTION_KEY = {
  approve: 'actionApprove',
  deny: 'actionDeny',
  answer: 'actionAnswer',
  snooze: 'actionSnooze',
  open: 'actionOpen',
  done: 'actionDone',
  dismiss: 'actionDismiss',
  reprompt: 'actionReprompt'
} as const

export function AttentionQueue({
  items,
  cursorId,
  now,
  keys,
  t,
  onAct,
  onOpen,
  onNotify
}: AttentionQueueProps): ReactElement {
  const [answering, setAnswering] = useState('')
  const [draft, setDraft] = useState('')
  // Enter sends only outside a composition: the Enter that commits a Chinese
  // candidate is a keydown like any other, and without this it ships half-typed
  // pinyin to the agent as an answer.
  const ime = useImeEnter()

  if (!items.length) {
    return (
      <div className="panel-scroll">
        <p className="empty-note">{t('queueEmpty')}</p>
        <p className="empty-note">{t('queueEmptyBusy')}</p>
      </div>
    )
  }

  const sendAnswer = (item: AttentionItem): void => {
    // Same normalization the widget bubble and `POST /pro/answer` go through:
    // a pasted paragraph folds to one line, because a newline reaching the pane
    // is Enter and submits the first half early.
    const { text } = answerText(draft)
    if (!text) {
      onNotify(t('answerNeedsText'), 'warn')
      return
    }
    onAct(item.id, 'answer', { text })
    setDraft('')
    setAnswering('')
  }

  return (
    <div className="panel-scroll">
      <div className="queue">
        {items.map((item) => {
          const waited = Math.max(0, now - (item.since || now))
          const approve = decisionKeys(item.agentKind, 'approve', keys)
          const deny = decisionKeys(item.agentKind, 'deny', keys)
          const openAnswer = answering === item.id
          return (
            <article
              className="qitem"
              key={item.id}
              data-cursor={item.id === cursorId}
              data-snoozed={item.snoozedUntil > now}
              data-resolved={item.resolved}
            >
              <div className="qitem-head">
                <span className="kind" data-kind={item.kind}>
                  {t(KIND_KEY[item.kind])}
                </span>
                <span className="qitem-where" title={item.taskTitle}>
                  {item.taskTitle || t('whereUnknown')}
                  {item.groupLabel ? ` · ${item.groupLabel}` : ''}
                </span>
                <span className="qitem-wait">{fill(t, 'waitedFor', { t: dur(waited, t) })}</span>
              </div>

              {item.title && <p className="qitem-text">{item.title}</p>}
              {item.detail && item.detail !== item.title && (
                <p className="qitem-detail">{item.detail}</p>
              )}
              {item.command && <pre className="qitem-cmd">{item.command}</pre>}

              <div className="qactions">
                {attentionActions(item.kind).map((action) => (
                  <ActionButton
                    key={action}
                    action={action}
                    item={item}
                    approve={approve}
                    deny={deny}
                    openAnswer={openAnswer}
                    t={t}
                    onAct={onAct}
                    onOpen={onOpen}
                    onToggleAnswer={() => {
                      setAnswering(openAnswer ? '' : item.id)
                      setDraft('')
                    }}
                  />
                ))}
              </div>

              {item.kind === 'permission' && !approve && !deny && (
                <p className="no-recipe">{fill(t, 'noRecipe', { agent: item.agentKind || '?' })}</p>
              )}

              {openAnswer && (
                <div className="answer-box">
                  <div className="answer-row">
                    <input
                      className="input"
                      autoFocus
                      value={draft}
                      placeholder={t('answerPlaceholder')}
                      maxLength={ANSWER_MAX_CHARS}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          // Mid-composition Escape belongs to the IME: it drops
                          // the candidate, not the answer box.
                          if (ime.swallows(event)) return
                          setAnswering('')
                          setDraft('')
                          return
                        }
                        if (!ime.submits(event)) return
                        event.preventDefault()
                        sendAnswer(item)
                      }}
                      {...ime.composition}
                    />
                    <button type="button" className="btn primary sm" onClick={() => sendAnswer(item)}>
                      {t('answerSend')}
                    </button>
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>
    </div>
  )
}

interface ActionButtonProps {
  action: AttentionAction
  item: AttentionItem
  approve: ReturnType<typeof decisionKeys>
  deny: ReturnType<typeof decisionKeys>
  openAnswer: boolean
  t: Translate
  onAct: AttentionQueueProps['onAct']
  onOpen: (item: AttentionItem) => void
  onToggleAnswer: () => void
}

/**
 * One action button. Split out because the approve/deny pair carries a key
 * preview and a "no recipe" rule that would swamp the item's own markup.
 */
function ActionButton({
  action,
  item,
  approve,
  deny,
  openAnswer,
  t,
  onAct,
  onOpen,
  onToggleAnswer
}: ActionButtonProps): ReactElement | null {
  if (action === 'approve' || action === 'deny') {
    const recipe = action === 'approve' ? approve : deny
    if (!recipe) return null
    return (
      <button
        type="button"
        className={`btn sm ${action === 'approve' ? 'approve' : 'deny'}`}
        title={fill(t, 'sendsKeys', { keys: recipe.preview })}
        onClick={() => onAct(item.id, action)}
      >
        {action === 'approve' ? <Check /> : <X />}
        {t(ACTION_KEY[action])}
        <Keycaps recipe={recipe.keys} />
      </button>
    )
  }

  if (action === 'answer') {
    return (
      <button type="button" className="btn sm" data-open={openAnswer || undefined} onClick={onToggleAnswer}>
        <MessageSquare />
        {t(ACTION_KEY[action])}
      </button>
    )
  }

  if (action === 'open') {
    return (
      <button type="button" className="btn sm" onClick={() => onOpen(item)}>
        <CornerUpRight />
        {t(ACTION_KEY[action])}
      </button>
    )
  }

  const icon =
    action === 'snooze' ? (
      <Clock />
    ) : action === 'done' ? (
      <CheckCheck />
    ) : action === 'reprompt' ? (
      <RotateCcw />
    ) : (
      <EyeOff />
    )
  const label =
    action === 'snooze' ? fill(t, 'actionSnooze', { n: DEFAULT_SNOOZE_MINUTES }) : t(ACTION_KEY[action])
  return (
    <button
      type="button"
      className="btn ghost sm"
      onClick={() =>
        onAct(item.id, action, action === 'snooze' ? { minutes: DEFAULT_SNOOZE_MINUTES } : {})
      }
    >
      {icon}
      {label}
    </button>
  )
}

/** The literal keys a decision will press, drawn on the button that presses them. */
function Keycaps({ recipe }: { recipe: readonly string[] }): ReactElement {
  return (
    <span className="keycap">
      {recipe.map((key, index) => (
        <kbd key={`${key}-${index}`}>{key}</kbd>
      ))}
    </span>
  )
}
