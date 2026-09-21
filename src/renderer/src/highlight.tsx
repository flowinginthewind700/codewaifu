/**
 * Syntax colours for the code an agent prints.
 *
 * Both transcript readers render a reply through `splitBlocks()`, which hands
 * back prose and fenced code separately; this module is the only thing that
 * knows how to turn a fence into coloured spans, and both surfaces call it so
 * the widget and the bench cannot drift into two different ideas of what
 * TypeScript looks like.
 *
 * Two decisions that came out of measuring rather than guessing:
 *
 * 1. `highlight(language, code)` only, never `highlightAuto()`. Auto-detection
 *    on a 300-character sample costs about as much as highlighting the whole
 *    transcript and it is wrong often enough to be worse than no colours: a
 *    paragraph of English prose scores `kotlin`, a directory tree scores
 *    `css`, a CI log scores `ini`. A fence with no info string therefore stays
 *    plain. The agent almost always writes one.
 * 2. Results are cached by (language, source). The widget re-renders on every
 *    poll tick and the bench on every frame push, so the same block is asked
 *    for over and over; highlighting 10k characters costs ~6ms, which is
 *    nothing once and a visible stutter on every keystroke of a stream.
 */
import type { ReactNode } from 'react'
import type { RootContent } from 'hast'
import { createLowlight, common } from 'lowlight'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import properties from 'highlight.js/lib/languages/properties'
import cmake from 'highlight.js/lib/languages/cmake'
import nginx from 'highlight.js/lib/languages/nginx'
import protobuf from 'highlight.js/lib/languages/protobuf'
import { isStylableLanguage, resolveLanguage } from '@shared/highlightLang'
import { outputLanguage, splitToolOutput } from '@shared/toolOutput'

/**
 * Above this, render plain. A fenced dump of a whole file is the one shape
 * where tokenizing stops being worth the main-thread time, and unstyled text
 * is still perfectly readable - it is what this app did before colours existed.
 */
export const MAX_HIGHLIGHT_CHARS = 24000

/**
 * `common` is highlight.js's curated set (37 grammars: the languages people
 * actually write, plus diff, json, yaml, markdown, ini, sql, makefile). The
 * five extras are the ones that turn up constantly in agent replies and are
 * missing from it - a Dockerfile, an .env, a CMakeLists, an nginx.conf, a .proto.
 */
const lowlight = createLowlight(common)
lowlight.register('dockerfile', dockerfile)
lowlight.register('properties', properties)
lowlight.register('cmake', cmake)
lowlight.register('nginx', nginx)
lowlight.register('protobuf', protobuf)

/**
 * The grammars this build can tokenize. `codeSpans()` is the gate at runtime;
 * this is the same list handed to the theme test, so a newly registered grammar
 * that emits a scope the CSS has never styled fails the test instead of showing
 * up as mysteriously grey tokens in a screenshot review.
 */
export function registeredGrammars(): string[] {
  return lowlight.listLanguages()
}

/**
 * The exact gate `codeSpans()` uses: true for a canonical grammar name AND for
 * any alias highlight.js knows (`tsx`, `console`, `jsx`), which `listLanguages()`
 * deliberately leaves out. The theme test checks the spelling table against this
 * rather than the list, so a fence that renders plain in the app is a fence that
 * fails the test - the two can never disagree about what is registered.
 */
export function isRegistered(language: string): boolean {
  return lowlight.registered(language)
}

type CacheEntry = { spans: ReactNode[]; chars: number }

/** Bounded by source characters, not entry count: one huge block must not be
    able to hold the cache open while a hundred small ones churn through it. */
const CACHE_MAX_CHARS = 512 * 1024
const cache = new Map<string, CacheEntry>()
let cacheChars = 0

/**
 * highlight.js scopes arrive as `className: ['hljs-title', 'function_']`. The
 * first is the class the theme styles; the rest are lowlight's own scope
 * suffixes, which we keep so a future theme can be more specific than we are.
 */
function toNodes(node: RootContent, key: number): ReactNode[] {
  if (node.type === 'text') return [node.value]
  // Everything else lowlight can emit - a doctype, a comment, raw HTML - has no
  // text to colour and nothing to nest, so it contributes nothing.
  if (node.type !== 'element') return []
  const className = node.properties?.className
  const classes = Array.isArray(className)
    ? className.map(String).filter(Boolean)
    : typeof className === 'string' && className
      ? [className]
      : []
  const children = node.children.flatMap((child, index) => toNodes(child, index))
  if (classes.length === 0) return children
  return [
    <span key={key} className={classes.join(' ')}>
      {children}
    </span>
  ]
}

function tokenize(language: string, text: string): ReactNode[] {
  const tree = lowlight.highlight(language, text)
  return tree.children.flatMap((child, index) => toNodes(child, index))
}

/**
 * The coloured children for one fenced block. Returns plain text (as a single
 * string node) whenever there is no grammar worth trusting, so callers can
 * render `{codeSpans(block.lang, block.text)}` unconditionally.
 */
export function codeSpans(fence: string | undefined | null, text: string): ReactNode[] {
  const source = String(text ?? '')
  const language = resolveLanguage(fence)
  if (!isStylableLanguage(language) || source.length > MAX_HIGHLIGHT_CHARS) return [source]
  if (!lowlight.registered(language)) return [source]

  const key = `${language}\u0000${source}`
  const hit = cache.get(key)
  if (hit) {
    // Re-insert so the Map's insertion order stays a least-recently-used order.
    cache.delete(key)
    cache.set(key, hit)
    return hit.spans
  }

  let spans: ReactNode[]
  try {
    spans = tokenize(language, source)
  } catch {
    // A grammar can throw on pathological input (deeply nested regexes). Code
    // that fails to tokenize still has to render; losing the colours is the
    // cheap failure, losing the block would hide what the agent wrote.
    return [source]
  }

  cache.set(key, { spans, chars: source.length })
  cacheChars += source.length
  while (cacheChars > CACHE_MAX_CHARS) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cacheChars -= cache.get(oldest.value)?.chars ?? 0
    cache.delete(oldest.value)
  }
  return spans
}

/** Test seam: the cache is module state, and a bounded cache needs a reset. */
export function clearCodeCache(): void {
  cache.clear()
  cacheChars = 0
}

/**
 * The coloured children for one tool row's command line - the one sentence of
 * code a history shows for every tool row even while its output stays folded,
 * which is what makes it the text a human scanning a transcript actually
 * reads. `bash` is the grammar: these lines are shell, and `codeSpans()` keeps
 * the whole line as one plain string whenever tokenizing fails or the line is
 * over the size gate, so a mangled summary can never render half-coloured.
 *
 * The summary is clipped at 120 characters with a trailing ellipsis
 * (`summarizeArgs`), which bash reads as an unfinished word - the same thing a
 * truncated file would look like, and harmless in a one-line chip.
 */
export function commandSpans(command: string | null | undefined): ReactNode[] {
  const source = String(command ?? '')
  if (!source) return []
  return codeSpans('bash', source)
}

/**
 * The children for one tool row's *output*, coloured where the output is
 * provably code and plain everywhere else.
 *
 * Tool rows are what a terminal history is actually made of - 11,513 of them
 * against zero fenced blocks in agent prose across 40 real Codex rollouts - so
 * this, not `codeSpans()`, is the path that decides whether the transcript
 * reads like a terminal or like a text file. Which grammar applies comes from
 * `shared/toolOutput.ts`: the command that printed the bytes, else the output's
 * own shape when a parser agrees with it, else nothing.
 *
 * The harness wrapper this app prints around a command's stdout (`Chunk ID:`,
 * `Wall time:`, the exit code, `Output:`) stays plain. Colouring it would paint
 * `Chunk ID: 4ae44c` as a TypeScript type, and it is not the agent's output.
 */
export function outputSpans(input: {
  tool?: string | null
  command?: string | null
  output?: string | null
}): ReactNode[] {
  const raw = String(input.output ?? '')
  if (!raw) return []
  const language = outputLanguage(input)
  if (!language) return [raw]
  const { head, body } = splitToolOutput(raw)
  if (!body) return [raw]
  // A string node needs no key; `codeSpans()` keys its own spans.
  const nodes: ReactNode[] = head ? [`${head}\n`] : []
  nodes.push(...codeSpans(language, body))
  return nodes
}
