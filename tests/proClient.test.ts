/**
 * The typed herdr client (acceptance 6.6), driven by recorded snapshots.
 *
 * Two rules this file exists to protect. One: a wrapper returns parsed shared
 * types, so nothing above it ever sees `pane_id` or `agent_status`. Two: the
 * outgoing params match herdr's own schema exactly, because herdr answers a
 * misspelled field with `invalid_request` and the bench would read that as
 * "herdr is broken" rather than "we asked wrong".
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HerdrClient } from '../src/main/pro/herdr/client'
import { HerdrError } from '../src/main/pro/herdr/socket'
import { fakeServer } from './helpers/herdrSocket'

const FIXTURES = path.join(__dirname, 'fixtures', 'herdr')

/** The `result` half of a recorded reply: what herdr actually sent. */
function recorded(name: string): Record<string, unknown> {
  const parsed = JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as {
    result: Record<string, unknown>
  }
  return parsed.result
}

/** A client whose every call is answered by a fixture, with the wire exposed. */
function client(
  result: unknown,
  options: { fail?: [string, string] } = {}
): { herdr: HerdrClient; server: ReturnType<typeof fakeServer> } {
  const server = fakeServer(options.fail ? { silent: true } : { result: result ?? { type: 'ok' } })
  const herdr = new HerdrClient({ socketPath: '/tmp/cw.sock', connect: server.connect, timeoutMs: 500 })
  if (options.fail) {
    // An error reply has to echo the request id, which only exists once the
    // client has written it, so it is queued instead of configured up front.
    const [code, message] = options.fail
    setTimeout(() => server.socket().fail(code, message), 0)
  }
  return { herdr, server }
}

describe('HerdrClient.snapshot', () => {
  it('parses a recorded multi-workspace snapshot into camelCase shared types', async () => {
    const { herdr, server } = client(recorded('snapshot-multi.json'))
    const snapshot = await herdr.snapshot()
    expect(server.socket().method()).toBe('session.snapshot')
    expect(snapshot).not.toBeNull()
    expect(snapshot?.version).toBe('0.9.0')
    expect(snapshot?.protocol).toBe(22)
    expect(snapshot?.workspaces.map((entry) => entry.workspaceId)).toEqual(['w1', 'wA', 'wB'])
    expect(snapshot?.workspaces[1]).toMatchObject({ label: 'fixture-a', paneCount: 1, tabCount: 1 })
    expect(snapshot?.panes.map((pane) => pane.paneId)).toEqual(['w1:p1', 'wA:p1', 'wB:p1'])
    expect(snapshot?.panes[1]).toMatchObject({
      workspaceId: 'wA',
      tabId: 'wA:t1',
      cwd: '/tmp/codewaifu-fixture/a',
      foregroundCwd: '/tmp/codewaifu-fixture/a',
      agentStatus: 'unknown',
      focused: false
    })
    expect(snapshot?.focusedWorkspaceId).toBe('w1')
    expect(snapshot?.focusedPaneId).toBe('w1:p1')
    // A pane with no agent still parses, with empty strings rather than holes.
    expect(snapshot?.panes[0].agent).toBe('')
    expect(snapshot?.panes[0].agentSession).toBeNull()
    expect(snapshot?.panes[0].scroll).toEqual({
      offsetFromBottom: 0,
      maxOffsetFromBottom: 0,
      viewportRows: 23
    })
  })

  it('keeps the blocked agent visible in both the pane and the agents list', async () => {
    const { herdr } = client(recorded('snapshot-agent.json'))
    const snapshot = await herdr.snapshot()
    const blocked = snapshot?.panes.find((pane) => pane.paneId === 'wA:p1')
    expect(blocked).toMatchObject({
      agent: 'codex',
      agentStatus: 'blocked',
      label: 'fixture-pane',
      focused: true
    })
    expect(snapshot?.agents).toHaveLength(1)
    expect(snapshot?.agents[0]).toMatchObject({ paneId: 'wA:p1', agent: 'codex', agentStatus: 'blocked' })
    expect(snapshot?.focusedWorkspaceId).toBe('wA')
    // The tab carries the folded status, which is what the tree renders.
    expect(snapshot?.tabs.find((tab) => tab.tabId === 'wA:t1')?.agentStatus).toBe('blocked')
  })

  it('accepts a bare snapshot object as well as the envelope', async () => {
    const envelope = recorded('snapshot-live.json')
    const { herdr } = client(envelope.snapshot)
    const snapshot = await herdr.snapshot()
    expect(snapshot?.panes.map((pane) => pane.paneId)).toEqual(['w1:p1'])
  })

  it('returns null for a reply that is not a snapshot instead of inventing one', async () => {
    const { herdr } = client({ type: 'ok' })
    expect(await herdr.snapshot()).toBeNull()
  })

  it("surfaces herdr's error as a HerdrError with the method attached", async () => {
    const { herdr } = client(null, { fail: ['internal', 'snapshot unavailable'] })
    const error = await herdr.snapshot().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HerdrError)
    expect(error).toMatchObject({ code: 'internal', method: 'session.snapshot' })
  })
})

describe('HerdrClient reads and keystrokes', () => {
  it('reads a pane without focusing it, defaulting to the detection source', async () => {
    const { herdr, server } = client({
      type: 'pane_read',
      read: {
        pane_id: 'wA:p1',
        workspace_id: 'wA',
        tab_id: 'wA:t1',
        text: 'Allow command? npm test\n[y] yes  [n] no',
        truncated: false,
        revision: 4,
        source: 'detection',
        format: 'text'
      }
    })
    const read = await herdr.readPane('wA:p1')
    // F3 hinges on these defaults: `detection` shows the prompt the way the
    // agent framed it, and no `pane.focus` anywhere means the user's terminal
    // stays exactly where they left it.
    expect(server.socket().params()).toEqual({
      pane_id: 'wA:p1',
      source: 'detection',
      lines: null,
      format: 'text',
      strip_ansi: true
    })
    expect(read?.text).toContain('Allow command?')
    expect(read).toMatchObject({ paneId: 'wA:p1', revision: 4, truncated: false })
  })

  it('passes the read options through when the caller overrides them', async () => {
    const { herdr, server } = client({ type: 'pane_read', read: { pane_id: 'wA:p1' } })
    await herdr.readPane('wA:p1', { source: 'visible', lines: 40, format: 'ansi', stripAnsi: false })
    expect(server.socket().params()).toEqual({
      pane_id: 'wA:p1',
      source: 'visible',
      lines: 40,
      format: 'ansi',
      strip_ansi: false
    })
  })

  it('returns null for a pane.read reply that names no pane', async () => {
    const { herdr } = client({ type: 'ok' })
    expect(await herdr.readPane('wA:p1')).toBeNull()
  })

  it('sends named keys, which is how approve reaches a keystroke prompt', async () => {
    const { herdr, server } = client({ type: 'ok' })
    expect(await herdr.sendKeys('wA:p1', ['y', 'enter'])).toBe(true)
    expect(server.socket().method()).toBe('pane.send_keys')
    expect(server.socket().params()).toEqual({ pane_id: 'wA:p1', keys: ['y', 'enter'] })
  })

  it('sends free text verbatim', async () => {
    const { herdr, server } = client({ type: 'ok' })
    expect(await herdr.sendText('wA:p1', 'fix the failing test\n')).toBe(true)
    expect(server.socket().params()).toEqual({ pane_id: 'wA:p1', text: 'fix the failing test\n' })
  })

  it('reports a non-ok reply as false rather than throwing', async () => {
    const keys = client({ type: 'error', message: 'pane is gone' })
    expect(await keys.herdr.sendKeys('wA:p1', ['y'])).toBe(false)
    const close = client({ type: 'error' })
    expect(await close.herdr.closePane('wA:p1')).toBe(false)
    const focus = client({ type: 'error' })
    expect(await focus.herdr.focusPane('wA:p1')).toBe(false)
  })

  it('knows that zoom answers with `pane_zoom`, not `ok`', async () => {
    const { herdr, server } = client({ type: 'pane_zoom', pane_id: 'wA:p1', zoomed: true })
    expect(await herdr.zoomPane('wA:p1')).toBe(true)
    expect(server.socket().params()).toEqual({ pane_id: 'wA:p1', mode: 'toggle' })
    const off = client({ type: 'pane_zoom' })
    await off.herdr.zoomPane('wA:p1', 'off')
    expect(off.server.socket().params()).toEqual({ pane_id: 'wA:p1', mode: 'off' })
    // An `ok` reply is not a zoom: the discriminator differs per method.
    const wrong = client({ type: 'ok' })
    expect(await wrong.herdr.zoomPane('wA:p1')).toBe(false)
  })
})

describe('HerdrClient agents', () => {
  it('starts an agent into an existing pane, with resume carried in args', async () => {
    const { herdr, server } = client({
      type: 'agent_started',
      agent: { pane_id: 'wA:p1', agent: 'codex', agent_status: 'working', state_change_seq: 3 }
    })
    const agent = await herdr.startAgent({
      name: 'ship the bench',
      kind: 'codex',
      paneId: 'wA:p1',
      args: ['resume', '01991abc']
    })
    expect(server.socket().method()).toBe('agent.start')
    expect(server.socket().params()).toEqual({
      name: 'ship the bench',
      kind: 'codex',
      pane_id: 'wA:p1',
      args: ['resume', '01991abc'],
      timeout_ms: null
    })
    expect(agent).toMatchObject({ paneId: 'wA:p1', agent: 'codex', agentStatus: 'working' })
  })

  it('returns null when agent.start names no agent', async () => {
    const { herdr } = client({ type: 'agent_started' })
    expect(await herdr.startAgent({ name: 'x', kind: 'codex', paneId: 'wA:p1' })).toBeNull()
  })

  it("maps the prompt wait into herdr's snake_case, which is how Answer reports success", async () => {
    const { herdr, server } = client({
      type: 'agent_prompted',
      agent: { pane_id: 'wA:p1', agent: 'codex', agent_status: 'working' }
    })
    const agent = await herdr.promptAgent({
      target: 'wA:p1',
      text: 'yes, run it',
      wait: { until: ['working', 'blocked', 'done'], timeoutMs: 8000 }
    })
    expect(server.socket().method()).toBe('agent.prompt')
    expect(server.socket().params()).toEqual({
      target: 'wA:p1',
      text: 'yes, run it',
      wait: { until: ['working', 'blocked', 'done'], timeout_ms: 8000 }
    })
    expect(agent?.agentStatus).toBe('working')
  })

  it('sends no wait block at all when the caller does not ask for one', async () => {
    const { herdr, server } = client({ type: 'agent_prompted', agent: { pane_id: 'wA:p1' } })
    await herdr.promptAgent({ target: 'wA:p1', text: 'go' })
    expect(server.socket().params()).toEqual({ target: 'wA:p1', text: 'go', wait: null })
  })

  it('answers agent.send_keys with the agent it unblocked', async () => {
    const { herdr, server } = client({
      type: 'agent_keys_sent',
      agent: { pane_id: 'wA:p1', agent: 'claude', agent_status: 'working' }
    })
    const agent = await herdr.agentSendKeys('wA:p1', ['enter'])
    expect(server.socket().params()).toEqual({ target: 'wA:p1', keys: ['enter'] })
    expect(agent).toMatchObject({ agent: 'claude', agentStatus: 'working' })
  })

  it('waits for a status set, defaulting the timeout to null', async () => {
    const { herdr, server } = client({
      type: 'agent_waited',
      agent: { pane_id: 'wA:p1', agent: 'codex', agent_status: 'done' }
    })
    const agent = await herdr.waitAgent({ target: 'wA:p1', until: ['done'], timeoutMs: 1500 })
    expect(server.socket().params()).toEqual({ target: 'wA:p1', until: ['done'], timeout_ms: 1500 })
    expect(agent?.agentStatus).toBe('done')
  })
})

describe('HerdrClient creation verbs', () => {
  it('creates a workspace and learns its ids from the same reply', async () => {
    const { herdr, server } = client({
      type: 'workspace_created',
      workspace: { workspace_id: 'wC', label: 'codewaifu', number: 3, pane_count: 1, tab_count: 1 },
      root_pane: { pane_id: 'wC:p1', workspace_id: 'wC', tab_id: 'wC:t1', cwd: '/srv/app' },
      tab: { tab_id: 'wC:t1', workspace_id: 'wC', number: 1 }
    })
    const created = await herdr.createWorkspace({ cwd: '/srv/app', label: 'codewaifu' })
    expect(server.socket().params()).toEqual({
      cwd: '/srv/app',
      label: 'codewaifu',
      focus: false,
      env: {}
    })
    expect(created.workspace?.workspaceId).toBe('wC')
    // `root_pane` is the field name on this reply; `pane` on others. Recovery
    // needs the pane id from whichever one herdr happened to send.
    expect(created.pane?.paneId).toBe('wC:p1')
    expect(created.tab?.tabId).toBe('wC:t1')
    expect(created.worktree).toBeNull()
  })

  it('creates a linked worktree and reports the checkout path recovery needs', async () => {
    const { herdr, server } = client({
      type: 'worktree_created',
      workspace: { workspace_id: 'wD', label: 'fix-auth' },
      pane: { pane_id: 'wD:p1', workspace_id: 'wD' },
      worktree: {
        repo_key: 'codewaifu',
        repo_name: 'codewaifu',
        repo_root: '/srv/codewaifu',
        checkout_path: '/srv/codewaifu/.worktrees/fix-auth',
        is_linked_worktree: true
      }
    })
    const created = await herdr.createWorktree({
      cwd: '/srv/codewaifu',
      branch: 'fix-auth',
      base: 'main',
      path: '/srv/codewaifu/.worktrees/fix-auth',
      label: 'fix auth',
      trustRepository: true,
      workspaceId: 'wA'
    })
    expect(server.socket().method()).toBe('worktree.create')
    expect(server.socket().params()).toEqual({
      cwd: '/srv/codewaifu',
      branch: 'fix-auth',
      base: 'main',
      path: '/srv/codewaifu/.worktrees/fix-auth',
      label: 'fix auth',
      focus: false,
      trust_repository: true,
      workspace_id: 'wA'
    })
    expect(created.worktree).toMatchObject({
      checkoutPath: '/srv/codewaifu/.worktrees/fix-auth',
      repoRoot: '/srv/codewaifu',
      isLinkedWorktree: true
    })
  })

  it('omits a worktree ref when the reply has no checkout path', async () => {
    const { herdr } = client({ type: 'worktree_created', worktree: { repo_root: '/srv/app' } })
    const created = await herdr.createWorktree({ cwd: '/srv/app' })
    expect(created.worktree).toBeNull()
  })

  it('splits a pane and falls back to the created pane when `pane` is absent', async () => {
    const { herdr, server } = client({
      type: 'pane_split',
      root_pane: { pane_id: 'wA:p2', workspace_id: 'wA', tab_id: 'wA:t1' }
    })
    const pane = await herdr.splitPane({ direction: 'down', targetPaneId: 'wA:p1', cwd: '/srv/app' })
    expect(server.socket().params()).toEqual({
      direction: 'down',
      target_pane_id: 'wA:p1',
      workspace_id: null,
      cwd: '/srv/app',
      ratio: null,
      focus: false,
      env: {}
    })
    expect(pane?.paneId).toBe('wA:p2')
  })

  it('clamps an unknown split direction to `right`', async () => {
    const { herdr, server } = client({ type: 'pane_split', pane: { pane_id: 'wA:p2' } })
    await herdr.splitPane({ direction: 'sideways' as 'right' })
    expect(server.socket().params().direction).toBe('right')
  })

  it('creates a tab inside a named workspace', async () => {
    const { herdr, server } = client({
      type: 'tab_created',
      tab: { tab_id: 'wA:t2', workspace_id: 'wA', number: 2 },
      pane: { pane_id: 'wA:p3', workspace_id: 'wA', tab_id: 'wA:t2' }
    })
    const created = await herdr.createTab({ workspaceId: 'wA', cwd: '/srv/app', label: 'tests' })
    expect(server.socket().params()).toEqual({
      workspace_id: 'wA',
      cwd: '/srv/app',
      label: 'tests',
      focus: false
    })
    expect(created.tab?.tabId).toBe('wA:t2')
    expect(created.pane?.paneId).toBe('wA:p3')
  })
})

describe('HerdrClient plumbing', () => {
  it('answers ping with version and protocol, and null for a non-pong', async () => {
    const { herdr } = client({ type: 'pong', version: '0.9.0', protocol: 22, capabilities: ['agents'] })
    expect(await herdr.ping()).toEqual({ version: '0.9.0', protocol: 22, capabilities: ['agents'] })
    const other = client({ type: 'ok' })
    expect(await other.herdr.ping()).toBeNull()
  })

  it('lists workspaces and agents, dropping entries that do not parse', async () => {
    const { herdr, server } = client({
      type: 'workspace_list',
      workspaces: [{ workspace_id: 'wA', label: 'a' }, { label: 'no id' }, null]
    })
    const workspaces = await herdr.listWorkspaces()
    expect(server.socket().method()).toBe('workspace.list')
    expect(workspaces.map((entry) => entry.workspaceId)).toEqual(['wA'])

    const agents = client({
      type: 'agent_list',
      agents: [{ pane_id: 'wA:p1', agent: 'codex', agent_status: 'blocked' }, { agent: 'no pane' }]
    })
    const list = await agents.herdr.listAgents()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ paneId: 'wA:p1', agentStatus: 'blocked' })
  })

  it('treats a missing list as empty rather than undefined', async () => {
    const { herdr } = client({ type: 'workspace_list' })
    expect(await herdr.listWorkspaces()).toEqual([])
    const agents = client({ type: 'agent_list' })
    expect(await agents.herdr.listAgents()).toEqual([])
  })

  it('renames and focuses with the exact params herdr expects', async () => {
    const rename = client({ type: 'ok' })
    expect(await rename.herdr.renameWorkspace('wA', 'the bench')).toBe(true)
    expect(rename.server.socket().params()).toEqual({ workspace_id: 'wA', label: 'the bench' })

    const paneName = client({ type: 'ok' })
    expect(await paneName.herdr.renamePane('wA:p1', null)).toBe(true)
    expect(paneName.server.socket().params()).toEqual({ pane_id: 'wA:p1', label: null })

    const focus = client({ type: 'ok' })
    expect(await focus.herdr.focusWorkspace('wA')).toBe(true)
    expect(focus.server.socket().params()).toEqual({ workspace_id: 'wA' })

    const agentFocus = client({ type: 'ok' })
    expect(await agentFocus.herdr.focusAgent('wA:p1')).toBe(true)
    expect(agentFocus.server.socket().params()).toEqual({ target: 'wA:p1' })
  })

  it('closing a workspace can take the group with it', async () => {
    const { herdr, server } = client({ type: 'ok' })
    expect(await herdr.closeWorkspace('wA', true)).toBe(true)
    expect(server.socket().params()).toEqual({ workspace_id: 'wA', close_group: true })
  })

  it('exposes call() for a method this file does not wrap yet', async () => {
    const { herdr, server } = client({ type: 'custom', value: 1 })
    expect(await herdr.call('custom.thing', { a: 1 })).toEqual({ type: 'custom', value: 1 })
    expect(server.socket().method()).toBe('custom.thing')
    expect(herdr.endpoint).toBe('/tmp/cw.sock')
  })

  it('defaults params to an empty object so herdr never sees undefined', async () => {
    const { herdr, server } = client({ type: 'ok' })
    await herdr.call('ping')
    expect(server.socket().params()).toEqual({})
  })

  it('opens one connection per call, because herdr closes it after replying', async () => {
    const { herdr, server } = client({ type: 'ok' })
    await herdr.call('ping')
    await herdr.call('ping')
    expect(server.sockets).toHaveLength(2)
    expect(server.sockets.every((socket) => socket.destroyed)).toBe(true)
  })
})
