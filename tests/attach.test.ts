/**
 * Attachments: the policies that decide whether a drag or a paste reaches an
 * agent.
 *
 * Two halves, both pure enough to drive without an app. `shared/attach` owns the
 * text a gesture becomes - which paths need quoting for which shell, and where
 * the caret lands afterwards. `main/attach` owns the clipboard and the directory
 * a pasted screenshot is written to - which format names a file, what the file
 * is called, when it is swept, and what permission it has while it sits there.
 *
 * The Electron 44 clipboard facts asserted here are measured, not assumed: see
 * the comment on `FILE_TYPES` in `main/attach.ts`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENTS,
  MAX_PATH_LEN,
  cleanPaths,
  insertAtCursor,
  isStalePaste,
  pasteFileName,
  pathsToText,
  quotePath
} from '../src/shared/attach'
import {
  PASTE_MAX_AGE_MS,
  SWEEP_INTERVAL_MS,
  clipboardPaths,
  decodeBytes,
  fileUrlToPath,
  plistStrings,
  readClipboardPayload,
  resetSweepClock,
  savePastedImage,
  sweepDue,
  sweepPastedImages,
  type AttachDeps,
  type ClipboardReader
} from '../src/main/attach'

// `sweepDue` keeps a module-level clock; every test starts from a clean one.
afterEach(() => {
  resetSweepClock()
})

// ============================================================
// Quoting. The rule is "quote when in doubt": two extra characters against a
// path with a space in it silently becoming two arguments.
// ============================================================

describe('quotePath', () => {
  it('leaves a path with nothing to protect alone', () => {
    expect(quotePath('/tmp/shot-1.png', 'posix')).toBe('/tmp/shot-1.png')
    expect(quotePath('C:\\Users\\me\\shot.png', 'windows')).toBe('C:\\Users\\me\\shot.png')
  })

  it('single-quotes a POSIX path the shell would split', () => {
    expect(quotePath('/tmp/my shot.png', 'posix')).toBe("'/tmp/my shot.png'")
    // A glob is a glob whether or not anything matches it.
    expect(quotePath('/tmp/*.png', 'posix')).toBe("'/tmp/*.png'")
    // `~` expands, and `#` starts a comment mid-word in some shells.
    expect(quotePath('/tmp/~draft#1.png', 'posix')).toBe("'/tmp/~draft#1.png'")
  })

  it('escapes an embedded single quote the only way POSIX allows', () => {
    expect(quotePath("/tmp/it's.png", 'posix')).toBe(`'/tmp/it'\\''s.png'`)
  })

  it('double-quotes a Windows path, where a quote cannot appear inside one', () => {
    expect(quotePath('C:\\My Documents\\shot.png', 'windows')).toBe('"C:\\My Documents\\shot.png"')
    // `&`, `%` and `^` are cmd's sharp edges and are not in the safe set.
    expect(quotePath('C:\\a&b.png', 'windows')).toBe('"C:\\a&b.png"')
  })

  it('answers an empty path with an empty quoted word rather than nothing', () => {
    // Nothing at all would splice two neighbouring paths together.
    expect(quotePath('', 'posix')).toBe("''")
  })
})

describe('pathsToText', () => {
  it('joins with a space, which is what an argument list wants', () => {
    expect(pathsToText(['/a/one.png', '/a/two three.png'], 'posix')).toBe(
      "/a/one.png '/a/two three.png' "
    )
  })

  it('drops the trailing space for a composer, where it would be a stray one', () => {
    expect(pathsToText(['/a/one.png'], 'posix', { trailing: false })).toBe('/a/one.png')
  })

  it('is empty for no paths, so a caller cannot insert a bare space', () => {
    expect(pathsToText([], 'posix')).toBe('')
  })
})

// ============================================================
// The roster of one gesture. A dragged folder is four thousand files, and four
// thousand quoted paths is a denial of the input box rather than an attachment.
// ============================================================

describe('cleanPaths', () => {
  it('keeps the order, drops the empties, and dedupes one gesture', () => {
    expect(cleanPaths(['/a', '', '  ', '/b', '/a'])).toEqual(['/a', '/b'])
  })

  it('caps a gesture rather than the roster', () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 40 }, (_, index) => `/a/${index}.png`)
    expect(cleanPaths(many)).toHaveLength(MAX_ATTACHMENTS)
    expect(cleanPaths(many)[0]).toBe('/a/0.png')
  })

  it('refuses anything too long to be a path', () => {
    expect(cleanPaths([`/a/${'x'.repeat(MAX_PATH_LEN)}.png`])).toEqual([])
  })

  it('trims the whitespace a uri-list leaves on a line', () => {
    expect(cleanPaths(['  /a/one.png\n'])).toEqual(['/a/one.png'])
  })

  it('survives a non-string entry, which is what a hostile clipboard sends', () => {
    expect(cleanPaths([null as unknown as string, 7 as unknown as string, '/a'])).toEqual(['/a'])
  })
})

// ============================================================
// Where the caret lands. An attachment appended after a signature reads as if
// it belonged to nobody, so the insertion goes where the human put the caret.
// ============================================================

describe('insertAtCursor', () => {
  it('inserts at the caret and reports where the caret belongs', () => {
    const result = insertAtCursor('look at  please', '/a/shot.png', 8, 8)
    expect(result.value).toBe('look at /a/shot.png please')
    expect(result.caret).toBe(8 + '/a/shot.png'.length)
  })

  it('replaces a selection, which is what a paste does everywhere else', () => {
    expect(insertAtCursor('abcdef', 'X', 2, 4)).toEqual({ value: 'abXef', caret: 3 })
  })

  it('appends when the caret is at the end', () => {
    expect(insertAtCursor('hi', ' there', 2, 2).value).toBe('hi there')
  })

  it('clamps an out-of-range or reversed selection instead of slicing oddly', () => {
    expect(insertAtCursor('abc', 'X', 99, 99)).toEqual({ value: 'abcX', caret: 4 })
    expect(insertAtCursor('abc', 'X', -5, -1)).toEqual({ value: 'Xabc', caret: 1 })
    // end before start: the pair collapses to a caret, it does not delete backwards.
    expect(insertAtCursor('abc', 'X', 2, 1)).toEqual({ value: 'abXc', caret: 3 })
  })

  it('treats a missing value as an empty field', () => {
    expect(insertAtCursor(undefined as unknown as string, 'X', 0, 0)).toEqual({
      value: 'X',
      caret: 1
    })
  })
})

// ============================================================
// Naming and sweeping. The name has to let the human find the file again; the
// sweep has to not keep every screenshot ever pasted.
// ============================================================

describe('pasteFileName', () => {
  it('stamps the moment, so the file says which screenshot it was', () => {
    const at = new Date(2026, 8, 17, 9, 5, 4).getTime()
    expect(pasteFileName(at)).toBe('cw-paste-20260917-090504.png')
  })

  it('adds a counter only when a second paste lands in the same second', () => {
    const at = new Date(2026, 8, 17, 9, 5, 4).getTime()
    expect(pasteFileName(at, 1)).toBe('cw-paste-20260917-090504-2.png')
    expect(pasteFileName(at, 10)).toBe('cw-paste-20260917-090504-11.png')
  })
})

describe('isStalePaste', () => {
  it('keeps a file the agent may still be reading', () => {
    const now = Date.UTC(2026, 8, 17)
    expect(isStalePaste(now - 60_000, now, PASTE_MAX_AGE_MS)).toBe(false)
    expect(isStalePaste(now - PASTE_MAX_AGE_MS, now, PASTE_MAX_AGE_MS)).toBe(false)
  })

  it('sweeps one past the age, and anything with no usable mtime', () => {
    const now = Date.UTC(2026, 8, 17)
    expect(isStalePaste(now - PASTE_MAX_AGE_MS - 1, now, PASTE_MAX_AGE_MS)).toBe(true)
    expect(isStalePaste(0, now, PASTE_MAX_AGE_MS)).toBe(true)
    expect(isStalePaste(Number.NaN, now, PASTE_MAX_AGE_MS)).toBe(true)
  })
})

/** A fake directory, so the policies can be driven without touching the disk. */
function fakeFs(entries: Record<string, number> = {}): AttachDeps & {
  written: Array<{ file: string; bytes: number }>
  removed: string[]
} {
  const names = new Map(Object.entries(entries))
  const written: Array<{ file: string; bytes: number }> = []
  const removed: string[] = []
  return {
    dir: '/fake/attachments',
    written,
    removed,
    mkdir: () => true,
    exists: (file) => names.has(path.basename(file)),
    write: (file, bytes) => {
      written.push({ file, bytes: bytes.byteLength })
      names.set(path.basename(file), bytes.byteLength)
      return true
    },
    list: () => [...names].map(([name, size]) => ({ name, mtimeMs: size })),
    unlink: (file) => {
      removed.push(path.basename(file))
      names.delete(path.basename(file))
      return true
    }
  }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

describe('savePastedImage', () => {
  it('writes one named file and answers with its path', () => {
    const fake = fakeFs()
    const saved = savePastedImage(PNG, { ...fake, now: () => new Date(2026, 8, 17, 9, 5, 4).getTime() })
    // path.join, not a literal: the separator is the runner's, and a saved
    // path is native on purpose - quotePath is what makes it shell-safe.
    expect(saved).toBe(path.join('/fake/attachments', 'cw-paste-20260917-090504.png'))
    expect(fake.written).toEqual([{ file: saved, bytes: PNG.byteLength }])
  })

  it('walks to the next name when the second one already exists', () => {
    const fake = fakeFs({ 'cw-paste-20260917-090504.png': 1 })
    const saved = savePastedImage(PNG, { ...fake, now: () => new Date(2026, 8, 17, 9, 5, 4).getTime() })
    expect(saved).toBe(path.join('/fake/attachments', 'cw-paste-20260917-090504-2.png'))
  })

  it('writes nothing and answers null for every way it can fail', () => {
    const at = new Date(2026, 8, 17, 9, 5, 4).getTime()
    const fake = fakeFs()
    expect(savePastedImage(null, { now: () => at })).toBeNull()
    expect(savePastedImage(new Uint8Array(2), { now: () => at })).toBeNull()
    expect(savePastedImage(new Uint8Array(33 * 1024 * 1024), { now: () => at })).toBeNull()
    expect(savePastedImage(PNG, { ...fake, now: () => at, mkdir: () => false })).toBeNull()
    // A half-written file would leave a path in the prompt that names nothing,
    // so a refused write is no path at all rather than a best effort.
    expect(savePastedImage(PNG, { ...fake, now: () => at, write: () => false })).toBeNull()
    expect(fake.written).toEqual([])
  })

  it('gives up after a sane number of name tries', () => {
    const names = new Map<string, number>()
    for (let index = 0; index < 40; index += 1) {
      names.set(index === 0 ? 'cw-paste-20260917-090504.png' : `cw-paste-20260917-090504-${index + 1}.png`, 1)
    }
    const fake = fakeFs(Object.fromEntries([...names].map(([name]) => [name, 0])))
    expect(savePastedImage(PNG, { ...fake, now: () => new Date(2026, 8, 17, 9, 5, 4).getTime() })).toBeNull()
  })

  it('really writes 0600, because it is a picture of somebody’s screen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-attach-'))
    try {
      const saved = savePastedImage(PNG, { dir })
      expect(saved).toBeTruthy()
      // A unix mode is a unix thing: on Windows node's chmod is the read-only
      // bit and stat answers 0o666, so the permission half of this claim is
      // POSIX-only. The bytes are everybody's business.
      if (process.platform !== 'win32') {
        expect(fs.statSync(saved as string).mode & 0o777).toBe(0o600)
      }
      expect(fs.readFileSync(saved as string).byteLength).toBe(PNG.byteLength)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('sweepPastedImages', () => {
  it('removes only the pastes that outlived their usefulness', () => {
    const now = Date.UTC(2026, 8, 17)
    // `list` answers with mtimeMs, and the fake stores the age in that slot.
    const fake = fakeFs({
      'cw-paste-20260901-000000.png': now - PASTE_MAX_AGE_MS - 1000,
      'cw-paste-20260917-000000.png': now - 1000
    })
    expect(sweepPastedImages({ ...fake, now: () => now })).toBe(1)
    expect(fake.removed).toEqual(['cw-paste-20260901-000000.png'])
  })

  it('never touches a file it could not have written', () => {
    const now = Date.UTC(2026, 8, 17)
    const ancient = now - PASTE_MAX_AGE_MS * 10
    const fake = fakeFs({
      'notes.png': ancient,
      'cw-paste-nope.png': ancient,
      'CW-PASTE-20260101-000000.png': ancient,
      'cw-paste-20260101-000000.png': ancient
    })
    expect(sweepPastedImages({ ...fake, now: () => now })).toBe(1)
    expect(fake.removed).toEqual(['cw-paste-20260101-000000.png'])
  })

  it('survives a directory that is not there', () => {
    expect(sweepPastedImages({ dir: '/nope', list: () => [] })).toBe(0)
  })
})

describe('sweepDue', () => {
  it('runs at most once per interval, so a paste costs one write', () => {
    resetSweepClock()
    let now = Date.UTC(2026, 8, 17)
    const fake = fakeFs({ 'cw-paste-20260101-000000.png': now - PASTE_MAX_AGE_MS * 2 })
    const deps = { ...fake, now: () => now }
    expect(sweepDue(deps)).toBe(1)
    // The same file is already gone; a second call inside the interval must not
    // even look, which is what makes the throttle observable.
    now += SWEEP_INTERVAL_MS - 1
    expect(sweepDue(deps)).toBe(0)
    now += 1
    expect(sweepDue(deps)).toBe(0)
    resetSweepClock()
  })
})

// ============================================================
// What the clipboard is holding.
// ============================================================

/** A format's bytes, as Electron 44's `getType` would hand them over. */
function blob(text: string, encoding: 'utf-8' | 'utf-16le' = 'utf-8'): Uint8Array {
  return encoding === 'utf-8'
    ? new TextEncoder().encode(text)
    : new Uint8Array(Buffer.from(text, 'utf16le'))
}

/** A `clipboard.read()` answer: items that list their types and vend bytes. */
function reader(items: Array<Record<string, Uint8Array | string>>): ClipboardReader & {
  fetched: string[]
} {
  const fetched: string[] = []
  return {
    fetched,
    read: async () =>
      items.map((formats) => ({
        types: Object.keys(formats),
        getType: async (type: string) => {
          fetched.push(type)
          const value = formats[type]
          if (typeof value === 'string') return { title: value, url: value }
          return { arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) }
        }
      }))
  }
}

const URI_LIST = 'text/uri-list'
const NS_FILENAMES = 'electron application/osclipboard;format="NSFilenamesPboardType"'
const FILE_NAME_W = 'electron application/osclipboard;format="FileNameW"'
const IMAGE = 'image/png'

describe('fileUrlToPath', () => {
  it('reads a file: URL, a bare POSIX path and a bare Windows path', () => {
    expect(fileUrlToPath('file:///tmp/a%20b.png')).toBe('/tmp/a b.png')
    expect(fileUrlToPath('/tmp/a.png')).toBe('/tmp/a.png')
    expect(fileUrlToPath('C:\\Users\\me\\a.png')).toBe('C:\\Users\\me\\a.png')
  })

  it('reads a Windows spelling on any platform, because the parser is not node\'s', () => {
    // node's fileURLToPath answers for the platform it runs on, which made the
    // Windows CI die on POSIX URLs and would make a mac run blind to these.
    expect(fileUrlToPath('file:///C:/Users/me/a%20shot.png')).toBe('C:/Users/me/a shot.png')
    expect(fileUrlToPath('file://server/share/a.png')).toBe('\\\\server\\share\\a.png')
    expect(fileUrlToPath('file://localhost/tmp/a.png')).toBe('/tmp/a.png')
  })

  it('keeps a lone percent, which is a legal filename character and an illegal escape', () => {
    expect(fileUrlToPath('file:///tmp/100%.png')).toBe('/tmp/100%.png')
  })

  it('refuses a URL that is not a file, which is what keeps a copied link a link', () => {
    expect(fileUrlToPath('https://onora.dev/x.png')).toBe('')
    expect(fileUrlToPath('')).toBe('')
    expect(fileUrlToPath('file://not-a-path')).toBe('')
  })
})

describe('decodeBytes', () => {
  it('reads UTF-8 as UTF-8', () => {
    expect(decodeBytes(blob('/tmp/shot.png'))).toBe('/tmp/shot.png')
  })

  it('reads Windows’ wide filename as UTF-16LE instead of as mojibake', () => {
    expect(decodeBytes(blob('C:\\Users\\me\\shot.png', 'utf-16le'))).toBe('C:\\Users\\me\\shot.png')
  })
})

describe('plistStrings', () => {
  it('reads the paths out of the plist macOS uses for a copied file', () => {
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '<array>',
      '\t<string>/tmp/one.png</string>',
      '\t<string>/tmp/two &amp; three.png</string>',
      '</array>',
      '</plist>'
    ].join('\n')
    expect(plistStrings(plist)).toEqual(['/tmp/one.png', '/tmp/two & three.png'])
  })

  it('is empty for a document with no strings', () => {
    expect(plistStrings('<plist><array></array></plist>')).toEqual([])
  })
})

describe('clipboardPaths', () => {
  it('reads a uri-list, skipping its comments', () => {
    const formats = new Map([[URI_LIST, blob('# comment\nfile:///tmp/a.png\nfile:///tmp/b.png\n')]])
    expect(clipboardPaths(formats)).toEqual(['/tmp/a.png', '/tmp/b.png'])
  })

  it('prefers the first format that names a file, because the rest say it worse', () => {
    const formats = new Map([
      [URI_LIST, blob('file:///tmp/my%20shot.png')],
      [NS_FILENAMES, blob('<array><string>/tmp/my shot.png</string></array>')]
    ])
    expect(clipboardPaths(formats)).toEqual(['/tmp/my shot.png'])
  })

  it('falls through a uri-list that holds no file at all', () => {
    const formats = new Map([
      [URI_LIST, blob('https://onora.dev/x.png')],
      [NS_FILENAMES, blob('<array><string>/tmp/real.png</string></array>')],
      [FILE_NAME_W, blob('C:\\never\\reached.png', 'utf-16le')]
    ])
    expect(clipboardPaths(formats)).toEqual(['/tmp/real.png'])
  })

  it('reads a Windows wide filename', () => {
    const formats = new Map([[FILE_NAME_W, blob('C:\\My Documents\\shot.png', 'utf-16le')]])
    expect(clipboardPaths(formats)).toEqual(['C:\\My Documents\\shot.png'])
  })

  it('is empty when nothing on the clipboard names a file', () => {
    expect(clipboardPaths(new Map())).toEqual([])
    expect(clipboardPaths(new Map([[URI_LIST, blob('')]]))).toEqual([])
  })
})

describe('readClipboardPayload', () => {
  it('answers a copied file with its path and no image', async () => {
    const clip = reader([{ [URI_LIST]: blob('file:///tmp/a.png'), [IMAGE]: blob('icon-bytes-here!!') }])
    const payload = await readClipboardPayload(clip)
    expect(payload.paths).toEqual(['/tmp/a.png'])
    // The icon is still fetched - one `read()` cannot know in advance - but it
    // is never what a paste inserts when a real file was on the clipboard.
    expect(payload.png).not.toBeNull()
  })

  it('answers a screenshot with its bytes and no path', async () => {
    const clip = reader([{ [IMAGE]: blob('not-really-a-png-but-long-enough'), 'text/html': blob('<b>x</b>') }])
    const payload = await readClipboardPayload(clip)
    expect(payload.paths).toEqual([])
    expect(payload.png?.byteLength).toBeGreaterThan(0)
  })

  it('never asks for a format nobody wants, so a 4 MB TIFF stays on the clipboard', async () => {
    const clip = reader([
      {
        [IMAGE]: blob('png!'),
        'electron application/osclipboard;format="NeXT TIFF v4.0 pasteboard type"': blob('huge')
      }
    ])
    await readClipboardPayload(clip)
    expect(clip.fetched).toEqual([IMAGE])
  })

  it('is empty for a clipboard that rejects, which is what an empty one does', async () => {
    const payload = await readClipboardPayload({
      read: async () => {
        throw new Error('clipboard is empty')
      }
    })
    expect(payload).toEqual({ paths: [], png: null })
  })

  it('skips shapes it does not recognise rather than throwing inside a paste', async () => {
    const payload = await readClipboardPayload({
      read: async () => [null, 7, { types: 'nope' }, { types: [IMAGE] }, { types: [IMAGE], getType: async () => ({ title: 't', url: 'u' }) }]
    })
    expect(payload.paths).toEqual([])
    expect(payload.png).toBeNull()
  })

  it('keeps going when one format refuses to be read', async () => {
    const payload = await readClipboardPayload({
      read: async () => [
        {
          types: [URI_LIST, IMAGE],
          getType: async (type: string) => {
            if (type === URI_LIST) throw new Error('format vanished')
            return { arrayBuffer: async () => blob('png-bytes-here').buffer }
          }
        }
      ]
    })
    expect(payload.paths).toEqual([])
    expect(payload.png?.byteLength).toBeGreaterThan(0)
  })

  it('is empty when read answers with something that is not a list', async () => {
    expect(await readClipboardPayload({ read: async () => undefined })).toEqual({ paths: [], png: null })
  })
})
