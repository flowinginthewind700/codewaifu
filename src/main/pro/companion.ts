/**
 * The companion half of F7: bench attention becomes a face, a voice and a
 * clickable bubble, and a bubble click becomes a bench command.
 *
 * This file is the only place in Pro that touches the desktop widget, and it
 * owns no state of its own. The queue, the badge number and the task a bubble
 * points at all come from `ProService` through `CompanionApi`; what lives here
 * is the translation and the two policies that make the difference between an
 * ambient channel and a nuisance:
 *
 * - **Appear, never take focus.** Summoning the widget is `show`, not `focus`.
 *   Stealing the keyboard from a human who is typing into a terminal, in order
 *   to tell them a terminal needs them, is worse than not appearing at all.
 * - **Announce once, then get out of the way.** An announcement is held for the
 *   bubble's own lifetime and then released, so her face falls back to reading
 *   the fleet instead of freezing on the last thing she said.
 *
 * Everything failable is injected (`timers`, `newId`, the widget and badge
 * callbacks), so the whole bridge is unit-testable without Electron.
 */
import crypto from 'node:crypto'
import type { ProConfig } from '../../shared/config'
import type { Lang } from '../../shared/protocol'
import type { BubbleMessage } from '../../shared/ui'
import {
  badgeFor,
  companionView,
  noticeText,
  recoveryCounts,
  recoveryText,
  resolveCommand,
  routeFor,
  shouldSummon,
  summonPolicyOf,
  type ResolvedCommand
} from '../../shared/companionLink'
import {
  DEFAULT_SNOOZE_MINUTES,
  emptyCounts,
  type AttentionItem,
  type BenchView,
  type StateCounts
} from '../../shared/pro'
import {
  failResult,
  okResult,
  parseBenchCommand,
  parseProCompanion,
  type ProActionRequest,
  type ProCompanionPush,
  type ProReject,
  type ProResult
} from '../../shared/proIpc'

/**
 * What the bridge may ask the bench for. Deliberately the *whole* authority:
 * the widget never keeps its own copy of a queue, so there is exactly one
 * answer to "what needs me" and it is `ProService`'s.
 */
export interface CompanionApi {
  /** The current projection, or null while herdr is not talking to us. */
  view(): BenchView | null
  /** Run one attention action; the same path a Bench button takes. */
  act(request: ProActionRequest): Promise<ProResult>
  /** Bring the Bench forward, select this task and focus this pane. */
  focusBench(taskId: string, paneId: string, reason: string): void
  /** Delay the whole queue. Returns how many items were snoozed. */
  snoozeAll(minutes: number): number
  /** Show and focus the Bench window without selecting anything. */
  openBench(): void
}

export interface CompanionTimer {
  cancel: () => void
}

export interface CompanionTimers {
  after(cb: () => void, ms: number): CompanionTimer
  now(): number
}

export const realCompanionTimers: CompanionTimers = {
  after(cb, ms) {
    const handle = setTimeout(cb, ms)
    // A pending announcement must never be what keeps the process alive.
    handle.unref?.()
    return { cancel: () => clearTimeout(handle) }
  },
  now: () => Date.now()
}

export interface CompanionDeps {
  api: CompanionApi
  config: () => ProConfig
  /** Speech language: `config.lang`, or the interface language when `auto`. */
  lang: () => Lang
  bubble: (message: BubbleMessage) => void
  /**
   * Must be the mute-respecting, deduping path (`Speaker.say`), not `force`:
   * a muted companion stays muted, and one hook that fires twice says one line.
   */
  speak: (text: string, lang: Lang) => void
  speaking: () => boolean
  /** Show or hide the widget. Never focuses it; see the file header. */
  setWidget: (visible: boolean) => void
  widgetVisible: () => boolean
  benchFocused: () => boolean
  setBadge: (count: number) => void
  push: (state: ProCompanionPush) => void
  /** How long a bubble stays up, from the app config. */
  bubbleMs: () => number
  timers?: CompanionTimers
  newId?: () => string
}

/** What one announcement did, so a caller (and a test) can tell. */
export interface AnnounceResult {
  summoned: boolean
  spoke: boolean
  bubbled: boolean
  text: string
}

/** Held for the bubble's lifetime plus a beat, so speech never outlives it. */
const ANNOUNCE_SLACK_MS = 1000
/** Floor for the hold: a very short bubble must not freeze her face on 'alert'. */
const MIN_ANNOUNCE_MS = 1500

export class CompanionBridge {
  private readonly api: CompanionApi
  private readonly deps: CompanionDeps
  private readonly timers: CompanionTimers
  private readonly newId: () => string

  private announcing: { itemId: string; kind: string } | null = null
  private timer: CompanionTimer | null = null
  private last: ProCompanionPush | null = null

  constructor(deps: CompanionDeps) {
    this.deps = deps
    this.api = deps.api
    this.timers = deps.timers ?? realCompanionTimers
    this.newId =
      deps.newId ?? (() => `${this.timers.now()}-${crypto.randomBytes(3).toString('hex')}`)
  }

  private config(): ProConfig {
    return this.deps.config()
  }

  private lang(): Lang {
    return this.deps.lang()
  }

  /** The last state we pushed; null before the first sync. */
  state(): ProCompanionPush | null {
    return this.last
  }

  /** The badge number as the tray sees it right now. */
  badge(): number {
    return this.last?.notices ?? 0
  }

  /* ---------------------------------------------------------------- *
   * Bench -> companion
   * ---------------------------------------------------------------- */

  /**
   * Tell her about one item that was just raised.
   *
   * `view` is normally passed in by `ProService`, which has just rebuilt the
   * projection; without it we ask, which costs nothing but can be one event
   * behind. Either way the position and the "+N more" count come from the live
   * queue, never from a number this bridge remembers.
   */
  announce(item: AttentionItem, view: BenchView | null = null): AnnounceResult {
    const live = view ?? this.api.view()
    const lang = this.lang()
    const now = this.timers.now()
    const queue = live?.attention ?? []
    const at = queue.findIndex((entry) => entry.id === item.id)
    const position = at >= 0 ? at + 1 : 1
    const notice = noticeText({
      item,
      lang,
      now,
      count: Math.max(queue.length, position),
      position
    })
    const cfg = this.config()
    const summoned = shouldSummon({
      policy: summonPolicyOf(cfg.summon),
      kind: item.kind,
      benchFocused: this.deps.benchFocused(),
      widgetVisible: this.deps.widgetVisible()
    })
    if (summoned) this.deps.setWidget(true)

    const spoke = Boolean(cfg.speakAttention && notice.speak)
    if (spoke) this.deps.speak(notice.speak, lang)
    const bubbled = Boolean(cfg.bubbleAttention && notice.text)
    if (bubbled) {
      this.deps.bubble({
        id: this.newId(),
        text: notice.text,
        lang,
        agent: item.agentKind || 'bench',
        // The kind doubles as the bubble's eyebrow label, so a permission
        // prompt reads as one even before the text is read.
        kind: item.kind,
        at: now,
        route: routeFor(item, lang)
      })
    }
    this.hold(item)
    this.sync(live)
    return { summoned, spoke, bubbled, text: notice.text }
  }

  /**
   * The boot line that makes the ledger visible: "three tasks can be resumed".
   * Returns the text (or '' when there was nothing to say) so the caller can log
   * it; speaking and bubbling follow the same toggles as an attention item.
   */
  announceRecovery(view: BenchView | null): string {
    if (!view) return ''
    const lang = this.lang()
    const text = recoveryText(recoveryCounts(view), lang)
    if (!text) return ''
    this.say(text, lang, 'notice')
    return text
  }

  /** Bench-side "say this through her": a stage control, an HTTP caller. */
  announceText(text: string, lang: Lang = this.lang()): boolean {
    return this.say(text, lang, 'notice')
  }

  private say(text: string, lang: Lang, kind: string): boolean {
    const clean = String(text || '').trim()
    if (!clean) return false
    const cfg = this.config()
    const spoke = Boolean(cfg.speakAttention)
    if (spoke) this.deps.speak(clean, lang)
    const bubbled = Boolean(cfg.bubbleAttention)
    if (bubbled) {
      this.deps.bubble({
        id: this.newId(),
        text: clean,
        lang,
        agent: 'bench',
        kind,
        at: this.timers.now()
      })
    }
    return spoke || bubbled
  }

  /* ---------------------------------------------------------------- *
   * State push
   * ---------------------------------------------------------------- */

  /**
   * Recompute and push her whole view of the bench. Called on every state
   * change rather than polled: the widget may be hidden or mid-animation, and a
   * stale badge on the one surface that answers "do I have to go back?" is the
   * failure mode F7 exists to prevent.
   */
  sync(view: BenchView | null): ProCompanionPush {
    const counts: StateCounts = view ? view.counts : emptyCounts()
    const notices = view ? badgeFor(view) : 0
    const state = companionView({
      counts,
      notices,
      benchFocused: this.deps.benchFocused(),
      widgetVisible: this.deps.widgetVisible(),
      announcing: this.announcing,
      speaking: this.deps.speaking(),
      now: this.timers.now()
    })
    this.last = state
    this.deps.push(state)
    // Always call setBadge, even with the toggle off, so turning it off clears
    // the number that is already on the tray instead of freezing it there.
    this.deps.setBadge(this.config().badge ? notices : 0)
    return state
  }

  /** Release the announcement for one item (or any item when `itemId` is ''). */
  clearAnnounce(itemId = ''): void {
    if (itemId && this.announcing?.itemId !== itemId) return
    this.release()
    this.sync(this.api.view())
  }

  /**
   * Quit-time. Nothing she points at may outlive the bench: a bubble saying
   * "codex needs approval" on a desktop whose bench is gone is a lie with a
   * click target, so the badge goes to zero and the announcement is dropped.
   */
  dismissAll(): void {
    this.release()
    this.sync(null)
  }

  shutdown(): void {
    this.dismissAll()
  }

  private hold(item: AttentionItem): void {
    this.release()
    this.announcing = { itemId: item.id, kind: item.kind }
    const ms = Math.max(MIN_ANNOUNCE_MS, this.deps.bubbleMs() + ANNOUNCE_SLACK_MS)
    this.timer = this.timers.after(() => {
      this.timer = null
      this.announcing = null
      this.sync(this.api.view())
    }, ms)
  }

  private release(): void {
    this.announcing = null
    if (!this.timer) return
    this.timer.cancel()
    this.timer = null
  }

  /* ---------------------------------------------------------------- *
   * Companion -> bench, and bench -> widget controls
   * ---------------------------------------------------------------- */

  /**
   * A bubble click, a tray click or an HTTP call: one entry point, parsed once.
   *
   * Resolution against the live view is what makes a stale widget safe. The
   * bubble can outlive the item that made it (answered from the Bench, or the
   * agent moved on), and `resolveCommand` turns that into "show the task" or
   * "show the bench" instead of a silent no-op.
   */
  async command(payload: unknown): Promise<ProResult> {
    const parsed = parseBenchCommand(payload)
    if (rejected(parsed)) return failResult(parsed.code, parsed.error)
    return this.dispatch(resolveCommand(parsed, this.api.view()))
  }

  private async dispatch(resolved: ResolvedCommand): Promise<ProResult> {
    switch (resolved.type) {
      case 'openBench':
        this.api.openBench()
        return okResult(null, '', 'open-bench')
      case 'focus':
        this.api.focusBench(resolved.taskId, resolved.paneId, 'widget')
        return okResult(null, '', 'focused')
      case 'snoozeAll': {
        const count = this.api.snoozeAll(resolved.minutes)
        return okResult({ count }, '', 'snoozed')
      }
      case 'act': {
        const request: ProActionRequest = {
          itemId: resolved.itemId,
          action: resolved.action,
          text: resolved.text,
          origin: 'widget',
          minutes: DEFAULT_SNOOZE_MINUTES
        }
        const result = await this.api.act(request)
        // She is no longer talking about an item the human just answered, even
        // if the queue still has others in it.
        if (result.ok) this.clearAnnounce(resolved.itemId)
        return result
      }
      case 'drop':
        // `detail` stays the internal reason: it is what the log needs, and the
        // renderer localizes off `code` rather than off prose it cannot parse.
        return failResult('dropped', resolved.reason)
    }
  }

  /** Bench -> widget: summon, dismiss, toggle, or say a line through her. */
  companionCommand(payload: unknown): ProResult {
    const parsed = parseProCompanion(payload)
    if (rejected(parsed)) return failResult(parsed.code, parsed.error)
    switch (parsed.op) {
      case 'summon':
        this.deps.setWidget(true)
        this.sync(this.api.view())
        return okResult(null, '', 'summoned')
      case 'dismiss':
        this.release()
        this.deps.setWidget(false)
        this.sync(this.api.view())
        return okResult(null, '', 'dismissed')
      case 'toggle': {
        const visible = !this.deps.widgetVisible()
        if (!visible) this.release()
        this.deps.setWidget(visible)
        this.sync(this.api.view())
        return okResult({ visible }, '', visible ? 'summoned' : 'dismissed')
      }
      case 'announce': {
        const said = this.say(parsed.text, parsed.lang, 'notice')
        return said ? okResult(null, '', 'announced') : failResult('muted', 'ambient output is off')
      }
    }
  }
}

/** Narrow a parse result without repeating the `ok` check at every call site. */
function rejected(value: unknown): value is ProReject {
  return Boolean(value) && typeof value === 'object' && (value as { ok?: unknown }).ok === false
}
