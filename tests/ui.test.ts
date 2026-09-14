import { describe, expect, it } from 'vitest'
import {
  CHROME_ESTIMATE,
  HEIGHT_CHAT,
  PANEL_H,
  PANEL_MIN_H,
  WINDOW_PADDING,
  estimatedHeight,
  panelHeight,
  stageHeight,
  widgetView
} from '../src/shared/ui'

/**
 * Main sizes the frame from these numbers and the renderer lays the card out
 * from the same ones (`--panel-h`). A drift between the two shows up as a
 * clipped panel or a transparent strip under the card, and neither is visible
 * from one side alone — so the contract is tested as a whole.
 */
describe('widget geometry', () => {
  it('collapses the panel away entirely', () => {
    for (const mode of ['builtin', 'image', 'live2d'] as const) {
      expect(panelHeight(mode, 'collapsed')).toBe(0)
      expect(estimatedHeight(mode, 'collapsed')).toBe(stageHeight(mode, 'collapsed') + CHROME_ESTIMATE)
    }
  })

  it('gives the tabbed panel its fixed height, whatever the avatar', () => {
    for (const mode of ['builtin', 'image', 'live2d'] as const) {
      expect(panelHeight(mode, 'panel')).toBe(PANEL_H)
    }
  })

  it('fits the chat panel into the chat frame exactly, so the card never overflows it', () => {
    for (const mode of ['builtin', 'image', 'live2d'] as const) {
      const chrome = CHROME_ESTIMATE - WINDOW_PADDING * 2
      const card = stageHeight(mode, 'chat') + panelHeight(mode, 'chat') + chrome
      expect(card + WINDOW_PADDING * 2).toBe(HEIGHT_CHAT)
      expect(estimatedHeight(mode, 'chat')).toBe(HEIGHT_CHAT)
      // A chat shorter than this cannot show a transcript and a composer.
      expect(panelHeight(mode, 'chat')).toBeGreaterThanOrEqual(PANEL_MIN_H)
    }
  })

  it('derives the view the same way both sides do', () => {
    expect(widgetView(false, false)).toBe('collapsed')
    expect(widgetView(false, true)).toBe('collapsed')
    expect(widgetView(true, false)).toBe('panel')
    expect(widgetView(true, true)).toBe('chat')
  })
})
