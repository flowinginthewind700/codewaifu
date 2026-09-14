import { describe, expect, it } from 'vitest'
import {
  REPORT_MAX_DETAIL,
  SPEAK_BUDGET,
  ageBucket,
  ageLabel,
  composeStatusReport,
  projectName,
  sortThreads,
  threadName,
  threadState,
  type ReportThread
} from '../src/shared/report'

// ============================================================
// 「汇报一下 coding 状态」的文案生成。纯函数:排序、点名上限、双语、空态、
// 以及播报稿必须卡在长度预算内(main 会在 400 字处硬砍,砍在句中很难听)。
// ============================================================

const NOW = 1_800_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function thread(over: Partial<ReportThread> = {}): ReportThread {
  return {
    agent: 'codex',
    title: '',
    cwd: '/Users/me/dev/robotworld',
    updatedAt: NOW - 3 * MIN,
    live: false,
    lastKind: '',
    ...over
  }
}

describe('threadState', () => {
  it('reads live as running, a stop event as finished, anything else as idle', () => {
    expect(threadState(thread({ live: true }))).toBe('running')
    expect(threadState(thread({ lastKind: 'stop' }))).toBe('finished')
    expect(threadState(thread({ lastKind: 'tool' }))).toBe('idle')
    expect(threadState(thread())).toBe('idle')
  })

  it('lets live win over a stale stop event', () => {
    expect(threadState(thread({ live: true, lastKind: 'stop' }))).toBe('running')
  })
})

describe('projectName / threadName', () => {
  it('takes the last path segment, on either separator', () => {
    expect(projectName('/Users/me/dev/codewaifu')).toBe('codewaifu')
    expect(projectName('C:\\Users\\me\\dev\\codewaifu\\')).toBe('codewaifu')
    expect(projectName('')).toBe('')
  })

  it('falls back to the title, then to the agent', () => {
    expect(threadName(thread({ cwd: '', title: 'fix lip-sync' }))).toBe('fix lip-sync')
    expect(threadName(thread({ cwd: '', title: '', agent: 'claude' }))).toBe('claude')
    expect(threadName(thread())).toBe('robotworld')
  })
})

describe('ageBucket / ageLabel', () => {
  it('buckets by elapsed time', () => {
    expect(ageBucket(NOW - 10_000, NOW)).toEqual({ unit: 'now', value: 0 })
    expect(ageBucket(NOW - 5 * MIN, NOW)).toEqual({ unit: 'minute', value: 5 })
    expect(ageBucket(NOW - 3 * HOUR, NOW)).toEqual({ unit: 'hour', value: 3 })
    expect(ageBucket(NOW - 2 * DAY, NOW)).toEqual({ unit: 'day', value: 2 })
  })

  it('never reports a negative age for a future timestamp', () => {
    expect(ageBucket(NOW + 5 * MIN, NOW)).toEqual({ unit: 'now', value: 0 })
  })

  it('says nothing for a missing timestamp, and localises the rest', () => {
    expect(ageLabel(0, NOW, 'zh')).toBe('')
    expect(ageLabel(NOW - 5 * MIN, NOW, 'zh')).toBe('5 分钟前')
    expect(ageLabel(NOW - 5 * MIN, NOW, 'en')).toBe('5 min ago')
    expect(ageLabel(NOW - 3 * HOUR, NOW, 'en')).toBe('3 h ago')
    expect(ageLabel(NOW - 10_000, NOW, 'zh')).toBe('刚刚')
  })
})

describe('sortThreads', () => {
  it('puts running threads first, then the most recently updated', () => {
    const sorted = sortThreads([
      thread({ cwd: '/a/old', updatedAt: NOW - DAY }),
      thread({ cwd: '/a/live', live: true, updatedAt: NOW - 10 * MIN }),
      thread({ cwd: '/a/mid', updatedAt: NOW - HOUR })
    ])
    expect(sorted.map((item) => projectName(item.cwd))).toEqual(['live', 'mid', 'old'])
  })

  it('breaks ties deterministically so the report does not shuffle between clicks', () => {
    const sorted = sortThreads([
      thread({ agent: 'claude', cwd: '/a/x', updatedAt: NOW, live: true }),
      thread({ agent: 'codex', cwd: '/a/y', updatedAt: NOW, live: true })
    ])
    expect(sorted.map((item) => item.agent)).toEqual(['claude', 'codex'])
  })

  it('does not mutate the input', () => {
    const input = [thread({ cwd: '/a/old', updatedAt: NOW - DAY }), thread({ cwd: '/a/new', live: true })]
    const before = input.map((item) => item.cwd)
    sortThreads(input)
    expect(input.map((item) => item.cwd)).toEqual(before)
  })
})

describe('composeStatusReport', () => {
  it('handles the empty case in both languages', () => {
    const zh = composeStatusReport({ threads: [], now: NOW }, 'zh')
    expect(zh.total).toBe(0)
    expect(zh.bubble).toContain('还没有会话')
    expect(zh.speak).toContain('Codex')
    const en = composeStatusReport({ threads: [], now: NOW }, 'en')
    expect(en.headline).toBe('No threads yet')
    expect(en.speak).toMatch(/^No threads yet\./)
  })

  it('names every running thread and counts the rest', () => {
    const report = composeStatusReport(
      {
        now: NOW,
        threads: [
          thread({ agent: 'codex', cwd: '/a/robotworld', live: true, updatedAt: NOW - 2 * MIN }),
          thread({ agent: 'claude', cwd: '/a/codewaifu', live: true, lastKind: 'tool', updatedAt: NOW - MIN }),
          thread({ agent: 'codex', cwd: '/a/paper', updatedAt: NOW - 2 * HOUR, lastKind: 'stop' }),
          thread({ agent: 'claude', cwd: '/a/old', updatedAt: NOW - 3 * DAY })
        ]
      },
      'zh'
    )
    expect(report.running).toBe(2)
    expect(report.total).toBe(4)
    expect(report.headline).toBe('2 个在跑 · 共 4 个会话')
    // 三个最近的被点名(两个运行中 + 两小时前完成的),三天前那个只进总数
    // 顺序遵循 sortThreads:运行中优先,同级按最近更新倒序(1 分钟前 > 2 分钟前)
    expect(report.lines).toEqual([
      'claude · codewaifu — 运行中 · 1 分钟前',
      'codex · robotworld — 运行中 · 2 分钟前',
      'codex · paper — 刚完成 · 2 小时前'
    ])
    expect(report.bubble.split('\n')[0]).toBe(report.headline)
    expect(report.speak).toContain('2 个 agent 在干活')
    expect(report.speak).toContain('另外还有 1 个会话')
  })

  it('caps the detail at REPORT_MAX_DETAIL and says how many are left', () => {
    const threads = Array.from({ length: 7 }, (_, i) =>
      thread({ cwd: `/a/p${i}`, live: true, updatedAt: NOW - i * MIN })
    )
    const report = composeStatusReport({ threads, now: NOW }, 'en')
    expect(report.lines).toHaveLength(REPORT_MAX_DETAIL)
    expect(report.running).toBe(7)
    expect(report.speak).toContain('4 more threads')
  })

  it('still reports a total when every thread is too old to name', () => {
    const report = composeStatusReport(
      { threads: [thread({ updatedAt: NOW - 9 * DAY }), thread({ updatedAt: NOW - 10 * DAY })], now: NOW },
      'en'
    )
    expect(report.lines).toEqual([])
    expect(report.headline).toBe('nothing running · 2 threads')
    expect(report.speak).toContain('2 threads in total')
  })

  it('keeps the spoken line inside the budget even with absurd paths', () => {
    const long = '/Users/someone/'.concat('very-long-project-name-'.repeat(6))
    const threads = Array.from({ length: 12 }, (_, i) =>
      thread({ cwd: `${long}${i}`, live: i < 6, updatedAt: NOW - i * MIN })
    )
    for (const lang of ['zh', 'en'] as const) {
      const report = composeStatusReport({ threads, now: NOW, maxDetail: 12 }, lang)
      expect(report.speak.length).toBeLessThanOrEqual(SPEAK_BUDGET)
      // 预算不够时宁可少点名,也要把「另外还有 N 个」说完
      expect(report.speak).toMatch(lang === 'zh' ? /另外还有 \d+ 个会话。$/ : /\d+ more threads\.$/)
    }
  })

  it('reads as one sentence per language', () => {
    const zh = composeStatusReport({ threads: [thread({ live: true })], now: NOW }, 'zh')
    expect(zh.speak).toBe('现在有 1 个 agent 在干活。Codex 在 robotworld,正在跑。')
    const en = composeStatusReport({ threads: [thread({ live: true })], now: NOW }, 'en')
    expect(en.speak).toBe('1 agent is working right now. Codex is running in robotworld.')
  })

  it('tolerates junk input', () => {
    const report = composeStatusReport(
      { threads: [thread({ updatedAt: Number.NaN, cwd: '' })], now: Number.NaN },
      'en'
    )
    expect(report.total).toBe(1)
    expect(report.speak.length).toBeGreaterThan(0)
    expect(Number.isNaN(report.running)).toBe(false)
  })
})
