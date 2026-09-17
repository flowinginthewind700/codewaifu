/**
 * `SecretStore`: the passwords behind the SSH roster's lock badge.
 *
 * This is the only file in the app that holds a credential, and the two ways it
 * can be wrong are both silent. Storing plaintext when the platform has no
 * keychain produces a working feature and a file anybody on the box can read;
 * throwing when the ciphertext came from another install produces a connect that
 * fails with a stack instead of asking for the password again. So the cases
 * below pin the refusals as hard as the happy path: no keychain means the write
 * does not happen, and unreadable ciphertext means "no password", never an
 * error.
 *
 * Electron is nowhere in this file. `safeStorage` arrives as the injected
 * `SecretCipher`, which is a reversible fake here and the real thing in
 * `main/keychain.ts` - the same seam the roster uses for disk and for `ssh`.
 */
import { describe, expect, it } from 'vitest'
import { SecretStore, type SecretCipher, type SecretsFile } from '../src/main/pro/secrets'

const NOW = 1_700_000_000_000
/** A machine id, shaped like the ones the roster hands out. */
const ID = 'mkz1a2b3'
const PLAIN = 'correct horse battery staple'

interface FakeVault {
  file: SecretsFile | null
  writes: number
  /** Modes the store asked for, in order: 0600 on the ciphertext is the courtesy. */
  modes: number[]
  /** Flip to false and every write fails, like a read-only disk. */
  writable: boolean
  /** What `isEncryptionAvailable` answers. */
  available: boolean
  /** Flip and the cipher throws instead of encrypting. */
  broken: boolean
}

function vault(overrides: Partial<FakeVault> = {}): FakeVault {
  return {
    file: null,
    writes: 0,
    modes: [],
    writable: true,
    available: true,
    broken: false,
    ...overrides
  }
}

/**
 * Reversible, and deliberately not the identity: a ciphertext that looked like
 * the plaintext would let a test pass on a store that skipped the cipher.
 */
function cipher(v: FakeVault): SecretCipher {
  return {
    isEncryptionAvailable: () => {
      if (v.broken) throw new Error('keychain locked')
      return v.available
    },
    encryptString: (plain) => {
      if (v.broken) throw new Error('keychain locked')
      return Buffer.from(`enc:${plain}`, 'utf8')
    },
    decryptString: (buf) => {
      if (v.broken) throw new Error('keychain locked')
      const text = buf.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('ciphertext from another install')
      return text.slice(4)
    }
  }
}

function store(v: FakeVault, cipherOrNull: SecretCipher | null = cipher(v)): SecretStore {
  return new SecretStore({
    file: 'memory://secrets.json',
    cipher: cipherOrNull,
    now: () => NOW,
    read: () => v.file,
    write: (_file, value) => {
      if (!v.writable) return false
      v.file = value as SecretsFile
      v.writes += 1
      return true
    },
    chmod: (_file, mode) => {
      v.modes.push(mode)
    }
  })
}

describe('SecretStore', () => {
  it('stores a password and reads back the same bytes', () => {
    const v = vault()
    const secrets = store(v)
    expect(secrets.set(ID, PLAIN)).toBe(true)
    expect(secrets.has(ID)).toBe(true)
    expect(secrets.get(ID)).toBe(PLAIN)
    expect(secrets.ids()).toEqual([ID])
  })

  it('never writes the plaintext, only what the cipher returned', () => {
    const v = vault()
    store(v).set(ID, PLAIN)
    const onDisk = JSON.stringify(v.file)
    expect(onDisk, 'the file is the leak').not.toContain(PLAIN)
    expect(v.file?.secrets[ID]).toBe(Buffer.from(`enc:${PLAIN}`, 'utf8').toString('base64'))
  })

  it('tightens the ciphertext file to owner-only, after the write that made it', () => {
    const v = vault()
    store(v).set(ID, PLAIN)
    // `writeJsonAtomic` renames a temp file into place, so a mode set before the
    // write lands on a file that no longer exists at that path.
    expect(v.modes).toEqual([0o600])
  })

  it('keeps two machines apart, and replaces rather than appends', () => {
    const v = vault()
    const secrets = store(v)
    secrets.set(ID, PLAIN)
    secrets.set('m2', 'second')
    expect(secrets.ids().sort()).toEqual([ID, 'm2'].sort())
    secrets.set(ID, 'replaced')
    expect(secrets.get(ID)).toBe('replaced')
    expect(secrets.get('m2')).toBe('second')
    expect(Object.keys(v.file?.secrets ?? {})).toHaveLength(2)
  })

  it('reads an empty secret as a deletion, which is what makes one form field enough', () => {
    const v = vault()
    const secrets = store(v)
    secrets.set(ID, PLAIN)
    expect(secrets.set(ID, '')).toBe(true)
    expect(secrets.has(ID)).toBe(false)
    expect(secrets.get(ID)).toBeNull()
    // Clearing what was never there is not a failure to report: the state the
    // caller asked for is the state it got.
    expect(secrets.set('m-none', '')).toBe(false)
    expect(secrets.remove('m-none')).toBe(false)
  })

  it('drops one secret without touching the others', () => {
    const v = vault()
    const secrets = store(v)
    secrets.set(ID, PLAIN)
    secrets.set('m2', 'second')
    expect(secrets.remove(ID)).toBe(true)
    expect(secrets.has(ID)).toBe(false)
    expect(secrets.get('m2')).toBe('second')
  })

  it('refuses to write at all when this machine has no keychain', () => {
    const off = vault({ available: false })
    const secrets = store(off)
    expect(secrets.available()).toBe(false)
    expect(secrets.set(ID, PLAIN)).toBe(false)
    expect(secrets.has(ID)).toBe(false)
    expect(off.writes, 'a plaintext fallback is the breach this refuses').toBe(0)

    // No cipher injected at all is the same answer, not a different one.
    const none = store(vault(), null)
    expect(none.available()).toBe(false)
    expect(none.set(ID, PLAIN)).toBe(false)
    expect(none.get(ID)).toBeNull()
  })

  it('answers "no password" for ciphertext it cannot open, rather than throwing', () => {
    const v = vault()
    const secrets = store(v)
    secrets.set(ID, PLAIN)
    // The keychain was reset, or this file came from another OS install: the
    // honest answer sends the human to retype it, and a connect can still
    // succeed by hand.
    v.broken = true
    expect(secrets.get(ID)).toBeNull()
    // And a locked keychain is still a locked keychain on the way in.
    expect(secrets.available()).toBe(false)
  })

  it('reads a missing or corrupt file as an empty vault, and never throws', () => {
    expect(store(vault({ file: null })).ids()).toEqual([])
    const junk = vault({ file: { version: 1, updatedAt: NOW, secrets: null } as unknown as SecretsFile })
    const secrets = store(junk)
    expect(secrets.ids()).toEqual([])
    expect(secrets.has(ID)).toBe(false)
    expect(secrets.get(ID)).toBeNull()
    // Half-written entries are dropped on read, so a value that is not a string
    // cannot become a decryption attempt later.
    const mixed = vault({
      file: { version: 1, updatedAt: NOW, secrets: { a: 'enc:x', b: 42, c: '' } } as unknown as SecretsFile
    })
    expect(store(mixed).ids()).toEqual(['a'])
  })

  it('refuses a password longer than the cap, and stores nothing', () => {
    const v = vault()
    const secrets = store(v)
    expect(secrets.set(ID, 'x'.repeat(513))).toBe(false)
    expect(secrets.has(ID)).toBe(false)
    expect(v.writes).toBe(0)
    expect(secrets.set(ID, 'x'.repeat(512))).toBe(true)
  })

  it('trims an id, and refuses one that cannot be a JSON key', () => {
    const v = vault()
    const secrets = store(v)
    // The roster's ids arrive from JSON we did not write; the trimmed form is
    // the key, so `set(' m1 ')` and `get('m1')` are the same secret.
    secrets.set(`  ${ID}  `, PLAIN)
    expect(secrets.get(ID)).toBe(PLAIN)
    expect(secrets.set('', PLAIN)).toBe(false)
    expect(secrets.set('   ', PLAIN)).toBe(false)
    expect(secrets.get('')).toBeNull()
    expect(secrets.remove('')).toBe(false)
    expect(secrets.set('x'.repeat(201), PLAIN)).toBe(false)
  })

  it('reports a write the disk refused, instead of a secret that is not there', () => {
    const v = vault({ writable: false })
    const secrets = store(v)
    expect(secrets.set(ID, PLAIN)).toBe(false)
    expect(secrets.has(ID)).toBe(false)
    expect(v.modes, 'nothing was written, so nothing is chmodded').toEqual([])
  })

  it('does not rewrite the file to remove a secret that was not in it', () => {
    const v = vault()
    const secrets = store(v)
    secrets.set(ID, PLAIN)
    const before = v.writes
    expect(secrets.remove('m-never-stored')).toBe(false)
    expect(v.writes).toBe(before)
  })
})
