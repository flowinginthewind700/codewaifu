/**
 * What a renderer crash is allowed to say about itself: pure, no React, no DOM.
 *
 * The failure this exists for is a blank frame. React unmounts the whole tree
 * when a render or a mount effect throws, so the window stays open, empty, and
 * the main-process log stays clean - two such crashes shipped before anyone
 * could see them, and both were found only by attaching a debugger to the
 * renderer. The boundary that renders the fault card is the last code standing
 * when that happens, which makes it the one place that must not be clever: every
 * decision about the error is made here, where a test can pin it, and the
 * component only lays the result out.
 *
 * Two rules follow from "this runs while something is already broken":
 *
 * 1. Nothing here may throw. Property reads are guarded, because a getter that
 *    throws would blank the frame a second time, and there is no boundary behind
 *    the boundary.
 * 2. Nothing here may serialise the error. `JSON.stringify` on an arbitrary
 *    thrown value meets circular structures and hostile `toJSON`, so an error
 *    with no usable `message` is reported as having none rather than guessed at.
 */

/** The error's own name when it has a plausible one; otherwise a type. */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * A card is a few lines of type at 12.5px. Past this a message is a stack trace
 * wearing a string's clothes, and the part worth reading is already in `stack`.
 */
export const FAULT_MESSAGE_MAX = 400

/** One frame, capped: a bundled data-URL frame runs to thousands of characters. */
export const FAULT_FRAME_MAX = 200

/**
 * Frames kept. Four answers "which of my components": the first frame is the
 * throw site and the next three are usually the render path into it. More is
 * scrollback the card has no room for and the clipboard payload does not need.
 */
export const FAULT_STACK_LINES = 4

export interface RenderFault {
  /** `TypeError`, `Error`, `string`, `object`, `null` - never empty. */
  kind: string
  /** The error's message, flattened to one line. Empty when it has none. */
  message: string
  /** At most `FAULT_STACK_LINES` frames, each already capped. */
  stack: string[]
}

/**
 * A guarded property read.
 *
 * The value being inspected is by definition not what we expected, so it may be
 * a Proxy, an instance with a throwing getter, or `null`. Optional chaining
 * covers `null` and `undefined`; only a try covers the rest.
 */
function read(error: unknown, key: 'name' | 'message' | 'stack'): unknown {
  try {
    return (error as Record<string, unknown> | null)?.[key]
  } catch {
    return undefined
  }
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

/**
 * One line, always.
 *
 * A message carrying newlines (a multi-line CLI error, a formatted assertion
 * diff) would break the card's single-line row and leave the clipboard payload
 * ambiguous about where the message ends and the frames begin.
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function kindOf(error: unknown): string {
  const name = read(error, 'name')
  if (typeof name === 'string' && IDENT.test(name.trim())) return name.trim()
  if (error instanceof Error) return 'Error'
  if (error === null) return 'null'
  if (Array.isArray(error)) return 'array'
  return typeof error
}

function messageOf(error: unknown): string {
  // A thrown string is its own message: `throw 'no herdr socket'` is legal JS and
  // is what plenty of glue code actually does.
  const raw = typeof error === 'string' ? error : read(error, 'message')
  if (typeof raw !== 'string') return ''
  return cap(flatten(raw), FAULT_MESSAGE_MAX)
}

/**
 * The frames worth showing, and only those.
 *
 * V8's `stack` opens with `Name: message`, which duplicates the message the card
 * already prints in full - so frames are selected by their `at ` prefix rather
 * than by dropping a fixed number of leading lines. A SpiderMonkey shaped stack
 * (`foo@file:...`) has no such prefix; for those we show no frames rather than
 * repeat the header, and the card still carries kind and message.
 */
function stackOf(error: unknown): string[] {
  const raw = read(error, 'stack')
  if (typeof raw !== 'string') return []
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, FAULT_STACK_LINES)
    .map((line) => cap(line, FAULT_FRAME_MAX))
}

/** Describe a thrown value. Never throws, always returns a renderable fault. */
export function describeFault(error: unknown): RenderFault {
  return { kind: kindOf(error), message: messageOf(error), stack: stackOf(error) }
}

/**
 * The clipboard payload for "Copy details".
 *
 * Kept beside the describer rather than in the component so the copied text and
 * the rendered card cannot drift apart, and so the wording used for an error with
 * no message is a tested line instead of a branch inside JSX.
 */
export function formatFault(fault: RenderFault, unknown: string): string {
  const head = `${fault.kind}: ${fault.message || unknown}`
  return [head, ...fault.stack.map((frame) => `  ${frame}`)].join('\n')
}
