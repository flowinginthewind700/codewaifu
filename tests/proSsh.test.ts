/**
 * The SSH service: roster merge, pinning, probing and key discovery.
 *
 * Every impure edge is injected - disk, the child runner, herdr's machine list -
 * so these tests assert the *policy* (what wins a dedupe, what a probe status
 * means, how an id is assigned) without a real `~/.ssh` or a real `ssh`.
 */
import { describe, expect, it } from 'vitest'
import { SshService, type MachinesFile, type SshDeps, type SshRunResult } from '../src/main/pro/ssh'
import type { SshMachine } from '../src/shared/ssh'

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
