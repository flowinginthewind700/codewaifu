/**
 * The verbs that cross from the widget and the Bench toolbar into the service.
 *
 * These parsers fold the incoming verb to lower case and then compare it, so
 * the literals in the tests below are spelled exactly the way the call sites
 * spell them (`App.tsx` sends `focusTask`, `api.ts` sends `snoozeAll`,
 * `Bench.tsx` sends `applyAll`). That is deliberate: a parser that compares a
 * folded verb against a camelCase label rejects every one of them with
 * `bad-op`, which reads like a version mismatch rather than a dead button.
 */
import { describe, expect, it } from 'vitest'
import {
  isProReject,
  parseBenchCommand,
  parseProCompanion,
  parseProRecovery,
  parseProTask,
  paneIdOf,
  taskIdOf,
  threadKeysOf,
  type ProCompanionRequest,
  type ProTaskRequest
} from '../src/shared/proIpc'
import { DEFAULT_SNOOZE_MINUTES } from '../src/shared/pro'
import type { BenchCommand } from '../src/shared/companionLink'

function command(payload: unknown): BenchCommand {
  const result = parseBenchCommand(payload)
  if (isProReject(result)) {
    throw new Error(`expected a command, got ${result.code}: ${result.error}`)
  }
  return result
}

function refusedCommand(payload: unknown): string {
  const result = parseBenchCommand(payload)
  if (!isProReject(result)) throw new Error(`expected a rejection, got ${JSON.stringify(result)}`)
  return result.code
}

describe('parseBenchCommand', () => {
  it('accepts the openBench the widget sends', () => {
    expect(command({ type: 'openBench' })).toEqual({ type: 'openBench' })
  })

  it('accepts the focusTask the widget sends, with and without a pane', () => {
    expect(command({ type: 'focusTask', taskId: 'task-1' })).toEqual({
      type: 'focusTask',
      taskId: 'task-1'
    })
    expect(command({ type: 'focusTask', taskId: 'task-1', paneId: 'pane-3' })).toEqual({
      type: 'focusTask',
      taskId: 'task-1',
      paneId: 'pane-3'
    })
  })

  it('accepts the snoozeAll the Bench toolbar sends', () => {
    expect(command({ type: 'snoozeAll', minutes: 30 })).toEqual({
      type: 'snoozeAll',
      minutes: 30
    })
  })

  it('defaults snooze minutes rather than snoozing for zero of them', () => {
    expect(command({ type: 'snoozeAll' })).toEqual({
      type: 'snoozeAll',
      minutes: DEFAULT_SNOOZE_MINUTES
    })
  })

  const minutes: [number, number][] = [
    [0, 1],
    [-15, 1],
    [9999, 240]
  ]

  it.each(minutes)('clamps %s snooze minutes to %s', (input, expected) => {
    expect(command({ type: 'snoozeAll', minutes: input })).toEqual({
      type: 'snoozeAll',
      minutes: expected
    })
  })

  it('truncates a fractional minute count rather than rounding it', () => {
    // The parser floors with int(); resolveCommand is the layer that rounds.
    // Neither is wrong, but a bubble asking for 12.6 minutes gets 12 here,
    // and pinning the wrong one makes the two layers look interchangeable.
    expect(command({ type: 'snoozeAll', minutes: 12.6 })).toEqual({
      type: 'snoozeAll',
      minutes: 12
    })
  })

  it('keeps the short aliases, since a widget author is not a protocol', () => {
    expect(command({ type: 'open' })).toEqual({ type: 'openBench' })
    expect(command({ type: 'focus', taskId: 'task-1' })).toEqual({
      type: 'focusTask',
      taskId: 'task-1'
    })
  })

  it('reads op as a synonym for type', () => {
    expect(command({ op: 'openBench' })).toEqual({ type: 'openBench' })
  })

  it('accepts an act carrying everything it needs', () => {
    expect(
      command({ type: 'act', itemId: 'i-1', taskId: 'task-1', action: 'approve', paneId: 'pane-3' })
    ).toEqual({
      type: 'act',
      action: 'approve',
      itemId: 'i-1',
      taskId: 'task-1',
      paneId: 'pane-3',
      text: '',
      option: 0
    })
  })

  it('refuses an act with a missing itemId, taskId or action', () => {
    expect(refusedCommand({ type: 'act', taskId: 't', action: 'approve' })).toBe('bad-payload')
    expect(refusedCommand({ type: 'act', itemId: 'i', action: 'approve' })).toBe('bad-task')
    expect(refusedCommand({ type: 'act', itemId: 'i', taskId: 't' })).toBe('bad-action')
    expect(refusedCommand({ type: 'act', itemId: 'i', taskId: 't', action: 'sidestep' })).toBe(
      'bad-action'
    )
  })

  it('refuses an answer with nothing in it', () => {
    expect(
      refusedCommand({ type: 'act', itemId: 'i', taskId: 't', action: 'answer', text: '   ' })
    ).toBe('needs-text')
    expect(
      command({ type: 'act', itemId: 'i', taskId: 't', action: 'answer', text: ' yes ' })
    ).toMatchObject({ action: 'answer', text: 'yes' })
  })

  it('has no input verb, so the widget is never a second keyboard', () => {
    // MVP section 9. A companion that can type into a pane can run anything the
    // human could run, and she is reachable from a bubble over untrusted text.
    expect(refusedCommand({ type: 'input', taskId: 't', paneId: 'p', text: 'rm -rf /' })).toBe(
      'bad-op'
    )
    expect(refusedCommand({ type: 'keys', taskId: 't', paneId: 'p' })).toBe('bad-op')
  })

  it('names the command it refused', () => {
    const result = parseBenchCommand({ type: 'launchTheRockets' })
    expect(isProReject(result)).toBe(true)
    if (isProReject(result)) {
      expect(result.code).toBe('bad-op')
      expect(result.error).toContain('launchTheRockets')
    }
  })

  it('refuses a focus with no usable task id', () => {
    expect(refusedCommand({ type: 'focusTask' })).toBe('bad-task')
    expect(refusedCommand({ type: 'focusTask', taskId: '../evil' })).toBe('bad-task')
  })

  it('drops a pane id it cannot use rather than failing the whole command', () => {
    // A stale bubble pointing at a pane that no longer parses should still
    // route to the task; losing the pane is a degradation, not an error.
    expect(command({ type: 'focusTask', taskId: 'task-1', paneId: '../../etc' })).toEqual({
      type: 'focusTask',
      taskId: 'task-1'
    })
  })
})

describe('parseProRecovery', () => {
  const empty: unknown[] = [{}, { op: '' }, null, undefined]

  it.each(empty)('defaults %j to plans', (payload) => {
    expect(parseProRecovery(payload)).toEqual({ op: 'plans' })
  })

  it('accepts the applyAll the recovery panel sends', () => {
    expect(parseProRecovery({ op: 'applyAll' })).toEqual({ op: 'applyAll' })
  })

  it.each(['apply', 'handoff', 'reprompt'])('carries the taskId for %s', (op) => {
    expect(parseProRecovery({ op, taskId: 'task-1' })).toEqual({ op, taskId: 'task-1' })
  })

  it('reads id as a synonym for taskId', () => {
    expect(parseProRecovery({ op: 'apply', id: 'task-1' })).toEqual({
      op: 'apply',
      taskId: 'task-1'
    })
  })

  const missingTask: unknown[] = [
    { op: 'apply' },
    { op: 'handoff', taskId: '   ' },
    { op: 'reprompt', taskId: '../evil' },
    { op: 'apply', taskId: 'has space' },
    { op: 'apply', taskId: 42 }
  ]

  it.each(missingTask)('refuses %j for want of a usable task id', (payload) => {
    const result = parseProRecovery(payload)
    expect(isProReject(result)).toBe(true)
    if (isProReject(result)) expect(result.code).toBe('bad-task')
  })

  it('names the op it refused', () => {
    const result = parseProRecovery({ op: 'rebuildEverything' })
    expect(isProReject(result)).toBe(true)
    if (isProReject(result)) {
      expect(result.code).toBe('bad-op')
      expect(result.error).toContain('rebuildEverything')
    }
  })
})

describe('the id gates', () => {
  const goodIds = ['a', 'task-1', 'T_2.3', 'x'.repeat(64)]
  const badIds = ['', '   ', '../evil', 'a/b', 'has space', '/abs', 'x'.repeat(65), null, 42]

  it.each(goodIds)('taskIdOf keeps %j', (id) => {
    expect(taskIdOf(id)).toBe(id)
  })

  it.each(badIds)('taskIdOf refuses %j', (id) => {
    // These end up in a filename and in a spawned argv, so the gate is the only
    // thing standing between a payload and tasks/../config.json.
    expect(taskIdOf(id)).toBe('')
  })

  it('taskIdOf refuses a colon, which paneIdOf allows', () => {
    // The two charsets differ on purpose: a task id becomes a filename, a pane
    // id is herdr's own and may carry a colon. Sharing one regex would either
    // let ':' into a path or reject every herdr pane.
    expect(taskIdOf('pane:3')).toBe('')
    expect(paneIdOf('pane:3')).toBe('pane:3')
  })

  it.each(['pane-3', 'pane:3', 'a'.repeat(120)])('paneIdOf keeps %j', (id) => {
    expect(paneIdOf(id)).toBe(id)
  })

  it.each(['../evil', 'a/b', '', null])('paneIdOf refuses %j', (id) => {
    expect(paneIdOf(id)).toBe('')
  })

  it('paneIdOf truncates an over-long id to the charset maximum', () => {
    // str() clips at 120 and the regex admits exactly 120, so a longer id is
    // shortened rather than refused. That is not a traversal risk - the
    // charset has no separators - and a shortened id simply matches no pane,
    // which focusTask already degrades to by dropping the pane. Pinned here
    // so the asymmetry with taskIdOf reads as a decision, not an oversight.
    expect(paneIdOf('a'.repeat(121))).toBe('a'.repeat(120))
    expect(taskIdOf('x'.repeat(65))).toBe('')
  })
})

/** Narrow a task parse to a request, failing the test if it was refused. */
function task(payload: unknown): ProTaskRequest {
  const result = parseProTask(payload)
  if (isProReject(result)) {
    throw new Error(`expected a request, got ${result.code}: ${result.error}`)
  }
  return result
}

function refusedTask(payload: unknown): string {
  const result = parseProTask(payload)
  if (!isProReject(result)) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`)
  return result.code
}

function companion(payload: unknown): ProCompanionRequest {
  const result = parseProCompanion(payload)
  if (isProReject(result)) {
    throw new Error(`expected a request, got ${result.code}: ${result.error}`)
  }
  return result
}

describe('the import verb', () => {
  it('accepts the keys the picker sends, with the attach box as it was ticked', () => {
    expect(task({ op: 'import', keys: ['codex:0190f'], attach: true })).toEqual({
      op: 'import',
      keys: ['codex:0190f'],
      attach: true
    })
    expect(task({ op: 'import', keys: ['claude:abc-123'] })).toEqual({
      op: 'import',
      keys: ['claude:abc-123'],
      attach: false
    })
  })

  it('folds the op, and reads the ids alias the first picker shipped', () => {
    expect(task({ op: ' IMPORT ', ids: ['codex:1'] })).toEqual({
      op: 'import',
      keys: ['codex:1'],
      attach: false
    })
  })

  it('refuses an import with nothing in it, naming the payload and not the op', () => {
    // A dead button reads as a version mismatch; this says what was missing.
    expect(refusedTask({ op: 'import', keys: [] })).toBe('bad-payload')
    expect(refusedTask({ op: 'import', keys: ['not-a-key'] })).toBe('bad-payload')
  })
})

describe('the remove and purge verbs', () => {
  it('keeps a shell by default, because a caller that did not ask is a script', () => {
    // The bench sends an explicit answer from a checkbox the human just read.
    // Everything else - the HTTP API, an older widget, a hand-rolled curl -
    // gets the non-destructive half, and the shell it leaves behind is reported
    // on the declined chip rather than closed behind their back.
    expect(task({ op: 'remove', taskId: 't1' })).toEqual({
      op: 'remove',
      taskId: 't1',
      closeShell: false
    })
    expect(task({ op: 'remove', taskId: 't1', closeShell: false })).toEqual({
      op: 'remove',
      taskId: 't1',
      closeShell: false
    })
  })

  it('closes one when asked, folded and spelled either way', () => {
    expect(task({ op: ' REMOVE ', taskId: 't1', closeShell: true })).toEqual({
      op: 'remove',
      taskId: 't1',
      closeShell: true
    })
    expect(task({ op: 'remove', id: 't1', close: true })).toEqual({
      op: 'remove',
      taskId: 't1',
      closeShell: true
    })
  })

  it('still refuses a remove with no task in it', () => {
    expect(refusedTask({ op: 'remove', closeShell: true })).toBe('bad-task')
  })

  it('accepts the purge the declined chip sends, and nothing else in it', () => {
    expect(task({ op: 'purge' })).toEqual({ op: 'purge' })
    expect(task({ op: ' PURGE ' })).toEqual({ op: 'purge' })
  })
})

describe('threadKeysOf', () => {
  it('keeps agent:id and nothing else', () => {
    expect(threadKeysOf(['codex:0190f', 'claude:9c1e', 'codex', 'a b:c', '../x:y'])).toEqual([
      'codex:0190f',
      'claude:9c1e'
    ])
  })

  it('collapses a repeat, because two rows for one conversation is two tasks', () => {
    expect(threadKeysOf(['codex:1', 'codex:1', 'codex:1'])).toEqual(['codex:1'])
  })

  it('caps the batch, and answers nothing for a value that is not a list', () => {
    const many = Array.from({ length: 500 }, (_, at) => `codex:s${at}`)
    expect(threadKeysOf(many)).toHaveLength(200)
    expect(threadKeysOf(many, 3)).toHaveLength(3)
    expect(threadKeysOf('codex:1')).toEqual([])
    expect(threadKeysOf(undefined)).toEqual([])
  })

  it('does not fold or clip the session id, which is the only handle on the chat', () => {
    const id = 'ABCdef0123456789-_.x'
    expect(threadKeysOf([`codex:${id}`])).toEqual([`codex:${id}`])
  })
})

describe('the stage verb', () => {
  it('accepts the mode switch back to her, folded like every other verb', () => {
    expect(companion({ op: 'stage' })).toEqual({ op: 'stage' })
    expect(companion({ op: ' STAGE ' })).toEqual({ op: 'stage' })
  })

  it('still refuses a verb nobody defined', () => {
    const result = parseProCompanion({ op: 'quit' })
    if (!isProReject(result)) throw new Error('expected a refusal')
    expect(result.code).toBe('bad-op')
  })
})
