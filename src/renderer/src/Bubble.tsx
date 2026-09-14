import type { ReactElement } from 'react'
import type { BubbleMessage } from '@shared/ui'

/** Labels for the bubble eyebrow; the spoken text carries everything else. */
const KIND_LABEL: Record<string, { zh: string; en: string }> = {
  greeting: { zh: '问候', en: 'hello' },
  notice: { zh: '提示', en: 'notice' },
  alert: { zh: '注意', en: 'alert' },
  session_start: { zh: '会话开始', en: 'session start' },
  session_end: { zh: '会话结束', en: 'session end' },
  stop: { zh: '完成', en: 'finished' },
  permission: { zh: '待授权', en: 'permission' },
  notification: { zh: '通知', en: 'notification' },
  tool: { zh: '工具', en: 'tool' },
  compact: { zh: '压缩上下文', en: 'compacting' },
  subagent: { zh: '子任务', en: 'subagent' },
  interrupt: { zh: '已中断', en: 'interrupted' },
  prompt: { zh: '输入', en: 'prompt' }
}

interface BubbleProps {
  message: BubbleMessage | null
}

export function Bubble({ message }: BubbleProps): ReactElement | null {
  if (!message) return null
  const label = KIND_LABEL[message.kind] || KIND_LABEL.notice
  const tone = message.kind === 'alert' ? 'alert' : message.kind === 'greeting' ? 'greeting' : 'plain'
  return (
    <div className="bubble" data-solid="1" data-tone={tone} role="status" aria-live="polite">
      <div className="bubble-meta">
        {message.agent && message.agent !== 'codewaifu' ? <span>{message.agent}</span> : null}
        <span>{label[message.lang] || label.en}</span>
      </div>
      <div>{message.text}</div>
    </div>
  )
}
