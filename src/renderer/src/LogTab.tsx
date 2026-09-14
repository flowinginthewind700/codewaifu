import type { ReactElement } from 'react'
import type { HookEvent } from '@shared/protocol'
import type { Translate } from './i18n'

interface LogTabProps {
  events: HookEvent[]
  t: Translate
}

/** Newest first, straight from the relay: this is the "did my hook fire?" view. */
export function LogTab({ events, t }: LogTabProps): ReactElement {
  if (events.length === 0) return <div className="panel-body"><div className="empty">{t('logEmpty')}</div></div>

  return (
    <div className="panel-body">
      <div className="list">
        {events.map((event) => (
          <div className="log-line" key={event.id}>
            <span className="log-time">{clockTime(event.at)}</span>
            <div className="log-main">
              <div className="log-title">
                <span className={`tag ${event.agent}`}>{event.agent}</span> {event.title}
              </div>
              {event.detail ? <div className="log-detail">{event.detail}</div> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function clockTime(at: number): string {
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
