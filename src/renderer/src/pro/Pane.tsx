/**
 * One rented terminal (F4).
 *
 * The pane does not own its PTY. herdr does, through
 * `herdr terminal session control <pane>`, and main hands us base64 ANSI frames
 * over `cw-pro:frames`. Three consequences shape this file:
 *
 * - Frames never enter React state. They go from the IPC listener straight into
 *   `term.write` via the pane bus, so a chatty build cannot re-render the tree.
 * - The decoder is per pane and streaming. A multi-byte UTF-8 character split
 *   across two frames would otherwise render as two replacement characters, and
 *   `full:true` is the only moment we reset it (a full repaint starts a new
 *   byte stream).
 * - Unmounting releases the bridge, and releasing the bridge kills nothing. The
 *   agent keeps running in herdr; we only stop paying for its output.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchResultChangeEvent } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import {
  Bell,
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Maximize2,
  Minimize2,
  Plug,
  PlugZap,
  Regex,
  Search,
  X
} from 'lucide-react'
import { planFind, type FindFault } from '@shared/findQuery'
import type { PaneView } from '@shared/pro'
import type { ProBridgePush, ProFramePush } from '@shared/proIpc'
import { clipboardAction, searchAction } from '@shared/termKeys'
import { agentClass } from './agentTag'
import { platform, proApi } from './api'
import { bridgeErrorText, fill, type Translate } from './i18n'
import { bridgeOf, registerPane } from './paneBus'
import { monoStack, terminalFontsReady } from './terminalFont'
import type { Tone } from './toast'

/** The bench's terminal palette: the shared accents, mapped onto ANSI. */
const THEME = {
  /* `--bench-term` and RobotWorld's code block: one background for every
     terminal in the product, so a pane never reads as a different app than
     the bench around it. The ANSI slots come from the same syntax tokens the
     site highlights with - comment grey, string amber, keyword violet, call
     cyan - which is why output reads like code instead of like a rainbow. */
  background: '#0d1117',
  foreground: '#d1d5db',
  cursor: '#00da5a',
  cursorAccent: '#0d1117',
  selectionBackground: 'rgba(0,218,90,0.26)',
  selectionInactiveBackground: 'rgba(255,255,255,0.12)',
  black: '#2a2b2e',
  red: '#f87171',
  green: '#3ddc97',
  yellow: '#fbbf24',
  blue: '#6aa9ff',
  magenta: '#c4b5fd',
  cyan: '#5eead4',
  white: '#d1d5db',
  brightBlack: '#8b98a9',
  brightRed: '#ff9d94',
  brightGreen: '#4dff99',
  brightYellow: '#fcd34d',
  brightBlue: '#9cc7ff',
  brightMagenta: '#d6c9ff',
  brightCyan: '#7ff2dd',
  brightWhite: '#e2e8f0'
}

/** base64 -> bytes. `atob` is Latin-1, so every char becomes exactly one byte. */
function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** How long the bell lights the pane header before it stops claiming attention. */
const BELL_MS = 2500

/**
 * Match colours for the search addon.
 *
 * Not a cosmetic choice: the addon only reports a result count while
 * decorations are enabled, so without these the bar's counter never moves and
 * "no matches" is indistinguishable from "search is broken".
 */
const SEARCH_DECORATIONS = {
  matchBackground: '#4a3a12',
  matchBorder: '#fbbf24',
  matchOverviewRuler: '#fbbf24',
  activeMatchBackground: '#0f3d24',
  activeMatchBorder: '#00da5a',
  activeMatchColorOverviewRuler: '#00da5a'
}

/**
 * Keystroke-to-scan delay for the search box.
 *
 * A find walks the whole scrollback, and a six-letter word typed at normal
 * speed is six of them. The delay is short enough to feel live and long enough
 * that typing the word costs one scan.
 */
const SEARCH_DEBOUNCE_MS = 140

/**
 * Copy the selection to the system clipboard.
 *
 * Returns false only when the clipboard itself refused. `navigator.clipboard`
 * is gated on document focus, and a Bench sitting in the background is exactly
 * when somebody reaches for a copy shortcut, so that failure is worth a line in
 * the toast rail rather than a silent no-op.
 */
async function copySelection(term: Terminal): Promise<boolean> {
  const text = term.getSelection()
  if (!text) return true
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * Paste through the terminal, not around it.
 *
 * `term.paste` wraps the text in bracketed-paste markers and feeds it back out
 * through `onData`, which is this pane's only path to the PTY. Sending the
 * string straight to `proApi.pane.input` would skip the markers, and a TUI that
 * understands bracketed paste would then execute a multi-line clipboard as N
 * separate commands - a pasted diff becoming a pasted shell history.
 */
async function pasteInto(term: Terminal): Promise<void> {
  let text = ''
  try {
    text = await navigator.clipboard.readText()
  } catch {
    // Read permission is granted per origin and can be withheld; there is
    // nothing to paste and no reason to interrupt the agent about it.
    return
  }
  if (text) term.paste(text)
}

export interface PaneProps {
  pane: PaneView
  active: boolean
  zoomed: boolean
  t: Translate
  onSelect: (paneId: string) => void
  onZoom: (paneId: string) => void
  onNotify: (text: string, tone?: Tone) => void
}

const PHASE_KEYS = {
  idle: 'phaseIdle',
  starting: 'phaseStarting',
  live: 'phaseLive',
  respawning: 'phaseRespawning',
  closed: 'phaseClosed',
  error: 'phaseError'
} as const

/** The counter's three states: nothing searched yet, no hits, and a position. */
function matchCountLabel(t: Translate, matches: ISearchResultChangeEvent | null): string {
  if (!matches) return ''
  if (matches.resultCount === 0) return t('paneSearchNone')
  // resultIndex is -1 once the match count passes the addon's highlight limit.
  // Printing a zero position against a four-figure total reads as an
  // off-by-one rather than as a threshold, so the total is shown on its own.
  if (matches.resultIndex < 0) return fill(t, 'paneSearchCount', { n: matches.resultCount })
  return fill(t, 'paneSearchPosition', { i: matches.resultIndex + 1, n: matches.resultCount })
}

export function Pane({
  pane,
  active,
  zoomed,
  t,
  onSelect,
  onZoom,
  onNotify
}: PaneProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const sizeRef = useRef({ cols: 0, rows: 0 })
  const searchRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  /** Mirrors `query` for the debounced scan, which outlives one render. */
  const queryRef = useRef('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [phase, setPhase] = useState<ProBridgePush['phase']>(bridgeOf(pane.paneId)?.phase ?? 'idle')
  const [dropped, setDropped] = useState(0)
  const [error, setError] = useState('')
  /** Transient: the agent rang the bell and the header should say so. */
  const [bell, setBell] = useState(false)
  /** True when the human released this pane on purpose; no auto re-attach. */
  const [released, setReleased] = useState(false)
  /**
   * The bundled face is parsed and measurable. xterm sizes every cell at
   * `open()` (see terminalFont.ts), so a pane waits one woff2 fetch on a cold
   * start and one microtask on a warm cache - both invisible, where opening
   * early would leave the pane on fallback metrics for its whole life.
   */
  const [fontsReady, setFontsReady] = useState(false)
  /** Scrollback find. Overlaid, so opening it never resizes the PTY. */
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  /**
   * Last find result: the only terminal-derived React state in this pane, and it
   * moves on an explicit find rather than on output. A chatty build still cannot
   * re-render the tree, which is what the frame path at the top of this file
   * promises.
   */
  const [matches, setMatches] = useState<ISearchResultChangeEvent | null>(null)
  /** Find-bar toggles. The refs feed the debounced scan, which outlives a render. */
  const [regexOn, setRegexOn] = useState(false)
  const [caseOn, setCaseOn] = useState(false)
  const regexRef = useRef(false)
  const caseRef = useRef(false)
  /** Why this query is not being searched; it shows in the match counter. */
  const [fault, setFault] = useState<FindFault | null>(null)

  const paneId = pane.paneId

  const runSearch = useCallback((backwards: boolean) => {
    const addon = searchRef.current
    if (!addon) return
    const plan = planFind(queryRef.current, {
      regex: regexRef.current,
      caseSensitive: caseRef.current
    })
    if (plan.kind !== 'search') {
      // A refused query clears the previous highlight. Leaving yesterday's
      // matches on screen under a pattern that does not compile reads as the
      // bar ignoring what was just typed.
      addon.clearDecorations()
      setMatches(null)
      setFault(plan.kind === 'empty' ? null : plan)
      return
    }
    setFault(null)
    const options = { decorations: SEARCH_DECORATIONS, incremental: false }
    const found = backwards
      ? addon.findPrevious(plan.term, options)
      : addon.findNext(plan.term, options)
    // A miss is recorded here as well as left to the results event. The counter
    // is the only feedback the bar gives, so a stale count sitting over an empty
    // pane is how a working search comes to look broken.
    if (!found) setMatches({ resultIndex: -1, resultCount: 0 })
  }, [])

  /**
   * Flip a toggle and rescan immediately.
   *
   * No debounce here: the click is already deliberate, and waiting would show
   * the new mode against the old match count. Focus goes back to the input
   * because the button just took it, and a find bar that swallows focus turns
   * the next keystroke into nothing at all.
   */
  const flip = useCallback(
    (which: 'regex' | 'case') => {
      const next = which === 'regex' ? !regexRef.current : !caseRef.current
      if (which === 'regex') {
        regexRef.current = next
        setRegexOn(next)
      } else {
        caseRef.current = next
        setCaseOn(next)
      }
      runSearch(false)
      searchInputRef.current?.focus()
    },
    [runSearch]
  )

  const onQueryChange = useCallback(
    (value: string) => {
      setQuery(value)
      queryRef.current = value
      if (searchTimer.current) clearTimeout(searchTimer.current)
      searchTimer.current = setTimeout(() => runSearch(false), SEARCH_DEBOUNCE_MS)
    },
    [runSearch]
  )

  const clearSearch = useCallback(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    setSearchOpen(false)
    setQuery('')
    queryRef.current = ''
    setMatches(null)
    setFault(null)
    searchRef.current?.clearDecorations()
  }, [])

  const closeSearch = useCallback(() => {
    clearSearch()
    // Focus has to be handed back explicitly. The input owns it while the bar is
    // open, and dropping it on the surrounding div leaves a pane that looks live
    // and accepts nothing - silent, and the next keystroke was meant for the
    // agent.
    termRef.current?.focus()
  }, [clearSearch])

  const openSearch = useCallback(() => setSearchOpen(true), [])

  // Focus follows the bar, not the click. Opened from the header button, focus
  // would stay on that button and the first thing anybody does next is type.
  useEffect(() => {
    if (!searchOpen) return
    const input = searchInputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [searchOpen])

  useEffect(() => {
    let cancelled = false
    void terminalFontsReady().then(() => {
      if (!cancelled) setFontsReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host || released || !fontsReady) return

    const term = new Terminal({
      // A literal family list, never `var(--mono)`: see terminalFont.ts. The
      // declared value is read here because only the renderer has a document.
      fontFamily: monoStack(
        getComputedStyle(document.documentElement).getPropertyValue('--mono')
      ),
      fontSize: 12.5,
      lineHeight: 1.22,
      cursorBlink: true,
      // A ceiling, not a growth rate: xterm keeps scrollback in a circular
      // list of three 32-bit words per cell, and only the selected task's panes
      // are mounted at all. 4k lines was too small for what an agent prints -
      // one verbose build log scrolls the top of a test run off the screen, and
      // the find bar can only search what is still in the buffer.
      scrollback: 10_000,
      // The Unicode11 addon below reads `terminal.unicode`, which xterm gates
      // behind its proposed-API flag. With the flag off, activating the addon
      // throws inside the first Pane's mount effect and React unmounts the
      // tree, so the bench comes up as a blank frame on every platform.
      allowProposedApi: true,
      // OSC 8 hyperlinks, which an agent's tooling emits on purpose (`ls
      // --hyperlink`, cargo, pytest, git). With no handler xterm falls back to
      // `confirm("Do you want to navigate to ... WARNING: This link could
      // potentially be dangerous")` plus `window.open()` - a native modal raised
      // by a string we did not author, and a new Electron window instead of the
      // OS browser. Same exit as detected links: the host op whose scheme
      // allow-list runs in main. `allowNonHttpProtocols` stays at its default
      // false, so xterm drops anything that is not http(s) before it reaches us.
      linkHandler: {
        activate: (_event, uri) => {
          void proApi.host.openExternal(uri)
        }
      },
      theme: THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term

    // Wide-character widths. xterm's built-in table is Unicode 6, which predates
    // most of what an agent prints today: a fullwidth CJK glyph measured as one
    // cell shifts every column after it, and the result looks like a rendering
    // bug rather than a missing addon. Must be set before the first write.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'

    // OSC 52, so an agent can put text on the system clipboard itself.
    term.loadAddon(new ClipboardAddon())

    // Scrollback search, loaded whether or not the bar is open. The addon keeps
    // its match decorations against a buffer that is still growing, so
    // attaching it only on first use would search a view of the pane that
    // stopped at the moment the bar appeared.
    const search = new SearchAddon()
    term.loadAddon(search)
    searchRef.current = search
    const resultsSub = search.onDidChangeResults((event) => setMatches(event))

    // Links open in the OS browser and never in this window. The URL came from
    // output we do not control, so it leaves through the host op whose scheme
    // allow-list runs in main rather than in the renderer.
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void proApi.host.openExternal(uri)
      })
    )

    // Hardware rendering, with an honest fallback. A long diff is the worst case
    // for the DOM renderer, and acceptance 6.5 asks for flat memory through an
    // hour of busy output. WebGL can be missing entirely (software GL, driver
    // blocklist) and can lose its context later, so both paths drop back to the
    // DOM renderer instead of leaving a pane that has stopped updating.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      /* no WebGL here: slower, still correct */
    }

    // One streaming decoder per pane, reset whenever herdr sends a full frame.
    let decoder = new TextDecoder('utf-8', { fatal: false })

    const measure = (): void => {
      try {
        fit.fit()
      } catch {
        // A zero-size container throws; the ResizeObserver below retries.
        return
      }
      const { cols, rows } = term
      if (!cols || !rows) return
      const prev = sizeRef.current
      sizeRef.current = { cols, rows }
      if (prev.cols === cols && prev.rows === rows) return
      // Only a *changed* size is worth a round trip: herdr relays it to the PTY,
      // and a resize storm reflows the agent's whole screen each time.
      void proApi.pane.resize(paneId, cols, rows).then((result) => {
        if (!result.ok && prev.cols) onNotify(result.detail || t('phaseError'), 'error')
      })
    }

    measure()
    const unsub = registerPane(paneId, {
      frame(frame: ProFramePush): void {
        if (frame.full) {
          decoder = new TextDecoder('utf-8', { fatal: false })
          term.reset()
        }
        if (frame.bytes) term.write(decoder.decode(b64ToBytes(frame.bytes), { stream: !frame.full }))
      },
      bridge(push: ProBridgePush): void {
        setPhase(push.phase)
        setDropped(push.dropped)
        setError(push.error)
        // herdr may have resized the PTY under us while we were away.
        if (push.phase === 'live' && push.cols && push.rows) measure()
      },
      focus(): void {
        // `term.focus()` lands on xterm's hidden helper textarea, which is what
        // makes keystrokes go to the PTY instead of to the bench's `j/k/a/d/s`
        // (`Bench.tsx::typing` bails on anything inside `.xterm`). Focusing the
        // host div would look focused and still route keys to the bench.
        term.focus()
      }
    })

    const dataSub = term.onData((text) => {
      void proApi.pane.input(paneId, text)
    })

    // The bell is the agent's own "look at me" and it is easy to miss when the
    // Bench is one of nine windows. It lights the pane header instead of raising
    // a toast: a build that rings once per error would otherwise bury the
    // attention queue, which is the thing that actually deserves a toast.
    let bellTimer: ReturnType<typeof setTimeout> | null = null
    const bellSub = term.onBell(() => {
      setBell(true)
      if (bellTimer) clearTimeout(bellTimer)
      bellTimer = setTimeout(() => setBell(false), BELL_MS)
    })

    // Copy and paste. Electron does not connect a terminal selection to the
    // system clipboard by itself, so the chords are ours to wire - but they must
    // not collide with the agent's, and plain Ctrl+C is SIGINT. The decision
    // table is shared pure code (`@shared/termKeys`) precisely so that rule is
    // pinned by a test rather than by this component behaving well today.
    // Returning false is what tells xterm we consumed the key; true leaves it
    // on its way to the PTY.
    term.attachCustomKeyEventHandler((event) => {
      // Checked before the clipboard table. On macOS this is Cmd+F, which no
      // terminal program is waiting for; elsewhere it is Ctrl+Shift+F, because
      // plain Ctrl+F is readline forward-char and has to keep reaching the PTY.
      if (searchAction(platform, event) === 'open') {
        openSearch()
        return false
      }
      const action = clipboardAction(platform, event, term.hasSelection())
      if (action === 'ignore') return true
      if (action === 'copy') {
        void copySelection(term).then((done) => {
          if (!done) onNotify(t('paneCopyFailed'), 'warn')
        })
        return false
      }
      void pasteInto(term)
      return false
    })

    // Debounced: a window drag fires dozens of resize events, and each fit is a
    // layout pass over the whole scrollback viewport.
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(measure, 70)
    })
    observer.observe(host)

    void proApi.pane
      .attach(paneId, sizeRef.current.cols || 80, sizeRef.current.rows || 24)
      .then((result) => {
        if (!result.ok) onNotify(result.detail || t('phaseError'), 'error')
      })

    return () => {
      if (timer) clearTimeout(timer)
      if (bellTimer) clearTimeout(bellTimer)
      // A scan armed a moment before unmount would fire against a terminal that
      // is already disposed, and its match decorations go with it.
      if (searchTimer.current) clearTimeout(searchTimer.current)
      resultsSub.dispose()
      searchRef.current = null
      observer.disconnect()
      unsub()
      dataSub.dispose()
      bellSub.dispose()
      termRef.current = null
      term.dispose()
      void proApi.pane.detach(paneId)
    }
    // `active` and `zoomed` are read by the parent's CSS, not by us: re-running
    // this effect on a selection change would detach and repaint for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, released, fontsReady])

  const release = useCallback(() => {
    setReleased(true)
    setPhase('idle')
    // The bar searches a terminal that is about to stop existing. Left open it
    // would show a live input over a pane nobody is attached to.
    clearSearch()
  }, [clearSearch])

  const label = pane.title || pane.cwd || pane.paneId
  const live = phase === 'live'
  const agent = pane.displayAgent || pane.agent || 'sh'
  /**
   * The counter doubles as the bar's error line. It is the only text the find
   * bar owns, so a refused pattern has nowhere else to go - and a toast would
   * fire once per keystroke while somebody types a regex.
   */
  const faultText = !fault
    ? ''
    : fault.kind === 'empty-match'
      ? t('paneSearchEmptyMatch')
      : fill(t, 'paneSearchBadPattern', { error: fault.message })
  /**
   * The bridge's complaint, translated for a human. main forwards the child's
   * own words, and for a control process that never started those words are an
   * errno - a diagnosis, not an instruction, and the overlay is the only place
   * anybody will read it.
   */
  const errorText = error ? bridgeErrorText(t, error) : ''

  return (
    <section
      className="pane"
      data-active={active}
      data-zoom-hidden={zoomed && !active}
      onMouseDown={() => onSelect(paneId)}
    >
      <header className="pane-head">
        <span className={`tag ${agentClass(agent)}`.trim()}>{agent}</span>
        <span className="pane-title" title={label}>
          {label}
        </span>
        {bell && (
          <span className="pane-bell" title={t('paneBell')} aria-label={t('paneBell')}>
            <Bell size={12} />
          </span>
        )}
        <span className="pane-flag" data-live={live} data-phase={phase} title={errorText || undefined}>
          {dropped > 0 && <span>{fill(t, 'droppedFrames', { n: dropped })}</span>}
          <span>{t(PHASE_KEYS[phase] ?? 'phaseIdle')}</span>
        </span>
        <button
          type="button"
          className="btn icon ghost"
          title={t('paneSearchOpen')}
          aria-label={t('paneSearchOpen')}
          aria-pressed={searchOpen}
          data-open={searchOpen || undefined}
          disabled={released}
          onClick={() => (searchOpen ? closeSearch() : openSearch())}
        >
          <Search size={12} />
        </button>
        <button
          type="button"
          className="btn icon ghost"
          title={t('paneFocusHerdr')}
          aria-label={t('paneFocusHerdr')}
          onClick={() => void proApi.pane.focus(paneId)}
        >
          <Crosshair />
        </button>
        <button
          type="button"
          className="btn icon ghost"
          title={zoomed ? t('paneZoomOff') : t('paneZoomOn')}
          aria-label={zoomed ? t('paneZoomOff') : t('paneZoomOn')}
          onClick={() => onZoom(paneId)}
        >
          {zoomed ? <Minimize2 /> : <Maximize2 />}
        </button>
        <button
          type="button"
          className="btn icon ghost"
          title={released ? t('verbAttach') : t('paneDetach')}
          aria-label={released ? t('verbAttach') : t('paneDetach')}
          onClick={() => (released ? setReleased(false) : release())}
        >
          {released ? <Plug /> : <PlugZap />}
        </button>
      </header>
      <div className="pane-body" ref={hostRef} />
      {searchOpen && !released && (
        <div className="pane-search" role="search">
          <Search size={12} aria-hidden="true" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                runSearch(event.shiftKey)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                closeSearch()
              } else if (searchAction(platform, event) === 'open') {
                // The bar owns focus, so the pane's own key handler never sees
                // this chord. Hitting it again re-selects the term instead of
                // doing nothing at all, which is what a find bar does everywhere
                // else.
                event.preventDefault()
                event.currentTarget.select()
              }
            }}
            placeholder={t('paneSearchPlaceholder')}
            aria-label={t('paneSearchPlaceholder')}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="btn icon ghost"
            title={t('paneSearchRegex')}
            aria-label={t('paneSearchRegex')}
            aria-pressed={regexOn}
            data-on={regexOn || undefined}
            onClick={() => flip('regex')}
          >
            <Regex size={12} />
          </button>
          <button
            type="button"
            className="btn icon ghost"
            title={t('paneSearchCase')}
            aria-label={t('paneSearchCase')}
            aria-pressed={caseOn}
            data-on={caseOn || undefined}
            onClick={() => flip('case')}
          >
            <CaseSensitive size={12} />
          </button>
          <span
            className="pane-search-count"
            data-none={!faultText && matches !== null && matches.resultCount === 0}
            data-bad={faultText ? 'true' : undefined}
            title={faultText || undefined}
          >
            {faultText || matchCountLabel(t, matches)}
          </span>
          <button
            type="button"
            className="btn icon ghost"
            title={t('paneSearchPrev')}
            aria-label={t('paneSearchPrev')}
            onClick={() => runSearch(true)}
          >
            <ChevronUp size={12} />
          </button>
          <button
            type="button"
            className="btn icon ghost"
            title={t('paneSearchNext')}
            aria-label={t('paneSearchNext')}
            onClick={() => runSearch(false)}
          >
            <ChevronDown size={12} />
          </button>
          <button
            type="button"
            className="btn icon ghost"
            title={t('paneSearchClose')}
            aria-label={t('paneSearchClose')}
            onClick={closeSearch}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {released && (
        <div className="pane-overlay">
          <span>{t('paneDetachedNote')}</span>
          <button type="button" className="btn" onClick={() => setReleased(false)}>
            <Plug />
            {t('verbAttach')}
          </button>
        </div>
      )}
      {phase === 'error' && error && (
        <div className="pane-overlay">
          <span>{errorText}</span>
          <button type="button" className="btn" onClick={() => setReleased(false)}>
            {t('installRetry')}
          </button>
        </div>
      )}
    </section>
  )
}
