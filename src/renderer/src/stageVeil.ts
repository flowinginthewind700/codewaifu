/**
 * The stage shows itself where the pointer is.
 *
 * With no card behind her the box that makes her draggable is still there, and
 * it still swallows a click: 300x300 of nothing that behaves like something.
 * A click that dies silently is indistinguishable from a frozen app, so the box
 * answers the pointer instead of just taking it - a hairline at rest, and under
 * the cursor the same glass the card is made of.
 *
 * This file only answers "is the pointer inside". What that looks like is CSS
 * (`.card[data-bare='1'] .l2d`), because the material belongs with the rest of
 * the material, and a hover state held in React would re-render the avatar tree
 * on every forwarded mouse move to flip one attribute.
 *
 * The whole contract is one attribute: `data-veil="1"` while the pointer is
 * inside the box. It used to carry the pointer's coordinates too, for a lens
 * that followed the cursor; the lens painted under her canvas and read as a
 * halo ring around her silhouette, so the glass became uniform and the
 * coordinates had nothing left to say.
 *
 * `mousemove` and not `pointermove` on purpose. While the window is
 * click-through the only moves that reach the page are the ones Electron
 * forwards, and forwarding is a mouse-event feature; the first forwarded move
 * is also the one that turns click-through back off (see App.tsx), so the veil
 * and the hit test cannot disagree about where the pointer is. Listening on the
 * scope rather than on the box is what makes leaving work: a forwarded stream
 * carries no reliable `mouseleave`, but it does carry moves whose coordinates
 * are outside, and those are the exit.
 */

/** Attribute present while the pointer is inside the stage box. */
export const VEIL_ATTR = 'data-veil'

export interface VeilBox {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Whether the pointer is inside the box.
 *
 * No clamping: a move outside is not "at the edge", it is the answer to a
 * different question, and the caller's response is to take the veil down.
 */
export function veilInside(clientX: number, clientY: number, box: VeilBox): boolean {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false
  if (!(box.width > 0) || !(box.height > 0)) return false
  const x = clientX - box.left
  const y = clientY - box.top
  return x >= 0 && y >= 0 && x <= box.width && y <= box.height
}

const noop = (): void => {}

/**
 * Track the pointer for one stage box and return the detach.
 *
 * Safe to call with null (the ref is not attached on the first render) and safe
 * to call twice: the second attach is its own listener pair and its own detach.
 */
export function attachStageVeil(node: HTMLElement | null, scope: EventTarget = window): () => void {
  if (!node) return noop
  let on = false

  const show = (): void => {
    if (on) return
    on = true
    node.setAttribute(VEIL_ATTR, '1')
  }

  const hide = (): void => {
    if (!on) return
    on = false
    node.removeAttribute(VEIL_ATTR)
  }

  const onMove = (event: Event): void => {
    const move = event as MouseEvent
    if (typeof move.clientX !== 'number' || typeof move.clientY !== 'number') return
    if (veilInside(move.clientX, move.clientY, node.getBoundingClientRect())) show()
    else hide()
  }

  // The pointer can leave without a move we see - the window lost focus, or the
  // display slept. A veil stuck on is worse than no veil: it says "your click
  // lands here" over a box nothing is pointing at.
  const onBlur = (): void => hide()

  scope.addEventListener('mousemove', onMove)
  scope.addEventListener('blur', onBlur)
  return () => {
    scope.removeEventListener('mousemove', onMove)
    scope.removeEventListener('blur', onBlur)
    hide()
  }
}
