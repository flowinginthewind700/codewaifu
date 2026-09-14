import type { Lang } from './protocol'

// ============================================================
// Speech text pipeline, shared by every engine (Matcha neural, macOS `say`,
// SAPI, espeak-ng).
//
// Two stages, deliberately separate:
//
//   1. `toSpeakable` (in lang.ts) removes what is not language at all — markdown,
//      URLs, ANSI escapes, code fences. Engine agnostic.
//   2. `toPhonetic` here rewrites what *is* language but a phonemiser cannot
//      place: `src/main/tts.ts`, `exec_command`, `paper-search`, `v0.1.0`.
//      These are the strings coding agents actually emit, and every one of them
//      is an out-of-vocabulary token to espeak-ng, which either drops it or
//      spells it letter by letter.
//
// The rule for the whole file: a rewrite is only allowed when saying it the new
// way is what a human reading the notice aloud would do. Nothing here may drop
// information the listener needs.
// ============================================================

/** Emoji, dingbats, variation selectors, ZWJ. Nothing pronounces these. */
const PICTOGRAMS =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu

/** Box drawing and block elements leak out of terminal-formatted agent output. */
const BOX_DRAWING = /[\u2500-\u259F\u2580-\u259F]/g

/**
 * Rewrite one line into something a grapheme-to-phoneme stage can actually
 * pronounce. Idempotent: running it twice changes nothing.
 */
export function toPhonetic(text: string): string {
  let out = String(text || '')
  if (!out) return ''

  out = out.replace(PICTOGRAMS, ' ').replace(BOX_DRAWING, ' ')

  // A clipped line ends in `…`; that is a UI affordance, and espeak turns it
  // into a long trailing pause. The sentence already ended, so drop it.
  out = out.replace(/\u2026+$/g, '').replace(/\u2026+/g, ' ')

  // Paths and identifiers: the separator is a word boundary when spoken, not a
  // character. `src/main/tts.ts` -> `src main tts ts`, `exec_command` ->
  // `exec command`. Guarded by a word character on both sides so a leading `-`
  // (a list bullet) and a sentence-final `/` are untouched.
  out = out.replace(/(?<=[\w])[/\\_](?=[\w])/g, ' ')
  // Hyphen: always a word boundary here. `paper-search` -> `paper search`,
  // `2026-09-14` -> `2026 09 14`. espeak-ng has no entry for `-` at all, so
  // leaving it in logs `Ignore OOV '-'` and silently drops the character;
  // measured on the notice corpus that was 6 dropped characters per 16 lines.
  out = out.replace(/(?<=[A-Za-z\d])-+(?=[A-Za-z\d])/g, ' ')
  // `.` between letters is a file extension or an abbreviation boundary.
  // Left alone between digits on purpose: `v0.1.0` reads better as
  // "v zero point one point zero" than as three unrelated numbers.
  out = out.replace(/(?<=[A-Za-z])\.(?=[A-Za-z])/g, ' ')

  // Symbols with a spoken word that the lexicon does not carry.
  out = out
    .replace(/(?<=[\w])@(?=[\w])/g, ' at ')
    .replace(/#/g, ' ')
    .replace(/\*/g, ' ')
    .replace(/~/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/[{}[\]<>]/g, ' ')
    .replace(/\$(?=\d)/g, ' dollars ')

  // Long runs of punctuation read as one boundary, not three.
  out = out.replace(/([,;:])\1+/g, '$1')
  out = out.replace(/\s+/g, ' ')
  return out.trim()
}

/**
 * Split into synthesis units. Matcha and the OS engines both sound better on
 * sentence-sized input than on a paragraph: pauses land where the punctuation
 * is, and streaming the first sentence cuts the time-to-first-audio from
 * "whole notice" to "first clause".
 *
 * Ported from robotworld's `lib/tts/chunker.ts` (same site, same agent
 * notices) so the two products pause in the same places.
 */
export function splitSentences(text: string, maxChars = 160): string[] {
  const sentences = String(text || '')
    .split(/(?<=[。.!！?？；;])\s*/u)
    .map((s) => s.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      out.push(sentence)
      continue
    }
    let piece = ''
    for (const part of sentence.split(/(?<=[，,、：:—])\s*/u)) {
      if (piece && piece.length + part.length > maxChars) {
        out.push(piece.trim())
        piece = ''
      }
      piece += part
    }
    if (piece.trim()) out.push(piece.trim())
  }
  return out.filter(Boolean)
}

/** Full pipeline: engine-agnostic cleanup, then phonetic rewrite, then split. */
export function speechUnits(text: string, maxChars = 160): string[] {
  return splitSentences(toPhonetic(text), maxChars)
}

/**
 * Words-per-minute -> Matcha `speed` multiplier. 178 wpm is the macOS `say`
 * default that `voice.rate` ships with, so the shipped config sounds the same
 * speed on both engines and moving the slider moves both.
 */
export const NEUTRAL_WPM = 178

export function rateToSpeed(wordsPerMinute: number): number {
  if (!Number.isFinite(wordsPerMinute) || wordsPerMinute <= 0) return 1
  return Math.min(2, Math.max(0.5, wordsPerMinute / NEUTRAL_WPM))
}

/** `true` when a line is mostly CJK — used to pick the fallback OS voice. */
export function isMostlyCjk(text: string): boolean {
  const cjk = (String(text || '').match(/[\u4e00-\u9fff]/g) || []).length
  const latin = (String(text || '').match(/[A-Za-z]/g) || []).length
  return cjk > 0 && cjk >= latin
}

export function speechLang(text: string, fallback: Lang = 'en'): Lang {
  return isMostlyCjk(text) ? 'zh' : fallback
}
