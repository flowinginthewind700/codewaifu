/**
 * The renderer half of attachments: what a drag or a paste actually carried.
 *
 * Three facts shape this file, and none of them are ours to change:
 *
 * - A `File` in a drop or paste event has no readable path any more. Electron
 *   32 removed `File.path`, and `webUtils.getPathForFile` only runs in the
 *   preload, so every path here arrives by asking the bridge.
 * - The things that arrive with no path are not failures. Dragged text, a
 *   selection dragged out of a browser, and a screenshot blob on the clipboard
 *   are all legitimate gestures that happen to contain no file, and each one
 *   has its own right answer: insert the text, or ask main what the clipboard
 *   is holding.
 * - A drop nobody claimed navigates the window. Electron will happily replace
 *   the widget with the dropped PNG, which is why `guardWindowDrops` exists and
 *   why both entry points call it before rendering anything.
 *
 * The decisions that matter - which paths, in what order, quoted how - live in
 * `@shared/attach` where a test can reach them without a DOM.
 */
import {
  cleanPaths,
  insertAtCursor,
  pathsToText,
  type AttachPlatform,
  type Insertion
} from '@shared/attach'
/**
 * The bridge, narrowed to the three members this file uses.
 *
 * Narrowed rather than imported as `CodeWaifuApi` so a test hands in four lines
 * instead of a window, and so the dependency is legible at the call site: an
 * attachment needs a path lookup, one channel, and nothing else.
 */
export interface AttachApi {
  pathForFile(file: unknown): string
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>
  channels: { clipboardAttach: string }
}

/** What a `cw:clipboard-attach` call answers. */
interface AttachReply {
  ok?: boolean
  paths?: string[]
  empty?: boolean
  error?: string
}

/**
 * The bridge that answers nothing. Reached only when `window.codewaifu` is
 * missing - a browser test, or a page that loaded without its preload - and the
 * alternative is an exception inside a paste handler, which would take the
 * textarea's keystrokes with it.
 */
const NO_BRIDGE: AttachApi = {
  pathForFile: () => '',
  invoke: async () => ({}) as never,
  channels: { clipboardAttach: 'cw:clipboard-attach' }
}

/** The real bridge, resolved per call so a test can import this module without one. */
function bridge(api?: AttachApi): AttachApi {
  if (api) return api
  try {
    return (window.codewaifu as AttachApi | undefined) ?? NO_BRIDGE
  } catch {
    return NO_BRIDGE
  }
}

export function attachPlatform(platform: string): AttachPlatform {
  return platform === 'win32' ? 'windows' : 'posix'
}

/**
 * The paths of a gesture's files, in the order they were dropped.
 *
 * An entry with no path is skipped rather than reported: a drag of three files
 * and one piece of dragged text is three attachments, and the text has its own
 * route.
 */
export function transferPaths(files: ArrayLike<File> | undefined, api?: AttachApi): string[] {
  const bridgeApi = bridge(api)
  if (!files || !files.length) return []
  const raw: string[] = []
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    if (!file) continue
    try {
      raw.push(bridgeApi.pathForFile(file) || '')
    } catch {
      raw.push('')
    }
  }
  return cleanPaths(raw)
}

/** What the clipboard can attach, as paths. Never throws; `[]` means nothing. */
export async function clipboardPaths(api?: AttachApi): Promise<string[]> {
  const bridgeApi = bridge(api)
  try {
    const reply = (await bridgeApi.invoke<AttachReply>(bridgeApi.channels.clipboardAttach)) || {}
    return reply.ok ? cleanPaths(reply.paths ?? []) : []
  } catch {
    // A blocked channel or a dead main process is not worth an exception in a
    // paste handler; the caller reports "nothing attached" and moves on.
    return []
  }
}

/** The event shape both a real paste and a test's fake satisfy. */
export interface PasteLike {
  clipboardData?: {
    files?: ArrayLike<File>
    getData?: (format: string) => string
  } | null
}

/**
 * What a paste gesture is asking for, decided synchronously.
 *
 * The split from `resolvePaste` is not tidiness, it is the whole feature: a
 * paste's default action runs the moment the event finishes dispatching, so
 * `preventDefault` has to be called before the first `await`. Anything that
 * needs main - a screenshot with no path, a file copied in Finder - is decided
 * here as "ask" and answered later, with the default already suppressed.
 *
 * `text` means "not ours": leave the characters alone and let the textarea have
 * them. Files win over text because a drag out of a file manager carries both a
 * path and a filename, and the filename alone would paste a word that names
 * nothing.
 */
export type PastePlan =
  | { kind: 'text' }
  | { kind: 'paths'; paths: string[] }
  /**
   * No usable path and no characters, so the clipboard is holding something
   * only main can see. `hadFiles` records whether the event itself advertised a
   * file: a screenshot blob arrives as a `File` with no path, and that gesture
   * deserves "could not save it" when it comes back empty, where a plain
   * Cmd+V on an empty clipboard deserves silence.
   */
  | { kind: 'ask'; hadFiles: boolean }

export function planPaste(event: PasteLike, api?: AttachApi): PastePlan {
  const data = event.clipboardData
  const hadFiles = !!data?.files?.length
  if (data) {
    const fromFiles = transferPaths(data.files, api)
    if (fromFiles.length) return { kind: 'paths', paths: fromFiles }
    const text = data.getData ? data.getData('text/plain') || data.getData('text') : ''
    if (text) return { kind: 'text' }
  }
  return { kind: 'ask', hadFiles }
}

/**
 * The paths a planned paste turned out to carry, `[]` for "nothing after all".
 * Never throws: the caller has already suppressed the default action, and an
 * exception here would leave a textarea that swallowed a keystroke.
 */
export async function resolvePaste(plan: PastePlan, api?: AttachApi): Promise<string[]> {
  if (plan.kind === 'text') return []
  if (plan.kind === 'paths') return plan.paths
  return clipboardPaths(api)
}

/** What a drop gesture carried: paths when there are files, else the text. */
export interface DropAttachment {
  paths: string[]
  text: string
}

export function dropAttachment(
  event: { dataTransfer?: { files?: ArrayLike<File>; getData?: (format: string) => string } | null },
  api?: AttachApi
): DropAttachment {
  const data = event.dataTransfer
  const paths = transferPaths(data?.files, api)
  if (paths.length) return { paths, text: '' }
  const text = data?.getData ? data.getData('text/plain') || data.getData('text') || '' : ''
  return { paths: [], text }
}

/** The text one gesture inserts, quoted for the shell that will read it. */
export function attachmentText(
  paths: readonly string[],
  platform: AttachPlatform,
  trailing = true
): string {
  return pathsToText(paths, platform, { trailing })
}

/**
 * Insert at a textarea's caret and put the caret back where the insertion ends.
 *
 * Split in two because React owns `value` and the DOM owns the selection: the
 * caret has to be restored after the re-render, or the next character the human
 * types lands at the end of the field and quietly reorders their sentence.
 */
export function insertIntoField(
  field: HTMLTextAreaElement | HTMLInputElement | null,
  current: string,
  insertion: string
): Insertion {
  if (!insertion) return { value: current, caret: current.length }
  const start = field?.selectionStart ?? current.length
  const end = field?.selectionEnd ?? start
  return insertAtCursor(current, insertion, start, end)
}

export function restoreCaret(
  field: HTMLTextAreaElement | HTMLInputElement | null,
  caret: number
): void {
  if (!field) return
  // After the paint, not before: setting a selection on the element whose value
  // React is about to replace is setting a selection on the old text.
  requestAnimationFrame(() => {
    try {
      field.focus()
      field.setSelectionRange(caret, caret)
    } catch {
      /* an input type without a selection (number, email) simply keeps focus */
    }
  })
}

/**
 * Stop an unclaimed drop from replacing the window with the dropped file.
 *
 * Called once per entry point, before the first render. `dragover` has to be
 * prevented too - that is what makes the window a legal drop target in the
 * first place, and without it a child's own `onDrop` never fires on some
 * platforms. Returns the unsubscribe, for a test that mounts twice.
 */
export function guardWindowDrops(target: Window = window): () => void {
  const stop = (event: Event): void => {
    event.preventDefault()
  }
  target.addEventListener('dragover', stop)
  target.addEventListener('drop', stop)
  return () => {
    target.removeEventListener('dragover', stop)
    target.removeEventListener('drop', stop)
  }
}
