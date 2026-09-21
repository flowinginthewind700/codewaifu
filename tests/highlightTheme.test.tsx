/**
 * The syntax theme, as a contract between highlight.tsx and highlight.css.
 *
 * Two failures are invisible from either file alone, and both are the reason a
 * theme like this gets a test instead of a screenshot review:
 *
 * 1. A scope the grammar emits that the CSS never mentions. The block renders,
 *    the colours look right at a glance, and one whole class of token is
 *    silently base-grey - you only notice when you diff against an editor.
 * 2. A rule added under one container's scope and not the others. The widget and
 *    the bench are two bundles with two stylesheets, and highlight.css is
 *    imported by both; each window also holds three kinds of code - the fenced
 *    blocks an agent writes, the output a tool printed, and the command line a
 *    tool row shows while its output stays folded. A selector that only says
 *    `.msg-bubble .code` means the same TypeScript is a different colour in five
 *    of the six places it can appear. Tool rows are the ones a human actually
 *    reads: 11,513 of them against zero fenced blocks over 40 real Codex
 *    rollouts, which is how that mistake stayed invisible for a release.
 *
 * So: collect every class the shipped grammars actually produce from a corpus of
 * the fences agents write, then require the CSS to style each one under all six
 * scopes. Neutral scopes (operator, punctuation, a declaration wrapper) inherit
 * the block's own colour on purpose, so they are listed as expected-unstyled
 * rather than being allowed to slip in unreviewed.
 *
 * The corpus is checked against `registeredGrammars()`: registering a grammar
 * without a snippet for it is a red test here, because an untested grammar is a
 * scope set nobody has ever mapped to a colour.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clearCodeCache,
  codeSpans,
  isRegistered,
  registeredGrammars
} from '../src/renderer/src/highlight'
import { aliasKeys, resolveLanguage } from '../src/shared/highlightLang'
import { extensionLanguageValues } from '../src/shared/toolOutput'

const RAW_CSS = readFileSync(path.join(__dirname, '../src/renderer/src/highlight.css'), 'utf8')
/**
 * Comments out. The prose in highlight.css contains commas ("tag names in the
 * site's review blue, so markup reads as markup"), and a comma is exactly what a
 * selector list is split on - parsing the file as written would read half a
 * sentence as a selector and fail on it.
 */
const CSS = RAW_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
const WIDGET_CSS = readFileSync(path.join(__dirname, '../src/renderer/src/styles.css'), 'utf8')
const BENCH_CSS = readFileSync(path.join(__dirname, '../src/renderer/src/pro/bench.css'), 'utf8')

/** Every className in a codeSpans() tree, flattened. */
function classesOf(nodes: unknown, acc: Set<string> = new Set()): Set<string> {
  if (!nodes || typeof nodes === 'string' || typeof nodes === 'number') return acc
  const list = Array.isArray(nodes) ? nodes : [nodes]
  for (const node of list) {
    const element = node as { props?: { className?: string; children?: unknown } }
    for (const cls of String(element?.props?.className ?? '').split(/\s+/)) {
      if (cls.startsWith('hljs-')) acc.add(cls)
    }
    if (element?.props && 'children' in element.props) classesOf(element.props.children, acc)
  }
  return acc
}

/**
 * One snippet per shipped grammar, deliberately chosen to exercise the scopes
 * that grammar can produce rather than to be a nice example: `hljs-params` only
 * appears in a function definition, `hljs-addition` only in a diff, `hljs-meta`
 * only where a language has decorators or a shebang. `plaintext` is here so the
 * "renders no colour" path is covered too.
 */
const CORPUS: Record<string, string> = {
  arduino: '#include <Servo.h>\nServo s;\nvoid setup() { s.attach(9); }\nvoid loop() { s.write(90); }',
  bash: '#!/usr/bin/env bash\nset -euo pipefail\nexport A="${B:-c}"\nfor i in 1 2; do echo "$i"; done',
  c: '#include <stdio.h>\nint main(void) { printf("%d\\n", 1); return 0; }',
  cpp: '#include <vector>\nclass A { public: virtual ~A() {} };\nnamespace n { struct S { int a; }; }',
  csharp: 'using System;\nnamespace N { public class C { public int M() => 1; } }',
  css: '.a#b:hover > [data-x="1"] { color: red; /* c */ }\n@import url("x.css");',
  diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new',
  go: 'package main\n\nimport "fmt"\n\nfunc f(x int) int { return x }\n\nfunc main() { fmt.Println(f(1)) }',
  graphql: 'type Query { a(x: Int): String! }\nquery Q { a }',
  ini: '[section]\nkey = value\n# comment',
  java: 'package p;\npublic class C { public static void main(String[] a) { } }',
  javascript: 'const o = { a: 1, b: /re/g }\nclass C extends D { static s = true }\nconst t = `${o.a}`',
  json: '{ "a": 1, "b": [true, null, "s"] }',
  kotlin: 'fun main() { val x: List<Int> = listOf(1); println(x) }',
  less: '@v: 1;\n.a { width: @v; &:hover { color: red; } }',
  lua: 'local function f(x) return x end\nprint(f(1))',
  makefile: 'all: a.o\n\tgcc -o all a.o\n.PHONY: all',
  markdown: '# h\n\n**b** `c` [l](u)\n\n- i\n\n> q\n\n```js\nx\n```',
  objectivec: '@interface A : NSObject\n@end\n@implementation A\n@end',
  perl: 'use strict;\nmy $x = 1;\nprint "$x\\n";',
  php: '<?php\nfunction f($x) { return "$x"; }\n',
  'php-template': '<p><?= $x ?></p>\n<?php echo "y"; ?>',
  plaintext: 'nothing styled here at all',
  python: 'import os\n\n\ndef f(x, y=1):\n    """doc"""\n    return [i for i in x]',
  'python-repl': '>>> f(1)\n2',
  r: 'f <- function(x) { x + 1 }\nprint(f(1))',
  ruby: 'def f(x)\n  x.to_s\nend\nputs f(1)',
  rust: 'fn main() { let v: Vec<u8> = vec![1]; println!("{:?}", v); }',
  scss: '$v: 1;\n@mixin m { .n { width: $v; } }\n.a { @include m; }',
  shell: '$ npm run build\n> out',
  sql: 'SELECT a, COUNT(*) AS n FROM t WHERE b > 1 GROUP BY a;',
  swift: 'import Foundation\nfunc f(_ x: Int) -> Int { return x }',
  typescript: 'import { x } from "y"\n// c\nexport function f(a: string): number { return 1 }',
  vbnet: 'Module M\n  Sub Main()\n    Dim x As Integer = 1\n  End Sub\nEnd Module',
  wasm: '(module\n  (func $f (result i32) i32.const 1))',
  xml: '<?xml version="1.0"?>\n<a b="1"><!-- c --><b/>text</a>',
  yaml: 'key: value\nlist:\n  - a: 1\n',
  // The five grammars registered on top of `common`.
  dockerfile: 'FROM node:22 AS build\nARG X=1\nRUN echo "$X"\nCMD ["node", "a.js"]',
  properties: 'KEY=value\nOTHER = 1\n# comment',
  cmake: 'cmake_minimum_required(VERSION 3.20)\nproject(x CXX)\nadd_executable(x a.cc)',
  nginx: 'server {\n  listen 80;\n  root /x;\n  location / { proxy_pass http://u; }\n}',
  protobuf: 'syntax = "proto3";\npackage p;\nmessage M { int32 a = 1; }'
}

/**
 * Scopes highlight.js produces that carry no meaning worth a colour of their
 * own: they wrap a token whose child already has one, or they are punctuation
 * that should read exactly like the surrounding code. Leaving these to inherit
 * is the decision, not an omission - so they are asserted unstyled, and giving
 * one a colour is a diff against this list that has to be reviewed.
 */
const NEUTRAL = new Set([
  'hljs-operator',
  'hljs-punctuation',
  'hljs-subst',
  'hljs-bullet',
  'hljs-code',
  'hljs-formula',
  'hljs-keyword.hljs-atrule',
  'hljs-char.escape_',
  // Wrappers around a declaration: `hljs-function` spans the whole `f(x) {}`
  // and `hljs-class` the whole `class C {}`, while the meaningful token inside
  // each (`hljs-title.function_` / `hljs-title.class_`) already carries its own
  // colour. Painting the wrapper would recolour the name AND every child with
  // no scope of its own, so the theme leaves both to inherit.
  'hljs-function',
  'hljs-class'
])

/**
 * Every container the theme has to cover: two windows times three kinds of
 * code - the fences an agent writes, the output a tool printed, and the
 * command line every tool row shows even while its output stays folded.
 */
const CONTAINERS = {
  widgetFence: '.msg-bubble .code',
  widgetOutput: '.tool-output',
  benchFence: '.convo-code',
  benchOutput: '.convo-output',
  widgetCommand: '.tool-cmd',
  benchCommand: '.convo-cmd'
} as const

type ContainerName = keyof typeof CONTAINERS

/** Escape one selector for use inside a RegExp. */
function escapeSelector(selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rulesFor(cls: string): Record<ContainerName, boolean> {
  // `.hljs-title.function_` arrives from lowlight as two classes on one span;
  // the theme styles the parent `.hljs-title`, so match on the scope root.
  const scope = cls.split('.')[0]
  const escaped = escapeSelector(scope)
  const found = {} as Record<ContainerName, boolean>
  for (const name of Object.keys(CONTAINERS) as ContainerName[]) {
    found[name] = new RegExp(`${escapeSelector(CONTAINERS[name])} \\.${escaped}\\b`).test(CSS)
  }
  return found
}

describe('highlight.css', () => {
  it('has a corpus entry for every grammar the app ships', () => {
    // Registering a grammar without a snippet means its scope set was never
    // mapped to a colour, and nothing below would notice.
    const missing = registeredGrammars().filter((g: string) => !(g in CORPUS))
    const unused = Object.keys(CORPUS).filter((g) => !isRegistered(g))
    expect({ missing, unused }).toEqual({ missing: [], unused: [] })
  })

  it('points every fence spelling at a grammar that is actually registered', () => {
    // `codeSpans()` renders an unregistered grammar as plain text, so a typo
    // here - or a highlight.js rename - silently drops the colours for that
    // fence and nothing else in the app complains. `isRegistered` is the very
    // gate the render site uses, so this table and the app cannot disagree: an
    // alias highlight.js knows (`tsx`, `console`) counts as registered even
    // though `listLanguages()` only names canonical grammars.
    const dangling: string[] = []
    for (const key of aliasKeys()) {
      const target = resolveLanguage(key)
      if (target && !isRegistered(target)) dangling.push(`${key} -> ${target}`)
    }
    expect(dangling).toEqual([])
  })

  it('points every file extension at a grammar that is actually registered', () => {
    // The same check for the other table that names grammars: the one
    // `shared/toolOutput.ts` uses to colour the result of `cat src/app.ts`. A
    // typo there renders every file with that extension plain and nothing else
    // in the app complains. It lives here rather than in toolOutput.test.ts
    // because `isRegistered()` is the renderer's, and a `.ts` test sits in the
    // node project, which cannot compile the renderer's `.tsx`.
    const dangling = extensionLanguageValues().filter((language) => !isRegistered(language))
    expect(dangling).toEqual([])
  })

  const emitted = new Set<string>()
  clearCodeCache()
  for (const [lang, source] of Object.entries(CORPUS)) {
    for (const cls of classesOf(codeSpans(lang, source))) emitted.add(cls)
  }

  it('styles every scope the shipped grammars emit, in all six containers', () => {
    const unstyled: string[] = []
    const oneSided: string[] = []
    for (const cls of [...emitted].sort()) {
      if (NEUTRAL.has(cls) || NEUTRAL.has(cls.split('.')[0])) continue
      const coverage = rulesFor(cls)
      const styled = (Object.keys(coverage) as ContainerName[]).filter((name) => coverage[name])
      if (styled.length === 0) unstyled.push(cls)
      else if (styled.length !== Object.keys(coverage).length) {
        oneSided.push(`${cls} styled=${styled.join(',')}`)
      }
    }
    expect({ unstyled, oneSided }).toEqual({ unstyled: [], oneSided: [] })
  })

  it('really did exercise the grammars, so the assertion above is not vacuous', () => {
    expect(emitted.size).toBeGreaterThan(20)
    for (const scope of ['hljs-keyword', 'hljs-string', 'hljs-comment', 'hljs-title', 'hljs-number']) {
      expect([...emitted].some((c) => c.split('.')[0] === scope)).toBe(true)
    }
  })

  it('is imported by both windows, so one code block cannot be two colours', () => {
    expect(WIDGET_CSS).toMatch(/@import '\.\/highlight\.css'/)
    expect(BENCH_CSS).toMatch(/@import '\.\.\/highlight\.css'/)
  })

  it('scopes every colour rule, so the theme cannot leak onto the interface', () => {
    // A bare `.hljs-keyword { color }` would also paint any hljs class that
    // appears outside a code block, and highlight.css is loaded globally in both
    // windows. Every selector that sets a colour must start from one of the four
    // block scopes.
    const bodies = CSS.split('}').filter((chunk) => /(^|\n)\s*(color|background|font-)/.test(chunk))
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) {
      const selectors = body
        .split('{')[0]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      expect(selectors.length).toBeGreaterThan(0)
      for (const sel of selectors) {
        expect(Object.values(CONTAINERS).some((container) => sel.startsWith(container))).toBe(true)
      }
    }
  })

  it('asks only for the two font weights the app bundles', () => {
    // Only 400 and 700 of JetBrains Mono ship (see main.tsx), so a rule asking
    // for 500 or 600 would be synthesized by the platform - bolder on Linux than
    // it is on macOS, from the same file.
    for (const weight of CSS.match(/font-weight:\s*[^;]+/g) ?? []) {
      expect(weight).toMatch(/font-weight:\s*(400|700)\s*$/)
    }
  })
})
