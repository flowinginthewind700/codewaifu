import os from 'node:os'
import path from 'node:path'
import type { Platform } from '../shared/hookScript'
import { normalizeRequestedPort } from '../shared/portPolicy'

export const platform: Platform =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'

export const isWindows = platform === 'win32'

const home = os.homedir()

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

/** Honour the agents' own home overrides so a relocated config is still found. */
export const codexHome = resolveOverride(process.env.CODEX_HOME, path.join(home, '.codex'))
export const claudeHome = resolveOverride(process.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'))

export const codexHooksFile = path.join(codexHome, 'hooks.json')
export const codexSessionIndex = path.join(codexHome, 'session_index.jsonl')
export const codexSessionsDir = path.join(codexHome, 'sessions')
export const claudeSettingsFile = path.join(claudeHome, 'settings.json')
export const claudeProjectsDir = path.join(claudeHome, 'projects')

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
