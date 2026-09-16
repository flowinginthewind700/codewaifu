import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HARNESS = fileURLToPath(new URL('../tests/installWindows.ps1', import.meta.url))

/**
 * pwsh is preinstalled on the Windows runner and optional everywhere else. Each
 * scenario runs install.ps1 in a child process with Invoke-RestMethod,
 * Invoke-WebRequest and Start-Process stubbed, so what is under test is the
 * installer's own branching rather than GitHub's answers.
 */
const pwsh = process.env.PWSH ?? 'pwsh'
const hasPwsh =
  spawnSync(pwsh, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
    .status === 0

const SCENARIOS = [
  'setup-preferred',
  'portable-only',
  'foreign-only',
  'no-release',
  'missing-tag',
  'download-fails',
  'from-build-dir',
  'from-missing',
  'hooks-only',
  'uninstall',
  'uninstall-purge',
  'uninstall-nothing'
]

describe.skipIf(!hasPwsh)('install.ps1', () => {
  for (const scenario of SCENARIOS) {
    // The first pwsh spawn on a shared runner cold-starts past vitest's default
    // 5s (the linux job died exactly there), while later scenarios land in ~2s.
    // The child is already bounded by spawnSync's own timeout, so give the test
    // layer the same ceiling instead of racing a cold PowerShell.
    it(scenario, () => {
      const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', HARNESS, scenario], {
        encoding: 'utf8',
        timeout: 120_000
      })
      const detail = [result.stdout, result.stderr].filter(Boolean).join(String.fromCharCode(10))
      expect(result.status, detail).toBe(0)
    }, 120_000)
  }
})
