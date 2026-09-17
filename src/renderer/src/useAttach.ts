/**
 * Attachments for a composer: a drag or a paste that carries a file becomes
 * text at the caret.
 *
 * Two surfaces have a textarea that steers an agent - the widget's chat view
 * and the bench's conversation panel - and both want the identical three
 * behaviours: quote the path for the shell that will read it, insert where the
 * caret already was rather than at the end, and put the caret back after React
 * re-renders the value. One hook, so the two cannot drift into different ideas
 * about what a dropped folder means.
 *
 * The terminal pane is deliberately not here. Its target is `term.paste`, which
 * routes through bracketed-paste markers and a PTY rather than through React
 * state, and faking a textarea around it would only hide that.
 */
import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import {
  attachPlatform,
  attachmentText,
  dropAttachment,
  insertIntoField,
  planPaste,
  resolvePaste,
  restoreCaret,
  type AttachApi
} from './attach'

/** The four strings a composer needs, resolved by whichever i18n table it owns. */
export interface AttachStrings {
  /** One gesture attached N paths. */
  attached: (n: number) => string
  /** The clipboard held something we could not turn into a file. */
  failed: string
  /** The drop hint shown while a drag is over the field. */
  dropHint: string
}

export interface UseAttachFieldOptions {
  fieldRef: { current: HTMLTextAreaElement | HTMLInputElement | null }
  /** The field's current value, owned by the caller's React state. */
  value: string
  onChange: (next: string) => void
  /** `process.platform`, as the bridge reports it; decides the quoting dialect. */
  platform: string
  strings: AttachStrings
  notify?: (text: string, tone?: 'info' | 'warn' | 'error') => void
  /** Injectable for a test; defaults to `window.codewaifu`. */
  api?: AttachApi
}

export interface AttachField {
  /** True while a drag is over the field, which is what shows the hint. */
  dragging: boolean
  dropHint: string
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => void
  onDrop: (event: DragEvent<HTMLTextAreaElement | HTMLInputElement>) => void
  onDragOver: (event: DragEvent<HTMLTextAreaElement | HTMLInputElement>) => void
  onDragEnter: (event: DragEvent<HTMLTextAreaElement | HTMLInputElement>) => void
  onDragLeave: (event: DragEvent<HTMLTextAreaElement | HTMLInputElement>) => void
}

export function useAttachField(options: UseAttachFieldOptions): AttachField {
  const { fieldRef, value, onChange, platform, strings, notify, api } = options
  const [dragging, setDragging] = useState(false)
  /**
   * A counter, not a boolean. `dragleave` fires on every child the pointer
   * crosses on its way in, so a flag would flicker the hint off mid-gesture -
   * and a hint that disappears while the file is still in the air reads as
   * "this does not accept drops".
   */
  const depth = useRef(0)
  // The latest value and strings, read inside an async continuation that outlives
  // the render which scheduled it. Without these a paste resolved after a
  // keystroke would overwrite that keystroke.
  const latest = useRef({ value, strings, notify, onChange })
  latest.current = { value, strings, notify, onChange }

  /**
   * Put text at the caret and hand the field back ready for the next word.
   * No trailing space: this is a composer, not a shell line, and a space at the
   * end of a draft is a space the human has to notice and delete.
   */
  const insert = useCallback(
    (text: string): void => {
      if (!text) return
      const current = latest.current
      const result = insertIntoField(fieldRef.current, current.value, text)
      current.onChange(result.value)
      restoreCaret(fieldRef.current, result.caret)
    },
    [fieldRef]
  )

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
      const plan = planPaste(event, api)
      if (plan.kind === 'text') return // an ordinary paste: the textarea keeps its characters
      event.preventDefault()
      const current = latest.current
      void resolvePaste(plan, api).then((paths) => {
        if (!paths.length) {
          // Silence for a plain Cmd+V on an empty clipboard - there was nothing
          // to paste and nothing went wrong. A gesture that advertised a file
          // and came back empty is a real failure worth one line.
          if (plan.kind === 'ask' && !plan.hadFiles) return
          current.notify?.(current.strings.failed, 'warn')
          return
        }
        insert(attachmentText(paths, attachPlatform(platform), false))
        current.notify?.(current.strings.attached(paths.length), 'info')
      })
    },
    [api, insert, platform]
  )

  const onDrop = useCallback(
    (event: DragEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
      event.preventDefault()
      depth.current = 0
      setDragging(false)
      const { paths, text } = dropAttachment(event, api)
      const current = latest.current
      if (paths.length) {
        insert(attachmentText(paths, attachPlatform(platform), false))
        current.notify?.(current.strings.attached(paths.length), 'info')
        return
      }
      // Dragged text - a selection out of a browser, a line out of another
      // terminal. The field would have received it anyway had we not claimed
      // the drop, so claim it and type it.
      if (text) insert(text)
    },
    [api, insert, platform]
  )

  const onDragOver = useCallback(
    (event: DragEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
      // Without this the window is not a legal drop target and `onDrop` never
      // fires at all. `copy` because a drag out of a file manager must not be
      // allowed to read as a move.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    },
    []
  )

  const onDragEnter = useCallback(
    (event: DragEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
      event.preventDefault()
      depth.current += 1
      setDragging(true)
    },
    []
  )

  const onDragLeave = useCallback((): void => {
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }, [])

  return {
    dragging,
    dropHint: strings.dropHint,
    onPaste,
    onDrop,
    onDragOver,
    onDragEnter,
    onDragLeave
  }
}
