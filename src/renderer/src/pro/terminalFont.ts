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
 * The list leads with the face we ship ourselves. Trusting the host is how a
 * terminal ends up ugly by accident: on a stock Linux box `ui-monospace`
 * resolves through fontconfig to DejaVu Sans Mono, and every "modern coding
 * face" in a host-only stack is silently skipped because none is installed -
 * the pane then renders in a 2004-era metric and reads as "wrong font" even
 * though every column aligns. Ghostty and cmux settle this the same way: the
 * font rides inside the app (JetBrains Mono, OFL-1.1, via @fontsource), so
 * Latin renders identically on every machine. Behind it: the platform's own
 * mono, then a CJK mono so Chinese output keeps exact double-width cells
 * (Han is not in JetBrains Mono and stays a system face, as in every web
 * terminal), then the universal Linux mono, then the generic keyword.
 */
export const MONO_FALLBACK =
  "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, " +
  "'Noto Sans Mono CJK SC', 'DejaVu Sans Mono', monospace"

/**
 * The faces xterm has to be able to measure before a pane opens.
 *
 * xterm sizes every cell through canvas at `open()` time; a face that is
 * still downloading is measured as whatever fallback canvas has right then,
 * and the pane keeps those metrics for its whole life. The bundled faces
 * arrive as woff2 over `file://` (dev: over the vite server), so on a cold
 * start they are *always* still downloading when React mounts the first
 * pane. `document.fonts.load` is the only honest gate: it resolves once the
 * bytes for the requested face are parsed, and resolves empty - not throws -
 * when no such face is declared.
 */
const MEASURE_SPECS = [
  '12px "JetBrains Mono"',
  'bold 12px "JetBrains Mono"',
  'italic 12px "JetBrains Mono"'
]

/**
 * Resolve once the bundled faces can be measured; never reject.
 *
 * A face that fails to load is a fallback, not a crash: the stack behind it
 * is still a literal list of installed families, and a pane that refuses to
 * open would look exactly like "herdr died". Contexts with no document at
 * all (tests, SSR) resolve immediately - there is no canvas to mis-measure.
 */
export async function terminalFontsReady(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return
  try {
    await Promise.all(MEASURE_SPECS.map((spec) => document.fonts.load(spec)))
  } catch {
    /* see above: fallback stack, not a fault */
  }
}

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
