/// <reference types="vite/client" />
import type { CodeWaifuApi } from '@shared/bridge'

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts through contextBridge. */
    codewaifu: CodeWaifuApi
  }
}

export {}
