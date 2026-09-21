/**
 * Which grammar a tool row's output gets, and which part of it gets coloured.
 *
 * This is the decision the terminal history reads as "highlighted" or "a text
 * file", so it gets the same treatment as the fence theme: the failure modes are
 * cheap to state as assertions and expensive to notice otherwise. A rule that is
 * too loose paints `nl -ba` line numbers as TypeScript, which is worse than no
 * colour at all; a rule that is too strict is exactly the bug this module was
 * written to fix - 11,513 tool rows and none of them coloured.
 */
import { describe, expect, it } from 'vitest'
import {
  commandLanguage,
  commandToolLanguage,
  extensionLanguageKeys,
  extensionLanguageValues,
  isShellTool,
  looksLikeDiff,
  looksLikeJson,
  outputLanguage,
  pathLanguage,
  shapeLanguage,
  splitToolOutput
} from '../src/shared/toolOutput'

/** The wrapper this app's own exec harness prints around a command's stdout. */
const wrapped = (body: string, exit = 0): string =>
  `Chunk ID: 4ae44c\nWall time: 0.1 seconds\nProcess exited with code ${exit}\nOutput:\n${body}`

describe('commandLanguage', () => {
  it('trusts a reader that printed the file it names', () => {
    expect(commandLanguage('cat src/app.ts')).toBe('typescript')
    expect(commandLanguage('head -40 src/app.tsx')).toBe('tsx')
    expect(commandLanguage('tail -n 20 scripts/run.py')).toBe('python')
    expect(commandLanguage('bat src/style.css')).toBe('css')
    expect(commandLanguage('less notes.md')).toBe('markdown')
  })

  it('trusts a sed that only prints whole lines by number', () => {
    // `sed -n 'A,Bp'` emits the file's own lines and nothing else, which makes it
    // a reader exactly like `head`/`tail` - and it is how most of this app's own
    // transcripts read source (1.7M characters across 40 rollouts). It sat in the
    // reject list below until that was measured.
    expect(commandLanguage('sed -n 1,40p src/app.ts')).toBe('typescript')
    expect(commandLanguage("sed -n '905,1010p' app/api/pages.py")).toBe('python')
    expect(commandLanguage('sed -n "1,$p" notes.md')).toBe('markdown')
    expect(commandLanguage('gsed -n 20,30p style.css')).toBe('css')
    expect(commandLanguage('cd /srv && sed -n 10,20p main.ts')).toBe('typescript')
    expect(commandLanguage('sed -n 1,40p src/app.ts | cat')).toBe('typescript')
  })

  it('rejects every sed that does more than print numbered lines', () => {
    for (const cmd of [
      // A substitution rewrites the bytes.
      "sed 's/foo/bar/' src/app.ts",
      "sed -n 's/foo/bar/p' src/app.ts",
      // Without `-n`, sed echoes every line and prints the range again.
      'sed 1,40p src/app.ts',
      // In-place edits, a script from a file, and a second expression.
      'sed -i 1,40p src/app.ts',
      'sed -nf script.sed src/app.ts',
      "sed -n -e '1,40p' src/app.ts",
      // A regex address selects lines by content, which this refuses to guess at.
      "sed -n '/export/,/^}/p' src/app.ts",
      // `d` deletes, so what remains is not the file.
      "sed -n '1,40d;41,80p' src/app.ts"
    ]) {
      expect(commandLanguage(cmd)).toBe(null)
    }
  })

  it('reads a path, and a binary path, the same way', () => {
    expect(commandLanguage('/usr/bin/cat /etc/nginx.conf')).toBe('ini')
    expect(commandLanguage('cd /srv && cat app.py')).toBe('python')
    expect(commandLanguage('sudo cat /etc/hosts.json')).toBe('json')
  })

  it('accepts the shell noise real commands carry', () => {
    expect(commandLanguage('cat a.ts 2>/dev/null')).toBe('typescript')
    expect(commandLanguage('cat a.ts 2>&1')).toBe('typescript')
    expect(commandLanguage('VAR=1 cat a.ts')).toBe('typescript')
    expect(commandLanguage('cat a.ts | less')).toBe('typescript')
  })

  it('rejects a command that rewrites what it prints', () => {
    // Each of these prints something shaped like the file without being it, so
    // colouring it would be a confident lie about the bytes on screen.
    for (const cmd of [
      'nl -ba src/app.ts',
      'grep -n foo src/app.ts',
      'rg foo src/app.ts',
      'awk "{print $2}" src/app.ts',
      'cut -d: -f1 src/app.ts',
      'wc -l src/app.ts',
      'sort src/app.ts',
      'tr a-z A-Z < src/app.ts',
      'cat src/app.ts | head -5 | sort -u'
    ]) {
      expect(commandLanguage(cmd)).toBe(null)
    }
  })

  it('rejects a command that is not a reader at all', () => {
    expect(commandLanguage('npm run build')).toBe(null)
    expect(commandLanguage('node dist/index.js')).toBe(null)
    expect(commandLanguage('git log --oneline')).toBe(null)
    expect(commandLanguage('ls -la src')).toBe(null)
    expect(commandLanguage('pytest -q tests/test_a.py')).toBe(null)
    expect(commandLanguage('')).toBe(null)
    expect(commandLanguage(null)).toBe(null)
  })

  it('rejects a command whose stdout goes somewhere else', () => {
    // The bytes we are about to colour are not the file's bytes any more.
    expect(commandLanguage('cat a.ts > b.txt')).toBe(null)
    expect(commandLanguage('cat a.ts >> b.txt')).toBe(null)
  })

  it('rejects a command that names no language, or two', () => {
    expect(commandLanguage('cat README')).toBe(null)
    expect(commandLanguage('cat a.ts b.py')).toBe(null)
    // Two halves, two grammars, neither true of the whole.
    expect(commandLanguage('cat a.ts && node b.js')).toBe(null)
    expect(commandLanguage('cat a.ts; echo done')).toBe(null)
  })

  it('takes one language from a whole path, not one per segment', () => {
    // `cd` into a `.ts` directory and read a `.ts` file is still just TypeScript.
    expect(commandLanguage('cd /srv/app.ts.bak && cat main.ts')).toBe('typescript')
  })
})

describe('pathLanguage', () => {
  it('names the single language in a path', () => {
    expect(pathLanguage('src/shared/chat.ts')).toBe('typescript')
    expect(pathLanguage('a/Dockerfile')).toBe('dockerfile')
    expect(pathLanguage('Makefile')).toBe('makefile')
    expect(pathLanguage('Gemfile')).toBe('ruby')
  })

  it('says nothing about a path it cannot read', () => {
    expect(pathLanguage('src/app')).toBe(null)
    expect(pathLanguage('a.ts b.go')).toBe(null)
    expect(pathLanguage('')).toBe(null)
    expect(pathLanguage(null)).toBe(null)
  })

  it('ignores version-number dots that are not extensions', () => {
    expect(pathLanguage('python3.12 a.py')).toBe('python')
    expect(pathLanguage('node v22.1.0')).toBe(null)
  })
})

describe('isShellTool', () => {
  it('knows both agents\' shell tools, with and without the Codex suffix', () => {
    expect(isShellTool('exec_command')).toBe(true)
    expect(isShellTool('local_shell_call')).toBe(true)
    expect(isShellTool('Bash')).toBe(true)
    expect(isShellTool('container.exec')).toBe(true)
  })

  it('is not fooled by a tool that merely has a command-shaped name', () => {
    expect(isShellTool('apply_patch')).toBe(false)
    expect(isShellTool('view_image')).toBe(false)
    expect(isShellTool('write_stdin')).toBe(false)
    expect(isShellTool('Read')).toBe(false)
    expect(isShellTool('')).toBe(false)
    expect(isShellTool(undefined)).toBe(false)
  })
})

describe('commandToolLanguage', () => {
  it('needs both a shell tool and a reader command', () => {
    expect(commandToolLanguage('exec_command', 'cat a.ts')).toBe('typescript')
    // A `cat` inside `apply_patch`'s arguments is not a command that ran.
    expect(commandToolLanguage('apply_patch', 'cat a.ts')).toBe(null)
    expect(commandToolLanguage('view_image', '/tmp/a.png')).toBe(null)
    expect(commandToolLanguage('exec_command', 'npm test')).toBe(null)
    expect(commandToolLanguage(null, 'cat a.ts')).toBe(null)
  })
})

describe('splitToolOutput', () => {
  it('keeps the harness wrapper out of the coloured part', () => {
    const { head, body } = splitToolOutput(wrapped('export const a = 1'))
    expect(head).toBe(
      'Chunk ID: 4ae44c\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:'
    )
    expect(body).toBe('export const a = 1')
  })

  it('treats an output with no wrapper as all body', () => {
    const { head, body } = splitToolOutput('just some text')
    expect(head).toBe('')
    expect(body).toBe('just some text')
  })

  it('only splits on a marker that owns its whole line', () => {
    // A log line mentioning `Output:` mid-sentence is not the harness.
    const text = 'see Output: below\nmore text'
    expect(splitToolOutput(text).body).toBe(text)
  })

  it('survives empty and missing input', () => {
    expect(splitToolOutput('').body).toBe('')
    expect(splitToolOutput(null).body).toBe('')
    expect(splitToolOutput(undefined).body).toBe('')
  })
})

describe('looksLikeJson', () => {
  it('asks the parser, not a regex', () => {
    expect(looksLikeJson('{"a":1}')).toBe(true)
    expect(looksLikeJson('[1,2,3]')).toBe(true)
    expect(looksLikeJson('  { "a": 1 }  ')).toBe(true)
    expect(looksLikeJson('{"a":1')).toBe(false)
    // Looks like JSON, is not: trailing prose breaks the parse.
    expect(looksLikeJson('{"a":1} extra')).toBe(false)
    expect(looksLikeJson("{'a':1}")).toBe(false)
    expect(looksLikeJson('')).toBe(false)
    expect(looksLikeJson('a: 1')).toBe(false)
  })
})

describe('looksLikeDiff', () => {
  it('recognizes a patch and a git show', () => {
    expect(looksLikeDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new')).toBe(true)
    expect(looksLikeDiff('diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b')).toBe(
      true
    )
    expect(looksLikeDiff('commit 0123456789abcdef\nAuthor: a\n\n    msg\ndiff --git a b\n')).toBe(true)
  })

  it('refuses a paragraph that merely mentions a diff marker', () => {
    // Both the first line and a diff line inside have to qualify.
    expect(looksLikeDiff('I applied the change.\nThe file now starts with @@ heading')).toBe(false)
    expect(looksLikeDiff('some log output\n--- not a diff header really')).toBe(false)
    expect(looksLikeDiff('')).toBe(false)
  })
})

describe('shapeLanguage', () => {
  it('reads the shape of the body, past any wrapper', () => {
    expect(shapeLanguage(wrapped('{"a":1}'))).toBe('json')
    expect(shapeLanguage(wrapped('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b'))).toBe('diff')
    expect(shapeLanguage(wrapped('npm ERR! code 1'))).toBe(null)
  })

  it('never guesses a language from prose or a log', () => {
    // A directory tree and a CI log are the two shapes `highlightAuto()` loves to
    // call css and ini; both have to come back plain.
    expect(shapeLanguage('src/\n  app.ts\n  main.ts\n2 files')).toBe(null)
    expect(shapeLanguage('[12:00:01] step 1 of 9\n[12:00:02] step 2 of 9')).toBe(null)
  })
})

describe('outputLanguage', () => {
  it('lets the command that printed the bytes win over their shape', () => {
    // A `.json` fixture cat'ed by a command that names a markdown file: the
    // agent asked to read the markdown, so the markdown grammar is the truth.
    expect(
      outputLanguage({ tool: 'exec_command', command: 'cat notes.md', output: '{"a":1}' })
    ).toBe('markdown')
  })

  it('falls back to shape when no command vouches for the output', () => {
    expect(outputLanguage({ tool: 'exec_command', command: 'npm run build', output: '{"a":1}' })).toBe(
      'json'
    )
    // An orphan output row carries no command at all.
    expect(outputLanguage({ tool: 'output', output: wrapped('{"a":1}') })).toBe('json')
    expect(outputLanguage({ output: '{"a":1}' })).toBe('json')
  })

  it('returns null, so the row renders plain, when nothing proves a grammar', () => {
    expect(outputLanguage({ tool: 'exec_command', command: 'ls -la', output: 'a.txt' })).toBe(null)
    expect(outputLanguage({ tool: 'apply_patch', output: 'Success. Updated the following files:' })).toBe(
      null
    )
    expect(outputLanguage({ tool: 'view_image', output: '' })).toBe(null)
  })

  it('colours a real harness-wrapped exec_command row the way the app will', () => {
    const output = wrapped('import { useState } from "react"')
    expect(outputLanguage({ tool: 'exec_command', command: 'cat src/App.tsx', output })).toBe('tsx')
  })
})

describe('the extension table', () => {
  it('maps at least the extensions that dominate real transcripts', () => {
    // Measured over 40 Codex rollouts: ts 4558, py 2014, tsx 1664, md 1110,
    // css 599. These five are what most of the coloured output is.
    for (const ext of ['ts', 'py', 'tsx', 'md', 'css']) {
      expect(extensionLanguageKeys()).toContain(ext)
      expect(pathLanguage(`src/app.${ext}`)).not.toBe(null)
    }
  })

  it('names at most one grammar per extension, so the table cannot disagree', () => {
    // The table is the only thing deciding that `.ts` is TypeScript, and its
    // values are the grammars handed straight to `codeSpans()`. Whether each of
    // them is *registered* needs the renderer's `isRegistered()`, and that half
    // lives in tests/highlightTheme.test.tsx next to the identical check for
    // fence spellings.
    expect(extensionLanguageValues().length).toBeGreaterThan(20)
    expect(pathLanguage('a.ts')).toBe('typescript')
    expect(pathLanguage('notes.md')).toBe('markdown')
  })
})
