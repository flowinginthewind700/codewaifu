import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  libraryCandidates,
  libraryName,
  matchaConfig,
  moduleRoots,
  openVoice,
  platformPackageName,
  resolveLibrary,
  RULE_FSTS,
  unpackedFromAsar
} from '../src/main/matchaNative'

// ============================================================
// The Matcha binding is the difference between the companion sounding like
// robotworld and sounding like `say`. These tests cover two things: the pure
// resolution/config helpers that decide *which* library and *which* settings
// are used, and — whenever this machine really has both the native library and
// the 134MB of weights — one actual synthesis, which is the only check that can
// catch an ABI drift.
// ============================================================

describe('library resolution', () => {
  it('names the C API library per platform', () => {
    expect(libraryName('darwin')).toBe('libsherpa-onnx-c-api.dylib')
    expect(libraryName('win32')).toBe('sherpa-onnx-c-api.dll')
    expect(libraryName('linux')).toBe('libsherpa-onnx-c-api.so')
  })

  it('uses sherpa\'s own platform spelling, not node\'s', () => {
    // sherpa publishes `sherpa-onnx-win-x64`, never `-win32-`.
    expect(platformPackageName('win32', 'x64')).toBe('sherpa-onnx-win-x64')
    expect(platformPackageName('darwin', 'arm64')).toBe('sherpa-onnx-darwin-arm64')
    expect(platformPackageName('linux', 'x64')).toBe('sherpa-onnx-linux-x64')
  })

  it('rewrites an asar path to its unpacked sibling', () => {
    const packed = `${path.sep}Applications${path.sep}CodeWaifu.app${path.sep}Contents${path.sep}Resources${path.sep}app.asar${path.sep}node_modules${path.sep}x`
    expect(unpackedFromAsar(packed)).toBe(packed.replace('app.asar', 'app.asar.unpacked'))
    // Outside an asar (dev, or already unpacked) nothing moves.
    expect(unpackedFromAsar(path.join('a', 'b', 'node_modules', 'x'))).toBe(
      path.join('a', 'b', 'node_modules', 'x')
    )
    expect(unpackedFromAsar(`${path.sep}app.asar.unpacked${path.sep}node_modules`)).toBe(
      `${path.sep}app.asar.unpacked${path.sep}node_modules`
    )
  })

  it('probes the bundled node_modules and the cwd, deduplicated', () => {
    const here = path.join('/fake/out/main')
    const roots = moduleRoots(here)
    expect(roots[0]).toBe(path.join('/fake/node_modules'))
    expect(new Set(roots).size).toBe(roots.length)
  })

  it('builds one candidate per module root', () => {
    const roots = ['/a/node_modules', '/b/node_modules']
    expect(libraryCandidates('darwin', 'arm64', roots)).toEqual([
      '/a/node_modules/sherpa-onnx-darwin-arm64/libsherpa-onnx-c-api.dylib',
      '/b/node_modules/sherpa-onnx-darwin-arm64/libsherpa-onnx-c-api.dylib'
    ])
  })

  it('finds the library this machine actually ships', () => {
    const found = resolveLibrary()
    // A dev checkout on darwin/win/linux has it; skip loudly otherwise.
    if (found === null) {
      expect(['darwin', 'win32', 'linux']).not.toContain(process.platform)
      return
    }
    expect(fs.statSync(found).isFile()).toBe(true)
    expect(found).toContain(platformPackageName())
  })
})

describe('matchaConfig', () => {
  const dir = path.join('/models', 'matcha')
  const config = matchaConfig({ dir, threads: 3 }) as {
    rule_fsts: string
    max_num_sentences: number
    silence_scale: number
    model: {
      num_threads: number
      provider: string
      matcha: Record<string, unknown>
    }
  }

  it('points at robotworld\'s weights and settings', () => {
    const matcha = config.model.matcha
    expect(matcha.acoustic_model).toBe(path.join(dir, 'model-steps-3.onnx'))
    expect(matcha.vocoder).toBe(path.join(dir, 'vocos-16khz-univ.onnx'))
    expect(matcha.data_dir).toBe(path.join(dir, 'espeak-ng-data'))
    // app/api/tts.py: noise_scale 0.667, length_scale 1.0, 1 sentence per pass.
    expect(matcha.noise_scale).toBeCloseTo(0.667)
    expect(matcha.length_scale).toBe(1.0)
    expect(config.max_num_sentences).toBe(1)
    expect(config.model.provider).toBe('cpu')
  })

  it('passes the three zh rule FSTs, comma joined in production order', () => {
    expect([...RULE_FSTS]).toEqual(['date-zh.fst', 'number-zh.fst', 'phone-zh.fst'])
    expect(config.rule_fsts.split(',')).toEqual(RULE_FSTS.map((name) => path.join(dir, name)))
  })

  it('clamps threads instead of handing sherpa a nonsense value', () => {
    const threads = (n: unknown): number =>
      (matchaConfig({ dir, threads: n as number }).model as { num_threads: number }).num_threads
    expect(threads(3)).toBe(3)
    expect(threads(0)).toBe(1)
    expect(threads(99)).toBe(8)
    expect(threads(2.4)).toBe(2)
    expect(threads(Number.NaN)).toBe(2)
  })

  it('populates every model family, because koffi rejects undefined strings', () => {
    // An `undefined` string is a koffi marshalling error, not a null pointer,
    // so a missing field would fail at create() time with no hint as to which.
    const walk = (value: unknown, where: string): void => {
      if (value === undefined) throw new Error(`undefined field at ${where}`)
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) walk(child, `${where}.${key}`)
      }
    }
    expect(() => walk(config, 'config')).not.toThrow()
    const families = config.model as unknown as Record<string, unknown>
    for (const key of ['vits', 'matcha', 'kokoro', 'kitten', 'zipvoice', 'pocket', 'supertonic']) {
      expect(families[key], key).toBeTypeOf('object')
    }
  })
})

// ---------------------------------------------------------------------------
// Real synthesis. Skipped unless both halves of the runtime are on disk, which
// keeps CI green while making the check meaningful on a developer machine.
// ---------------------------------------------------------------------------

const weightsDir =
  process.env.CODEWAIFU_MATCHA_DIR || path.join(os.homedir(), '.codewaifu', 'models', 'matcha')
const library = resolveLibrary()
const weightsReady =
  library !== null &&
  ['model-steps-3.onnx', 'vocos-16khz-univ.onnx', 'lexicon.txt', 'tokens.txt'].every((name) =>
    fs.existsSync(path.join(weightsDir, name))
  ) &&
  fs.existsSync(path.join(weightsDir, 'espeak-ng-data', 'phontab'))

describe.skipIf(!weightsReady)('live Matcha synthesis', () => {
  it(
    'renders a mixed zh/en line into a playable WAV, and the handle survives reuse',
    async () => {
      const voice = openVoice({ dir: weightsDir, threads: 2, library })
      try {
        // 16kHz is what the vocos-16khz vocoder emits; anything else means the
        // struct layout no longer matches the library.
        expect(voice.sampleRate).toBe(16_000)
        expect(voice.numSpeakers).toBeGreaterThanOrEqual(1)

        const first = await voice.render('paper-search 跑完了，共找到 12 篇 VLA 论文', 1)
        expect(first).not.toBeNull()
        const bytes = first!.bytes
        expect(Buffer.from(bytes).subarray(0, 4).toString('ascii')).toBe('RIFF')
        expect(Buffer.from(bytes).subarray(8, 12).toString('ascii')).toBe('WAVE')
        expect(bytes.byteLength).toBe(44 + first!.samples * 2)
        // ~2s of 16kHz mono is ~64KB; a struct mismatch shows up as noise here.
        expect(first!.samples).toBeGreaterThan(4_000)
        expect(first!.samples).toBeLessThan(16_000 * 60)

        const second = await voice.render('Done', 1)
        expect(second).not.toBeNull()
        expect(second!.sampleRate).toBe(16_000)
      } finally {
        voice.release()
      }
    },
    60_000
  )

  it('renders nothing for empty text and after release', async () => {
    const voice = openVoice({ dir: weightsDir, threads: 2, library })
    expect(await voice.render('   ', 1)).toBeNull()
    voice.release()
    voice.release() // idempotent
    expect(await voice.render('hello', 1)).toBeNull()
  }, 60_000)
})
