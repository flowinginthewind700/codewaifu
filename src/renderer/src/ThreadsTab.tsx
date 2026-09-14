import { useState, type KeyboardEvent, type ReactElement } from 'react'
import { CornerDownLeft, MessageSquare } from 'lucide-react'
import type { SteerResult, ThreadInfo } from '@shared/protocol'
import type { Translate } from './i18n'

interface ThreadsTabProps {
  threads: ThreadInfo[]
  t: Translate
  onSteer: (agent: ThreadInfo['agent'], threadId: string, message: string) => Promise<SteerResult>
  onNotice: (text: string) => void
}

export function ThreadsTab({ threads, t, onSteer, onNotice }: ThreadsTabProps): ReactElement {
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const current = threads.find((thread) => thread.key === selected) ?? null

  async function send(): Promise<void> {
    const message = draft.trim()
    if (!message || busy) return
    if (!current) {
      onNotice(t('steerPickFirst'))
      return
    }
    setBusy(true)
    try {
      const result = await onSteer(current.agent, current.id, message)
      if (result.ok && result.method === 'queue') setDraft('')
      onNotice(result.message || (result.ok ? t('steerSend') : 'failed'))
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void send()
  }

  return (
    <>
      <div className="panel-body">
        {threads.length === 0 ? (
          <div className="empty">{t('threadsEmpty')}</div>
        ) : (
          <div className="list">
            {threads.map((thread) => (
              <button
                key={thread.key}
                type="button"
                className="item"
                aria-current={thread.key === selected}
                onClick={() => setSelected(thread.key === selected ? null : thread.key)}
              >
                <div className="item-main">
                  <div className="item-title">{thread.title || thread.id.slice(0, 8)}</div>
                  <div className="item-sub">
                    {thread.cwd || thread.id.slice(0, 8)}
                    {thread.lastDetail ? ` · ${thread.lastDetail}` : ''}
                  </div>
                </div>
                <div className="item-side">
                  <span className={`tag ${thread.agent}`}>{thread.agent}</span>
                  <span>{relativeTime(thread.updatedAt, t)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="composer" data-solid="1">
        <textarea
          value={draft}
          placeholder={current ? t('steerPlaceholder') : t('steerPickFirst')}
          disabled={!current || busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          className="icon-btn primary"
          type="button"
          title={t('steerSend')}
          aria-label={t('steerSend')}
          disabled={!current || busy || !draft.trim()}
          onClick={() => void send()}
        >
          {busy ? <MessageSquare size={15} /> : <CornerDownLeft size={15} strokeWidth={2.4} />}
        </button>
      </div>

      {current && !current.steerable ? <div className="hint warn">{t('steerUnsupported')}</div> : null}
    </>
  )
}

function relativeTime(at: number, t: Translate): string {
  if (!at) return ''
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 45) return t('justNow')
  if (seconds < 3600) return `${Math.round(seconds / 60)} ${t('minutesAgo')}`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} ${t('hoursAgo')}`
  return new Date(at).toLocaleDateString()
}
