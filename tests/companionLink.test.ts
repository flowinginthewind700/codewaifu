/**
 * The widget side of the link (F7): what a bubble may offer, and what may take
 * a bubble down.
 *
 * Both functions here decide something a human is looking at, and both fail in
 * the direction of losing their work. `routeCanAnswer` reads the action list
 * main already validated instead of re-deriving verbs from `kind`, because a
 * second derivation is how the bubble ends up offering a verb the service will
 * refuse - a button that does nothing when clicked is worse than no button.
 * `shouldClearBubble` normally beats the bubble's own timer, but not while a
 * sentence is half typed: the push reporting "the queue drained" is exactly the
 * one an in-flight answer causes, so honouring it would delete the text.
 */
import { describe, expect, it } from 'vitest'
import { emptyCounts } from '../src/shared/pro'
import type { ProCompanionPush } from '../src/shared/proIpc'
import type { BubbleMessage, BubbleRoute } from '../src/shared/ui'
import {
  resolveCommand,
  routeCanAnswer,
  routeFor,
  shouldClearBubble
} from '../src/shared/companionLink'
import { attentionItem } from './helpers/pro'

const AT = 1_700_000_000_000

function push(patch: Partial<ProCompanionPush> = {}): ProCompanionPush {
  return {
    notices: 1,
    expression: 'alert',
    counts: emptyCounts(),
    benchFocused: false,
    widgetVisible: true,
    benchOpen: false,
    announcing: '',
    at: AT,
    ...patch
  }
}

function bubble(patch: Partial<BubbleMessage> = {}): BubbleMessage {
  return {
    id: 'b1',
    text: 'codex wants to run npm test',
    lang: 'en',
    agent: 'codex',
    kind: 'permission',
    at: AT,
    ...patch
  }
}

function route(patch: Partial<BubbleRoute> = {}): BubbleRoute {
  return {
    taskId: 't1',
    paneId: 'pane-1',
    itemId: 't1:permission:hook',
    kind: 'permission',
    actions: ['approve', 'deny', 'answer', 'snooze', 'open'],
    benchLabel: 'Open in Bench',
    ...patch
  }
}

describe('routeCanAnswer', () => {
  it('is false without an item to answer', () => {
    // A hook notice or a status report has no queue entry behind it.
    expect(routeCanAnswer(null)).toBe(false)
    expect(routeCanAnswer(undefined)).toBe(false)
    expect(routeCanAnswer(route({ itemId: '' }))).toBe(false)
  })

  it('follows the action list main validated', () => {
    expect(routeCanAnswer(route({ actions: ['answer', 'snooze', 'open'] }))).toBe(true)
    expect(routeCanAnswer(route({ actions: ['open', 'done', 'snooze'] }))).toBe(false)
  })

  it('agrees with the queue about which kinds can be answered in place', () => {
    // `routeFor` copies `attentionActions`, so a review item - the one kind with
    // no `answer` verb - must not grow a composer on the widget either.
    expect(routeCanAnswer(routeFor(attentionItem({ kind: 'question' }), 'en'))).toBe(true)
    expect(routeCanAnswer(routeFor(attentionItem({ kind: 'permission' }), 'en'))).toBe(true)
    expect(routeCanAnswer(routeFor(attentionItem({ kind: 'review' }), 'en'))).toBe(false)
  })
})

describe('shouldClearBubble', () => {
  const drained = push({ notices: 0, announcing: '' })
  const next = push({ notices: 1, announcing: 't2:question:hook' })

  it('clears on a drained queue and on the next item taking over', () => {
    const shown = bubble({ route: route() })
    expect(shouldClearBubble(drained, shown)).toBe(true)
    expect(shouldClearBubble(next, shown)).toBe(true)
  })

  it('stands both of those down while a sentence is half typed', () => {
    const shown = bubble({ route: route() })
    expect(shouldClearBubble(drained, shown, true)).toBe(false)
    expect(shouldClearBubble(next, shown, true)).toBe(false)
  })

  it('never clears a re-push of the item already on screen', () => {
    // `pushProCompanion` fires on every herdr event; a flicker per event is how
    // a widget trains its human to ignore it.
    const shown = bubble({ route: route() })
    const same = push({ announcing: shown.route?.itemId })
    expect(shouldClearBubble(same, shown)).toBe(false)
    expect(shouldClearBubble(same, shown, true)).toBe(false)
  })

  it('leaves a hook bubble alone, composing or not', () => {
    // No route means it is the companion's own business, not the bench's.
    const hook = bubble({ route: undefined })
    expect(shouldClearBubble(drained, hook)).toBe(false)
    expect(shouldClearBubble(next, hook)).toBe(false)
  })

  it('has nothing to say when either side is missing', () => {
    expect(shouldClearBubble(null, bubble())).toBe(false)
    expect(shouldClearBubble(drained, null)).toBe(false)
  })
})

/**
 * The stage's door is a switch, and a switch has to work when nobody is
 * answering: degrading it to `openBench` would leave the button stuck on "open"
 * for exactly as long as the bench state feed is down, which is the moment a
 * human is most likely to be pressing it.
 */
describe('resolveCommand', () => {
  it('resolves the toggle without a view to resolve against', () => {
    expect(resolveCommand({ type: 'toggleBench' }, null)).toEqual({ type: 'toggleBench' })
  })
})
