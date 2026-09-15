import os from 'node:os'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The renderer's own alias, mirrored from electron.vite.config.ts. A test that
  // mounts a pro component pulls in `@shared/lang` and `@shared/renderFault`
  // exactly the way the bundle does, and without this the import fails to
  // resolve at runtime - a red test that says nothing about the component.
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared')
    }
  },
  esbuild: {
    // `.tsx` tests sit outside both tsconfig projects (node covers `tests/**/*.ts`,
    // web covers the sources), so esbuild cannot discover `react-jsx` from a
    // tsconfig and would emit `React.createElement` for a file that never
    // imports React.
    jsx: 'automatic'
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Tests must never read or write the developer's real ~/.codewaifu,
    // ~/.codex or ~/.claude: `env.ts` resolves every path at import time, so
    // redirecting the state dir here is what keeps a test run side-effect free.
    env: {
      CODEWAIFU_HOME: path.join(os.tmpdir(), 'codewaifu-vitest-home'),
      // Same rule for the agents' own homes: `transcript.ts` and `threads.ts`
      // read `CODEX_HOME` / `CLAUDE_CONFIG_DIR` through env.ts, so pointing them
      // at empty temp dirs is what lets a test lay out a fake session tree (and
      // stops a hooks test from ever touching a real ~/.codex/hooks.json).
      CODEX_HOME: path.join(os.tmpdir(), 'codewaifu-vitest-codex'),
      CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'codewaifu-vitest-claude'),
      CODEWAIFU_NO_LOG: '1'
    }
  }
})
