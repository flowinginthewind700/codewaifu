/**
 * One recovery plan's steps, spelled out.
 *
 * Shared by the recovery tab and the task card's banner, because the rule is the
 * same in both places: a plan is shown in full before `Apply` is offered. Pressing
 * a button that runs four shell commands you never read is not a cockpit.
 */
import type { ReactElement } from 'react'
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
          <span className="step-body">{stepText(step)}</span>
        </li>
      ))}
    </ol>
  )
}

/**
 * The command-shaped summary of one step. `prompt` and `notice` collapse to one
 * line here on purpose: a 400-token re-prompt inside a banner buries the banner.
 */
function stepText(step: RecoveryStep): string {
  switch (step.kind) {
    case 'workspace':
      return step.cwd || step.label
    case 'worktree': {
      const base = step.base ? ` ${step.base}` : ''
      return `git worktree add ${step.path} -b ${step.branch}${base}`
    }
    case 'agent':
      return [step.agent, ...step.args].filter(Boolean).join(' ')
    case 'prompt':
    case 'notice':
      return oneLine(step.text)
  }
}

function oneLine(text: string, limit = 120): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}
