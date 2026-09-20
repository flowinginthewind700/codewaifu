// @vitest-environment jsdom
/**
 * The character picker sheet.
 *
 * The stage pill's face and motion menus are lists; choosing *who she is*
 * covers the card with a sheet of thumbs instead, because eight portraits do
 * not fit next to a 24px button. These pin what the sheet owes the pointer
 * and the keyboard: every shipped character gets a cell, the one she wears is
 * pressed, a click names a character, and both Escape and the backdrop walk
 * away without changing anything.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CharacterPicker } from '../src/renderer/src/CharacterPicker'
import { LIVE2D_CATALOG } from '../src/shared/live2dCatalog'
import { makeTranslator } from '../src/renderer/src/i18n'

let container: HTMLDivElement
let root: Root

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

function items(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-char]'))
}

const t = makeTranslator('en')

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('CharacterPicker', () => {
  it('offers every shipped character and marks the one she wears', async () => {
    const second = LIVE2D_CATALOG.characters[1]
    await render(
      <CharacterPicker t={t} lang="en" selected={second.id} onPick={vi.fn()} onClose={vi.fn()} />
    )
    expect(items()).toHaveLength(LIVE2D_CATALOG.characters.length)
    const pressed = items().filter((el) => el.getAttribute('aria-pressed') === 'true')
    expect(pressed).toHaveLength(1)
    expect(pressed[0].textContent).toContain(second.labelEn)
    // The sheet must keep the window's input region while it is open.
    expect(container.querySelector('.char-picker')?.getAttribute('data-solid')).toBe('1')
  })

  it('names the character a thumb was clicked on', async () => {
    const onPick = vi.fn()
    const third = LIVE2D_CATALOG.characters[2]
    await render(
      <CharacterPicker t={t} lang="zh" selected={LIVE2D_CATALOG.characters[0].id} onPick={onPick} onClose={vi.fn()} />
    )
    const cell = items().find((el) => el.textContent?.includes(third.labelZh))
    expect(cell).toBeTruthy()
    await act(async () => {
      cell?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onPick).toHaveBeenCalledWith(third.id)
  })

  it('closes on Escape and on the backdrop, without picking', async () => {
    const onPick = vi.fn()
    const onClose = vi.fn()
    await render(
      <CharacterPicker t={t} lang="en" selected={LIVE2D_CATALOG.characters[0].id} onPick={onPick} onClose={onClose} />
    )
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onPick).not.toHaveBeenCalled()

    const backdrop = container.querySelector('.char-picker-backdrop')
    await act(async () => {
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(onPick).not.toHaveBeenCalled()
  })
})
