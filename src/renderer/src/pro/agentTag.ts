/**
 * The colour class behind an agent name.
 *
 * One copy, imported by the tree, the pane header and the import picker: three
 * surfaces that paint the same fact (which agent is this) and must not drift
 * into two shades of the same agent. Matching is a substring on purpose - herdr
 * reports manifests like `codex` and `claude`, but a custom one
 * (`claude-sonnet`) or a suffixed binary (`cursor-agent`, `kiro-cli`) should
 * still land on its family's colour rather than on neutral grey.
 *
 * Two families need the whole string instead: `agy` is herdr's own id for
 * Antigravity and `pi` is a real agent, and a substring test on either would
 * paint anything containing those letters (`copilot` matches `pi`). Every
 * agent we do not name keeps the neutral tag, which is the honest answer for a
 * manifest this build has never seen.
 */

/** Order matters: longer, more specific names are tested before their prefixes. */
const SUBSTRINGS: ReadonlyArray<[needle: string, klass: string]> = [
  ['codex', 'codex'],
  ['claude', 'claude'],
  ['antigravity', 'antigravity'],
  ['cursor', 'cursor'],
  ['gemini', 'gemini'],
  ['kimi', 'kimi'],
  ['zcode', 'zcode'],
  ['opencode', 'opencode'],
  ['kiro', 'kiro'],
  ['trae', 'trae']
]

/** Ids too short or too odd to match as a substring. */
const EXACT: Record<string, string> = { agy: 'antigravity', pi: 'pi' }

export function agentClass(agent: string): string {
  const key = String(agent || '').toLowerCase()
  if (EXACT[key]) return EXACT[key]
  for (const [needle, klass] of SUBSTRINGS) {
    if (key.includes(needle)) return klass
  }
  return ''
}
