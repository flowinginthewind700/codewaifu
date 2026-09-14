// Types for `scripts/after-pack.mjs`, which stays plain JavaScript because
// electron-builder loads it directly from disk at package time.

/** electron-builder's `Arch` enum, as the string names it hands back. */
export declare const ARCH_NAMES: readonly string[]

/** Which of `entries` is a native package built for some other target. */
export declare function foreignNativePackages(
  entries: readonly string[],
  platform: string,
  arch: string
): string[]

/** Every `app.asar.unpacked/node_modules` under a packed app directory. */
export declare function unpackedModuleDirs(appOutDir: string): string[]

/** The subset of electron-builder's `AfterPackContext` the hook reads. */
export interface PackContext {
  appOutDir: string
  arch: number
  packager: { platform: { name: string } }
}

export default function afterPack(context: PackContext): Promise<void>
