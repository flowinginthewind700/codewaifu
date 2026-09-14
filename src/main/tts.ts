import { spawn, type ChildProcess } from 'node:child_process'
import type { AppConfig } from '../shared/config'
import type { Lang, VoiceInfo } from '../shared/protocol'
import { rateToSpeed, speechUnits, toPhonetic } from '../shared/speech'
import { isLinux, isMac, isWindows, platform } from './env'
import { log } from './log'
import { synthesizeUnit } from './neuralTts'
import { chooseVoice, sapiRate, synthesize } from './synth'
import type { VoiceSession } from './voiceBridge'

interface QueueItem {
  text: string
  lang: Lang
}

const VOICE_CACHE_MS = 10 * 60 * 1000

/**
 * How long a line will wait for the widget's audio graph before giving up on
 * it. The renderer attaches its player a beat after the window paints, and a
 * notice that arrives in that gap used to be permanently downgraded to the OS
 * voice — audible, but not *her*. Bounded so a machine with no window at all
 * is delayed by this much and never more.
 */
const TRANSPORT_GRACE_MS = 4000

/**
 * Where a rendered WAV can be heard: the widget's own Web Audio graph. It is
 * the only path that gives the renderer an analyser, and therefore the only one
 * that can drive real lip-sync — so it is tried first and the OS engine below
 * stays as the fallback for when there is no window, or playback breaks.
 */
export interface VoiceTransport {
  available(): boolean
  /** Open one line of speech; null when the widget cannot play right now. */
  session(): VoiceSession | null
  stop(): void
  /**
   * Optional: settle once the widget can play, or once `ms` has passed. A
   * transport without it is simply taken at its word.
   */
  waitUntilAvailable?(ms: number): Promise<boolean>
}

/**
 * One line currently being spoken, whichever path is speaking it. `canceled`
 * is the guard that keeps a late `exit`/ack from advancing the queue twice or
 * from resurrecting a line the user just muted.
 */
interface Active {
  cancel: () => void
  canceled: boolean
}

/**
 * One voice, three ways to make it audible, tried in this order:
 *
 *   1. Matcha-TTS rendered to WAV, played by the widget's Web Audio graph.
 *      Neural quality, mixed zh/en in one pass, and the analyser on that graph
 *      is what drives lip-sync.
 *   2. The OS engine (`say` / SAPI / espeak-ng) rendered to WAV and played the
 *      same way. Lower quality, but lip-sync survives — which is the whole
 *      reason the WAV detour exists.
 *   3. The OS engine spawned straight at the speakers. Audible, no lip-sync.
 *      This is the path on a machine with no widget window, and the last
 *      resort everywhere else.
 *
 * Nothing here may throw: a broken voice degrades one rung, it never silences
 * the notice.
 */
export class Speaker {
  private queue: QueueItem[] = []
  private active: Active | null = null
  private voices: VoiceInfo[] = []
  private voicesAt = 0
  private stopped = false
  private transport: VoiceTransport | null = null
  /** Collapse identical back-to-back lines so a burst of hooks cannot drone. */
  private lastText = ''
  private lastAt = 0

  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly onState: (speaking: boolean, queueLength: number) => void
  ) {}

  /** Wired by `Core` once the window exists; null keeps the OS-engine path. */
  setTransport(transport: VoiceTransport | null): void {
    this.transport = transport
  }

  get speaking(): boolean {
    return this.active !== null
  }

  say(text: string, lang: Lang): void {
    const clean = String(text || '').trim()
    if (!clean || this.stopped) return
    const cfg = this.getConfig()
    if (!cfg.enabled || !cfg.speak) return
    const now = Date.now()
    if (clean === this.lastText && now - this.lastAt < 3000) return
    this.lastText = clean
    this.lastAt = now
    if (this.queue.length >= cfg.maxQueue) {
      // Drop the oldest pending line; a fresh notice matters more than backlog.
      this.queue.shift()
    }
    this.queue.push({ text: clean, lang })
    this.pump()
  }

  /** Say something regardless of the mute toggle (used for confirmations). */
  force(text: string, lang: Lang): void {
    const clean = String(text || '').trim()
    if (!clean || this.stopped) return
    this.queue.push({ text: clean, lang })
    this.pump()
  }

  stop(): void {
    this.queue = []
    const active = this.active
    this.active = null
    if (active) {
      active.canceled = true
      try {
        active.cancel()
      } catch (error) {
        log('warn', 'could not cancel speech', String(error))
      }
    }
    this.emitState()
  }

  shutdown(): void {
    this.stopped = true
    this.stop()
  }

  private emitState(): void {
    this.onState(this.active !== null, this.queue.length)
  }

  private pump(): void {
    if (this.active || this.stopped) {
      this.emitState()
      return
    }
    const item = this.queue.shift()
    if (!item) {
      this.emitState()
      return
    }
    const cfg = this.getConfig()
    const slot: Active = { cancel: () => undefined, canceled: false }
    this.active = slot
    this.emitState()

    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      if (slot.canceled) return
      if (this.active === slot) this.active = null
      this.emitState()
      this.pump()
    }

    const transport = this.transport
    if (transport?.available()) {
      void this.speakThroughRenderer(item, transport, slot, finish)
      return
    }
    if (transport?.waitUntilAvailable) {
      void transport.waitUntilAvailable(TRANSPORT_GRACE_MS).then((ready) => {
        if (slot.canceled) return
        const live = this.transport
        if (ready && live?.available()) {
          void this.speakThroughRenderer(item, live, slot, finish)
          return
        }
        this.spawnEngine(item, cfg, slot, finish)
      })
      return
    }
    this.spawnEngine(item, cfg, slot, finish)
  }

  /**
   * Preferred path: render to WAV, hand it to the widget, wait for the ack.
   * Anything that means "no sound came out" degrades to the OS engine; a
   * watchdog timeout does not, because by then she has already said it.
   */
  private async speakThroughRenderer(
    item: QueueItem,
    transport: VoiceTransport,
    slot: Active,
    finish: () => void
  ): Promise<void> {
    const cfg = this.getConfig()
    const session = transport.session()
    if (!session) {
      this.spawnEngine(item, cfg, slot, finish)
      return
    }
    slot.cancel = () => session.abort()

    const text = toPhonetic(item.text)
    const units = speechUnits(text)
    let pushed = 0
    /** Chunks that came out of Matcha, as opposed to the OS-engine WAV rung. */
    let neuralChunks = 0
    let stalled = false

    if (cfg.voice.engine === 'matcha') {
      const speed = rateToSpeed(cfg.voice.rate)
      for (const unit of units) {
        if (slot.canceled) break
        const chunk = await synthesizeUnit(unit, speed)
        if (!chunk) {
          stalled = true
          break
        }
        session.push(chunk.bytes, chunk.ms)
        pushed += 1
        neuralChunks += 1
      }
    }
    // Rung 2: the OS engine, still rendered to WAV so the mouth keeps moving.
    // Only worth trying when Matcha produced nothing at all — a line that
    // already half played must not be said again from the top.
    if (!slot.canceled && pushed === 0) {
      const audio = await synthesize(text || item.text, item.lang, cfg, this.voices)
      if (slot.canceled) {
        session.abort()
        return
      }
      if (audio) {
        session.push(audio.bytes, audio.ms)
        pushed = 1
      }
    }
    // Which voice actually spoke is the first thing anybody asks when the
    // companion sounds wrong, so it goes in the log rather than being inferred
    // from the absence of a warning.
    log('info', pushed > 0 && neuralChunks > 0 ? 'spoke via matcha' : 'spoke via system wav', {
      units: units.length,
      pushed,
      chars: text.length
    })

    if (slot.canceled) return
    if (pushed === 0) {
      session.abort()
      slot.cancel = () => undefined
      this.spawnEngine(item, cfg, slot, finish)
      return
    }
    if (stalled) log('warn', 'neural voice stalled mid-line; speaking what was rendered')

    session.close()
    const outcome = await session.done
    if (slot.canceled) return
    if (outcome === 'failed') {
      log('warn', 'renderer voice failed; falling back to the OS engine')
      slot.cancel = () => undefined
      this.spawnEngine(item, cfg, slot, finish)
      return
    }
    finish()
  }

  /** Fallback path, and the only path on a machine with no widget window. */
  private spawnEngine(item: QueueItem, cfg: AppConfig, slot: Active, finish: () => void): void {
    const request = this.buildCommand(item.text, item.lang, cfg)
    if (!request) {
      log('warn', `no TTS backend available on ${platform}`)
      finish()
      return
    }
    // No lip-sync on this rung: the audio never passes through the widget.
    log('info', 'spoke via system spawn', { cmd: request.cmd, chars: item.text.length })
    try {
      const child = spawn(request.cmd, request.args, {
        stdio: 'ignore',
        windowsHide: true,
        env: request.env ? { ...process.env, ...request.env } : process.env
      })
      slot.cancel = () => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
      child.once('exit', finish)
      child.once('error', (error) => {
        log('warn', 'TTS spawn failed', String(error))
        finish()
      })
      // Hard ceiling: a wedged engine must not silence every later notice.
      const timer = setTimeout(() => {
        if (slot.canceled) return
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, 30000)
      timer.unref?.()
    } catch (error) {
      log('error', 'TTS launch failed', String(error))
      finish()
    }
  }

  private buildCommand(
    text: string,
    lang: Lang,
    cfg: AppConfig
  ): { cmd: string; args: string[]; env?: Record<string, string> } | null {
    const choice = chooseVoice(cfg, lang, this.voices)
    if (isMac) {
      const args: string[] = []
      if (choice.voice) args.push('-v', choice.voice)
      args.push('-r', String(cfg.voice.rate))
      // A leading dash would be read as a flag by `say`.
      args.push(text.startsWith('-') ? ` ${text}` : text)
      return { cmd: 'say', args }
    }
    if (isWindows) {
      const script = [
        '$ErrorActionPreference="Stop";',
        '$s=New-Object -ComObject SAPI.SpVoice;',
        'if($env:CODEWAIFU_VOICE){',
        '  $v=$s.GetVoices()|Where-Object{$_.GetDescription() -like "*$env:CODEWAIFU_VOICE*"}|Select-Object -First 1;',
        '  if($v){$s.Voice=$v}',
        '};',
        '$s.Rate=[int]$env:CODEWAIFU_RATE;',
        '$s.Speak($env:CODEWAIFU_TEXT)|Out-Null'
      ].join(' ')
      return {
        cmd: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        env: {
          CODEWAIFU_TEXT: text,
          CODEWAIFU_VOICE: choice.voice,
          CODEWAIFU_RATE: String(sapiRate(choice.rate))
        }
      }
    }
    if (isLinux) {
      const voice = lang === 'zh' ? 'cmn' : 'en'
      return { cmd: 'espeak-ng', args: ['-v', voice, '-s', String(cfg.voice.rate), text] }
    }
    return null
  }

  /** Populate the voice table so auto-pick has something to choose from. */
  async refreshVoices(): Promise<VoiceInfo[]> {
    if (!isMac) return this.voices
    if (this.voices.length && Date.now() - this.voicesAt < VOICE_CACHE_MS) return this.voices
    const voices = await listMacVoices()
    if (voices.length) {
      this.voices = voices
      this.voicesAt = Date.now()
    }
    return this.voices
  }

  listVoices(): VoiceInfo[] {
    return this.voices
  }
}

export function listMacVoices(): Promise<VoiceInfo[]> {
  return new Promise((resolve) => {
    let out = ''
    let child: ChildProcess
    try {
      child = spawn('say', ['-v', '?'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      resolve([])
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      resolve(parseSayVoices(out))
    }, 4000)
    timer.unref?.()
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      out += chunk
    })
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(parseSayVoices(out))
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve([])
    })
  })
}

/** `say -v '?'` rows look like: `Samantha             en_US        # comment`. */
export function parseSayVoices(text: string): VoiceInfo[] {
  const voices: VoiceInfo[] = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([^\s#][^#]*?)\s{2,}([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)/.exec(line)
    if (!m) continue
    voices.push({ name: m[1].trim(), lang: m[2].trim() })
  }
  return voices
}
