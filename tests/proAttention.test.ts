/**
 * The answer path: from "a human typed a sentence" to "keystrokes in a pane".
 *
 * Three callers reach `planAttentionAction` - the Bench answer box, the widget
 * bubble and `POST /pro/answer` - so normalization lives in the plan and not in
 * any one of them, and what the ledger records is what the pane received.
 *
 * Both rules here fail silently rather than loudly, which is why they are pinned
 * instead of trusted. An answer is delivered by *typing* it, so a newline is
 * Enter: the fallback path sends text and then presses enter itself, and an
 * embedded newline submits the first half and types the rest into whatever the
 * agent shows next. The cap exists for the same reason - a TUI's input line
 * drops or re-wraps bytes past its buffer without complaining, so an unbounded
 * paste does not error, it arrives mangled and the agent answers a question
 * nobody asked.
 *
 * And one thing that must *not* be normalized: `reprompt` compiles a multi-line
 * recovery brief, and flattening it on the way through would send the ledger's
 * goal/decisions/plan as one long unreadable line.
 */
import { describe, expect, it } from 'vitest'
import {
  ANSWER_MAX_CHARS,
  answerText,
  parseTaskRecord,
  planAttentionAction
} from '../src/shared/pro'
import { isProReject, parseProAnswer } from '../src/shared/proIpc'
import { attentionItem } from './helpers/pro'

const NOW = 1_700_000_000_000

describe('answerText', () => {
  it('folds every whitespace run to one space and trims the ends', () => {
    // A pasted paragraph is the common case: it carries newlines, and a newline
    // that reaches the pane is Enter.
    expect(answerText('  use   the\nlinux\tbox \n').text).toBe('use the linux box')
    expect(answerText('\n').text).toBe('')
    expect(answerText('').clipped).toBe(false)
  })

  it('takes input that is not a string, because it arrives over IPC', () => {
    expect(answerText(null).text).toBe('')
    expect(answerText(undefined).text).toBe('')
    expect(answerText(42).text).toBe('42')
  })

  it('does not clip anything at or under the cap', () => {
    const exact = answerText('x'.repeat(ANSWER_MAX_CHARS))
    expect(exact.clipped).toBe(false)
    expect(exact.text).toHaveLength(ANSWER_MAX_CHARS)
  })

  it('cuts a long answer on a word boundary when one is near the end', () => {
    const words = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ')
    const { text, clipped } = answerText(words)
    expect(clipped).toBe(true)
    expect(text.length).toBeLessThanOrEqual(ANSWER_MAX_CHARS)
    // Every surviving token is a whole word: a half word is what the pane shows
    // and what the ledger line quotes forever.
    for (const token of text.split(' ')) expect(token).toMatch(/^w\d+$/)
    // And cutting on the boundary costs a few characters, not the sentence.
    expect(ANSWER_MAX_CHARS - text.length).toBeLessThanOrEqual(6)
  })

  it('hard-cuts when there is no word boundary worth keeping', () => {
    const { text, clipped } = answerText('x'.repeat(900))
    expect(clipped).toBe(true)
    expect(text).toHaveLength(ANSWER_MAX_CHARS)
    // A single space near the start is not a place to cut back to: losing 398
    // characters to avoid one half word is worse than the half word.
    const head = answerText(`ok ${'x'.repeat(900)}`)
    expect(head.text).toHaveLength(ANSWER_MAX_CHARS)
    expect(head.clipped).toBe(true)
  })

  it('counts the cap in code points, so an emoji is never cut in half', () => {
    const { text, clipped } = answerText('🙂'.repeat(ANSWER_MAX_CHARS + 100))
    expect(clipped).toBe(true)
    // A lone surrogate would type into the terminal as a replacement character
    // and show up here as one extra unit of length 1.
    expect(Array.from(text)).toHaveLength(ANSWER_MAX_CHARS)
    expect(text).toHaveLength(ANSWER_MAX_CHARS * 2)
    expect(text.endsWith('🙂')).toBe(true)
  })
})

describe('planAttentionAction: answer', () => {
  it('refuses an answer with nothing in it', () => {
    const plan = planAttentionAction({
      item: attentionItem({ kind: 'question' }),
      action: 'answer',
      text: '   \n\t ',
      now: NOW
    })
    expect(plan).toMatchObject({ kind: 'none', code: 'no-text' })
  })

  it('refuses to answer a pane that is gone, rather than typing into the void', () => {
    const plan = planAttentionAction({
      item: attentionItem({ kind: 'question', paneId: '' }),
      action: 'answer',
      text: 'use the linux box',
      now: NOW
    })
    expect(plan).toMatchObject({ kind: 'none', code: 'no-pane' })
  })

  it('sends the folded text, not what was typed', () => {
    const item = attentionItem({ kind: 'question' })
    const plan = planAttentionAction({
      item,
      action: 'answer',
      text: 'use\nthe linux   box\n',
      now: NOW
    })
    expect(plan).toEqual({
      kind: 'prompt',
      itemId: item.id,
      taskId: item.taskId,
      paneId: item.paneId,
      text: 'use the linux box'
    })
  })

  it('caps what it sends, so the warning the UI showed is the truth', () => {
    const plan = planAttentionAction({
      item: attentionItem({ kind: 'question' }),
      action: 'answer',
      text: 'x'.repeat(ANSWER_MAX_CHARS * 2),
      now: NOW
    })
    expect(plan.kind).toBe('prompt')
    if (plan.kind === 'prompt') expect(plan.text).toHaveLength(ANSWER_MAX_CHARS)
  })

  it('leaves the reprompt brief multi-line', () => {
    const task = parseTaskRecord({ id: 't1', goal: 'ship the bench', workdir: '/repo' })
    expect(task).not.toBeNull()
    const plan = planAttentionAction({
      item: attentionItem({ kind: 'failed', taskId: 't1' }),
      action: 'reprompt',
      task,
      digest: null,
      now: NOW
    })
    expect(plan.kind).toBe('prompt')
    if (plan.kind !== 'prompt') return
    expect(plan.text.split('\n').length).toBeGreaterThan(2)
    expect(plan.text).toContain('Goal: ship the bench')
  })
})

/**
 * `POST /pro/answer` is the one caller that can hand the plan a multi-line
 * string: the wire parser caps at 4000 and trims, but it does not fold, because
 * folding is a delivery concern and the parser's job is to reject. So the two
 * halves are asserted separately here - if a future parser starts folding, this
 * file says which guarantee moved rather than silently losing one.
 */
describe('planAttentionAction: an answer that arrived over HTTP', () => {
  it('folds what the parser lets through, because the parser does not', () => {
    const item = attentionItem({ kind: 'question' })
    const request = parseProAnswer(
      { itemId: item.id, text: 'use the linux box\nand keep the logs' },
      [item]
    )
    expect(isProReject(request)).toBe(false)
    if (isProReject(request)) return
    expect(request.text).toContain('\n')
    const plan = planAttentionAction({ item, action: 'answer', text: request.text, now: NOW })
    expect(plan).toMatchObject({ kind: 'prompt', text: 'use the linux box and keep the logs' })
  })

  it('caps a body the parser was happy to accept', () => {
    const item = attentionItem({ kind: 'question' })
    const request = parseProAnswer({ itemId: item.id, text: 'x'.repeat(4000) }, [item])
    if (isProReject(request)) throw new Error('the parser rejected a valid body')
    const plan = planAttentionAction({ item, action: 'answer', text: request.text, now: NOW })
    expect(plan.kind).toBe('prompt')
    if (plan.kind === 'prompt') expect(plan.text).toHaveLength(ANSWER_MAX_CHARS)
  })
})
