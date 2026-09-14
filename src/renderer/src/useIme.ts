import { useMemo, useRef, type KeyboardEvent } from 'react'
import { isImeKey, isSubmitEnter, type ImeKeyLike } from '@shared/ime'

/** Pull the three signals shared/ime.ts needs out of a React synthetic event. */
function fieldsOf(event: KeyboardEvent<Element>): ImeKeyLike {
  return {
    key: event.key,
    shiftKey: event.shiftKey,
    keyCode: event.keyCode,
    isComposing: event.nativeEvent.isComposing
  }
}

/**
 * Enter-to-send that survives an IME. Spread `composition` onto the editable
 * element and ask `submits(event)` in its `onKeyDown`; `swallows(event)` is the
 * same check for non-Enter shortcuts that must not fire mid-composition.
 */
export function useImeEnter(): {
  composition: { onCompositionStart: () => void; onCompositionEnd: () => void }
  submits: (event: KeyboardEvent<Element>) => boolean
  swallows: (event: KeyboardEvent<Element>) => boolean
} {
  // Our own copy of the composition state: it is the one signal that is still
  // set when a platform drops both `isComposing` and `keyCode`. A ref, not
  // state — a composition must never trigger a re-render of the transcript.
  const composing = useRef(false)

  // One stable object so callers can list it in a dependency array without
  // rebuilding their handlers on every render.
  return useMemo(
    () => ({
      composition: {
        onCompositionStart: (): void => {
          composing.current = true
        },
        onCompositionEnd: (): void => {
          composing.current = false
        }
      },
      submits: (event: KeyboardEvent<Element>): boolean => isSubmitEnter(fieldsOf(event), composing.current),
      swallows: (event: KeyboardEvent<Element>): boolean => isImeKey(fieldsOf(event), composing.current)
    }),
    []
  )
}
