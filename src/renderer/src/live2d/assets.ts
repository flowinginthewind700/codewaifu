import { LIVE2D_CATALOG, LIVE2D_KEEP_URLS, type Live2DCharacter } from './catalog'

// ============================================================
// Electron port of robotworld's Live2D asset loader.
//
// Same contract as the web version (`live2dAsset(url)` -> bytes, `loadCubismCore()`
// -> Core registered on window) so `host.ts` is a byte-for-byte copy, but the
// transport differs: the web app reads from Cache Storage and falls back to the
// site CDN, while here every byte comes from the private `cw-asset:` scheme that
// the main process serves out of ~/.codewaifu/assets (downloading once, then
// offline forever). See main/assets.ts for why the binaries are not vendored.
// ============================================================

/** Origin of the private scheme; must match main/assets.ts. */
const ASSET_BASE = 'cw-asset://app'

export type Live2DProgress = { loaded: number; total: number }

const inflight = new Map<string, Promise<ArrayBuffer>>()

function absolute(url: string): string {
  if (/^[a-z-]+:\/\//i.test(url)) return url
  return `${ASSET_BASE}${url.startsWith('/') ? '' : '/'}${url}`
}

/**
 * Absolute `cw-asset:` URL for a catalog path. Model assembly goes through
 * `live2dAsset` (which resolves relative paths itself); this is for the plain
 * `<img>` cases — the character thumbs in Settings.
 */
export function assetUrl(url: string): string {
  return absolute(url)
}

/** Fetch one asset. Concurrent requests for the same URL share one promise. */
export function live2dAsset(url: string, onProgress?: (n: number) => void): Promise<ArrayBuffer> {
  const key = absolute(url)
  let promise = inflight.get(key)
  if (!promise) {
    promise = downloadAsset(key, onProgress)
    inflight.set(key, promise)
    // Do not keep a rejected promise around: a retry must hit the wire again.
    promise.catch(() => inflight.delete(key))
  }
  return promise
}

async function downloadAsset(key: string, onProgress?: (n: number) => void): Promise<ArrayBuffer> {
  const response = await fetch(key)
  if (!response.ok) throw new Error(`Live2D asset ${key}: HTTP ${response.status}`)
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength === 0) throw new Error(`Live2D asset ${key}: empty response`)
  onProgress?.(bytes.byteLength)
  return bytes
}

type CoreState = 'idle' | 'loading' | 'ready' | 'failed'
let coreState: CoreState = 'idle'
let corePromise: Promise<void> | null = null

function globalCore(): unknown {
  return (globalThis as { Live2DCubismCore?: unknown }).Live2DCubismCore
}

/**
 * Load the Cubism Core runtime (an Emscripten UMD bundle that registers
 * `window.Live2DCubismCore`). It must evaluate before the framework touches it,
 * and it is not an ES module, so it goes in through a blob <script> tag — the
 * renderer CSP allows `script-src 'self' blob:` for exactly this.
 */
export function loadCubismCore(): Promise<void> {
  if (globalCore()) {
    coreState = 'ready'
    return Promise.resolve()
  }
  if (corePromise) return corePromise
  coreState = 'loading'
  corePromise = (async () => {
    const bytes = await live2dAsset(LIVE2D_CATALOG.coreUrl)
    const text = new TextDecoder().decode(bytes)
    const blobUrl = URL.createObjectURL(new Blob([text], { type: 'application/javascript' }))
    try {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = blobUrl
        script.async = false
        script.onload = () => resolve()
        script.onerror = () => reject(new Error('Cubism Core script failed to load'))
        document.head.appendChild(script)
      })
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
    if (!globalCore()) throw new Error('Cubism Core did not register Live2DCubismCore')
    coreState = 'ready'
  })()
  corePromise.catch(() => {
    coreState = 'failed'
    corePromise = null
  })
  return corePromise
}

export function cubismCoreState(): CoreState {
  if (globalCore()) return 'ready'
  return coreState
}

/** Total bytes for a character including Core — the denominator of the progress bar. */
export function characterTotalBytes(character: Live2DCharacter): number {
  return character.bytes + LIVE2D_CATALOG.coreBytes
}

/** Every URL this build can ask for; used to prune stale cache entries. */
export const KNOWN_ASSET_URLS: readonly string[] = LIVE2D_KEEP_URLS

/**
 * Download all of a character's files (plus Core) concurrently. Prefetch and
 * model assembly share one `live2dAsset` cache, so a warm run costs nothing.
 */
export async function prefetchCharacter(
  character: Live2DCharacter,
  onProgress?: (progress: Live2DProgress) => void
): Promise<void> {
  const total = characterTotalBytes(character)
  let loaded = 0
  const bump = (n: number): void => {
    loaded += n
    onProgress?.({ loaded: Math.min(loaded, total), total })
  }
  const jobs = [
    loadCubismCore().then(() => bump(LIVE2D_CATALOG.coreBytes)),
    ...character.files.map((file) => live2dAsset(file.url, bump))
  ]
  await Promise.all(jobs)
}

export function findCharacter(id: string): Live2DCharacter | undefined {
  return LIVE2D_CATALOG.characters.find((c) => c.id === id)
}

export function defaultCharacter(): Live2DCharacter {
  return LIVE2D_CATALOG.characters[0]
}
