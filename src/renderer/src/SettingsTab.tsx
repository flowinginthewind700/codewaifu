import { useEffect, useState, type ReactElement } from 'react'
import { FolderOpen, Image as ImageIcon, RefreshCw, Volume2 } from 'lucide-react'
import type { ConfigPatch } from '@shared/config'
import { clampZoom, ZOOM_MAX, ZOOM_MIN } from '@shared/zoom'
import { acceleratorFromCombo, formatAccelerator } from '@shared/hotkey'
import { normalizeRequestedPort } from '@shared/portPolicy'
import {
  HOOK_AGENTS,
  type AgentHookStatus,
  type NeuralPhase,
  type NeuralStatus,
  type RedactedConfig,
  type RuntimeState,
  type VoiceEngine
} from '@shared/protocol'
import { LIVE2D_CATALOG } from '@shared/live2dCatalog'
import type { Translate } from './i18n'
import { assetUrl } from './live2d/assets'
import { platform, versions } from './api'

interface SettingsTabProps {
  config: RedactedConfig
  runtime: RuntimeState
  t: Translate
  lang: 'zh' | 'en'
  onChange: (patch: ConfigPatch) => void
  onSay: (text: string) => void
  onPickImage: () => void
  onOpenPath: (path: string) => void
  onHooksInstall: () => void
  onHooksUninstall: () => void
  onNeuralRetry: () => void
  onQuit: () => void
}

export function SettingsTab(props: SettingsTabProps): ReactElement {
  const {
    config,
    runtime,
    t,
    lang,
    onChange,
    onSay,
    onPickImage,
    onOpenPath,
    onHooksInstall,
    onHooksUninstall,
    onNeuralRetry,
    onQuit
  } = props
  const relay = runtime.relay
  const neural = config.voice.engine === 'matcha'

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
        <Segmented
          label={t('voiceEngine')}
          value={config.voice.engine}
          options={[
            { value: 'matcha', label: t('engineMatcha') },
            { value: 'system', label: t('engineSystem') }
          ]}
          onChange={(v) => onChange({ voice: { ...config.voice, engine: v as VoiceEngine } })}
        />
        <div className="hint">{neural ? t('engineMatchaHint') : t('engineSystemHint')}</div>
        {neural ? (
          <>
            <Toggle
              label={t('autoDownload')}
              checked={config.voice.autoDownload}
              onChange={(v) => onChange({ voice: { ...config.voice, autoDownload: v } })}
            />
            <NeuralRow neural={runtime.neural} t={t} onRetry={onNeuralRetry} onOpenPath={onOpenPath} />
          </>
        ) : (
          <>
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
          </>
        )}
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
            <button
              className="text-btn"
              type="button"
              onClick={() => onSay(lang === 'en' ? 'Testing, one two three.' : '测试一下，我在。')}
            >
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
        <Select
          label={t('uiLang')}
          value={config.uiLang}
          options={[
            { value: 'auto', label: t('uiLangAuto') },
            { value: 'zh', label: '中文' },
            { value: 'en', label: 'English' }
          ]}
          onChange={(v) => onChange({ uiLang: v as ConfigPatch['uiLang'] })}
        />
        <div className="hint">{t('uiLangHint')}</div>
        <Segmented
          label={t('surface')}
          value={config.appearance.surface}
          options={[
            { value: 'glass', label: t('surfaceGlass') },
            { value: 'solid', label: t('surfaceSolid') }
          ]}
          onChange={(v) =>
            onChange({ appearance: { ...config.appearance, surface: v === 'solid' ? 'solid' : 'glass' } })
          }
        />
        <div className="hint">{t('surfaceHint')}</div>
        {config.avatar.mode === 'live2d' ? (
          <>
            <Toggle
              label={t('clearStage')}
              checked={config.appearance.clearStage}
              onChange={(v) => onChange({ appearance: { ...config.appearance, clearStage: v } })}
            />
            <div className="hint">{t('clearStageHint')}</div>
          </>
        ) : null}
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
        {/* The same rung Ctrl+= walks: the slider lands on it, main clamps it,
            so this row and the keystroke path cannot disagree about 130%. */}
        <Slider
          label={t('uiZoom')}
          value={clampZoom(config.uiZoom)}
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={0.1}
          display={`${Math.round(clampZoom(config.uiZoom) * 100)}%`}
          onChange={(v) => onChange({ uiZoom: v })}
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
              <button type="button" aria-selected={config.avatar.mode === 'live2d'} onClick={() => onChange({ avatar: { ...config.avatar, mode: 'live2d' } })}>
                {t('avatarLive2d')}
              </button>
              <button type="button" aria-selected={config.avatar.mode === 'builtin'} onClick={() => onChange({ avatar: { ...config.avatar, mode: 'builtin' } })}>
                {t('avatarBuiltin')}
              </button>
              <button type="button" aria-selected={config.avatar.mode === 'image'} onClick={() => (config.avatar.imagePath ? onChange({ avatar: { ...config.avatar, mode: 'image' } }) : onPickImage())}>
                <ImageIcon size={12} /> {t('avatarImage')}
              </button>
            </div>
          </div>
        </div>
        {config.avatar.mode === 'live2d' ? (
          <>
            <div className="row">
              <div className="row-label">{t('character')}</div>
              <div className="row-control">
                <div className="chars">
                  {LIVE2D_CATALOG.characters.map((character) => {
                    const selected = character.id === config.avatar.character
                    const label = lang === 'zh' ? character.labelZh : character.labelEn
                    return (
                      <button
                        key={character.id}
                        type="button"
                        className="char"
                        aria-pressed={selected}
                        title={lang === 'zh' ? character.blurbZh : character.blurbEn}
                        onClick={() => onChange({ avatar: { ...config.avatar, character: character.id } })}
                      >
                        {character.thumbUrl ? (
                          <img src={assetUrl(character.thumbUrl)} alt="" draggable={false} loading="lazy" />
                        ) : null}
                        <span>{label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
            <div className="hint">{t('live2dHint')}</div>
          </>
        ) : null}
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

      {/* ---- window & hotkey ----------------------------------------- */}
      <section className="section">
        <h3 className="section-title">{t('secWindow')}</h3>
        <HotkeyRow t={t} value={config.hotkey} onChange={(hotkey) => onChange({ hotkey })} />
        {/* `pro` is replaced wholesale by `parseConfig`, never merged key by
            key, so the spread is the write: dropping it would erase every
            other bench setting on this one click. */}
        <Toggle
          label={t('benchFrame')}
          checked={config.pro.benchFrame}
          onChange={(value) => onChange({ pro: { ...config.pro, benchFrame: value } })}
        />
        <div className="hint">{t('benchFrameHint')}</div>
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
        {HOOK_ROWS.map((row) => (
          <HookRow
            key={row.agent}
            name={t(row.label)}
            report={runtime.hooks.agents[row.agent] ?? EMPTY_HOOK_STATUS}
            detected={Boolean(runtime.agents[row.agent])}
            t={t}
          />
        ))}
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
 * The hooks section lists every flavor we can install into, in one order.
 * Derived from `HOOK_AGENTS` rather than typed out here: adding an agent to the
 * shared list must add its row, or settings silently stops telling the truth
 * about what is installed.
 */
const HOOK_LABELS: Record<string, Parameters<Translate>[0]> = {
  codex: 'hooksCodex',
  claude: 'hooksClaude',
  cursor: 'hooksCursor',
  gemini: 'hooksGemini',
  antigravity: 'hooksAntigravity',
  kimi: 'hooksKimi'
}

const HOOK_ROWS: Array<{ agent: (typeof HOOK_AGENTS)[number]; label: Parameters<Translate>[0] }> = HOOK_AGENTS.map(
  (agent) => ({ agent, label: HOOK_LABELS[agent] ?? 'hooksAgent' })
)

/** An agent main never reported: shown as "not detected", never as installed. */
const EMPTY_HOOK_STATUS: AgentHookStatus = { path: '', installed: false, events: [] }

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

/**
 * Recorder row for the system-wide summon hotkey. Recording captures the next
 * keydown at the window (capture phase, so the panel's own shortcuts stay out
 * of it) and refuses bare keys: a global grab of a plain letter would swallow
 * typing in every other app on the machine.
 */
function HotkeyRow({
  t,
  value,
  onChange
}: {
  t: Translate
  value: string
  onChange: (hotkey: string) => void
}): ReactElement {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!recording) return
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        setError(false)
        return
      }
      const accelerator = acceleratorFromCombo({
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        code: event.code,
        key: event.key
      })
      if (!accelerator) {
        setError(true)
        return
      }
      setError(false)
      setRecording(false)
      onChange(accelerator)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, onChange])

  return (
    <>
      <div className="row">
        <div className="row-label">{t('hotkey')}</div>
        <div className="row-control">
          <button
            type="button"
            className={recording ? 'text-btn recording' : 'text-btn'}
            onClick={() => {
              setRecording((was) => !was)
              setError(false)
            }}
          >
            {recording ? t('hotkeyRecord') : formatAccelerator(value, platform === 'darwin')}
          </button>
        </div>
      </div>
      {error ? <div className="hint warn">{t('hotkeyInvalid')}</div> : <div className="hint">{t('hotkeyHint')}</div>}
    </>
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

/** Two-or-three-way choice, drawn as the same segmented control the tabs use. */
function Segmented({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}): ReactElement {
  return (
    <div className="row">
      <div className="row-label">{label}</div>
      <div className="row-control">
        <div className="segmented" style={{ flex: '0 0 auto' }}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-selected={option.value === value}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const NEURAL_LABEL: Record<NeuralPhase, Parameters<Translate>[0]> = {
  ready: 'neuralReady',
  downloading: 'neuralDownloading',
  extracting: 'neuralExtracting',
  loading: 'neuralLoading',
  missing: 'neuralMissing',
  unavailable: 'neuralUnavailable',
  error: 'neuralError'
}

/**
 * The 134MB weight download, honestly reported. It runs in the background and
 * the OS voice covers for it, so the only thing this row has to do is tell the
 * user whether it is coming, here, or stuck — and give a way to push it.
 */
function NeuralRow({
  neural,
  t,
  onRetry,
  onOpenPath
}: {
  neural: NeuralStatus
  t: Translate
  onRetry: () => void
  onOpenPath: (path: string) => void
}): ReactElement {
  const phase = neural.phase
  const busy = phase === 'downloading' || phase === 'extracting' || phase === 'loading'
  const pct = neural.total > 0 ? Math.min(100, Math.round((neural.received / neural.total) * 100)) : 0
  const state = phase === 'ready' ? 'ok' : phase === 'error' || phase === 'unavailable' ? 'warn' : 'live'
  const mb = (n: number): string => (n / 1e6).toFixed(1)
  const sub =
    phase === 'downloading' && neural.file
      ? neural.file
      : phase === 'error'
        ? [neural.error, neural.dir].filter(Boolean).join(' · ')
        : phase === 'ready' && neural.loadMs
          ? t('neuralColdLoad').replace('{ms}', String(neural.loadMs))
          : ''

  return (
    <>
      <div className="row">
        <div className="row-label">
          {t('neuralModel')}
          {sub ? <div className="row-sub">{sub}</div> : null}
        </div>
        <div className="row-control">
          <span className="chip" data-state={state}>
            <span className={busy ? 'dot pulse' : 'dot'} />
            {phase === 'downloading' ? `${pct}%` : t(NEURAL_LABEL[phase])}
          </span>
        </div>
      </div>
      {busy ? (
        <div className="row">
          <div className="row-label">
            <div className="row-sub">
              {neural.total > 0 ? `${mb(neural.received)} / ${mb(neural.total)} MB` : mb(neural.received) + ' MB'}
            </div>
          </div>
          <div className="row-control">
            <span className="meter">
              <span
                className="meter-fill"
                data-indeterminate={phase === 'downloading' ? undefined : '1'}
                style={{ width: phase === 'downloading' ? `${pct}%` : undefined }}
              />
            </span>
          </div>
        </div>
      ) : null}
      {phase === 'error' || phase === 'missing' ? (
        <div className="row">
          <div className="row-label" />
          <div className="row-control">
            <button className="text-btn" type="button" onClick={onRetry}>
              <RefreshCw size={13} /> {phase === 'error' ? t('neuralRetry') : t('neuralDownload')}
            </button>
            {neural.dir ? (
              <button className="text-btn" type="button" onClick={() => onOpenPath(neural.dir)}>
                <FolderOpen size={13} /> {t('openFolder')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
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
