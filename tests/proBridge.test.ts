/**
 * The terminal bridge (acceptance 6.6: "bridge frame parsing").
 *
 * This is the pane grid's whole relationship with herdr, and the MVP makes two
 * promises about it that a test has to hold us to. Frames are *dropped*, never
 * queued without bound, because a busy `npm test` repaints thousands of times a
 * second and a backlog replays history at the user forever. And closing the
 * bench kills nothing: herdr owns the PTY, so `close()` detaches and signals the
 * control child, never the agent running inside it.
 */
import { describe, expect, it } from 'vitest'
import {
  TerminalBridge,
  respawnBackoff,
  type BridgeOptions,
  type BridgeState
} from '../src/main/pro/herdr/terminalBridge'
import { ansiBytes } from '../src/shared/herdr'
import { FakeChild, fakeClock, fakeSpawner } from './helpers/bridge'

const BINARY = '/usr/local/bin/herdr'
const PANE = 'wA:p1'
/** What Node says about a spawn it could not perform: an errno, and no fix. */
const MISSING_BINARY = `spawn ${BINARY} ENOENT`

export interface Harness {
  bridge: TerminalBridge
  spawner: ReturnType<typeof fakeSpawner>
  clock: ReturnType<typeof fakeClock>
  child: FakeChild
  states: BridgeState[]
}

/** A bridge on a fake child and a fake clock, recording every state it emits. */
function harness(patch: Partial<BridgeOptions> = {}): Harness {
  const spawner = fakeSpawner()
  const clock = fakeClock()
  const bridge = new TerminalBridge({
    target: PANE,
    binaryPath: BINARY,
    env: { HERDR_SOCKET_PATH: '/tmp/herdr.sock' },
    cols: 100,
    rows: 30,
    respawnDelayMs: 250,
    killGraceMs: 500,
    spawn: spawner.spawn,
    timers: clock.timers,
    ...patch
  })
  const states: BridgeState[] = []
  bridge.onState((state) => states.push(state))
  bridge.open()
  return { bridge, spawner, clock, child: spawner.child(), states }
}

describe('opening the control connection', () => {
  it('spawns herdr with the pane target and the size it will render at', () => {
    const { spawner, bridge } = harness()
    expect(spawner.calls).toHaveLength(1)
    expect(spawner.calls[0].binary).toBe(BINARY)
    expect(spawner.calls[0].args).toEqual([
      'terminal',
      'session',
      'control',
      PANE,
      '--cols',
      '100',
      '--rows',
      '30'
    ])
    // The child has to reach the same server we do, or it attaches to a
    // different session and the pane shows somebody else's terminal.
    expect(spawner.calls[0].env).toEqual({ HERDR_SOCKET_PATH: '/tmp/herdr.sock' })
    expect(bridge.paneId).toBe(PANE)
    expect(bridge.size).toEqual({ cols: 100, rows: 30 })
    expect(bridge.status()).toMatchObject({ phase: 'starting', live: false, frames: 0 })
  })

  it('adds --takeover only when asked, and refuses to spawn twice', () => {
    const { spawner, bridge } = harness({ takeover: true })
    expect(spawner.calls[0].args.slice(-1)).toEqual(['--takeover'])
    // open() on a live bridge must not spawn a second control connection: two
    // clients on one pane is exactly the refusal this flag exists to resolve.
    bridge.open()
    expect(spawner.calls).toHaveLength(1)
  })

  it('honours a takeover requested at open() time', () => {
    const spawner = fakeSpawner()
    const bridge = new TerminalBridge({ target: PANE, binaryPath: BINARY, spawn: spawner.spawn })
    bridge.open(true)
    expect(spawner.calls[0].args.slice(-1)).toEqual(['--takeover'])
  })

  it('clamps a nonsense size instead of asking herdr for a zero-row terminal', () => {
    const spawner = fakeSpawner()
    const bridge = new TerminalBridge({
      target: PANE,
      binaryPath: BINARY,
      cols: 0,
      rows: -4,
      spawn: spawner.spawn
    })
    bridge.open()
    expect(bridge.size).toEqual({ cols: 1, rows: 1 })
    expect(spawner.calls[0].args.slice(4)).toEqual(['--cols', '1', '--rows', '1'])
  })

  it('defaults the size so a pane with no measurement yet still renders', () => {
    const spawner = fakeSpawner()
    const bridge = new TerminalBridge({ target: PANE, binaryPath: BINARY, spawn: spawner.spawn })
    bridge.open()
    expect(bridge.size).toEqual({ cols: 120, rows: 40 })
  })

  it('reports a spawn that throws as an error phase, not a crash', () => {
    const spawner = fakeSpawner()
    spawner.failNext('spawn herdr ENOENT')
    const bridge = new TerminalBridge({ target: PANE, binaryPath: BINARY, spawn: spawner.spawn })
    bridge.open()
    expect(bridge.status()).toMatchObject({ phase: 'error', live: false })
    expect(bridge.status().error).toContain('ENOENT')
  })

  it('does nothing before open() and stays closed after close()', () => {
    const spawner = fakeSpawner()
    const clock = fakeClock()
    const bridge = new TerminalBridge({
      target: PANE,
      binaryPath: BINARY,
      spawn: spawner.spawn,
      timers: clock.timers
    })
    expect(bridge.status().phase).toBe('idle')
    expect(bridge.take()).toEqual([])
    expect(bridge.input('ls\n'), 'no child, nothing to write to').toBe(false)
    bridge.open()
    bridge.close()
    bridge.open()
    expect(spawner.calls, 'a closed bridge stays closed').toHaveLength(1)
  })
})

describe('frames from the recorded capture', () => {
  it('parses the fixture into wire frames and never decodes the ANSI itself', () => {
    const { bridge, child } = harness()
    const count = child.playFixture('terminal-bridge.ndjson')
    expect(count).toBe(2)
    const frames = bridge.take()
    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({ paneId: PANE, seq: 1, full: true, width: 60, height: 12 })
    expect(frames[1]).toMatchObject({ paneId: PANE, seq: 2, full: false })
    // Main hands the renderer base64 and nothing else: interpreting ANSI is
    // xterm.js's job, and doing it here would put a decoder in the hot path.
    expect(frames[0].bytes).toMatch(/^[A-Za-z0-9+/=]+$/)
    const text = Buffer.from(ansiBytes(frames[0].bytes)).toString('utf8')
    expect(text).toContain('codewaifu-events')
    expect(bridge.status()).toMatchObject({ phase: 'live', live: true, frames: 2, seq: 2, dropped: 0 })
  })

  it('drains once: a second take() is empty rather than a replay', () => {
    const { bridge, child } = harness()
    child.playFixture('terminal-bridge.ndjson')
    expect(bridge.take()).toHaveLength(2)
    expect(bridge.take()).toEqual([])
  })

  it('reassembles a frame whose base64 body is split across reads', () => {
    const { bridge, child } = harness()
    const line = JSON.stringify({
      type: 'terminal.frame',
      seq: 9,
      width: 80,
      height: 24,
      full: true,
      bytes: Buffer.from('x'.repeat(4000)).toString('base64'),
      encoding: 'ansi'
    })
    child.feed(`${line}\n`, 13)
    const frames = bridge.take()
    expect(frames).toHaveLength(1)
    expect(frames[0].seq).toBe(9)
    expect(Buffer.from(ansiBytes(frames[0].bytes)).toString('utf8')).toBe('x'.repeat(4000))
  })

  it('goes live on the first frame and announces the transition once', () => {
    const { bridge, child, states } = harness()
    expect(states.map((state) => state.phase)).toEqual(['starting'])
    child.frame(1, { full: true })
    child.frame(2)
    expect(states.map((state) => state.phase)).toEqual(['starting', 'live'])
    expect(bridge.status().frames).toBe(2)
  })

  it('ignores garbage and unknown message types without losing the stream', () => {
    const { bridge, child } = harness()
    child.feed('not json\n')
    child.sendLine({ type: 'terminal.something_new', seq: 1 })
    child.sendLine({ hello: 'world' })
    child.frame(1)
    expect(bridge.take()).toHaveLength(1)
    expect(bridge.status()).toMatchObject({ phase: 'live', frames: 1 })
  })

  it("treats terminal.closed as a clean close carrying herdr's reason", () => {
    const { bridge, child } = harness()
    child.frame(1)
    child.sendLine({ type: 'terminal.closed', reason: 'pane exited' })
    expect(bridge.status()).toMatchObject({ phase: 'closed', error: 'pane exited' })
    expect(bridge.live).toBe(false)
  })

  it('unsubscribes a state listener without disturbing the others', () => {
    const { bridge, child } = harness()
    const seen: string[] = []
    const off = bridge.onState((state) => seen.push(state.phase))
    child.frame(1)
    off()
    child.frame(2)
    expect(seen).toEqual(['live'])
    expect(bridge.status().frames).toBe(2)
  })
})

describe('dropping frames when the renderer falls behind', () => {
  it('keeps the newest frames and counts the rest as dropped', () => {
    const { bridge, child } = harness({ maxFrames: 8 })
    for (let seq = 1; seq <= 12; seq += 1) child.frame(seq)
    const status = bridge.status()
    expect(status.frames, 'every frame was parsed').toBe(12)
    expect(status.dropped, 'the oldest four went overboard').toBe(4)
    expect(status.needsResync, 'a gap means the screen is partial').toBe(true)
    // Dropping the head is the whole point: the renderer gets the newest
    // picture instead of replaying twelve repaints of a finished build.
    expect(bridge.take().map((frame) => frame.seq)).toEqual([5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('never lets the bound drop below eight frames', () => {
    // A caller that asks for a two-frame queue would thrash: every busy pane
    // would resync forever. The floor keeps the smallest useful window.
    const { bridge, child } = harness({ maxFrames: 2 })
    for (let seq = 1; seq <= 12; seq += 1) child.frame(seq)
    expect(bridge.status().dropped).toBe(4)
    expect(bridge.take()).toHaveLength(8)
  })

  it('respawns after a drop so the next frame is a full repaint', () => {
    const { bridge, child, spawner, clock, states } = harness({ maxFrames: 8 })
    for (let seq = 1; seq <= 12; seq += 1) child.frame(seq)
    bridge.take()
    expect(spawner.calls).toHaveLength(1)
    clock.advance(250)
    expect(spawner.calls, 'a fresh control connection opens with a full frame').toHaveLength(2)
    expect(child.kills).toEqual(['SIGTERM'])
    expect(spawner.child(1)).not.toBe(child)
    expect(bridge.status()).toMatchObject({ phase: 'starting', respawns: 1, dropped: 4 })
    expect(bridge.take(), 'stale screen content does not survive a resync').toEqual([])
    expect(states.map((state) => state.phase)).toEqual([
      'starting',
      'live',
      'respawning',
      'starting'
    ])
  })

  it('arms one respawn no matter how many frames are dropped', () => {
    const { child, clock } = harness({ maxFrames: 8 })
    for (let seq = 1; seq <= 40; seq += 1) child.frame(seq)
    expect(clock.pending(), 'a drop storm must not queue a respawn storm').toBe(1)
  })
})

describe('backing off while the renderer stays behind', () => {
  it('doubles the resync delay, to a ceiling', () => {
    // A resync costs a full repaint, so replacing the connection on a fixed
    // interval while the consumer is still slow adds the largest frame of all
    // to a queue that is already overflowing. The ceiling is what keeps one bad
    // minute from parking a pane that would have recovered by itself.
    expect(respawnBackoff(0, 250)).toBe(250)
    expect(respawnBackoff(1, 250)).toBe(500)
    expect(respawnBackoff(2, 250)).toBe(1000)
    expect(respawnBackoff(4, 250)).toBe(4000)
    expect(respawnBackoff(40, 250), 'capped').toBe(4000)
    expect(respawnBackoff(-3, 250), 'a nonsense streak is not a longer wait').toBe(250)
    expect(respawnBackoff(2, 0), 'no delay configured, no delay invented').toBe(0)
  })

  it('waits longer for the next resync while the pane is still shedding frames', () => {
    const { bridge, spawner, clock } = harness({ maxFrames: 8 })
    for (let seq = 1; seq <= 12; seq += 1) spawner.child().frame(seq)
    bridge.take()
    clock.advance(250)
    expect(spawner.calls, 'the first resync is on the base delay').toHaveLength(2)

    // The same overload on the fresh connection. This is the shape that used to
    // run at four respawns a second for as long as the build kept printing,
    // which is precisely the hour of busy output acceptance 6.5 asks about.
    for (let seq = 1; seq <= 12; seq += 1) spawner.child(1).frame(seq)
    expect(clock.pending(), 'still one respawn armed, not one per drop').toBe(1)
    clock.advance(250)
    expect(spawner.calls, 'not yet: the streak earned a 500ms delay').toHaveLength(2)
    clock.advance(250)
    expect(spawner.calls).toHaveLength(3)
  })

  it('gives the base delay back once a resync found nothing dropped', () => {
    const { bridge, spawner, clock } = harness({ maxFrames: 8 })
    for (let seq = 1; seq <= 12; seq += 1) spawner.child().frame(seq)
    bridge.take()
    clock.advance(250)
    expect(spawner.calls).toHaveLength(2)
    spawner.child(1).frame(1, { full: true })

    // A resync with no drops behind it is a hiccup rather than a streak, so the
    // penalty is served once and the next genuine drop gets the short delay.
    bridge.requestResync()
    clock.advance(250)
    expect(spawner.calls).toHaveLength(3)
    for (let seq = 1; seq <= 12; seq += 1) spawner.child(2).frame(seq)
    clock.advance(250)
    expect(spawner.calls, 'base delay again, not the backed-off one').toHaveLength(4)
  })
})

describe('frame sequence gaps', () => {
  it('flags a backwards seq as needing a resync', () => {
    const { bridge, child } = harness()
    child.frame(5)
    expect(bridge.status().needsResync).toBe(false)
    child.frame(3)
    expect(bridge.status()).toMatchObject({ needsResync: true, seq: 5 })
  })

  it('clears the flag on a full frame, which is a complete screen by definition', () => {
    const { bridge, child } = harness()
    child.frame(5)
    child.frame(3)
    child.frame(4, { full: true })
    expect(bridge.status().needsResync).toBe(false)
  })

  it('settles after a resync instead of respawning in a loop', () => {
    // herdr numbers frames per connection, so the connection we just respawned
    // starts back at seq 1 and the counter has to go back to 0 with it. This
    // used to stop at the opening full frame, which clears the resync flag
    // whatever the numbers say: the storm started on the *second* frame of the
    // new connection, when seq 2 met a counter still sitting at 5 and read as a
    // gap. So the pane has to keep printing past the repaint to be proven calm.
    const { bridge, child, spawner, clock } = harness()
    child.frame(5)
    bridge.requestResync()
    clock.advance(250)
    expect(spawner.calls).toHaveLength(2)
    const next = spawner.child(1)
    next.frame(1, { full: true })
    // Per-connection, so this is 1 and not the 5 the dead connection reached.
    expect(bridge.status()).toMatchObject({ phase: 'live', respawns: 1, seq: 1 })
    expect(clock.pending(), 'no second resync armed').toBe(0)

    next.frame(2)
    next.frame(3)
    expect(bridge.status()).toMatchObject({ needsResync: false, respawns: 1, seq: 3 })
    expect(clock.pending(), 'ascending frames on a fresh connection are not a gap').toBe(0)
    clock.advance(10_000)
    expect(spawner.calls, 'no respawn storm').toHaveLength(2)
  })

  it('requestResync tells the renderer at once and respawns on the delay', () => {
    const { bridge, child, spawner, clock, states } = harness()
    child.frame(1)
    const before = states.length
    bridge.requestResync()
    expect(bridge.status().needsResync).toBe(true)
    // The pane has to show "resyncing" while it waits, or the user stares at a
    // frozen screen with no idea a repaint is coming.
    expect(states.length).toBe(before + 1)
    expect(states[before].needsResync).toBe(true)
    expect(spawner.calls).toHaveLength(1)
    clock.advance(249)
    expect(spawner.calls, 'the backoff is real time, not immediate').toHaveLength(1)
    clock.advance(1)
    expect(spawner.calls).toHaveLength(2)
    expect(states.slice(before + 1).map((state) => state.phase)).toEqual([
      'respawning',
      'starting'
    ])
  })
})

describe('the control child dying', () => {
  it('reports an unexplained exit as an error and respawns on a doubled backoff', () => {
    const { bridge, child, spawner, clock } = harness()
    child.frame(1)
    child.exitWith(3)
    expect(bridge.status()).toMatchObject({ phase: 'error', live: false, frames: 1 })
    expect(bridge.status().error).toBe('bridge exited (code 3, signal none)')
    clock.advance(499)
    expect(spawner.calls, 'a crash backs off twice as long as a resync').toHaveLength(1)
    clock.advance(1)
    expect(spawner.calls).toHaveLength(2)
    expect(bridge.status()).toMatchObject({ phase: 'starting', respawns: 1 })
  })

  it('names the signal when the child was killed rather than exiting', () => {
    const { bridge, child } = harness()
    child.exitWith(null, 'SIGKILL')
    expect(bridge.status().error).toBe('bridge exited (code null, signal SIGKILL)')
  })

  it('shows what herdr printed instead of a bare exit code', () => {
    const { bridge, child } = harness()
    child.say('herdr: pane wA:p1 no longer exists\n')
    child.exitWith(1)
    // The exit code is always 1; the reason the user can act on is on stderr.
    expect(bridge.status()).toMatchObject({ phase: 'error' })
    expect(bridge.status().error).toBe('herdr: pane wA:p1 no longer exists')
  })

  it('takes the terminal over exactly once when another client already holds it', () => {
    const { bridge, child, spawner, clock, states } = harness()
    child.say('herdr: this pane is already attached to another client\n')
    child.exitWith(1)
    // This is herdr's own TUI holding the pane, which is not a failure. Painting
    // an error here would tell the user their agent died when all that happened
    // is that they have the terminal open elsewhere.
    expect(bridge.status().phase, 'no error phase while retrying').not.toBe('error')
    expect(bridge.status().error).toBe('')
    expect(states.map((state) => state.phase)).toEqual(['starting'])
    clock.advance(0)
    expect(spawner.calls).toHaveLength(2)
    expect(spawner.calls[1].args.slice(-1)).toEqual(['--takeover'])
    expect(bridge.status()).toMatchObject({ phase: 'starting', respawns: 1 })
  })

  it('gives up after one takeover attempt, so a busy pane cannot loop', () => {
    const { bridge, spawner, clock } = harness()
    spawner.child(0).say('already attached')
    spawner.child(0).exitWith(1)
    clock.advance(0)
    spawner.child(1).say('still attached')
    spawner.child(1).exitWith(1)
    expect(bridge.status()).toMatchObject({ phase: 'error' })
    expect(bridge.status().error).toBe('still attached')
    expect(spawner.calls).toHaveLength(2)
  })

  it('keeps --takeover on a bridge that asked for it and does not re-escalate', () => {
    const { bridge, child, spawner, clock } = harness({ takeover: true })
    child.say('pane is busy')
    child.exitWith(1)
    expect(bridge.status().phase, 'already holding the flag: nothing to escalate to').toBe('error')
    clock.advance(500)
    expect(spawner.calls).toHaveLength(2)
    expect(spawner.calls[1].args.slice(-1), 'the retry keeps the flag it was opened with').toEqual([
      '--takeover'
    ])
  })

  it('records a child error without declaring the bridge dead', () => {
    const { bridge, child } = harness()
    child.frame(1)
    child.failWith('pipe broke')
    // node emits 'error' immediately before 'exit'. Acting on the first would
    // report a pane dead that the exit handler is about to replace anyway.
    expect(bridge.status()).toMatchObject({ phase: 'live', live: true })
    expect(bridge.status().error).toContain('pipe broke')
  })

  it('does not arm another respawn when the respawn itself cannot spawn', () => {
    const { bridge, child, spawner, clock } = harness()
    child.exitWith(1)
    spawner.failNext('spawn herdr ENOENT')
    clock.advance(500)
    expect(spawner.calls).toHaveLength(2)
    expect(spawner.children, 'the second attempt produced no child').toHaveLength(1)
    expect(bridge.status()).toMatchObject({ phase: 'error' })
    expect(bridge.status().error).toContain('ENOENT')
    expect(clock.pending(), 'a missing binary must not become a respawn storm').toBe(0)
  })

  it('reports a control process that never started instead of hanging on attaching', () => {
    const { bridge, child, states } = harness()
    // Node's shape for a spawn it could not perform: 'error', then 'close', and
    // no 'exit' at all. Listening only for 'exit' left the pane in 'starting'
    // forever - the errno was recorded and nothing ever showed it.
    child.failWith(MISSING_BINARY)
    child.closeWith(null, null)
    expect(bridge.status()).toMatchObject({ phase: 'error', live: false })
    expect(bridge.status().error).toContain('ENOENT')
    expect(
      bridge.status().error,
      'a process that never ran has no exit code to report'
    ).not.toContain('bridge exited')
    expect(
      states.some((state) => state.phase === 'error' && state.error.includes('ENOENT')),
      'the renderer is told, not just the log'
    ).toBe(true)
  })

  it('backs off while the binary stays missing and recovers the moment it appears', () => {
    const { bridge, spawner, clock } = harness()
    const fail = (index: number): void => {
      spawner.child(index).failWith(MISSING_BINARY)
      spawner.child(index).closeWith(null, null)
    }
    fail(0)
    // The retry delay is the respawn base doubled, then doubled again for each
    // failure in a row: 1s, 2s, 4s, and 8s as the ceiling.
    clock.advance(999)
    expect(spawner.calls, 'the first retry waits a second').toHaveLength(1)
    clock.advance(1)
    fail(1)
    clock.advance(2000)
    fail(2)
    clock.advance(4000)
    fail(3)
    clock.advance(7999)
    expect(spawner.calls, 'the ceiling is eight seconds, not a minute').toHaveLength(4)
    clock.advance(1)
    expect(spawner.calls).toHaveLength(5)
    // Somebody installed herdr. The same pane comes back without a reload, and
    // comes back clean: the errno goes with the phase that carried it.
    spawner.child(4).frame(1, { full: true })
    expect(bridge.status()).toMatchObject({ phase: 'live', live: true, error: '' })
  })
})

describe('commands on the way back to herdr', () => {
  it('writes a keystroke as one NDJSON line and refuses an empty write', () => {
    const { bridge, child } = harness()
    expect(bridge.input(''), 'nothing to send, nothing written').toBe(false)
    expect(child.writes).toEqual([])
    expect(bridge.input('y')).toBe(true)
    expect(child.commands()).toEqual([{ type: 'terminal.input', text: 'y' }])
  })

  it('can send raw bytes for keys that are not text', () => {
    const { bridge, child } = harness()
    const ctrlC = Buffer.from('\u0003').toString('base64')
    // Ctrl-C is not a character anybody types, and the encoder keeps text and
    // bytes mutually exclusive because the bridge rejects both at once.
    expect(bridge.send({ type: 'terminal.input', bytes: ctrlC })).toBe(true)
    expect(child.commands()).toEqual([{ type: 'terminal.input', bytes: ctrlC }])
  })

  it('says so when a resize changes nothing', () => {
    const { bridge, child } = harness()
    expect(bridge.resize(100, 30)).toBe(false)
    expect(child.writes, 'an unchanged size must not cost a round trip').toEqual([])
  })

  it('truncates and clamps a measured size before asking herdr for it', () => {
    const { bridge, child } = harness()
    expect(bridge.resize(140.9, 42.2)).toBe(true)
    expect(child.commands()).toEqual([
      { type: 'terminal.resize', cols: 140, rows: 42, cell_width_px: 0, cell_height_px: 0 }
    ])
    expect(bridge.size).toEqual({ cols: 140, rows: 42 })
    // A zero-height layout measurement is a real thing that happens mid-drag;
    // herdr would reject it and the pane would stop repainting.
    expect(bridge.resize(0, -3)).toBe(true)
    expect(child.commands()[1]).toMatchObject({ cols: 1, rows: 1 })
  })

  it('doubles as the manual redraw lever', () => {
    const { bridge, child } = harness()
    child.frame(1)
    bridge.resize(101, 30)
    expect(child.commands()).toEqual([
      { type: 'terminal.resize', cols: 101, rows: 30, cell_width_px: 0, cell_height_px: 0 }
    ])
  })

  it('defaults a scroll to three lines from the wheel and never sends zero', () => {
    const { bridge, child } = harness()
    bridge.scroll('up')
    bridge.scroll('down', 0, 'page_key')
    expect(child.commands()).toEqual([
      { type: 'terminal.scroll', direction: 'up', lines: 3, source: 'wheel' },
      { type: 'terminal.scroll', direction: 'down', lines: 1, source: 'page_key' }
    ])
  })

  it('coerces a direction or source it does not recognise', () => {
    const { bridge, child } = harness()
    bridge.scroll('sideways' as unknown as 'up', 2, 'trackpad' as unknown as 'wheel')
    // A stray value from a trackpad gesture must not reach herdr as-is: the
    // bridge validates strictly and would drop the command entirely.
    expect(child.commands()).toEqual([
      { type: 'terminal.scroll', direction: 'down', lines: 2, source: 'wheel' }
    ])
  })

  it('reports failure instead of throwing when there is no child to write to', () => {
    const spawner = fakeSpawner()
    const bridge = new TerminalBridge({ target: PANE, binaryPath: BINARY, spawn: spawner.spawn })
    expect(bridge.send({ type: 'terminal.release' })).toBe(false)
    expect(bridge.input('ls\n')).toBe(false)
    expect(bridge.scroll('up')).toBe(false)
    expect(bridge.resize(80, 24), 'the size is remembered for the next open()').toBe(false)
    expect(bridge.size).toEqual({ cols: 80, rows: 24 })
  })
})

describe('closing the bench', () => {
  it('detaches politely and kills nothing immediately', () => {
    const { bridge, child } = harness()
    child.frame(1)
    child.frame(2)
    bridge.close()
    expect(child.lastCommand()).toEqual({ type: 'terminal.release' })
    expect(child.stdinEnded, 'stdin ends so herdr sees the client leave').toBe(true)
    expect(child.kills, 'the grace period is for a child that ignores us').toEqual([])
    expect(bridge.status()).toMatchObject({ phase: 'closed', live: false })
    expect(bridge.take(), 'pending frames die with the window').toEqual([])
    expect(bridge.input('y'), 'a closed bridge writes nothing').toBe(false)
  })

  it('signals only the control child, and only after the grace period', () => {
    const { bridge, child, clock } = harness()
    bridge.close()
    clock.advance(499)
    expect(child.kills).toEqual([])
    clock.advance(1)
    // SIGTERM goes to `herdr terminal session control`, never to the pane.
    // herdr owns that PTY: closing a bench window must not kill a build.
    expect(child.kills).toEqual(['SIGTERM'])
  })

  it('is idempotent: one release, one signal', () => {
    const { bridge, child, clock } = harness()
    bridge.close()
    bridge.close()
    clock.advance(1000)
    const releases = child.commands().filter((command) => command.type === 'terminal.release')
    expect(releases).toHaveLength(1)
    expect(child.kills).toEqual(['SIGTERM'])
  })

  it('cancels a pending respawn so a closing window cannot spawn a child', () => {
    const { bridge, child, spawner, clock } = harness()
    bridge.requestResync()
    expect(clock.pending()).toBe(1)
    bridge.close()
    clock.advance(5000)
    expect(spawner.calls, 'no respawn after close').toHaveLength(1)
    expect(child.kills).toEqual(['SIGTERM'])
  })

  it('stays closed when the child exits afterwards', () => {
    const { bridge, child, clock } = harness()
    bridge.close()
    child.exitWith(0)
    clock.advance(1000)
    // The exit of a child we released on purpose is not a crash. Flipping the
    // pane to an error state here would show a failure the user just closed.
    expect(bridge.status()).toMatchObject({ phase: 'closed', error: '' })
  })

  it('closes cleanly after a spawn failure', () => {
    const spawner = fakeSpawner()
    const clock = fakeClock()
    spawner.failNext('spawn herdr ENOENT')
    const bridge = new TerminalBridge({
      target: PANE,
      binaryPath: BINARY,
      spawn: spawner.spawn,
      timers: clock.timers
    })
    bridge.open()
    expect(bridge.status().phase).toBe('error')
    bridge.close()
    expect(bridge.status()).toMatchObject({ phase: 'closed', live: false })
    expect(clock.pending(), 'nothing left scheduled').toBe(0)
  })
})
