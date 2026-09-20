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
 * a badge on the row and a chip in the header, and the chip row only appears
 * once there is something to filter: three segments reading 12 / 12 / 0 on a
 * machine where everything was made here is chrome that says nothing.
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
import { ChevronRight, PencilLine } from 'lucide-react'
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

export function TreeRail({
  groups,
  totalTasks,
  selectedId,
  cursorId,
  needsMeOnly,
  filter,
  counts,
  collapsed,
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

  const stopEditing = useCallback(() => setEditingId(''), [])
  /** The head button names the row `j/k` left highlighted, so it is never a guess. */
  const renameCursor = useCallback(() => {
    if (cursorId) setEditingId(cursorId)
  }, [cursorId])

  return (
    <aside className="bench-rail">
      <div className="rail-head">
        <span className="section-label">{t('treeTitle')}</span>
        <span className="spacer" />
        <label className="toggle" title={t('needsMeOnly')}>
          <input type="checkbox" checked={needsMeOnly} onChange={onToggleNeedsMe} />
          {t('countNeedsMe')}
        </label>
        <Tip label={t('renameTask')} side="bottom">
          <button
            type="button"
            className="btn ghost icon rename-toggle"
            aria-label={t('renameTask')}
            disabled={!cursorId}
            onClick={renameCursor}
          >
            <PencilLine />
          </button>
        </Tip>
      </div>

      {counts.imported > 0 ? (
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

  if (editing) {
    return (
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
    )
  }

  return (
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
        {task.status !== 'active' && <span className="pill quiet">{t(STATUS_KEY[task.status])}</span>}
      </span>
    </button>
  )
}
