import { describe, expect, it } from 'vitest'
import {
  applyPatch,
  CONFIG_PATCH_KEYS,
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  migrateConfig,
  parseConfig,
  type AppConfig
} from '../src/shared/config'
import { ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN } from '../src/shared/zoom'

describe('parseConfig', () => {
  it('returns the defaults for an empty or malformed file', () => {
    for (const junk of [{}, null, undefined, 'text', 42, [], { version: 99 }]) {
      const config = parseConfig(junk)
      expect(config.version).toBe(CONFIG_VERSION)
      expect(config.speak).toBe(DEFAULT_CONFIG.speak)
      expect(config.events).toEqual(DEFAULT_CONFIG.events)
      expect(config.voice).toEqual(DEFAULT_CONFIG.voice)
    }
  })

  it('clamps the sliders so a hand-edited file cannot make the widget unusable', () => {
    expect(parseConfig({ opacity: 0 }).opacity).toBe(0.35)
    expect(parseConfig({ opacity: 5 }).opacity).toBe(1)
    expect(parseConfig({ scale: 0 }).scale).toBe(0.6)
    expect(parseConfig({ scale: 99 }).scale).toBe(2)
    expect(parseConfig({ bubbleMs: 1 }).bubbleMs).toBe(1500)
    expect(parseConfig({ bubbleMs: 1e9 }).bubbleMs).toBe(30000)
    expect(parseConfig({ maxQueue: 0 }).maxQueue).toBe(1)
    expect(parseConfig({ maxQueue: 900 }).maxQueue).toBe(12)
    expect(parseConfig({ voice: { rate: 1 } }).voice.rate).toBe(90)
    expect(parseConfig({ voice: { rate: 9999 } }).voice.rate).toBe(400)
  })

  it('keeps interface zoom on the ladder, so the frame math stays integral', () => {
    // A hand-edited 3 would push the widget past the work area, and a value
    // between rungs would leave `targetSize()` multiplying by a number the
    // keyboard shortcuts can never get back to.
    expect(parseConfig({ uiZoom: 3 }).uiZoom).toBe(ZOOM_MAX)
    expect(parseConfig({ uiZoom: 0.01 }).uiZoom).toBe(ZOOM_MIN)
    expect(parseConfig({ uiZoom: 'nope' }).uiZoom).toBe(ZOOM_DEFAULT)
    expect(parseConfig({ uiZoom: 1.16 }).uiZoom).toBe(1.2)
  })

  it('accepts string numbers, because a Settings input arrives as text', () => {
    expect(parseConfig({ opacity: '0.8' }).opacity).toBe(0.8)
    expect(parseConfig({ port: '4321' }).port).toBe(4321)
    expect(parseConfig({ bubbleMs: '5000' }).bubbleMs).toBe(5000)
  })

  it('keeps the interface language separate from the spoken language', () => {
    expect(parseConfig({}).uiLang).toBe('auto')
    expect(parseConfig({ uiLang: 'en' }).uiLang).toBe('en')
    expect(parseConfig({ uiLang: 'fr' }).uiLang).toBe('auto')
    // A Chinese UI over an English-speaking agent is a supported combination.
    const config = parseConfig({ uiLang: 'zh', lang: 'en' })
    expect(config.uiLang).toBe('zh')
    expect(config.lang).toBe('en')
  })

  it('parses appearance, and refuses to invent a surface', () => {
    expect(parseConfig({}).appearance).toEqual({ surface: 'glass', clearStage: true })
    expect(parseConfig({ appearance: { surface: 'solid' } }).appearance).toEqual({
      surface: 'solid',
      clearStage: true
    })
    expect(parseConfig({ appearance: { surface: 'acrylic', clearStage: false } }).appearance).toEqual({
      surface: 'glass',
      clearStage: false
    })
    expect(parseConfig({ appearance: 'nope' }).appearance).toEqual(DEFAULT_CONFIG.appearance)
  })

  it('round-trips appearance through a Settings patch without losing a sibling key', () => {
    const base = parseConfig({})
    const next = applyPatch(base, { appearance: { ...base.appearance, clearStage: false } })
    expect(next.appearance).toEqual({ surface: 'glass', clearStage: false })
    expect(next.avatar).toEqual(base.avatar)
  })

  it('truncates fractional counts', () => {
    expect(parseConfig({ bubbleMs: 4321.9 }).bubbleMs).toBe(4321)
    expect(parseConfig({ maxQueue: 3.7 }).maxQueue).toBe(3)
  })

  it('rejects a privileged or nonsense port instead of clamping into one', () => {
    expect(parseConfig({ port: 80 }).port).toBe(0)
    expect(parseConfig({ port: -1 }).port).toBe(0)
    expect(parseConfig({ port: 70000 }).port).toBe(0)
    expect(parseConfig({ port: 'auto' }).port).toBe(0)
    expect(parseConfig({ port: 4321 }).port).toBe(4321)
  })

  it('falls back to auto for an unknown language', () => {
    expect(parseConfig({ lang: 'fr' }).lang).toBe('auto')
    expect(parseConfig({ lang: 'zh' }).lang).toBe('zh')
    expect(parseConfig({ lang: 'en' }).lang).toBe('en')
  })

  it('never lets an unknown avatar mode through', () => {
    // live2d is the default face now, so the fallback has to be an id that is
    // genuinely not in the union; the character id is filled from the default.
    expect(parseConfig({ avatar: { mode: 'hologram', imagePath: '/a.png' } }).avatar).toEqual({
      mode: 'live2d',
      imagePath: '/a.png',
      expression: 'idle',
      character: DEFAULT_CONFIG.avatar.character
    })
    expect(parseConfig({ avatar: { mode: 'builtin' } }).avatar.mode).toBe('builtin')
    expect(parseConfig({ avatar: { mode: 'image' } }).avatar.mode).toBe('image')
    expect(parseConfig({ avatar: { mode: 'live2d' } }).avatar.mode).toBe('live2d')
  })

  it('collapses a blank character id to the shipped default', () => {
    expect(parseConfig({ avatar: { character: '   ' } }).avatar.character).toBe(DEFAULT_CONFIG.avatar.character)
    expect(parseConfig({ avatar: { character: 'RiceBunny' } }).avatar.character).toBe('RiceBunny')
  })

  it('keeps a stored window position but rejects an off-screen one', () => {
    expect(parseConfig({ window: { x: 120, y: 80 } }).window).toEqual({ x: 120, y: 80 })
    expect(parseConfig({ window: { x: -500, y: -500 } }).window).toEqual({ x: -1, y: -1 })
  })

  it('fills in missing event toggles without dropping the ones that were set', () => {
    expect(parseConfig({ events: { tool: true } }).events).toEqual({ ...DEFAULT_CONFIG.events, tool: true })
  })
})

describe('applyPatch', () => {
  const base: AppConfig = parseConfig({ token: 'secret-token-0123456789', port: 4321 })

  it('only accepts whitelisted keys', () => {
    const next = applyPatch(base, { speak: false, version: 99, token: 'stolen', bogus: true })
    expect(next.speak).toBe(false)
    expect(next.version).toBe(CONFIG_VERSION)
    expect(next.token).toBe(base.token)
    expect('bogus' in next).toBe(false)
    expect('version' in next).toBe(true)
  })

  it('leaves everything else alone, including a port the patch does not mention', () => {
    const next = applyPatch(base, { scale: 1.4 })
    expect(next.port).toBe(4321)
    expect(next.scale).toBe(1.4)
    expect(next.voice).toEqual(base.voice)
  })

  it('survives a patch that is not an object', () => {
    for (const junk of [null, undefined, 'x', 42]) {
      expect(applyPatch(base, junk)).toEqual(base)
    }
  })

  it('clamps a value the renderer sent out of range', () => {
    expect(applyPatch(base, { opacity: 9 }).opacity).toBe(1)
    expect(applyPatch(base, { port: 22 }).port).toBe(0)
  })

  it('lists every field the Settings panel can edit', () => {
    expect(CONFIG_PATCH_KEYS).toContain('port')
    expect(CONFIG_PATCH_KEYS).toContain('pinPort')
    expect(CONFIG_PATCH_KEYS).toContain('events')
    expect(CONFIG_PATCH_KEYS).toContain('avatar')
    // version and token are generated, never user-editable.
    expect(CONFIG_PATCH_KEYS).not.toContain('version')
    expect(CONFIG_PATCH_KEYS).not.toContain('token')
    const patchable = Object.keys(DEFAULT_CONFIG).filter((k) => k !== 'version' && k !== 'token')
    expect([...CONFIG_PATCH_KEYS].sort()).toEqual(patchable.sort())
  })
})

describe('migrateConfig', () => {
  /** A config exactly as 0.1.0 (pre-Live2D) wrote it. */
  const v1 = {
    version: 1,
    port: 58361,
    speak: true,
    avatar: { mode: 'builtin', imagePath: '', expression: 'idle' }
  }

  it('moves a pre-Live2D install onto the companion face', () => {
    const next = parseConfig(migrateConfig(v1))
    expect(next.avatar.mode).toBe('live2d')
    expect(next.avatar.character).toBe(DEFAULT_CONFIG.avatar.character)
    // Everything the user actually set survives the rewrite.
    expect(next.port).toBe(58361)
    expect(next.speak).toBe(true)
    expect(next.version).toBe(CONFIG_VERSION)
  })

  it('keeps an image avatar the user picked themselves', () => {
    const next = parseConfig(migrateConfig({ ...v1, avatar: { mode: 'image', imagePath: '/me.png' } }))
    expect(next.avatar.mode).toBe('image')
    expect(next.avatar.imagePath).toBe('/me.png')
  })

  it('never touches a config that already knows about characters', () => {
    const current = { ...v1, version: CONFIG_VERSION, avatar: { mode: 'builtin', character: 'Mao' } }
    expect(parseConfig(migrateConfig(current)).avatar).toEqual({
      mode: 'builtin',
      imagePath: '',
      expression: 'idle',
      character: 'Mao'
    })
  })

  it('is a no-op for junk and for a fresh install', () => {
    for (const junk of [null, undefined, 'text', 42, []]) expect(migrateConfig(junk)).toBe(junk)
    expect(parseConfig(migrateConfig({}))).toEqual(DEFAULT_CONFIG)
  })
})
