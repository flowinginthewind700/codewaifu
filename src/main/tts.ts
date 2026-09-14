import { spawn, type ChildProcess } from 'node:child_process'
import type { AppConfig } from '../shared/config'
import type { Lang, VoiceInfo } from '../shared/protocol'
import { isLinux, isMac, isWindows, platform } from './env'
import { log } from './log'

interface QueueItem {
  text: string
  lang: Lang
}

/** Voices we prefer when the user left the choice on auto, in priority order. */
const PREFERRED: Record<Lang, string[]> = {
  zh: ['Tingting', 'Ting-Ting', 'Meijia', 'Sinji', 'Li-mu', 'Yu-shu', 'Tian-Tian', 'Han', 'Ling', 'Google 普通话'],
  en: ['Samantha', 'Ava', 'Karen', 'Moira', 'Daniel', 'Alex', 'Google US English', 'Zira', 'Hazel']
}

const VOICE_CACHE_MS = 10 * 60 * 1000

/**
 * OS-native speech only: no model downloads, no network, works offline on a
 * fresh Mac or Windows install. A neural-voice backend can slot in behind this
 * same interface later.
 */
export class Speaker {
  private queue: QueueItem[] = []
  private current: ChildProcess | null = null
  private voices: VoiceInfo[] = []
  private voicesAt = 0
  private stopped = false
  /** Collapse identical back-to-back lines so a burst of hooks cannot drone. */
  private lastText = ''
  private lastAt = 0

  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly onState: (speaking: boolean, queueLength: number) => void
  ) {}

  get speaking(): boolean {
    return this.current !== null
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
    const child = this.current
    this.current = null
    if (child) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
    this.emitState()
  }

  shutdown(): void {
    this.stopped = true
    this.stop()
  }

  private emitState(): void {
    this.onState(this.current !== null, this.queue.length)
  }

  private pump(): void {
    if (this.current) return
    const item = this.queue.shift()
    if (!item) {
      this.emitState()
      return
    }
    const cfg = this.getConfig()
    const request = this.buildCommand(item.text, item.lang, cfg)
    if (!request) {
      log('warn', `no TTS backend available on ${platform}`)
      this.emitState()
      return
    }
    this.emitState()
    try {
      const child = spawn(request.cmd, request.args, {
        stdio: 'ignore',
        windowsHide: true,
        env: request.env ? { ...process.env, ...request.env } : process.env
      })
      this.current = child
      const finish = (): void => {
        if (this.current === child) this.current = null
        this.emitState()
        this.pump()
      }
      child.once('exit', finish)
      child.once('error', (error) => {
        log('warn', 'TTS spawn failed', String(error))
        finish()
      })
      // Hard ceiling: a wedged engine must not silence every later notice.
      setTimeout(() => {
        if (this.current === child) {
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }
      }, 30000).unref?.()
    } catch (error) {
      log('error', 'TTS launch failed', String(error))
      this.current = null
      this.emitState()
    }
  }

  private buildCommand(
    text: string,
    lang: Lang,
    cfg: AppConfig
  ): { cmd: string; args: string[]; env?: Record<string, string> } | null {
    if (isMac) {
      const args: string[] = []
      const voice = this.pickVoice(lang, cfg)
      if (voice) args.push('-v', voice)
      args.push('-r', String(cfg.voice.rate))
      // A leading dash would be read as a flag by `say`.
      args.push(text.startsWith('-') ? ` ${text}` : text)
      return { cmd: 'say', args }
    }
    if (isWindows) {
      const rate = Math.max(-5, Math.min(5, Math.round((cfg.voice.rate - 178) / 18)))
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
          CODEWAIFU_VOICE: this.pickVoice(lang, cfg) || '',
          CODEWAIFU_RATE: String(rate)
        }
      }
    }
    if (isLinux) {
      const voice = lang === 'zh' ? 'cmn' : 'en'
      return { cmd: 'espeak-ng', args: ['-v', voice, '-s', String(cfg.voice.rate), text] }
    }
    return null
  }

  private pickVoice(lang: Lang, cfg: AppConfig): string {
    const explicit = lang === 'zh' ? cfg.voice.zh : cfg.voice.en
    if (explicit) return explicit
    if (!cfg.voice.auto || !isMac) return ''
    const known = this.voices
    if (known.length === 0) return ''
    for (const wanted of PREFERRED[lang]) {
      const hit = known.find((v) => v.name.toLowerCase() === wanted.toLowerCase())
      if (hit) return hit.name
    }
    const prefix = lang === 'zh' ? 'zh' : 'en'
    const byLang = known.find((v) => v.lang.toLowerCase().startsWith(prefix))
    return byLang ? byLang.name : ''
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
