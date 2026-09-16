/**
 * The connect palette against a real machine (known gap: everything else in the
 * ssh suites is injected).
 *
 * `tests/ssh.test.ts`, `tests/proSsh.test.ts` and `tests/proIpcSsh.test.ts`
 * cover the rules - what a pasted command keeps, what a metacharacter refuses,
 * which status a probe exit code maps to. What none of them can cover is
 * whether the line we build actually gets a human into a shell. That needs a
 * box, a key and a network, so it lives here and it is opt-in:
 *
 *   CODEWAIFU_SSH_TARGET='ssh wanlian@172.18.29.206 -p 2222' \
 *     npx vitest run --config vitest.e2e.config.ts tests/e2e/sshLive.e2e.ts
 *
 * The target is the *whole pasted command*, on purpose: the thing most likely
 * to break between a README and a working pane is the parser, so the live run
 * exercises it too rather than taking a pre-split host/port.
 *
 * Skipped when the env var is absent, which is the default - CI has no box to
 * reach, and a test that fails because nobody set an environment variable is a
 * test nobody runs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SshService } from '../../src/main/pro/ssh'
import { parseTarget } from '../../src/shared/ssh'

const target = (process.env.CODEWAIFU_SSH_TARGET ?? '').trim()
/** Set to any status but `ok` to assert a box is *not* passwordless yet. */
const want = (process.env.CODEWAIFU_SSH_EXPECT ?? 'ok').trim()

const tmpHome = target ? fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ssh-live-')) : ''

afterAll(() => {
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe.skipIf(!target)('live ssh', () => {
  /**
   * Reads are the developer's real `~/.ssh` (that is the point: their key, their
   * config aliases). The one file we ever write - `machines.json` - is redirected
   * into a temp dir, so a live run cannot pin a machine into the real app state.
   */
  const ssh = new SshService({
    home: os.homedir(),
    file: path.join(tmpHome, 'machines.json'),
    platform: process.platform === 'win32' ? 'windows' : 'posix'
  })

  it('parses the pasted command into the box it names', () => {
    const machine = parseTarget(target)
    expect(machine, `parseTarget refused: ${target}`).not.toBeNull()
    expect(machine!.host).toMatch(/\S/)
    // The connect line has to survive the round trip: parse -> line -> parse.
    const line = ssh.connectLine(machine!)
    expect(line.startsWith('ssh ')).toBe(true)
    const again = parseTarget(line)
    expect(again).not.toBeNull()
    expect(again!.host).toBe(machine!.host)
    expect(again!.port).toBe(machine!.port)
  })

  it('reports the real answer to "can I get in without a password?"', async () => {
    const machine = parseTarget(target)!
    const probe = await ssh.probe(machine)
    // Printed either way: on a failure this is the only evidence of what the
    // box actually said, and "expected ok, got unreachable" alone sends you
    // looking in the wrong place.
    console.log(`probe ${machine.host}:${machine.port} -> ${probe.status} ${probe.detail}`)
    expect(probe.status).toBe(want)
  }, 60_000)

  it('offers a setup plan only when this machine has no key to offer', () => {
    const machine = parseTarget(target)!
    const keys = ssh.keys()
    const plan = ssh.setup(machine)
    expect(plan.length).toBeGreaterThan(0)
    const createsKey = plan.some((l) => l.includes('ssh-keygen'))
    // keygen is prepended exactly when there is nothing to copy.
    expect(createsKey).toBe(keys.length === 0)
    expect(plan.some((l) => l.includes('ssh-copy-id') || l.includes('authorized_keys'))).toBe(true)
  })
})
