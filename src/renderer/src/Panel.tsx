import { useState, type ReactElement } from 'react'
import { Activity, ChevronsUpDown, ListTree, Settings2 } from 'lucide-react'
import type { HookEvent, RedactedConfig, RuntimeState, SteerResult, ThreadInfo } from '@shared/protocol'
import type { PanelTab } from '@shared/ui'
import type { ConfigPatch } from '@shared/config'
import type { Translate } from './i18n'
import { ChatView } from './ChatView'
import { LogTab } from './LogTab'
import { SettingsTab } from './SettingsTab'
import { ThreadsTab } from './ThreadsTab'
import { Tip } from './Tip'

interface PanelProps {
  tab: PanelTab
  onTab: (tab: PanelTab) => void
  config: RedactedConfig
  runtime: RuntimeState
  events: HookEvent[]
  threads: ThreadInfo[]
  /** Thread currently drilled into; null shows the tabbed panel. */
  chatThread: ThreadInfo | null
  t: Translate
  /** Resolved UI language; the character names are bilingual in the catalog. */
  lang: 'zh' | 'en'
  onChange: (patch: ConfigPatch) => void
  onSay: (text: string) => void
  onPickImage: () => void
  onOpenPath: (path: string) => void
  onHooksInstall: () => void
  onHooksUninstall: () => void
  onNeuralRetry: () => void
  onQuit: () => void
  onCollapse: () => void
  onOpenThread: (thread: ThreadInfo) => void
  onCloseChat: () => void
  onSteer: (agent: ThreadInfo['agent'], threadId: string, message: string) => Promise<SteerResult>
  onNotice: (text: string) => void
}

const TABS: Array<{ id: PanelTab; icon: typeof ListTree; label: Parameters<Translate>[0] }> = [
  { id: 'threads', icon: ListTree, label: 'tabThreads' },
  { id: 'log', icon: Activity, label: 'tabLog' },
  { id: 'settings', icon: Settings2, label: 'tabSettings' }
]

export function Panel(props: PanelProps): ReactElement {
  const { tab, onTab, t, onCollapse } = props
  const [hovered, setHovered] = useState<PanelTab | null>(null)

  // Drilling into a thread replaces the whole panel: a chat needs the header
  // row and every pixel of height, and a tab bar above it would be dead chrome.
  if (props.chatThread) {
    return (
      <div className="panel" data-solid="1">
        <ChatView
          thread={props.chatThread}
          t={t}
          lang={props.lang}
          onBack={props.onCloseChat}
          onSteer={props.onSteer}
          onNotice={props.onNotice}
          onSay={props.onSay}
          onOpenPath={props.onOpenPath}
        />
      </div>
    )
  }

  return (
    <div className="panel" data-solid="1">
      <div className="panel-head">
        <div className="segmented" role="tablist" aria-label="CodeWaifu panel">
          {TABS.map((entry) => {
            const Icon = entry.icon
            const selected = tab === entry.id
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={selected}
                title={t(entry.label)}
                onMouseEnter={() => setHovered(entry.id)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => onTab(entry.id)}
              >
                <Icon size={13} strokeWidth={2.1} />
                {/* At 320px three icon+label tabs overflow, so the inactive
                    ones collapse to their icon until hovered. */}
                {selected || hovered === entry.id ? <span>{t(entry.label)}</span> : null}
              </button>
            )
          })}
        </div>
        <Tip label={t('collapse')}>
          <button
            className="icon-btn"
            type="button"
            aria-label={t('collapse')}
            onClick={onCollapse}
          >
            <ChevronsUpDown size={15} />
          </button>
        </Tip>
      </div>

      {tab === 'threads' ? (
        <ThreadsTab threads={props.threads} t={t} onOpen={props.onOpenThread} />
      ) : null}
      {tab === 'log' ? <LogTab events={props.events} t={t} /> : null}
      {tab === 'settings' ? (
        <SettingsTab
          config={props.config}
          runtime={props.runtime}
          t={t}
          lang={props.lang}
          onChange={props.onChange}
          onSay={props.onSay}
          onPickImage={props.onPickImage}
          onOpenPath={props.onOpenPath}
          onHooksInstall={props.onHooksInstall}
          onHooksUninstall={props.onHooksUninstall}
          onNeuralRetry={props.onNeuralRetry}
          onQuit={props.onQuit}
        />
      ) : null}
    </div>
  )
}
