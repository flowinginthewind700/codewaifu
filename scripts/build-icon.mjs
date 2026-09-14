#!/usr/bin/env node
/**
 * Regenerate the packaged app icon from `src/main/png.ts`: the same signed
 * distance painter that draws the tray icon at runtime, so the 16px menu bar
 * glyph and the 1024px Dock/Start menu icon are literally the same artwork.
 *
 * The source of truth stays text; only the artifact is binary.
 *
 *   node --experimental-strip-types scripts/build-icon.mjs [size] [out.png]
 *
 * Needs Node >=22.6 for `--experimental-strip-types` (default-on in 23+).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const size = Number(process.argv[2] || 1024)
const out = path.resolve(process.argv[3] || path.join(here, '..', 'build', 'icon.png'))

const { waifuIconPng } = await import('../src/main/png.ts')

fs.mkdirSync(path.dirname(out), { recursive: true })
const png = waifuIconPng(size)
fs.writeFileSync(out, png)

const kb = (png.length / 1024).toFixed(1)
process.stdout.write(`${out}  ${size}x${size}  ${kb} KB\n`)
