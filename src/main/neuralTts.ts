import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { NeuralPhase, NeuralStatus } from '../shared/protocol'
import { matchaDir } from './env'
import { log } from './log'
import { openVoiceAsync, type NativeVoice } from './matchaNative'

// ============================================================
// Matcha-TTS: the default voice.
//
// This is the same engine and the same weights robotworld.top runs server side
// (`app/api/tts.py`) — sherpa-onnx Matcha with the `matcha-icefall-zh-en`
// acoustic model, the vocos-16kHz vocoder and the three zh rule FSTs — moved
// onto the user's machine. Keeping the configuration identical is deliberate:
// mixed Chinese/English notices are the whole point of this app, and that model
// is the one already proven to read `paper-search 跑完了，共找到 12 篇 VLA 论文`
// without switching voices or dropping words.
//
// Measured on an M-series arm64 laptop: 616ms cold load, RTF ~0.015 (≈65x
// real time), a 22-character Chinese notice in ~85ms. Both model creation and
// generation run off Electron's main thread, so a long notice never stalls the
// window or the relay.
//
// ⛔ The engine is driven through `matchaNative` (sherpa's C API via koffi),
// *not* through the `sherpa-onnx-node` JS front. That addon returns PCM as an
// external ArrayBuffer and Electron builds Node with external buffers
// disabled, so it can only ever fail inside the packaged app — which is how a
// wrong timbre shipped once already. See `matchaNative.ts`.
//
// The weights are 134MB, so they are downloaded on first run rather than
// bundled. Until they land, `available()` is false and the Speaker keeps using
// the OS voice — the companion is never silent just because a download is in
// flight.
// ============================================================

/** Bumped when the file list changes, so a stale install re-downloads. */
export const MATCHA_REV = 'matcha-icefall-zh-en/v1'

export interface ModelFile {
  name: string
  /** Exact upstream size; doubles as the download's integrity check. */
  bytes: number
}

/**
 * The eight files the engine needs, with sizes taken from the ModelScope repo
 * listing at pin time. `espeak-ng-data.tar.gz` is fetched as a tarball instead
 * of its 356 individual members: 9MB in one request versus 356 round trips.
 */
export const MODEL_FILES: readonly ModelFile[] = [
  { name: 'model-steps-3.onnx', bytes: 75717082 },
  { name: 'vocos-16khz-univ.onnx', bytes: 53882848 },
  { name: 'espeak-ng-data.tar.gz', bytes: 9019081 },
  { name: 'lexicon.txt', bytes: 1400278 },
  { name: 'phone-zh.fst', bytes: 88630 },
  { name: 'number-zh.fst', bytes: 64482 },
  { name: 'date-zh.fst', bytes: 59154 },
  { name: 'tokens.txt', bytes: 21146 }
]

export const MODEL_TOTAL_BYTES: number = MODEL_FILES.reduce((n, f) => n + f.bytes, 0)

/** Extracted from the tarball; its presence is what makes the install usable. */
const ESPEAK_MARKER = path.join('espeak-ng-data', 'phontab')

/** Primary source: ModelScope mirrors the bundle whole and is fast in CN. */
const MODELSCOPE_NS = 'bujidc/matcha-icefall-zh-en'
/** Fallback: upstream k2-fsa release assets, reachable everywhere else. */
const GITHUB_BUNDLE =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/matcha-icefall-zh-en.tar.bz2'
const GITHUB_VOCODER =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos-16khz-univ.onnx'

const MANIFEST = 'manifest.json'
/** Two big files dominate; more parallelism just splits the same bandwidth. */
const CONCURRENCY = 3
const HTTP_TIMEOUT_MS = 30_000

function blankStatus(phase: NeuralPhase, error = ''): NeuralStatus {
  return {
    phase,
    received: 0,
    total: MODEL_TOTAL_BYTES,
    file: '',
    error,
    dir: matchaDir,
    sampleRate: 0,
    loadMs: 0
  }
}

export interface DownloadProgress {
  received: number
  total: number
  file: string
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested without touching the network)
// ---------------------------------------------------------------------------

export function modelscopeUrl(name: string): string {
  return `https://www.modelscope.cn/models/${MODELSCOPE_NS}/resolve/master/${encodeURIComponent(name)}`
}

/**
 * Decide what to do about one file. `keep` means it is already the right size;
 * `resume` means a partial download can continue from where it stopped;
 * `fetch` means start over.
 */
export function planFile(
  expected: number,
  have: number,
  havePartial: number
): 'keep' | 'resume' | 'fetch' {
  if (have === expected) return 'keep'
  if (havePartial > 0 && havePartial < expected) return 'resume'
  return 'fetch'
}

/** Frame count -> milliseconds, for the widget's playback progress. */
export function wavMs(samples: number, sampleRate: number): number {
  return sampleRate > 0 ? Math.round((samples / sampleRate) * 1000) : 0
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

interface FetchResult {
  ok: boolean
  status: number
  /** Bytes written by this call (a resumed download only counts the new ones). */
  written: number
  error: string
}

/**
 * Stream one URL to `dest.part` then rename it into place. Resumes from the
 * existing partial size with a Range request, verifies the final byte count,
 * and never leaves a half-written file at the real path — a crashed download
 * is indistinguishable from no download at all.
 */
async function fetchFile(
  url: string,
  dest: string,
  expected: number,
  onBytes: (n: number) => void
): Promise<FetchResult> {
  const part = `${dest}.part`
  let start = 0
  try {
    start = (await fsp.stat(part)).size
    if (start >= expected && expected > 0) start = 0
  } catch {
    start = 0
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS + 600_000)
  timer.unref?.()
  let written = 0
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'codewaifu/0.1',
        ...(start > 0 ? { range: `bytes=${start}-` } : {})
      }
    })
    // A 200 in answer to a Range request means the server ignored it; the
    // partial bytes are then garbage and must be discarded.
    const resuming = start > 0 && response.status === 206
    if (!response.ok && response.status !== 206) {
      return { ok: false, status: response.status, written: 0, error: `HTTP ${response.status}` }
    }
    if (!resuming && start > 0) {
      await fsp.rm(part, { force: true })
      start = 0
    }
    if (!response.body) {
      return { ok: false, status: response.status, written: 0, error: 'empty body' }
    }
    const handle = await fsp.open(part, resuming ? 'r+' : 'w')
    try {
      let position = resuming ? start : 0
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        await handle.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength), 0, value.byteLength, position)
        position += value.byteLength
        written += value.byteLength
        onBytes(value.byteLength)
      }
    } finally {
      await handle.close()
    }
    const size = (await fsp.stat(part)).size
    if (expected > 0 && size !== expected) {
      return { ok: false, status: response.status, written, error: `size ${size} != expected ${expected}` }
    }
    await fsp.rename(part, dest)
    return { ok: true, status: response.status, written, error: '' }
  } catch (error) {
    return { ok: false, status: 0, written, error: String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** Unpack with the system tar: macOS/Linux ship bsdtar/GNU tar, Windows 10+ ships bsdtar. */
function extract(archive: string, destDir: string, flags: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('tar', [...flags, archive, '-C', destDir], { stdio: 'ignore', windowsHide: true })
    } catch (error) {
      log('warn', 'cannot launch tar', String(error))
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* gone */
      }
      resolve(false)
    }, 180_000)
    timer.unref?.()
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await fsp.stat(file)).size
  } catch {
    return 0
  }
}

/**
 * Fallback path: the upstream k2-fsa release ships everything except the
 * vocoder in one .tar.bz2. Slower from some networks, but it is a plain GitHub
 * asset that works wherever ModelScope does not.
 */
async function installFromGithub(onProgress: (p: DownloadProgress) => void): Promise<boolean> {
  const tmp = path.join(matchaDir, '.bundle')
  await fsp.mkdir(tmp, { recursive: true })
  const bundle = path.join(tmp, 'matcha-icefall-zh-en.tar.bz2')
  const vocoder = path.join(matchaDir, 'vocos-16khz-univ.onnx')

  const vocoderSpec = MODEL_FILES.find((f) => f.name === 'vocos-16khz-univ.onnx')
  const bundleResult = await fetchFile(GITHUB_BUNDLE, bundle, 0, (n) =>
    onProgress({ received: n, total: 0, file: 'matcha-icefall-zh-en.tar.bz2' })
  )
  if (!bundleResult.ok) {
    log('warn', 'github bundle download failed', bundleResult.error)
    return false
  }
  if (vocoderSpec && (await sizeOf(vocoder)) !== vocoderSpec.bytes) {
    const voc = await fetchFile(GITHUB_VOCODER, vocoder, vocoderSpec.bytes, (n) =>
      onProgress({ received: n, total: vocoderSpec.bytes, file: 'vocos-16khz-univ.onnx' })
    )
    if (!voc.ok) {
      log('warn', 'github vocoder download failed', voc.error)
      return false
    }
  }
  if (!(await extract(bundle, tmp, ['-xjf']))) return false

  const inner = path.join(tmp, 'matcha-icefall-zh-en')
  if (!(await exists(inner))) return false
  // Flatten the bundle into the model dir, keeping the vocoder we fetched.
  for (const entry of await fsp.readdir(inner)) {
    const from = path.join(inner, entry)
    const to = path.join(matchaDir, entry)
    if (entry === 'vocos-16khz-univ.onnx' && (await sizeOf(to)) > 0) continue
    await fsp.rm(to, { recursive: true, force: true })
    await fsp.rename(from, to).catch(async () => {
      await fsp.cp(from, to, { recursive: true })
    })
  }
  await fsp.rm(tmp, { recursive: true, force: true })
  return exists(path.join(matchaDir, ESPEAK_MARKER))
}

async function unpackEspeak(): Promise<boolean> {
  const archive = path.join(matchaDir, 'espeak-ng-data.tar.gz')
  if (await exists(path.join(matchaDir, ESPEAK_MARKER))) return true
  if (!(await exists(archive))) return false
  if (!(await extract(archive, matchaDir, ['-xzf']))) return false
  const ok = await exists(path.join(matchaDir, ESPEAK_MARKER))
  if (ok) {
    // 9MB of tarball with nothing left to do; the extracted tree is the source.
    await fsp.rm(archive, { force: true }).catch(() => undefined)
  }
  return ok
}

/**
 * Make sure the weights are on disk. Idempotent, resumable, and safe to call
 * concurrently (a second caller joins the in-flight promise instead of racing
 * two downloads into the same directory).
 */
let ensurePromise: Promise<boolean> | null = null

export function ensureModels(onProgress?: (p: DownloadProgress) => void): Promise<boolean> {
  if (ensurePromise) return ensurePromise
  ensurePromise = doEnsure(onProgress).finally(() => {
    ensurePromise = null
  })
  return ensurePromise
}

async function doEnsure(onProgress?: (p: DownloadProgress) => void): Promise<boolean> {
  if (await verified()) return true
  await fsp.mkdir(matchaDir, { recursive: true })
  setPhase('downloading')

  let received = 0
  for (const file of MODEL_FILES) {
    received += (await sizeOf(path.join(matchaDir, file.name))) === file.bytes ? file.bytes : 0
  }
  const report = (file: string, delta: number): void => {
    received = Math.min(MODEL_TOTAL_BYTES, received + delta)
    onProgress?.({ received, total: MODEL_TOTAL_BYTES, file })
  }

  const queue = [...MODEL_FILES]
  let failed = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const file = queue.shift()
      if (!file) return
      const dest = path.join(matchaDir, file.name)
      const partial = await sizeOf(`${dest}.part`)
      const have = await sizeOf(dest)
      const plan = planFile(file.bytes, have, partial)
      if (plan === 'keep') {
        report(file.name, file.bytes)
        continue
      }
      const result = await fetchFile(modelscopeUrl(file.name), dest, file.bytes, (n) => report(file.name, n))
      if (!result.ok) {
        failed += 1
        log('warn', `matcha: ${file.name} failed`, result.error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, worker))

  if (failed > 0) {
    log('info', 'matcha: falling back to the GitHub release bundle')
    if (!(await installFromGithub((p) => onProgress?.(p)))) {
      setPhase('error', 'model download failed on every source')
      return false
    }
  }
  setPhase('extracting')
  if (!(await unpackEspeak())) {
    log('warn', 'matcha: espeak-ng-data could not be unpacked')
    setPhase('error', 'espeak-ng-data could not be unpacked')
    return false
  }
  if (!(await verified())) {
    setPhase('error', 'downloaded files did not verify')
    return false
  }
  await writeManifest()
  return true
}

/** Every model file present at its exact size, plus the unpacked espeak tree. */
async function filesComplete(): Promise<boolean> {
  for (const file of MODEL_FILES) {
    if (file.name === 'espeak-ng-data.tar.gz') continue
    if ((await sizeOf(path.join(matchaDir, file.name))) !== file.bytes) return false
  }
  return exists(path.join(matchaDir, ESPEAK_MARKER))
}

/**
 * Is the install usable? A complete weights directory is enough on its own: the
 * manifest is only our own bookkeeping, and requiring it would make a directory
 * that was copied in by hand — or left behind by a run that died before writing
 * it — trigger a 134MB re-download every single launch. Adopting it writes the
 * manifest so later launches skip the size scan.
 */
export async function modelsInstalled(): Promise<boolean> {
  if (!(await filesComplete())) return false
  if (!(await exists(path.join(matchaDir, MANIFEST)))) {
    try {
      await writeManifest()
      log('info', 'matcha: adopted an existing weights directory', { dir: matchaDir })
    } catch (error) {
      // Read-only home: the weights still work, we just rescan them next boot.
      log('warn', 'matcha: could not write manifest', String(error))
    }
  }
  return true
}

async function verified(): Promise<boolean> {
  return modelsInstalled()
}

async function writeManifest(): Promise<void> {
  const files: Record<string, number> = {}
  for (const file of MODEL_FILES) {
    if (file.name === 'espeak-ng-data.tar.gz') continue
    files[file.name] = file.bytes
  }
  const manifest = { rev: MATCHA_REV, files, completedAt: new Date().toISOString() }
  const tmp = path.join(matchaDir, `${MANIFEST}.tmp`)
  await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2))
  await fsp.rename(tmp, path.join(matchaDir, MANIFEST))
}

/** Sweep `.part` files from an interrupted run; they are pure dead weight. */
export async function prunePartials(): Promise<void> {
  try {
    for (const entry of await fsp.readdir(matchaDir)) {
      if (!entry.endsWith('.part')) continue
      await fsp.rm(path.join(matchaDir, entry), { force: true }).catch(() => undefined)
    }
  } catch {
    /* directory does not exist yet */
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

let voice: NativeVoice | null = null
let voicePromise: Promise<NativeVoice | null> | null = null
let loadMs = 0
let fatalError = ''
let currentPhase: NeuralPhase = 'missing'

export function phase(): NeuralPhase {
  return currentPhase
}

function setPhase(next: NeuralPhase, error = ''): void {
  currentPhase = next
  if (error) fatalError = error
}

/** Inference threads for the acoustic model; the environment can override it. */
function matchaThreads(): number {
  const raw = Number(process.env.CODEWAIFU_MATCHA_THREADS || 2)
  return Number.isFinite(raw) && raw > 0 ? Math.min(8, Math.round(raw)) : 2
}

/**
 * Load the engine once, off the main thread. Concurrent callers share one
 * promise; a failed load is cached as null so every later notice falls back to
 * the OS voice immediately instead of retrying a 600ms load each time.
 */
export async function engine(): Promise<NativeVoice | null> {
  if (voice) return voice
  if (voicePromise) return voicePromise
  voicePromise = (async () => {
    setPhase('loading')
    const started = Date.now()
    try {
      voice = await openVoiceAsync({ dir: matchaDir, threads: matchaThreads() })
      loadMs = Date.now() - started
      setPhase('ready')
      log('info', 'matcha engine ready', {
        loadMs,
        sampleRate: voice.sampleRate,
        speakers: voice.numSpeakers
      })
      return voice
    } catch (error) {
      voice = null
      setPhase('error', String(error))
      log('warn', 'matcha engine failed to load', String(error))
      return null
    }
  })()
  return voicePromise
}

export function available(): boolean {
  return voice !== null
}

/**
 * Resolve the engine, bounded. Used before the launch greeting: loading takes
 * ~1.6s once the weights are on disk and much longer while they are still
 * downloading, and a line spoken during that window comes out in the OS voice.
 * Never throws and never waits longer than asked, so the worst case is a
 * greeting that falls back — not a greeting that never happens.
 */
export async function warm(timeoutMs: number): Promise<boolean> {
  if (voice) return true
  const budget = Math.max(0, Math.round(timeoutMs) || 0)
  const loaded = engine().then((loaded) => loaded !== null)
  if (budget === 0) return loaded
  return Promise.race([
    loaded,
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), budget)
      timer.unref?.()
    })
  ])
}

/**
 * Forget a failed bring-up so the next attempt really starts over. The cached
 * `null` engine and the sticky error string are what would otherwise make
 * "Retry" a no-op that reports the same failure instantly.
 */
export function resetForRetry(): void {
  fatalError = ''
  if (!voice) voicePromise = null
  currentPhase = 'missing'
}

export function status(received = 0, file = ''): NeuralStatus {
  const base = blankStatus(currentPhase, currentPhase === 'error' ? fatalError : '')
  return { ...base, received, file, sampleRate: voice?.sampleRate ?? 0, loadMs }
}

export function engineLoadMs(): number {
  return loadMs
}

export interface NeuralChunk {
  bytes: Uint8Array
  ms: number
}

/**
 * Synthesize one unit of text. Returns null when the engine is absent or the
 * call throws — the Speaker treats null as "use the OS voice".
 */
export async function synthesizeUnit(text: string, speed: number): Promise<NeuralChunk | null> {
  const clean = String(text || '').trim()
  if (!clean) return null
  const tts = await engine()
  if (!tts) return null
  const clamped = Number.isFinite(speed) ? Math.min(2, Math.max(0.5, speed)) : 1
  try {
    const audio = await tts.render(clean, clamped)
    if (!audio || audio.bytes.byteLength < 44 || audio.samples <= 0) return null
    return { bytes: audio.bytes, ms: wavMs(audio.samples, audio.sampleRate) }
  } catch (error) {
    log('warn', 'matcha synthesis failed', String(error))
    return null
  }
}

export function shutdown(): void {
  try {
    voice?.release()
  } catch {
    /* already gone */
  }
  voice = null
  voicePromise = null
}

/** Dev helper: forget the manifest so the next launch re-verifies the install. */
export async function resetInstall(): Promise<void> {
  shutdown()
  await fsp.rm(path.join(matchaDir, MANIFEST), { force: true }).catch(() => undefined)
  setPhase('missing')
}
