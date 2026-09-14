import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ChevronRight, MessageSquareText, Radio, Search, X } from 'lucide-react'
import { recencyBucket, threadMatches } from '@shared/chat'
import { isImeKey } from '@shared/ime'
import type { ThreadInfo } from '@shared/protocol'
import type { Translate } from './i18n'

/**
 * The session list. Both agents leave a lot of history behind (we surface up to
 * 80), so this is a list you search and scan rather than scroll: a sticky
 * filter, a "running now" section that is always first, and recency buckets so
 * the tail of the list is not one undifferentiated wall.
 *
 * Opening a row hands the thread to `ChatView`, which reads the real transcript
 * and lets you steer it — that is what makes a row worth clicking.
 */

interface ThreadsTabProps {
  threads: ThreadInfo[]
  t: Translate
  onOpen: (thread: ThreadInfo) => void
}

type Bucket = 'live' | 'today' | 'week' | 'older'

const ORDER: Bucket[] = ['live', 'today', 'week', 'older']

export function ThreadsTab({ threads, t, onOpen }: ThreadsTabProps): ReactElement {
  const [query, setQuery] = useState('')
  const [liveOnly, setLiveOnly] = useState(false)
  const [focused, setFocused] = useState<number | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const groups = useMemo(() => {
    const filtered = threads.filter((thread) => {
      if (liveOnly && !thread.live) return false
      return threadMatches([thread.title, thread.cwd, thread.id, thread.lastDetail], query)
    })
    const buckets = new Map<Bucket, ThreadInfo[]>()
    for (const thread of filtered) {
      const bucket: Bucket = thread.live ? 'live' : recencyBucket(thread.updatedAt)
      const list = buckets.get(bucket)
      if (list) list.push(thread)
      else buckets.set(bucket, [thread])
    }
    return ORDER.map((bucket) => ({ bucket, items: buckets.get(bucket) ?? [] })).filter((group) => group.items.length > 0)
  }, [liveOnly, query, threads])

  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups])
  const liveCount = useMemo(() => threads.filter((thread) => thread.live).length, [threads])

  /* `/` focuses the filter; arrows walk the list; Enter opens a thread. */
  const onKeyDown = useCallback(
    (event: globalThis.KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      // An IME's Enter commits a candidate; it must not also open a thread.
      if (isImeKey(event)) return
      if (event.key === '/' && !typing) {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (typing || flat.length === 0) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        const index = focused === null ? (step > 0 ? 0 : flat.length - 1) : (focused + step + flat.length) % flat.length
        setFocused(index)
        document.querySelector<HTMLElement>(`[data-thread-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
      }
      if (event.key === 'Enter' && focused !== null) {
        event.preventDefault()
        onOpen(flat[focused])
      }
    },
    [flat, focused, onOpen]
  )

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  // A new query resets the cursor; a stale index would open the wrong thread.
  useEffect(() => setFocused(null), [query, liveOnly, threads.length])

  return (
    <div className="threads">
      <div className="filterbar" data-solid="1">
        <Search size={12} className="filter-icon" />
        <input
          ref={searchRef}
          className="filter-input"
          type="text"
          value={query}
          placeholder={t('threadsFilter')}
          aria-label={t('threadsFilter')}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button className="icon-btn ghost" type="button" title={t('clear')} aria-label={t('clear')} onClick={() => setQuery('')}>
            <X size={12} />
          </button>
        ) : null}
        <button
          className="filter-chip"
          type="button"
          aria-pressed={liveOnly}
          title={t('threadsLiveOnly')}
          disabled={liveCount === 0}
          onClick={() => setLiveOnly((prev) => !prev)}
        >
          <Radio size={11} />
          {liveCount}
        </button>
      </div>

      <div className="panel-body threads-body">
        {threads.length === 0 ? (
          <div className="empty">{t('threadsEmpty')}</div>
        ) : flat.length === 0 ? (
          <div className="empty">{t('threadsNoMatch')}</div>
        ) : (
          groups.map((group) => (
            <section className="group" key={group.bucket}>
              <h3 className="group-head">
                {t(groupLabel(group.bucket))}
                <span className="group-count">{group.items.length}</span>
              </h3>
              <div className="list">
                {group.items.map((thread) => {
                  const index = flat.indexOf(thread)
                  return (
                    <button
                      key={thread.key}
                      type="button"
                      className="item thread-item"
                      data-thread-index={index}
                      aria-current={focused === index}
                      onClick={() => onOpen(thread)}
                      onMouseEnter={() => setFocused(index)}
                    >
                      <span className="thread-rail" data-live={thread.live || undefined} />
                      <span className="item-main">
                        <span className="item-title">{thread.title || thread.id.slice(0, 8)}</span>
                        <span className="item-sub">
                          {shortCwd(thread.cwd) || thread.id.slice(0, 8)}
                          {thread.lastDetail ? ` · ${thread.lastDetail}` : ''}
                        </span>
                      </span>
                      <span className="item-side">
                        <span className={`tag ${thread.agent}`}>{thread.agent}</span>
                        <span>{relativeTime(thread.updatedAt, t)}</span>
                      </span>
                      <ChevronRight size={13} className="item-caret" />
                    </button>
                  )
                })}
              </div>
            </section>
          ))
        )}
        {flat.length > 0 ? (
          <p className="threads-foot">
            <MessageSquareText size={11} />
            {t('threadsHint')}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function groupLabel(bucket: Bucket): 'groupLive' | 'groupToday' | 'groupWeek' | 'groupOlder' {
  if (bucket === 'live') return 'groupLive'
  if (bucket === 'today') return 'groupToday'
  return bucket === 'week' ? 'groupWeek' : 'groupOlder'
}

function shortCwd(cwd: string): string {
  if (!cwd) return ''
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/')
}

function relativeTime(at: number, t: Translate): string {
  if (!at) return ''
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 45) return t('justNow')
  if (seconds < 3600) return `${Math.round(seconds / 60)} ${t('minutesAgo')}`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} ${t('hoursAgo')}`
  return new Date(at).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}
