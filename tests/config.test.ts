import { describe, expect, it } from 'vitest'
import { applyPatch, CONFIG_PATCH_KEYS, DEFAULT_CONFIG, parseConfig, type AppConfig } from '../src/shared/config'

describe('parseConfig', () => {
  it('returns the defaults for an empty or malformed file', () => {
    for (const junk of [{}, null, undefined, 'text', 42, [], { version: 99 }]) {
      const config = parseConfig(junk)
      expect(config.version).toBe(1)
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

  it('accepts string numbers, because a Settings input arrives as text', () => {
    expect(parseConfig({ opacity: '0.8' }).opacity).toBe(0.8)
    expect(parseConfig({ port: '4321' }).port).toBe(4321)
    expect(parseConfig({ bubbleMs: '5000' }).bubbleMs).toBe(5000)
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
    expect(parseConfig({ avatar: { mode: 'live2d', imagePath: '/a.png' } }).avatar).toEqual({
      mode: 'builtin',
      imagePath: '/a.png',
      expression: 'idle'
    })
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
    expect(next.version).toBe(1)
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
