// @vitest-environment jsdom
/**
 * The pane's keyboard chords, from the event's point of view.
 *
 * `tests/termKeys.test.ts` pins *which* chords belong to the pane; this pins
 * the half that only a mounted pane can get wrong: claiming a chord means
 * both telling xterm "consumed" (return false) *and* cancelling the browser's
 * default. Returning false alone still lets the default fire a real paste on
 * xterm's hidden textarea, which types the clipboard a second time - the
 * doubled paste on Linux. A paste that lands twice reads as a broken
 * clipboard, so the pairing is the regression worth a mount.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The one Terminal instance the mount created, plus what it was told.
 *
 * Everything the mock factories touch has to live inside `vi.hoisted`: the
 * factories run before every top-level binding in this file, so a class
 * declared at the top is still uninitialized when `@xterm/xterm` is imported.
 */
const { termState, FakeTerminal, FakeSearchAddon } = vi.hoisted(() => {
  const termState: {
    current: null | {
      keyHandler: ((event: KeyboardEvent) => boolean) | null
      wheelHandler: ((event: WheelEvent) => boolean) | null
      pasted: string[]
      selection: boolean
    }
  } = { current: null }

  class FakeTerminal {
    rows = 24
    cols = 80
    unicode = { activeVersion: '6' }
    onData = (): { dispose: () => void } => ({ dispose: () => undefined })
    onBell = (): { dispose: () => void } => ({ dispose: () => undefined })
    onWriteParsed = (): { dispose: () => void } => ({ dispose: () => undefined })
    paste = (text: string): void => {
      termState.current?.pasted.push(text)
    }
    write = (): void => undefined
    reset = (): void => undefined
    focus = (): void => undefined
    dispose = (): void => undefined
    hasSelection = (): boolean => termState.current?.selection ?? false
    getSelection = (): string => ''
    loadAddon = (): void => undefined
    open = (): void => undefined
    attachCustomKeyEventHandler = (handler: (event: KeyboardEvent) => boolean): void => {
      if (termState.current) termState.current.keyHandler = handler
    }
    attachCustomWheelEventHandler = (handler: (event: WheelEvent) => boolean): void => {
      if (termState.current) termState.current.wheelHandler = handler
    }
  }

  class FakeSearchAddon {
    onDidChangeResults = (): { dispose: () => void } => ({ dispose: () => undefined })
    findNext = (): boolean => false
    findPrevious = (): boolean => false
    clearDecorations = (): void => undefined
    dispose = (): void => undefined
  }

  return { termState, FakeTerminal, FakeSearchAddon }
})

// The mock factories are hoisted above every top-level binding, so each addon
// is an inline class: nothing outside the factory may be touched.
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    dispose(): void {}
  }
}))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: FakeSearchAddon }))
vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {
    activate(): void {}
    dispose(): void {}
  }
}))
vi.mock('@xterm/addon-clipboard', () => ({
  ClipboardAddon: class {
    activate(): void {}
    dispose(): void {}
  }
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    activate(): void {}
    dispose(): void {}
  }
}))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    activate(): void {}
    dispose(): void {}
  }
}))

vi.mock('../src/renderer/src/pro/api', () => ({
  platform: 'linux',
  proApi: {
    pane: {
      attach: async () => ({ ok: true, data: null }),
      detach: async () => ({ ok: true, data: null }),
      resize: async () => ({ ok: true, data: null }),
      input: async () => ({ ok: true, data: null }),
      scroll: async () => ({ ok: true, data: null }),
      scrollBottom: async () => ({ ok: true, data: null }),
      focus: async () => ({ ok: true, data: null })
    },
    host: { openExternal: async () => ({ ok: true, data: null }) }
  }
}))

import { Pane } from '../src/renderer/src/pro/Pane'
import { makeTranslator } from '../src/renderer/src/pro/i18n'
import type { PaneView } from '../src/shared/pro'

const t = makeTranslator('en')

const pane: PaneView = {
  paneId: 'p1',
  terminalId: 't1',
  workspaceId: 'w1',
  tabId: 'b1',
  cwd: '/tmp',
  agent: 'codex',
  displayAgent: 'codex',
  title: 'probe',
  agentStatus: 'working',
  focused: true,
  revision: 1,
  attached: true
}

let container: HTMLDivElement
let root: Root

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

/** A keydown the browser would still act on unless somebody cancels it. */
function key(over: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...over })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom ships neither; the pane's mount effect and the wheel path both reach
  // for them.
  ;(globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      clipboard: {
        readText: async () => 'from the clipboard',
        writeText: async () => undefined
      }
    },
    configurable: true
  })
  termState.current = { keyHandler: null, wheelHandler: null, pasted: [], selection: false }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  termState.current = null
})

describe('the pane key handler', () => {
  it('consumes Ctrl+Shift+V and cancels the default, so the clipboard lands once', async () => {
    await render(
      <Pane pane={pane} active={true} zoomed={false} t={t} onSelect={vi.fn()} onZoom={vi.fn()} onNotify={vi.fn()} />
    )
    const handler = termState.current?.keyHandler
    expect(handler).not.toBeNull()
    const event = key({ key: 'V', ctrlKey: true, shiftKey: true })
    let consumed: boolean | undefined
    await act(async () => {
      consumed = handler?.(event)
    })
    // xterm's "consumed", and the browser's default cancelled with it: the pair
    // is the fix. Either half alone is the doubled paste.
    expect(consumed).toBe(false)
    expect(event.defaultPrevented).toBe(true)
    await act(async () => {
      await Promise.resolve()
    })
    expect(termState.current?.pasted).toEqual(['from the clipboard'])
  })

  it('consumes Ctrl+Shift+C with a selection on screen, default cancelled', async () => {
    // Copy needs something to copy: `termKeys` gives the chord back to the PTY
    // when nothing is selected, and that half is pinned over there. Here the
    // claim is only about the pairing once the pane does claim the chord.
    await render(
      <Pane pane={pane} active={true} zoomed={false} t={t} onSelect={vi.fn()} onZoom={vi.fn()} onNotify={vi.fn()} />
    )
    if (termState.current) termState.current.selection = true
    const handler = termState.current?.keyHandler
    const event = key({ key: 'C', ctrlKey: true, shiftKey: true })
    let consumed: boolean | undefined
    await act(async () => {
      consumed = handler?.(event)
    })
    expect(consumed).toBe(false)
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves Ctrl+Shift+C with the PTY while nothing is selected', async () => {
    await render(
      <Pane pane={pane} active={true} zoomed={false} t={t} onSelect={vi.fn()} onZoom={vi.fn()} onNotify={vi.fn()} />
    )
    const handler = termState.current?.keyHandler
    const event = key({ key: 'C', ctrlKey: true, shiftKey: true })
    expect(handler?.(event)).toBe(true)
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves plain Ctrl+C to the PTY, untouched by the browser', async () => {
    // SIGINT. The handler must not claim it, and must not cancel a default it
    // has no business cancelling.
    await render(
      <Pane pane={pane} active={true} zoomed={false} t={t} onSelect={vi.fn()} onZoom={vi.fn()} onNotify={vi.fn()} />
    )
    const handler = termState.current?.keyHandler
    const event = key({ key: 'c', ctrlKey: true })
    expect(handler?.(event)).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    expect(termState.current?.pasted).toEqual([])
  })

  it('consumes Shift+PageUp, the scrollback chord, with the default cancelled', async () => {
    await render(
      <Pane pane={pane} active={true} zoomed={false} t={t} onSelect={vi.fn()} onZoom={vi.fn()} onNotify={vi.fn()} />
    )
    const handler = termState.current?.keyHandler
    const event = key({ key: 'PageUp', shiftKey: true })
    let consumed: boolean | undefined
    await act(async () => {
      consumed = handler?.(event)
    })
    expect(consumed).toBe(false)
    expect(event.defaultPrevented).toBe(true)
  })
})
