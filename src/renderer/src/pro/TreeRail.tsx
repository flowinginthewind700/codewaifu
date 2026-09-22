/**
 * The tree (F1): the map of all work.
 *
 * Groups are directories and never reorder, because a tree that jumps is a tree
 * nobody can click accurately. Urgency lives in the two places allowed to move:
 * the attention queue, and the `needs me` pill on a row.
 *
 * Origin is a facet, not a fourth group. Imported and adopted tasks live in the
 * directory they actually live in - that is the spine, and a task with two homes
 * in one tree is a tree that lies about where work is. What they get instead is
 * a badge on the row and a chip in the header. A chip that reads 0 next to two
 * that read 12 is not chrome saying nothing: it is the one thing that tells you
 * the 12 are all yours, which is a fact worth knowing before you filter on it.
 *
 * Every way to hide rows is a chip in that one row, needs-me included: a filter
 * people can see counting what it would show is a filter they can undo, and the
 * strip under the chips names whatever is on plus how many rows it hides, with
 * the one click that clears all of it. A tree that shrank to one row in silence
 * is a tree people file as a bug, and they would be right to.
 *
 * Collapse state lives in the Bench, not here and not in config. It is a viewing
 * preference for the next ten seconds, so persisting it would only make two
 * windows argue about which repo is open. But it cannot be private to this
 * component either: `j/k` walks the rows that are actually on screen, and only
 * the Bench knows both the tree order and which groups are folded. The origin
 * filter is the same kind of state, so it is applied there too and handed down
 * already filtered - one derivation, or the cursor walks rows nobody can see.
 *
 * Renaming is the opposite kind of state and does belong here: which row has an
 * open title field is a fact about this list, it outlives no projection, and the
 * Bench has nothing to decide with it. What the Bench owns is the write.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ChevronRight, FilterX, PencilLine } from 'lucide-react'
import { TREE_FILTERS, type GroupView, type OriginCounts, type TreeFilter } from '@shared/pro'
import { Tip } from '../Tip'
import { agentClass } from './agentTag'
import { fill, type Translate } from './i18n'
import { RenameField } from './RenameField'
import { dur } from './time'

export interface TreeRailProps {
  groups: GroupView[]
  totalTasks: number
  selectedId: string
  cursorId: string
  needsMeOnly: boolean
  /** Origin facet currently applied. The groups arrive already filtered by it. */
  filter: TreeFilter
  /** Counts over the *unfiltered* tree, so a chip can say what it would show. */
  counts: OriginCounts
  /** Group keys currently folded. Owned by the Bench; see the header note. */
  collapsed: ReadonlySet<string>
  /**
   * Whether the rail is on screen. Owned by the Bench, which is the only place
   * that knows: at a wide window a closed rail is `display: none`, and below
   * 721px it is a drawer slid off the left edge. Both mean "nothing here can be
   * seen", and a control that opens on an invisible row is one that commits on
   * the next blur with no way to read what it wrote.
   */
  open: boolean
  t: Translate
  onFilter: (filter: TreeFilter) => void
  onToggleNeedsMe: () => void
  onToggleGroup: (key: string) => void
  onSelect: (taskId: string) => void
  /** A title the human committed. Already trimmed and known to differ. */
  onRename: (taskId: string, title: string) => void
}

const STATUS_KEY = {
  active: 'statusActive',
  parked: 'statusParked',
  done: 'statusDone',
  lost: 'statusLost'
} as const

const FILTER_KEY = {
  all: 'filterAll',
  mine: 'filterMine',
  imported: 'filterImported'
} as const satisfies Record<TreeFilter, string>

/** The needs-me chip sits in the same row as the origin facets and is counted
 *  the same way, so the tree has one family of filters and no switch that can
 *  quietly shrink it to a single row. */
const NEEDS_ME_KEY = 'filterNeedsMe' as const

const ORIGIN_KEY = {
  adopted: 'originAdopted',
  imported: 'originImported'
} as const

/** Why the list is empty matters: the fix for each case is a different button. */
function emptyNote(needsMeOnly: boolean, filter: TreeFilter, t: Translate): string {
  if (needsMeOnly) return t('treeEmptyFiltered')
  if (filter !== 'all') return t('treeEmptyFacet')
  return t('treeEmpty')
}

/**
 * True when a keystroke belongs to something that is taking text.
 *
 * The same question the Bench's window handler asks, answered here again because
 * F2 is bound in this component and a handler that fires while you are typing
 * into a terminal eats a key the agent was waiting for. xterm keeps a hidden
 * helper textarea inside `.xterm`, so the container check comes first.
 */
function inTextField(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null
  if (!element) return false
  if (element.closest('.xterm')) return true
  const tag = element.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (element as HTMLElement).isContentEditable === true
}

/**
 * True while a dialog owns the window.
 *
 * Every dialog here is `aria-modal="true"` - new task, connect, import, remove,
 * and the character picker - so one selector covers the family. F2 renaming a
 * row behind an open dialog would steal focus from a field the human is filling
 * in, and the rename would commit on the blur that follows.
 */
function dialogOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null
}

export function TreeRail({
  groups,
  totalTasks,
  selectedId,
  cursorId,
  needsMeOnly,
  filter,
  counts,
  collapsed,
  open,
  t,
  onFilter,
  onToggleNeedsMe,
  onToggleGroup,
  onSelect,
  onRename
}: TreeRailProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [editingId, setEditingId] = useState('')

  const shown = useMemo(() => {
    if (!needsMeOnly) return groups
    return groups
      .map((group) => ({ ...group, tasks: group.tasks.filter((task) => task.needsMe > 0) }))
      .filter((group) => group.tasks.length > 0)
  }, [groups, needsMeOnly])

  const shownCount = useMemo(() => shown.reduce((n, group) => n + group.tasks.length, 0), [shown])
  const hiddenCount = totalTasks - shownCount
  /** While any filter is on the tree shows fewer rows than exist, and a tree
   *  that hides rows without saying so is a tree people call broken. The strip
   *  names every active filter and carries the one click that ends all of them. */
  const filtering = needsMeOnly || filter !== 'all'
  const clearFilters = useCallback(() => {
    if (needsMeOnly) onToggleNeedsMe()
    if (filter !== 'all') onFilter('all')
  }, [needsMeOnly, filter, onToggleNeedsMe, onFilter])

  /** A row that is no longer on screen cannot be the one being renamed. */
  useEffect(() => {
    if (!editingId) return
    if (shown.some((group) => group.tasks.some((task) => task.id === editingId))) return
    setEditingId('')
  }, [editingId, shown])

  // Keep the keyboard cursor in view without yanking the list: `nearest` is the
  // only scroll behaviour that does not move a row you were about to click.
  useEffect(() => {
    if (!cursorId || !scrollRef.current) return
    scrollRef.current.querySelector<HTMLElement>('[data-cursor="true"]')?.scrollIntoView({
      block: 'nearest'
    })
  }, [cursorId])

  /**
   * F2 renames the row `j/k` left highlighted, the way every file manager and
   * IDE renames the thing you are pointing at.
   *
   * Three ways out, each for a reason that is not obvious from the key: a rail
   * folded away cannot show the field it opened; a dialog owns the window; and a
   * keystroke belongs to whatever is taking text. Nothing is claimed in those
   * cases, so the Bench's own handler still sees the event.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Bare F2 only. A chord is somebody else's shortcut, and guessing which
      // one claims a key the agent or the terminal may be waiting on.
      if (event.key !== 'F2' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
        return
      if (inTextField(event.target) || dialogOpen()) return
      if (!open) return
      if (editingId) return
      // The cursor is only set on rows this rail can show, so it doubles as the
      // "there is something to rename" check: a folded group leaves it empty.
      if (!cursorId) return
      event.preventDefault()
      setEditingId(cursorId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, cursorId, editingId])

  const stopEditing = useCallback(() => setEditingId(''), [])

  return (
    <aside className="bench-rail">
      <div className="rail-head">
        <span className="section-label">{t('treeTitle')}</span>
      </div>

      {/* The facet row is the tree's filter surface, and it is always there:
          needs-me can bite on a machine where nothing was ever imported, so a
          rail that only grew its controls later would hide the one filter that
          is on. Counts are over the unfiltered tree, so a chip says what it
          would show before you click it. */}
      <div className="rail-facets" role="group" aria-label={t('filterLabel')}>
        {TREE_FILTERS.map((key) => (
          <button
            type="button"
            className="facet"
            key={key}
            data-on={filter === key || undefined}
            aria-pressed={filter === key}
            onClick={() => onFilter(key)}
          >
            {t(FILTER_KEY[key])}
            <span className="facet-n">{counts[key]}</span>
          </button>
        ))}
        <button
          type="button"
          className="facet"
          data-on={needsMeOnly || undefined}
          aria-pressed={needsMeOnly}
          title={t('needsMeOnly')}
          onClick={onToggleNeedsMe}
        >
          {t(NEEDS_ME_KEY)}
          <span className="facet-n">{counts.needsMe}</span>
        </button>
      </div>

      {filtering ? (
        <div className="rail-filterbar">
          <span className="filterbar-label">{t('railFiltering')}</span>
          {needsMeOnly && <span className="filterbar-tag">{t(NEEDS_ME_KEY)}</span>}
          {filter !== 'all' && <span className="filterbar-tag">{t(FILTER_KEY[filter])}</span>}
          {hiddenCount > 0 && (
            <span className="filterbar-hidden">{fill(t, 'railHidden', { n: hiddenCount })}</span>
          )}
          <span className="spacer" />
          <Tip label={t('filterClear')} side="bottom">
            <button
              type="button"
              className="btn ghost icon filterbar-clear"
              aria-label={t('filterClear')}
              onClick={clearFilters}
            >
              <FilterX />
            </button>
          </Tip>
        </div>
      ) : null}

      <div className="rail-scroll" ref={scrollRef}>
        {!shown.length && <p className="empty-note">{emptyNote(needsMeOnly, filter, t)}</p>}
        {shown.map((group) => {
          const open = !collapsed.has(group.key)
          return (
            <div className="group" key={group.key}>
              <button
                type="button"
                className="group-head"
                data-open={open}
                aria-expanded={open}
                title={group.key}
                onClick={() => onToggleGroup(group.key)}
              >
                <ChevronRight className="chev" />
                <span className="group-name">{group.label || t('unfiled')}</span>
                <span className="group-hint">{group.tasks.length}</span>
              </button>
              {open &&
                group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    selectedId={selectedId}
                    cursorId={cursorId}
                    editing={editingId === task.id}
                    t={t}
                    onSelect={onSelect}
                    onEdit={() => setEditingId(task.id)}
                    onRename={onRename}
                    onDone={stopEditing}
                  />
                ))}
            </div>
          )
        })}
      </div>

      <div className="rail-foot">{fill(t, 'treeFoot', { shown: shownCount, total: totalTasks })}</div>
    </aside>
  )
}

interface TaskRowProps {
  task: TaskRowTask
  selectedId: string
  cursorId: string
  /** This row's title field is open. */
  editing: boolean
  t: Translate
  onSelect: (taskId: string) => void
  onEdit: () => void
  onRename: (taskId: string, title: string) => void
  onDone: () => void
}

/** The slice of a `TaskView` a row reads. Named so the props stay honest. */
type TaskRowTask = GroupView['tasks'][number]

/**
 * One row, in two shapes.
 *
 * An `<input>` inside a `<button>` is invalid HTML and Chromium quietly drops
 * the keystrokes, so while the title is open the row is a `div` that keeps every
 * class and data attribute it had - the same row, minus one thing it may not
 * contain. `data-editing` is what the stylesheet uses to stop the row from
 * looking clickable while you are typing into it.
 *
 * The rename pencil is the row's sibling, never its child: a `<button>` may not
 * hold another `<button>`, and turning the row into a `div` to make room would
 * cost it the click and the keyboard activation the whole tree runs on. So
 * `.task-cell` is the per-row box that owns both, and the pencil floats over the
 * right edge of the padding the row reserves permanently - which is why showing
 * it cannot shove the status pills sideways and move a row under the pointer.
 */
function TaskRow({
  task,
  selectedId,
  cursorId,
  editing,
  t,
  onSelect,
  onEdit,
  onRename,
  onDone
}: TaskRowProps): ReactElement {
  const selected = task.id === selectedId
  const agent = task.agentKind || task.panes[0]?.displayAgent || ''
  const flags = {
    'data-selected': selected,
    'data-cursor': task.id === cursorId,
    'data-editing': editing || undefined
  }

  /** Hidden while the field is open: a pencil beside a caret renames twice. */
  const pencil = editing ? null : (
    <Tip label={t('renameTask')} kbd="F2">
      <button
        type="button"
        className="btn ghost icon row-rename"
        aria-label={t('renameTask')}
        onClick={(event) => {
          // Without this the row underneath also takes the click, and the field
          // opens on a task that just became the selected one.
          event.stopPropagation()
          onEdit()
        }}
      >
        <PencilLine />
      </button>
    </Tip>
  )

  if (editing) {
    return (
      <div className="task-cell">
        <div className="task-row" {...flags}>
          <span className="dot" data-state={task.liveStatus} title={task.liveStatus} />
          <span className="task-main">
            <RenameField
              value={task.title}
              className="task-rename"
              ariaLabel={t('renameTask')}
              hint={t('renameKeys')}
              onCommit={(title) => {
                onDone()
                onRename(task.id, title)
              }}
              onCancel={onDone}
            />
            <span className="task-sub">
              {agent && <span className={`tag ${agentClass(agent)}`.trim()}>{agent}</span>}
              {task.branch && <span className="branch">{task.branch}</span>}
            </span>
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="task-cell">
      <button
        type="button"
        className="task-row"
        {...flags}
        aria-current={selected || undefined}
        onClick={() => onSelect(task.id)}
        onDoubleClick={onEdit}
      >
        <span className="dot" data-state={task.liveStatus} title={task.liveStatus} />
        <span className="task-main">
          <span className="task-name">{task.title || t('unfiled')}</span>
          <span className="task-sub">
            {agent && <span className={`tag ${agentClass(agent)}`.trim()}>{agent}</span>}
            {/* Provenance, quiet: it answers "did I start this here" without
                competing with the status pill for the same row. */}
            {task.origin !== 'created' && (
              <span className="tag" data-origin={task.origin}>
                {t(ORIGIN_KEY[task.origin])}
              </span>
            )}
            {task.branch && <span className="branch">{task.branch}</span>}
            {task.dirty > 0 && <span>{fill(t, 'dirtyCount', { n: task.dirty })}</span>}
            {task.blockedMs > 0 && <span className="warn">{dur(task.blockedMs, t)}</span>}
          </span>
        </span>
        <span className="task-side">
          {task.needsMe > 0 && <span className="pill">{task.needsMe}</span>}
          {task.status !== 'active' && (
            <span className="pill quiet">{t(STATUS_KEY[task.status])}</span>
          )}
        </span>
      </button>
      {pencil}
    </div>
  )
}
