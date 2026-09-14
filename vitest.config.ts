import os from 'node:os'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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
