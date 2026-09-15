/**
 * The empty state, which is the first thing most people will see.
 *
 * Two different situations render here and they must not be conflated: Pro
 * switched off in config (our own switch, one click from on) and herdr missing
 * (a dependency that owns every terminal we could show). The first gets an
 * Enable button; the second gets the exact command to run, selectable, because
 * "install the thing" is not actionable advice unless it can be copied.
 *
 * The chrome around this card stays mounted. A cockpit that blanks itself
 * because a dependency is missing cannot be configured back to life.
 */
import { useState, type ReactElement } from 'react'
import { RefreshCw, ToggleRight } from 'lucide-react'
import type { HerdrView } from '@shared/pro'
import { fill, type Translate } from './i18n'
import { platform, proApi } from './api'
import type { Tone } from './toast'

export interface InstallCardProps {
  herdr: HerdrView | null
  proEnabled: boolean
  t: Translate
  onNotify: (text: string, tone?: Tone) => void
  onEnabled: () => void
}

/** herdr's own installer, per platform. Copied from herdr.dev/install docs. */
function installCommand(): string {
  return platform === 'win32'
    ? 'curl.exe -fsSLo install.cmd https://herdr.dev/install.cmd && install.cmd && del install.cmd'
    : 'curl -fsSL https://herdr.dev/install.sh | sh'
}

export function InstallCard({
  herdr,
  proEnabled,
  t,
  onNotify,
  onEnabled
}: InstallCardProps): ReactElement {
  const [busy, setBusy] = useState(false)

  if (!proEnabled) {
    return (
      <div className="install">
        <div className="install-card">
          <h1 className="install-title">{t('proDisabledTitle')}</h1>
          <p className="install-body">{t('proDisabledBody')}</p>
          <div className="install-actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                const result = await proApi.setConfig({ enabled: true })
                setBusy(false)
                if (!result.ok) {
                  onNotify(result.detail || result.code, 'error')
                  return
                }
                onEnabled()
              }}
            >
              <ToggleRight />
              {t('proEnable')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const retry = async (): Promise<void> => {
    setBusy(true)
    const result = await proApi.host.discovery()
    setBusy(false)
    if (!result.ok) onNotify(result.detail || result.code, 'error')
  }

  return (
    <div className="install">
      <div className="install-card">
        <h1 className="install-title">{t('installTitle')}</h1>
        <p className="install-body">{t('installBody')}</p>
        {herdr?.error && <p className="install-error">{fill(t, 'installError', { error: herdr.error })}</p>}
        <div className="install-step">
          <span className="section-label">{t('installRun')}</span>
          <pre className="install-cmd">herdr</pre>
        </div>
        <div className="install-step">
          <span className="section-label">{t('installHint')}</span>
          <pre className="install-cmd">{installCommand()}</pre>
        </div>
        <div className="install-actions">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void retry()}>
            <RefreshCw />
            {t('refresh')}
          </button>
        </div>
      </div>
    </div>
  )
}
