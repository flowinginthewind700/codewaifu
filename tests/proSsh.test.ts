/**
 * The SSH service: roster merge, pinning, probing and key discovery.
 *
 * Every impure edge is injected - disk, the child runner, herdr's machine list -
 * so these tests assert the *policy* (what wins a dedupe, what a probe status
 * means, how an id is assigned) without a real `~/.ssh` or a real `ssh`.
 */
import { describe, expect, it } from 'vitest'
import { SshService, type MachinesFile, type SshDeps, type SshRunResult } from '../src/main/pro/ssh'
import { machineKey, type SshMachine } from '../src/shared/ssh'

const HOME = '/home/tester'

interface FakeWorld {
  machines: MachinesFile | null
  config: string
  sshDir: string[]
  runResult: SshRunResult
  runCalls: Array<{ cmd: string; args: readonly string[] }>
  writes: number
}

function world(overrides: Partial<FakeWorld> = {}): FakeWorld {
  return {
    machines: null,
    config: '',
    sshDir: [],
    runResult: { code: 0, stdout: '', stderr: '', timedOut: false },
    runCalls: [],
    writes: 0,
    ...overrides
  }
}

function service(w: FakeWorld, extra: Partial<SshDeps> = {}): SshService {
  return new SshService({
    home: HOME,
    now: () => 1000,
    newId: () => 'mTEST',
    read: () => w.machines,
    write: (_file, value) => {
      w.machines = value as MachinesFile
      w.writes += 1
      return true
    },
    readFile: (file) => (file.endsWith('config') ? w.config : null),
    listDir: () => w.sshDir,
    run: (cmd, args) => {
      w.runCalls.push({ cmd, args })
      return Promise.resolve(w.runResult)
    },
    ...extra
  })
}

const CONFIG = ['Host prod', '  HostName 10.0.0.5', '  User deploy', '  Port 2200'].join('\n')

describe('roster', () => {
  it('merges saved, config and herdr, ranking saved first', async () => {
    const w = world({ config: CONFIG })
    const herdr: SshMachine = {
      id: 'herdr:1',
      label: 'herdr-box',
      host: '10.9.9.9',
      port: 0,
      user: '',
      identityFile: '',
      proxyJump: '',
      source: 'herdr',
      alias: ''
    }
    const svc = service(w, { herdrMachines: () => Promise.resolve([herdr]) })
    svc.save({ host: '1.2.3.4', user: 'alice', label: 'pinned' })
    const roster = await svc.roster()
    expect(roster.map((m) => m.source)).toEqual(['saved', 'config', 'herdr'])
    expect(roster[0].label).toBe('pinned')
    expect(roster[1].alias).toBe('prod')
  })

  it('filters by query across label, host, user and alias', async () => {
    const w = world({ config: CONFIG })
    const svc = service(w)
    svc.save({ host: 'staging.internal', user: 'bob' })
    const hits = await svc.roster('deploy')
    expect(hits.map((m) => m.alias)).toEqual(['prod'])
  })

  it('reads an empty roster without a config or saved file', async () => {
    expect(await service(world()).roster()).toEqual([])
  })
})

describe('save / remove', () => {
  it('assigns a durable id and persists', () => {
    const w = world()
    const svc = service(w)
    const saved = svc.save({ host: 'box', user: 'alice', port: 2222 })
    expect(saved?.id).toBe('mTEST')
    expect(w.writes).toBe(1)
    expect(svc.saved()).toHaveLength(1)
  })

  it('parses a free-form target string', () => {
    const svc = service(world())
    const saved = svc.save({ target: 'alice@box:2222' })
    expect(saved?.host).toBe('box')
    expect(saved?.user).toBe('alice')
    expect(saved?.port).toBe(2222)
  })

  it('refuses to save something with no host', () => {
    expect(service(world()).save({ host: '' })).toBeNull()
    expect(service(world()).save({ target: 'not a target' })).toBeNull()
  })

  it('upserts by id rather than duplicating', () => {
    const w = world()
    const svc = service(w)
    svc.save({ id: 'm1', host: 'a' })
    svc.save({ id: 'm1', host: 'b' })
    expect(svc.saved()).toHaveLength(1)
    expect(svc.saved()[0].host).toBe('b')
  })

  it('removes a pinned machine and reports a miss', () => {
    const svc = service(world())
    const saved = svc.save({ host: 'box' })!
    expect(svc.remove(saved.id)).toBe(true)
    expect(svc.saved()).toHaveLength(0)
    expect(svc.remove('nope')).toBe(false)
  })
})

describe('probe', () => {
  it('classifies a clean exit as ok and runs ssh in batch mode', async () => {
    const w = world({ runResult: { code: 0, stdout: '', stderr: '', timedOut: false } })
    const svc = service(w)
    const result = await svc.probe({ ...svc.save({ host: 'box', user: 'alice' })! })
    expect(result.status).toBe('ok')
    expect(w.runCalls[0].cmd).toBe('ssh')
    expect(w.runCalls[0].args.join(' ')).toContain('BatchMode=yes')
  })

  it('maps permission denied to auth', async () => {
    const w = world({ runResult: { code: 255, stdout: '', stderr: 'Permission denied (publickey).', timedOut: false } })
    const svc = service(w)
    const result = await svc.probe(svc.save({ host: 'box' })!)
    expect(result.status).toBe('auth')
    expect(result.detail).toBe('Permission denied (publickey).')
  })

  it('reports a missing ssh binary as no-ssh', async () => {
    const w = world({ runResult: { code: 127, stdout: '', stderr: 'ssh: command not found', timedOut: false } })
    const result = await service(w).probe({
      id: 'x', label: 'x', host: 'box', port: 0, user: '', identityFile: '', proxyJump: '', source: 'saved', alias: ''
    })
    expect(result.status).toBe('no-ssh')
  })

  it('never throws when the runner rejects', async () => {
    const svc = service(world(), { run: () => Promise.reject(new Error('boom')) })
    const result = await svc.probe({
      id: 'x', label: 'x', host: 'box', port: 0, user: '', identityFile: '', proxyJump: '', source: 'saved', alias: ''
    })
    expect(result.status).toBe('error')
  })
})

describe('keys', () => {
  it('lists public keys, conventional ones first', () => {
    const w = world({ sshDir: ['known_hosts', 'id_rsa.pub', 'config', 'id_ed25519.pub', 'weird.pub'] })
    const svc = service(w)
    expect(svc.keys().map((k) => k.split('/').pop())).toEqual(['id_ed25519.pub', 'id_rsa.pub', 'weird.pub'])
    expect(svc.defaultKey().endsWith('id_ed25519.pub')).toBe(true)
  })

  it('is empty with no home', () => {
    expect(new SshService({ home: '' }).keys()).toEqual([])
  })

  /**
   * The separator comes from the platform the service was told about, not the
   * one the test happens to run on. Built on `node:path`, a faked posix world
   * answered `/home/tester/.ssh/...` on Linux and `\home\tester\.ssh\...` on a
   * Windows runner - so the same case passed in one CI job and failed in
   * another, and the Windows answer was a key path nothing could open.
   *
   * Two keys, not one: ranking reduces a path to its filename, and a basename
   * that only splits on the host separator leaves a Windows path whole, both
   * keys unranked, and the order they were listed in.
   */
  it('joins and ranks with the declared platform', () => {
    const posix = world({ sshDir: ['id_rsa.pub', 'id_ed25519.pub'] })
    expect(service(posix, { platform: 'posix' }).keys()).toEqual([
      `${HOME}/.ssh/id_ed25519.pub`,
      `${HOME}/.ssh/id_rsa.pub`
    ])

    const windows = world({ sshDir: ['id_rsa.pub', 'id_ed25519.pub'] })
    expect(service(windows, { platform: 'windows', home: 'C:\\Users\\t' }).keys()).toEqual([
      'C:\\Users\\t\\.ssh\\id_ed25519.pub',
      'C:\\Users\\t\\.ssh\\id_rsa.pub'
    ])
  })

  it('reads the config from the declared platform too', () => {
    const seen: string[] = []
    const w = world({ config: 'Host prod\n  HostName 10.0.0.5\n' })
    const svc = service(w, {
      platform: 'windows',
      home: 'C:\\Users\\t',
      sshConfigPath: undefined,
      readFile: (file) => {
        seen.push(file)
        return file.endsWith('config') ? w.config : null
      }
    })
    expect(svc.config().map((m) => m.alias)).toEqual(['prod'])
    expect(seen).toEqual(['C:\\Users\\t\\.ssh\\config'])
  })
})

describe('setup + connect lines', () => {
  it('builds an ssh-copy-id line on posix using the default key', () => {
    const w = world({ sshDir: ['id_ed25519.pub'] })
    const svc = service(w)
    const line = svc.setup(svc.save({ host: 'box', user: 'alice' })!)[0]
    expect(line).toContain('ssh-copy-id')
    expect(line).toContain('-i /home/tester/.ssh/id_ed25519.pub')
    expect(line).toContain('alice@box')
  })

  it('builds the interactive connect line', () => {
    const svc = service(world())
    expect(svc.connectLine(svc.save({ host: 'box', user: 'alice', port: 2222 })!)).toBe('ssh -p 2222 alice@box')
  })
})

/* The two verbs that let a human fix a wrong row. Both have a boundary worth
   pinning down: `~/.ssh/config` is read and never written, and a hide has to
   survive every other write to the same file. */

/** The `prod` alias from CONFIG, as the roster sees it. */
function prodAlias(svc: SshService): SshMachine {
  const alias = svc.config().find((machine) => machine.alias === 'prod')
  if (!alias) throw new Error('the fixture config has no prod alias')
  return alias
}

describe('edit', () => {
  it('upserts a saved machine instead of leaving the old row beside the new', () => {
    const svc = service(world())
    const saved = svc.save({ host: 'box', user: 'alice', label: 'old' })!
    const next = svc.edit(saved, { label: 'new', port: 2222 })!
    expect(svc.saved()).toHaveLength(1)
    expect(next.id).toBe(saved.id)
    expect(next.label).toBe('new')
    expect(next.port).toBe(2222)
  })

  it('forks a config alias into our roster and hides the original', async () => {
    const w = world({ config: CONFIG })
    const svc = service(w)
    const alias = prodAlias(svc)
    const next = svc.edit(alias, { port: 22 })!
    expect(next.source).toBe('saved')
    // The new port is only reachable because the alias went with it.
    expect(next.alias).toBe('')
    expect(svc.connectLine(next)).toBe('ssh -p 22 deploy@10.0.0.5')
    // Their file is untouched, and the palette shows one row for the box
    // rather than the fork sitting next to the thing it forked from.
    expect(w.config).toBe(CONFIG)
    expect(svc.hidden()).toEqual([machineKey(alias).toLowerCase()])
    const roster = await svc.roster()
    expect(roster.map((machine) => machine.id)).toEqual([next.id])
  })

  it('renames a config alias without forking its identity away', async () => {
    const w = world({ config: CONFIG })
    const svc = service(w)
    const next = svc.edit(prodAlias(svc), { label: 'production' })!
    // A label is not a connection field, so the alias stays and `ssh prod` is
    // still what gets dialled - the config block remains the truth.
    expect(next.alias).toBe('prod')
    expect(svc.connectLine(next)).toBe('ssh prod')
    expect(await svc.roster()).toHaveLength(1)
  })

  it('refuses an edit that would leave nothing to dial', () => {
    const svc = service(world())
    const saved = svc.save({ host: 'box' })!
    expect(svc.edit(saved, { host: '', alias: '' })).toBeNull()
    expect(svc.saved()).toEqual([saved])
  })
})

describe('hide / unhide', () => {
  it('deletes a machine we own, and hides nothing for it', () => {
    const svc = service(world())
    const saved = svc.save({ host: 'box' })!
    expect(svc.hide(saved)).toBe(true)
    expect(svc.saved()).toHaveLength(0)
    expect(svc.hidden()).toEqual([])
  })

  it('records a config row instead of touching the file, and says so twice', async () => {
    const w = world({ config: CONFIG })
    const svc = service(w)
    const alias = prodAlias(svc)
    expect(svc.hide(alias)).toBe(true)
    expect(await svc.roster()).toEqual([])
    expect(w.config).toBe(CONFIG)
    // Already hidden is not a second change, and claiming one would be a lie.
    expect(svc.hide(alias)).toBe(false)
  })

  it('brings a hidden row back, and reports a key it never held', async () => {
    const w = world({ config: CONFIG })
    const svc = service(w)
    const alias = prodAlias(svc)
    svc.hide(alias)
    expect(svc.unhide(machineKey(alias))).toBe(true)
    expect(await svc.roster()).toHaveLength(1)
    expect(svc.unhide('alias:never-hidden')).toBe(false)
    expect(svc.unhide('  ')).toBe(false)
  })

  it('lets a later pin win over an earlier hide', async () => {
    const w = world({ config: CONFIG })
    const svc = service(w)
    const alias = prodAlias(svc)
    svc.hide(alias)
    // Pinning the same box afterwards is an explicit decision made later;
    // leaving the key hidden would make the pin button look broken.
    svc.save({ host: '10.0.0.5', user: 'deploy', alias: 'prod', label: 'prod' })
    expect(svc.hidden()).toEqual([])
    expect(await svc.roster()).toHaveLength(1)
  })

  it('keeps the hidden list through an unrelated remove', () => {
    const w = world({ config: CONFIG })
    const svc = service(w)
    const alias = prodAlias(svc)
    svc.hide(alias)
    const saved = svc.save({ host: 'other' })!
    expect(svc.remove(saved.id)).toBe(true)
    expect(svc.hidden()).toEqual([machineKey(alias).toLowerCase()])
  })

  it('reports the config it reads, so the palette can offer to open it', () => {
    expect(service(world()).configFile()).toMatch(/\.ssh[/\\]config$/)
    expect(service(world({})).homeDir()).toBe(HOME)
  })
})

describe('hiddenMachines', () => {
  it('resolves a hidden key back to the row that reported it', async () => {
    const w = world({ config: CONFIG })
    const svc = service(w)
    const alias = prodAlias(svc)
    svc.hide(alias)
    const rows = await svc.hiddenMachines()
    expect(rows).toHaveLength(1)
    expect(rows[0].stale).toBe(false)
    expect(rows[0].key).toBe(machineKey(alias).toLowerCase())
    expect(rows[0].machine.host).toBe('10.0.0.5')
  })

  it('keeps an identity no source reports any more, so it can still be dropped', async () => {
    const svc = service(
      world({ machines: { version: 1, updatedAt: 1000, machines: [], hidden: ['alias:gone'] } })
    )
    const rows = await svc.hiddenMachines()
    expect(rows).toHaveLength(1)
    expect(rows[0].stale).toBe(true)
    // The key travels with the row rather than being recomputed from it: a
    // placeholder would produce a different key and be stuck in the list.
    expect(rows[0].key).toBe('alias:gone')
    expect(svc.unhide(rows[0].key)).toBe(true)
    expect(await svc.hiddenMachines()).toEqual([])
  })

  it('folds a herdr report in too, and is empty when nothing was hidden', async () => {
    const herdr: SshMachine = {
      id: 'herdr:1',
      label: 'herdr-box',
      host: '10.9.9.9',
      port: 0,
      user: '',
      identityFile: '',
      proxyJump: '',
      source: 'herdr',
      alias: ''
    }
    const svc = service(world(), { herdrMachines: () => Promise.resolve([herdr]) })
    expect(await svc.hiddenMachines()).toEqual([])
    svc.hide(herdr)
    const rows = await svc.hiddenMachines()
    expect(rows.map((row) => row.machine.label)).toEqual(['herdr-box'])
    expect(rows[0].stale).toBe(false)
  })
})
