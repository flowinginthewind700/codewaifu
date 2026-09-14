// The catalog itself lives in `src/shared` so the main process can pre-warm the
// same asset list; this shim keeps the renderer's import paths unchanged.
export * from '@shared/live2dCatalog'
