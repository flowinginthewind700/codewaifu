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
      CODEWAIFU_NO_LOG: '1'
    }
  }
})
