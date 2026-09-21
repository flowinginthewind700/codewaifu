// @vitest-environment jsdom
/**
 * The stage's door into the Bench.
 *
 * The door is a switch the human clicks while their hands are on the keyboard,
 * and the stage re-renders under it the moment they do. A focused button
 * answers Space and Enter from the browser's own default action, so without an
 * explicit blur the next keystroke meant for the agent flips the bench open or
 * shut instead - a door that opens on typing is worse than no door. These pin
 * the two halves a click has to leave behind: the bench was asked, and the
 * focus was not kept.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StageTools } from '../src/renderer/src/StageTools'
import { makeTranslator } from '../src/renderer/src/i18n'

const t = makeTranslator('en')

let container: HTMLDivElement
let root: Root

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

function door(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('.stage-tools button[aria-pressed]')
}

function tools(over: Partial<Parameters<typeof StageTools>[0]> = {}) {
  return (
    <StageTools
      t={t}
      lang="en"
      expressions={[]}
      motions={[]}
      proAvailable={true}
      onBench={vi.fn()}
      benchOpen={false}
      onReport={vi.fn()}
      onExpression={vi.fn()}
      onMotion={vi.fn()}
      charactersAvailable={false}
      onCharacters={vi.fn()}
      {...over}
    />
  )
}

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

describe('the bench door', () => {
  it('asks for the bench exactly once per click', async () => {
    const onBench = vi.fn()
    await render(tools({ onBench }))
    const button = door()
    expect(button).not.toBeNull()
    await act(async () => {
      button?.click()
    })
    expect(onBench).toHaveBeenCalledTimes(1)
  })

  it("lets go of the focus, so the next Space is the agent's, not the door's", async () => {
    // The regression: a click leaves the button focused, the stage re-renders,
    // and the first Space the human types re-triggers the door. Focusing first
    // is what makes the assertion bite - jsdom's click() does not focus on its
    // own, so an unfocused start would pass for the wrong reason.
    const onBench = vi.fn()
    await render(tools({ onBench }))
    const button = door()
    expect(button).not.toBeNull()
    button?.focus()
    expect(document.activeElement).toBe(button)
    await act(async () => {
      button?.click()
    })
    expect(onBench).toHaveBeenCalledTimes(1)
    expect(document.activeElement).not.toBe(button)
  })

  it('reads as a switch: pressed while the bench is up, flat while it is not', async () => {
    await render(tools({ benchOpen: true }))
    expect(door()?.getAttribute('aria-pressed')).toBe('true')
    expect(door()?.getAttribute('data-on')).toBe('1')
    await render(tools({ benchOpen: false }))
    expect(door()?.getAttribute('aria-pressed')).toBe('false')
    expect(door()?.hasAttribute('data-on')).toBe(false)
  })

  it('offers no door when there is no bench to open', async () => {
    await render(tools({ proAvailable: false }))
    expect(door()).toBeNull()
  })
})
