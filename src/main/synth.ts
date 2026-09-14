import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AppConfig } from '../shared/config'
import type { Lang, VoiceInfo } from '../shared/protocol'
import { isLinux, isMac, isWindows, ttsDir } from './env'
import { log } from './log'

// ============================================================
// Speech rendered to a WAV file instead of straight to the speakers.
//
// Why bother: `say`/SAPI/espeak-ng playing into the OS audio device gives the
// companion no way to know how loud it is being *right now*, which is exactly
// the signal Live2D lip-sync needs. Rendering to a file lets the renderer play
// the bytes through a Web Audio graph with an AnalyserNode on a side chain, so
// the mouth moves on real RMS instead of a guess.
//
// It is strictly an upgrade path: every function here returns null on failure
// and the Speaker falls back to spawning the engine directly, so a machine
// without a writable temp dir or without `say` still talks.
// ============================================================

/** Mono 16-bit 22.05kHz: small, universally decodable, plenty for speech. */
const MAC_DATA_FORMAT = 'LEI16@22050'
const SYNTH_TIMEOUT_MS = 20_000
const MAX_WAV_BYTES = 12 * 1024 * 1024

/** Voices we prefer when the user left the choice on auto, in priority order. */
export const PREFERRED: Record<Lang, string[]> = {
  zh: ['Tingting', 'Ting-Ting', 'Meijia', 'Sinji', 'Li-mu', 'Yu-shu', 'Tian-Tian', 'Han', 'Ling', 'Google 普通话'],
  en: ['Samantha', 'Ava', 'Karen', 'Moira', 'Daniel', 'Alex', 'Google US English', 'Zira', 'Hazel']
}

export interface VoiceChoice {
  voice: string
  rate: number
}

/** Resolve the engine voice + rate for one line. Pure, so it is unit-testable. */
export function chooseVoice(cfg: AppConfig, lang: Lang, known: readonly VoiceInfo[]): VoiceChoice {
  const explicit = lang === 'zh' ? cfg.voice.zh : cfg.voice.en
  let voice = explicit
  if (!voice && cfg.voice.auto && isMac) {
    const wanted = PREFERRED[lang].find((name) => known.some((v) => v.name.toLowerCase() === name.toLowerCase()))
    const byLang = wanted
      ? known.find((v) => v.name.toLowerCase() === wanted.toLowerCase())
      : known.find((v) => v.lang.toLowerCase().startsWith(lang === 'zh' ? 'zh' : 'en'))
    voice = byLang?.name ?? ''
  }
  return { voice: voice || '', rate: cfg.voice.rate }
}

export interface SpeechAudio {
  /** Complete WAV file. */
  bytes: Uint8Array
  /** Duration parsed from the header; 0 when the header is unreadable. */
  ms: number
}

/**
 * Render one line to WAV. Returns null when the platform has no engine, the
 * engine is missing, or the bytes do not look like audio — the caller then
 * falls back to direct playback.
 */
export async function synthesize(
  text: string,
  lang: Lang,
  cfg: AppConfig,
  known: readonly VoiceInfo[] = []
): Promise<SpeechAudio | null> {
  const clean = String(text || '').trim()
  if (!clean) return null
  const choice = chooseVoice(cfg, lang, known)
  let file = ''
  try {
    await fs.mkdir(ttsDir, { recursive: true })
    file = path.join(ttsDir, `line-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.wav`)
    const ok = await renderToFile(clean, lang, file, choice)
    if (!ok) return null
    const bytes = await fs.readFile(file)
    if (bytes.byteLength < 64 || bytes.byteLength > MAX_WAV_BYTES) return null
    return { bytes: new Uint8Array(bytes), ms: wavDurationMs(bytes) }
  } catch (error) {
    log('warn', 'speech synthesis failed', String(error))
    return null
  } finally {
    if (file) {
      // Scratch files are single-use; a crashed run leaves at most one behind.
      await fs.rm(file, { force: true }).catch(() => undefined)
    }
  }
}

async function renderToFile(
  text: string,
  lang: Lang,
  file: string,
  choice: VoiceChoice
): Promise<boolean> {
  if (isMac) {
    const args = ['-o', file, '--file-format=WAVE', `--data-format=${MAC_DATA_FORMAT}`]
    if (choice.voice) args.push('-v', choice.voice)
    args.push('-r', String(choice.rate))
    // A leading dash would be parsed as a flag by `say`.
    args.push(text.startsWith('-') ? ` ${text}` : text)
    return runExitOk('say', args)
  }
  if (isWindows) {
    // SAPI has no CLI; the SpFileStream COM object writes the same WAV.
    const script = [
      '$ErrorActionPreference="Stop";',
      '$s=New-Object -ComObject SAPI.SpVoice;',
      'if($env:CODEWAIFU_VOICE){',
      '  $v=$s.GetVoices()|Where-Object{$_.GetDescription() -like "*$env:CODEWAIFU_VOICE*"}|Select-Object -First 1;',
      '  if($v){$s.Voice=$v}',
      '};',
      '$s.Rate=[int]$env:CODEWAIFU_RATE;',
      '$f=New-Object -ComObject SAPI.SpFileStream;',
      // SSFMCreateForWrite = 3; format 22 = SAFT22kHz16BitMono.
      '$f.Open($env:CODEWAIFU_OUT,3,$false);',
      'try{$f.Format.Type=22}catch{};',
      '$s.AudioOutputStream=$f;',
      '$s.Speak($env:CODEWAIFU_TEXT)|Out-Null;',
      '$f.Close();',
      '$s.AudioOutputStream=$null'
    ].join(' ')
    return runExitOk(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        CODEWAIFU_TEXT: text,
        CODEWAIFU_VOICE: choice.voice,
        CODEWAIFU_RATE: String(sapiRate(choice.rate)),
        CODEWAIFU_OUT: file
      }
    )
  }
  if (isLinux) {
    return runExitOk('espeak-ng', [
      '-w',
      file,
      '-v',
      lang === 'zh' ? 'cmn' : 'en',
      '-s',
      String(choice.rate),
      text
    ])
  }
  return false
}

/** SAPI's rate is -10..10 around 0; `say`'s is words-per-minute around 178. */
export function sapiRate(wordsPerMinute: number): number {
  if (!Number.isFinite(wordsPerMinute)) return 0
  return Math.max(-5, Math.min(5, Math.round((wordsPerMinute - 178) / 18)))
}

function runExitOk(cmd: string, args: string[], env?: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, {
        stdio: 'ignore',
        windowsHide: true,
        env: env ? { ...process.env, ...env } : process.env
      })
    } catch (error) {
      log('warn', `cannot launch ${cmd}`, String(error))
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolve(false)
    }, SYNTH_TIMEOUT_MS)
    timer.unref?.()
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      log('warn', `speech engine ${cmd} unavailable`, String(error))
      resolve(false)
    })
  })
}

/**
 * Duration of a PCM WAV, from its own header. Used to size the playback
 * watchdog: a stuck renderer must not silence every later announcement, but the
 * timeout has to be longer than the line itself.
 */
export function wavDurationMs(bytes: Uint8Array): number {
  if (bytes.byteLength < 44) return 0
  const tag = (offset: number, length: number): string => {
    let out = ''
    for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0)
    return out
  }
  if (tag(0, 4) !== 'RIFF' || tag(8, 4) !== 'WAVE') return 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let byteRate = 0
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset, 4)
    const size = view.getUint32(offset + 4, true)
    if (!Number.isFinite(size) || size < 0) return 0
    // byteRate sits 8 bytes into the `fmt ` chunk data.
    if (id === 'fmt ' && offset + 20 <= bytes.byteLength) byteRate = view.getUint32(offset + 16, true)
    if (id === 'data') {
      const dataBytes = Math.min(size, bytes.byteLength - (offset + 8))
      return byteRate > 0 ? Math.round((dataBytes / byteRate) * 1000) : 0
    }
    // Chunks are word-aligned; a stray pad byte is part of the layout.
    offset += 8 + size + (size % 2)
  }
  return 0
}
