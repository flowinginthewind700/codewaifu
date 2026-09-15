/**
 * The recovery tab (F5): what survives a crash, and how to put it back.
 *
 * The service plans recovery for *every* task; this panel shows only the ones
 * with something to do. `intact` is the normal case, and listing thirty green
 * rows to say "nothing is broken" is the kind of noise that trains people to
 * ignore the tab. `parked` is filtered too: a task the human deliberately
 * stopped is not a disaster, and recovery is contractually forbidden to touch it.
 *
 * An offline herdr short-circuits everything. Without it no fact can be probed,
 * so every task would carry the same `offline` verdict; one honest sentence
 * beats a list of identical guesses.
 */
import { useMemo, type ReactElement } from 'react'
import { Play, RotateCcw } from 'lucide-react'
import type { RecoveryPlan, RecoveryVerdict } from '@shared/pro'
import { fill, type StringKey, type Translate } from './i18n'
import { PlanSteps } from './PlanSteps'

export interface RecoveryPanelProps {
  plans: RecoveryPlan[]
  herdrOnline: boolean
  t: Translate
  onApply: (taskId: string) => void
  onApplyAll: () => void
  onReprompt: (taskId: string) => void
  onOpenTask: (taskId: string) => void
}

const VERDICT_KEY: Record<RecoveryVerdict, StringKey> = {
  intact: 'verdictIntact',
  resumable: 'verdictResumable',
  rebuild: 'verdictRebuild',
  lost: 'verdictLost',
  offline: 'verdictOffline',
  parked: 'verdictParked'
}

/** Verdicts that do not earn a row here. */
export const HIDDEN_VERDICTS: readonly RecoveryVerdict[] = ['intact', 'parked']

/**
 * Which plans this panel would actually render, as a pure function.
 *
 * The bench needs the same filter the panel uses to draw the tab's count badge,
 * and the only way to keep those two numbers from drifting apart is to compute
 * both from one predicate. Tests pin it too: it encodes a product decision
 * ("do not show me green rows"), not a rendering detail.
 */
export function needsRecovery(plans: readonly RecoveryPlan[]): RecoveryPlan[] {
  return plans.filter((plan) => !HIDDEN_VERDICTS.includes(plan.verdict))
}

export function RecoveryPanel({
  plans,
  herdrOnline,
  t,
  onApply,
  onApplyAll,
  onReprompt,
  onOpenTask
}: RecoveryPanelProps): ReactElement {
  const shown = useMemo(() => needsRecovery(plans), [plans])

  if (!herdrOnline) {
    return (
      <div className="panel-scroll">
        <p className="empty-note">{t('recoveryOffline')}</p>
      </div>
    )
  }

  if (!shown.length) {
    return (
      <div className="panel-scroll">
        <p className="empty-note">{t('recoveryEmpty')}</p>
      </div>
    )
  }

  const anyActionable = shown.some((plan) => plan.actionable)

  return (
    <>
      <div className="panel-scroll">
        {anyActionable && (
          <div className="recovery-bar">
            <button type="button" className="btn primary sm" onClick={onApplyAll}>
              <Play />
              {t('applyAll')}
            </button>
          </div>
        )}
        {shown.map((plan) => (
          <article className="plan" key={plan.taskId}>
            <div className="plan-head">
              <span className="verdict" data-verdict={plan.verdict}>
                {t(VERDICT_KEY[plan.verdict])}
              </span>
              <button
                type="button"
                className="plan-title"
                title={plan.taskId}
                onClick={() => onOpenTask(plan.taskId)}
              >
                {plan.title || t('whereUnknown')}
              </button>
            </div>
            {plan.reason && <p className="plan-reason">{plan.reason}</p>}
            <PlanSteps steps={plan.steps} t={t} />
            <div className="plan-actions">
              <button
                type="button"
                className="btn primary sm"
                disabled={!plan.actionable}
                onClick={() => onApply(plan.taskId)}
              >
                <Play />
                {t('applyPlan')}
              </button>
              {plan.rePrompt && (
                <button type="button" className="btn sm" onClick={() => onReprompt(plan.taskId)}>
                  <RotateCcw />
                  {t('reprompt')}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      <div className="panel-foot">{fill(t, 'recoveryCount', { n: shown.length })}</div>
    </>
  )
}
