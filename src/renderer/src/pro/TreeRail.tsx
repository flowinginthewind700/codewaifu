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
 */
import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'
import { TREE_FILTERS, type GroupView, type OriginCounts, type TreeFilter } from '@shared/pro'
import { agentClass } from './agentTag'
import { fill, type Translate } from './i18n'
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
  onSelect
}: TreeRailProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const shown = useMemo(() => {
    if (!needsMeOnly) return groups
    return groups
      .map((group) => ({ ...group, tasks: group.tasks.filter((task) => task.needsMe > 0) }))
      .filter((group) => group.tasks.length > 0)
  }, [groups, needsMeOnly])

  const shownCount = useMemo(() => shown.reduce((n, group) => n + group.tasks.length, 0), [shown])

  // Keep the keyboard cursor in view without yanking the list: `nearest` is the
  // only scroll behaviour that does not move a row you were about to click.
  useEffect(() => {
    if (!cursorId || !scrollRef.current) return
    scrollRef.current.querySelector<HTMLElement>('[data-cursor="true"]')?.scrollIntoView({
      block: 'nearest'
    })
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
                    t={t}
                    onSelect={onSelect}
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
  t: Translate
  onSelect: (taskId: string) => void
}

/** The slice of a `TaskView` a row reads. Named so the props stay honest. */
type TaskRowTask = GroupView['tasks'][number]

function TaskRow({ task, selectedId, cursorId, t, onSelect }: TaskRowProps): ReactElement {
  const selected = task.id === selectedId
  const agent = task.agentKind || task.panes[0]?.displayAgent || ''
  return (
    <button
      type="button"
      className="task-row"
      data-selected={selected}
      data-cursor={task.id === cursorId}
      aria-current={selected || undefined}
      onClick={() => onSelect(task.id)}
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
