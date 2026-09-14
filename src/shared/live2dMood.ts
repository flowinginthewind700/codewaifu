// ============================================================
// Event mood -> a Live2D expression this character actually ships.
//
// The widget already reduces a hook event to one of five moods
// (`expressionForKind`), but expression *names* are per-model: Haru calls
// surprise `surprise`, Mao calls it `surprised`, and neither ships the other's
// set. Asking a model for a name it does not have is silent in Cubism — she
// just keeps her previous face, so the mismatch never shows up as an error.
// Picking from an ordered candidate list against the catalog keeps her
// reactive without a per-character lookup table to maintain.
// ============================================================
import type { Expression } from './ui'
import type { Live2DCharacter } from './live2dCatalog'

/** Ordered fallbacks per mood; first name the model ships wins. */
const CANDIDATES: Record<Expression, readonly string[]> = {
  alert: ['surprise', 'surprised', 'scare'],
  talk: ['happy', 'happy-01', 'smile'],
  happy: ['happy-01', 'happy', 'smile'],
  sleepy: ['sad', 'coldness', 'embarrass'],
  idle: ['smile']
}

/**
 * The expression name to set for a mood, or null when the model ships none of
 * the candidates (callers should then leave her face alone).
 */
export function expressionForMood(character: Live2DCharacter, mood: Expression): string | null {
  const owned = new Set(character.expressions)
  for (const name of CANDIDATES[mood] ?? []) {
    if (owned.has(name)) return name
  }
  return null
}

/** True when the model declares a motion group with at least one entry. */
export function canPlayGroup(character: Live2DCharacter, group: string): boolean {
  return (character.motionGroups[group] ?? 0) > 0
}
