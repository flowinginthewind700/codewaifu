#!/usr/bin/env node
// ============================================================
// Make sure the native runtime for every target we are about to build is
// present in node_modules: the sherpa-onnx binary package (which carries
// `libsherpa-onnx-c-api`, the library the Matcha voice is driven through) and
// the matching `@koromix/koffi-*` prebuilt that loads it.
//
// Why this exists: `sherpa-onnx-node` is only a JS front. The actual addon is
// an optionalDependency per platform/arch, and npm installs *only* the one
// matching the machine it runs on. So building a mac x64 zip from an Apple
// Silicon laptop — or a Windows installer from CI's mac runner — silently
// produces an app whose neural voice cannot load. That failure is quiet by
// design (every line degrades to the OS voice), which is exactly how a wrong
// timbre ships.
// The same is true of koffi, whose binary also arrives as a per-platform
// optionalDependency (`@koromix/koffi-darwin-arm64`, `@koromix/koffi-win32-x64`).
//
// electron-builder.yml selects these directories per target, so installing the
// package is all that is needed; a pattern that matches nothing simply
// contributes nothing.
//
// Usage:
//   node scripts/ensure-voice-runtime.mjs darwin arm64 x64
//   node scripts/ensure-voice-runtime.mjs win x64
//   node scripts/ensure-voice-runtime.mjs            # this machine only
// ============================================================
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/** sherpa names Windows packages `win`, not node's `win32`. */
const PLATFORM_ALIAS = { win32: 'win', mac: 'darwin', macos: 'darwin', windows: 'win' }
const ARCH_ALIAS = { arm: 'arm64', x86: 'ia32', universal: 'arm64' }

function normalizePlatform(value) {
  const key = String(value || '').toLowerCase()
  return PLATFORM_ALIAS[key] ?? key
}

/** koffi's packages use node's own platform spelling, so `win` has to go back. */
function koffiPlatform(platform) {
  return platform === 'win' ? 'win32' : platform
}

function normalizeArch(value) {
  const key = String(value || '').toLowerCase()
  return ARCH_ALIAS[key] ?? key
}

/** The version the JS front was installed at; the binaries must match it. */
function sherpaVersion() {
  try {
    return require('sherpa-onnx-node/package.json').version
  } catch {
    return null
  }
}

/** koffi's native side is versioned in lockstep with the JS side. */
function koffiVersion() {
  // Not `require('koffi/package.json')`: koffi's `exports` map does not expose
  // it, so the manifest has to be read off disk.
  try {
    const manifest = path.join(root, 'node_modules', 'koffi', 'package.json')
    return JSON.parse(readFileSync(manifest, 'utf8')).version ?? null
  } catch {
    return null
  }
}

/** The addon binary is the only file whose presence proves a usable install. */
function addonPath(platform, arch) {
  return path.join(root, 'node_modules', `sherpa-onnx-${platform}-${arch}`, 'sherpa-onnx.node')
}

/** `@koromix/koffi-<platform>-<arch>/<platform>_<abi>/koffi.node`. */
function koffiAddonPath(platform, arch) {
  const name = koffiPlatform(platform)
  return path.join(root, 'node_modules', '@koromix', `koffi-${name}-${arch}`, `${name}_${arch}`, 'koffi.node')
}

function install(spec) {
  // --force is what lets npm ignore its own os/cpu check: the whole point here
  // is fetching a binary for a platform this machine is not. --no-save keeps
  // package.json honest, since these are already optionalDependencies.
  const result = spawnSync('npm', ['install', spec, '--no-save', '--force', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  return result.status === 0
}

/** Install one native package if its proof-of-life file is missing. */
function ensure(spec, probe, label) {
  if (existsSync(probe)) {
    console.log(`ensure-voice-runtime: ${label} present`)
    return true
  }
  console.log(`ensure-voice-runtime: installing ${spec}`)
  if (!install(spec)) {
    console.error(`ensure-voice-runtime: could not install ${spec}`)
    return false
  }
  if (!existsSync(probe)) {
    console.error(`ensure-voice-runtime: ${spec} installed without ${path.basename(probe)}`)
    return false
  }
  return true
}

function main() {
  const argv = process.argv.slice(2)
  let platform = normalizePlatform(process.platform)
  let arches = []

  if (argv.length > 0) {
    platform = normalizePlatform(argv[0])
    arches = argv.slice(1).map(normalizeArch)
  }
  if (arches.length === 0) arches = [normalizeArch(process.arch)]

  const version = sherpaVersion()
  if (!version) {
    console.error('ensure-voice-runtime: sherpa-onnx-node is not installed; run npm install first')
    process.exit(1)
  }
  const ffiVersion = koffiVersion()
  if (!ffiVersion) {
    console.error('ensure-voice-runtime: koffi is not installed; run npm install first')
    process.exit(1)
  }

  let failed = false
  for (const arch of arches) {
    const sherpa = `sherpa-onnx-${platform}-${arch}`
    if (!ensure(`${sherpa}@${version}`, addonPath(platform, arch), sherpa)) failed = true
    const ffi = `@koromix/koffi-${koffiPlatform(platform)}-${arch}`
    if (!ensure(`${ffi}@${ffiVersion}`, koffiAddonPath(platform, arch), ffi)) failed = true
  }

  if (failed) {
    // Fail the build rather than ship an app whose voice silently degrades.
    process.exit(1)
  }
}

main()
