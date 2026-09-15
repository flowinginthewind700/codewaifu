/**
 * The find bar's query planner: pure decisions, no DOM, no xterm import.
 *
 * `SearchAddon` compiles a regex the moment it is handed one and lets the throw
 * escape, so a half-typed pattern (`err(or`) would surface as an uncaught
 * exception inside a debounce timer: no message on screen, no matches, and a
 * find bar that looks broken from the second character onwards. The plan is
 * computed here instead, where a test can pin every rejection, and the bar shows
 * the reason in the same counter that shows the match count.
 *
 * This module deliberately does not import the addon's `ISearchOptions`: a
 * shared module is imported by main as well, and the only thing main would get
 * from that import is a dependency on a renderer library.
 */

/** The two toggles the bar owns. Both are off by default: plain substring find. */
export interface FindOptions {
  regex: boolean
  caseSensitive: boolean
}

/** Why a query cannot be searched yet. `empty` is not a fault, only a no-op. */
export type FindFault =
  | { kind: 'bad-pattern'; message: string }
  | { kind: 'empty-match' }

export type FindPlan =
  | { kind: 'empty' }
  | FindFault
  | { kind: 'search'; term: string; options: FindOptions }

/** How much of a RegExp error message fits in a counter the width of a thumb. */
const MESSAGE_MAX = 160

/**
 * V8's shape: `Invalid regular expression: /err(or/gi: Unterminated group`.
 *
 * Greedy to the last `/flags: `, because the reason is what has to survive and a
 * pattern may itself contain that sequence. The flags are part of the echo -
 * the addon always compiles with `g`, and with `i` unless case is on.
 */
const ENGINE_ECHO = /^Invalid regular expression: \/.*\/[a-z]*: /

/**
 * The flags `SearchAddon` compiles with, mirrored exactly.
 *
 * Validating against a different flag set is how a planner comes to approve a
 * pattern the addon then rejects: `i` is harmless, but a stray `u` would turn
 * `\d` style escapes and unbraced `\p` into syntax errors the addon does not
 * have.
 */
function addonFlags(caseSensitive: boolean): string {
  return caseSensitive ? 'g' : 'gi'
}

/**
 * The part of an engine complaint worth showing.
 *
 * The middle of V8's message is the pattern the human just typed and can still
 * read in the input, so echoing it back costs the counter the only space it has
 * and hides the reason. Anything not shaped that way - another engine, a
 * non-Error throw - passes through truncated rather than being guessed at.
 */
function faultMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = raw.replace(ENGINE_ECHO, '')
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX)}…` : text
}

/**
 * Turn the bar's three controls into something the addon can be handed.
 *
 * With `regex` off the term is passed through untouched. Metacharacters have to
 * survive as literals there - searching for `a+b` in a build log is a search for
 * those three characters, and escaping them for the user would be indistinguishable
 * from the bar silently not finding what they typed.
 */
export function planFind(term: string, options: FindOptions): FindPlan {
  if (!term) return { kind: 'empty' }
  if (!options.regex) return { kind: 'search', term, options }

  let compiled: RegExp
  try {
    compiled = new RegExp(term, addonFlags(options.caseSensitive))
  } catch (error) {
    return { kind: 'bad-pattern', message: faultMessage(error) }
  }

  // A pattern that matches the empty string matches at every cell boundary of
  // every line, so `a*`, `^` and `(?:)` all "succeed" with a count in the tens
  // of thousands and a highlight over the whole scrollback. Refusing it is the
  // only answer that is not a lie: the count would be arithmetically right and
  // useless. (Catastrophic backtracking is not detectable here; the debounce is
  // what keeps one keystroke from costing more than one scan.)
  if (compiled.test('')) return { kind: 'empty-match' }

  return { kind: 'search', term, options }
}
