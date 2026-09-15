/**
 * The topbar: one line that answers "is anything waiting for me, and is the
 * runtime underneath me alive".
 *
 * Three deliberate choices:
 *
 * 1. herdr's state is a chip, never a modal. The bench without herdr is not an
 *    error dialog, it is an empty cockpit with an install card in the middle;
 *    the chrome stays up so the toggles and the queue are still reachable.
 * 2. Zeros are dimmed, not removed. A count that disappears when it hits zero
 *    makes the row reflow, and your eye loses its place in a bar you glance at
 *    twenty times an hour.
 * 3. The companion toggles live here rather than in a settings page, because
 *    "stop talking to me for a while" has to be one click away at the moment it
 *    is wanted. Everything here writes straight through to `config.pro`, which
 *    is also what the widget reads - one source of truth, two surfaces.
 */
import type { ReactElement } from 'react'
import {
  Bell,
  Clock,
  FolderInput,
  MessageCircle,
  PanelLeft,
  Plus,
  RefreshCw,
  Sparkles,
  Volume2
} from 'lucide-react'
import type { ProConfig } from '@shared/config'
import type { BenchView } from '@shared/pro'
import { fill, type Translate } from './i18n'

export interface TopBarProps {
  view: BenchView
  pro: ProConfig | null
  railOpen: boolean
  rightOpen: boolean
  t: Translate
  onToggle: (key: 'speakAttention' | 'bubbleAttention' | 'badge') => void
  onSummon: (value: ProConfig['summon']) => void
  onCompanion: () => void
  onSnoozeAll: () => void
  onAdopt: () => void
  onNewTask: () => void
  onRediscover: () => void
  onToggleRail: () => void
  onToggleRight: () => void
}

const SUMMON_KEYS = {
  always: 'summonAlways',
  blocking: 'summonBlocking',
  never: 'summonNever'
} as const satisfies Record<ProConfig['summon'], string>

export function TopBar({
  view,
  pro,
  railOpen,
  rightOpen,
  t,
  onToggle,
  onSummon,
  onCompanion,
  onSnoozeAll,
  onAdopt,
  onNewTask,
  onRediscover,
  onToggleRail,
  onToggleRight
}: TopBarProps): ReactElement {
  const { counts } = view
  const attentionCount = view.attention.length
  const companionVisible = view.companion.visible

  return (
    <header className="bench-topbar">
      <button
        type="button"
        className="btn ghost icon rail-toggle"
        title={t('treeTitle')}
        aria-label={t('treeTitle')}
        aria-expanded={railOpen}
        onClick={onToggleRail}
      >
        <PanelLeft />
      </button>

      <div className="brand">
        <span className="brand-name">{t('brandName')}</span>
        <span className="brand-sub">{t('brandSub')}</span>
      </div>

      <HerdrChip view={view} t={t} onRediscover={onRediscover} />

      <div className="counts">
        <Count state="working" n={counts.working} label={t('countWorking')} />
        <Count state="blocked" n={counts.blocked} label={t('countBlocked')} />
        <Count state="done" n={counts.done} label={t('countDone')} />
        <Count state="needsMe" n={counts.needsMe} label={t('countNeedsMe')} />
      </div>

      <span className="spacer" />

      <div className="toggles">
        <Toggle
          on={pro?.speakAttention ?? false}
          label={t('toggleSpeak')}
          disabled={!pro}
          onChange={() => onToggle('speakAttention')}
        >
          <Volume2 />
        </Toggle>
        <Toggle
          on={pro?.bubbleAttention ?? false}
          label={t('toggleBubble')}
          disabled={!pro}
          onChange={() => onToggle('bubbleAttention')}
        >
          <MessageCircle />
        </Toggle>
        <Toggle
          on={pro?.badge ?? false}
          label={t('toggleBadge')}
          disabled={!pro}
          onChange={() => onToggle('badge')}
        >
          <Bell />
        </Toggle>
      </div>

      <select
        className="select"
        value={pro?.summon ?? 'blocking'}
        disabled={!pro}
        aria-label={t('summonLabel')}
        title={t('summonLabel')}
        onChange={(event) => onSummon(event.target.value as ProConfig['summon'])}
      >
        {(Object.keys(SUMMON_KEYS) as (keyof typeof SUMMON_KEYS)[]).map((value) => (
          <option key={value} value={value}>
            {`${t('summonLabel')}: ${t(SUMMON_KEYS[value])}`}
          </option>
        ))}
      </select>

      <div className="topbar-actions">
        <button
          type="button"
          className="btn ghost icon"
          title={t('snoozeAll')}
          aria-label={t('snoozeAll')}
          disabled={!attentionCount}
          onClick={onSnoozeAll}
        >
          <Clock />
        </button>
        <button
          type="button"
          className="btn ghost icon"
          title={t('adopt')}
          aria-label={t('adopt')}
          onClick={onAdopt}
        >
          <FolderInput />
        </button>
        <button
          type="button"
          className="btn ghost icon"
          title={companionVisible ? t('companionHide') : t('companionShow')}
          aria-label={companionVisible ? t('companionHide') : t('companionShow')}
          aria-pressed={companionVisible}
          data-open={companionVisible || undefined}
          onClick={onCompanion}
        >
          <Sparkles />
        </button>
        <button type="button" className="btn primary sm" onClick={onNewTask}>
          <Plus />
          {t('newTask')}
        </button>
        <button
          type="button"
          className="btn ghost icon right-toggle"
          title={t('queueTitle')}
          aria-label={t('queueTitle')}
          aria-expanded={rightOpen}
          data-count={attentionCount}
          onClick={onToggleRight}
        >
          <Bell />
        </button>
      </div>
    </header>
  )
}

function Count({
  state,
  n,
  label
}: {
  state: 'working' | 'blocked' | 'done' | 'needsMe'
  n: number
  label: string
}): ReactElement {
  return (
    <span className="count" data-state={state} data-zero={n === 0}>
      <b>{n}</b>
      {label}
    </span>
  )
}

/**
 * herdr's own state, with the socket path in a tooltip: when two sessions are
 * running on one machine, "which herdr am I driving" has to be answerable
 * without opening a terminal.
 */
function HerdrChip({
  view,
  t,
  onRediscover
}: {
  view: BenchView
  t: Translate
  onRediscover: () => void
}): ReactElement {
  const { herdr } = view
  if (!herdr.online) {
    return (
      <span className="chip offline" title={herdr.error || herdr.socketPath}>
        <span className="chip-dot" />
        <span className="chip-text">{t('herdrOffline')}</span>
        <button
          type="button"
          className="btn ghost icon"
          title={t('refresh')}
          aria-label={t('refresh')}
          onClick={onRediscover}
        >
          <RefreshCw />
        </button>
      </span>
    )
  }
  return (
    <span
      className="chip online"
      title={`${fill(t, 'herdrSocket', { path: herdr.socketPath })}${herdr.error ? `\n${herdr.error}` : ''}`}
    >
      <span className="chip-dot" />
      <span className="chip-text">{fill(t, 'herdrOnline', { version: herdr.version || '?' })}</span>
      <span className="chip-text">
        {fill(t, 'herdrStats', { workspaces: herdr.workspaces, panes: herdr.panes })}
      </span>
    </span>
  )
}

function Toggle({
  on,
  label,
  disabled,
  onChange,
  children
}: {
  on: boolean
  label: string
  disabled: boolean
  onChange: () => void
  children: ReactElement
}): ReactElement {
  return (
    <label className="toggle" title={label}>
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        aria-label={label}
        onChange={onChange}
      />
      {children}
    </label>
  )
}
