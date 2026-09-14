import type { Lang } from './protocol'
import { normalizeRequestedPort } from './portPolicy'

export interface EventToggles {
  sessionStart: boolean
  stop: boolean
  permission: boolean
  notification: boolean
  tool: boolean
  compact: boolean
  subagent: boolean
  prompt: boolean
}

export interface VoiceConfig {
  auto: boolean
  zh: string
  en: string
  /** Words per minute, macOS `say -r`. */
  rate: number
}

export interface AppConfig {
  version: 1
  /**
   * Loopback relay port. `0` = automatic: bind the last working port if it is
   * still free, otherwise let the kernel choose. Non-zero is a preference, and
   * a hard requirement when `pinPort` is set.
   */
  port: number
  /** Treat `port` as a promise: report a conflict loudly instead of moving on. */
  pinPort: boolean
  token: string
  enabled: boolean
  speak: boolean
  popOnSessionStart: boolean
  alwaysOnTop: boolean
  opacity: number
  scale: number
  bubbleMs: number
  maxQueue: number
  lang: Lang | 'auto'
  voice: VoiceConfig
  events: EventToggles
  avatar: { mode: 'builtin' | 'image'; imagePath: string; expression: string }
  window: { x: number; y: number }
  /** Install the agent hooks automatically on every launch. */
  autoInstallHooks: boolean
}

export const CONFIG_VERSION = 1 as const

export const DEFAULT_CONFIG: AppConfig = {
  version: CONFIG_VERSION,
  port: 0,
  pinPort: false,
  token: '',
  enabled: true,
  speak: true,
  popOnSessionStart: true,
  alwaysOnTop: true,
  opacity: 1,
  scale: 1,
  bubbleMs: 7000,
  maxQueue: 4,
  lang: 'auto',
  voice: { auto: true, zh: '', en: '', rate: 178 },
  events: {
    sessionStart: true,
    stop: true,
    permission: true,
    notification: true,
    tool: false,
    compact: true,
    subagent: true,
    prompt: false
  },
  avatar: { mode: 'builtin', imagePath: '', expression: 'idle' },
  window: { x: -1, y: -1 },
  autoInstallHooks: true
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Merge an untrusted/partial config blob over the defaults. Every field is
 * clamped so a hand-edited config.json cannot crash the app or point the HTTP
 * server at a privileged port.
 */
export function parseConfig(input: unknown): AppConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const d = DEFAULT_CONFIG
  const rawVoice = (raw.voice && typeof raw.voice === 'object' ? raw.voice : {}) as Record<string, unknown>
  const rawEvents = (raw.events && typeof raw.events === 'object' ? raw.events : {}) as Record<string, unknown>
  const rawAvatar = (raw.avatar && typeof raw.avatar === 'object' ? raw.avatar : {}) as Record<string, unknown>
  const rawWindow = (raw.window && typeof raw.window === 'object' ? raw.window : {}) as Record<string, unknown>
  const langRaw = str(raw.lang, d.lang)
  const avatarMode = str(rawAvatar.mode, d.avatar.mode)

  return {
    version: CONFIG_VERSION,
    // 0 means automatic; anything unusable collapses back to automatic rather
    // than being clamped into a port we do not own.
    port: normalizeRequestedPort(raw.port ?? d.port),
    pinPort: bool(raw.pinPort, d.pinPort),
    token: str(raw.token, d.token),
    enabled: bool(raw.enabled, d.enabled),
    speak: bool(raw.speak, d.speak),
    popOnSessionStart: bool(raw.popOnSessionStart, d.popOnSessionStart),
    alwaysOnTop: bool(raw.alwaysOnTop, d.alwaysOnTop),
    opacity: num(raw.opacity, d.opacity, 0.35, 1),
    scale: num(raw.scale, d.scale, 0.6, 2),
    bubbleMs: Math.trunc(num(raw.bubbleMs, d.bubbleMs, 1500, 30000)),
    maxQueue: Math.trunc(num(raw.maxQueue, d.maxQueue, 1, 12)),
    lang: langRaw === 'zh' || langRaw === 'en' ? langRaw : 'auto',
    voice: {
      auto: bool(rawVoice.auto, d.voice.auto),
      zh: str(rawVoice.zh, d.voice.zh),
      en: str(rawVoice.en, d.voice.en),
      rate: Math.trunc(num(rawVoice.rate, d.voice.rate, 90, 400))
    },
    events: {
      sessionStart: bool(rawEvents.sessionStart, d.events.sessionStart),
      stop: bool(rawEvents.stop, d.events.stop),
      permission: bool(rawEvents.permission, d.events.permission),
      notification: bool(rawEvents.notification, d.events.notification),
      tool: bool(rawEvents.tool, d.events.tool),
      compact: bool(rawEvents.compact, d.events.compact),
      subagent: bool(rawEvents.subagent, d.events.subagent),
      prompt: bool(rawEvents.prompt, d.events.prompt)
    },
    avatar: {
      mode: avatarMode === 'image' ? 'image' : 'builtin',
      imagePath: str(rawAvatar.imagePath, d.avatar.imagePath),
      expression: str(rawAvatar.expression, d.avatar.expression)
    },
    window: {
      x: Math.trunc(num(rawWindow.x, d.window.x, -1, 100000)),
      y: Math.trunc(num(rawWindow.y, d.window.y, -1, 100000))
    },
    autoInstallHooks: bool(raw.autoInstallHooks, d.autoInstallHooks)
  }
}

/** Fields the renderer may change; the token is generated and never editable. */
export type ConfigPatch = Partial<Omit<AppConfig, 'version' | 'token'>>

export const CONFIG_PATCH_KEYS: Array<keyof ConfigPatch> = [
  'enabled',
  'speak',
  'popOnSessionStart',
  'alwaysOnTop',
  'opacity',
  'scale',
  'bubbleMs',
  'maxQueue',
  'lang',
  'voice',
  'events',
  'avatar',
  'window',
  'autoInstallHooks',
  'port',
  'pinPort'
]

export function applyPatch(config: AppConfig, patch: unknown): AppConfig {
  const raw = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  const picked: Record<string, unknown> = {}
  for (const key of CONFIG_PATCH_KEYS) {
    if (key in raw) picked[key as string] = raw[key as string]
  }
  return parseConfig({ ...config, ...picked })
}
