// @vitest-environment jsdom
/**
 * The renderer half of attachments: what a gesture carried, and what the
 * composer did about it.
 *
 * The rule that matters most is the one that is invisible when it works - an
 * ordinary Cmd+V of text must keep going to the textarea. Everything here is
 * therefore pinned from the event's point of view: which gestures get
 * `preventDefault`, which ones ask main, which ones stay out of the way, and
 * where the caret is afterwards.
 */
import { act, useRef, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachPlatform,
  attachmentText,
  clipboardPaths,
  dropAttachment,
  guardWindowDrops,
  insertIntoField,
  planPaste,
  resolvePaste,
  transferPaths,
  type AttachApi
} from '../src/renderer/src/attach'
import { useAttachField, type AttachStrings } from '../src/renderer/src/useAttach'

/** A bridge that answers with canned paths, and records that it was asked. */
function fakeApi(pathsByFile: Record<string, string>, clipboard: string[] = []): AttachApi & {
  asked: number
} {
  const api = {
    asked: 0,
    pathForFile: (file: unknown): string =>
      pathsByFile[(file as { name?: string })?.name ?? ''] ?? '',
    // Generic to match the bridge: the caller names the reply type, and a test
    // that answers with a canned object is answering every type at once.
    invoke: async <T,>(): Promise<T> => {
      api.asked += 1
      return (clipboard.length ? { ok: true, paths: clipboard } : { ok: false, empty: true }) as T
    },
    channels: { clipboardAttach: 'cw:clipboard-attach' }
  }
  return api
}

function fileEvent(
  kind: 'paste' | 'drop',
  data: { files?: unknown[]; text?: string }
): Event & { defaultPrevented: boolean } {
  const event = new Event(kind, { bubbles: true, cancelable: true })
  const payload = {
    files: data.files ?? [],
    getData: (format: string): string =>
      format === 'text/plain' || format === 'text' ? (data.text ?? '') : ''
  }
  Object.defineProperty(event, kind === 'paste' ? 'clipboardData' : 'dataTransfer', {
    value: payload
  })
  return event as Event & { defaultPrevented: boolean }
}

function dragEvent(kind: 'dragenter' | 'dragleave' | 'dragover'): Event {
  const event = new Event(kind, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { dropEffect: '' } })
  return event
}

// ============================================================
// What a gesture carried.
// ============================================================

describe('transferPaths', () => {
  it('asks the preload for each file, because a File has no readable path any more', () => {
    const api = fakeApi({ 'a.png': '/tmp/a.png', 'b.png': '/tmp/b.png' })
    expect(transferPaths([{ name: 'a.png' }, { name: 'b.png' }] as unknown as File[], api)).toEqual([
      '/tmp/a.png',
      '/tmp/b.png'
    ])
  })

  it('skips what has no path, which is dragged text and a screenshot blob', () => {
    const api = fakeApi({ 'a.png': '/tmp/a.png' })
    expect(transferPaths([{ name: 'a.png' }, { name: 'blob' }] as unknown as File[], api)).toEqual([
      '/tmp/a.png'
    ])
    expect(transferPaths([], api)).toEqual([])
    expect(transferPaths(undefined, api)).toEqual([])
  })

  it('survives a bridge that throws, rather than taking the keystrokes with it', () => {
    const api: AttachApi = {
      pathForFile: () => {
        throw new Error('no preload')
      },
      invoke: async <T,>(): Promise<T> => ({}) as T,
      channels: { clipboardAttach: 'cw:clipboard-attach' }
    }
    expect(transferPaths([{ name: 'a.png' }] as unknown as File[], api)).toEqual([])
  })
})

describe('planPaste', () => {
  it('takes the files when a paste has them', () => {
    const api = fakeApi({ 'a.png': '/tmp/a.png' })
    const event = fileEvent('paste', { files: [{ name: 'a.png' }], text: 'a.png' })
    // Files beat text: a drag out of a file manager carries both, and the
    // filename alone would paste a word that names nothing.
    expect(planPaste(event as never, api)).toEqual({ kind: 'paths', paths: ['/tmp/a.png'] })
  })

  it('stays out of the way of an ordinary text paste', () => {
    const api = fakeApi({})
    const event = fileEvent('paste', { text: 'npm test' })
    expect(planPaste(event as never, api)).toEqual({ kind: 'text' })
    expect(api.asked).toBe(0)
  })

  it('asks main for a paste with no path and no characters, and says a file was offered', () => {
    const api = fakeApi({})
    const event = fileEvent('paste', { files: [{ name: 'blob' }] })
    expect(planPaste(event as never, api)).toEqual({ kind: 'ask', hadFiles: true })
  })

  it('asks main for a bare Cmd+V too, but does not claim a file was offered', () => {
    const api = fakeApi({})
    const event = fileEvent('paste', {})
    expect(planPaste(event as never, api)).toEqual({ kind: 'ask', hadFiles: false })
  })
})

describe('resolvePaste', () => {
  it('answers a planned text paste without touching the bridge', async () => {
    const api = fakeApi({}, ['/tmp/x.png'])
    expect(await resolvePaste({ kind: 'text' }, api)).toEqual([])
    expect(api.asked).toBe(0)
  })

  it('answers planned paths from the plan', async () => {
    const api = fakeApi({}, ['/tmp/x.png'])
    expect(await resolvePaste({ kind: 'paths', paths: ['/tmp/a.png'] }, api)).toEqual(['/tmp/a.png'])
    expect(api.asked).toBe(0)
  })

  it('asks main, and turns a dead bridge into nothing rather than an exception', async () => {
    expect(await resolvePaste({ kind: 'ask', hadFiles: true }, fakeApi({}, ['/tmp/a.png']))).toEqual([
      '/tmp/a.png'
    ])
    const dead: AttachApi = {
      pathForFile: () => '',
      invoke: async () => {
        throw new Error('no handler')
      },
      channels: { clipboardAttach: 'cw:clipboard-attach' }
    }
    expect(await resolvePaste({ kind: 'ask', hadFiles: true }, dead)).toEqual([])
  })
})

describe('dropAttachment', () => {
  it('takes the files, else the dragged text', () => {
    const api = fakeApi({ 'a.png': '/tmp/a.png' })
    expect(dropAttachment(fileEvent('drop', { files: [{ name: 'a.png' }] }) as never, api)).toEqual({
      paths: ['/tmp/a.png'],
      text: ''
    })
    expect(dropAttachment(fileEvent('drop', { text: 'a selection' }) as never, api)).toEqual({
      paths: [],
      text: 'a selection'
    })
    expect(dropAttachment({ dataTransfer: null }, api)).toEqual({ paths: [], text: '' })
  })
})

describe('attachmentText', () => {
  it('quotes for the shell that is about to read the path', () => {
    expect(attachmentText(['/tmp/my shot.png'], attachPlatform('darwin'))).toBe("'/tmp/my shot.png' ")
    // Windows quotes with the pair `cmd` reads, and leaves a path that needs
    // no quoting alone - the quotes are for the shell, not for decoration.
    expect(attachmentText(['C:/my shot.png'], attachPlatform('win32'))).toBe('"C:/my shot.png" ')
    expect(attachmentText(['C:/plain.png'], attachPlatform('win32'))).toBe('C:/plain.png ')
    expect(attachmentText(['/a', '/b'], 'posix', false)).toBe('/a /b')
  })
})

describe('insertIntoField', () => {
  it('uses the field’s selection, and the end of the value when there is none', () => {
    const field = { selectionStart: 4, selectionEnd: 6 } as unknown as HTMLTextAreaElement
    expect(insertIntoField(field, 'abcdefgh', 'X')).toEqual({ value: 'abcdXgh', caret: 5 })
    expect(insertIntoField(null, 'abc', 'X')).toEqual({ value: 'abcX', caret: 4 })
  })

  it('changes nothing for an empty insertion', () => {
    expect(insertIntoField(null, 'abc', '')).toEqual({ value: 'abc', caret: 3 })
  })
})

describe('guardWindowDrops', () => {
  it('stops an unclaimed drop from replacing the window with the file', () => {
    const off = guardWindowDrops(window)
    const drop = fileEvent('drop', { text: 'x' })
    const over = dragEvent('dragover')
    window.dispatchEvent(drop)
    window.dispatchEvent(over)
    expect(drop.defaultPrevented).toBe(true)
    expect(over.defaultPrevented).toBe(true)
    off()
    const after = fileEvent('drop', { text: 'x' })
    window.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })
})

describe('clipboardPaths', () => {
  it('cleans what main reports, and answers [] for a refusal', async () => {
    expect(await clipboardPaths(fakeApi({}, ['/tmp/a.png', '/tmp/a.png', '']))).toEqual(['/tmp/a.png'])
    const refusing: AttachApi = {
      pathForFile: () => '',
      invoke: async <T,>(): Promise<T> => ({ ok: false, empty: true }) as T,
      channels: { clipboardAttach: 'cw:clipboard-attach' }
    }
    expect(await clipboardPaths(refusing)).toEqual([])
  })
})

// ============================================================
// The composer, mounted. This is where the two surfaces - the widget's chat and
// the bench's conversation panel - get their behaviour from, so the assertions
// are about the field a human is typing into.
// ============================================================

const STRINGS: AttachStrings = {
  attached: (n) => `attached ${n}`,
  failed: 'could not save it',
  dropHint: 'drop it here'
}

let container: HTMLDivElement
let root: Root
let notices: Array<{ text: string; tone?: string }>
let field: HTMLTextAreaElement

/** A composer shaped like both real ones: React owns the value, the hook owns the gestures. */
function Composer({ api, platform: plat }: { api: AttachApi; platform: string }): ReactElement {
  const [draft, setDraft] = useState('look at  please')
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const attach = useAttachField({
    fieldRef: ref,
    value: draft,
    onChange: setDraft,
    platform: plat,
    strings: STRINGS,
    notify: (text, tone) => notices.push({ text, tone }),
    api
  })
  return (
    <textarea
      ref={ref}
      data-testid="field"
      data-dragging={attach.dragging || undefined}
      placeholder={attach.dragging ? attach.dropHint : 'type'}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onPaste={attach.onPaste}
      onDrop={attach.onDrop}
      onDragOver={attach.onDragOver}
      onDragEnter={attach.onDragEnter}
      onDragLeave={attach.onDragLeave}
    />
  )
}

async function mount(api: AttachApi, plat = 'darwin'): Promise<void> {
  await act(async () => {
    root.render(<Composer api={api} platform={plat} />)
  })
  field = container.querySelector('[data-testid="field"]') as HTMLTextAreaElement
  if (!field) throw new Error('the composer did not render')
  // The caret is where the human put it: mid-sentence, not at the end.
  field.setSelectionRange(8, 8)
}

async function fire(event: Event): Promise<void> {
  await act(async () => {
    field.dispatchEvent(event)
    // Let the promise inside the handler settle before the assertion runs.
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  notices = []
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  vi.restoreAllMocks()
})

describe('useAttachField', () => {
  it('leaves an ordinary text paste to the textarea', async () => {
    await mount(fakeApi({}, ['/tmp/should-not-be-used.png']))
    const event = fileEvent('paste', { text: 'npm test' })
    await fire(event)
    expect(event.defaultPrevented).toBe(false)
    expect(field.value).toBe('look at  please')
    expect(notices).toEqual([])
  })

  it('inserts pasted file paths at the caret and says how many', async () => {
    const api = fakeApi({ 'a.png': '/tmp/my shot.png' })
    await mount(api)
    await fire(fileEvent('paste', { files: [{ name: 'a.png' }] }))
    expect(field.value).toBe("look at '/tmp/my shot.png' please")
    expect(notices).toEqual([{ text: 'attached 1', tone: 'info' }])
  })

  it('asks main when the paste has no path, which is a screenshot', async () => {
    const api = fakeApi({}, ['/tmp/cw-paste-20260917-090504.png'])
    await mount(api)
    const event = fileEvent('paste', { files: [{ name: 'image.png' }] })
    await fire(event)
    expect(event.defaultPrevented).toBe(true)
    expect(api.asked).toBe(1)
    expect(field.value).toBe('look at /tmp/cw-paste-20260917-090504.png please')
    expect(notices).toEqual([{ text: 'attached 1', tone: 'info' }])
  })

  it('reports a failure only when the gesture really offered a file', async () => {
    await mount(fakeApi({}))
    // A screenshot that could not be written out is worth one line.
    await fire(fileEvent('paste', { files: [{ name: 'image.png' }] }))
    expect(notices).toEqual([{ text: 'could not save it', tone: 'warn' }])
    notices = []
    // Cmd+V on an empty clipboard is not an event, and must not read as one.
    await fire(fileEvent('paste', {}))
    expect(notices).toEqual([])
  })

  it('inserts what a drop carried, and claims the drop so the window survives', async () => {
    await mount(fakeApi({ 'a.png': '/tmp/a.png', 'b.png': '/tmp/b c.png' }))
    const event = fileEvent('drop', { files: [{ name: 'a.png' }, { name: 'b.png' }] })
    await fire(event)
    expect(event.defaultPrevented).toBe(true)
    expect(field.value).toBe("look at /tmp/a.png '/tmp/b c.png' please")
    expect(notices).toEqual([{ text: 'attached 2', tone: 'info' }])
  })

  it('types dragged text, which the field would have received anyway', async () => {
    await mount(fakeApi({}))
    await fire(fileEvent('drop', { text: 'a selection' }))
    expect(field.value).toBe('look at a selection please')
    expect(notices).toEqual([])
  })

  it('quotes for the platform the app is running on', async () => {
    await mount(fakeApi({ 'a.png': 'C:\\My Documents\\a.png' }), 'win32')
    await fire(fileEvent('drop', { files: [{ name: 'a.png' }] }))
    expect(field.value).toBe('look at "C:\\My Documents\\a.png" please')
  })

  it('shows the hint for as long as the drag is over the field, not one child deep', async () => {
    await mount(fakeApi({}))
    expect(field.dataset.dragging).toBeUndefined()
    await fire(dragEvent('dragenter'))
    expect(field.dataset.dragging).toBe('true')
    expect(field.placeholder).toBe('drop it here')
    // A child under the pointer fires leave and enter; the hint must not blink.
    await fire(dragEvent('dragenter'))
    await fire(dragEvent('dragleave'))
    expect(field.dataset.dragging).toBe('true')
    await fire(dragEvent('dragleave'))
    expect(field.dataset.dragging).toBeUndefined()
    expect(field.placeholder).toBe('type')
  })

  it('makes the field a legal drop target, which is what dragover is for', async () => {
    await mount(fakeApi({}))
    const event = dragEvent('dragover')
    await fire(event)
    expect(event.defaultPrevented).toBe(true)
    expect((event as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect).toBe(
      'copy'
    )
  })

  it('clears the hint on the drop itself', async () => {
    await mount(fakeApi({ 'a.png': '/tmp/a.png' }))
    await fire(dragEvent('dragenter'))
    expect(field.dataset.dragging).toBe('true')
    await fire(fileEvent('drop', { files: [{ name: 'a.png' }] }))
    expect(field.dataset.dragging).toBeUndefined()
  })
})
