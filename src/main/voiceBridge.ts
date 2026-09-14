import crypto from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipcChannels'
import type { SpeechChunk } from '../shared/protocol'
import { log } from './log'

// ============================================================
// Main-process half of the widget's voice.
//
// The renderer owns the audible path, because that is the only place a Web
// Audio AnalyserNode can sit — and the analyser's RMS is what drives Live2D
// lip-sync. Main still owns the queue, so "what is being said next" has one
// source of truth.
//
// Speech is streamed: Matcha renders sentence by sentence (~85ms each), so a
// five-sentence notice starts playing before the fifth sentence exists. That
// means one line is a *session* of chunks sharing an id, not a single message,
// and the watchdog has to be sized from the audio pushed so far rather than
// from a duration known up front.
//
// Every failure mode here is a reject, and the Speaker turns a reject into the
// OS-voice path. Speech must never depend on this bridge working.
// ============================================================

/** Slack on top of the audio pushed so far before we call the renderer stuck. */
const ACK_SLACK_MS = 8000
/** Floor, so a line whose duration we could not parse still gets a watchdog. */
const ACK_MIN_MS = 6000
/** Ceiling: a session that never closes must not hold the queue forever. */
const SESSION_MAX_MS = 120_000

/**
 * How one line ended. The distinction matters: `failed` means nothing was
 * heard (decode error, suspended context) so the Speaker may retry through the
 * OS voice, while `timeout` means the renderer went quiet mid-line and
 * replaying would make her say the same sentences twice.
 */
export type PlayOutcome = 'heard' | 'failed' | 'timeout'

export interface VoiceSession {
  readonly id: string
  /** Hand one rendered WAV to the widget. Safe to call from a loop. */
  push(wav: Uint8Array, ms: number): void
  /** No more audio is coming; resolves `done` when playback finishes. */
  close(): void
  /** Cut the line short (mute, queue cleared, app quitting). */
  abort(): void
  /** Settles once the line was heard, failed, or outlived its watchdog. */
  readonly done: Promise<PlayOutcome>
}

interface SessionState {
  chunks: number
  audioMs: number
  closed: boolean
  settled: boolean
  watchdog: NodeJS.Timeout | null
  ceiling: NodeJS.Timeout
  resolve: (outcome: PlayOutcome, detail?: string) => void
}

export class RendererVoice {
  private readonly sessions = new Map<string, SessionState>()
  private ready = false
  /** Callers parked in `waitUntilAvailable`, woken by `setReady(true)`. */
  private waiters: Array<() => void> = []

  constructor(private readonly getWin: () => BrowserWindow | null) {}

  /** The renderer says its audio player exists (or is going away). */
  setReady(on: boolean): void {
    this.ready = on
    if (on) {
      const waiters = this.waiters
      this.waiters = []
      for (const wake of waiters) wake()
      return
    }
    this.drain('failed', 'renderer voice went away')
  }

  available(): boolean {
    if (!this.ready) return false
    const win = this.getWin()
    if (!win || win.isDestroyed()) return false
    return !win.webContents.isDestroyed()
  }

  /**
   * Settle once the widget can actually play audio, or once `ms` has passed.
   * The renderer attaches its Web Audio player a beat after the window paints
   * (and Matcha a beat after that), and a line landing in that gap used to be
   * handed straight to the OS voice — which is how a fresh install ended up
   * greeting the user in a voice it never uses again.
   */
  waitUntilAvailable(ms: number): Promise<boolean> {
    if (this.available()) return Promise.resolve(true)
    const budget = Math.max(0, Math.round(ms) || 0)
    if (budget === 0) return Promise.resolve(this.available())
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const at = this.waiters.indexOf(wake)
        if (at >= 0) this.waiters.splice(at, 1)
        resolve(this.available())
      }
      const wake = (): void => finish()
      const timer = setTimeout(finish, budget)
      timer.unref?.()
      this.waiters.push(wake)
    })
  }

  /** Open one line of speech, or null when the widget cannot play right now. */
  session(): VoiceSession | null {
    if (!this.available()) return null
    const win = this.getWin()
    if (!win) return null
    const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`

    let settle!: (outcome: PlayOutcome, detail?: string) => void
    const done = new Promise<PlayOutcome>((resolve) => {
      settle = (outcome, detail) => {
        const state = this.sessions.get(id)
        if (!state || state.settled) return
        state.settled = true
        if (state.watchdog) clearTimeout(state.watchdog)
        clearTimeout(state.ceiling)
        this.sessions.delete(id)
        if (detail && outcome !== 'heard') log('warn', `renderer playback ${outcome}`, detail)
        resolve(outcome)
      }
    })

    const ceiling = setTimeout(() => settle('timeout', 'session never closed'), SESSION_MAX_MS)
    ceiling.unref?.()
    this.sessions.set(id, {
      chunks: 0,
      audioMs: 0,
      closed: false,
      settled: false,
      watchdog: null,
      ceiling,
      resolve: settle
    })

    const send = (chunk: SpeechChunk): void => {
      try {
        win.webContents.send(IPC.pushSpeech, chunk)
      } catch (error) {
        settle('failed', String(error))
      }
    }

    return {
      id,
      push: (wav, ms) => {
        const state = this.sessions.get(id)
        if (!state || state.settled || state.closed) return
        state.chunks += 1
        state.audioMs += Math.max(0, Math.round(ms) || 0)
        send({ id, wav, ms: Math.max(0, Math.round(ms) || 0), end: false })
      },
      close: () => {
        const state = this.sessions.get(id)
        if (!state || state.settled || state.closed) return
        state.closed = true
        send({ id, ms: 0, end: true })
        const budget = Math.max(ACK_MIN_MS, state.audioMs + ACK_SLACK_MS)
        const watchdog = setTimeout(() => settle('timeout', `no ack within ${budget}ms`), budget)
        watchdog.unref?.()
        state.watchdog = watchdog
      },
      abort: () => {
        const state = this.sessions.get(id)
        if (!state || state.settled) return
        state.closed = true
        send({ id, ms: 0, end: true })
        try {
          win.webContents.send(IPC.pushSpeechStop)
        } catch {
          /* window is going away */
        }
        // An intentional stop counts as success: the Speaker already dropped
        // the queue, so replaying through another engine would double-speak.
        settle('heard')
      },
      done
    }
  }

  /** Renderer report: `{ id, ok, error? }`. Unknown ids are late acks; ignore. */
  ack(id: string, ok: boolean, error?: string): void {
    const state = this.sessions.get(id)
    if (!state || state.settled) return
    state.resolve(ok ? 'heard' : 'failed', error)
  }

  /** Stop whatever is playing and release every open session as heard. */
  stop(): void {
    const win = this.getWin()
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send(IPC.pushSpeechStop)
      } catch {
        /* window is going away */
      }
    }
    for (const [id, state] of this.sessions) {
      if (state.settled) continue
      state.settled = true
      if (state.watchdog) clearTimeout(state.watchdog)
      clearTimeout(state.ceiling)
      this.sessions.delete(id)
      state.resolve('heard')
    }
  }

  private drain(outcome: PlayOutcome, reason: string): void {
    for (const [id, state] of this.sessions) {
      if (state.settled) continue
      state.settled = true
      if (state.watchdog) clearTimeout(state.watchdog)
      clearTimeout(state.ceiling)
      this.sessions.delete(id)
      state.resolve(outcome, reason)
    }
  }

  get busy(): boolean {
    return this.sessions.size > 0
  }

  shutdown(): void {
    this.stop()
    this.ready = false
    const waiters = this.waiters
    this.waiters = []
    for (const wake of waiters) wake()
    log('info', 'renderer voice shut down')
  }
}
