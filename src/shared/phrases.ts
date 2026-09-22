import type { Lang } from './protocol'

export type PhraseKey =
  | 'greeting_morning'
  | 'greeting_afternoon'
  | 'greeting_evening'
  | 'greeting_night'
  | 'session_resume'
  | 'stop'
  | 'permission'
  | 'tool'
  | 'notification'
  | 'idle'
  | 'compact'
  | 'subagent'
  | 'interrupt'
  | 'error'
  | 'steer_queued'
  | 'steer_copied'
  | 'enabled'
  | 'disabled'

type Pool = { zh: string[]; en: string[] }

/**
 * Every pool is deliberately wide: the same event should not sound identical
 * twice in a row. `{detail}` / `{agent}` / `{tool}` are filled by `pickPhrase`.
 */
export const PHRASES: Record<PhraseKey, Pool> = {
  greeting_morning: {
    zh: [
      '早上好呀，今天也要一起写好代码哦。',
      '早安！咖啡还没凉，我们先从最简单的任务开始吧。',
      '早上好，我已经帮你盯着 agent 了，你可以慢慢来。',
      '早呀，昨晚的 build 没有报错，是个好兆头。',
      '早上好，今天的第一个 commit 会顺利的，我保证。',
      '早安，我把通知都接住了，你专心写就行。',
      '早呀，先深呼吸一下，然后我们一起开工。'
    ],
    en: [
      'Good morning. Let us write something worth shipping today.',
      'Morning! Coffee first, stack traces second.',
      'Good morning, I am watching the agents so you do not have to.',
      'Hey, good morning. Overnight builds stayed green, good sign.',
      'Morning. First commit of the day is always the bravest one.',
      'Good morning, I will catch every notification for you.',
      'Morning. Take a breath, then let us get into it.'
    ]
  },
  greeting_afternoon: {
    zh: [
      '下午好，进度过半了，继续保持。',
      '午后容易犯困，我来帮你盯着日志吧。',
      '下午好呀，需要我提醒你喝水吗？',
      '下午好，这个 bug 我们一定能抓到的。',
      '嗨，下午好，agent 那边一切正常。',
      '下午好，别急，一步一步来。'
    ],
    en: [
      'Good afternoon. We are past the halfway mark, keep going.',
      'Afternoon slump is real, I will watch the logs for you.',
      'Good afternoon. Want me to remind you to drink some water?',
      'Afternoon. That bug is not getting away from us.',
      'Hey, good afternoon. Everything looks healthy on the agent side.',
      'Good afternoon. Steady hands, one step at a time.'
    ]
  },
  greeting_evening: {
    zh: [
      '晚上好，今天辛苦啦。',
      '晚上好呀，收尾之前记得跑一遍测试。',
      '嗨，晚上好，别熬太晚哦。',
      '晚上好，剩下的交给我盯着就好。',
      '晚上好，今天写的代码挺漂亮的。'
    ],
    en: [
      'Good evening. You worked hard today.',
      'Evening. Run the tests once more before you wrap up.',
      'Hey, good evening. Do not stay up too late.',
      'Good evening, I will keep watch from here.',
      'Evening. The code you wrote today looks good.'
    ]
  },
  greeting_night: {
    zh: [
      '这么晚了还在写代码呀，注意休息。',
      '夜深了，我把音量调低一点陪你。',
      '凌晨了哦，写完这个就去睡吧。',
      '夜里安静，正好专心，但也别太拼。',
      '这么晚还在跑 build，我陪你。'
    ],
    en: [
      'Still coding this late? Take care of yourself.',
      'It is late. I will keep my voice down and keep you company.',
      'Past midnight. Finish this one and then get some sleep.',
      'Quiet nights are good for focus, just do not overdo it.',
      'Running builds at this hour? I am right here with you.'
    ]
  },
  session_resume: {
    zh: ['我回来了，继续上次的进度吧。', '会话恢复啦，我们接着做。', '欢迎回来，上次停在这里。', '继续吧，我还记得上下文。'],
    en: ['I am back, let us pick up where we left off.', 'Session resumed, continuing now.', 'Welcome back, this is where we stopped.', 'Let us continue, I still have the context.']
  },
  stop: {
    zh: ['{agent} 做完了，来看看吧。', '这一轮跑完了。', '{agent} 停下来等你确认。', '任务结束，需要你过一眼。', '好了，{agent} 交作业了。'],
    en: ['{agent} is done, take a look.', 'That round is finished.', '{agent} stopped and is waiting for you.', 'Task complete, it needs your review.', 'Alright, {agent} handed in its work.']
  },
  permission: {
    zh: ['{agent} 需要你的授权。', '有权限请求，去点一下同意吧。', '{agent} 卡在权限确认了。', '它想执行 {tool}，需要你批准。'],
    en: ['{agent} needs your permission.', 'There is a permission request waiting.', '{agent} is blocked on an approval.', 'It wants to run {tool} and needs your go ahead.']
  },
  tool: {
    zh: ['正在使用 {tool}。', '{agent} 调用了 {tool}。', '执行 {tool} 中。'],
    en: ['Using {tool}.', '{agent} called {tool}.', 'Running {tool}.']
  },
  notification: {
    zh: ['{agent} 发来一条消息。', '有新通知。', '{agent} 在叫你。'],
    en: ['{agent} sent a message.', 'You have a new notification.', '{agent} is calling for you.']
  },
  idle: {
    zh: ['{agent} 在等你的输入。', '它闲下来了，需要你回一句。', '等你回复中。'],
    en: ['{agent} is waiting for your input.', 'It went idle and needs a reply.', 'Waiting on you.']
  },
  compact: {
    zh: ['上下文压缩中，稍等一下。', '{agent} 正在整理记忆。', '压缩上下文，马上回来。'],
    en: ['Compacting context, one moment.', '{agent} is tidying its memory.', 'Context compaction in progress, back soon.']
  },
  subagent: {
    zh: ['子任务结束了。', '{agent} 的子代理汇报完毕。', '分支任务收工。'],
    en: ['The subagent finished.', '{agent} subagent reported back.', 'That side task is wrapped up.']
  },
  interrupt: {
    zh: ['你打断了 {agent}。', '已中断，随时可以继续。', '停下来了，听你的。'],
    en: ['You interrupted {agent}.', 'Interrupted, we can resume any time.', 'Stopped. You are in control.']
  },
  error: {
    zh: ['出错了：{detail}', '{agent} 报了一个错误。', '这一步失败了，需要看看。'],
    en: ['Something failed: {detail}', '{agent} reported an error.', 'That step failed and needs a look.']
  },
  steer_queued: {
    zh: ['已经把你的话排进队列了。', '收到，稍后会转达给它。', '指令已发送给 {agent}。'],
    en: ['Queued your message.', 'Got it, I will pass it along.', 'Message sent to {agent}.']
  },
  steer_copied: {
    zh: [
      '已经复制到剪贴板，去 {agent} 里粘贴吧。',
      '{agent} 不支持直接插话，内容已复制。',
      '内容放好了，切到 {agent} 粘贴发送就行。'
    ],
    en: [
      'Copied to your clipboard, paste it into {agent}.',
      '{agent} has no injection API, so I copied the text for you.',
      'It is on your clipboard now, just paste it into {agent}.'
    ]
  },
  enabled: {
    zh: ['我回来了，会一直陪着你。', '监听已开启。', '我在，有事就叫我。'],
    en: ['I am back, watching over you.', 'Listening is on.', 'I am here, call me if you need anything.']
  },
  disabled: {
    zh: ['好，我先安静一会儿。', '已静音，需要时再叫我。', '那我先休息啦。'],
    en: ['Okay, I will be quiet for a while.', 'Muted. Call me when you need me.', 'I will take a break then.']
  }
}

const AGENT_LABEL: Record<string, Record<Lang, string>> = {
  codex: { zh: 'Codex', en: 'Codex' },
  claude: { zh: 'Claude Code', en: 'Claude Code' },
  cursor: { zh: 'Cursor Agent', en: 'Cursor Agent' },
  gemini: { zh: 'Gemini CLI', en: 'Gemini CLI' },
  antigravity: { zh: 'Antigravity', en: 'Antigravity' },
  kimi: { zh: 'Kimi CLI', en: 'Kimi CLI' },
  opencode: { zh: 'OpenCode', en: 'OpenCode' },
  kiro: { zh: 'Kiro', en: 'Kiro' },
  pi: { zh: 'Pi', en: 'Pi' },
  trae: { zh: 'Trae', en: 'Trae' },
  zcode: { zh: 'ZCode', en: 'ZCode' },
  unknown: { zh: 'agent', en: 'the agent' }
}

export function agentLabel(agent: string, lang: Lang): string {
  return (AGENT_LABEL[agent] || AGENT_LABEL.unknown)[lang]
}

export function greetingKeyForHour(hour: number): PhraseKey {
  if (hour >= 5 && hour < 12) return 'greeting_morning'
  if (hour >= 12 && hour < 18) return 'greeting_afternoon'
  if (hour >= 18 && hour < 23) return 'greeting_evening'
  return 'greeting_night'
}

export interface PhraseVars {
  agent?: string
  tool?: string
  detail?: string
}

export function fillPhrase(template: string, lang: Lang, vars: PhraseVars = {}): string {
  const agent = vars.agent ? agentLabel(vars.agent, lang) : agentLabel('unknown', lang)
  return template
    .replace(/\{agent\}/g, agent)
    .replace(/\{tool\}/g, vars.tool || 'a tool')
    .replace(/\{detail\}/g, vars.detail || '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export type Rng = () => number

export function pickPhrase(key: PhraseKey, lang: Lang, vars: PhraseVars = {}, rng: Rng = Math.random): string {
  const pool = PHRASES[key]
  if (!pool) return ''
  const list = pool[lang].length ? pool[lang] : pool.en
  const template = list[Math.min(list.length - 1, Math.floor(rng() * list.length))]
  return fillPhrase(template, lang, vars)
}

/** Total variants across both languages, used by tests and the settings panel. */
export function phraseCount(key: PhraseKey): number {
  const pool = PHRASES[key]
  return pool ? pool.zh.length + pool.en.length : 0
}
