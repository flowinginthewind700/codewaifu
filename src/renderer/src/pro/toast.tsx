/**
 * Toasts: the bench's only feedback channel for a `ProResult`.
 *
 * Every mutating IPC call resolves rather than throws, so "it did not work" has
 * to be *shown* somewhere or it is silently indistinguishable from "it worked".
 * One queue, auto-expiring, never modal: an error that blocks the keyboard in a
 * tool whose whole job is unblocking agents is the wrong shape of interruption.
 */
import { useCallback, useRef, useState, type ReactElement } from 'react'
import type { ProNoticePush } from '@shared/proIpc'

export type Tone = 'info' | 'ok' | 'warn' | 'error'

export interface ToastItem {
  id: number
  text: string
  tone: Tone
}

/** How long a message stays. Errors get longer: they are read, not glanced at. */
const TTL: Record<Tone, number> = { info: 3200, ok: 2600, warn: 4200, error: 7000 }

const MAX_TOASTS = 4

export function noticeTone(push: ProNoticePush): Tone {
  return push.tone === 'error' ? 'error' : push.tone === 'warn' ? 'warn' : 'info'
}

export function useToasts(): {
  toasts: ToastItem[]
  push: (text: string, tone?: Tone) => void
  dismiss: (id: number) => void
} {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const seq = useRef(0)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const push = useCallback(
    (text: string, tone: Tone = 'info') => {
      const message = String(text || '').trim()
      if (!message) return
      // Coalesce repeats: a resize storm or a flapping bridge would otherwise
      // stack the same sentence four times and hide the message underneath.
      setToasts((current) => {
        const same = current.find((toast) => toast.text === message && toast.tone === tone)
        if (same) return current
        const id = (seq.current += 1)
        const next = [...current, { id, text: message, tone }].slice(-MAX_TOASTS)
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), TTL[tone] ?? 3200)
        )
        return next
      })
    },
    [dismiss]
  )

  return { toasts, push, dismiss }
}

export function Toasts({
  items,
  onDismiss
}: {
  items: ToastItem[]
  onDismiss: (id: number) => void
}): ReactElement | null {
  if (!items.length) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((toast) => (
        <button
          key={toast.id}
          type="button"
          className="toast"
          data-tone={toast.tone}
          onClick={() => onDismiss(toast.id)}
        >
          {toast.text}
        </button>
      ))}
    </div>
  )
}
