/**
 * The one module that hands Electron's keychain to the rest of main.
 *
 * `safeStorage` is the platform facility behind it: Keychain on macOS, DPAPI on
 * Windows, the login keyring on Linux. Everything that wants to keep a secret
 * takes a `SecretCipher` instead of importing Electron, so the policy stays
 * unit-testable and `pro/service.ts` stays free of Electron as it declares
 * itself to be. This file is the only place the two meet.
 *
 * Returns null when the app cannot reach `safeStorage` at all - a headless run,
 * or a Linux session with no keyring - and the store then refuses to write
 * rather than keeping a plaintext password on disk.
 */
import { safeStorage } from 'electron'
import type { SecretCipher } from './pro/secrets'

export function safeStorageCipher(): SecretCipher | null {
  try {
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') return null
    return {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (plain) => safeStorage.encryptString(plain),
      decryptString: (cipher) => safeStorage.decryptString(cipher)
    }
  } catch {
    return null
  }
}
