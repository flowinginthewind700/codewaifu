/**
 * The terminal's font, resolved the only way a 2D context can accept it.
 *
 * xterm measures and draws glyphs through canvas (and the WebGL atlas built
 * from it). `ctx.font` does not substitute CSS custom properties: handing it
 * the literal string `var(--mono)` leaves the context on its default 10px
 * sans-serif, so every cell is measured with the wrong advance and the pane
 * renders as ragged, letter-spaced noise while the DOM around it looks fine.
 * The stack therefore has to arrive as a literal family list - read back from
 * the very custom property the rest of the UI uses, so the terminal and the
 * code blocks cannot drift apart, with a fallback for contexts that have no
 * stylesheet at all (tests, SSR).
 *
 * The list is ordered like the SOTA terminals we measure against (Orca and
 * cmux both ship a Menlo-first stack): a modern coding face where one is
 * installed, the platform's own mono next, then a CJK mono so Chinese output
 * keeps exact double-width cells, then the universal Linux mono, then the
 * generic keyword. Per-glyph fallback means the first family that actually
 * exists on the box wins for Latin, and Han falls through to the CJK mono.
 */
export const MONO_FALLBACK =
  "ui-monospace, 'JetBrains Mono', 'Fira Code', 'Cascadia Mono', 'SF Mono', Menlo, " +
  "Consolas, 'Noto Sans Mono CJK SC', 'DejaVu Sans Mono', monospace"

/**
 * Choose the stack to hand xterm, given what tokens.css declares for `--mono`.
 * Pure on purpose: the DOM read stays in Pane.tsx (which has a document), so
 * this module typechecks under the node project that the tests live in.
 *
 * A value that still contains `var(` is refused: that is the exact string
 * canvas cannot resolve, and accepting it would put the original bug back one
 * indirection deeper.
 */
export function monoStack(declared?: string | null): string {
  const stack = (declared ?? '').trim()
  return stack && !stack.includes('var(') ? stack : MONO_FALLBACK
}
