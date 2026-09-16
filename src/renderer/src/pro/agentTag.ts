/**
 * The colour class behind an agent name.
 *
 * One copy, imported by the tree, the pane header and the import picker: three
 * surfaces that paint the same two facts (this is codex, this is claude) and
 * must not drift into two shades of the same agent. Matching is a substring on
 * purpose - herdr reports manifests like `codex` and `claude`, but a custom one
 * (`claude-sonnet`) should still land on its family's colour rather than on
 * neutral grey.
 */
export function agentClass(agent: string): string {
  const key = String(agent || '').toLowerCase()
  if (key.includes('codex')) return 'codex'
  if (key.includes('claude')) return 'claude'
  return ''
}
