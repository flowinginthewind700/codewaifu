// ============================================================
// 「汇报一下现在的 coding 状态」—— 把线程表压成一句能读、也能念出来的话。
//
// 为什么在 shared 而不是渲染层:这段是纯数据 → 文案,没有 DOM、没有 React,
// 放这里就能在 vitest 里直接断言(排序、上限、双语、空态),而不用起 Electron。
// 气泡文本与播报文本是**两份**:气泡可以列条目,播报要是一句连贯的人话
// (而且要短 —— main 的 toSpeakable 会在 400 字处砍断)。
// ============================================================
import type { Agent, EventKind, Lang } from './protocol'

/** composeStatusReport 需要的线程字段(ThreadInfo 的子集,方便测试喂假数据)。 */
export interface ReportThread {
  agent: Agent
  title: string
  cwd: string
  updatedAt: number
  live: boolean
  lastKind: EventKind | ''
  lastDetail?: string
}

export interface ReportInput {
  threads: readonly ReportThread[]
  /** 毫秒时间戳;由调用方给,函数内部不读时钟(可测)。 */
  now: number
  /** 最多展开几个会话;其余合并成「另外还有 N 个」。 */
  maxDetail?: number
}

export interface StatusReport {
  /** 气泡首行:总量与运行数。 */
  headline: string
  /** 气泡正文行,一条会话一行(已按 maxDetail 截断)。 */
  lines: string[]
  /** headline + lines,用 \n 连接(气泡按 pre-line 渲染)。 */
  bubble: string
  /** 播报稿:一句连贯的话,长度已在预算内。 */
  speak: string
  running: number
  total: number
}

/** 默认展开的会话数:再多气泡就比她的舞台还高了。 */
export const REPORT_MAX_DETAIL = 3

/** 播报稿的长度预算(字符)。main 在 400 处硬砍,这里留出余量。 */
export const SPEAK_BUDGET = 340

/** 超过这个年龄的会话不再单独点名(只进总数),否则汇报变成念旧账。 */
const RECENT_MS = 24 * 60 * 60 * 1000

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 会话状态:运行中 / 刚完成 / 空闲。 */
export type ThreadState = 'running' | 'finished' | 'idle'

export function threadState(thread: ReportThread): ThreadState {
  if (thread.live) return 'running'
  return thread.lastKind === 'stop' ? 'finished' : 'idle'
}

/** 目录名当项目名:比线程标题短,也更适合念出来。 */
export function projectName(cwd: string): string {
  if (!cwd) return ''
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/** 会话的称呼:项目名优先,退回标题(线程刚起、cwd 还没写进记录时会这样)。 */
export function threadName(thread: ReportThread): string {
  return projectName(thread.cwd) || thread.title || thread.agent
}

/** 相对时间的粗档位;两个 UI(线程列表 / 汇报)共用同一套判据。 */
export function ageBucket(at: number, now: number): { unit: 'now' | 'minute' | 'hour' | 'day'; value: number } {
  if (!at || !Number.isFinite(at)) return { unit: 'day', value: 0 }
  const ms = Math.max(0, now - at)
  if (ms < 45 * 1000) return { unit: 'now', value: 0 }
  if (ms < HOUR) return { unit: 'minute', value: Math.max(1, Math.round(ms / MINUTE)) }
  if (ms < DAY) return { unit: 'hour', value: Math.max(1, Math.round(ms / HOUR)) }
  return { unit: 'day', value: Math.max(1, Math.round(ms / DAY)) }
}

const AGE: Record<'now' | 'minute' | 'hour' | 'day', Record<Lang, (n: number) => string>> = {
  now: { zh: () => '刚刚', en: () => 'just now' },
  minute: { zh: (n) => `${n} 分钟前`, en: (n) => `${n} min ago` },
  hour: { zh: (n) => `${n} 小时前`, en: (n) => `${n} h ago` },
  day: { zh: (n) => `${n} 天前`, en: (n) => `${n} d ago` }
}

export function ageLabel(at: number, now: number, lang: Lang): string {
  const bucket = ageBucket(at, now)
  if (bucket.unit === 'day' && bucket.value === 0) return ''
  return AGE[bucket.unit][lang](bucket.value)
}

const STATE_WORD: Record<ThreadState, Record<Lang, string>> = {
  running: { zh: '运行中', en: 'running' },
  finished: { zh: '刚完成', en: 'just finished' },
  idle: { zh: '空闲', en: 'idle' }
}

const AGENT_WORD: Record<string, Record<Lang, string>> = {
  codex: { zh: 'Codex', en: 'Codex' },
  claude: { zh: 'Claude', en: 'Claude' }
}

function agentWord(agent: string, lang: Lang): string {
  return AGENT_WORD[agent]?.[lang] ?? agent
}

/**
 * 运行中的排前面,其余按最近更新排序;并列时 agent 名兜底,保证输出稳定
 * (汇报每次点出来的顺序不该乱跳)。
 */
export function sortThreads(threads: readonly ReportThread[]): ReportThread[] {
  return [...threads].sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1
    if (b.updatedAt !== a.updatedAt) return (b.updatedAt || 0) - (a.updatedAt || 0)
    return a.agent.localeCompare(b.agent)
  })
}

/**
 * 汇总当前 coding 状态。
 *
 * 只点名「正在跑的」和「24 小时内有动静的」,最多 maxDetail 条;剩下的进总数。
 * 播报稿按子句拼装并卡在 SPEAK_BUDGET 内,宁可少说一个会话也不说半句。
 */
export function composeStatusReport(input: ReportInput, lang: Lang): StatusReport {
  const now = Number.isFinite(input.now) ? input.now : 0
  const maxDetail = Math.max(0, input.maxDetail ?? REPORT_MAX_DETAIL)
  const sorted = sortThreads(input.threads ?? [])
  const total = sorted.length
  const running = sorted.filter((thread) => thread.live).length

  if (total === 0) {
    const headline = lang === 'zh' ? '还没有会话' : 'No threads yet'
    const line =
      lang === 'zh'
        ? '打开 Codex 或 Claude Code，我就能盯着它们的进度。'
        : 'Start Codex or Claude Code and I will watch them for you.'
    return {
      headline,
      lines: [line],
      bubble: `${headline}\n${line}`,
      speak: lang === 'zh' ? `${headline}。${line}` : `${headline}. ${line}`,
      running: 0,
      total: 0
    }
  }

  const detail = sorted
    .filter((thread) => thread.live || now - (thread.updatedAt || 0) <= RECENT_MS)
    .slice(0, maxDetail)

  const lines = detail.map((thread) => {
    const state = STATE_WORD[threadState(thread)][lang]
    const age = ageLabel(thread.updatedAt, now, lang)
    const tail = [state, age].filter(Boolean).join(' · ')
    return `${thread.agent} · ${threadName(thread)} — ${tail}`
  })

  const headline =
    lang === 'zh'
      ? running > 0
        ? `${running} 个在跑 · 共 ${total} 个会话`
        : `没有正在跑的 · 共 ${total} 个会话`
      : running > 0
        ? `${running} running · ${total} threads`
        : `nothing running · ${total} threads`

  const speak = composeSpeak({ detail, running, total, lang })
  return { headline, lines, bubble: [headline, ...lines].join('\n'), speak, running, total }
}

/**
 * 「另外还有 N 个会话」—— N 是**听众没听到**的数量,不是被 maxDetail 切掉的
 * 数量:播报稿还会因为长度预算再砍一刀,砍掉的同样要说清楚,否则她念到一半
 * 就停,听起来像丢了会话。返回空串表示全都点过名了。
 */
function tailFor(left: number, lang: Lang): string {
  if (left <= 0) return ''
  return lang === 'zh'
    ? `另外还有 ${left} 个会话。`
    : `${left} more ${left === 1 ? 'thread' : 'threads'}.`
}

function composeSpeak(args: {
  detail: readonly ReportThread[]
  running: number
  total: number
  lang: Lang
}): string {
  const { detail, running, total, lang } = args
  const zh = lang === 'zh'
  const clauses: string[] = []

  if (running > 0) {
    clauses.push(
      zh
        ? `现在有 ${running} 个 agent 在干活。`
        : `${running} ${running === 1 ? 'agent is' : 'agents are'} working right now.`
    )
  } else {
    clauses.push(zh ? '现在没有 agent 在跑。' : 'Nothing is running right now.')
  }

  const join = (parts: readonly string[]): string => parts.filter(Boolean).join(zh ? '' : ' ')
  const head = clauses[0]

  /** 点名到第几条时,尾句会怎么念;预算要连它一起算。 */
  const withTail = (named: readonly string[]): string => {
    const left = total - named.length
    return named.length ? tailFor(left, lang) : ''
  }

  const named: string[] = []
  for (const thread of detail) {
    const state = threadState(thread)
    const verb =
      state === 'running'
        ? zh
          ? '正在跑'
          : 'is running'
        : state === 'finished'
          ? zh
            ? '刚完成'
            : 'just finished'
          : zh
            ? '空闲'
            : 'is idle'
    const clause = zh
      ? `${agentWord(thread.agent, lang)} 在 ${threadName(thread)},${verb}。`
      : `${agentWord(thread.agent, lang)} ${verb} in ${threadName(thread)}.`
    // 预留尾句的字数:宁可少点名一个,也要把「另外还有 N 个」说完。
    const prospective = [...named, clause]
    if (join([head, ...prospective, withTail(prospective)]).length > SPEAK_BUDGET) break
    named.push(clause)
  }

  if (named.length === 0) {
    // 有会话但一个都没点名(都太旧):说清总量,「另外还有」在这里不成立
    const fallback =
      total > 0
        ? zh
          ? `一共 ${total} 个会话。`
          : `${total} ${total === 1 ? 'thread' : 'threads'} in total.`
        : ''
    return join([head, fallback])
  }
  return join([head, ...named, withTail(named)])
}
