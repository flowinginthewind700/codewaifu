/**
 * The intent ledger (F4): the record of *why*, not of what ran.
 *
 * It owns its own fetch rather than taking entries as a prop, for one reason:
 * the ledger is append-only and grows without bound, so it is the one panel in
 * the bench that must not be re-read on every state push. A state push arrives
 * on every terminal frame batch; `revision` is the service's signal that this
 * task's ledger actually changed, and it is the only thing that re-reads.
 *
 * Newest first. The ledger answers "what did we decide last", and a chronological
 * list makes you scroll to the bottom of your own history to find out.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { NotebookPen } from 'lucide-react'
import type { LedgerEntry, LedgerKind } from '@shared/pro'
import { fill, type Translate } from './i18n'
import { ago, clock } from './time'
import type { Tone } from './toast'
import { proApi } from './api'

export interface LedgerPanelProps {
  taskId: string
  revision: number
  now: number
  t: Translate
  onNotify: (text: string, tone?: Tone) => void
  /**
   * Tells the bench a row landed so it can bump `revision` and re-read.
   * Optional because the panel already refreshes its own list; this exists so the
   * *other* consumers of the ledger see the append in the same tick instead of
   * waiting on a coalesced state push that may never arrive.
   */
  onAppend?: () => void
}

/** What a human can capture by hand. The other kinds arrive from hooks. */
const CAPTURE_KINDS: readonly LedgerKind[] = ['decision', 'next', 'goal', 'plan', 'note']

const KIND_KEY = {
  goal: 'ledgerKindGoal',
  plan: 'ledgerKindPlan',
  decision: 'ledgerKindDecision',
  next: 'ledgerKindNext',
  event: 'ledgerKindEvent',
  git: 'ledgerKindGit',
  session: 'ledgerKindSession',
  metric: 'ledgerKindMetric',
  checkpoint: 'ledgerKindCheckpoint',
  note: 'ledgerKindNote'
} as const satisfies Record<LedgerKind, string>

export function LedgerPanel({
  taskId,
  revision,
  now,
  t,
  onNotify,
  onAppend
}: LedgerPanelProps): ReactElement {
  const [entries, setEntries] = useState<LedgerEntry[]>([])
  const [kind, setKind] = useState<LedgerKind>('decision')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!taskId) {
      setEntries([])
      return
    }
    let cancelled = false
    void proApi.ledger.read(taskId).then((list) => {
      // A late answer for the previous task must not paint over the current one.
      if (cancelled) return
      setEntries(list.slice().reverse())
    })
    return () => {
      cancelled = true
    }
  }, [taskId, revision])

  const record = useCallback(async (): Promise<void> => {
    const text = draft.trim()
    if (!taskId || !text || busy) return
    setBusy(true)
    const result = await proApi.ledger.append(taskId, kind, text)
    setBusy(false)
    if (result.ok) {
      setDraft('')
      // The service pushes a new state on append, but the read is ours to make:
      // bumping here keeps the row visible even if the push is coalesced away.
      const list = await proApi.ledger.read(taskId)
      setEntries(list.slice().reverse())
      onAppend?.()
      return
    }
    onNotify(result.detail || result.code || 'failed', 'error')
  }, [busy, draft, kind, onAppend, onNotify, taskId])

  return (
    <>
      <div className="panel-scroll">
        {!taskId ? (
          <p className="empty-note">{t('ledgerNoTask')}</p>
        ) : !entries.length ? (
          <p className="empty-note">{t('ledgerEmpty')}</p>
        ) : (
          <div className="ledger">
            {entries.map((entry) => (
              <div className="entry" key={entry.id} data-kind={entry.kind}>
                <span className="entry-kind">{t(KIND_KEY[entry.kind])}</span>
                <div className="entry-body">
                  <p className="entry-text">{entry.text}</p>
                  <EntryMeta entry={entry} now={now} t={t} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="capture">
        <span className="section-label">{t('captureLabel')}</span>
        <div className="capture-row">
          <select
            className="select"
            value={kind}
            aria-label={t('captureLabel')}
            onChange={(event) => setKind(event.target.value as LedgerKind)}
          >
            {CAPTURE_KINDS.map((option) => (
              <option key={option} value={option}>
                {t(KIND_KEY[option])}
              </option>
            ))}
          </select>
          <input
            className="input"
            value={draft}
            disabled={!taskId}
            placeholder={t('capturePlaceholder')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void record()
              }
            }}
          />
          <button
            type="button"
            className="btn primary icon"
            title={t('captureButton')}
            aria-label={t('captureButton')}
            disabled={!taskId || !draft.trim() || busy}
            onClick={() => void record()}
          >
            <NotebookPen />
          </button>
        </div>
        {taskId && entries.length > 0 && (
          <span className="hint">{fill(t, 'ledgerCount', { n: entries.length })}</span>
        )}
      </div>
    </>
  )
}

/**
 * The provenance strip under one entry. Deliberately terse: this repeats per
 * row, so anything here is paid for a hundred times over.
 */
function EntryMeta({
  entry,
  now,
  t
}: {
  entry: LedgerEntry
  now: number
  t: Translate
}): ReactElement {
  return (
    <div className="entry-meta">
      <span title={clock(entry.at)}>{ago(entry.at, now, t)}</span>
      {entry.branch && <span className="mono">{entry.branch}</span>}
      {entry.gitHead && <span className="mono">{entry.gitHead.slice(0, 7)}</span>}
      {entry.dirty > 0 && <span>{fill(t, 'dirtyCount', { n: entry.dirty })}</span>}
      {entry.agent && <span>{entry.agent}</span>}
    </div>
  )
}
