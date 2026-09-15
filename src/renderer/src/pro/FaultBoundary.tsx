/**
 * The last component standing when the bench throws.
 *
 * React unmounts the entire tree on an uncaught render or mount-effect error, so
 * without this a crash is an empty window and a clean main-process log. Two such
 * crashes shipped in the first Pro builds (`shared/lang.ts` reading `process.env`
 * in a renderer module, and `Pane` constructing a terminal before the Unicode11
 * addon had turned on the proposed-API flag) and both were found by attaching a
 * debugger to the window rather than by looking at the app. This turns the same
 * failure into four lines of text and two buttons.
 *
 * Three constraints shape it, and they are why it is not a generic "ErrorCard":
 *
 * 1. It may not depend on anything that can itself be broken. No `proApi`, no
 *    config, no context, no import of `Bench`. Language comes from `navigator`
 *    rather than from the user's `uiLang` setting for the same reason: a fault
 *    card in the wrong language still beats a blank frame.
 * 2. It says the thing that actually matters first. herdr owns the PTYs, so a
 *    dead renderer has killed nobody, and reloading is safe - the tree and the
 *    ledger are re-derived from disk and from herdr at boot.
 * 3. It decides nothing about the error itself. Kind, message and frames come
 *    from `@shared/renderFault`, where a test pins them; a boundary that formats
 *    a stack trace inline is a boundary that can throw while rendering a throw.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Copy, RefreshCw } from 'lucide-react'
import { systemLangFromLocales } from '@shared/lang'
import { describeFault, formatFault, type RenderFault } from '@shared/renderFault'
import { makeTranslator, type Translate } from './i18n'

export interface FaultBoundaryProps {
  children: ReactNode
}

interface FaultBoundaryState {
  fault: RenderFault | null
  /** Whether "Copy details" worked. A silent failure here is a lost bug report. */
  copied: 'idle' | 'ok' | 'fail'
}

/** How long the button reads "Copied" before it becomes a button again. */
const COPIED_MS = 2000

/**
 * The interface language as this window can see it without asking anybody.
 *
 * Duplicated from `Bench.tsx` on purpose: importing it from there would pull the
 * whole bench module into the one component that has to keep working when the
 * bench module is what broke.
 */
function localLang(): 'zh' | 'en' {
  const locales = navigator.languages?.length ? navigator.languages : [navigator.language || 'en']
  return systemLangFromLocales(locales)
}

export class FaultBoundary extends Component<FaultBoundaryProps, FaultBoundaryState> {
  state: FaultBoundaryState = { fault: null, copied: 'idle' }

  private readonly t: Translate

  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(props: FaultBoundaryProps) {
    super(props)
    this.t = makeTranslator(localLang())
  }

  static getDerivedStateFromError(error: unknown): Partial<FaultBoundaryState> {
    return { fault: describeFault(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The card is for whoever is looking at the window; this line is for whoever
    // debugs it. `componentStack` is what a bundled `error.stack` usually cannot
    // tell you: which of our components was rendering when it threw.
    console.error('[pro] renderer fault', error, info?.componentStack ?? '')
  }

  componentWillUnmount(): void {
    if (this.timer) clearTimeout(this.timer)
  }

  private readonly reload = (): void => {
    window.location.reload()
  }

  private readonly copy = (): void => {
    const fault = this.state.fault
    if (!fault) return
    const text = formatFault(fault, this.t('faultUnknown'))
    try {
      // `navigator.clipboard` is gated on document focus and can be absent
      // entirely, and this is the one button whose whole job is to get a crash
      // off the machine - so a refusal is shown, not swallowed.
      const written = navigator.clipboard?.writeText(text)
      if (!written) {
        this.mark('fail')
        return
      }
      void written.then(
        () => this.mark('ok'),
        () => this.mark('fail')
      )
    } catch {
      this.mark('fail')
    }
  }

  private mark(copied: 'ok' | 'fail'): void {
    if (this.timer) clearTimeout(this.timer)
    this.setState({ copied })
    // Back to idle rather than latched: the usual cause of a failed copy is an
    // unfocused window, and the next click succeeds.
    this.timer = setTimeout(() => this.setState({ copied: 'idle' }), COPIED_MS)
  }

  render(): ReactNode {
    const fault = this.state.fault
    if (!fault) return this.props.children

    const t = this.t
    const copied = this.state.copied
    return (
      <div className="fault" role="alert">
        <header className="fault-head">
          <h1 className="fault-title">{t('faultTitle')}</h1>
          <code className="fault-kind">{fault.kind}</code>
        </header>
        <p className="fault-body">{t('faultBody')}</p>
        <p className="fault-message">{fault.message || t('faultUnknown')}</p>
        {fault.stack.length > 0 && <pre className="fault-stack">{fault.stack.join('\n')}</pre>}
        <div className="fault-actions">
          <button type="button" className="btn primary" onClick={this.reload}>
            <RefreshCw size={12} />
            {t('faultReload')}
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={this.copy}
            data-on={copied === 'ok' || undefined}
          >
            <Copy size={12} />
            {copied === 'ok' ? t('faultCopied') : t('faultCopy')}
          </button>
        </div>
        {copied === 'fail' && <p className="fault-failed">{t('faultCopyFailed')}</p>}
      </div>
    )
  }
}
