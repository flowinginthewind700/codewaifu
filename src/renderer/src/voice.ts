// ============================================================
// The widget's voice: Web Audio playback of the WAV chunks main renders, plus
// the analyser side-chain that drives Live2D lip-sync.
//
// Ported from robotworld's `frontend/src/lib/tts/engine.ts` (the playback and
// lip-sync halves). Two differences that matter here:
//
//   * The audio is produced elsewhere. Main owns the queue and the Matcha
//     engine and streams one *session* of sentence-sized chunks per line, so
//     this module schedules rather than synthesizes.
//   * Every session has to be acknowledged. Main waits on the ack to advance
//     its queue and to decide whether a line was actually heard; silence here
//     would wedge speech forever, so every path out of a session acks exactly
//     once.
//
// Chunks are scheduled on the AudioContext timeline at a running `nextStartAt`
// rather than played on arrival: that is what makes sentence seams sample
// accurate, so a five-sentence notice sounds like one breath.
// ============================================================
import { api, CH } from './api'
import type { SpeechChunk } from '@shared/protocol'

/** Slack after the last scheduled sample before we tell main "heard". */
const ACK_SLACK_MS = 220
/** A session that never closes still has to ack, or main's queue stalls. */
const SESSION_CEILING_MS = 120_000
/**
 * How long a closed session waits for decodes that are still in flight before
 * it is called inaudible. Main pushes a sentence's WAV and the `end` marker
 * back to back, so "closed with zero decodes" is the normal state for a few
 * milliseconds and must not be read as failure. Kept well inside main's
 * watchdog (max(6s, audio + 8s)) in `voiceBridge.ts`.
 */
const DECODE_GRACE_MS = 4_000

interface Session {
  id: string
  sources: AudioBufferSourceNode[]
  /** AudioContext time at which this session's scheduled audio ends. */
  endAt: number
  decoded: number
  /** Chunks handed to `decodeAudioData` that have not settled yet. */
  pending: number
  /** Grace timer armed while `pending > 0` on a closed session; 0 when none. */
  settle: number
  /** Serial decode queue, so sentence N is never scheduled after N+1. */
  chain: Promise<void>
  /** Chunks that arrived but could not be decoded. */
  errors: number
  lastError: string
  closed: boolean
  acked: boolean
  ceiling: number
}

export class WidgetVoice {
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private levelBuffer: Float32Array<ArrayBuffer> | null = null
  private analyserUnavailable = false
  private nextStartAt = 0
  private readonly sessions = new Map<string, Session>()
  private readonly offs: Array<() => void> = []
  private attached = false

  /** Mount the player and tell main it may stream speech to us. */
  attach(): void {
    if (this.attached) return
    this.attached = true
    this.offs.push(
      api.on(CH.pushSpeech, (payload) => this.onChunk(payload as SpeechChunk)),
      api.on(CH.pushSpeechStop, () => this.stopAll())
    )
    // The context is created lazily but readiness is not: main needs to know
    // the widget can play before it commits to this path over the OS voice.
    void this.ensureContext().then((ctx) => {
      void api.invoke(CH.voiceReady, Boolean(ctx))
    })
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    for (const off of this.offs.splice(0)) {
      try {
        off()
      } catch {
        /* listener already gone */
      }
    }
    void api.invoke(CH.voiceReady, false).catch(() => undefined)
    this.stopAll()
    this.teardown()
  }

  private teardown(): void {
    const ctx = this.ctx
    this.ctx = null
    this.analyser = null
    this.levelBuffer = null
    this.analyserUnavailable = false
    this.nextStartAt = 0
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
  }

  private async ensureContext(): Promise<AudioContext | null> {
    if (this.ctx && this.ctx.state !== 'closed') {
      // Electron boots the widget without a user gesture, but a context that
      // still came up suspended (display asleep, audio device change) has to be
      // resumed or every notice plays into a paused clock.
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined)
      return this.ctx
    }
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      this.ctx = new Ctor({ latencyHint: 'interactive' })
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined)
      // A fresh context invalidates the old analyser and its clock base.
      this.analyser = null
      this.levelBuffer = null
      this.analyserUnavailable = false
      this.nextStartAt = 0
      return this.ctx
    } catch {
      this.ctx = null
      return null
    }
  }

  private onChunk(chunk: SpeechChunk | null): void {
    if (!chunk || typeof chunk.id !== 'string' || !chunk.id) return
    if (chunk.end && !chunk.wav) {
      this.closeSession(chunk.id)
      return
    }
    if (!chunk.wav) return
    this.begin(chunk)
  }

  /**
   * Register the chunk *synchronously*, then decode it. The ordering matters:
   * if the session only came into existence after an `await`, the `end` marker
   * could close a session that had never been touched and the line would be
   * reported inaudible while its audio was still on the way.
   */
  private begin(chunk: SpeechChunk): void {
    const session = this.touch(chunk.id)
    session.pending += 1
    session.chain = session.chain
      .then(() => this.decode(session, chunk))
      .catch(() => undefined)
  }

  private async decode(session: Session, chunk: SpeechChunk): Promise<void> {
    const wav = chunk.wav
    try {
      const ctx = await this.ensureContext()
      if (!ctx) {
        session.errors += 1
        session.lastError = 'no audio context'
        return
      }
      if (session.acked || !wav) return
      // decodeAudioData detaches its input; hand it a private copy.
      const buffer = await ctx.decodeAudioData(wav.slice().buffer)
      if (session.acked) return
      this.scheduleAt(ctx, session, buffer)
    } catch (error) {
      // One undecodable chunk in a line that otherwise played must not trigger a
      // replay from the top. Only a line where *nothing* decoded is inaudible,
      // and that is the case main has to hear about so it can use the OS voice.
      session.errors += 1
      session.lastError = String(error)
    } finally {
      session.pending = Math.max(0, session.pending - 1)
      if (session.closed && !session.acked) this.armAck(session)
    }
  }

  private scheduleAt(ctx: AudioContext, session: Session, buffer: AudioBuffer): void {
    if (this.nextStartAt < ctx.currentTime) this.nextStartAt = ctx.currentTime
    const startAt = this.nextStartAt
    const source = ctx.createBufferSource()
    source.buffer = buffer
    this.connect(ctx, source)
    source.start(startAt)
    this.nextStartAt = startAt + buffer.duration
    session.endAt = Math.max(session.endAt, this.nextStartAt)
    session.decoded += 1
    session.sources.push(source)
    if (session.closed) this.armAck(session)
  }

  /** Speakers, plus a side-chain tap for the mouth. Never in series. */
  private connect(ctx: AudioContext, source: AudioScheduledSourceNode): void {
    source.connect(ctx.destination)
    try {
      const analyser = this.tapForLipSync(ctx)
      if (analyser) source.connect(analyser)
    } catch {
      // A missing analyser costs lip-sync, never audio.
    }
  }

  private tapForLipSync(ctx: AudioContext): AnalyserNode | null {
    if (this.analyser) return this.analyser
    if (this.analyserUnavailable) return null
    if (typeof ctx.createAnalyser !== 'function') {
      this.analyserUnavailable = true
      return null
    }
    try {
      const analyser = ctx.createAnalyser()
      if (!analyser) {
        this.analyserUnavailable = true
        return null
      }
      // 1024 points at 16kHz is ~64ms a frame: fast enough for syllables,
      // coarse enough that the mouth does not jitter into noise.
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.6
      this.analyser = analyser
      this.levelBuffer = new Float32Array(new ArrayBuffer(analyser.fftSize * 4))
      return analyser
    } catch {
      this.analyserUnavailable = true
      return null
    }
  }

  /**
   * RMS of what is audible right now, 0..~0.4. Read once per frame by the
   * Live2D host. Zero whenever nothing is scheduled: the analyser keeps the last
   * waveform it saw, and a stale waveform means a mouth that never closes.
   */
  getLevel(): number {
    const ctx = this.ctx
    const analyser = this.analyser
    const buffer = this.levelBuffer
    if (!ctx || !analyser || !buffer) return 0
    if (ctx.state !== 'running') return 0
    if (!this.playing) return 0
    try {
      analyser.getFloatTimeDomainData(buffer)
    } catch {
      return 0
    }
    let sum = 0
    for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i]
    return Math.sqrt(sum / buffer.length)
  }

  /** True while scheduled audio has not run out yet. */
  get playing(): boolean {
    const ctx = this.ctx
    if (!ctx || ctx.state !== 'running') return false
    for (const session of this.sessions.values()) {
      if (session.endAt > ctx.currentTime) return true
    }
    return false
  }

  private touch(id: string): Session {
    const existing = this.sessions.get(id)
    if (existing) return existing
    const session: Session = {
      id,
      sources: [],
      endAt: 0,
      decoded: 0,
      pending: 0,
      settle: 0,
      chain: Promise.resolve(),
      errors: 0,
      lastError: '',
      closed: false,
      acked: false,
      ceiling: window.setTimeout(() => this.fail(id, 'session ceiling'), SESSION_CEILING_MS)
    }
    this.sessions.set(id, session)
    return session
  }

  /** No more audio is coming for this line. */
  private closeSession(id: string): void {
    // `touch`, not `get`: an end marker for a session this player never saw
    // still has to be answered, or main waits out the whole watchdog before it
    // may fall back to the OS voice.
    const session = this.touch(id)
    if (session.closed) return
    session.closed = true
    this.armAck(session)
  }

  /**
   * Ack once the last scheduled sample has been heard. `onended` is the precise
   * signal; the timer is the backstop for a source that never fires it (context
   * closed underneath us), because a missing ack costs more than an early one.
   */
  private armAck(session: Session): void {
    if (session.acked) return
    if (session.pending > 0) {
      this.armSettle(session)
      return
    }
    if (session.decoded === 0) {
      this.fail(session.id, session.lastError || 'nothing decoded')
      return
    }
    const last = session.sources[session.sources.length - 1]
    const settle = (): void => this.ack(session.id, true)
    if (last) last.onended = settle
    const ctx = this.ctx
    const remaining = ctx ? Math.max(0, (session.endAt - ctx.currentTime) * 1000) : 0
    window.setTimeout(settle, remaining + ACK_SLACK_MS)
  }

  /** One grace timer per session; when it fires, whatever decoded is final. */
  private armSettle(session: Session): void {
    if (session.settle) return
    session.settle = window.setTimeout(() => {
      session.settle = 0
      session.pending = 0
      if (session.acked) return
      this.armAck(session)
    }, DECODE_GRACE_MS)
  }

  private ack(id: string, ok: boolean, error?: string): void {
    const session = this.sessions.get(id)
    if (!session || session.acked) return
    session.acked = true
    window.clearTimeout(session.ceiling)
    if (session.settle) {
      window.clearTimeout(session.settle)
      session.settle = 0
    }
    this.sessions.delete(id)
    void api.invoke(CH.speechAck, { id, ok, error }).catch(() => undefined)
  }

  private fail(id: string, error: string): void {
    const session = this.sessions.get(id)
    if (session) {
      for (const source of session.sources) {
        try {
          source.onended = null
          source.stop()
        } catch {
          /* never started */
        }
      }
    }
    this.ack(id, false, error)
  }

  /** Main dropped the queue (mute, hide, quit): cut the sound, ack nothing. */
  private stopAll(): void {
    for (const session of this.sessions.values()) {
      for (const source of session.sources) {
        try {
          source.onended = null
          source.stop()
        } catch {
          /* already finished */
        }
      }
      session.acked = true
      window.clearTimeout(session.ceiling)
      if (session.settle) {
        window.clearTimeout(session.settle)
        session.settle = 0
      }
    }
    this.sessions.clear()
    this.nextStartAt = 0
  }
}

/** One player per widget. Exported so the avatar can read its level. */
export const widgetVoice = new WidgetVoice()
