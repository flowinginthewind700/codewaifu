import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    build: {
      rollupOptions: {
        // Preload must stay CommonJS: it is the only entry Electron loads in a
        // sandboxed renderer, where ESM is unavailable.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        // Two windows, two documents: the desktop widget and the Bench. They
        // share tokens.css and the preload, and nothing else - the Bench must
        // not pay for the Live2D runtime, and the widget must not ship xterm.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          pro: resolve(__dirname, 'src/renderer/pro.html')
        }
      }
    }
  }
})
