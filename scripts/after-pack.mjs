import fs from 'node:fs'
import path from 'node:path'

// ============================================================
// Drop the native packages that belong to *another* architecture.
//
// Why this exists: `npm install` on an Apple Silicon laptop leaves both
// `sherpa-onnx-darwin-arm64` and `-darwin-x64` in node_modules (the x64 one
// arrives when a contributor builds the Intel zip), and electron-builder's
// node-module collector takes whatever it finds on disk rather than filtering
// by the target arch. The result is an arm64 dmg carrying 36MB of Intel
// dylibs it can never load — and worse, a reader of the bundle cannot tell
// which copy is live.
//
// `${arch}` in a `files` pattern is not substituted the way one would hope, so
// the pruning happens here, after the app directory is assembled and before
// the dmg/zip/installer is made from it. Only `app.asar.unpacked` is touched:
// these are binaries, they are never inside the archive.
// ============================================================

/** electron-builder's `Arch` enum, mirrored so the hook has no imports. */
export const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

/** sherpa spells Windows `win`; node and koffi spell it `win32`. */
const PLATFORM_ALIAS = { win: 'win32', mac: 'darwin', macos: 'darwin', windows: 'win32' }

/** `sherpa-onnx-<os>-<arch>` and `@koromix/koffi-<os>-<arch>`, or null. */
function parseNativePackage(entry) {
  const match = /^(?:sherpa-onnx|koffi)-([a-z0-9]+)-([a-z0-9]+)$/.exec(entry)
  if (!match) return null
  const platform = PLATFORM_ALIAS[match[1]] ?? match[1]
  return { platform, arch: match[2] }
}

/**
 * Which of `entries` is a native package for a different platform/arch than the
 * one being packaged. Packages we do not recognise are never listed, so an
 * unrelated `sherpa-onnx-node` or a future dependency survives untouched.
 */
export function foreignNativePackages(entries, platform, arch) {
  const wanted = { platform: PLATFORM_ALIAS[platform] ?? platform, arch }
  const out = []
  for (const entry of entries) {
    const parsed = parseNativePackage(entry)
    if (!parsed) continue
    if (parsed.platform === wanted.platform && parsed.arch === wanted.arch) continue
    out.push(entry)
  }
  return out
}

/** Every `app.asar.unpacked/node_modules` under the packed app, whatever the OS layout. */
export function unpackedModuleDirs(appOutDir) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name === 'app.asar.unpacked') {
        const modules = path.join(full, 'node_modules')
        if (fs.existsSync(modules)) found.push(modules)
        continue
      }
      walk(full, depth + 1)
    }
  }
  walk(appOutDir, 0)
  return found
}

/** Scoped directories that can hold a per-platform binary package. */
const SCOPES = ['@koromix']

function remove(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

export default async function afterPack(context) {
  const arch = ARCH_NAMES[context.arch] ?? ''
  // A universal mac build needs both halves; there is nothing foreign in it.
  if (!arch || arch === 'universal') return
  const platform = context.packager.platform.name === 'mac' ? 'darwin' : context.packager.platform.name

  let removed = 0
  for (const modules of unpackedModuleDirs(context.appOutDir)) {
    const scopes = ['', ...SCOPES]
    for (const scope of scopes) {
      const dir = scope ? path.join(modules, scope) : modules
      let entries = []
      try {
        entries = fs.readdirSync(dir)
      } catch {
        continue
      }
      for (const entry of foreignNativePackages(entries, platform, arch)) {
        if (remove(path.join(dir, entry))) removed += 1
      }
      // An emptied scope directory is just noise in the bundle listing.
      if (scope) {
        try {
          if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
        } catch {
          /* not empty, or already gone */
        }
      }
    }
  }
  if (removed > 0) {
    console.log(`after-pack: dropped ${removed} foreign-arch native package(s) for ${platform}-${arch}`)
  }
}
