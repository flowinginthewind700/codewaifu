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
 * Records come out of `parseTaskRecord` and groups out of `buildBench`, so a
 * fixture here cannot describe a bench the projection could never produce.
 */
import { describe, expect, it } from 'vitest'
import { parseSnapshot, type Snapshot } from '../src/shared/herdr'
import {
  buildBench,
  filterGroups,
  groupKeyFor,
  originCounts,
  parseTaskRecord,
  provisionTasks,
  taskOriginOf,
  treeFilterOf,
  type BenchView,
  type GroupView,
  type TaskRecord
} from '../src/shared/pro'
import { benchView } from './helpers/pro'

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
 * The projection, not a hand-written `GroupView[]`: grouping, labels and the
 * per-group counts all come from the same code the rail renders.
 */
function bench(tasks: readonly TaskRecord[]): BenchView {
  return buildBench({
    now: NOW,
    herdr: benchView().herdr,
    snapshot: null,
    tasks,
    attention: []
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
