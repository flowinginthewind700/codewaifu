/**
 * The origin facet: where a task came from, and what the tree does with it.
 *
 * The tree's spine is directories, so "imported" cannot be a folder without
 * moving a task out of the checkout it actually lives in. What these functions
 * implement instead is a facet over the same rows, and a facet has three
 * properties worth a case each, because each is a way the rail could quietly
 * lie:
 *
 * 1. Filtering drops the groups that end up empty. A heading with nothing under
 *    it is a promise the list did not keep.
 * 2. Counts are recomputed from the rows that survived, never carried over. A
 *    chip reading 4 above a list of 2 is worse than no chip.
 * 3. `imported` and `adopted` are one bucket to the filter and two to the badge.
 *    Both mean "not made here"; only the row can say which.
 *
 * The second half of the file is the other two promises the rail makes: a row
 * only moves when it needs you (`compareTasks`), and a heading only ever moves
 * when a directory is renamed (`deriveGroups`, `groupLabelFor`). Both are read
 * through `buildBench` rather than from hand-written views, so a fixture here
 * cannot describe a bench the projection could never produce.
 *
 * Records come out of `parseTaskRecord` and groups out of `buildBench`, so a
 * fixture here cannot describe a bench the projection could never produce.
 */
import { describe, expect, it } from 'vitest'
import { parseSnapshot, type Snapshot } from '../src/shared/herdr'
import {
  buildBench,
  bindTasks,
  deriveGroups,
  filterGroups,
  groupKeyFor,
  groupLabelFor,
  originCounts,
  parseTaskRecord,
  provisionTasks,
  taskOriginOf,
  treeFilterOf,
  type AttentionItem,
  type BenchView,
  type GroupView,
  type TaskRecord
} from '../src/shared/pro'
import { attentionItem, benchView } from './helpers/pro'

const NOW = 1_700_000_000_000
const REPO = '/work/codewaifu'
const OTHER = '/work/robotworld'

function record(patch: Record<string, unknown>): TaskRecord {
  const parsed = parseTaskRecord(patch)
  if (!parsed) throw new Error(`task fixture did not parse: ${JSON.stringify(patch)}`)
  return parsed
}

/** One live pane in one workspace: what herdr hands back for adopted work. */
function snapshotWith(workspaceId: string, cwd: string): Snapshot {
  const parsed = parseSnapshot({
    version: '0.0.0-test',
    protocol: 1,
    workspaces: [{ workspace_id: workspaceId, number: 1, label: workspaceId }],
    panes: [
      { pane_id: 'p-1', workspace_id: workspaceId, tab_id: 'tab-1', cwd, agent: 'codex' }
    ]
  })
  if (!parsed) throw new Error('snapshot fixture did not parse')
  return parsed
}

/**
 * One live pane per entry, each with a status. The `working` rung of the tree
 * order can only be reached from a real herdr pane, and the cwds are a
 * directory no task claims so that binding happens by workspace rather than by
 * the workdir fallback (which would quietly make every task in the fixture
 * live, and the ladder untestable).
 */
function liveSnapshot(
  panes: readonly { workspaceId: string; status: string }[]
): Snapshot {
  const parsed = parseSnapshot({
    version: '0.0.0-test',
    protocol: 1,
    workspaces: panes.map((pane, index) => ({
      workspace_id: pane.workspaceId,
      number: index + 1,
      label: pane.workspaceId
    })),
    panes: panes.map((pane, index) => ({
      pane_id: `p-${index + 1}`,
      workspace_id: pane.workspaceId,
      tab_id: `tab-${index + 1}`,
      cwd: `/tmp/live/${pane.workspaceId}`,
      agent: 'codex',
      agent_status: pane.status
    }))
  })
  if (!parsed) throw new Error('snapshot fixture did not parse')
  return parsed
}

/** A task pinned to one of `liveSnapshot`'s workspaces. */
function liveTask(patch: Record<string, unknown>): TaskRecord {
  return record({ workdir: REPO, repoRoot: REPO, status: 'active', updatedAt: NOW, ...patch })
}

/**
 * The projection, not a hand-written `GroupView[]`: grouping, labels and the
 * per-group counts all come from the same code the rail renders.
 */
function bench(
  tasks: readonly TaskRecord[],
  opts: { snapshot?: Snapshot | null; attention?: readonly AttentionItem[] } = {}
): BenchView {
  return buildBench({
    now: NOW,
    herdr: benchView().herdr,
    snapshot: opts.snapshot ?? null,
    tasks,
    attention: [...(opts.attention ?? [])]
  })
}

const MINE = record({
  id: 't-mine',
  title: 'the one I started here',
  workdir: REPO,
  repoRoot: REPO,
  status: 'active',
  updatedAt: NOW,
  origin: 'created'
})

const ADOPTED = record({
  id: 't-adopted',
  title: 'herdr was already running this',
  workdir: REPO,
  repoRoot: REPO,
  status: 'active',
  updatedAt: NOW,
  origin: 'adopted'
})

const IMPORTED = record({
  id: 't-imported',
  title: 'a session she saw somewhere else',
  workdir: OTHER,
  repoRoot: OTHER,
  status: 'parked',
  updatedAt: NOW,
  origin: 'imported'
})

/** Two directories: one holding both of the first two, one holding the third. */
function groups(): GroupView[] {
  return bench([MINE, ADOPTED, IMPORTED]).groups
}

function ids(shown: readonly GroupView[]): string[] {
  return shown.flatMap((group) => group.tasks.map((task) => task.id))
}

describe('taskOriginOf', () => {
  it('keeps the three origins it knows', () => {
    expect(taskOriginOf('created')).toBe('created')
    expect(taskOriginOf('adopted')).toBe('adopted')
    expect(taskOriginOf('imported')).toBe('imported')
  })

  it('trims and folds, because bench.json is ours but it is also editable', () => {
    expect(taskOriginOf('  IMPORTED ')).toBe('imported')
  })

  it('answers created for anything else, including nothing at all', () => {
    expect(taskOriginOf('summoned')).toBe('created')
    expect(taskOriginOf(undefined)).toBe('created')
    expect(taskOriginOf(7)).toBe('created')
  })
})

describe('a record written before origin existed', () => {
  it('loads as created instead of failing or inventing a provenance', () => {
    // The upgrade path is the point: an existing bench.json has no origin key,
    // and a parser that dropped the record would empty somebody's tree.
    const parsed = record({ id: 't-old', title: 'shipped last month', workdir: REPO, updatedAt: NOW })
    expect(parsed.origin).toBe('created')
  })
})

describe('provisionTasks', () => {
  it('marks work herdr was already running as adopted', () => {
    const result = provisionTasks({
      snapshot: snapshotWith('ws-9', OTHER),
      tasks: [],
      now: NOW,
      newId: () => 't-new'
    })
    expect(result.created).toHaveLength(1)
    expect(result.created[0].origin).toBe('adopted')
  })

  it('declines a workspace the human removed instead of adopting it back', () => {
    // Removing a row does not close the session - the confirmation says so -
    // which means the workspace is still in every later snapshot and still
    // unclaimed. Adoption cannot tell "nobody wants this" from "the human just
    // threw this away" without being told, and getting it wrong is the row
    // coming back.
    const result = provisionTasks({
      snapshot: snapshotWith('ws-9', OTHER),
      tasks: [],
      now: NOW,
      newId: () => 't-new',
      forgotten: ['ws-9']
    })
    expect(result.created).toHaveLength(0)
  })

  it('still adopts the neighbours of a removed workspace', () => {
    const snapshot = parseSnapshot({
      version: '0.0.0-test',
      protocol: 1,
      workspaces: [
        { workspace_id: 'ws-9', number: 1, label: 'removed' },
        { workspace_id: 'ws-10', number: 2, label: 'new' }
      ],
      panes: [
        { pane_id: 'ws-9:p1', workspace_id: 'ws-9', tab_id: 't1', cwd: OTHER },
        { pane_id: 'ws-10:p1', workspace_id: 'ws-10', tab_id: 't2', cwd: OTHER }
      ]
    })
    if (!snapshot) throw new Error('snapshot fixture did not parse')
    const result = provisionTasks({
      snapshot,
      tasks: [],
      now: NOW,
      newId: () => 't-new',
      forgotten: ['ws-9']
    })
    // A removal is about one workspace. Blocking the whole snapshot would make
    // "I closed that one terminal" cost every terminal opened afterwards.
    expect(result.created.map((task) => task.workspaceId)).toEqual(['ws-10'])
  })
})

/**
 * The weakest binding rule is the only one that collides, so it is the only one
 * that has to look at the rest of the roster.
 *
 * "Some pane has my directory as cwd" is true of every shell opened in the same
 * checkout, and a task whose own workspace is momentarily missing from a
 * snapshot - the rebuild case the fallback exists for - will grab a neighbour's
 * instead. Bound one task at a time that guess is indistinguishable from a real
 * match, and `rebind` writes it back to disk, so two rows stay glued to one pane
 * across restarts: the older one mirrors output it never started, and steering
 * it types into somebody else's shell.
 */
describe('bindTasks', () => {
  /** Every pane in one directory, so the guess matches all of them. */
  function sharedCwd(workspaceIds: readonly string[]): Snapshot {
    const parsed = parseSnapshot({
      version: '0.0.0-test',
      protocol: 1,
      workspaces: workspaceIds.map((id, index) => ({
        workspace_id: id,
        number: index + 1,
        label: id
      })),
      panes: workspaceIds.map((id) => ({
        pane_id: `${id}:p1`,
        workspace_id: id,
        tab_id: `${id}:t1`,
        cwd: REPO
      }))
    })
    if (!parsed) throw new Error('snapshot fixture did not parse')
    return parsed
  }

  const HOLDER = record({
    id: 't-holder',
    workdir: REPO,
    workspaceId: 'w1',
    paneIds: ['w1:p1'],
    updatedAt: NOW
  })
  const GUESSER = record({ id: 't-guesser', workdir: REPO, updatedAt: NOW })

  function bound(tasks: readonly TaskRecord[], snapshot: Snapshot): Record<string, string> {
    const out: Record<string, string> = {}
    for (const binding of bindTasks(tasks, snapshot)) {
      out[binding.taskId] = `${binding.workspaceId || '-'}:${binding.matchedBy}`
    }
    return out
  }

  it('does not let the directory guess take a workspace an id holds', () => {
    expect(bound([HOLDER, GUESSER], sharedCwd(['w1', 'w2']))).toEqual({
      't-holder': 'w1:workspace',
      // Its own shell, found by stepping around the held one: still a guess,
      // but a guess about a pane nobody else claims.
      't-guesser': 'w2:workdir'
    })
  })

  it('goes stale rather than share, when there is nowhere else to land', () => {
    expect(bound([HOLDER, GUESSER], sharedCwd(['w1']))).toEqual({
      't-holder': 'w1:workspace',
      // Stale is the honest answer and it is recoverable: the pane may come
      // back, and the ledger still holds the evidence to re-bind by session.
      't-guesser': '-:stale'
    })
  })

  it('answers the same whichever order the roster happens to be in', () => {
    // One pass would make the outcome depend on which row came first in
    // bench.json, and the file is written by whichever operation landed last.
    expect(bound([GUESSER, HOLDER], sharedCwd(['w1', 'w2']))).toEqual({
      't-holder': 'w1:workspace',
      't-guesser': 'w2:workdir'
    })
  })

  it('still binds by directory when nothing stronger holds it', () => {
    expect(bound([GUESSER], sharedCwd(['w1', 'w2']))).toEqual({ 't-guesser': 'w1:workdir' })
  })

  it('binds nothing at all when herdr is away', () => {
    expect(bindTasks([HOLDER, GUESSER], null).map((binding) => binding.matchedBy)).toEqual([
      'stale',
      'stale'
    ])
    expect(bindTasks([HOLDER, GUESSER], null).map((binding) => binding.workspaceId)).toEqual([
      '',
      ''
    ])
  })
})

describe('groupKeyFor', () => {
  it('files a worktree under the repo it came from', () => {
    expect(groupKeyFor({ repoRoot: REPO, workdir: `${REPO}/.worktrees/fix-auth` })).toBe(REPO)
  })

  it('falls back to the workdir and never keeps a trailing slash', () => {
    expect(groupKeyFor({ repoRoot: '', workdir: `${OTHER}/` })).toBe(OTHER)
  })
})

describe('filterGroups', () => {
  it('all is every row, handed back as a copy', () => {
    const every = groups()
    const shown = filterGroups(every, 'all')
    expect(ids(shown)).toEqual(ids(every))
    // A copy, because the rail keeps the unfiltered tree to count facets from.
    expect(shown).not.toBe(every)
  })

  it('mine keeps what was made here and drops the group left empty', () => {
    const shown = filterGroups(groups(), 'mine')
    expect(shown.map((group) => group.label)).toEqual(['codewaifu'])
    expect(ids(shown)).toEqual(['t-mine'])
  })

  it('imported is "not made here", so adopted and imported alike', () => {
    expect(ids(filterGroups(groups(), 'imported'))).toEqual(['t-adopted', 't-imported'])
  })

  it('recounts from the rows that survived', () => {
    const before = groups().find((group) => group.label === 'codewaifu')
    expect(before?.counts.total).toBe(2)
    const [shown] = filterGroups(groups(), 'mine')
    expect(shown.counts.total).toBe(1)
  })
})

describe('originCounts', () => {
  it('counts the whole tree, which is what a chip has to promise', () => {
    expect(originCounts(groups())).toEqual({ all: 3, mine: 1, imported: 2 })
  })

  it('is zero over an empty tree, so the facet row stays hidden', () => {
    expect(originCounts([])).toEqual({ all: 0, mine: 0, imported: 0 })
  })
})

describe('treeFilterOf', () => {
  it('folds an unknown facet back to all rather than to nothing', () => {
    expect(treeFilterOf(' MINE ')).toBe('mine')
    expect(treeFilterOf('imported')).toBe('imported')
    expect(treeFilterOf('bogus')).toBe('all')
    expect(treeFilterOf(null)).toBe('all')
  })
})

/* ------------------------------------------------------------------ *
 * Tree order
 * ------------------------------------------------------------------ */

/**
 * Movement in a tree has to mean something. The ladder is: needs a decision,
 * then active and working, then active and quiet, then lost, then everything
 * the human put away - and only inside a rung does the title decide. Titles
 * below are deliberately reverse-alphabetical, so an order that came out
 * alphabetical would be an order that ignored the ranks.
 */
describe('the tree order', () => {
  const ladder = (): BenchView =>
    bench(
      [
        liveTask({ id: 't-a', title: 'aaa parked', status: 'parked' }),
        liveTask({ id: 't-b', title: 'bbb lost', status: 'lost' }),
        liveTask({ id: 't-c', title: 'ccc no live pane' }),
        liveTask({ id: 't-d', title: 'ddd working', workspaceId: 'ws-work' }),
        liveTask({ id: 't-e', title: 'eee wants a decision', status: 'done' })
      ],
      {
        snapshot: liveSnapshot([{ workspaceId: 'ws-work', status: 'working' }]),
        attention: [attentionItem({ taskId: 't-e' })]
      }
    )

  it('ranks by need, and only then by name', () => {
    expect(ladder().tasks.map((task) => task.id)).toEqual(['t-e', 't-d', 't-c', 't-b', 't-a'])
  })

  it('ranks the row needing a decision first even when it is finished', () => {
    // `status: 'done'` is the human's filing; the queue item is the truth right
    // now. A row that needs an answer must not hide under "put away".
    const [first] = ladder().tasks
    expect(first.id).toBe('t-e')
    expect(first.needsMe).toBe(1)
  })

  it('breaks a tie on title, then on id, so the order never flickers', () => {
    const view = bench([
      liveTask({ id: 't-zzz', title: 'beta' }),
      liveTask({ id: 't-aaa', title: 'alpha' }),
      liveTask({ id: 't-b', title: 'same' }),
      liveTask({ id: 't-a', title: 'same' })
    ])
    expect(view.tasks.map((task) => task.id)).toEqual(['t-aaa', 't-zzz', 't-a', 't-b'])
  })

  it('does not float a blocked task on its own: blocked is what the queue is for', () => {
    const view = bench(
      [
        liveTask({ id: 't-blocked', title: 'zzz blocked', workspaceId: 'ws-blocked' }),
        liveTask({ id: 't-working', title: 'aaa working', workspaceId: 'ws-working' }),
        liveTask({ id: 't-quiet', title: 'mmm quiet' })
      ],
      {
        snapshot: liveSnapshot([
          { workspaceId: 'ws-blocked', status: 'blocked' },
          { workspaceId: 'ws-working', status: 'working' }
        ])
      }
    )
    // `blocked` folds to the same rung as an active task with no live pane, so
    // these two sort on title; the working row outranks both.
    expect(view.tasks.map((task) => task.id)).toEqual(['t-working', 't-quiet', 't-blocked'])
  })

  it('floats the same blocked task once it is actually asking for something', () => {
    const view = bench(
      [
        liveTask({ id: 't-blocked', title: 'zzz blocked', workspaceId: 'ws-blocked' }),
        liveTask({ id: 't-working', title: 'aaa working', workspaceId: 'ws-working' })
      ],
      {
        snapshot: liveSnapshot([
          { workspaceId: 'ws-blocked', status: 'blocked' },
          { workspaceId: 'ws-working', status: 'working' }
        ]),
        attention: [attentionItem({ taskId: 't-blocked' })]
      }
    )
    expect(view.tasks.map((task) => task.id)).toEqual(['t-blocked', 't-working'])
  })
})

/* ------------------------------------------------------------------ *
 * Groups
 * ------------------------------------------------------------------ */

describe('the group order', () => {
  it('is alphabetical by label, then by path, and never by urgency', () => {
    const view = bench(
      [
        liveTask({ id: 't-1', title: 'in zebra', workdir: '/work/zebra', repoRoot: '/work/zebra' }),
        liveTask({ id: 't-2', title: 'in apple', workdir: '/work/apple', repoRoot: '/work/apple' }),
        liveTask({ id: 't-3', title: 'other repo', workdir: '/other/place/repo', repoRoot: '/other/place/repo' }),
        liveTask({ id: 't-4', title: 'work repo', workdir: '/work/shared/repo', repoRoot: '/work/shared/repo' })
      ],
      // The urgent row lives in the last directory alphabetically: a heading
      // that jumps to the top is a tree nobody can read twice.
      { attention: [attentionItem({ taskId: 't-1' })] }
    )
    expect(view.groups.map((group) => group.key)).toEqual([
      '/work/apple',
      '/other/place/repo',
      '/work/shared/repo',
      '/work/zebra'
    ])
    expect(view.groups.map((group) => group.label)).toEqual(['apple', 'repo', 'repo', 'zebra'])
  })

  it('keeps the rows it is handed, in the order it is handed them', () => {
    const [a, b] = bench([
      liveTask({ id: 't-quiet', title: 'mmm quiet' }),
      liveTask({ id: 't-urgent', title: 'zzz urgent' })
    ], { attention: [attentionItem({ taskId: 't-urgent' })] }).tasks
    expect([a.id, b.id]).toEqual(['t-urgent', 't-quiet'])
    // `deriveGroups` is the bucketing step, not a second sort: reversing its
    // input reverses the group, which is what keeps the ladder above the only
    // thing that decides order.
    const reversed = deriveGroups([b, a])
    expect(reversed[0].tasks.map((task) => task.id)).toEqual(['t-quiet', 't-urgent'])
  })

  it('carries the parent directory as a hint, for two checkouts of one repo', () => {
    const [group] = bench([liveTask({ id: 't-1', title: 'here' })]).groups
    expect(group.label).toBe('codewaifu')
    expect(group.hint).toBe('work')
  })

  it('has no hint for a bare directory, and files a task with no path under unknown', () => {
    const view = bench([
      liveTask({ id: 't-bare', title: 'relative', workdir: 'repo', repoRoot: 'repo' }),
      liveTask({ id: 't-homeless', title: 'nowhere', workdir: '', repoRoot: '' })
    ])
    const byKey = new Map(view.groups.map((group) => [group.key, group]))
    expect(byKey.get('repo')?.hint).toBe('')
    expect(byKey.get('')?.label).toBe('unknown')
    expect(byKey.get('')?.tasks.map((task) => task.id)).toEqual(['t-homeless'])
  })
})

describe('groupLabelFor', () => {
  it('names a group after its last path segment', () => {
    expect(groupLabelFor('/work/codewaifu')).toBe('codewaifu')
  })

  it('reads a Windows path and a UNC share the same way', () => {
    expect(groupLabelFor('C:\\work\\codewaifu')).toBe('codewaifu')
    expect(groupLabelFor('\\\\files\\team\\codewaifu')).toBe('codewaifu')
  })

  it('falls back to the key, then to unknown, rather than to an empty heading', () => {
    expect(groupLabelFor('/')).toBe('/')
    expect(groupLabelFor('')).toBe('unknown')
  })
})
