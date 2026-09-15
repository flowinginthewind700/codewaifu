#!/usr/bin/env node
/**
 * `codewaifu` on the PATH. A thin launcher: it finds the installed desktop app
 * and re-executes it with `--cli`, so hook merging, TTS and status live in one
 * tested implementation (src/main/cli.ts) instead of a second copy here.
 *
 * Resolution order:
 *   1. $CODEWAIFU_APP            explicit binary path (used by install.sh and CI)
 *   2. the packaged app          /Applications, ~/Applications, %LOCALAPPDATA%
 *   3. a repo checkout           node_modules/.bin/electron . (dev only)
 *
 * On Linux the candidates come in pairs: `AppRun` before `codewaifu`. AppRun is
 * electron-builder's own launcher and it probes for unprivileged user namespaces
 * at every start, adding --no-sandbox when the kernel or AppArmor refuses them.
 * Ubuntu 24.04+ refuses them for any binary without an AppArmor profile, and
 * Chromium then aborts *before the Node main bundle loads*, so this is the one
 * platform decision that cannot be made from inside the app.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

function packagedCandidates() {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return [
      '/Applications/CodeWaifu.app/Contents/MacOS/CodeWaifu',
      path.join(home, 'Applications', 'CodeWaifu.app', 'Contents', 'MacOS', 'CodeWaifu')
    ]
  }
  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    return roots.filter(Boolean).map((root) => path.join(root, 'Programs', 'CodeWaifu', 'CodeWaifu.exe'))
  }
  return [
    // A user-space install first: it is what scripts/install.sh writes, and a
    // machine can legitimately have both it and a root-installed deb.
    ...linuxPair(path.join(home, '.local', 'share', 'CodeWaifu')),
    ...linuxPair('/opt/CodeWaifu'),
    ...linuxPair(path.join(home, 'Applications', 'CodeWaifu'))
  ]
}

function linuxPair(root) {
  return [path.join(root, 'AppRun'), path.join(root, 'codewaifu')]
}

/**
 * Does this binary need `--no-sandbox`? True only when the installer's
 * empirical launch probe left a marker beside it, or the operator asked.
 * AppRun never needs it from us — it does the same check itself, at every
 * start, and would see the flag twice.
 */
function linuxSandboxFlags(binary) {
  if (process.platform !== 'linux') return []
  const env = (name) => String(process.env[name] ?? '').trim().toLowerCase()
  const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(value)
  if (truthy(env('CODEWAIFU_SANDBOX'))) return []
  if (truthy(env('CODEWAIFU_NO_SANDBOX')) || truthy(env('ELECTRON_DISABLE_SANDBOX'))) {
    return ['--no-sandbox']
  }
  if (path.basename(binary) === 'AppRun') return []
  const marker = path.join(path.dirname(binary), '.no-sandbox')
  return fs.existsSync(marker) ? ['--no-sandbox'] : []
}

function resolveBinary() {
  const forced = process.env.CODEWAIFU_APP
  if (forced && fs.existsSync(forced)) return forced
  for (const candidate of packagedCandidates()) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function devLauncher() {
  const electron = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')
  if (fs.existsSync(electron) && fs.existsSync(path.join(repoRoot, 'out', 'main', 'index.js'))) {
    return { bin: electron, prefix: [repoRoot] }
  }
  return null
}

const args = process.argv.slice(2)
const withCli = args.includes('--cli') ? args : ['--cli', ...args]

const binary = resolveBinary()
if (binary) {
  const result = spawnSync(binary, [...withCli, ...linuxSandboxFlags(binary)], { stdio: 'inherit' })
  if (result.error) {
    process.stderr.write(`codewaifu: failed to launch ${binary}: ${result.error.message}\n`)
    process.exit(1)
  }
  process.exit(result.status ?? 0)
}

const dev = devLauncher()
if (dev) {
  const result = spawnSync(dev.bin, [...dev.prefix, ...withCli], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

process.stderr.write(
  [
    'codewaifu: no CodeWaifu app found on this machine.',
    '',
    'Install it with one line:',
    '  macOS / Linux : curl -fsSL https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/scripts/install.sh | bash',
    '  Windows       : irm https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/scripts/install.ps1 | iex',
    ''
  ].join('\n')
)
process.exit(3)
