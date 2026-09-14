import type { Lang } from './protocol'

/** Any CJK codepoint counts: Hiragana/Katakana, Hangul, CJK ideographs + ext A. */
const CJK = /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

export function hasCjk(text: string): boolean {
  return CJK.test(text)
}

/**
 * Detect the language to speak. One CJK character is enough to switch to Chinese:
 * mixed agent output ("正在运行 npm test") reads far better in a zh voice than in
 * an en voice, while an all-ASCII string never needs the zh voice.
 */
export function detectLang(text: string, fallback: Lang = 'en'): Lang {
  if (!text || !text.trim()) return fallback
  return hasCjk(text) ? 'zh' : 'en'
}

/** Resolve `auto` against a piece of text; explicit languages pass through. */
export function resolveLang(pref: Lang | 'auto', text: string): Lang {
  return pref === 'auto' ? detectLang(text) : pref
}

/**
 * The language the interface is written in, as opposed to the language a given
 * notice happens to be in. `auto` follows the OS, so a fresh install on a
 * Chinese Mac reads Chinese and on an English Windows reads English without
 * anybody having found the setting first.
 */
export function resolveUiLang(pref: Lang | 'auto', system: Lang): Lang {
  return pref === 'auto' ? system : pref
}

/**
 * Pick a UI language from the OS's preferred-language list (`zh-Hans-CN`,
 * `en-GB`, …). Falls back to the usual POSIX locale variables so the headless
 * CLI reports the same language the widget would, and to `zh` when nothing is
 * known — the companion's own copy is Chinese-first.
 */
export function systemLangFromLocales(locales: readonly string[]): Lang {
  const candidates = [
    ...locales,
    process.env.LC_ALL ?? '',
    process.env.LC_MESSAGES ?? '',
    process.env.LANG ?? ''
  ]
  for (const raw of candidates) {
    const value = String(raw || '').trim().toLowerCase()
    if (!value) continue
    if (value.startsWith('zh') || value.startsWith('cmn')) return 'zh'
    if (value.startsWith('en')) return 'en'
  }
  return 'zh'
}

/**
 * Strip what a TTS engine chokes on: markdown fences, URLs, long code, ANSI
 * escapes and control characters. Spoken text should be prose, not source.
 */
export function toSpeakable(text: string, maxChars = 220): string {
  let out = String(text || '')
  out = out.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, ' ')
  out = out.replace(/```[\s\S]*?```/g, ' ')
  out = out.replace(/`([^`]*)`/g, '$1')
  // Unwrap markdown images/links before the bare-URL strip, or the strip eats
  // the `](http://…` half and leaves a dangling `[label](` behind.
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  out = out.replace(/https?:\/\/\S+/g, ' ')
  // Emphasis markers only go when they actually wrap a word: `**bold**` loses
  // its stars while `exec_command` keeps its underscore, since that one is an
  // identifier the user needs to recognise in the log and in the bubble.
  out = out.replace(/(^|[^\w])(__|\*\*|~~)(?=\S)([^*_~]+?)\2(?![\w])/g, '$1$3')
  out = out.replace(/(^|[^\w])([*_])(?=\S)([^*_]*?\S)\2(?![\w])/g, '$1$3')
  out = out.replace(/[#>|~]/g, ' ')
  out = out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
  out = out.replace(/\s+/g, ' ').trim()
  if (out.length > maxChars) {
    out = clipAtBoundary(out, maxChars)
  }
  return out
}

/**
 * Cut at a word/sentence boundary instead of mid-word, and never leave a
 * dangling connector before the ellipsis.
 */
export function clipAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const window = text.slice(0, maxChars)
  const boundary = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
    window.lastIndexOf('。'),
    window.lastIndexOf('！'),
    window.lastIndexOf('？'),
    window.lastIndexOf('；'),
    window.lastIndexOf('; '),
    window.lastIndexOf(', '),
    window.lastIndexOf('，'),
    window.lastIndexOf(' ')
  )
  let cut = boundary > maxChars * 0.45 ? window.slice(0, boundary) : window
  cut = cut.replace(/[,;:、，；：\-\u2014\u2013]+\s*$/, '')
  return `${cut.trim()}…`
}
