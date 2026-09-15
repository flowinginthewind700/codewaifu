/**
 * The two-way link between the Bench and the desktop companion (F7).
 *
 * One state, two surfaces. The Bench is where a human who is looking at the
 * screen spends attention; the widget is where a human who is not still finds
 * out that something needs them. Neither owns anything: both render
 * `ProService` state and both issue the same commands back into it. That is what
 * makes the badge and the queue unable to disagree, and what makes a bubble
 * click land on the exact pane that asked.
 *
 * Everything here is pure. Text, expressions, summon policy and command
 * resolution are functions of their arguments, so the link is testable without
 * Electron, and the main-process bridge is left as the only thing that can fail.
 */
import type { Lang } from './protocol'
import type { BubbleRoute, Expression } from './ui'
import {
  attentionActions,
  needsMeCount,
  type AttentionAction,
  type AttentionItem,
  type AttentionKind,
  type BenchView,
  type StateCounts
} from './pro'

/* ------------------------------------------------------------------ *
 * Widget -> Bench, and Bench -> widget
 * ------------------------------------------------------------------ */

/** What the Bench (or an HTTP caller) asks the widget to do. */
export type CompanionCommand =
  | { type: 'summon' }
  | { type: 'dismiss' }
  | { type: 'toggle' }
  | { type: 'announce'; text: string; lang: Lang }

/** What the widget asks the Bench to do. */
export type BenchCommand =
  | { type: 'openBench' }
  | { type: 'focusTask'; taskId: string; paneId?: string }
  | {
      type: 'act'
      action: AttentionAction
      itemId: string
      taskId: string
      paneId?: string
      text?: string
    }
  | { type: 'snoozeAll'; minutes: number }

/**
 * A command after it has been checked against current bench state. The widget
 * holds stale data by nature (a bubble can outlive the item that made it), so
 * resolution is where "the task is gone" turns into a useful degradation rather
 * than a silent no-op.
 */
export type ResolvedCommand =
  | { type: 'openBench'; reason: string }
  | { type: 'focus'; taskId: string; paneId: string }
  | { type: 'act'; action: AttentionAction; itemId: string; taskId: string; paneId: string; text: string }
  | { type: 'snoozeAll'; minutes: number }
  | { type: 'drop'; reason: string }

export function resolveCommand(command: BenchCommand, view: BenchView | null): ResolvedCommand {
  if (!view) return { type: 'openBench', reason: 'bench state unavailable' }
  switch (command.type) {
    case 'openBench':
      return { type: 'openBench', reason: 'requested' }
    case 'snoozeAll': {
      const minutes = Math.min(240, Math.max(1, Math.round(command.minutes || 10)))
      return { type: 'snoozeAll', minutes }
    }
    case 'focusTask':
      return resolveFocus(command.taskId, command.paneId ?? '', view)
    case 'act': {
      const item = view.attention.find((entry) => entry.id === command.itemId)
      if (!item) {
        // The item was answered elsewhere (the Bench, the HTTP API, or the
        // agent moved on). Show the task if it still exists; otherwise the bench.
        const fallback = resolveFocus(command.taskId, command.paneId ?? '', view)
        return fallback.type === 'drop' ? { type: 'openBench', reason: 'item resolved' } : fallback
      }
      if (!attentionActions(item.kind).includes(command.action)) {
        return { type: 'drop', reason: `${command.action} is not valid for ${item.kind}` }
      }
      const text = String(command.text ?? '').trim()
      if (command.action === 'answer' && !text) {
        return { type: 'drop', reason: 'an answer needs text' }
      }
      const focus = resolveFocus(item.taskId, item.paneId, view)
      return {
        type: 'act',
        action: command.action,
        itemId: item.id,
        taskId: item.taskId,
        paneId: focus.type === 'focus' ? focus.paneId : item.paneId,
        text
      }
    }
  }
}

function resolveFocus(taskId: string, paneId: string, view: BenchView): ResolvedCommand {
  const task = view.tasks.find((entry) => entry.id === taskId)
  if (!task) return { type: 'drop', reason: 'task no longer exists' }
  const wanted = task.panes.find((pane) => pane.paneId === paneId)
  const chosen = wanted ?? task.panes[0]
  return { type: 'focus', taskId: task.id, paneId: chosen?.paneId ?? '' }
}

/* ------------------------------------------------------------------ *
 * Summon policy
 * ------------------------------------------------------------------ */

export type SummonPolicy = 'always' | 'blocking' | 'never'

export function summonPolicyOf(value: unknown): SummonPolicy {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return raw === 'always' || raw === 'never' ? raw : 'blocking'
}

/** Kinds that mean "an agent is sitting still waiting for you". */
const BLOCKING_KINDS: readonly AttentionKind[] = ['permission', 'question', 'failed']

export function isBlocking(kind: AttentionKind | string): boolean {
  return BLOCKING_KINDS.includes(kind as AttentionKind)
}

/**
 * Should this item pull the widget onto the screen? Popping her up while the
 * human is already reading the queue in the Bench is the fastest way to get the
 * feature turned off, so a focused Bench suppresses the summon but never the
 * badge or the bubble.
 */
export function shouldSummon(input: {
  policy: SummonPolicy
  kind: AttentionKind | string
  benchFocused: boolean
  widgetVisible: boolean
}): boolean {
  if (input.policy === 'never') return false
  if (input.benchFocused) return false
  if (input.widgetVisible) return false
  if (input.policy === 'blocking') return isBlocking(input.kind)
  return true
}

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

export interface NoticeInput {
  item: AttentionItem
  lang: Lang
  now: number
  /** Live queue length, for "and 3 more". */
  count: number
  /** Position in the queue, 1-based. */
  position: number
}

interface Template {
  text: (title: string, extra: string) => string
  speak: (title: string) => string
}

const TEMPLATES: Record<AttentionKind, Record<Lang, Template>> = {
  permission: {
    zh: {
      text: (title, extra) => `${title} 需要授权${extra ? `：${extra}` : ''}`,
      speak: (title) => `${title} 在等你授权`
    },
    en: {
      text: (title, extra) => `${title} needs approval${extra ? `: ${extra}` : ''}`,
      speak: (title) => `${title} is waiting for approval`
    }
  },
  question: {
    zh: {
      text: (title, extra) => `${title} 有个问题${extra ? `：${extra}` : ''}`,
      speak: (title) => `${title} 在问你问题`
    },
    en: {
      text: (title, extra) => `${title} is asking something${extra ? `: ${extra}` : ''}`,
      speak: (title) => `${title} has a question for you`
    }
  },
  review: {
    zh: {
      text: (title) => `${title} 做完了，等你过一眼`,
      speak: (title) => `${title} 完成了，等你 review`
    },
    en: {
      text: (title) => `${title} is done and waiting for review`,
      speak: (title) => `${title} finished and wants a review`
    }
  },
  failed: {
    zh: {
      text: (title, extra) => `${title} 挂了${extra ? `：${extra}` : ''}`,
      speak: (title) => `${title} 失败了`
    },
    en: {
      text: (title, extra) => `${title} failed${extra ? `: ${extra}` : ''}`,
      speak: (title) => `${title} failed`
    }
  },
  stalled: {
    zh: {
      text: (title, extra) => `${title} 卡住了${extra ? `（${extra}）` : ''}`,
      speak: (title) => `${title} 好像卡住了`
    },
    en: {
      text: (title, extra) => `${title} looks stalled${extra ? ` (${extra})` : ''}`,
      speak: (title) => `${title} looks stalled`
    }
  }
}

const MORE: Record<Lang, (n: number) => string> = {
  zh: (n) => `（还有 ${n} 个在等）`,
  en: (n) => ` (+${n} more waiting)`
}

const OPEN_LABEL: Record<Lang, string> = { zh: '在 Bench 中打开', en: 'Open in Bench' }

function clip(text: string, max: number): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/**
 * The one line of context that makes a bubble actionable: the command for a
 * permission prompt, the question for a question, how long for a stall.
 */
export function noticeExtra(item: AttentionItem, lang: Lang, now: number): string {
  if (item.kind === 'permission') return clip(item.command || item.toolName || item.detail, 80)
  if (item.kind === 'question') return clip(item.detail || item.title, 90)
  if (item.kind === 'stalled' || item.kind === 'review' || item.kind === 'failed') {
    const mins = Math.max(1, Math.round((now - item.since) / 60000))
    if (item.kind === 'failed') return clip(item.detail, 80)
    return lang === 'zh' ? `${mins} 分钟` : `${mins}m`
  }
  return ''
}

/** Bubble text and the shorter line to say out loud. */
export function noticeText(input: NoticeInput): { text: string; speak: string } {
  const { item, lang, now, count, position } = input
  const template = TEMPLATES[item.kind]?.[lang] ?? TEMPLATES.review[lang]
  const extra = noticeExtra(item, lang, now)
  const title = clip(item.taskTitle || item.groupLabel || (lang === 'zh' ? '任务' : 'task'), 40)
  let text = clip(template.text(title, extra), 140)
  const remaining = count - position
  if (remaining > 0) text = clip(`${text} ${MORE[lang](remaining)}`, 160)
  return { text, speak: template.speak(title) }
}

/** Which face she wears. Mirrors `expressionForKind` for hook bubbles. */
export function expressionForNotice(kind: AttentionKind | string, speaking: boolean): Expression {
  if (speaking) return 'talk'
  if (kind === 'permission' || kind === 'question' || kind === 'failed') return 'alert'
  if (kind === 'review') return 'happy'
  if (kind === 'stalled') return 'sleepy'
  return 'idle'
}

/**
 * Her resting face while nothing is being announced: worried when the fleet is
 * blocked, pleased when the queue is empty and something is running, asleep when
 * nothing is happening at all. A glance at the widget answers "do I need to go
 * back?" without reading a number.
 */
export function expressionForBench(counts: StateCounts, speaking: boolean): Expression {
  if (speaking) return 'talk'
  if (counts.blocked > 0 || counts.needsMe > 0) return 'alert'
  if (counts.working > 0) return 'idle'
  if (counts.done > 0) return 'happy'
  if (counts.total === 0) return 'idle'
  return 'sleepy'
}

/** The route a bubble carries, so a click knows where to land. */
export function routeFor(item: AttentionItem, lang: Lang): BubbleRoute {
  return {
    taskId: item.taskId,
    paneId: item.paneId,
    itemId: item.id,
    kind: item.kind,
    actions: attentionActions(item.kind),
    benchLabel: OPEN_LABEL[lang]
  }
}

/** One number, three renders: tray badge, widget bubble, tree header. */
export function badgeFor(view: BenchView): number {
  return needsMeCount(view.attention, view.generatedAt)
}

/* ------------------------------------------------------------------ *
 * Recovery chatter
 * ------------------------------------------------------------------ */

export interface RecoveryNotice {
  resumable: number
  rebuild: number
  lost: number
}

export function recoveryCounts(view: BenchView): RecoveryNotice {
  const out: RecoveryNotice = { resumable: 0, rebuild: 0, lost: 0 }
  for (const plan of view.recovery) {
    if (plan.verdict === 'resumable') out.resumable += 1
    else if (plan.verdict === 'rebuild') out.rebuild += 1
    else if (plan.verdict === 'lost') out.lost += 1
  }
  return out
}

/**
 * The line she says on boot when work survived an interruption. This is the
 * moment the intent ledger proves itself, so it gets spoken, not just badged:
 * "three tasks can be resumed" is the difference between a reboot costing
 * nothing and costing an afternoon.
 */
export function recoveryText(counts: RecoveryNotice, lang: Lang): string {
  const total = counts.resumable + counts.rebuild + counts.lost
  if (!total) return ''
  if (lang === 'zh') {
    const parts: string[] = []
    if (counts.resumable) parts.push(`${counts.resumable} 个可以直接恢复`)
    if (counts.rebuild) parts.push(`${counts.rebuild} 个要重建目录`)
    if (counts.lost) parts.push(`${counts.lost} 个只剩意图`)
    return `工作台回来了：${parts.join('，')}`
  }
  const parts: string[] = []
  if (counts.resumable) parts.push(`${counts.resumable} resumable`)
  if (counts.rebuild) parts.push(`${counts.rebuild} to rebuild`)
  if (counts.lost) parts.push(`${counts.lost} intent-only`)
  return `Bench is back: ${parts.join(', ')}`
}
