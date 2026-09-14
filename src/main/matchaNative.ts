import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type koffi from 'koffi'
import type { LibraryHandle, TypeObject } from 'koffi'

// ============================================================
// Matcha-TTS through sherpa-onnx's C API.
//
// The obvious route — the official `sherpa-onnx-node` addon — cannot work
// inside Electron. That addon hands the generated PCM back to JavaScript as an
// *external* ArrayBuffer (zero copy over native memory), and Electron builds
// Node with external buffers disabled. So the sync call dies with "External
// buffers are not allowed" and the async one with "TTS settlement failed" (its
// result object cannot be built, so the promise can never settle). The very
// same code runs fine under plain node, which is why this only ever showed up
// in the packaged app: every line quietly degraded to the OS voice and the
// companion spoke in the wrong timbre.
//
// So we call `libsherpa-onnx-c-api` — the same entry points the upstream CLI
// uses — through koffi. Audio never crosses the boundary as native memory:
// sherpa writes the RIFF header and the 16-bit PCM into a Buffer we allocated,
// and JavaScript only ever sees bytes it owns.
//
// The dylibs/DLLs ride along in the per-platform `sherpa-onnx-<os>-<arch>`
// packages, which is why `sherpa-onnx-node` stays a dependency even though we
// no longer call its JS front.
//
// ⛔ The struct layout below is the sherpa-onnx 1.13.8 ABI
// (`sherpa-onnx/c-api/c-api.h`), so that version is pinned exactly in
// package.json. A silent field insertion upstream would shift every offset
// after it; `openVoice()` refusing a bogus sample rate is the tripwire, and
// `tests/matchaVoice.test.ts` synthesizes for real whenever weights are on
// disk.
// ============================================================

type Koffi = typeof koffi

/** 12MB of 16kHz mono is ~10 minutes of speech; anything bigger is a bug. */
const MAX_WAV_BYTES = 12 * 1024 * 1024

export interface RenderedAudio {
  /** Complete 16-bit mono WAV file. */
  bytes: Uint8Array
  /** PCM frame count, so the caller can compute duration without parsing. */
  samples: number
  sampleRate: number
}

export interface NativeVoice {
  sampleRate: number
  numSpeakers: number
  /** Render one line. Resolves null instead of throwing on a synthesis error. */
  render(text: string, speed: number): Promise<RenderedAudio | null>
  release(): void
}

// ---------------------------------------------------------------------------
// Library resolution (pure, unit tested)
// ---------------------------------------------------------------------------

/** sherpa names its Windows packages `win`, and the C API file per platform. */
export function libraryName(platform: string = process.platform): string {
  if (platform === 'darwin') return 'libsherpa-onnx-c-api.dylib'
  if (platform === 'win32') return 'sherpa-onnx-c-api.dll'
  return 'libsherpa-onnx-c-api.so'
}

export function platformPackageName(
  platform: string = process.platform,
  arch: string = process.arch
): string {
  const os = platform === 'win32' ? 'win' : platform
  return `sherpa-onnx-${os}-${arch}`
}

/**
 * `dlopen` cannot read inside an asar, and electron-builder puts unpacked
 * files in a sibling directory. Resolution still reports the asar path, so the
 * rewrite has to happen here.
 */
export function unpackedFromAsar(candidate: string): string {
  const asar = `${path.sep}app.asar${path.sep}`
  const at = candidate.indexOf(asar)
  if (at < 0) return candidate
  return `${candidate.slice(0, at)}${path.sep}app.asar.unpacked${path.sep}${candidate.slice(at + asar.length)}`
}

/** Where `node_modules` can be, in probe order: next to the bundle, then cwd. */
export function moduleRoots(
  here: string = path.dirname(fileURLToPath(import.meta.url))
): string[] {
  const roots = [path.resolve(here, '../../node_modules'), path.resolve(process.cwd(), 'node_modules')]
  return [...new Set(roots)]
}

export function libraryCandidates(
  platform: string = process.platform,
  arch: string = process.arch,
  roots: readonly string[] = moduleRoots()
): string[] {
  const pkg = platformPackageName(platform, arch)
  const name = libraryName(platform)
  return [...new Set(roots.map((root) => unpackedFromAsar(path.join(root, pkg, name))))]
}

/** First candidate that is really on disk, or null when this platform has none. */
export function resolveLibrary(
  platform: string = process.platform,
  arch: string = process.arch
): string | null {
  for (const candidate of libraryCandidates(platform, arch)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* try the next one */
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Configuration (pure, unit tested — mirrors robotworld's app/api/tts.py)
// ---------------------------------------------------------------------------

/** Rule FSTs, in the order production passes them. */
export const RULE_FSTS = ['date-zh.fst', 'number-zh.fst', 'phone-zh.fst'] as const

export interface MatchaOptions {
  dir: string
  threads?: number
  maxNumSentences?: number
}

/**
 * The config struct as a plain object. Every model family sherpa knows about
 * has to be present and fully populated: koffi marshals field by field, and an
 * `undefined` string is an error rather than a null pointer.
 *
 * The numbers are robotworld's: Matcha `model-steps-3` + vocos-16kHz, the
 * upstream defaults `noiseScale 0.667` / `lengthScale 1.0`, 2 threads, one
 * sentence per pass. Same weights and same settings is what makes the desktop
 * companion sound like the voice workshop instead of merely similar.
 */
export function matchaConfig(options: MatchaOptions): Record<string, unknown> {
  const dir = options.dir
  const requested = options.threads ?? 2
  const threads = Number.isFinite(requested) ? Math.min(8, Math.max(1, Math.round(requested))) : 2
  const blank = {
    model: '',
    lexicon: '',
    tokens: '',
    data_dir: '',
    dict_dir: '',
    voices: '',
    lang: '',
    encoder: '',
    decoder: '',
    vocoder: '',
    acoustic_model: '',
    lm_flow: '',
    lm_main: '',
    text_conditioner: '',
    vocab_json: '',
    token_scores_json: '',
    duration_predictor: '',
    text_encoder: '',
    vector_estimator: '',
    tts_json: '',
    unicode_indexer: '',
    voice_style: ''
  }
  return {
    model: {
      vits: { ...blank, noise_scale: 0.667, noise_scale_w: 0.8, length_scale: 1.0 },
      num_threads: threads,
      debug: 0,
      provider: 'cpu',
      matcha: {
        ...blank,
        acoustic_model: path.join(dir, 'model-steps-3.onnx'),
        vocoder: path.join(dir, 'vocos-16khz-univ.onnx'),
        lexicon: path.join(dir, 'lexicon.txt'),
        tokens: path.join(dir, 'tokens.txt'),
        data_dir: path.join(dir, 'espeak-ng-data'),
        noise_scale: 0.667,
        length_scale: 1.0
      },
      kokoro: { ...blank, length_scale: 1.0 },
      kitten: { ...blank, length_scale: 1.0 },
      zipvoice: { ...blank, feat_scale: 0, t_shift: 0, target_rms: 0, guidance_scale: 0 },
      pocket: { ...blank, voice_embedding_cache_capacity: 0 },
      supertonic: { ...blank }
    },
    rule_fsts: RULE_FSTS.map((name) => path.join(dir, name)).join(','),
    max_num_sentences: options.maxNumSentences ?? 1,
    rule_fars: '',
    silence_scale: 0.2
  }
}

// ---------------------------------------------------------------------------
// Native binding
// ---------------------------------------------------------------------------

interface Types {
  config: TypeObject
  audio: TypeObject
}

/** koffi's `LibraryHandle.func`, narrowed to the overload we use. */
interface KoffiFn {
  (...call: unknown[]): unknown
  async: (...call: unknown[]) => void
}

interface Functions {
  create: (config: unknown) => unknown
  sampleRate: (tts: unknown) => number
  numSpeakers: (tts: unknown) => number
  generate: KoffiFn
  waveFileSize: (n: number) => number | bigint
  writeWaveToBuffer: (samples: unknown, n: number, sampleRate: number, buffer: Uint8Array) => void
  destroyAudio: (audio: unknown) => void
  destroy: (tts: unknown) => void
}

function defineTypes(k: Koffi): Types {
  const str = 'str'
  const f32 = 'float'
  const vits = k.struct({
    model: str,
    lexicon: str,
    tokens: str,
    data_dir: str,
    noise_scale: f32,
    noise_scale_w: f32,
    length_scale: f32,
    dict_dir: str
  })
  const matcha = k.struct({
    acoustic_model: str,
    vocoder: str,
    lexicon: str,
    tokens: str,
    data_dir: str,
    noise_scale: f32,
    length_scale: f32,
    dict_dir: str
  })
  const kokoro = k.struct({
    model: str,
    voices: str,
    tokens: str,
    data_dir: str,
    length_scale: f32,
    dict_dir: str,
    lexicon: str,
    lang: str
  })
  const kitten = k.struct({
    model: str,
    voices: str,
    tokens: str,
    data_dir: str,
    length_scale: f32
  })
  const zipvoice = k.struct({
    tokens: str,
    encoder: str,
    decoder: str,
    vocoder: str,
    data_dir: str,
    lexicon: str,
    feat_scale: f32,
    t_shift: f32,
    target_rms: f32,
    guidance_scale: f32
  })
  const pocket = k.struct({
    lm_flow: str,
    lm_main: str,
    encoder: str,
    decoder: str,
    text_conditioner: str,
    vocab_json: str,
    token_scores_json: str,
    voice_embedding_cache_capacity: 'int32'
  })
  const supertonic = k.struct({
    duration_predictor: str,
    text_encoder: str,
    vector_estimator: str,
    vocoder: str,
    tts_json: str,
    unicode_indexer: str,
    voice_style: str
  })
  const model = k.struct({
    vits,
    num_threads: 'int32',
    debug: 'int32',
    provider: str,
    matcha,
    kokoro,
    kitten,
    zipvoice,
    pocket,
    supertonic
  })
  const config = k.struct({
    model,
    rule_fsts: str,
    max_num_sentences: 'int32',
    rule_fars: str,
    silence_scale: f32
  })
  const audio = k.struct({
    samples: k.pointer('float'),
    n: 'int32',
    sample_rate: 'int32'
  })
  return { config, audio }
}

function loadKoffi(): Koffi {
  // The main bundle is ESM and koffi is an external dependency, so `require`
  // has to be rebuilt from the module URL (same trick as every native dep here).
  return createRequire(import.meta.url)('koffi') as unknown as Koffi
}

/**
 * Windows resolves a DLL's imports by name, and `onnxruntime.dll` sits next to
 * the C API rather than on PATH. Loading it first is what makes that import
 * resolve whatever the process working directory happens to be.
 */
function preloadSiblings(k: Koffi, dir: string): void {
  if (process.platform !== 'win32') return
  for (const name of ['onnxruntime_providers_shared.dll', 'onnxruntime.dll']) {
    try {
      k.load(path.join(dir, name))
    } catch {
      /* the C API load below reports the real failure */
    }
  }
}

function asPromise(fn: KoffiFn, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    fn.async(...args, (error: unknown, result: unknown) => {
      if (error) reject(error instanceof Error ? error : new Error(String(error)))
      else resolve(result)
    })
  })
}

export interface OpenOptions extends MatchaOptions {
  /** Override the resolved library; tests point this at a real dylib. */
  library?: string | null
}

/** One loaded library: everything needed to create and drive a voice. */
interface Bound {
  k: Koffi
  fns: Functions
  types: Types
}

function bind(library: string): Bound {
  const k = loadKoffi()
  preloadSiblings(k, path.dirname(library))
  const lib: LibraryHandle = k.load(library)
  const types = defineTypes(k)
  const fns: Functions = {
    create: lib.func('SherpaOnnxCreateOfflineTts', 'void *', [
      k.pointer(types.config)
    ]) as unknown as Functions['create'],
    sampleRate: lib.func('SherpaOnnxOfflineTtsSampleRate', 'int32', [
      'void *'
    ]) as unknown as Functions['sampleRate'],
    numSpeakers: lib.func('SherpaOnnxOfflineTtsNumSpeakers', 'int32', [
      'void *'
    ]) as unknown as Functions['numSpeakers'],
    generate: lib.func('SherpaOnnxOfflineTtsGenerate', k.pointer(types.audio), [
      'void *',
      'str',
      'int32',
      'float'
    ]),
    waveFileSize: lib.func('SherpaOnnxWaveFileSize', 'int64', [
      'int32'
    ]) as unknown as Functions['waveFileSize'],
    writeWaveToBuffer: lib.func('SherpaOnnxWriteWaveToBuffer', 'void', [
      k.pointer('float'),
      'int32',
      'int32',
      'void *'
    ]) as unknown as Functions['writeWaveToBuffer'],
    destroyAudio: lib.func('SherpaOnnxDestroyOfflineTtsGeneratedAudio', 'void', [
      k.pointer(types.audio)
    ]) as unknown as Functions['destroyAudio'],
    destroy: lib.func('SherpaOnnxDestroyOfflineTts', 'void', ['void *']) as unknown as Functions['destroy']
  }
  return { k, fns, types }
}

/** Resolve the platform library, or throw with the paths we actually probed. */
function resolveOrFail(requested?: string | null): string {
  const library = requested === undefined ? resolveLibrary() : requested
  if (!library) {
    const tried = libraryCandidates().join(', ') || 'no node_modules'
    throw new Error(
      `sherpa-onnx native library not found for ${process.platform}-${process.arch} (tried ${tried})`
    )
  }
  return library
}

/**
 * Adopt a live handle: read back the sample rate (the ABI tripwire) and wire up
 * the render queue around it.
 */
function adopt(bound: Bound, handle: unknown, dir: string): NativeVoice {
  const { k, fns, types } = bound
  const sampleRate = fns.sampleRate(handle)
  // A shifted struct yields garbage here long before it yields wrong audio.
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 192_000) {
    fns.destroy(handle)
    throw new Error(
      `sherpa-onnx reported an impossible sample rate (${sampleRate}) for ${dir}; ABI mismatch?`
    )
  }
  const speakers = fns.numSpeakers(handle)
  const numSpeakers = Number.isFinite(speakers) ? speakers : 0

  async function generate(text: string, speed: number): Promise<RenderedAudio | null> {
    const audio = await asPromise(fns.generate, [handle, text, 0, speed])
    if (!audio) return null
    try {
      const info = k.decode(audio, types.audio) as unknown as {
        samples: unknown
        n: number
        sample_rate: number
      }
      const n = Number(info.n)
      const rate = Number(info.sample_rate)
      if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(rate) || rate <= 0) return null
      const size = Number(fns.waveFileSize(n))
      if (!Number.isFinite(size) || size < 44 || size > MAX_WAV_BYTES) return null
      const buffer = Buffer.alloc(size)
      fns.writeWaveToBuffer(info.samples, n, rate, buffer)
      // Buffer.alloc is never pooled, so this view owns the whole allocation.
      return {
        bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length),
        samples: n,
        sampleRate: rate
      }
    } finally {
      fns.destroyAudio(audio)
    }
  }

  /** One generation at a time: same handle, and lines are spoken in order anyway. */
  let queue: Promise<unknown> = Promise.resolve()

  function renderOnce(text: string, speed: number): Promise<RenderedAudio | null> {
    const run = queue.then(
      () => generate(text, speed),
      () => generate(text, speed)
    )
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  let released = false
  return {
    sampleRate,
    numSpeakers,
    render(text, speed) {
      if (released) return Promise.resolve(null)
      const clean = String(text || '').trim()
      if (!clean) return Promise.resolve(null)
      return renderOnce(clean, speed)
    },
    release() {
      if (released) return
      released = true
      try {
        fns.destroy(handle)
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Load the engine. Throws when koffi, the native library or the model files
 * are missing — the caller decides how loudly to complain and what to fall
 * back to.
 */
export function openVoice(options: OpenOptions): NativeVoice {
  const bound = bind(resolveOrFail(options.library))
  const handle = bound.fns.create(matchaConfig(options))
  if (!handle) throw new Error(`sherpa-onnx refused the Matcha configuration in ${options.dir}`)
  return adopt(bound, handle, options.dir)
}

/**
 * Same engine, but model creation happens on koffi's worker thread. Loading
 * costs ~600ms of ONNX graph setup; doing it synchronously would freeze the
 * Electron main thread for exactly that long on every launch.
 */
export async function openVoiceAsync(options: OpenOptions): Promise<NativeVoice> {
  const bound = bind(resolveOrFail(options.library))
  const handle = await asPromise(bound.fns.create as unknown as KoffiFn, [matchaConfig(options)])
  if (!handle) throw new Error(`sherpa-onnx refused the Matcha configuration in ${options.dir}`)
  return adopt(bound, handle, options.dir)
}
