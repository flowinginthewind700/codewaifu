/**
 * One text field with three ways out of it.
 *
 * The tree row and the task card both rename the same title, so the part that
 * is easy to get wrong lives here once: Enter commits, Escape cancels, blur
 * commits, and none of the three fires while an IME is composing - a Chinese
 * task name is the common case here, not the exception, and Enter is how pinyin
 * commits a candidate.
 *
 * Trimming and "nothing actually changed" are decided here too, because both
 * callers would otherwise send a patch that the registry would either reject
 * (empty) or write for no reason (identical), and an unchanged title closing
 * the field without a round trip is the behaviour a human expects.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { TASK_TITLE_MAX } from '@shared/pro'
import { useImeEnter } from '../useIme'

export interface RenameFieldProps {
  /** The title as stored. Also what an empty or unchanged draft falls back to. */
  value: string
  className: string
  ariaLabel: string
  /** `Enter to save · Esc to cancel`, in the row's own language. */
  hint: string
  onCommit: (title: string) => void
  onCancel: () => void
}

export function RenameField({
  value,
  className,
  ariaLabel,
  hint,
  onCommit,
  onCancel
}: RenameFieldProps): ReactElement {
  const [draft, setDraft] = useState(value)
  const ime = useImeEnter()
  const nodeRef = useRef<HTMLInputElement | null>(null)
  // One way out only. Enter fires `blur` on the way to unmounting, and a field
  // that commits twice writes the title twice to the ledger.
  const left = useRef(false)

  // Focused and fully selected on mount: renaming is normally "replace this
  // name", and a caret at the end is what makes people keep the old prefix.
  useEffect(() => {
    const node = nodeRef.current
    if (!node) return
    node.focus()
    node.select()
  }, [])

  const leave = (): void => {
    if (left.current) return
    left.current = true
    const next = draft.trim()
    if (!next || next === value) onCancel()
    else onCommit(next)
  }

  const cancel = (): void => {
    if (left.current) return
    left.current = true
    onCancel()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      // Escape mid-composition drops the IME's candidate, not the rename.
      if (ime.swallows(event)) return
      event.preventDefault()
      event.stopPropagation()
      cancel()
      return
    }
    if (event.key !== 'Enter') return
    if (!ime.submits(event)) return
    event.preventDefault()
    event.stopPropagation()
    leave()
  }

  return (
    <input
      ref={nodeRef}
      className={className}
      value={draft}
      aria-label={ariaLabel}
      title={hint}
      maxLength={TASK_TITLE_MAX}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={leave}
      {...ime.composition}
    />
  )
}
