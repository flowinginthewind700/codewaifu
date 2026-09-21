import os from 'node:os'
import path from 'node:path'
import type { Platform } from '../shared/hookScript'
import { normalizeRequestedPort } from '../shared/portPolicy'

export const platform: Platform =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'

export const isWindows = platform === 'win32'

const home = os.homedir()

/**
 * The home directory, exported because Pro resolves a human's `~` and an empty
 * path field against it. Everything below is derived from the same value, so a
 * caller that needs "home" and a caller that needs "our state dir" cannot
 * disagree about whose home it is.
 */
export const homeDir = home

function resolveOverride(envValue: string | undefined, fallback: string): string {
  return envValue && envValue.trim() ? path.resolve(envValue) : fallback
}

/** Everything CodeWaifu writes lives here; nothing else on disk is ours. */
export const stateDir = resolveOverride(process.env.CODEWAIFU_HOME, path.join(home, '.codewaifu'))
export const hooksDir = path.join(stateDir, 'hooks')
export const backupsDir = path.join(stateDir, 'backups')
export const configFile = path.join(stateDir, 'config.json')
export const endpointFile = path.join(stateDir, 'endpoint.env')
export const logFile = path.join(stateDir, 'codewaifu.log')
/** Downloaded Live2D characters + Cubism Core (see main/assets.ts). */
export const assetRoot = path.join(stateDir, 'assets')
/** Scratch space for TTS rendered to a file so the renderer can lip-sync it. */
export const ttsDir = path.join(stateDir, 'tts')
/**
 * Images lifted off the system clipboard so an agent can be handed one as a
 * path. Under `stateDir` rather than the OS temp dir on purpose: this path is
 * typed into a prompt and read back out of a transcript weeks later, and a
 * `/var/folders/.../T/` that the OS emptied under it is a broken sentence
 * nobody can diagnose. See `main/attach.ts` for the sweep that keeps it from
 * becoming an archive of every screenshot ever pasted.
 */
export const attachmentsDir = path.join(stateDir, 'attachments')
/**
 * Neural TTS (Matcha) weights, downloaded on first run. Override to reuse an
 * existing checkout across dev runs: `CODEWAIFU_MATCHA_DIR=/path/to/models`.
 */
export const matchaDir = resolveOverride(
  process.env.CODEWAIFU_MATCHA_DIR,
  path.join(stateDir, 'models', 'matcha')
)

/** Honour the agents' own home overrides so a relocated config is still found. */
export const codexHome = resolveOverride(process.env.CODEX_HOME, path.join(home, '.codex'))
export const claudeHome = resolveOverride(process.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'))

export const codexHooksFile = path.join(codexHome, 'hooks.json')
export const codexSessionIndex = path.join(codexHome, 'session_index.jsonl')
export const codexSessionsDir = path.join(codexHome, 'sessions')
export const claudeSettingsFile = path.join(claudeHome, 'settings.json')
export const claudeProjectsDir = path.join(claudeHome, 'projects')

/**
 * Hook targets beyond Codex and Claude Code. Each keeps its own layout: Cursor
 * wants a `version: 1` file of flat definitions, Gemini reuses the Claude shape
 * under a different file with a millisecond timeout, Antigravity nests global
 * hooks under a named bundle inside *Gemini's* config dir, and Kimi has no JSON
 * at all (TOML `[[hooks]]` tables, see `shared/kimiToml.ts`).
 */
export const cursorHome = path.join(home, '.cursor')
export const cursorHooksFile = path.join(cursorHome, 'hooks.json')
export const geminiHome = path.join(home, '.gemini')
export const geminiSettingsFile = path.join(geminiHome, 'settings.json')
/** Antigravity shares Gemini's config dir; its global hooks live one level down. */
export const antigravityHooksFile = path.join(geminiHome, 'config', 'hooks.json')
/** Same resolution Kimi's own CLI uses, so hooks land in the home Kimi reads. */
export const kimiHome = resolveOverride(process.env.KIMI_CODE_HOME, path.join(home, '.kimi-code'))
export const kimiConfigToml = path.join(kimiHome, 'config.toml')

/**
 * Homes of every agent we can name. Presence here is what the bench's agent menu
 * and the settings panel use to decide a runner is worth offering; absence just
 * means the row stays hidden. Codex and Claude Code key off the same override
 * their CLIs use, so a relocated config is still found.
 */
export const detectionHomes: Record<string, string> = {
  codex: codexHome,
  claude: claudeHome,
  cursor: cursorHome,
  gemini: geminiHome,
  kimi: kimiHome,
  opencode: path.join(home, '.opencode'),
  kiro: path.join(home, '.kiro'),
  pi: path.join(home, '.pi'),
  trae: path.join(home, '.trae')
}

export const isMac = platform === 'darwin'
export const isLinux = platform === 'linux'

/**
 * `CODEWAIFU_PORT` pins the relay port from the environment (fixed firewall
 * rules, CI, tinkerers). Invalid or privileged values collapse to automatic
 * instead of being clamped into a port we would not be allowed to bind.
 */
export const envPinnedPort: number = normalizeRequestedPort(
  process.env.CODEWAIFU_PIN_PORT ?? process.env.CODEWAIFU_PORT ?? 0
)
