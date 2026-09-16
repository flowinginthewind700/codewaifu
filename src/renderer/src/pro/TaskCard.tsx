/**
 * The task card (F2): everything you need to *decide*, none of what you need to
 * read. The terminal below it is for reading.
 *
 * The two intent lines are the point of the whole feature. Goal is what the task
 * was for; Next is the single most useful sentence in a cockpit, because it is
 * the one thing you cannot reconstruct from a terminal scrollback after a crash
 * or a day away. Both come from the ledger, which is why this card owns a digest
 * fetch of its own: the projection that arrives on every state push deliberately
 * does not carry it (see the note in LedgerPanel).
 *
 * Verbs split by blast radius. Anything that only touches this window or sends
 * text to a pane is done here. Anything that mutates the task record - status,
 * removal - is handed to the Bench, because selection and the confirm dialog
 * live there and a second owner of that state is how a removed task stays
 * selected.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import {
  CheckCheck,
  FolderOpen,
  Hand,
  MessageSquare,
  Pause,
  Play,
  RotateCcw,
  Send,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import type { LedgerDigest, RecoveryPlan, RecoveryVerdict, TaskView } from '@shared/pro'
import { fill, type StringKey, type Translate } from './i18n'
import { ago } from './time'
import type { Tone } from './toast'
import { proApi } from './api'
import { PlanSteps } from './PlanSteps'

export interface TaskCardProps {
  task: TaskView
  plan: RecoveryPlan | null
  /** Bumped by the Bench when this task's ledger changed, so the digest refetches. */
  revision: number
  now: number
  t: Translate
  onNotify: (text: string, tone?: Tone) => void
  onStatus: (status: 'active' | 'parked' | 'done') => void
  onRemove: () => void
}

const STATUS_KEY: Record<TaskView['status'], StringKey> = {
  active: 'statusActive',
  parked: 'statusParked',
  done: 'statusDone',
  lost: 'statusLost'
}

/** Verdicts that earn a banner. Everything else is either fine or the human's doing. */
const BANNER: readonly RecoveryVerdict[] = ['resumable', 'rebuild', 'lost']

export function TaskCard({
  task,
  plan,
  revision,
  now,
  t,
  onNotify,
  onStatus,
  onRemove
}: TaskCardProps): ReactElement {
  const [digest, setDigest] = useState<LedgerDigest | null>(null)
  const [steering, setSteering] = useState(false)
  const [draft, setDraft] = useState('')

  const paneId = task.panes[0]?.paneId ?? ''
  const goal = digest?.goal || task.goal
  const next = digest?.next || ''
  const session = digest?.sessionValue || task.agentSessionId || ''
  const branch = task.branch || digest?.branch || ''
  const agent = task.agentKind || digest?.agent || task.panes[0]?.displayAgent || ''

  useEffect(() => {
    let cancelled = false
    setDigest(null)
    void proApi.ledger.digest(task.id).then((value) => {
      if (!cancelled) setDigest(value)
    })
    return () => {
      cancelled = true
    }
  }, [task.id, revision])

  // Leaving the task must not leave a half-typed steer behind for the next one.
  useEffect(() => {
    setSteering(false)
    setDraft('')
  }, [task.id])

  const steer = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (!text) return
    if (!paneId) {
      // No terminal of ours to type into - an imported session is still running
      // in the human's own console. The queue/clipboard path reaches it anyway,
      // and it reports which of the two happened instead of claiming a delivery.
      const sent = await proApi.task.steer(task.id, text)
      const delivered = sent.data
      if (!sent.ok || !delivered) {
        onNotify(sent.detail || sent.code || t('steerFailed'), 'error')
        return
      }
      onNotify(delivered.message || t('steerFailed'), delivered.ok ? 'ok' : 'warn')
      if (delivered.ok) {
        setDraft('')
        setSteering(false)
      }
      return
    }
    const result = await proApi.pane.send(paneId, text)
    if (!result.ok) {
      onNotify(result.detail || result.code, 'error')
      return
    }
    // No success toast: the line appears in the terminal a hundred pixels below.
    setDraft('')
    setSteering(false)
  }, [draft, onNotify, paneId, t, task.id])

  const interrupt = useCallback(async (): Promise<void> => {
    if (!paneId) {
      onNotify(t('steerNoPane'), 'warn')
      return
    }
    const result = await proApi.pane.keys(paneId, ['esc'])
    if (!result.ok) {
      onNotify(result.detail || result.code, 'error')
      return
    }
    onNotify(t('interruptSent'), 'ok')
  }, [onNotify, paneId, t])

  const handoff = useCallback(async (): Promise<void> => {
    const result = await proApi.recovery.handoff(task.id)
    const text = result.data?.text ?? ''
    if (!result.ok || !text) {
      onNotify(result.detail || result.code || t('handoffFailed'), 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      onNotify(t('handoffCopied'), 'ok')
    } catch {
      onNotify(t('handoffFailed'), 'error')
    }
  }, [onNotify, t, task.id])

  const reveal = useCallback(async (): Promise<void> => {
    const result = await proApi.host.openPath(task.workdir || task.repoRoot)
    if (!result.ok) onNotify(result.detail || result.code, 'error')
  }, [task.repoRoot, task.workdir, onNotify])

  const reprompt = useCallback(async (): Promise<void> => {
    const result = await proApi.recovery.reprompt(task.id)
    if (!result.ok) onNotify(result.detail || result.code, 'error')
  }, [onNotify, task.id])

  const apply = useCallback(async (): Promise<void> => {
    const result = await proApi.recovery.apply(task.id)
    if (!result.ok) onNotify(result.detail || result.code, 'error')
  }, [onNotify, task.id])

  const banner = plan && BANNER.includes(plan.verdict) ? plan : null

  return (
    <section className="task-card">
      <div className="task-card-head">
        <span className="dot" data-state={task.liveStatus} title={task.liveStatus} />
        <h2 className="task-card-title" title={task.title}>
          {task.title || t('unfiled')}
        </h2>
        <span className="spacer" />
        {agent && <span className="tag">{agent}</span>}
        <span className="pill quiet">{t(STATUS_KEY[task.status])}</span>
      </div>

      <div className="intent">
        <div className="intent-row">
          <span className="section-label">{t('goalLabel')}</span>
          <p data-empty={!goal}>{goal || t('emptyGoal')}</p>
        </div>
        <div className="intent-row">
          <span className="section-label">{t('nextLabel')}</span>
          <p className="next" data-empty={!next}>
            {next || t('emptyNext')}
          </p>
        </div>
      </div>

      <dl className="facts">
        <Fact label={t('factBranch')} value={branch} empty="—" />
        <Fact
          label={t('factDirty')}
          value={task.dirty > 0 ? fill(t, 'dirtyCount', { n: task.dirty }) : ''}
          empty="0"
        />
        <Fact label={t('factSession')} value={shortId(session)} empty="—" title={session} />
        <Fact
          label={t('factTokens')}
          value={task.tokens > 0 ? String(task.tokens) : ''}
          empty="0"
        />
        <Fact
          label={t('factLast')}
          value={ago(task.lastActivityAt, now, t)}
          empty={t('never')}
          plain
        />
        <Fact label={t('factWorkdir')} value={task.workdir} empty="—" title={task.workdir} />
      </dl>

      {banner && (
        <div className="banner" data-tone={banner.verdict === 'lost' ? 'lost' : 'warn'}>
          <div className="banner-head">
            <TriangleAlert />
            <span className="banner-title">{t('recoveryBanner')}</span>
            <span className="banner-reason">{banner.reason}</span>
          </div>
          <PlanSteps steps={banner.steps} t={t} />
          <div className="banner-actions">
            <button
              type="button"
              className="btn primary sm"
              disabled={!banner.actionable}
              onClick={() => void apply()}
            >
              <Play />
              {t('applyPlan')}
            </button>
            {banner.rePrompt && (
              <button type="button" className="btn sm" onClick={() => void reprompt()}>
                <RotateCcw />
                {t('reprompt')}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="verbs">
        <button
          type="button"
          className="btn sm"
          data-open={steering || undefined}
          onClick={() => setSteering((open) => !open)}
        >
          <MessageSquare />
          {t('verbSteer')}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          disabled={!paneId}
          title={t('verbInterrupt')}
          onClick={() => void interrupt()}
        >
          <Hand />
          {t('verbInterrupt')}
        </button>
        <button type="button" className="btn ghost sm" onClick={() => void handoff()}>
          <Send />
          {t('verbHandoff')}
        </button>
        <button type="button" className="btn ghost sm" onClick={() => void reveal()}>
          <FolderOpen />
          {t('verbReveal')}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => onStatus(task.status === 'parked' ? 'active' : 'parked')}
        >
          {task.status === 'parked' ? <Play /> : <Pause />}
          {task.status === 'parked' ? t('verbUnpark') : t('verbPark')}
        </button>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => onStatus(task.status === 'done' ? 'active' : 'done')}
        >
          <CheckCheck />
          {task.status === 'done' ? t('verbReopen') : t('verbDone')}
        </button>
        <button type="button" className="btn ghost danger sm" onClick={onRemove}>
          <Trash2 />
          {t('verbRemove')}
        </button>
      </div>

      {steering && (
        <div className="steer">
          <input
            className="input"
            autoFocus
            value={draft}
            placeholder={t('steerPlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void steer()
              } else if (event.key === 'Escape') {
                setSteering(false)
                setDraft('')
              }
            }}
          />
          <button
            type="button"
            className="btn primary sm"
            disabled={!draft.trim()}
            onClick={() => void steer()}
          >
            <Send />
            {t('answerSend')}
          </button>
        </div>
      )}
    </section>
  )
}

function Fact({
  label,
  value,
  empty,
  title,
  plain
}: {
  label: string
  value: string
  empty: string
  title?: string
  /** True for prose values, which should not be drawn in the mono face. */
  plain?: boolean
}): ReactElement {
  const filled = value !== ''
  return (
    <div>
      <dt>{label}</dt>
      <dd
        data-empty={!filled}
        className={filled && !plain ? 'mono' : undefined}
        title={title || value}
      >
        {filled ? value : empty}
      </dd>
    </div>
  )
}

/** Session ids are long and only their tail is distinguishing; keep both ends. */
function shortId(value: string, head = 6, tail = 6): string {
  const text = String(value || '').trim()
  if (text.length <= head + tail + 1) return text
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}
