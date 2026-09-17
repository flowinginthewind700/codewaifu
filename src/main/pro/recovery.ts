/**
 * Recovery, IO half (F5).
 *
 * The judgement lives in `shared/pro.ts::planRecovery` and is pure: it takes a
 * task, its ledger digest and a set of probed facts, and returns a verdict plus
 * the steps that would fix it. This file owns only the two things that can
 * fail - probing the facts, and executing the steps.
 *
 * Keeping them apart is what makes the moat testable. The interesting question
 * ("is this work still alive, and if not, what does it take to bring it back?")
 * has no IO in it at all.
 */
import fs from 'node:fs'
import {
  bindTask,
  planRecovery,
  type LedgerDigest,
  type RecoveryFacts,
  type RecoveryPlan,
  type RecoveryStep,
  type TaskRecord
} from '../../shared/pro'
import { agentName, type Snapshot } from '../../shared/herdr'
import type { HerdrClient } from './herdr/client'

export interface RecoveryDeps {
  /** Live client, or null when herdr is not talking to us. */
  herdr?: () => HerdrClient | null
  /** The cached snapshot; recovery never forces a read of its own. */
  snapshot?: () => Snapshot | null
  online?: () => boolean
  /** Injectable so a test can claim a directory exists or does not. */
  exists?: (dir: string) => boolean
}

export interface AppliedStep {
  kind: RecoveryStep['kind']
  ok: boolean
  detail: string
}

export interface ApplyResult {
  taskId: string
  ok: boolean
  steps: AppliedStep[]
  /** Ids created along the way, so the registry can rebind without a probe. */
  workspaceId: string
  paneId: string
  /** Checkout path herdr reported for a recreated worktree, '' when none. */
  workdir: string
  notices: string[]
}

function defaultExists(dir: string): boolean {
  const target = String(dir || '').trim()
  if (!target) return false
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

export class Recovery {
  private readonly herdr: () => HerdrClient | null
  private readonly snapshot: () => Snapshot | null
  private readonly online: () => boolean
  private readonly exists: (dir: string) => boolean

  constructor(deps: RecoveryDeps = {}) {
    this.herdr = deps.herdr ?? (() => null)
    this.snapshot = deps.snapshot ?? (() => null)
    this.online = deps.online ?? (() => false)
    this.exists = deps.exists ?? defaultExists
  }

  /**
   * Probe the world for one task. Cheap and synchronous: the snapshot is
   * already cached, and a `statSync` on the task's own directory is one syscall.
   */
  factsFor(task: TaskRecord): RecoveryFacts {
    const snapshot = this.snapshot()
    const binding = bindTask(task, snapshot)
    const paneId = binding.paneIds[0] ?? ''
    const pane = paneId ? (snapshot?.panes.find((entry) => entry.paneId === paneId) ?? null) : null
    return {
      herdrOnline: this.online(),
      dirExists: this.exists(task.workdir) || this.exists(task.repoRoot),
      workspaceId: binding.workspaceId,
      paneId,
      sessionRef: pane?.agentSession ?? null
    }
  }

  plan(task: TaskRecord, digest: LedgerDigest | null): RecoveryPlan {
    return planRecovery({ task, digest, facts: this.factsFor(task) })
  }

  /** Every task gets a verdict. The boot screen is a list, not a search. */
  planAll(tasks: readonly TaskRecord[], digests: Record<string, LedgerDigest | null>): RecoveryPlan[] {
    return tasks.map((task) => this.plan(task, digests[task.id] ?? null))
  }

  /**
   * Execute a plan. Steps run in order and share state: the workspace step 1
   * creates is the pane step 2 launches into. A failed step stops the run
   * rather than launching an agent into a directory that does not exist.
   */
  async apply(plan: RecoveryPlan, task: TaskRecord): Promise<ApplyResult> {
    const result: ApplyResult = {
      taskId: task.id,
      ok: false,
      steps: [],
      workspaceId: task.workspaceId,
      paneId: task.paneIds[0] ?? '',
      workdir: '',
      notices: []
    }
    if (!plan.actionable || !plan.steps.length) {
      result.ok = true
      result.notices.push('nothing to apply')
      return result
    }
    const herdr = this.herdr()
    if (!herdr) {
      result.notices.push('herdr is not reachable')
      return result
    }

    for (const step of plan.steps) {
      const applied = await this.applyStep(herdr, step, result, task)
      result.steps.push(applied)
      if (applied.kind === 'notice') continue
      if (!applied.ok) return result
    }
    result.ok = result.steps.every((entry) => entry.ok)
    return result
  }

  private async applyStep(
    herdr: HerdrClient,
    step: RecoveryStep,
    result: ApplyResult,
    task: TaskRecord
  ): Promise<AppliedStep> {
    try {
      switch (step.kind) {
        case 'notice':
          result.notices.push(step.text)
          return { kind: 'notice', ok: true, detail: step.text }

        case 'workspace': {
          const created = await herdr.createWorkspace({ cwd: step.cwd, label: step.label || task.title })
          const workspaceId = created.workspace?.workspaceId ?? ''
          const paneId = created.pane?.paneId ?? ''
          if (!workspaceId || !paneId) {
            return { kind: 'workspace', ok: false, detail: `herdr returned no workspace for ${step.cwd}` }
          }
          result.workspaceId = workspaceId
          result.paneId = paneId
          return { kind: 'workspace', ok: true, detail: `workspace ${workspaceId} at ${step.cwd}` }
        }

        case 'worktree': {
          const created = await herdr.createWorktree({
            cwd: step.cwd,
            branch: step.branch || null,
            base: step.base || null,
            path: step.path || null,
            label: task.title || null
          })
          const workspaceId = created.workspace?.workspaceId ?? ''
          const paneId = created.pane?.paneId ?? ''
          const checkout = created.worktree?.checkoutPath ?? ''
          if (!workspaceId || !paneId) {
            return {
              kind: 'worktree',
              ok: false,
              detail: `worktree for ${step.branch || 'branch'} was not created`
            }
          }
          result.workspaceId = workspaceId
          result.paneId = paneId
          if (checkout) result.workdir = checkout
          return { kind: 'worktree', ok: true, detail: `worktree ${checkout || step.branch}` }
        }

        case 'agent': {
          if (!result.paneId) {
            return { kind: 'agent', ok: false, detail: 'no pane to launch into' }
          }
          const agent = await herdr.startAgent({
            // Derived, never the raw title: herdr answers `invalid_agent_name`
            // to anything that is not a lowercase ASCII slug, which would fail
            // the recovery of exactly the tasks whose names are worth reading.
            name: agentName(task.title || step.agent, task.id),
            kind: step.agent,
            paneId: result.paneId,
            args: step.args
          })
          if (!agent) {
            return { kind: 'agent', ok: false, detail: `herdr could not start ${step.agent}` }
          }
          return {
            kind: 'agent',
            ok: true,
            detail: step.args.length ? `${step.agent} ${step.args.join(' ')}` : step.agent
          }
        }

        case 'prompt': {
          if (!result.paneId) {
            return { kind: 'prompt', ok: false, detail: 'no pane to prompt' }
          }
          // `agent.prompt` submits the text. A lost task's re-prompt is the whole
          // point of the ledger, so wait for the agent to leave `idle` before
          // calling this a success rather than hoping the keystrokes landed.
          const agent = await herdr.promptAgent({
            target: result.paneId,
            text: step.text,
            wait: { until: ['working', 'blocked', 'done'], timeoutMs: 8000 }
          })
          if (!agent) {
            return { kind: 'prompt', ok: false, detail: 'the re-prompt was not accepted' }
          }
          return { kind: 'prompt', ok: true, detail: `${step.text.length} chars of context sent` }
        }
      }
    } catch (error) {
      return { kind: step.kind, ok: false, detail: errorMessage(error) }
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? 'unknown error')
}
