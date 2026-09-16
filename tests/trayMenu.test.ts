import { describe, expect, it } from 'vitest'
import {
  trayInteraction,
  trayLabel,
  trayMenu,
  trayMenuKey,
  type TrayAction,
  type TrayEntry,
  type TrayMenuState
} from '../src/shared/trayMenu'

const state = (over: Partial<TrayMenuState> = {}): TrayMenuState => ({
  visible: false,
  muted: false,
  bench: true,
  badge: 0,
  lang: 'en',
  ...over
})

/** The rows only, so an ordering assertion reads as an ordering assertion. */
const actions = (entries: readonly TrayEntry[]): readonly string[] =>
  entries.map((entry) => (entry.kind === 'separator' ? '-' : entry.action))

const labels = (entries: readonly TrayEntry[]): readonly string[] =>
  entries.flatMap((entry) => (entry.kind === 'separator' ? [] : [entry.label]))

describe('trayInteraction', () => {
  it('is a menu on Linux, where the platform delivers no click event', () => {
    expect(trayInteraction('linux')).toBe('menu')
  })

  it('is a gesture on mac and Windows, which do deliver one', () => {
    expect(trayInteraction('darwin')).toBe('gesture')
    expect(trayInteraction('win32')).toBe('gesture')
  })

  it('falls back to a gesture for a platform nobody named', () => {
    // The wrong default here is a dead tray, which is the bug this module
    // exists to fix; a gesture platform that gets a menu is merely ordinary.
    expect(trayInteraction('freebsd')).toBe('gesture')
    expect(trayInteraction('')).toBe('gesture')
  })
})

describe('trayMenu order', () => {
  it('leads with the way back to her, then the bench, then the panel', () => {
    expect(actions(trayMenu(state({ visible: false })))).toEqual([
      'stage',
      'bench',
      'panel',
      '-',
      'mute',
      'hooks',
      '-',
      'quit'
    ])
  })

  it('offers to hide the stage when the stage is on screen', () => {
    expect(actions(trayMenu(state({ visible: true })))[0]).toBe('hide')
  })

  it('drops the bench row when Pro is off, rather than showing a dead door', () => {
    expect(actions(trayMenu(state({ bench: false })))).toEqual([
      'stage',
      'panel',
      '-',
      'mute',
      'hooks',
      '-',
      'quit'
    ])
  })

  it('keeps quit alone at the bottom, behind a separator', () => {
    const entries = trayMenu(state())
    expect(entries[entries.length - 1]).toMatchObject({ action: 'quit' })
    expect(entries[entries.length - 2]).toEqual({ kind: 'separator' })
  })

  it('flips the voice row with the mute state', () => {
    expect(actions(trayMenu(state({ muted: false })))).toContain('mute')
    expect(actions(trayMenu(state({ muted: true })))).toContain('unmute')
    expect(actions(trayMenu(state({ muted: true })))).not.toContain('mute')
  })
})

describe('trayMenu badge', () => {
  it('carries the count in the bench label, because the icon glyph is three pixels', () => {
    const entries = trayMenu(state({ badge: 3 }))
    expect(entries[1]).toMatchObject({ action: 'bench', label: 'Open the bench (3)' })
  })

  it('says nothing about a count of zero', () => {
    expect(trayMenu(state({ badge: 0 }))[1]).toMatchObject({ label: 'Open the bench' })
  })
})

describe('trayMenu languages', () => {
  it('writes every row in the language the interface is in', () => {
    expect(labels(trayMenu(state({ lang: 'zh' })))).toEqual([
      '显示舞台',
      '打开工作台',
      '打开面板',
      '静音',
      '修复 agent hooks',
      '退出 CodeWaifu'
    ])
  })

  it('uses the product mode vocabulary, not a second product name', () => {
    // One app, two modes: 舞台/工作台. A row that said "Pro" would claim two
    // applications in the one menu that is supposed to switch between them.
    const zh = labels(trayMenu(state({ lang: 'zh' }))).join(' ')
    expect(zh).toContain('舞台')
    expect(zh).toContain('工作台')
    expect(zh).not.toContain('Pro')
  })

  it('has a label for every action, in both languages', () => {
    const all: TrayAction[] = ['stage', 'hide', 'bench', 'panel', 'mute', 'unmute', 'hooks', 'quit']
    for (const action of all) {
      expect(trayLabel(action, 'en').length).toBeGreaterThan(0)
      expect(trayLabel(action, 'zh').length).toBeGreaterThan(0)
    }
  })
})

describe('trayMenuKey', () => {
  it('is stable for the same menu, so publishing is idempotent', () => {
    expect(trayMenuKey(state())).toBe(trayMenuKey(state()))
  })

  it('changes when a row would say something different', () => {
    const base = trayMenuKey(state())
    expect(trayMenuKey(state({ visible: true }))).not.toBe(base)
    expect(trayMenuKey(state({ muted: true }))).not.toBe(base)
    expect(trayMenuKey(state({ bench: false }))).not.toBe(base)
    expect(trayMenuKey(state({ badge: 2 }))).not.toBe(base)
    expect(trayMenuKey(state({ lang: 'zh' }))).not.toBe(base)
  })

  it('ignores a badge no row shows, because re-publishing is D-Bus churn', () => {
    expect(trayMenuKey(state({ bench: false, badge: 0 }))).toBe(
      trayMenuKey(state({ bench: false, badge: 4 }))
    )
  })
})
