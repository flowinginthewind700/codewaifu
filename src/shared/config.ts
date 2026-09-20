import type { Lang, VoiceEngine } from './protocol'
import { normalizeRequestedPort } from './portPolicy'
import { DEFAULT_HOTKEY } from './hotkey'
import type { AvatarMode } from './ui'
import { ZOOM_MAX, ZOOM_MIN, clampZoom } from './zoom'

export interface AvatarConfig {
  mode: AvatarMode
  /** Path of a user-supplied still image (`mode: 'image'`). */
  imagePath: string
  /** Built-in SVG face (`mode: 'builtin'`). */
  expression: string
  /** Live2D character id from the asset catalog (`mode: 'live2d'`). */
  character: string
}

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

/** How much of the desktop the widget lets through. */
export interface AppearanceConfig {
  /**
   * `glass` keeps the sheet translucent and blurred so the window behind it
   * stays readable; `solid` is opaque for busy wallpapers and screen sharing.
   */
  surface: 'glass' | 'solid'
  /**
   * While collapsed, let the companion stand straight on the desktop with no
   * sheet behind her at all. The chrome floats as a pill and the empty space
   * around her still passes clicks through to whatever is underneath.
   */
  clearStage: boolean
}

export interface VoiceConfig {
  auto: boolean
  zh: string
  en: string
  /** Words per minute, macOS `say -r`. */
  rate: number
  /** Which engine speaks. `matcha` needs a one-time 134MB weight download. */
  engine: VoiceEngine
  /**
   * Fetch the neural weights in the background on launch. Off is for metered
   * connections; the OS voice keeps working either way, so this never silences
   * the companion.
   */
  autoDownload: boolean
}

export interface AppConfig {
  version: 2
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
  /**
   * Interface zoom, applied as `webContents.setZoomFactor` on every window, so
   * it scales type and layout together (Ctrl/Cmd + and -). Distinct from
   * `scale`, which is the avatar's own size slider: zooming the interface must
   * not also inflate the Live2D model, whose canvas is already sized to the
   * stage. One rung of `shared/zoom.ts`, persisted like any other preference.
   */
  uiZoom: number
  bubbleMs: number
  maxQueue: number
  lang: Lang | 'auto'
  /**
   * Language the interface is written in. Independent of `lang`, which is the
   * language notices are *spoken* in: a Chinese UI can still read English agent
   * output aloud in an English voice. `auto` follows the OS.
   */
  uiLang: Lang | 'auto'
  voice: VoiceConfig
  events: EventToggles
  avatar: AvatarConfig
  appearance: AppearanceConfig
  window: { x: number; y: number }
  /** Install the agent hooks automatically on every launch. */
  autoInstallHooks: boolean
  /**
   * Electron accelerator for the system-wide summon/hide shortcut. While a
   * non-empty input in our own window is focused the shortcut stays idle, so
   * it can never yank the window out from under a draft. See shared/hotkey.ts.
   */
  hotkey: string
  /** CodeWaifu Pro: the bench, its herdr runtime and the companion link. */
  pro: ProConfig
}

/**
 * Pro's knobs. Everything here is a preference, never a requirement: with
 * `enabled` off the companion behaves exactly as it did before Pro existed, and
 * with no herdr on the machine the bench degrades to an install card.
 */
export interface ProConfig {
  enabled: boolean
  /** Explicit herdr binary; '' means discover it on PATH and in common spots. */
  herdrPath: string
  /** `HERDR_SESSION` equivalent: which named herdr session to talk to. */
  herdrSession: string
  /** `HERDR_SOCKET_PATH` equivalent; wins over discovery when non-empty. */
  socketPath: string
  /** When an attention item may pull the widget onto the screen. */
  summon: 'always' | 'blocking' | 'never'
  /** Speak attention items aloud (the ambient channel's whole point). */
  speakAttention: boolean
  /** Show them as bubbles, which is what makes them clickable. */
  bubbleAttention: boolean
  /** Mirror the queue length onto the tray icon. */
  badge: boolean
  /** How long a `working` pane with no output counts as stalled. */
  stalledAfterMs: number
  /** Approve/deny keystrokes per agent: `codex.approve` -> `1`. */
  keys: Record<string, string>
  /** Bench window geometry; -1 means centred on first open. */
  bench: { width: number; height: number; x: number; y: number }
  /** Open the Bench window on launch instead of waiting to be summoned. */
  openBenchOnLaunch: boolean
  /**
   * Start the herdr server ourselves when the binary is installed and no socket
   * is listening. This is the reboot half of durability: herdr keeps panes
   * alive across its own restarts, but nothing on the box starts it after one,
   * and a bench that boots into an install card is a bench that stopped work.
   */
  autoStartHerdr: boolean
  /**
   * Once herdr is online and one snapshot has been reconciled, apply the
   * recovery plans that need no live pane: recreate the workspace, relaunch the
   * agent with its recorded session id, re-prompt from the ledger. One attempt
   * per connection, and only for work with nothing running - a task whose pane
   * herdr restored is left alone, because the only evidence we could act on is
   * herdr's screen-based agent detection and a false negative means two agents
   * editing one worktree.
   */
  autoResumeOnBoot: boolean
}

/**
 * Bumped when a stored config has to be reinterpreted. v2 is the Live2D face
 * becoming the default; see `migrateConfig`.
 */
export const CONFIG_VERSION = 2 as const

/**
 * Declared before `DEFAULT_CONFIG` so the default config can point at the very
 * same object instead of repeating fourteen fields that could drift.
 */
export const DEFAULT_PRO: ProConfig = {
  enabled: true,
  herdrPath: '',
  herdrSession: '',
  socketPath: '',
  summon: 'blocking',
  speakAttention: true,
  bubbleAttention: true,
  badge: true,
  stalledAfterMs: 300000,
  keys: {},
  bench: { width: 1180, height: 760, x: -1, y: -1 },
  openBenchOnLaunch: false,
  autoStartHerdr: true,
  autoResumeOnBoot: true
}

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
  uiZoom: 1,
  bubbleMs: 7000,
  maxQueue: 4,
  lang: 'auto',
  uiLang: 'auto',
  // Matcha is the default voice: it is the reason this app sounds like a
  // person instead of a 1990s screen reader, and it reads mixed zh/en notices
  // in one pass. The system engine stays as the no-download fallback.
  voice: { auto: true, zh: '', en: '', rate: 178, engine: 'matcha', autoDownload: true },
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
  // Live2D is the default face: it is the companion this app exists for. The
  // built-in SVG stays as the offline fallback (assets download on first run).
  avatar: { mode: 'live2d', imagePath: '', expression: 'idle', character: 'HaruGreeter' },
  appearance: { surface: 'glass', clearStage: true },
  window: { x: -1, y: -1 },
  autoInstallHooks: true,
  hotkey: DEFAULT_HOTKEY,
  pro: DEFAULT_PRO
}

/**
 * Rewrite a config blob written by an older build before it is parsed.
 *
 * v1 had no Live2D at all: its default face was the built-in SVG and its avatar
 * block carried no `character` key. So `mode: 'builtin'` in a v1 file means
 * "nobody ever picked a face", not "the user rejected the companion" — those
 * installs move to the new default. Anything that already knows about
 * characters, and any user-supplied image avatar, is left byte-for-byte alone.
 */
export function migrateConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const blob = { ...(raw as Record<string, unknown>) }
  const version = Number(blob.version)
  if (Number.isFinite(version) && version >= CONFIG_VERSION) return blob
  const avatar = (blob.avatar && typeof blob.avatar === 'object' ? blob.avatar : {}) as Record<string, unknown>
  const untouched = avatar.mode === undefined || avatar.mode === 'builtin'
  if (!('character' in avatar) && untouched) {
    blob.avatar = { ...avatar, mode: 'live2d', character: DEFAULT_CONFIG.avatar.character }
  }
  blob.version = CONFIG_VERSION
  return blob
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
  const rawAppearance = (raw.appearance && typeof raw.appearance === 'object'
    ? raw.appearance
    : {}) as Record<string, unknown>
  const rawPro = (raw.pro && typeof raw.pro === 'object' ? raw.pro : {}) as Record<string, unknown>
  const rawBench = (rawPro.bench && typeof rawPro.bench === 'object'
    ? rawPro.bench
    : {}) as Record<string, unknown>
  const langRaw = str(raw.lang, d.lang)
  const uiLangRaw = str(raw.uiLang, d.uiLang)
  const avatarMode = str(rawAvatar.mode, d.avatar.mode)
  const avatarCharacter = str(rawAvatar.character, d.avatar.character).trim()

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
    uiZoom: clampZoom(num(raw.uiZoom, d.uiZoom, ZOOM_MIN, ZOOM_MAX)),
    bubbleMs: Math.trunc(num(raw.bubbleMs, d.bubbleMs, 1500, 30000)),
    maxQueue: Math.trunc(num(raw.maxQueue, d.maxQueue, 1, 12)),
    lang: langRaw === 'zh' || langRaw === 'en' ? langRaw : 'auto',
    uiLang: uiLangRaw === 'zh' || uiLangRaw === 'en' ? uiLangRaw : 'auto',
    voice: {
      auto: bool(rawVoice.auto, d.voice.auto),
      zh: str(rawVoice.zh, d.voice.zh),
      en: str(rawVoice.en, d.voice.en),
      rate: Math.trunc(num(rawVoice.rate, d.voice.rate, 90, 400)),
      engine: str(rawVoice.engine, d.voice.engine) === 'system' ? 'system' : 'matcha',
      autoDownload: bool(rawVoice.autoDownload, d.voice.autoDownload)
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
      mode: avatarMode === 'image' || avatarMode === 'builtin' ? avatarMode : 'live2d',
      imagePath: str(rawAvatar.imagePath, d.avatar.imagePath),
      expression: str(rawAvatar.expression, d.avatar.expression),
      // An empty or whitespace-only id would make the catalog lookup fail at draw
      // time; collapse it to the shipped default instead.
      character: avatarCharacter || d.avatar.character
    },
    appearance: {
      surface: str(rawAppearance.surface, d.appearance.surface) === 'solid' ? 'solid' : 'glass',
      clearStage: bool(rawAppearance.clearStage, d.appearance.clearStage)
    },
    window: {
      x: Math.trunc(num(rawWindow.x, d.window.x, -1, 100000)),
      y: Math.trunc(num(rawWindow.y, d.window.y, -1, 100000))
    },
    autoInstallHooks: bool(raw.autoInstallHooks, d.autoInstallHooks),
    // A hand-edited garbage string cannot crash anything: registration simply
    // fails and falls back to the default (see main/window.ts syncHotkey).
    hotkey: str(raw.hotkey, d.hotkey).trim() || d.hotkey,
    pro: parsePro(rawPro, rawBench)
  }
}

const SUMMON_VALUES = ['always', 'blocking', 'never'] as const

/**
 * Key recipes are the one setting that presses buttons on the user's behalf, so
 * they are clamped hard: `agent.approve` / `agent.deny` only, a handful of
 * entries, and each value a short list of herdr key names. Anything else is
 * dropped, which leaves the built-in recipe in force.
 */
function parseKeyOverrides(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  for (const [key, rawKeys] of Object.entries(raw)) {
    if (Object.keys(out).length >= 40) break
    const match = /^([a-z0-9_.-]{1,40})\.(approve|deny)$/i.exec(key.trim())
    if (!match) continue
    const keys = String(rawKeys ?? '')
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 8)
    if (!keys.length) continue
    out[`${match[1].toLowerCase()}.${match[2].toLowerCase()}`] = keys.join(' ')
  }
  return out
}

function parsePro(rawPro: Record<string, unknown>, rawBench: Record<string, unknown>): ProConfig {
  const d = DEFAULT_PRO
  const summon = String(rawPro.summon ?? d.summon)
    .trim()
    .toLowerCase() as (typeof SUMMON_VALUES)[number]
  return {
    enabled: bool(rawPro.enabled, d.enabled),
    herdrPath: str(rawPro.herdrPath, d.herdrPath).trim().slice(0, 400),
    herdrSession: str(rawPro.herdrSession, d.herdrSession).trim().slice(0, 80),
    socketPath: str(rawPro.socketPath, d.socketPath).trim().slice(0, 400),
    summon: SUMMON_VALUES.includes(summon) ? summon : d.summon,
    speakAttention: bool(rawPro.speakAttention, d.speakAttention),
    bubbleAttention: bool(rawPro.bubbleAttention, d.bubbleAttention),
    badge: bool(rawPro.badge, d.badge),
    stalledAfterMs: Math.trunc(num(rawPro.stalledAfterMs, d.stalledAfterMs, 30000, 7200000)),
    keys: parseKeyOverrides(rawPro.keys),
    bench: {
      width: Math.trunc(num(rawBench.width, d.bench.width, 480, 4000)),
      height: Math.trunc(num(rawBench.height, d.bench.height, 360, 2400)),
      x: Math.trunc(num(rawBench.x, d.bench.x, -1, 100000)),
      y: Math.trunc(num(rawBench.y, d.bench.y, -1, 100000))
    },
    openBenchOnLaunch: bool(rawPro.openBenchOnLaunch, d.openBenchOnLaunch),
    autoStartHerdr: bool(rawPro.autoStartHerdr, d.autoStartHerdr),
    autoResumeOnBoot: bool(rawPro.autoResumeOnBoot, d.autoResumeOnBoot)
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
  'uiZoom',
  'bubbleMs',
  'maxQueue',
  'lang',
  'uiLang',
  'voice',
  'events',
  'avatar',
  'appearance',
  'window',
  'autoInstallHooks',
  'port',
  'pinPort',
  'hotkey',
  'pro'
]

export function applyPatch(config: AppConfig, patch: unknown): AppConfig {
  const raw = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>
  const picked: Record<string, unknown> = {}
  for (const key of CONFIG_PATCH_KEYS) {
    if (key in raw) picked[key as string] = raw[key as string]
  }
  return parseConfig({ ...config, ...picked })
}
