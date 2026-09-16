/**
 * Connect: one palette for "get me a shell somewhere".
 *
 * The shape follows the rest of the bench's dialogs (a filter, a list, a foot)
 * but three decisions are specific to it:
 *
 * 1. **The input is both a filter and a destination.** Everything the roster
 *    knows is filtered by it, and if what is typed names a box the roster does
 *    not have, that becomes a row of its own. So the palette is useful on a
 *    machine with an empty `~/.ssh/config` and no saved hosts, which is the
 *    state every fresh install starts in.
 * 2. **A local terminal is the last row, not another screen.** "Open a shell
 *    here" and "ssh somewhere" are the same gesture - both end in a pane the
 *    bench already knows how to draw - so they share one palette. The row is
 *    always present, which also means the list is never empty and Enter always
 *    does something.
 * 3. **Probing is explicit and never automatic.** A probe spawns a real `ssh`
 *    with a connect timeout; running one per row on every keystroke would put
 *    a dozen network round trips behind a filter box. The verdict is cached for
 *    the life of the dialog and re-run when asked, so "test again after setting
 *    up keys" works.
 *
 * Verbs are Alt-accelerators rather than bare letters because the input owns
 * the keyboard: an unmodified `s` has to keep typing the hostname. They are
 * matched on `event.code`, since Option+P on mac reports the composed `π` in
 * `event.key` and would never match a letter.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'
import { Activity, KeyRound, Pin, PinOff, Plug, TerminalSquare, X } from 'lucide-react'
import type { ProbeStatus, SshMachine } from '@shared/ssh'
import { machineKey, parseTarget } from '@shared/ssh'
import type { ProResult, ProSessionOpened } from '@shared/proIpc'
import { proApi } from './api'
import { fill, type StringKey, type Translate } from './i18n'
import type { Tone } from './toast'

export interface ConnectDialogProps {
  t: Translate
  /**
   * Where a local terminal opens, and the initial `cwd` of a session: the
   * selected task's working directory. Empty means home, which main resolves -
   * the same rule the New task form uses.
   */
  cwd: string
  onCancel: () => void
  onNotify: (text: string, tone?: Tone) => void
}

/** One selectable line in the list. */
type Row =
  | { kind: 'machine'; id: string; machine: SshMachine }
  /** Built from the input; `target` is what the human actually typed. */
  | { kind: 'typed'; id: string; machine: SshMachine; target: string }
  | { kind: 'terminal'; id: string }

interface ProbeEntry {
  status: ProbeStatus
  detail: string
}

const PROBE_KEY: Record<ProbeStatus, StringKey> = {
  unknown: 'sshProbeUnknown',
  ok: 'sshProbeOk',
  auth: 'sshProbeAuth',
  'host-key': 'sshProbeHostKey',
  timeout: 'sshProbeTimeout',
  unreachable: 'sshProbeUnreachable',
  'no-ssh': 'sshProbeNoSsh',
  error: 'sshProbeError'
}

const SOURCE_KEY: Record<SshMachine['source'], StringKey> = {
  saved: 'sshSourceSaved',
  config: 'sshSourceConfig',
  herdr: 'sshSourceHerdr'
}

/** Long enough to coalesce a fast typist, short enough to feel immediate. */
const DEBOUNCE_MS = 120

/** The second line of a machine row: what ssh would actually dial. */
function describe(machine: SshMachine): string {
  const dest = machine.user ? `${machine.user}@${machine.host}` : machine.host
  const port = machine.port && machine.port !== 22 ? `:${machine.port}` : ''
  // An alias is worth showing only when it differs from the host it resolves
  // to; `prod → prod` is noise where `prod → 10.0.0.4` is the useful half.
  return machine.alias && machine.alias !== machine.host
    ? `${machine.alias} → ${dest}${port}`
    : `${dest}${port}`
}

export function ConnectDialog({
  t,
  cwd,
  onCancel,
  onNotify
}: ConnectDialogProps): ReactElement {
  const [query, setQuery] = useState('')
  const [machines, setMachines] = useState<readonly SshMachine[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [index, setIndex] = useState(0)
  const [probes, setProbes] = useState<Record<string, ProbeEntry>>({})
  /** The row with a call in flight, so a double press cannot start two. */
  const [busy, setBusy] = useState('')

  // Guards an out-of-order answer: a slow `list` for an old query must not
  // overwrite the roster that matches what is on screen right now.
  const queryRef = useRef(query)
  const listRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async (wanted: string): Promise<void> => {
    const result = await proApi.ssh.list(wanted)
    if (queryRef.current !== wanted) return
    setLoading(false)
    if (!result.ok) {
      // Shown, never rendered as an empty list: "no machines" and "the roster
      // did not answer" call for different fixes.
      setError(result.detail || result.code || 'failed')
      return
    }
    setError('')
    setMachines(result.data?.machines ?? [])
  }, [])

  useEffect(() => {
    queryRef.current = query
    const timer = setTimeout(() => {
      void load(query)
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, load])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = machines.map((machine) => ({
      kind: 'machine' as const,
      id: machine.id,
      machine
    }))
    const typed = parseTarget(query)
    // A typed target that is already in the list would be the same box twice,
    // and `machineKey` is the same identity the roster was deduped by.
    if (typed && !machines.some((machine) => machineKey(machine) === machineKey(typed))) {
      out.push({
        kind: 'typed',
        id: `typed:${machineKey(typed)}`,
        machine: typed,
        target: query.trim()
      })
    }
    out.push({ kind: 'terminal', id: 'terminal' })
    return out
  }, [machines, query])

  // A new query starts from the top: the row under the cursor before you typed
  // has nothing to do with the row under it now.
  useEffect(() => {
    setIndex(0)
  }, [query])

  useEffect(() => {
    setIndex((value) => Math.min(value, Math.max(0, rows.length - 1)))
  }, [rows.length])

  // Keep the selection visible; the list scrolls, the dialog does not.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('.connect-row[data-selected]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [index, rows.length])

  /** The one place a `ProResult` becomes feedback, with the ssh-specific reads. */
  const report = useCallback(
    (result: ProResult, done?: string): boolean => {
      if (!result.ok) {
        // `offline` is main's word for "herdr is not reachable", which reads as
        // an infrastructure bug. The user-facing fact is that terminals need it.
        onNotify(
          result.code === 'offline' ? t('sshNeedHerdr') : result.detail || result.code || 'failed',
          'error'
        )
        return false
      }
      if (done) onNotify(done, 'ok')
      return true
    },
    [onNotify, t]
  )

  /**
   * A pane that opened but never received the connect line is the failure mode
   * this feature has to name out loud: it looks exactly like a successful
   * connect until you notice the shell is sitting at a local prompt.
   */
  const noteTyped = useCallback(
    (data: Partial<ProSessionOpened> | null, expected: number): void => {
      if (expected > 0 && (data?.typed ?? 0) === 0) onNotify(t('sshSendFailed'), 'warn')
    },
    [onNotify, t]
  )

  const activate = useCallback(
    async (row: Row): Promise<void> => {
      if (busy) return
      setBusy(row.id)
      if (row.kind === 'terminal') {
        const result = await proApi.ssh.terminal(cwd)
        setBusy('')
        if (!report(result, t('sshTerminalOpened'))) return
        onCancel()
        return
      }
      const target = row.kind === 'typed' ? row.target : ''
      const result = await proApi.ssh.connect({
        machine: row.machine,
        target,
        // Pinning on connect is what makes the second time one keystroke; a
        // machine you just used is a machine you meant to keep.
        save: true,
        cwd
      })
      setBusy('')
      if (!report(result, fill(t, 'sshConnected', { label: row.machine.label }))) return
      noteTyped(result.data, 1)
      onCancel()
    },
    [busy, cwd, noteTyped, onCancel, report, t]
  )

  const probe = useCallback(
    async (row: Row): Promise<void> => {
      if (busy || row.kind === 'terminal') return
      setBusy(row.id)
      const result = await proApi.ssh.probe(
        row.machine,
        row.kind === 'typed' ? row.target : ''
      )
      setBusy('')
      if (!report(result)) return
      const data = result.data
      if (!data) return
      setProbes((current) => ({
        ...current,
        [row.id]: { status: data.status, detail: data.detail }
      }))
    },
    [busy, report]
  )

  const pin = useCallback(
    async (row: Row): Promise<void> => {
      if (busy || row.kind === 'terminal') return
      setBusy(row.id)
      const result = await proApi.ssh.save(row.machine, row.kind === 'typed' ? row.target : '')
      setBusy('')
      if (!report(result, fill(t, 'sshPinned', { label: row.machine.label }))) return
      // The saved roster just changed underneath us; re-read so the row's
      // `saved` pill and its durable id are the ones main now holds.
      await load(queryRef.current)
    },
    [busy, load, report, t]
  )

  const unpin = useCallback(
    async (row: Row): Promise<void> => {
      if (busy || row.kind !== 'machine') return
      // Only a machine this app saved can be unsaved. A `~/.ssh/config` alias
      // belongs to the user's own file and deleting it from here would be a
      // surprise edit to a file we were only ever asked to read.
      if (row.machine.source !== 'saved') {
        onNotify(t('sshUnpin'), 'warn')
        return
      }
      setBusy(row.id)
      const result = await proApi.ssh.remove(row.machine.id)
      setBusy('')
      if (!report(result, fill(t, 'sshUnpinned', { label: row.machine.label }))) return
      await load(queryRef.current)
    },
    [busy, load, onNotify, report, t]
  )

  const setup = useCallback(
    async (row: Row): Promise<void> => {
      if (busy || row.kind === 'terminal') return
      setBusy(row.id)
      const result = await proApi.ssh.setup({
        machine: row.machine,
        target: row.kind === 'typed' ? row.target : '',
        run: true
      })
      setBusy('')
      if (!report(result, t('sshSetupStarted'))) return
      noteTyped(result.data, result.data?.lines?.length ?? 0)
      // Stay open would be wrong: the pane now owns the human's attention, and
      // it is waiting on a password prompt.
      onCancel()
    },
    [busy, noteTyped, onCancel, report, t]
  )

  const onKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const row = rows[index]
      switch (event.key) {
        case 'Escape':
          event.preventDefault()
          onCancel()
          return
        case 'ArrowDown':
          event.preventDefault()
          setIndex((value) => Math.min(value + 1, rows.length - 1))
          return
        case 'ArrowUp':
          event.preventDefault()
          setIndex((value) => Math.max(value - 1, 0))
          return
        case 'Home':
          event.preventDefault()
          setIndex(0)
          return
        case 'End':
          event.preventDefault()
          setIndex(Math.max(0, rows.length - 1))
          return
        case 'Enter':
          event.preventDefault()
          if (row) void activate(row)
          return
        default:
          break
      }
      if (!event.altKey || !row) return
      // `code`, not `key`: see the file header. preventDefault also stops the
      // composed character from landing in the filter input.
      if (event.code === 'KeyP') {
        event.preventDefault()
        void probe(row)
      } else if (event.code === 'KeyS') {
        event.preventDefault()
        void pin(row)
      } else if (event.code === 'KeyK') {
        event.preventDefault()
        void setup(row)
      } else if (event.code === 'KeyU') {
        event.preventDefault()
        void unpin(row)
      }
    },
    [activate, index, onCancel, pin, probe, rows, setup, unpin]
  )

  const cwdLabel = cwd.trim() || t('sshHome')
  const showEmpty = !loading && !error && !machines.length && !rows.some((r) => r.kind === 'typed')

  return (
    <div
      className="scrim"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        className="dialog connect-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('sshTitle')}
        onKeyDown={onKey}
      >
        <div className="dialog-head">
          <h2 className="dialog-title">{t('sshTitle')}</h2>
          <p className="dialog-hint">{t('sshHint')}</p>
        </div>

        <div className="connect-input">
          <Plug />
          <input
            autoFocus
            type="text"
            value={query}
            placeholder={t('sshPlaceholder')}
            aria-label={t('sshTitle')}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="btn ghost icon"
              title={t('confirmCancel')}
              aria-label={t('confirmCancel')}
              onClick={() => setQuery('')}
            >
              <X />
            </button>
          ) : null}
        </div>

        <div className="connect-list" role="listbox" aria-label={t('sshTitle')} ref={listRef}>
          {loading ? <p className="empty-note">{t('sshLoading')}</p> : null}
          {!loading && error ? <p className="dialog-error">{error}</p> : null}
          {showEmpty ? <p className="empty-note">{t('sshEmpty')}</p> : null}
          {rows.map((row, position) => {
            const selected = position === index
            const shared = {
              key: row.id,
              className: 'connect-row',
              role: 'option' as const,
              'aria-selected': selected,
              'data-selected': selected || undefined,
              'data-busy': busy === row.id && row.kind !== 'terminal' ? '1' : undefined,
              onMouseEnter: () => setIndex(position),
              onClick: () => void activate(row)
            }

            if (row.kind === 'terminal') {
              return (
                <div {...shared}>
                  <span className="connect-icon">
                    <TerminalSquare />
                  </span>
                  <span className="connect-main">
                    <span className="connect-name">{t('sshTerminalRow')}</span>
                    <span className="connect-detail mono" title={cwdLabel}>
                      {fill(t, 'sshTerminalHint', { cwd: cwdLabel })}
                    </span>
                  </span>
                </div>
              )
            }

            const cached = probes[row.id]
            const status: ProbeStatus = busy === row.id ? 'unknown' : (cached?.status ?? 'unknown')
            const probeText = busy === row.id ? t('sshProbeBusy') : t(PROBE_KEY[status])
            const sourceKey = row.kind === 'typed' ? 'sshSourceTyped' : SOURCE_KEY[row.machine.source]

            return (
              <div {...shared} data-source={row.machine.source}>
                <span className="connect-icon">
                  <Plug />
                </span>
                <span className="connect-main">
                  <span className="connect-name">{row.machine.label}</span>
                  <span className="connect-detail mono" title={describe(row.machine)}>
                    {describe(row.machine)}
                  </span>
                </span>
                <span className="connect-side">
                  <span
                    className="pill connect-probe"
                    data-probe={busy === row.id ? 'busy' : status}
                    title={cached?.detail || probeText}
                  >
                    <Activity />
                    {probeText}
                  </span>
                  <span className="pill quiet">{t(sourceKey)}</span>
                  <span className="connect-verbs" onClick={(event) => event.stopPropagation()}>
                    <button
                      type="button"
                      className="btn ghost icon sm"
                      title={t('sshTest')}
                      aria-label={t('sshTest')}
                      disabled={Boolean(busy)}
                      onClick={() => void probe(row)}
                    >
                      <Activity />
                    </button>
                    {row.kind === 'machine' && row.machine.source === 'saved' ? (
                      <button
                        type="button"
                        className="btn ghost icon sm"
                        title={t('sshUnpin')}
                        aria-label={t('sshUnpin')}
                        disabled={Boolean(busy)}
                        onClick={() => void unpin(row)}
                      >
                        <PinOff />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn ghost icon sm"
                        title={t('sshPin')}
                        aria-label={t('sshPin')}
                        disabled={Boolean(busy) || row.machine.source === 'saved'}
                        onClick={() => void pin(row)}
                      >
                        <Pin />
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn ghost icon sm"
                      title={t('sshSetupHint')}
                      aria-label={t('sshSetupKey')}
                      disabled={Boolean(busy)}
                      onClick={() => void setup(row)}
                    >
                      <KeyRound />
                    </button>
                  </span>
                </span>
              </div>
            )
          })}
        </div>

        <div className="dialog-foot connect-foot">
          <span className="connect-keys">{t('sshKeysHint')}</span>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onCancel}>
            <X />
            {t('confirmCancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
