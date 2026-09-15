/**
 * One recovery plan's steps, spelled out.
 *
 * Shared by the recovery tab and the task card's banner, because the rule is the
 * same in both places: a plan is shown in full before `Apply` is offered. Pressing
 * a button that runs four shell commands you never read is not a cockpit.
 */
import type { ReactElement } from 'react'
import { recoveryStepText } from '@shared/pro'
import type { RecoveryStep } from '@shared/pro'
import type { Translate } from './i18n'

const STEP_KEY = {
  workspace: 'stepWorkspace',
  worktree: 'stepWorktree',
  agent: 'stepAgent',
  prompt: 'stepPrompt',
  notice: 'stepNotice'
} as const

export function PlanSteps({ steps, t }: { steps: RecoveryStep[]; t: Translate }): ReactElement | null {
  if (!steps.length) return null
  return (
    <ol className="steps">
      {steps.map((step, index) => (
        <li key={`${step.kind}-${index}`}>
          <span className="step-kind">{t(STEP_KEY[step.kind])}</span>
          <span className="step-body">{recoveryStepText(step)}</span>
        </li>
      ))}
    </ol>
  )
}
