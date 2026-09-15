/**
 * The pane grid (F4): every live pane of the selected task, as real terminals.
 *
 * Zoom is renderer state, not herdr state. herdr has its own zoom and we expose
 * it as a separate verb (`pane.zoom`) because a herdr-side zoom changes what the
 * multiplexer shows everywhere; ours only changes what this window draws, and
 * conflating the two would make the bench's layout depend on another window
 * somewhere else on the machine.
 */
import { useEffect, useState, type ReactElement } from 'react'
import type { TaskView } from '@shared/pro'
import { Pane } from './Pane'
import type { Translate } from './i18n'
import type { Tone } from './toast'

export interface PaneGridProps {
  task: TaskView | null
  selectedPaneId: string
  t: Translate
  onSelectPane: (paneId: string) => void
  onNotify: (text: string, tone?: Tone) => void
}

export function PaneGrid({
  task,
  selectedPaneId,
  t,
  onSelectPane,
  onNotify
}: PaneGridProps): ReactElement {
  const [zoomedId, setZoomedId] = useState('')
  const taskId = task?.id ?? ''
  const panes = task?.panes ?? []

  // Switching task or focus must never leave you staring at a hidden pane.
  useEffect(() => {
    setZoomedId('')
  }, [taskId])

  useEffect(() => {
    if (zoomedId && selectedPaneId && zoomedId !== selectedPaneId) setZoomedId('')
  }, [selectedPaneId, zoomedId])

  if (!task) {
    return <div className="panes-empty">{t('noTask')}</div>
  }

  if (!panes.length) {
    return <div className="panes-empty">{t('noPanes')}</div>
  }

  return (
    <div className="panes" data-count={Math.min(panes.length, 4)} data-zoomed={zoomedId !== ''}>
      {panes.map((pane) => (
        <Pane
          key={pane.paneId}
          pane={pane}
          active={zoomedId ? zoomedId === pane.paneId : selectedPaneId === pane.paneId}
          zoomed={zoomedId !== ''}
          t={t}
          onSelect={onSelectPane}
          onZoom={(id) => setZoomedId((current) => (current === id ? '' : id))}
          onNotify={onNotify}
        />
      ))}
    </div>
  )
}
