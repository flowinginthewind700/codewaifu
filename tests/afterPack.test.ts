import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import afterPack, {
  ARCH_NAMES,
  foreignNativePackages,
  unpackedModuleDirs
} from '../scripts/after-pack.mjs'

// ============================================================
// The hook is what keeps an arm64 dmg from shipping 36MB of Intel dylibs, and
// the failure mode of getting it wrong is silent: the app still runs, it just
// carries dead weight — or, if the filter is too greedy, loses the binary it
// does need and falls back to the OS voice.
// ============================================================

const SCRATCH: string[] = []

function tree(layout: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-afterpack-'))
  SCRATCH.push(root)
  for (const entry of layout) {
    const full = path.join(root, entry)
    if (entry.endsWith('/')) {
      fs.mkdirSync(full, { recursive: true })
    } else {
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, 'x')
    }
  }
  return root
}

afterAll(() => {
  for (const dir of SCRATCH) fs.rmSync(dir, { recursive: true, force: true })
})

describe('foreignNativePackages', () => {
  const entries = [
    'sherpa-onnx-darwin-arm64',
    'sherpa-onnx-darwin-x64',
    'sherpa-onnx-win-x64',
    'sherpa-onnx-node',
    'koffi-darwin-arm64',
    'koffi-win32-x64',
    'lucide-react'
  ]

  it('keeps only the target arch and never touches anything else', () => {
    expect(foreignNativePackages(entries, 'darwin', 'arm64')).toEqual([
      'sherpa-onnx-darwin-x64',
      'sherpa-onnx-win-x64',
      'koffi-win32-x64'
    ])
  })

  it('understands sherpa\'s `win` spelling and node\'s `win32`', () => {
    expect(foreignNativePackages(entries, 'win32', 'x64')).toEqual([
      'sherpa-onnx-darwin-arm64',
      'sherpa-onnx-darwin-x64',
      'koffi-darwin-arm64'
    ])
    // The hook is handed electron-builder's platform name, which is `windows`.
    expect(foreignNativePackages(entries, 'windows', 'x64')).toEqual(
      foreignNativePackages(entries, 'win32', 'x64')
    )
  })

  it('leaves the JS front and ordinary dependencies alone', () => {
    const doomed = foreignNativePackages(entries, 'darwin', 'arm64')
    expect(doomed).not.toContain('sherpa-onnx-node')
    expect(doomed).not.toContain('lucide-react')
  })

  it('names electron-builder\'s arch enum in order', () => {
    expect(ARCH_NAMES).toEqual(['ia32', 'x64', 'armv7l', 'arm64', 'universal'])
  })
})

describe('unpackedModuleDirs', () => {
  it('finds the mac and the win/linux layout', () => {
    const root = tree([
      'CodeWaifu.app/Contents/Resources/app.asar.unpacked/node_modules/koffi/index.cjs',
      'CodeWaifu.app/Contents/Resources/app.asar',
      'win/resources/app.asar.unpacked/node_modules/@koromix/koffi-win32-x64/index.js',
      'win/resources/app.asar'
    ])
    const found = unpackedModuleDirs(root).map((dir: string) => path.relative(root, dir)).sort()
    expect(found).toEqual([
      path.join('CodeWaifu.app/Contents/Resources/app.asar.unpacked/node_modules'),
      path.join('win/resources/app.asar.unpacked/node_modules')
    ])
  })

  it('is quiet about a directory with no asar at all', () => {
    expect(unpackedModuleDirs(tree(['out/main/index.js']))).toEqual([])
  })
})

describe('afterPack hook', () => {
  const macLayout = [
    'CodeWaifu.app/Contents/Resources/app.asar.unpacked/node_modules/sherpa-onnx-darwin-arm64/libsherpa-onnx-c-api.dylib',
    'CodeWaifu.app/Contents/Resources/app.asar.unpacked/node_modules/sherpa-onnx-darwin-x64/libsherpa-onnx-c-api.dylib',
    'CodeWaifu.app/Contents/Resources/app.asar.unpacked/node_modules/sherpa-onnx-node/package.json',
    'CodeWaifu.app/Contents/Resources/app.asar.unpacked/node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node',
    'CodeWaifu.app/Contents/Resources/app.asar.unpacked/node_modules/@koromix/koffi-darwin-x64/darwin_x64/koffi.node'
  ]

  it('prunes the other arch and keeps the target one', async () => {
    const appOutDir = tree(macLayout)
    const unpacked = path.join(
      appOutDir,
      'CodeWaifu.app/Contents/Resources/app.asar.unpacked/node_modules'
    )
    await afterPack({
      appOutDir,
      arch: ARCH_NAMES.indexOf('arm64'),
      packager: { platform: { name: 'mac' } }
    })
    expect(fs.existsSync(path.join(unpacked, 'sherpa-onnx-darwin-arm64'))).toBe(true)
    expect(fs.existsSync(path.join(unpacked, 'sherpa-onnx-darwin-x64'))).toBe(false)
    expect(fs.existsSync(path.join(unpacked, 'sherpa-onnx-node'))).toBe(true)
    expect(fs.existsSync(path.join(unpacked, '@koromix/koffi-darwin-arm64'))).toBe(true)
    expect(fs.existsSync(path.join(unpacked, '@koromix/koffi-darwin-x64'))).toBe(false)
  })

  it('removes an emptied @scope directory', async () => {
    const appOutDir = tree([
      'resources/app.asar.unpacked/node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node'
    ])
    await afterPack({
      appOutDir,
      arch: ARCH_NAMES.indexOf('x64'),
      packager: { platform: { name: 'windows' } }
    })
    const unpacked = path.join(appOutDir, 'resources/app.asar.unpacked/node_modules')
    expect(fs.existsSync(path.join(unpacked, '@koromix'))).toBe(false)
  })

  it('never prunes a universal build, which needs both halves', async () => {
    const appOutDir = tree(macLayout)
    await afterPack({
      appOutDir,
      arch: ARCH_NAMES.indexOf('universal'),
      packager: { platform: { name: 'mac' } }
    })
    const unpacked = path.join(
      appOutDir,
      'CodeWaifu.app/Contents/Resources/app.asar.unpacked/node_modules'
    )
    expect(fs.existsSync(path.join(unpacked, 'sherpa-onnx-darwin-x64'))).toBe(true)
    expect(fs.existsSync(path.join(unpacked, '@koromix/koffi-darwin-x64'))).toBe(true)
  })
})
