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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { ProConfig } from '@shared/config'
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
import { BenchBrand, TopBar } from './TopBar'
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
    // Both drawers close. On a narrow window the point of opening a task is to
    // see its terminal, and the drawers overlay it.
    setRailOpen(false)
    setRightOpen(false)
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

  // The facet row only exists while there is something imported or adopted. If
  // the last one is removed while its chip is selected, the tree would stay
  // empty with no control left on screen to unfilter it.
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
      setRailOpen(false)
      setRightOpen(false)
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
        />
      ) : (
        // Pro switched off: no projection, so no stage bar - but the chrome stays
        // mounted, because a cockpit that blanks itself cannot be switched back on.
        <header className="bench-topbar">
          <BenchBrand t={t} onStage={toStage} />
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
                onRemove={() => askRemove(selectedTask.id)}
              />
            )}
            {conversationTask ? (
              // A task with a session but no pane: imported from the companion,
              // or adopted from a herdr workspace whose terminal is gone. The
              // pane grid's honest answer here is "no panes", which tells the
              // human nothing about work that is still running in their own
              // terminal, so the transcript takes the center instead.
              <ConversationPanel task={conversationTask} t={t} onNotify={push} />
            ) : (
              <PaneGrid
                task={selectedTask}
                selectedPaneId={paneId}
                t={t}
                onSelectPane={setPaneId}
                onNotify={push}
              />
            )}
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
