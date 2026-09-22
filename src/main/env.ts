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
/**
 * Antigravity has no home directory of its own to probe - it lives inside
 * Gemini's. The `config/` dir holding its hooks file is the closest honest
 * marker, so a machine with both agents reports both instead of claiming only
 * one exists. Still a heuristic like every other probe here: presence of that
 * dir means "some Antigravity config is there", not that a binary is on PATH.
 */
export const antigravityHome = path.dirname(antigravityHooksFile)
/** Same resolution Kimi's own CLI uses, so hooks land in the home Kimi reads. */
export const kimiHome = resolveOverride(process.env.KIMI_CODE_HOME, path.join(home, '.kimi-code'))
export const kimiConfigToml = path.join(kimiHome, 'config.toml')

/**
 * ZCode keeps a hook config at `~/.zcode/cli/config.json`. Its root object is
 * the user's (provider, model, permission, storage, ...), so only `hooks` is
 * ever rewritten here - see `shared/hooksMerge.ts::mergeZcodeHooks`.
 */
export const zcodeHome = resolveOverride(process.env.ZCODE_STORAGE_DIR, path.join(home, '.zcode'))
export const zcodeHooksFile = path.join(zcodeHome, 'cli', 'config.json')
/**
 * ZCode writes no JSONL: its whole history lives in one SQLite file, three
 * tables (`session`, `message`, `part`), under the same home the hook config
 * uses. Read-only access, in `main/zcodeDb.ts`.
 */
export const zcodeDbFile = path.join(zcodeHome, 'cli', 'db', 'db.sqlite')

/**
 * OpenCode has no hook config: it loads every file in `plugins/` under its
 * config dir. We write one plugin that relays lifecycle events to us. Both
 * homes are checked because `~/.config/opencode` is current and `~/.opencode`
 * is the older layout still in use.
 */
export const opencodeConfigDir = resolveOverride(
  process.env.OPENCODE_CONFIG_DIR,
  path.join(home, '.config', 'opencode')
)
export const opencodeLegacyConfigDir = path.join(home, '.opencode')
/** Basename, so a relocated config dir still resolves to the same plugin. */
export const opencodePluginName = 'codewaifu-agent-state.js'
export const opencodePluginFile = path.join(opencodeConfigDir, 'plugins', opencodePluginName)

/**
 * Pi loads TypeScript extensions from `~/.pi/agent/extensions/`. Same idea as
 * OpenCode's plugin: a relay file, not a hook config.
 */
export const piHome = resolveOverride(process.env.PI_CODING_AGENT_DIR, path.join(home, '.pi'))
export const piExtensionName = 'codewaifu-agent-state.ts'
/**
 * Pi's own `getAgentDir()` returns `$PI_CODING_AGENT_DIR` *as-is* when it is
 * set, and only falls back to `~/.pi/agent` otherwise. So the override replaces
 * the `agent` directory, not its parent - mirroring that exactly, because
 * `piHome/agent/extensions` would look one level too deep on a relocated agent
 * dir and we would install a file Pi never loads.
 */
export const piAgentDir = resolveOverride(
  process.env.PI_CODING_AGENT_DIR,
  path.join(home, '.pi', 'agent')
)
export const piExtensionFile = path.join(piAgentDir, 'extensions', piExtensionName)

/**
 * Kiro reads hooks from `~/.kiro/hooks/`, honouring `KIRO_HOME` the same way
 * its own CLI does. Every file in that directory is loaded, so ours is named
 * after us and never overwrites a hook file the user wrote beside it.
 */
export const kiroHome = resolveOverride(process.env.KIRO_HOME, path.join(home, '.kiro'))
export const kiroHooksFile = path.join(kiroHome, 'hooks', 'codewaifu.json')

/**
 * Trae has a single global hook file and no home override, so there is nothing
 * to resolve and nothing to relocate: `~/.trae/hooks.json`. It is shared with
 * whatever else the user put there, which is why the merge below carries every
 * foreign entry through.
 */
export const traeHome = path.join(home, '.trae')
export const traeHooksFile = path.join(traeHome, 'hooks.json')

/**
 * Homes of every agent we can name, one or more candidate directories each.
 * Presence here is what the bench's agent menu and the settings panel use to
 * decide a runner is worth offering; absence just means the row stays hidden.
 * Codex, Claude Code, Kimi, ZCode, OpenCode and Pi key off the same override
 * their own CLI uses, so a relocated config is still found. A list rather than
 * a single path because two agents have two legitimate homes (OpenCode:
 * `~/.config/opencode` or `~/.opencode`) and either one means "installed".
 */
export const detectionHomes: Record<string, readonly string[]> = {
  codex: [codexHome],
  claude: [claudeHome],
  cursor: [cursorHome],
  gemini: [geminiHome],
  antigravity: [antigravityHome],
  kimi: [kimiHome],
  zcode: [zcodeHome],
  opencode: [opencodeConfigDir, opencodeLegacyConfigDir],
  kiro: [kiroHome],
  pi: [piHome],
  trae: [traeHome]
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
