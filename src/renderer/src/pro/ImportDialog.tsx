/**
 * Import: the sessions the companion already sees, offered as bench tasks.
 *
 * Three decisions this dialog makes visible, because each one reads as a bug
 * when it is left implicit:
 *
 * 1. A session that already has a task is listed and disabled rather than
 *    hidden. The picker's whole job is to answer "what is on this machine", and
 *    an answer that silently drops rows leaves the human wondering whether the
 *    scan ran at all.
 * 2. Importing parks by default. We know where a session ran and which agent ran
 *    it; we do not know that a workspace still exists for it, and an active task
 *    with no pane is a lost task on the Recovery tab. `attach` is the opt-in that
 *    says "bring the terminal back too", and it reuses the recovery plan instead
 *    of growing a second resume path.
 * 3. Nothing is claimed until the button is pressed. The list is the
 *    companion's thread tracker, which the bench may read but never writes.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { X } from 'lucide-react'
import type { ImportCandidate } from '@shared/proIpc'
import { proApi } from './api'
import { agentClass } from './agentTag'
import { fill, type Translate } from './i18n'
import { ago } from './time'
import type { Tone } from './toast'

export interface ImportDialogProps {
  t: Translate
  /** For the relative timestamps; owned by the Bench so every clock agrees. */
  now: number
  onCancel: () => void
  /** Main accepted the import. The three numbers are what it did with the rows. */
  onImported: (imported: number, attached: number, skipped: number) => void
  onNotify: (text: string, tone?: Tone) => void
}

export function ImportDialog({
  t,
  now,
  onCancel,
  onImported,
  onNotify
}: ImportDialogProps): ReactElement {
  const [rows, setRows] = useState<readonly ImportCandidate[]>([])
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [attach, setAttach] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void proApi.host.threads().then((result) => {
      if (cancelled) return
      setLoading(false)
      if (!result.ok) {
        // Rule 3 of the Bench: a failure is shown, never rendered as an empty
        // list. "No sessions" and "the tracker did not answer" are different
        // facts and call for different fixes.
        setError(result.detail || result.code || 'failed')
        return
      }
      // Newest first. The row you want is nearly always the session you were
      // just in, which is also the one most likely to still be live.
      const found = [...(result.data?.threads ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
      setRows(found)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Capture phase, so a focused checkbox's own Escape handling cannot swallow
  // the one gesture that must always close the dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  /** Rows this dialog may claim; the rest already have a task. */
  const offerable = useMemo(() => rows.filter((row) => !row.taskId), [rows])
  const allPicked = offerable.length > 0 && offerable.every((row) => picked.has(row.key))

  const toggle = useCallback((key: string): void => {
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const toggleAll = useCallback((): void => {
    setPicked(allPicked ? new Set<string>() : new Set(offerable.map((row) => row.key)))
  }, [allPicked, offerable])

  const submit = useCallback(async (): Promise<void> => {
    const keys = [...picked]
    if (!keys.length || busy) return
    setBusy(true)
    const result = await proApi.task.import(keys, attach)
    setBusy(false)
    if (!result.ok) {
      onNotify(result.detail || result.code || 'failed', 'error')
      return
    }
    const data = result.data ?? { imported: 0, attached: 0, skipped: [] as string[] }
    onImported(data.imported, data.attached, data.skipped.length)
  }, [attach, busy, onImported, onNotify, picked])

  return (
    <div
      className="scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        className="dialog import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('importTitle')}
      >
        <div className="dialog-head">
          <h2 className="dialog-title">{t('importTitle')}</h2>
          <p className="dialog-hint">{t('importHint')}</p>
        </div>

        <div className="import-bar">
          <label className="check">
            <input
              type="checkbox"
              checked={allPicked}
              disabled={!offerable.length}
              aria-label={t('importSelectAll')}
              onChange={toggleAll}
            />
            {t('importSelectAll')}
          </label>
          <span className="spacer" />
          <span className="import-count">
            {fill(t, 'importPicked', { n: picked.size, total: offerable.length })}
          </span>
        </div>

        <div className="import-list">
          {loading ? <p className="empty-note">{t('importLoading')}</p> : null}
          {!loading && error ? <p className="dialog-error import-error">{error}</p> : null}
          {!loading && !error && !rows.length ? (
            <p className="empty-note">{t('importEmpty')}</p>
          ) : null}
          {!loading && !error
            ? rows.map((row) => {
                const claimed = Boolean(row.taskId)
                return (
                  <label className="import-row" key={row.key} data-claimed={claimed || undefined}>
                    <input
                      type="checkbox"
                      checked={picked.has(row.key)}
                      disabled={claimed}
                      onChange={() => toggle(row.key)}
                    />
                    <span className={`tag ${agentClass(row.agent)}`.trim()}>{row.agent}</span>
                    <span className="import-main">
                      <span className="import-name">{row.title || t('unfiled')}</span>
                      <span className="import-cwd mono" title={row.cwd}>
                        {row.cwd}
                      </span>
                    </span>
                    <span className="import-side">
                      {row.live ? (
                        <span className="dot" data-state="working" title={t('importLive')} />
                      ) : null}
                      <span className="import-when">{ago(row.updatedAt, now, t)}</span>
                      {claimed ? <span className="pill quiet">{t('importClaimed')}</span> : null}
                    </span>
                  </label>
                )
              })
            : null}
        </div>

        <div className="dialog-foot">
          <label className="check" title={t('importAttachHint')}>
            <input
              type="checkbox"
              checked={attach}
              onChange={() => setAttach((value) => !value)}
            />
            {t('importAttach')}
          </label>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onCancel}>
            <X />
            {t('confirmCancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !picked.size}
            onClick={() => void submit()}
          >
            {fill(t, 'importSubmit', { n: picked.size })}
          </button>
        </div>
      </div>
    </div>
  )
}
