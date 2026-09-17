/**
 * The SSH roster's passwords, in the operating system's own keychain.
 *
 * Two rules shape this file, and both come from the fact that what is stored
 * here is the one thing in the app that can hand somebody a shell on a machine
 * that is not this one:
 *
 * - **The plaintext never reaches our disk.** `safeStorage` encrypts with the
 *   platform's own facility (Keychain on macOS, DPAPI on Windows, the login
 *   keyring on Linux); we keep the ciphertext and nothing else. When no such
 *   facility is available the store *refuses to write* rather than falling back
 *   to plaintext - "we could not save it" is an answer, "we saved it where
 *   anybody can read it" is a breach.
 * - **The secret is never handed to a caller that only asked whether it exists.**
 *   `has` answers the roster's badge, `get` is for the two places that actually
 *   need the bytes: typing the password into a prompt the human just opened,
 *   and answering an `SSH_ASKPASS` helper during a probe.
 *
 * Electron is not imported here. The cipher is injected (`src/main/keychain.ts`
 * builds the real one), which keeps this policy testable without an app and
 * keeps `pro/service.ts` free of Electron as it declares itself to be.
 */
import fs from 'node:fs'
import path from 'node:path'
import { proDir, readJson, writeJsonAtomic } from './env'

/** Ciphertext per machine id, base64. The plaintext is never in this file. */
export const secretsFile = path.join(proDir, 'secrets.json')

const SECRETS_VERSION = 1
/** A password longer than this is not a password, and it is a JSON key's worth of room. */
const MAX_SECRET = 512
const MAX_ID = 200

/**
 * The slice of Electron's `safeStorage` this store uses. Declared structurally
 * so a test can hand in a reversible fake instead of an app.
 */
export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): string | Buffer | Uint8Array
  decryptString(cipher: Buffer): string
}

export interface SecretsFile {
  version: number
  updatedAt: number
  secrets: Record<string, string>
}

export interface SecretStoreDeps {
  file?: string
  /** null (or an unavailable cipher) means "this machine has no keychain". */
  cipher?: SecretCipher | null
  read?: (file: string) => SecretsFile | null
  write?: (file: string, value: unknown) => boolean
  /** File permissions; the real one tightens the ciphertext file to owner-only. */
  chmod?: (file: string, mode: number) => void
  now?: () => number
}

export class SecretStore {
  private readonly file: string
  private readonly cipher: SecretCipher | null
  private readonly read: (file: string) => SecretsFile | null
  private readonly write: (file: string, value: unknown) => boolean
  private readonly chmod: (file: string, mode: number) => void
  private readonly now: () => number

  constructor(deps: SecretStoreDeps = {}) {
    this.file = deps.file ?? secretsFile
    this.cipher = deps.cipher ?? null
    this.read = deps.read ?? ((file) => readJson<SecretsFile>(file))
    this.write =
      deps.write ??
      ((file, value) => {
        try {
          writeJsonAtomic(file, value)
          return true
        } catch {
          return false
        }
      })
    this.chmod =
      deps.chmod ??
      ((file, mode) => {
        try {
          fs.chmodSync(file, mode)
        } catch {
          // A filesystem that will not take a mode is not a reason to lose the
          // write; the ciphertext is the protection, the mode is the courtesy.
        }
      })
    this.now = deps.now ?? (() => Date.now())
  }

  /** Can this machine hold a secret at all? The edit form says so in words. */
  available(): boolean {
    if (!this.cipher) return false
    try {
      return this.cipher.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  /** Every id with a stored secret. Ids only - the roster wants a badge, not bytes. */
  ids(): string[] {
    return Object.keys(this.secrets())
  }

  has(id: string): boolean {
    const key = keyOf(id)
    return key ? Object.prototype.hasOwnProperty.call(this.secrets(), key) : false
  }

  /** The plaintext, or null. Only the two callers that need bytes should ask. */
  get(id: string): string | null {
    const key = keyOf(id)
    if (!key || !this.available()) return null
    const cipher = this.secrets()[key]
    if (!cipher) return null
    try {
      const plain = this.cipher?.decryptString(Buffer.from(cipher, 'base64'))
      return typeof plain === 'string' && plain ? plain : null
    } catch {
      // Ciphertext from another OS install, or a keychain that was reset: the
      // honest answer is "no password", which sends the human to retype it
      // instead of failing a connect they can still complete by hand.
      return null
    }
  }

  /**
   * Store a password. An empty secret is a *deletion*, which is what makes one
   * verb enough for the edit form: clearing the field clears the keychain.
   * Returns false when nothing was stored - no keychain, or a write that failed.
   */
  set(id: string, secret: string): boolean {
    const key = keyOf(id)
    if (!key) return false
    if (!secret) return this.remove(id)
    if (secret.length > MAX_SECRET || !this.available()) return false
    let cipher: string
    try {
      cipher = Buffer.from(this.cipher!.encryptString(secret)).toString('base64')
    } catch {
      return false
    }
    const secrets = { ...this.secrets(), [key]: cipher }
    return this.persist(secrets)
  }

  /** Drop one secret. False when there was nothing to drop. */
  remove(id: string): boolean {
    const key = keyOf(id)
    if (!key) return false
    const secrets = this.secrets()
    if (!Object.prototype.hasOwnProperty.call(secrets, key)) return false
    const next = { ...secrets }
    delete next[key]
    return this.persist(next)
  }

  /** The stored map, normalised. Corrupt or missing reads as empty, never throws. */
  private secrets(): Record<string, string> {
    const raw = this.read(this.file)
    const map = raw && typeof raw.secrets === 'object' && raw.secrets ? raw.secrets : {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(map)) {
      if (typeof value === 'string' && value) out[key] = value
    }
    return out
  }

  private persist(secrets: Record<string, string>): boolean {
    const file: SecretsFile = { version: SECRETS_VERSION, updatedAt: this.now(), secrets }
    if (!this.write(this.file, file)) return false
    // 0600 after the write: `writeJsonAtomic` renames a temp file into place, so
    // the mode has to be set on the file that ends up at the real path.
    this.chmod(this.file, 0o600)
    return true
  }
}

/** A JSON key and a lookup key in one: trimmed, non-empty, length-capped. */
function keyOf(id: string): string {
  const key = String(id ?? '').trim()
  if (!key || key.length > MAX_ID) return ''
  return key
}
