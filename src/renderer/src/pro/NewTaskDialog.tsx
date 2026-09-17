/**
 * New task (F2): the one form in the product.
 *
 * It is a form and not a wizard because everything on it is optional, the
 * directory included: blank means `~`, and main resolves that to a real path
 * (`shared/pro.ts::resolveWorkdir`) so the registry never stores a guess.
 * Title and goal can be filled in later from the card; the worktree
 * and branch fields stay hidden until the checkbox that needs them is ticked;
 * the agent list is whatever herdr can actually start on this machine, fetched
 * once on open rather than hardcoded, because a select full of agents that are
 * not installed is a form that fails only after you finish typing.
 *
 * Creating while herdr is down is legal and deliberate: the registry records the
 * intent and recovery provisions the workspace the moment herdr appears.
 * Throwing away what the human typed because a daemon is offline is the worse
 * failure of the two.
 */
import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'
import { FolderOpen, X } from 'lucide-react'
import type { TaskRecord } from '@shared/pro'
import type { Translate } from './i18n'
import type { Tone } from './toast'
import { proApi } from './api'

export interface NewTaskDialogProps {
  defaultWorkdir: string
  t: Translate
  onCancel: () => void
  onCreated: (task: TaskRecord) => void
  onNotify: (text: string, tone?: Tone) => void
}

export function NewTaskDialog({
  defaultWorkdir,
  t,
  onCancel,
  onCreated,
  onNotify
}: NewTaskDialogProps): ReactElement {
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [workdir, setWorkdir] = useState(defaultWorkdir)
  const [agent, setAgent] = useState('')
  const [agents, setAgents] = useState<string[]>([])
  const [worktree, setWorktree] = useState(false)
  const [branch, setBranch] = useState('')
  const [base, setBase] = useState('')
  const [start, setStart] = useState(true)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void proApi.host.agents().then((result) => {
      if (cancelled || !result.ok) return
      /*
       * Names only, and anything else is dropped rather than rendered. The
       * handler once answered herdr's agent records here, and one of those as
       * an `<option>` child is React error #31 - a fault card over the whole
       * bench. The typed contract now forbids it, but a picker that degrades
       * to empty is survivable in a way a crashed dialog is not.
       */
      const found = (result.data?.agents ?? []).filter(
        (name): name is string => typeof name === 'string'
      )
      setAgents(found)
      setAgent((current) => current || found.find((name) => name === 'codex') || found[0] || '')
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Capture-phase, so a focused input's own Escape handling cannot swallow the
  // one gesture that must always close the dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])

  const browse = async (): Promise<void> => {
    const result = await proApi.host.pickDir()
    if (!result.ok) {
      // Dismissing a file picker is not a failure and must not raise a toast.
      if (result.code !== 'cancelled') onNotify(result.detail || result.code, 'error')
      return
    }
    const path = result.data?.path ?? ''
    if (path) setWorkdir(path)
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    const result = await proApi.task.create({
      title: title.trim(),
      goal: goal.trim(),
      // A blank field is a decision, not a missing one: it means home. The
      // tilde is sent rather than expanded here because the renderer does not
      // know whose home this is, and main already has the one implementation.
      workdir: workdir.trim() || '~',
      branch: worktree ? branch.trim() : '',
      base: worktree ? base.trim() : '',
      worktree,
      agent: start ? agent : '',
      start: start && Boolean(agent),
      prompt: prompt.trim()
    })
    setBusy(false)
    if (!result.ok || !result.data) {
      setError(result.detail || result.code)
      return
    }
    // `data` is the envelope, not the row: handing the envelope over made the
    // bench call `setTaskId(undefined)`, so the tree never selected the task
    // the human had just created.
    onCreated(result.data.task)
  }

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <div
      className="scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('newTaskTitle')}
        onKeyDown={onKeyDown}
      >
        <div className="dialog-head">
          <h2 className="dialog-title">{t('newTaskTitle')}</h2>
        </div>

        <div className="dialog-grid">
          <Field className="wide" label={t('fieldTitle')}>
            <input
              className="input"
              autoFocus
              value={title}
              placeholder={t('titlePlaceholder')}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>

          <Field className="wide" label={t('fieldGoal')}>
            <textarea
              className="textarea"
              rows={2}
              value={goal}
              placeholder={t('goalPlaceholder')}
              onChange={(event) => setGoal(event.target.value)}
            />
          </Field>

          <Field className="wide" label={t('fieldWorkdir')}>
            <span className="dialog-row">
              <input
                className="input mono"
                value={workdir}
                spellCheck={false}
                placeholder={t('workdirPlaceholder')}
                onChange={(event) => setWorkdir(event.target.value)}
              />
              <button type="button" className="btn sm" onClick={() => void browse()}>
                <FolderOpen />
                {t('browse')}
              </button>
            </span>
          </Field>

          <Field label={t('fieldAgent')}>
            <select
              className="select"
              value={agent}
              disabled={!agents.length}
              onChange={(event) => setAgent(event.target.value)}
            >
              {!agents.length && <option value="">-</option>}
              {agents.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Field>

          {worktree ? (
            <Field label={t('fieldBranch')}>
              <input
                className="input mono"
                value={branch}
                spellCheck={false}
                placeholder="pro/fix-login"
                onChange={(event) => setBranch(event.target.value)}
              />
            </Field>
          ) : (
            <span />
          )}

          {worktree && (
            <Field className="wide" label={t('fieldBase')}>
              <input
                className="input mono"
                value={base}
                spellCheck={false}
                placeholder="HEAD"
                onChange={(event) => setBase(event.target.value)}
              />
            </Field>
          )}

          <span className="checks wide">
            <label className="check">
              <input
                type="checkbox"
                checked={worktree}
                onChange={(event) => setWorktree(event.target.checked)}
              />
              {t('worktreeToggle')}
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={start}
                disabled={!agents.length}
                onChange={(event) => setStart(event.target.checked)}
              />
              {t('startToggle')}
            </label>
          </span>

          <Field className="wide" label={t('fieldPrompt')}>
            <textarea
              className="textarea"
              rows={3}
              value={prompt}
              placeholder={t('promptPlaceholder')}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </Field>
        </div>

        <div className="dialog-foot">
          {error && <span className="dialog-error">{error}</span>}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onCancel}>
            <X />
            {t('confirmCancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {t('createTask')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** A labelled control. The wrapping `<label>` keeps the click target on the text. */
function Field({
  label,
  className,
  children
}: {
  label: string
  className?: string
  children: ReactElement
}): ReactElement {
  return (
    <label className={`field ${className ?? ''}`.trim()}>
      <span>{label}</span>
      {children}
    </label>
  )
}
