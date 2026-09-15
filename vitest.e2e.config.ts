import path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * The smoke config, separate from `vitest.config.ts` on purpose.
 *
 * These tests launch Electron against the built bundle, so they need a build, a
 * display and tens of seconds - none of which belong in the suite that runs
 * before every commit. The include pattern is disjoint from the unit one
 * (`*.e2e.ts` vs `*.test.ts`), so neither run can pick the other's files up.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.ts'],
    // A cold Electron plus a first React mount, with room for a slow disk.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One app at a time: two instances would fight over the tray, the display
    // and any port the relay picks.
    fileParallelism: false
  }
})
