import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The main bundle is ESM (package `"type": "module"`), so `__dirname` does not
 * exist; `import.meta.dirname` is present on every Node/Electron we support but
 * the URL fallback keeps older runtimes working.
 */
const metaDir = (import.meta as { dirname?: string }).dirname
export const here = typeof metaDir === 'string' && metaDir ? metaDir : path.dirname(fileURLToPath(import.meta.url))
