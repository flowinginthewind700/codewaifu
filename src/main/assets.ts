import fs from 'node:fs/promises'
import path from 'node:path'
import { net, protocol } from 'electron'
import { assetRoot } from './env'
import { log } from './log'

// ============================================================
// Character assets (Cubism Core + Live2D models) are NOT vendored into this
// repo: Cubism Core ships under the Live2D Proprietary Software License and the
// characters under Live2D's free-material terms, so keeping the binaries out of
// the source tree keeps the repo unambiguous. They are fetched once from
// robotworld.top (immutable, one-year CDN cache, rev-versioned URLs) into
// ~/.codewaifu/assets and served to the renderer from there.
//
// The renderer reaches them through a private `cw-asset:` scheme rather than
// https:// so that (a) no CORS or network stack is involved at draw time,
// (b) the second launch is fully offline, and (c) the renderer can never be
// pointed at an arbitrary origin.
// ============================================================

export const ASSET_SCHEME = 'cw-asset'
export const ASSET_HOST = 'app'
/** Canonical origin for avatar assets. Overridable for testing/mirrors. */
export const ASSET_ORIGIN = process.env.CODEWAIFU_ASSET_ORIGIN || 'https://robotworld.top'

const DOWNLOAD_TIMEOUT_MS = 30_000
const inflight = new Map<string, Promise<Uint8Array>>()

/** Must run before `app.ready`; Electron rejects privileged schemes later. */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ])
}

/** `cw-asset://app/<path>` — the URL the renderer fetches. */
export function assetUrl(assetPath: string): string {
  const clean = String(assetPath || '').replace(/^\/+/, '')
  return `${ASSET_SCHEME}://${ASSET_HOST}/${clean}`
}

function cachePathFor(rel: string): string | null {
  const normalized = path.normalize(decodeURIComponent(rel)).replace(/^([/\\])+/, '')
  const root = assetRoot
  const full = path.join(root, normalized)
  // Path traversal guard: a crafted URL must never escape the asset root.
  if (full !== root && !full.startsWith(root + path.sep)) return null
  if (path.sep !== '/' && full.includes('\0')) return null
  return full
}

async function download(rel: string): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  timer.unref?.()
  try {
    const response = await net.fetch(`${ASSET_ORIGIN}/${rel.replace(/^\/+/, '')}`, {
      signal: controller.signal,
      bypassCustomProtocolHandlers: true
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${rel}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0) throw new Error(`empty response for ${rel}`)
    return buffer
  } finally {
    clearTimeout(timer)
  }
}

/** Cache-first read; on a miss download once and store atomically. */
async function resolve(rel: string): Promise<Uint8Array> {
  const file = cachePathFor(rel)
  if (!file) throw new Error(`refusing to serve ${rel}`)
  try {
    const stat = await fs.stat(file)
    if (stat.isFile() && stat.size > 0) return await fs.readFile(file)
  } catch {
    /* miss: fall through to the network */
  }

  const key = path.normalize(rel)
  const pending = inflight.get(key)
  if (pending) return pending
  const job = (async (): Promise<Uint8Array> => {
    const bytes = await download(rel)
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.part`
      await fs.writeFile(tmp, bytes)
      await fs.rename(tmp, file)
    } catch (error) {
      // A read-only home must not be fatal: serve the bytes anyway.
      log('warn', 'could not cache avatar asset', { rel, error: String(error) })
    }
    return bytes
  })()
  inflight.set(key, job)
  try {
    return await job
  } finally {
    inflight.delete(key)
  }
}

export function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const url = new URL(request.url)
    const rel = url.pathname
    try {
      const bytes = await resolve(rel)
      // `BodyInit` is a DOM lib type and the main process compiles without DOM;
      // name the Response parameter type instead of the global.
      return new Response(bytes as unknown as ConstructorParameters<typeof Response>[0], {
        status: 200,
        headers: {
          'Content-Type': contentTypeFor(rel),
          'Content-Length': String(bytes.byteLength),
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch (error) {
      log('warn', 'avatar asset unavailable', { rel, error: String(error) })
      return new Response(JSON.stringify({ ok: false, error: String(error) }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }
  })
}

function contentTypeFor(rel: string): string {
  const ext = path.extname(rel).toLowerCase()
  switch (ext) {
    case '.js':
      return 'application/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.webp':
      return 'image/webp'
    case '.png':
      return 'image/png'
    case '.moc3':
      return 'application/octet-stream'
    default:
      return 'application/octet-stream'
  }
}

/**
 * Warm the cache in the background so the first companion render is instant.
 * Best-effort and never awaited by startup: offline users simply fall back to
 * the built-in avatar.
 */
export function prewarmAssets(paths: readonly string[]): void {
  if (paths.length === 0) return
  void (async () => {
    try {
      await fs.mkdir(assetRoot, { recursive: true })
    } catch {
      return
    }
    let ok = 0
    // Small worker pool: a serial walk over ~40 motion files would take seconds
    // on a cold CDN, and full parallelism would open 40 sockets for no reason.
    const queue = [...paths]
    const worker = async (): Promise<void> => {
      for (;;) {
        const rel = queue.shift()
        if (!rel) return
        try {
          await resolve(rel)
          ok += 1
        } catch (error) {
          log('warn', 'avatar prewarm failed', { rel, error: String(error) })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, paths.length) }, worker))
    if (ok > 0) log('info', 'avatar assets ready', { count: ok, total: paths.length })
  })()
}
