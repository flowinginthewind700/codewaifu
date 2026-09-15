/**
 * The words a pane shows when its control process would not start.
 *
 * `spawnFailure` (shared) turns Node's errno line into a reason, and
 * `bridgeErrorText` (renderer) turns that reason into the fix it implies. They
 * get their own file because the failure they cover is invisible everywhere
 * else: with no herdr binary on PATH the pane used to sit on "Attaching..."
 * forever, because Node reports a spawn it could not perform as `error` and
 * then `close`, and the bridge only listened for `exit`. The truth was in a
 * string nobody rendered.
 *
 * The passthrough cases matter as much as the mappings. A message we do not
 * recognise has to reach the screen byte for byte, since replacing evidence
 * with a guess sends somebody after the wrong problem.
 *
 * This is a .tsx file with no JSX in it: the web tsconfig lists the .tsx
 * tests and not the .ts ones, and it is the renderer copy table under test.
 * (A glob inside a block comment is a trap: its star-slash ends the comment.)
 */
import { describe, expect, it } from 'vitest'
import { spawnFailure } from '../src/shared/pro'
import { bridgeErrorText, makeTranslator } from '../src/renderer/src/pro/i18n'

const BINARY = '/usr/local/bin/herdr'
const en = makeTranslator('en')
const zh = makeTranslator('zh')

const missing = `spawn ${BINARY} ENOENT`
const denied = `spawn ${BINARY} EACCES`

describe('spawnFailure', () => {
  it('reads the errno Node writes, and the path it tried', () => {
    expect(spawnFailure(missing)).toEqual({ reason: 'no-binary', binary: BINARY })
    expect(spawnFailure(denied)).toEqual({ reason: 'not-executable', binary: BINARY })
    expect(spawnFailure(`spawn ${BINARY} EPERM`)).toEqual({
      reason: 'not-executable',
      binary: BINARY
    })
    expect(spawnFailure(`spawnSync ${BINARY} ENOENT`), 'sync spelling').toEqual({
      reason: 'no-binary',
      binary: BINARY
    })
  })

  it('keeps a path with spaces in one piece', () => {
    expect(spawnFailure('spawn /opt/my tools/herdr ENOENT')).toEqual({
      reason: 'no-binary',
      binary: '/opt/my tools/herdr'
    })
  })

  it('claims nothing about a message it does not recognise', () => {
    const others = [
      '',
      'bridge exited (code 1, signal none)',
      'already attached',
      'spawn',
      'ENOENT',
      'herdr: pane not found'
    ]
    for (const text of others) {
      expect(spawnFailure(text), text || '(empty)').toEqual({ reason: '', binary: '' })
    }
  })
})

describe('bridgeErrorText', () => {
  it('turns a missing binary into the two ways to fix it, in both languages', () => {
    for (const t of [en, zh]) {
      const text = bridgeErrorText(t, missing)
      expect(text, 'names the file it tried').toContain(BINARY)
      expect(text, 'names the setting that overrides it').toContain('pro.herdrPath')
      expect(text, 'an errno is a diagnosis, not an instruction').not.toContain('ENOENT')
      expect(text, 'the placeholder is filled, not printed').not.toContain('{path}')
    }
  })

  it('turns a permission failure into the command that fixes it', () => {
    for (const t of [en, zh]) {
      const text = bridgeErrorText(t, denied)
      expect(text).toContain(BINARY)
      expect(text).toContain('chmod +x')
      expect(text).not.toContain('EACCES')
    }
  })

  it('passes through anything it cannot classify', () => {
    const others = [
      'bridge exited (code 1, signal none)',
      'already attached',
      'herdr: pane not found',
      ''
    ]
    for (const text of others) expect(bridgeErrorText(en, text), text || '(empty)').toBe(text)
  })
})
