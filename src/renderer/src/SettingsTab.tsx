import { useEffect, useState, type ReactElement } from 'react'
import { FolderOpen, Image as ImageIcon, Volume2 } from 'lucide-react'
import type { ConfigPatch } from '@shared/config'
import { normalizeRequestedPort } from '@shared/portPolicy'
import type { RedactedConfig, RuntimeState } from '@shared/protocol'
import type { Translate } from './i18n'
import { platform, versions } from './api'

interface SettingsTabProps {
  config: RedactedConfig
  runtime: RuntimeState
  t: Translate
  onChange: (patch: ConfigPatch) => void
  onSay: (text: string) => void
  onPickImage: () => void
  onOpenPath: (path: string) => void
  onHooksInstall: () => void
  onHooksUninstall: () => void
  onQuit: () => void
}

export function SettingsTab(props: SettingsTabProps): ReactElement {
  const { config, runtime, t, onChange, onSay, onPickImage, onOpenPath, onHooksInstall, onHooksUninstall, onQuit } = props
  const relay = runtime.relay

  return (
    <div className="panel-body">
      {/* ---- voice ---------------------------------------------------- */}
      <section className="section">
        <h3 className="section-title">{t('secVoice')}</h3>
        <Toggle label={t('enabled')} checked={config.enabled} onChange={(v) => onChange({ enabled: v })} />
        <Toggle label={t('speak')} checked={config.speak} onChange={(v) => onChange({ speak: v })} />
        <Toggle
          label={t('popOnSessionStart')}
          checked={config.popOnSessionStart}
          onChange={(v) => onChange({ popOnSessionStart: v })}
        />
        <Toggle
          label={t('alwaysOnTop')}
          checked={config.alwaysOnTop}
          onChange={(v) => onChange({ alwaysOnTop: v })}
        />
        <Select
          label={t('lang')}
          value={config.lang}
          options={[
            { value: 'auto', label: t('langAuto') },
            { value: 'zh', label: '中文' },
            { value: 'en', label: 'English' }
          ]}
          onChange={(v) => onChange({ lang: v as ConfigPatch['lang'] })}
        />
        <Select
          label={t('voiceZh')}
          value={config.voice.zh}
          placeholder={t('voiceAuto')}
          options={voiceOptions(runtime.voices, 'zh')}
          onChange={(v) => onChange({ voice: { ...config.voice, zh: v } })}
        />
        <Select
          label={t('voiceEn')}
          value={config.voice.en}
          placeholder={t('voiceAuto')}
          options={voiceOptions(runtime.voices, 'en')}
          onChange={(v) => onChange({ voice: { ...config.voice, en: v } })}
        />
        <Slider
          label={t('rate')}
          value={config.voice.rate}
          min={110}
          max={300}
          step={2}
          display={String(config.voice.rate)}
          onChange={(v) => onChange({ voice: { ...config.voice, rate: v } })}
        />
        <div className="row">
          <div className="row-label" />
          <div className="row-control">
            <button className="text-btn" type="button" onClick={() => onSay(config.lang === 'en' ? 'Testing, one two three.' : '测试一下，我在。')}>
              <Volume2 size={13} /> {t('testVoice')}
            </button>
          </div>
        </div>
      </section>

      {/* ---- announced events ----------------------------------------- */}
      <section className="section">
        <h3 className="section-title">{t('secEvents')}</h3>
        {EVENT_ROWS.map((row) => (
          <Toggle
            key={row.key}
            label={t(row.label)}
            checked={config.events[row.key]}
            onChange={(v) => onChange({ events: { ...config.events, [row.key]: v } })}
          />
        ))}
      </section>

      {/* ---- appearance ----------------------------------------------- */}
      <section className="section">
        <h3 className="section-title">{t('secLook')}</h3>
        <Slider
          label={t('opacity')}
          value={config.opacity}
          min={0.35}
          max={1}
          step={0.05}
          display={`${Math.round(config.opacity * 100)}%`}
          onChange={(v) => onChange({ opacity: v })}
        />
        <Slider
          label={t('scale')}
          value={config.scale}
          min={0.6}
          max={1.8}
          step={0.05}
          display={`${Math.round(config.scale * 100)}%`}
          onChange={(v) => onChange({ scale: v })}
        />
        <Slider
          label={t('bubbleMs')}
          value={config.bubbleMs}
          min={2000}
          max={20000}
          step={500}
          display={`${(config.bubbleMs / 1000).toFixed(1)} ${t('seconds')}`}
          onChange={(v) => onChange({ bubbleMs: v })}
        />
        <div className="row">
          <div className="row-label">{t('avatar')}</div>
          <div className="row-control">
            <div className="segmented" style={{ flex: '0 0 auto' }}>
              <button type="button" aria-selected={config.avatar.mode === 'builtin'} onClick={() => onChange({ avatar: { ...config.avatar, mode: 'builtin' } })}>
                {t('avatarBuiltin')}
              </button>
              <button type="button" aria-selected={config.avatar.mode === 'image'} onClick={() => (config.avatar.imagePath ? onChange({ avatar: { ...config.avatar, mode: 'image' } }) : onPickImage())}>
                <ImageIcon size={12} /> {t('avatarImage')}
              </button>
            </div>
          </div>
        </div>
        {config.avatar.mode === 'image' && config.avatar.imagePath ? (
          <div className="row">
            <div className="row-label">
              <div className="row-sub">{config.avatar.imagePath}</div>
            </div>
            <div className="row-control">
              <button className="text-btn" type="button" onClick={onPickImage}>
                {t('chooseImage')}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* ---- relay / port --------------------------------------------- */}
      <section className="section">
        <h3 className="section-title">{t('secRelay')}</h3>
        <PortRow config={config} relay={relay} t={t} onChange={onChange} />
        <div className="row">
          <div className="row-label">
            {t('relayState')}
            <div className="row-sub">
              {relay.port ? `127.0.0.1:${relay.port} · ${reasonLabel(relay.reason)}` : 'not listening'}
            </div>
          </div>
          <div className="row-control">
            <span className="chip" data-state={relay.port ? 'ok' : 'warn'}>
              <span className="dot" /> {relay.port || '—'}
            </span>
          </div>
        </div>
        {relay.conflict ? <div className="hint warn">{t('relayConflict')}: {relay.conflict.hint}</div> : null}
        {relay.duplicateOf ? (
          <div className="hint danger">{t('relayDuplicate')}: pid {relay.duplicateOf}</div>
        ) : null}
        <div className="row">
          <div className="row-label">
            {t('endpointFile')}
            <div className="row-sub">{relay.endpointFile}</div>
          </div>
          <div className="row-control">
            <button className="icon-btn" type="button" title={t('openFolder')} aria-label={t('openFolder')} onClick={() => onOpenPath(relay.endpointFile)}>
              <FolderOpen size={14} />
            </button>
          </div>
        </div>
      </section>

      {/* ---- agent hooks ---------------------------------------------- */}
      <section className="section">
        <h3 className="section-title">{t('secHooks')}</h3>
        <Toggle
          label={t('autoInstallHooks')}
          checked={config.autoInstallHooks}
          onChange={(v) => onChange({ autoInstallHooks: v })}
        />
        <HookRow name={t('hooksCodex')} report={runtime.hooks.codex} detected={runtime.agents.codex} t={t} />
        <HookRow name={t('hooksClaude')} report={runtime.hooks.claude} detected={runtime.agents.claude} t={t} />
        {runtime.hooks.codexTrustNeeded ? <div className="hint warn">{t('trustNeeded')}</div> : null}
        <div className="row">
          <div className="row-label" />
          <div className="row-control">
            <button className="text-btn" type="button" onClick={onHooksInstall}>{t('hooksRepair')}</button>
            <button className="text-btn danger" type="button" onClick={onHooksUninstall}>{t('hooksRemove')}</button>
          </div>
        </div>
      </section>

      {/* ---- about ----------------------------------------------------- */}
      <section className="section">
        <h3 className="section-title">{t('secAbout')}</h3>
        <div className="row">
          <div className="row-label">{t('version')}</div>
          <div className="row-control"><span className="chip">{runtime.version}</span></div>
        </div>
        <div className="hint">
          electron {versions.electron} · chrome {versions.chrome} · node {versions.node} · {platform}
        </div>
        <div className="row">
          <div className="row-label" />
          <div className="row-control">
            <button className="text-btn danger" type="button" onClick={onQuit}>{t('quit')}</button>
          </div>
        </div>
      </section>
    </div>
  )
}

const EVENT_ROWS: Array<{ key: keyof RedactedConfig['events']; label: Parameters<Translate>[0] }> = [
  { key: 'sessionStart', label: 'evSessionStart' },
  { key: 'stop', label: 'evStop' },
  { key: 'permission', label: 'evPermission' },
  { key: 'notification', label: 'evNotification' },
  { key: 'compact', label: 'evCompact' },
  { key: 'subagent', label: 'evSubagent' },
  { key: 'tool', label: 'evTool' },
  { key: 'prompt', label: 'evPrompt' }
]

/**
 * The port field keeps a local draft so typing "80" on the way to "8080" does
 * not rebind the relay twice. Commits go through `normalizeRequestedPort`, the
 * same clamp the config parser uses, so junk collapses to automatic.
 */
function PortRow({
  config,
  relay,
  t,
  onChange
}: {
  config: RedactedConfig
  relay: RuntimeState['relay']
  t: Translate
  onChange: (patch: ConfigPatch) => void
}): ReactElement {
  const [draft, setDraft] = useState(String(config.port || ''))

  useEffect(() => {
    setDraft(config.port ? String(config.port) : '')
  }, [config.port])

  const commit = (): void => {
    const next = normalizeRequestedPort(draft)
    setDraft(next ? String(next) : '')
    if (next !== config.port) onChange({ port: next })
  }

  const envPinned = relay.pinned && relay.requested !== config.port

  return (
    <>
      <div className="row">
        <div className="row-label">
          {t('relayPort')}
          <div className="row-sub">{t('relayAuto')} = 0</div>
        </div>
        <div className="row-control">
          <input
            type="number"
            min={0}
            max={65535}
            value={draft}
            placeholder={t('relayAuto')}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit()
            }}
          />
        </div>
      </div>
      <Toggle label={t('pinPort')} checked={config.pinPort} onChange={(v) => onChange({ pinPort: v })} />
      {envPinned ? <div className="hint warn">CODEWAIFU_PORT = {relay.requested}</div> : null}
    </>
  )
}

function HookRow({
  name,
  report,
  detected,
  t
}: {
  name: string
  report: RuntimeState['hooks']['codex']
  detected: boolean
  t: Translate
}): ReactElement {
  const state = !detected ? 'none' : report.installed ? 'ok' : 'warn'
  const label = !detected ? t('notFound') : report.installed ? t('installed') : t('notInstalled')
  return (
    <div className="row">
      <div className="row-label">
        {name}
        {report.installed && report.events.length ? <div className="row-sub">{report.events.join(', ')}</div> : null}
        {report.error ? <div className="row-sub">{report.error}</div> : null}
      </div>
      <div className="row-control">
        <span className="chip" data-state={state === 'ok' ? 'ok' : 'warn'}>
          <span className="dot" /> {label}
        </span>
      </div>
    </div>
  )
}

function Toggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}): ReactElement {
  return (
    <div className="row">
      <div className="row-label">{label}</div>
      <div className="row-control">
        <button
          type="button"
          className="switch"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          onClick={() => onChange(!checked)}
        />
      </div>
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onChange: (value: number) => void
}): ReactElement {
  return (
    <div className="row">
      <div className="row-label">{label}</div>
      <div className="row-control">
        <span className="chip">{display}</span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
    </div>
  )
}

function Select({
  label,
  value,
  options,
  placeholder,
  onChange
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  placeholder?: string
  onChange: (value: string) => void
}): ReactElement {
  // A voice saved in config may no longer be installed; keep it selectable so
  // the user can see what is configured instead of silently showing a default.
  const known = value && !options.some((option) => option.value === value)
  return (
    <div className="row">
      <div className="row-label">{label}</div>
      <div className="row-control">
        <select value={value} aria-label={label} onChange={(event) => onChange(event.target.value)}>
          <option value="">{placeholder || ''}</option>
          {known ? <option value={value}>{value}</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

function voiceOptions(voices: RuntimeState['voices'], lang: 'zh' | 'en'): Array<{ value: string; label: string }> {
  return voices
    .filter((voice) => (lang === 'zh' ? /zh|cmn|Chinese/i.test(voice.lang) : /en|English/i.test(voice.lang)))
    .map((voice) => ({ value: voice.name, label: voice.name }))
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'pinned':
      return 'pinned'
    case 'sticky':
      return 'reused'
    case 'os-assigned':
      return 'os-assigned'
    default:
      return reason
  }
}
