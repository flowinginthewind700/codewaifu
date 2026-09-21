/**
 * The Bench root: one projection, rendered once (F1-F7 on a single screen).
 *
 * Three rules keep this file from becoming a second source of truth:
 *
 * 1. **Everything about the work arrives pushed.** `proApi.onState` hands over a
 *    whole `BenchView`; nothing here re-derives "needs me", re-ranks the queue or
 *    re-sorts the tree. The only state this window owns is *viewing* state: which
 *    task is selected, where the keyboard cursor sits, which drawer is open.
 * 2. **Terminal bytes never enter React state.** Frames and bridge phases are
 *    routed by `paneBus` straight to the xterm instance that registered for them.
 *    A frame in `useState` is a re-render per output chunk of every busy agent,
 *    and the acceptance criterion is "memory stays flat through an hour of it".
 * 3. **A failure is always shown.** Every call resolves to a `ProResult` instead
 *    of throwing, so "it did not work" has to become a toast or it is silently
 *    indistinguishable from "it worked".
 *
 * The keyboard is the primary surface: `j/k` walk the rows actually on screen,
 * `Enter` opens one, and `a/d/s` decide the head of the queue *without focusing
 * its pane*. That last one is the whole product - see MVP F3.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import type { ProConfig } from '@shared/config'
import {
  COLUMN_RANGE,
  COLUMN_SAVE_DELAY,
  clampColumnWidth,
  columnVar,
  columnVarValue,
  draggedColumnWidth,
  isDrawerColumn,
  RAIL_DEFAULT,
  RIGHT_DEFAULT,
  SPLIT_STEP,
  type BenchColumn
} from '@shared/benchLayout'
import { resolveUiLang, systemLangFromLocales } from '@shared/lang'
import {
  DEFAULT_SNOOZE_MINUTES,
  attentionActions,
  filterGroups,
  needsRecovery,
  originCounts,
  type AttentionAction,
  type AttentionItem,
  type BenchView,
  type GroupView,
  type TaskRecord,
  type TaskView,
  type TreeFilter
} from '@shared/pro'
import type { Lang, RedactedConfig, RuntimeState } from '@shared/protocol'
import type { ProFocusPush, ProResult } from '@shared/proIpc'
import { zoomPercent } from '@shared/zoom'
import { proApi } from './api'
import { AttentionQueue } from './AttentionQueue'
import { ConnectDialog } from './ConnectDialog'
import { ConversationPanel } from './ConversationPanel'
import { ImportDialog } from './ImportDialog'
import { InstallCard } from './InstallCard'
import { LedgerPanel } from './LedgerPanel'
import { NewTaskDialog } from './NewTaskDialog'
import { PaneGrid } from './PaneGrid'
import { RecoveryPanel } from './RecoveryPanel'
import { TaskCard } from './TaskCard'
import { Tip } from '../Tip'
import { BenchBrand, TopBar, WindowControls } from './TopBar'
import { TreeRail } from './TreeRail'
import { fill, makeTranslator, type Translate } from './i18n'
import { focusPane, routeBridge, routeFrames } from './paneBus'
import { Toasts, noticeTone, useToasts } from './toast'

type RightTab = 'queue' | 'ledger' | 'recovery'

type ToggleKey = 'speakAttention' | 'bubbleAttention' | 'badge'

/** A focus request older than this is stale; ignore it rather than jump somewhere. */
const FOCUS_TTL_MS = 10_000

/** Stable identity, so an empty queue does not re-render the panel on every push. */
const NO_ITEMS: readonly AttentionItem[] = []
/** Same, for a projection that has not landed yet. */
const NO_GROUPS: GroupView[] = []

/**
 * Whether removing this row has a shell underneath it to close.
 *
 * An imported session runs in somebody else's terminal, and a row whose pane is
 * already gone has nothing left, so the box is not offered in either case: a
 * choice with one answer is noise, and ticking it would earn a toast about a
 * close that could never have happened.
 */
function canCloseShell(task: TaskView | null | undefined): boolean {
  return !!task?.workspaceId && task.alive
}

export function Bench(): ReactElement {
  const [booted, setBooted] = useState(false)
  const [view, setView] = useState<BenchView | null>(null)
  const [config, setConfig] = useState<RedactedConfig | null>(null)
  const [runtime, setRuntime] = useState<RuntimeState | null>(null)

  /* Viewing state. None of it is a fact about the work. */
  const [taskId, setTaskId] = useState('')
  const [paneId, setPaneId] = useState('')
  const [cursorId, setCursorId] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [needsMeOnly, setNeedsMeOnly] = useState(false)
  const [tab, setTab] = useState<RightTab>('queue')
  const [railOpen, setRailOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  /**
   * The two side columns, in CSS pixels.
   *
   * Local state while you drag, so a 120Hz pointer stream repaints columns
   * without a config write per frame; the width lands in `pro.bench` once, when
   * you let go. Config is the source of truth between drags - see the sync below.
   */
  const [railW, setRailW] = useState(RAIL_DEFAULT)
  const [rightW, setRightW] = useState(RIGHT_DEFAULT)
  /** Which column a splitter drag owns, if any. */
  const [splitting, setSplitting] = useState<BenchColumn | null>(null)
  const splitRef = useRef<{
    column: BenchColumn
    pointerId: number
    startX: number
    startWidth: number
  } | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  /** Origin facet. Viewing state like the rest of it; main owns the facts. */
  const [treeFilter, setTreeFilter] = useState<TreeFilter>('all')
  const [removeId, setRemoveId] = useState('')
  /**
   * "Close the shell too", the checkbox in the remove dialog.
   *
   * Set by `askRemove` for the row being removed; the initial true only covers a
   * dialog opened before the projection landed.
   */
  const [removeClose, setRemoveClose] = useState(true)
  /** Bumped when a task's ledger changed, so the digest and the panel refetch. */
  const [revision, setRevision] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  const { toasts, push, dismiss } = useToasts()

  const viewRef = useRef<BenchView | null>(null)
  const configRef = useRef<RedactedConfig | null>(null)
  const tRef = useRef<Translate>(makeTranslator('en'))
  /** A focus push that arrived before the first projection did. */
  const pendingFocus = useRef<ProFocusPush | null>(null)
  const keyRef = useRef<(event: KeyboardEvent) => void>(() => undefined)

  /**
   * Interface language, same rule as the widget: `uiLang: 'auto'` follows the OS.
   * Until main's snapshot lands we use the browser's own locales, so the first
   * paint is not a flash of the wrong language.
   */
  const lang: Lang = resolveUiLang(config?.uiLang ?? 'auto', runtime?.systemLang ?? localLang())
  const t = useMemo(() => makeTranslator(lang), [lang])

  /* ---- data in -------------------------------------------------------- */

  const load = useCallback(async (): Promise<void> => {
    const boot = await proApi.bootstrap()
    setView(boot.view)
    setConfig(boot.config)
    setRuntime(boot.runtime)
    setBooted(true)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Point the bench at a task. False when the projection has no such task.
   *
   * "Focus" here is grid focus: the chosen pane is the one drawn active, which is
   * all MVP F7's `focusTask` asks of the pane grid. It is deliberately not
   * *keyboard* focus. Handing a terminal the keyboard the moment a bubble is
   * clicked would send the next `d` into the agent's shell instead of denying the
   * head of the queue, and deciding without focusing a pane is the loop F3 calls
   * the whole product. The keyboard enters a terminal only on `i`, and leaves on
   * Shift+Tab.
   */
  const selectTask = useCallback((nextTaskId: string, nextPaneId = ''): boolean => {
    const task = viewRef.current?.tasks.find((entry) => entry.id === nextTaskId) ?? null
    if (!task) return false
    const wanted = nextPaneId !== '' && task.panes.some((pane) => pane.paneId === nextPaneId)
    // Prefer the pane herdr says is focused: it is the one you were last in.
    const chosen = wanted
      ? nextPaneId
      : (task.panes.find((pane) => pane.focused)?.paneId ?? task.panes[0]?.paneId ?? '')
    setTaskId(task.id)
    setCursorId(task.id)
    setPaneId(chosen)
    // Drawers close, columns do not. Below its breakpoint each side panel
    // overlays the panes, and on a narrow window the point of opening a task is
    // to see its terminal - so the overlay gets out of the way. On a wide window
    // both panels *are* the layout, and a row click that folded the tree and the
    // queue away would rearrange the furniture every time you looked at a task.
    if (isDrawerColumn('rail', window.innerWidth)) setRailOpen(false)
    if (isDrawerColumn('right', window.innerWidth)) setRightOpen(false)
    return true
  }, [])

  useEffect(() => {
    viewRef.current = view
    configRef.current = config
    tRef.current = t

    // A bubble click can create this window: main replays the focus request once
    // we ask for state, and that replay can still land before the projection
    // commits. Hold it here and apply it as soon as there is a tree to find it in.
    const focus = pendingFocus.current
    if (!view || !focus) return
    if (Date.now() - focus.at > FOCUS_TTL_MS) {
      pendingFocus.current = null
      return
    }
    if (selectTask(focus.taskId, focus.paneId)) {
      pendingFocus.current = null
      if (focus.reason === 'widget') push(t('focusFromWidget'), 'info')
    }
  }, [view, config, t, push, selectTask])

  useEffect(() => {
    const unsubscribe = [
      proApi.onState(setView),
      proApi.onConfig(setConfig),
      proApi.onNotice((notice) => push(notice.text, noticeTone(notice))),
      // The interface scale changed under a keystroke: name the new ratio and
      // the way back, in the same toast lane everything else uses.
      proApi.onZoom((rung) =>
        push(`${zoomPercent(rung)} · ${tRef.current('zoomResetHint')}`, 'info')
      ),
      // Frames and bridge phases bypass React on purpose; see paneBus.
      proApi.onFrames(routeFrames),
      proApi.onBridge(routeBridge),
      proApi.onFocus((focus) => {
        if (selectTask(focus.taskId, focus.paneId)) {
          if (focus.reason === 'widget') push(tRef.current('focusFromWidget'), 'info')
          return
        }
        pendingFocus.current = focus
      })
    ]
    return () => {
      for (const off of unsubscribe) off()
    }
  }, [push, selectTask])

  /** `ago()` and `blockedMs` are relative, so something has to tick. */
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  /* ---- derived -------------------------------------------------------- */

  const pro = config?.pro ?? null
  const proEnabled = pro?.enabled ?? false
  /**
   * Frameless unless the setting says otherwise, including before main's
   * snapshot lands: the window is born frameless by default, so guessing the
   * other way paints a bar of controls the window does not need for one frame.
   */
  const frameless = !(pro?.benchFrame ?? false)
  const herdrOnline = view?.herdr.online ?? false
  const attention = view?.attention ?? NO_ITEMS
  const allGroups = view?.groups ?? NO_GROUPS
  /** Over the whole tree, so a chip can promise what it would show. */
  const origins = useMemo(() => originCounts(allGroups), [allGroups])
  const shownGroups = useMemo(() => filterGroups(allGroups, treeFilter), [allGroups, treeFilter])
  const selectedTask = useMemo(
    () => view?.tasks.find((entry) => entry.id === taskId) ?? null,
    [view, taskId]
  )
  /**
   * The task whose conversation replaces its terminal: it has a session to read
   * and no pane to draw. Import lands here, and so does an adopted workspace
   * whose pane has since gone away.
   */
  const conversationTask = useMemo(
    () =>
      selectedTask && !selectedTask.panes.length && selectedTask.agentSessionId
        ? selectedTask
        : null,
    [selectedTask]
  )
  /**
   * A task can have BOTH a terminal and a transcript: herdr owns the pane while
   * the agent keeps writing its rollout file. The terminal shows what the agent
   * sees (its own TUI, one flat colour by design); the transcript shows what the
   * agent said, with the colours the chat view gives it. Which one fills the
   * center is the human's call, remembered per task for the session - a bench
   * that resets the choice on every click makes reading a history a fight.
   * Tasks with no pane (imported, or adopted after the terminal died) skip the
   * switch: there is nothing to switch to.
   */
  const switchable = Boolean(selectedTask?.panes.length) && Boolean(selectedTask?.agentSessionId)
  const [centerView, setCenterView] = useState<Record<string, 'term' | 'convo'>>({})
  const centerMode = selectedTask ? (centerView[selectedTask.id] ?? 'term') : 'term'
  const plan = useMemo(
    () => view?.recovery.find((entry) => entry.taskId === taskId) ?? null,
    [view, taskId]
  )
  const recoveryCount = useMemo(() => needsRecovery(view?.recovery ?? []).length, [view])

  /**
   * The rows the tree is actually showing, in the order they are drawn. `j/k`
   * walk this and nothing else, so the cursor can never land on a folded row:
   * the same three pieces of state drive the filter in `TreeRail`.
   */
  const flat = useMemo(() => {
    const rows: TaskView[] = []
    for (const group of shownGroups) {
      if (collapsed.has(group.key)) continue
      for (const task of group.tasks) {
        if (!needsMeOnly || task.needsMe > 0) rows.push(task)
      }
    }
    return rows
  }, [shownGroups, collapsed, needsMeOnly])

  // If the last imported task goes away while its chip is the one selected, the
  // facet would keep filtering on a count that is now zero. The rail does show
  // the filtering strip and its clear button, so this is a kindness rather than
  // the only way back - but a filter that outlived every row it could match is
  // one the tree should not leave switched on.
  useEffect(() => {
    if (origins.imported === 0) setTreeFilter('all')
  }, [origins.imported])

  /* ---- keeping the selection honest ----------------------------------- */

  // Runs on projection changes only. Keying it on `taskId` too would race a
  // freshly created task: for one tick it is selected but not yet in the view.
  useEffect(() => {
    if (!view) return
    setTaskId((current) =>
      current && view.tasks.some((entry) => entry.id === current)
        ? current
        : (view.tasks[0]?.id ?? '')
    )
  }, [view])

  useEffect(() => {
    if (!flat.length) {
      setCursorId('')
      return
    }
    if (flat.some((entry) => entry.id === cursorId)) return
    setCursorId(flat.some((entry) => entry.id === taskId) ? taskId : flat[0].id)
  }, [flat, cursorId, taskId])

  useEffect(() => {
    const task = view?.tasks.find((entry) => entry.id === taskId) ?? null
    if (!task) {
      setPaneId('')
      return
    }
    if (paneId && task.panes.some((entry) => entry.paneId === paneId)) return
    setPaneId(task.panes.find((entry) => entry.focused)?.paneId ?? task.panes[0]?.paneId ?? '')
  }, [view, taskId, paneId])

  /* ---- actions -------------------------------------------------------- */

  const bump = useCallback(() => setRevision((value) => value + 1), [])

  /** The one place a `ProResult` becomes feedback. */
  const report = useCallback(
    (result: ProResult, done?: string): boolean => {
      if (!result.ok) {
        push(result.detail || result.code || 'failed', 'error')
        return false
      }
      if (done) push(done, 'ok')
      return true
    },
    [push]
  )

  const act = useCallback(
    async (
      itemId: string,
      action: AttentionAction,
      extra: { text?: string; minutes?: number; option?: number } = {}
    ): Promise<void> => {
      if (!report(await proApi.act(itemId, action, extra))) return
      // Approve, deny and answer all write a decision to the ledger, and the
      // task card's digest is fetched rather than pushed. Bump so it re-reads.
      bump()
    },
    [bump, report]
  )

  const patchConfig = useCallback(
    async (patch: Partial<ProConfig>): Promise<void> => {
      const result = await proApi.setConfig(patch)
      const data = result.ok ? result.data : null
      // Apply it locally as well: the config push normally wins the race, but a
      // toggle that waits a round trip looks broken for the hundred ms it takes.
      if (data) setConfig((current) => (current ? { ...current, pro: data.pro } : current))
      report(result)
    },
    [report]
  )

  const toggleConfig = useCallback(
    (key: ToggleKey): void => {
      const current = configRef.current?.pro
      if (!current) return
      const patch: Partial<ProConfig> = {}
      patch[key] = !current[key]
      void patchConfig(patch)
    },
    [patchConfig]
  )

  /* ---- side columns: collapse and resize ------------------------------- */

  const shellRef = useRef<HTMLDivElement | null>(null)
  const savedRailW = pro?.bench.railW ?? RAIL_DEFAULT
  const savedRightW = pro?.bench.rightW ?? RIGHT_DEFAULT

  /**
   * Config in, local state out. A drag leads with local state so the column
   * follows the pointer without a round trip per frame; once the write lands the
   * config is the same clamped number, so this is a no-op. Not applied while a
   * drag is in flight, or a late push would fight the hand.
   */
  useEffect(() => {
    if (splitRef.current) return
    setRailW(savedRailW)
    setRightW(savedRightW)
  }, [savedRailW, savedRightW])

  // The grid and both splitter positions read these two variables from CSS, so
  // they are written on the shell element rather than threaded through props.
  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    shell.style.setProperty(columnVar('rail'), columnVarValue(railW))
    shell.style.setProperty(columnVar('right'), columnVarValue(rightW))
    // `booted` is in the list because the shell element only exists once the
    // boot screen is gone: the first run has nothing to write to.
  }, [railW, rightW, booted])

  /** Remember the settled width, once per drag. */
  const saveColumn = useCallback(
    (column: BenchColumn, width: number): void => {
      const bench = configRef.current?.pro?.bench
      if (!bench) return
      void patchConfig({
        bench: column === 'rail' ? { ...bench, railW: width } : { ...bench, rightW: width }
      })
    },
    [patchConfig]
  )

  /**
   * The same write, coalesced.
   *
   * A drag ends once, so it writes once. Arrow keys do not: holding one down
   * repeats at the OS rate, and every `setConfig` is a synchronous
   * write-tmp-then-rename in the main process, so a write per keypress is a disk
   * write per keypress for a width that is still moving. The last width in a
   * burst is the only one worth keeping, so that is the only one written.
   */
  const columnTimer = useRef<number | undefined>(undefined)
  const pendingColumn = useRef<{ column: BenchColumn; width: number } | null>(null)

  const flushColumn = useCallback((): void => {
    if (columnTimer.current !== undefined) {
      window.clearTimeout(columnTimer.current)
      columnTimer.current = undefined
    }
    const queued = pendingColumn.current
    if (!queued) return
    pendingColumn.current = null
    saveColumn(queued.column, queued.width)
  }, [saveColumn])

  const saveColumnSoon = useCallback(
    (column: BenchColumn, width: number): void => {
      pendingColumn.current = { column, width }
      if (columnTimer.current !== undefined) window.clearTimeout(columnTimer.current)
      columnTimer.current = window.setTimeout(flushColumn, COLUMN_SAVE_DELAY)
    },
    [flushColumn]
  )

  // An arrow-key burst that ends by closing the window still has to land: the
  // unmount is the last chance to write the width the user just stepped to.
  useEffect(() => flushColumn, [flushColumn])

  /**
   * Grab a splitter.
   *
   * Pointer capture on the handle: the pointer keeps arriving at this element
   * after it slides off a 7px seam, which is exactly what happens the moment the
   * column starts to grow. Widths go through `draggedColumnWidth`, so the limits
   * live in one place and a flick cannot squeeze the terminal out of the window.
   */
  const onSplitDown = useCallback(
    (column: BenchColumn) =>
      (event: ReactPointerEvent<HTMLElement>): void => {
        if (event.button !== 0) return
        event.preventDefault()
        // A queued arrow-key write lands first, so the drag starts from the
        // width that is actually on disk rather than from a stale config value.
        flushColumn()
        splitRef.current = {
          column,
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: column === 'rail' ? railW : rightW
        }
        setSplitting(column)
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* capture is a nicety; the deltas still arrive while the button is down */
        }
      },
    [flushColumn, railW, rightW]
  )

  const onSplitMove = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    const drag = splitRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    // The rail is on the left, so dragging right grows it; the right panel is on
    // the right, so the same motion shrinks it.
    const sign: 1 | -1 = drag.column === 'rail' ? 1 : -1
    const width = draggedColumnWidth(
      drag.column,
      drag.startWidth,
      event.clientX - drag.startX,
      sign
    )
    if (drag.column === 'rail') setRailW(width)
    else setRightW(width)
  }, [])

  /** Let go: one durable write for the whole drag, and none if nothing moved. */
  const onSplitUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      const drag = splitRef.current
      splitRef.current = null
      setSplitting(null)
      if (!drag) return
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      const width = clampColumnWidth(drag.column, drag.column === 'rail' ? railW : rightW)
      if (width === drag.startWidth) return
      saveColumn(drag.column, width)
    },
    [railW, rightW, saveColumn]
  )

  /**
   * Double-click a splitter, or press Enter on it: back to the shipped width.
   * The handle is a real control rather than an invisible strip, so there is a
   * keyboard way to do what the mouse does, and a way to undo a drag you did not
   * mean.
   */
  const onSplitReset = useCallback(
    (column: BenchColumn) => (): void => {
      const width = column === 'rail' ? RAIL_DEFAULT : RIGHT_DEFAULT
      if (column === 'rail') setRailW(width)
      else setRightW(width)
      // Deliberate and finished, so write it now: the toast and the config have
      // to agree the moment either of them appears.
      pendingColumn.current = null
      saveColumn(column, width)
      // One durable write, one sentence. The width is already back where it
      // shipped; the toast is what says so, because nothing on screen moved.
      push(tRef.current('splitReset'), 'ok')
    },
    [push, saveColumn]
  )

  /**
   * Arrow keys on a focused splitter: the pointerless way to do what a drag does.
   *
   * Every press moves the column at once - a step you have to wait for is a step
   * nobody can repeat - while the durable write is coalesced by `saveColumnSoon`.
   * The keys are ones the window-level handler would otherwise eat, so this stops
   * the event before it reaches `handleKey`.
   */
  const onSplitStep = useCallback(
    (column: BenchColumn) =>
      (event: ReactKeyboardEvent<HTMLElement>): void => {
        const key = event.key
        if (key !== 'ArrowLeft' && key !== 'ArrowRight') return
        event.preventDefault()
        event.stopPropagation()
        const sign: 1 | -1 = column === 'rail' ? 1 : -1
        const delta = key === 'ArrowLeft' ? -SPLIT_STEP : SPLIT_STEP
        const current = column === 'rail' ? railW : rightW
        const width = draggedColumnWidth(column, current, delta, sign)
        if (width === current) return
        if (column === 'rail') setRailW(width)
        else setRightW(width)
        saveColumnSoon(column, width)
      },
    [railW, rightW, saveColumnSoon]
  )

  const setSummon = useCallback(
    (value: ProConfig['summon']): void => void patchConfig({ summon: value }),
    [patchConfig]
  )

  const toggleCompanion = useCallback((): void => {
    void proApi.companion.toggle().then((result) => report(result))
  }, [report])

  /** Back to the stage: one app, two modes, and the widget is the other one. */
  const toStage = useCallback((): void => {
    void proApi.companion.stage().then((result) => report(result))
  }, [report])

  /**
   * The frameless bench's own window verbs.
   *
   * Wired into the full topbar and into the pro-off fallback header alike:
   * chrome that only works while herdr is online is chrome that traps you in
   * a window precisely when something is already wrong.
   */
  const minimizeBench = useCallback((): void => {
    void proApi.benchControl('minimize').then((result) => report(result))
  }, [report])

  const closeBench = useCallback((): void => {
    void proApi.benchControl('close').then((result) => report(result))
  }, [report])

  /**
   * Import landed. Main pushes a fresh projection on its own, so this only
   * closes the picker, re-reads the ledger and says what happened - including
   * the rows that did not make it, because a silently smaller import reads as a
   * bug.
   */
  const onImported = useCallback(
    (imported: number, attached: number, skipped: number): void => {
      setImportOpen(false)
      bump()
      if (imported > 0) {
        push(
          attached > 0
            ? fill(t, 'importAttached', { attached })
            : fill(t, 'importDone', { n: imported }),
          'ok'
        )
      }
      if (skipped > 0) push(fill(t, 'importSkipped', { n: skipped }), 'warn')
    },
    [bump, push, t]
  )

  const snoozeAll = useCallback((): void => {
    void proApi.snoozeAll().then((result) => {
      if (report(result)) bump()
    })
  }, [bump, report])

  const adopt = useCallback((): void => {
    void proApi.task.adopt().then((result) => {
      if (report(result)) bump()
    })
  }, [bump, report])

  /**
   * The chip's button: close every terminal a removal left running in herdr.
   *
   * These are the shells the tree can no longer show, so this is the only
   * reachable way to be rid of them - and the reason a removal that kept its
   * process alive is a safe choice to offer.
   */
  const purgeDeclined = useCallback((): void => {
    void proApi.task.purgeDeclined().then((result) => {
      if (!report(result)) return
      const closed = result.data?.closed ?? 0
      if (closed) push(fill(t, 'purgedToast', { n: closed }), 'ok')
      bump()
    })
  }, [bump, push, report, t])

  const rediscover = useCallback((): void => {
    void proApi.host.discovery().then((result) => report(result))
  }, [report])

  const setStatus = useCallback(
    (status: 'active' | 'parked' | 'done'): void => {
      if (!taskId) return
      void proApi.task.setStatus(taskId, status).then((result) => {
        if (report(result)) bump()
      })
    },
    [bump, report, taskId]
  )

  /**
   * A title the human just wrote. Both callers have already trimmed it and
   * checked it against what was there, so a patch reaching the service is a
   * change worth a ledger line.
   *
   * No success toast: the row under the caret now reads the new name, and a
   * bubble announcing what is already on screen is the one notification that
   * adds no information.
   */
  const renameTask = useCallback(
    (id: string, title: string): void => {
      void proApi.task.patch(id, { title }).then((result) => {
        if (report(result)) bump()
      })
    },
    [bump, report]
  )

  const confirmRemove = useCallback((): void => {
    const id = removeId
    const closeShell = removeClose
    setRemoveId('')
    if (!id) return
    void proApi.task.remove(id, closeShell).then((result) => {
      if (!report(result)) return
      // Asked to close and herdr refused is worth saying out loud: the row is
      // gone, so the chip is the only other trace of the shell that survived.
      if (closeShell) {
        const closed = result.data?.closed === true
        push(t(closed ? 'removedAndClosed' : 'removedStillRunning'), closed ? 'ok' : 'warn')
      }
      bump()
    })
  }, [bump, push, report, removeClose, removeId, t])

  /**
   * Open the dialog with the checkbox at its default for *this* row.
   *
   * The default is "close it", and the box is only offered where there is
   * something to close (`canCloseShell`). Reset on every open rather than
   * remembered across the session: the answer belongs to the row in front of the
   * human, so one deliberate "keep it running" must not become the default for
   * the next five removals.
   */
  const askRemove = useCallback((id: string): void => {
    const task = viewRef.current?.tasks.find((entry) => entry.id === id) ?? null
    setRemoveClose(canCloseShell(task))
    setRemoveId(id)
  }, [])

  /** Recovery verbs all want the same thing: run, report, re-read the ledger. */
  const recover = useCallback(
    (run: () => Promise<ProResult>): void => {
      void run().then((result) => {
        if (report(result)) bump()
      })
    },
    [bump, report]
  )

  const onCreated = useCallback(
    (task: TaskRecord): void => {
      setNewTaskOpen(false)
      setTaskId(task.id)
      setCursorId(task.id)
      // Same rule as `selectTask`: only a drawer yields to the new task.
      if (isDrawerColumn('rail', window.innerWidth)) setRailOpen(false)
      if (isDrawerColumn('right', window.innerWidth)) setRightOpen(false)
      bump()
    },
    [bump]
  )

  const toggleGroup = useCallback((key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const openItem = useCallback(
    (item: AttentionItem): void => {
      if (selectTask(item.taskId, item.paneId)) return
      push(t('taskGone'), 'warn')
    },
    [push, selectTask, t]
  )

  /**
   * `t`: a plain local shell, in the selected task's directory.
   *
   * One keystroke and there is a pane - no dialog, no form, nothing to fill in.
   * An empty directory means home, which main resolves, so this works with no
   * task selected at all. The focus push that follows the open is what brings
   * the pane forward; this only has to say whether the open itself worked.
   */
  const openTerminal = useCallback((): void => {
    void proApi.ssh.terminal(selectedTask?.workdir ?? '').then((result) => {
      if (!report(result, t('sshTerminalOpened'))) return
      bump()
    })
  }, [bump, report, selectedTask, t])

  /* ---- keyboard ------------------------------------------------------- */

  const move = (delta: number): void => {
    if (!flat.length) return
    const index = flat.findIndex((entry) => entry.id === cursorId)
    const next =
      index < 0
        ? delta > 0
          ? 0
          : flat.length - 1
        : Math.min(flat.length - 1, Math.max(0, index + delta))
    setCursorId(flat[next].id)
  }

  /** `a/d/s` decide the head of the queue, whose highlight says which that is. */
  const decide = (letter: 'a' | 'd' | 's'): void => {
    const head = attention[0]
    if (!head) return
    const action: AttentionAction = letter === 'a' ? 'approve' : letter === 'd' ? 'deny' : 'snooze'
    if (!attentionActions(head.kind).includes(action)) {
      push(t('actionNotAvailable'), 'warn')
      return
    }
    // Show the row being decided: on a narrow window the drawer may be closed.
    setTab('queue')
    void act(head.id, action, action === 'snooze' ? { minutes: DEFAULT_SNOOZE_MINUTES } : {})
  }

  const handleKey = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (typing(event.target)) return
    const key = event.key

    if (key === 'Escape') {
      if (removeId) {
        setRemoveId('')
        event.preventDefault()
        return
      }
      // NewTaskDialog owns its own Escape, on a capture-phase listener.
      if (newTaskOpen || connectOpen) return
      if (!railOpen || !rightOpen) {
        setRailOpen(true)
        setRightOpen(true)
        event.preventDefault()
      }
      return
    }

    if (newTaskOpen || connectOpen || removeId || !view) return

    switch (key) {
      case 'j':
      case 'ArrowDown':
        move(1)
        event.preventDefault()
        return
      case 'k':
      case 'ArrowUp':
        move(-1)
        event.preventDefault()
        return
      case 'Enter':
        // A focused button already handles Enter; do not move the selection too.
        if (control(event.target)) return
        if (cursorId) selectTask(cursorId)
        event.preventDefault()
        return
      case ' ':
        // Same reasoning: Space activates a focused control before it filters.
        if (control(event.target)) return
        setNeedsMeOnly((value) => !value)
        event.preventDefault()
        return
      case 'i':
        // Into the selected pane's terminal. Every failure is shown: a binding
        // that silently does nothing is indistinguishable from a binding that
        // was never wired up.
        event.preventDefault()
        if (!selectedTask) return
        if (focusPane(paneId)) return
        push(selectedTask.panes.length ? t('paneFocusLost') : t('noPanes'), 'warn')
        return
      case '1':
        setTab('queue')
        return
      case '2':
        setTab('ledger')
        return
      case '3':
        setTab('recovery')
        return
      case 'n':
        setNewTaskOpen(true)
        event.preventDefault()
        return
      case 'c':
        // The connect palette. `i` focuses a pane that already exists; this is
        // how a new one gets made, locally or on another machine.
        setConnectOpen(true)
        event.preventDefault()
        return
      case 't':
        openTerminal()
        event.preventDefault()
        return
      case 'a':
      case 'd':
      case 's':
        decide(key)
        event.preventDefault()
        return
      default:
        return
    }
  }

  // Rebound every render, dispatched through a ref: the window listener itself
  // subscribes once, so a state push cannot drop a keystroke mid-resubscribe.
  useEffect(() => {
    keyRef.current = handleKey
  })

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => keyRef.current(event)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ---- paint ---------------------------------------------------------- */

  if (!booted) {
    return (
      <div className="boot">
        <span className="spin" />
        <span>{t('booting')}</span>
      </div>
    )
  }

  const install = !proEnabled || !herdrOnline
  const removeTask = view?.tasks.find((entry) => entry.id === removeId) ?? null
  const closable = canCloseShell(removeTask)

  return (
    <div
      className="bench"
      ref={shellRef}
      data-frame={frameless ? '0' : '1'}
      data-rail={railOpen ? 'open' : 'closed'}
      data-right={rightOpen ? 'open' : 'closed'}
    >
      {view ? (
        <TopBar
          view={view}
          pro={pro}
          railOpen={railOpen}
          rightOpen={rightOpen}
          t={t}
          onToggle={toggleConfig}
          onSummon={setSummon}
          onCompanion={toggleCompanion}
          onSnoozeAll={snoozeAll}
          onAdopt={adopt}
          onPurgeDeclined={purgeDeclined}
          onImport={() => setImportOpen(true)}
          onStage={toStage}
          onNewTask={() => setNewTaskOpen(true)}
          onConnect={() => setConnectOpen(true)}
          onTerminal={openTerminal}
          onRediscover={rediscover}
          onToggleRail={() => setRailOpen((value) => !value)}
          onToggleRight={() => setRightOpen((value) => !value)}
          frameless={frameless}
          onMinimize={minimizeBench}
          onClose={closeBench}
        />
      ) : (
        // Pro switched off: no projection, so no stage bar - but the chrome stays
        // mounted, because a cockpit that blanks itself cannot be switched back on.
        <header className="bench-topbar">
          <BenchBrand t={t} onStage={toStage} />
          <span className="spacer" />
          <WindowControls
            frameless={frameless}
            t={t}
            onMinimize={minimizeBench}
            onClose={closeBench}
          />
        </header>
      )}

      {install ? (
        <InstallCard
          herdr={view?.herdr ?? null}
          proEnabled={proEnabled}
          t={t}
          onNotify={push}
          onEnabled={() => void load()}
        />
      ) : (
        <>
          <TreeRail
            groups={shownGroups}
            totalTasks={view?.tasks.length ?? 0}
            selectedId={taskId}
            cursorId={cursorId}
            needsMeOnly={needsMeOnly}
            collapsed={collapsed}
            filter={treeFilter}
            counts={origins}
            t={t}
            onToggleNeedsMe={() => setNeedsMeOnly((value) => !value)}
            onToggleGroup={toggleGroup}
            onSelect={(id) => selectTask(id)}
            onFilter={setTreeFilter}
            onRename={renameTask}
          />

          <main className="bench-center">
            {selectedTask && (
              <TaskCard
                task={selectedTask}
                plan={plan}
                revision={revision}
                now={now}
                t={t}
                onNotify={push}
                onStatus={setStatus}
                onRename={renameTask}
                onRemove={() => askRemove(selectedTask.id)}
              />
            )}
            {switchable ? (
              <div className="center-tabs" role="tablist" aria-label={t('centerViewLabel')}>
                <button
                  type="button"
                  className="tab"
                  role="tab"
                  aria-selected={centerMode === 'term'}
                  data-active={centerMode === 'term'}
                  onClick={() => setCenterView((views) => ({ ...views, [selectedTask!.id]: 'term' }))}
                >
                  {t('centerTerm')}
                </button>
                <button
                  type="button"
                  className="tab"
                  role="tab"
                  aria-selected={centerMode === 'convo'}
                  data-active={centerMode === 'convo'}
                  onClick={() => setCenterView((views) => ({ ...views, [selectedTask!.id]: 'convo' }))}
                >
                  {t('centerConvo')}
                </button>
              </div>
            ) : null}
            {/* Hidden, not unmounted: an xterm pane that remounts replays its
                scrollback from scratch and loses the cursor position the human
                had; a transcript that remounts re-reads the file. CSS display
                keeps both alive while the other one fills the center. */}
            <div className="center-body" data-view={conversationTask ? 'convo' : centerMode}>
              {conversationTask ? (
                // A task with a session but no pane: imported from the companion,
                // or adopted from a herdr workspace whose terminal is gone. The
                // pane grid's honest answer here is "no panes", which tells the
                // human nothing about work that is still running in their own
                // terminal, so the transcript takes the center instead.
                <ConversationPanel task={conversationTask} t={t} lang={lang} onNotify={push} />
              ) : (
                <>
                  <PaneGrid
                    task={selectedTask}
                    selectedPaneId={paneId}
                    t={t}
                    onSelectPane={setPaneId}
                    onNotify={push}
                  />
                  {switchable ? (
                    <ConversationPanel task={selectedTask!} t={t} lang={lang} onNotify={push} />
                  ) : null}
                </>
              )}
            </div>
          </main>

          <aside className="bench-right">
            <div className="tabs" role="tablist">
              <Tab
                id="queue"
                label={t('queueTitle')}
                count={attention.length}
                active={tab === 'queue'}
                onSelect={setTab}
              />
              <Tab id="ledger" label={t('ledgerTitle')} active={tab === 'ledger'} onSelect={setTab} />
              <Tab
                id="recovery"
                label={t('recoveryTitle')}
                count={recoveryCount}
                active={tab === 'recovery'}
                onSelect={setTab}
              />
            </div>

            {tab === 'queue' && (
              <AttentionQueue
                items={attention}
                cursorId={attention[0]?.id ?? ''}
                now={now}
                keys={pro?.keys ?? null}
                t={t}
                onAct={(itemId, action, extra) => void act(itemId, action, extra)}
                onOpen={openItem}
                onNotify={push}
              />
            )}
            {tab === 'ledger' && (
              <LedgerPanel
                taskId={taskId}
                revision={revision}
                now={now}
                t={t}
                onNotify={push}
                onAppend={bump}
              />
            )}
            {tab === 'recovery' && (
              <RecoveryPanel
                plans={view?.recovery ?? []}
                herdrOnline={herdrOnline}
                t={t}
                onApply={(id) => recover(() => proApi.recovery.apply(id))}
                onApplyAll={() => recover(() => proApi.recovery.applyAll())}
                onReprompt={(id) => recover(() => proApi.recovery.reprompt(id))}
                onOpenTask={(id) => selectTask(id)}
              />
            )}

            {tab === 'queue' && <div className="panel-foot">{t('keyHints')}</div>}
          </aside>

          {/* The two seams. Rendered as siblings of the columns and positioned
              from the same variables, so a handle always sits exactly on the
              border it resizes - including the moment the column is mid-drag. */}
          <Splitter
            column="rail"
            label={t('splitRail')}
            dragging={splitting === 'rail'}
            width={railW}
            onDown={onSplitDown('rail')}
            onMove={onSplitMove}
            onUp={onSplitUp}
            onStep={onSplitStep('rail')}
            onReset={onSplitReset('rail')}
          />
          <Splitter
            column="right"
            label={t('splitRight')}
            dragging={splitting === 'right'}
            width={rightW}
            onDown={onSplitDown('right')}
            onMove={onSplitMove}
            onUp={onSplitUp}
            onStep={onSplitStep('right')}
            onReset={onSplitReset('right')}
          />
        </>
      )}

      <Toasts items={toasts} onDismiss={dismiss} />

      {newTaskOpen && (
        <NewTaskDialog
          defaultWorkdir={selectedTask?.workdir ?? ''}
          t={t}
          onCancel={() => setNewTaskOpen(false)}
          onCreated={onCreated}
          onNotify={push}
        />
      )}

      {importOpen && (
        <ImportDialog
          t={t}
          now={now}
          onCancel={() => setImportOpen(false)}
          onImported={onImported}
          onNotify={push}
        />
      )}

      {connectOpen && (
        <ConnectDialog
          t={t}
          cwd={selectedTask?.workdir ?? ''}
          onCancel={() => setConnectOpen(false)}
          onNotify={push}
        />
      )}

      {removeId && (
        <div
          className="scrim"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setRemoveId('')
          }}
        >
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('confirmRemoveTitle')}
          >
            <div className="dialog-head">
              <h2 className="dialog-title">{t('confirmRemoveTitle')}</h2>
            </div>
            <div className="dialog-grid">
              <p className="wide">{t('confirmRemoveBody')}</p>
              <p className="wide hint mono">
                {removeTask?.title || removeTask?.workdir || removeId}
              </p>
              {closable ? (
                <>
                  <span className="checks wide">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={removeClose}
                        onChange={(event) => setRemoveClose(event.target.checked)}
                      />
                      {t('confirmRemoveCloseShell')}
                    </label>
                  </span>
                  {!removeClose && <p className="wide hint">{t('confirmRemoveKeepShell')}</p>}
                </>
              ) : (
                // A disabled box with no sentence under it reads as a broken
                // dialog. Say what is true instead: there is no shell to close.
                <p className="wide hint">{t('confirmRemoveNoShell')}</p>
              )}
            </div>
            <div className="dialog-foot">
              <button type="button" className="btn ghost" onClick={() => setRemoveId('')}>
                {t('confirmCancel')}
              </button>
              <button type="button" className="btn danger" autoFocus onClick={confirmRemove}>
                {t('confirmRemove')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Tab({
  id,
  label,
  count = 0,
  active,
  onSelect
}: {
  id: RightTab
  label: string
  count?: number
  active: boolean
  onSelect: (tab: RightTab) => void
}): ReactElement {
  return (
    <button
      type="button"
      className="tab"
      role="tab"
      aria-selected={active}
      data-active={active}
      onClick={() => onSelect(id)}
    >
      {label}
      {count > 0 && <span className="tab-count">{count}</span>}
    </button>
  )
}

/**
 * The seam between a column and the panes: a resize handle, not a decoration.
 *
 * It is a `role="separator"` carrying the real value range, so the width is
 * legible to a screen reader and reachable with arrow keys - a splitter you can
 * only find with a mouse is a splitter nobody without one can move. The limits
 * come from `benchLayout` rather than being re-spelled here, because the same
 * numbers already decide where a drag may go and what `parseConfig` accepts.
 *
 * The handle owns no width of its own: CSS positions it from `--rail-w` /
 * `--right-w`, so it sits on the border it resizes and cannot drift away from
 * the column while that column is being dragged under the pointer.
 */
function Splitter({
  column,
  label,
  dragging,
  width,
  onDown,
  onMove,
  onUp,
  onStep,
  onReset
}: {
  column: BenchColumn
  label: string
  dragging: boolean
  width: number
  onDown: (event: ReactPointerEvent<HTMLElement>) => void
  onMove: (event: ReactPointerEvent<HTMLElement>) => void
  onUp: (event: ReactPointerEvent<HTMLElement>) => void
  onStep: (event: ReactKeyboardEvent<HTMLElement>) => void
  onReset: () => void
}): ReactElement {
  const { min, max } = COLUMN_RANGE[column]
  return (
    <Tip label={label} side="top">
      <div
        className={`bench-split bench-split-${column}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={clampColumnWidth(column, width)}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        data-dragging={dragging ? '1' : undefined}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={onReset}
        onKeyDown={(event) => {
          // Enter is the undo: a drag you did not mean has to be reversible
          // without a mouse, and without reading the tooltip first. Space too,
          // because a focused control that does nothing on Space reads as
          // broken - and the window-level handler would otherwise use it to
          // flip the needs-me filter while you are resizing a column.
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            onReset()
            return
          }
          onStep(event)
        }}
      />
    </Tip>
  )
}

/** OS language as this renderer can see it, for the frames before main answers. */
function localLang(): Lang {
  const locales = navigator.languages?.length ? navigator.languages : [navigator.language || 'en']
  return systemLangFromLocales(locales)
}

/** True when a keystroke belongs to a text field, or to a focused terminal. */
function typing(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null
  if (!element) return false
  // xterm keeps a hidden helper textarea inside `.xterm`; a terminal that has
  // focus must eat every key, including `j`, `k` and `s`.
  if (element.closest('.xterm')) return true
  const tag = element.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (element as HTMLElement).isContentEditable === true
}

/** True when Enter or Space would already activate the focused control. */
function control(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null
  if (!element) return false
  const tag = element.tagName
  return tag === 'BUTTON' || tag === 'A' || element.getAttribute('role') === 'button'
}
