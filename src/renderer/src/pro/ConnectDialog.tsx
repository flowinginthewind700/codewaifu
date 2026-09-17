/**
 * Connect: one palette for "get me a shell somewhere", and the one place a row
 * in it can be changed or dismissed.
 *
 * The shape follows the rest of the bench's dialogs (a filter, a list, a foot)
 * but four decisions are specific to it:
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
 * 4. **A row can be edited and dismissed, and each verb says what it owns.** A
 *    row this app saved is edited in place and deleted outright. A row reported
 *    by `~/.ssh/config` or by herdr comes from somewhere we were only asked to
 *    read: editing one *forks* it into our own roster (the block on disk stays
 *    byte for byte as it was) and dismissing one *hides* it, which is reversible
 *    from the list under the foot. Neither verb ever writes to the human's ssh
 *    config, and the toast names which of the two happened - claiming "deleted"
 *    about somebody else's file would promise an edit we refuse to make.
 *
 * Verbs are Alt-accelerators rather than bare letters because the input owns
 * the keyboard: an unmodified `s` has to keep typing the hostname. They are
 * matched on `event.code`, since Option+P on mac reports the composed `π` in
 * `event.key` and would never match a letter. Every shortcut stands down while
 * an IME is composing, so filtering by a Chinese machine name does not connect
 * to the highlighted row mid-word.
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
import {
  Activity,
  ArrowLeft,
  Eraser,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  Lock,
  Pencil,
  Pin,
  Plug,
  TerminalSquare,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import type { HiddenMachine, MachineEdit, ProbeStatus, SshMachine } from '@shared/ssh'
import {
  changesConnection,
  clampPort,
  editMachine,
  isHiddenRemoval,
  machineEditOf,
  machineKey,
  parseTarget,
  sshLine
} from '@shared/ssh'
import type { ProResult, ProSessionOpened, ProSshRoster } from '@shared/proIpc'
import { proApi } from './api'
import { fill, type StringKey, type Translate } from './i18n'
import type { Tone } from './toast'
import { useImeEnter } from '../useIme'

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

/**
 * The rows a form can be opened on: everything the palette lists except the
 * local terminal, which has no machine to rename and nothing to dial.
 */
type MachineRow = Extract<Row, { kind: 'machine' | 'typed' }>

interface ProbeEntry {
  status: ProbeStatus
  detail: string
}

/**
 * The edit form's working copy of a row.
 *
 * Every field is text, including the port: an empty port has to stay empty
 * (meaning 22) rather than snapping to a number the human did not type, and
 * `''` is also how a field is *cleared* - the difference between not touching
 * ProxyJump and saying this box has none.
 */
interface EditForm {
  label: string
  host: string
  port: string
  user: string
  identityFile: string
  proxyJump: string
  alias: string
  /**
   * The password to store, and the one field here that is not part of the
   * machine patch: it goes to the keychain under the row's id after the edit
   * lands, and it is always opened empty because main never hands a stored
   * secret back to a renderer. Empty means "leave the keychain alone".
   */
  password: string
}

interface EditDraft {
  row: MachineRow
  form: EditForm
  /** Inline validation, shown in the foot where the other dialogs show it. */
  error: string
  /** Whether the password field shows what was typed. Per-draft, so it never survives into the next row. */
  reveal: boolean
  /** "Remove the stored password when this form is saved", and undoable until then. */
  clearPassword: boolean
}

const PROBE_KEY: Record<ProbeStatus, StringKey> = {
  unknown: 'sshProbeUnknown',
  ok: 'sshProbeOk',
  password: 'sshProbePassword',
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
  /** Dismissed rows, carried by the roster so the foot's count is never stale. */
  const [hidden, setHidden] = useState<readonly HiddenMachine[]>([])
  const [configPath, setConfigPath] = useState('')
  const [home, setHome] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [index, setIndex] = useState(0)
  const [probes, setProbes] = useState<Record<string, ProbeEntry>>({})
  /** The row with a call in flight, so a double press cannot start two. */
  const [busy, setBusy] = useState('')
  /** The palette, or the restore list underneath it. */
  const [view, setView] = useState<'connect' | 'hidden'>('connect')
  const [hiddenQuery, setHiddenQuery] = useState('')
  const [hiddenIndex, setHiddenIndex] = useState(0)
  const [draft, setDraft] = useState<EditDraft | null>(null)
  /** Private halves of the keys in `~/.ssh`, for the identity-file datalist. */
  const [identities, setIdentities] = useState<readonly string[]>([])
  /**
   * Whether this machine has a keychain at all. False disables the password
   * field and says why, which beats offering a field that refuses on save.
   */
  const [keychain, setKeychain] = useState(false)

  // Guards an out-of-order answer: a slow `list` for an old query must not
  // overwrite the roster that matches what is on screen right now.
  const queryRef = useRef(query)
  // One ref for both lists: only one of them is mounted at a time.
  const listRef = useRef<HTMLDivElement | null>(null)
  const ime = useImeEnter()

  const load = useCallback(async (wanted: string): Promise<void> => {
    const result = await proApi.ssh.list(wanted)
    if (queryRef.current !== wanted) return
    setLoading(false)
    if (!result.ok || !result.data) {
      // Shown, never rendered as an empty list: "no machines" and "the roster
      // did not answer" call for different fixes.
      setError(result.detail || result.code || 'failed')
      return
    }
    setError('')
    const roster: ProSshRoster = result.data
    setMachines(roster.machines)
    setHidden(roster.hidden ?? [])
    setConfigPath(roster.configPath ?? '')
    setHome(roster.home ?? '')
    setKeychain(roster.keychain === true)
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

  /** The restore list, filtered in the renderer: it is at most a dozen rows. */
  const hiddenRows = useMemo<HiddenMachine[]>(() => {
    const wanted = hiddenQuery.trim().toLowerCase()
    if (!wanted) return hidden.slice()
    return hidden.filter((entry) => {
      const machine = entry.machine
      return (
        machine.label.toLowerCase().includes(wanted) ||
        machine.host.toLowerCase().includes(wanted) ||
        entry.key.includes(wanted)
      )
    })
  }, [hidden, hiddenQuery])

  // A new query starts from the top: the row under the cursor before you typed
  // has nothing to do with the row under it now.
  useEffect(() => {
    setIndex(0)
  }, [query])

  useEffect(() => {
    setHiddenIndex(0)
  }, [hiddenQuery])

  // A dismiss shrinks the list under the cursor; stay on a row that exists.
  useEffect(() => {
    setIndex((value) => Math.min(value, Math.max(0, rows.length - 1)))
  }, [rows.length])

  useEffect(() => {
    setHiddenIndex((value) => Math.min(value, Math.max(0, hiddenRows.length - 1)))
  }, [hiddenRows.length])

  // Keep the selection visible; the list scrolls, the dialog does not.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('.connect-row[data-selected]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [index, hiddenIndex, view, draft, rows.length, hiddenRows.length])

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
      const result = await proApi.ssh.probe(row.machine, row.kind === 'typed' ? row.target : '')
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
      // `saved` pill and its durable id are the ones main now holds. Pinning
      // also unhides the same identity, which the re-read picks up.
      await load(queryRef.current)
    },
    [busy, load, report, t]
  )

  /**
   * Dismiss a row: delete what is ours, hide what is not.
   *
   * `hidden` in the answer is the difference, and the two toasts are worded
   * apart on purpose. A config alias is not deleted by this - the block stays
   * in `~/.ssh/config` - so saying "deleted" would send the human looking for
   * a change on disk that we deliberately did not make.
   */
  const dismiss = useCallback(
    async (row: Row): Promise<void> => {
      if (busy || row.kind !== 'machine') return
      setBusy(row.id)
      const result = await proApi.ssh.hide(row.machine)
      setBusy('')
      if (!report(result)) return
      const label = result.data?.machine.label || row.machine.label
      onNotify(fill(t, result.data?.hidden ? 'sshHiddenRow' : 'sshRemoved', { label }), 'ok')
      await load(queryRef.current)
    },
    [busy, load, onNotify, report, t]
  )

  /** Bring a dismissed row back. For a stale one this simply drops the key. */
  const restore = useCallback(
    async (entry: HiddenMachine): Promise<void> => {
      if (busy) return
      setBusy(entry.key)
      const result = await proApi.ssh.unhide(entry.key)
      setBusy('')
      if (!report(result, fill(t, 'sshRestored', { label: entry.machine.label }))) return
      await load(queryRef.current)
    },
    [busy, load, report, t]
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

  /**
   * Open the form on a row's current values, pre-filled rather than empty.
   *
   * A typed target is welcome too - it is how "I just typed root@10.0.0.7 and
   * want it to survive" becomes one keystroke - and the title says "save as my
   * machine" instead of "edit" in that case, because there is nothing stored to
   * edit yet. The key list is fetched here rather than with the roster: it is a
   * directory read that only the form needs.
   */
  const openEdit = useCallback(
    (row: Row): void => {
      if (row.kind === 'terminal') return
      const values = machineEditOf(row.machine)
      setDraft({
        row,
        form: {
          label: values.label,
          host: values.host,
          port: values.port ? String(values.port) : '',
          user: values.user,
          identityFile: values.identityFile,
          proxyJump: values.proxyJump,
          alias: values.alias,
          password: ''
        },
        error: '',
        reveal: false,
        clearPassword: false
      })
      if (identities.length) return
      void proApi.ssh.keys().then((result) => {
        if (!result.ok || !result.data) return
        // `keys()` reports the public halves; `-i` wants the private one, so
        // the `.pub` comes off rather than offering a path ssh would reject.
        setIdentities(result.data.keys.map((path) => path.replace(/\.pub$/, '')))
      })
    },
    [identities.length]
  )

  const closeEdit = useCallback((): void => {
    setDraft(null)
  }, [])

  /**
   * What the form currently means: the patch to send, the machine it produces,
   * and the one validation the fields cannot express.
   *
   * The preview is built with the same `editMachine` and `sshLine` that main
   * will run, so the line under the fields cannot drift from what gets stored.
   * A form that shows one command and dials another is worse than no preview.
   */
  const edit = useMemo(() => {
    if (!draft) return null
    const machine = draft.row.machine
    const base: MachineEdit = {
      label: draft.form.label,
      host: draft.form.host,
      user: draft.form.user,
      identityFile: draft.form.identityFile,
      proxyJump: draft.form.proxyJump,
      port: draft.form.port
    }
    // Retyping anything ssh dials detaches a config alias: `sshArgv` short
    // circuits on `alias` (`ssh <alias>` and nothing else), so keeping it would
    // silently throw the new port or key away. The field is cleared and locked
    // and the note says why, rather than accepting input that will not be used.
    // Reverting the connection fields brings the alias back, because the form
    // never destroyed it - it only stopped offering it.
    const detached = Boolean(machine.alias) && changesConnection(machine, base)
    const patch: MachineEdit = { ...base, alias: detached ? '' : draft.form.alias }
    const port = draft.form.port.trim()
    return {
      patch,
      detached,
      machine: editMachine(machine, patch),
      portBad: port !== '' && clampPort(port) === 0
    }
  }, [draft])

  const saveEdit = useCallback(async (): Promise<void> => {
    if (!draft || !edit || busy) return
    if (edit.portBad) {
      setDraft({ ...draft, error: t('sshEditBadPort') })
      return
    }
    // An alias alone is dialable (`ssh prod`), so it is the host that is
    // optional, not the pair: this is the same test main applies before
    // storing, run here so the answer arrives without a round trip.
    if (!edit.machine.host && !edit.machine.alias) {
      setDraft({ ...draft, error: t('sshEditNeedsHost') })
      return
    }
    setBusy(draft.row.id)
    const result = await proApi.ssh.edit(
      draft.row.machine,
      edit.patch,
      draft.row.kind === 'typed' ? draft.row.target : ''
    )
    if (!report(result)) {
      setBusy('')
      return
    }
    const stored = result.data?.machine
    const label = stored?.label || edit.machine.label
    // Second half of the save, and the reason the password is not a field of
    // `patch`: the secret is stored against the id the *edit* produced. Editing
    // a config alias forks it into our roster under a fresh id, and main moves
    // an existing secret across with it, so that id is the one that owns the
    // password from here on.
    const id = stored?.id ?? ''
    const clearing = draft.clearPassword
    const wantsPassword = clearing || draft.form.password !== ''
    let passwordText = ''
    let passwordTone: Tone = 'ok'
    if (id && wantsPassword) {
      const saved = await proApi.ssh.setPassword(id, clearing ? null : draft.form.password)
      passwordTone = saved.ok ? 'ok' : 'error'
      passwordText = t(
        saved.ok ? (clearing ? 'sshPasswordCleared' : 'sshPasswordStored') : 'sshPasswordFailed'
      )
    }
    setBusy('')
    // `forked` is the outcome that has to be spelled out: the config row is now
    // hidden and the copy we dial is ours.
    onNotify(fill(t, result.code === 'forked' ? 'sshForked' : 'sshEdited', { label }), 'ok')
    if (passwordText) onNotify(passwordText, passwordTone)
    setDraft(null)
    await load(queryRef.current)
  }, [busy, draft, edit, load, onNotify, report, t])

  /** The palette refuses to rewrite `~/.ssh/config`; it can still open it. */
  const openConfig = useCallback(async (): Promise<void> => {
    if (!configPath) return
    const result = await proApi.host.openPath(configPath)
    report(result)
  }, [configPath, report])

  const openHidden = useCallback((): void => {
    setHiddenQuery('')
    setHiddenIndex(0)
    setView('hidden')
  }, [])

  const backToConnect = useCallback((): void => {
    setView('connect')
  }, [])

  /** Enter saves, Esc closes, and a focused button keeps its own Enter. */
  const onEditKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeEdit()
        return
      }
      if (!ime.submits(event)) return
      // Enter on a button is that button's click; saving as well would do two
      // things for one keystroke, and Cancel is right there.
      if ((event.target as HTMLElement).closest('button')) return
      event.preventDefault()
      void saveEdit()
    },
    [closeEdit, ime, saveEdit]
  )

  const onHiddenKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const entry = hiddenRows[hiddenIndex]
      switch (event.key) {
        case 'Escape':
          event.preventDefault()
          backToConnect()
          return
        case 'ArrowDown':
          event.preventDefault()
          setHiddenIndex((value) => Math.min(value + 1, hiddenRows.length - 1))
          return
        case 'ArrowUp':
          event.preventDefault()
          setHiddenIndex((value) => Math.max(value - 1, 0))
          return
        case 'Home':
          event.preventDefault()
          setHiddenIndex(0)
          return
        case 'End':
          event.preventDefault()
          setHiddenIndex(Math.max(0, hiddenRows.length - 1))
          return
        default:
          break
      }
      if (!ime.submits(event) || !entry) return
      event.preventDefault()
      void restore(entry)
    },
    [backToConnect, hiddenIndex, hiddenRows, ime, restore]
  )

  const onConnectKey = useCallback(
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
        default:
          break
      }
      if (ime.submits(event)) {
        event.preventDefault()
        if (row) void activate(row)
        return
      }
      if (!event.altKey || !row) return
      // `code`, not `key`: see the file header. preventDefault also stops the
      // composed character from landing in the filter input.
      if (event.code === 'KeyP') {
        event.preventDefault()
        void probe(row)
      } else if (event.code === 'KeyE') {
        event.preventDefault()
        openEdit(row)
      } else if (event.code === 'KeyD' || event.code === 'KeyU') {
        // `+U` was the unpin accelerator before delete and hide became one verb;
        // it stays bound so the shortcut a hand already knows keeps working.
        event.preventDefault()
        void dismiss(row)
      } else if (event.code === 'KeyS') {
        event.preventDefault()
        void pin(row)
      } else if (event.code === 'KeyK') {
        event.preventDefault()
        void setup(row)
      }
    },
    [activate, dismiss, ime, index, onCancel, openEdit, pin, probe, rows, setup]
  )

  const onKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      // An IME owns this key. Standing down is what keeps a Chinese machine
      // name from connecting to the highlighted row halfway through a word.
      if (ime.swallows(event)) return
      if (draft) {
        onEditKey(event)
        return
      }
      if (view === 'hidden') {
        onHiddenKey(event)
        return
      }
      onConnectKey(event)
    },
    [draft, ime, onConnectKey, onEditKey, onHiddenKey, view]
  )

  const cwdLabel = cwd.trim() || t('sshHome')
  const showEmpty = !loading && !error && !machines.length && !rows.some((r) => r.kind === 'typed')
  const editing = draft && edit ? { draft, edit } : null

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
        data-view={editing ? 'edit' : view}
        onKeyDown={onKey}
      >
        {editing ? (
          <EditView
            t={t}
            draft={editing.draft}
            edit={editing.edit}
            home={home}
            identities={identities}
            busy={busy === editing.draft.row.id}
            composition={ime.composition}
            onField={(field, value) =>
              setDraft((current) =>
                current ? { ...current, error: '', form: { ...current.form, [field]: value } } : current
              )
            }
            keychain={keychain}
            onToggleReveal={() =>
              setDraft((current) => (current ? { ...current, reveal: !current.reveal } : current))
            }
            onToggleClear={() =>
              setDraft((current) =>
                current ? { ...current, error: '', clearPassword: !current.clearPassword } : current
              )
            }
            onCancel={closeEdit}
            onSave={() => void saveEdit()}
          />
        ) : view === 'hidden' ? (
          <>
            <div className="dialog-head">
              <h2 className="dialog-title">{t('sshHiddenTitle')}</h2>
              <p className="dialog-hint">{t('sshHiddenHint')}</p>
            </div>

            <div className="connect-input">
              <EyeOff />
              <input
                autoFocus
                type="text"
                value={hiddenQuery}
                placeholder={t('sshHiddenPlaceholder')}
                aria-label={t('sshHiddenTitle')}
                spellCheck={false}
                autoComplete="off"
                {...ime.composition}
                onChange={(event) => setHiddenQuery(event.target.value)}
              />
              {hiddenQuery ? (
                <button
                  type="button"
                  className="btn ghost icon"
                  title={t('confirmCancel')}
                  aria-label={t('confirmCancel')}
                  onClick={() => setHiddenQuery('')}
                >
                  <X />
                </button>
              ) : null}
            </div>

            <div className="connect-list" role="listbox" aria-label={t('sshHiddenTitle')} ref={listRef}>
              {hiddenRows.length ? null : <p className="empty-note">{t('sshHiddenEmpty')}</p>}
              {hiddenRows.map((entry, position) => {
                const selected = position === hiddenIndex
                return (
                  <div
                    key={entry.key}
                    className="connect-row"
                    role="option"
                    aria-selected={selected}
                    data-selected={selected || undefined}
                    data-stale={entry.stale || undefined}
                    data-busy={busy === entry.key ? '1' : undefined}
                    onMouseEnter={() => setHiddenIndex(position)}
                    onClick={() => void restore(entry)}
                  >
                    <span className="connect-icon">
                      <EyeOff />
                    </span>
                    <span className="connect-main">
                      <span className="connect-name">{entry.machine.label}</span>
                      <span
                        className="connect-detail mono"
                        title={entry.stale ? entry.key : describe(entry.machine)}
                      >
                        {entry.stale ? entry.key : describe(entry.machine)}
                      </span>
                    </span>
                    <span className="connect-side">
                      {/* A stale key outlived the thing it named: restoring it
                          drops the entry rather than bringing a row back, and
                          the pill is what stops that reading as a broken click. */}
                      {entry.stale ? <span className="pill quiet">{t('sshHiddenStale')}</span> : null}
                      <span className="pill quiet">{t(SOURCE_KEY[entry.machine.source])}</span>
                      <span className="connect-verbs" onClick={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          className="btn ghost icon sm"
                          title={t('sshRestoreHint')}
                          aria-label={t('sshRestore')}
                          disabled={Boolean(busy)}
                          onClick={() => void restore(entry)}
                        >
                          <Undo2 />
                        </button>
                      </span>
                    </span>
                  </div>
                )
              })}
            </div>

            <div className="dialog-foot connect-foot">
              <span className="connect-keys">{t('sshHiddenKeysHint')}</span>
              <span className="spacer" />
              {configPath ? (
                <button
                  type="button"
                  className="btn ghost"
                  title={configPath}
                  onClick={() => void openConfig()}
                >
                  <FileText />
                  {t('sshOpenConfig')}
                </button>
              ) : null}
              <button type="button" className="btn ghost" onClick={backToConnect}>
                <ArrowLeft />
                {t('sshBack')}
              </button>
            </div>
          </>
        ) : (
          <>
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
                {...ime.composition}
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
                const saved = row.kind === 'machine' && row.machine.source === 'saved'
                const detail = describe(row.machine)

                return (
                  <div {...shared} data-source={row.machine.source}>
                    <span className="connect-icon">
                      <Plug />
                    </span>
                    <span className="connect-main">
                      <span className="connect-name">{row.machine.label}</span>
                      <span className="connect-detail mono" title={detail}>
                        {detail}
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
                      {/* A stored password is worth an icon on the row: it is
                          the difference between "connect" and "connect, and it
                          will answer for you". Named by its title, since an
                          icon alone is a guess. */}
                      {row.machine.hasPassword ? (
                        <span
                          className="pill quiet connect-lock"
                          role="img"
                          aria-label={t('sshHasPassword')}
                          title={t('sshHasPassword')}
                        >
                          <Lock />
                        </span>
                      ) : null}
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
                        <button
                          type="button"
                          className="btn ghost icon sm"
                          title={row.kind === 'typed' ? t('sshEditNewTitle') : t('sshEditHint')}
                          aria-label={t('sshEdit')}
                          disabled={Boolean(busy)}
                          onClick={() => openEdit(row)}
                        >
                          <Pencil />
                        </button>
                        {saved ? null : (
                          <button
                            type="button"
                            className="btn ghost icon sm"
                            title={t('sshPin')}
                            aria-label={t('sshPin')}
                            disabled={Boolean(busy)}
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
                        {/* A typed row has nothing stored to dismiss: hiding a
                            string the human just typed would be a verdict on
                            their typing, not on a machine. */}
                        {row.kind === 'machine' ? (
                          <button
                            type="button"
                            className={`btn ghost icon sm${saved ? ' danger' : ''}`}
                            title={saved ? t('sshDismissHint') : t('sshHideHint')}
                            aria-label={saved ? t('sshDismiss') : t('sshHide')}
                            disabled={Boolean(busy)}
                            onClick={() => void dismiss(row)}
                          >
                            {saved ? <Trash2 /> : <EyeOff />}
                          </button>
                        ) : null}
                      </span>
                    </span>
                  </div>
                )
              })}
            </div>

            <div className="dialog-foot connect-foot">
              <span className="connect-keys">{t('sshKeysHint')}</span>
              <span className="spacer" />
              {hidden.length ? (
                <button type="button" className="btn ghost" onClick={openHidden}>
                  <EyeOff />
                  {fill(t, 'sshHidden', { n: hidden.length })}
                </button>
              ) : null}
              <button type="button" className="btn ghost" onClick={onCancel}>
                <X />
                {t('confirmCancel')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** The values `EditView` may change; `port` stays text so '' can mean 22. */
type EditField = keyof EditForm

interface EditViewProps {
  t: Translate
  draft: EditDraft
  edit: { patch: MachineEdit; detached: boolean; machine: SshMachine; portBad: boolean }
  home: string
  identities: readonly string[]
  busy: boolean
  composition: { onCompositionStart: () => void; onCompositionEnd: () => void }
  onField: (field: EditField, value: string) => void
  /** Whether this machine can keep a secret at all; false disables the field. */
  keychain: boolean
  onToggleReveal: () => void
  onToggleClear: () => void
  onCancel: () => void
  onSave: () => void
}

/**
 * The edit form.
 *
 * Two things carry the design. The command line under the head is the real one
 * - built by the same `sshLine` that main types into the pane - so what you see
 * is what will be dialled, including the fields you just cleared. And the alias
 * field locks itself the moment a connection field changes, because a config
 * alias is the one value that would quietly override everything else in the
 * form; a field that accepts your port and then ignores it is a form that lies.
 */
function EditView({
  t,
  draft,
  edit,
  home,
  identities,
  busy,
  composition,
  onField,
  keychain,
  onToggleReveal,
  onToggleClear,
  onCancel,
  onSave
}: EditViewProps): ReactElement {
  const { form, row } = draft
  const machine = row.machine
  const isNew = row.kind === 'typed'
  const line = sshLine(edit.machine, { home })
  // Only a row we do not own forks, and only a config block deserves the
  // "your file is untouched" sentence: herdr reported the box, it has no file.
  const forks = !isNew && isHiddenRemoval(machine)
  const note = edit.detached
    ? fill(t, 'sshEditAliasHint', { alias: machine.alias })
    : forks && machine.source === 'config'
      ? t('sshEditConfigHint')
      : ''
  const hasPassword = machine.hasPassword === true
  // One line under the field, and it always says which of the three states the
  // form is in: nothing stored, something stored and being kept, or something
  // stored and about to go. Guessing that from an empty input is not possible,
  // because empty is exactly how "keep it" is spelled.
  const passwordHint = !keychain
    ? t('sshNoKeychain')
    : draft.clearPassword
      ? t('sshPasswordWillClear')
      : hasPassword
        ? form.password
          ? t('sshPasswordReplace')
          : t('sshPasswordKept')
        : t('sshPasswordHint')
  const passwordTone = !keychain ? 'bad' : draft.clearPassword ? 'warn' : undefined

  return (
    <>
      <div className="dialog-head">
        <h2 className="dialog-title">{isNew ? t('sshEditNewTitle') : t('sshEditTitle')}</h2>
        <p className="dialog-hint">{t('sshEditHint')}</p>
      </div>

      <div className="connect-note">
        <span className="note-pills">
          <span className="pill quiet">
            {isNew ? t('sshSourceTyped') : t(SOURCE_KEY[machine.source])}
          </span>
          {machine.alias ? <span className="pill connect-alias mono">{machine.alias}</span> : null}
          {edit.detached ? <span className="pill connect-detached">{t('sshFieldAlias')}</span> : null}
          {hasPassword ? (
            <span className="pill connect-lock" title={t('sshHasPassword')}>
              <Lock />
              {t('sshHasPassword')}
            </span>
          ) : null}
        </span>
        <span className="connect-preview mono" title={line}>
          {line}
        </span>
        {note ? (
          <p className="note-line" data-tone={edit.detached ? 'warn' : undefined}>
            {note}
          </p>
        ) : null}
      </div>

      <div className="dialog-grid">
        <Field className="wide" label={t('sshFieldLabel')}>
          <input
            className="input"
            autoFocus
            value={form.label}
            spellCheck={false}
            {...composition}
            onChange={(event) => onField('label', event.target.value)}
          />
        </Field>

        <Field label={t('sshFieldHost')}>
          <input
            className="input mono"
            value={form.host}
            spellCheck={false}
            placeholder="10.0.0.4"
            {...composition}
            onChange={(event) => onField('host', event.target.value)}
          />
        </Field>

        <Field label={t('sshFieldPort')}>
          <input
            className="input mono"
            value={form.port}
            inputMode="numeric"
            spellCheck={false}
            placeholder={t('sshPortDefault')}
            data-invalid={edit.portBad || undefined}
            {...composition}
            onChange={(event) => onField('port', event.target.value)}
          />
        </Field>

        <Field label={t('sshFieldUser')}>
          <input
            className="input mono"
            value={form.user}
            spellCheck={false}
            placeholder="root"
            {...composition}
            onChange={(event) => onField('user', event.target.value)}
          />
        </Field>

        <Field label={t('sshFieldKey')}>
          <input
            className="input mono"
            value={form.identityFile}
            spellCheck={false}
            list="connect-identities"
            placeholder={t('sshKeyNone')}
            {...composition}
            onChange={(event) => onField('identityFile', event.target.value)}
          />
        </Field>

        <Field label={t('sshFieldJump')}>
          <input
            className="input mono"
            value={form.proxyJump}
            spellCheck={false}
            placeholder="bastion"
            {...composition}
            onChange={(event) => onField('proxyJump', event.target.value)}
          />
        </Field>

        <Field label={t('sshFieldAlias')}>
          <input
            className="input mono"
            value={edit.detached ? '' : form.alias}
            spellCheck={false}
            disabled={edit.detached}
            title={edit.detached ? fill(t, 'sshEditAliasHint', { alias: machine.alias }) : undefined}
            {...composition}
            onChange={(event) => onField('alias', event.target.value)}
          />
        </Field>

        <Field className="wide" label={t('sshFieldPassword')}>
          {/* A div, not a span: `.field > span` is the label's own styling, and
              the cell holding the input must not inherit it. */}
          <div className="password-cell">
            <div className="password-row">
              <input
                className="input mono"
                type={draft.reveal ? 'text' : 'password'}
                value={draft.clearPassword ? '' : form.password}
                spellCheck={false}
                autoComplete="off"
                disabled={!keychain || draft.clearPassword}
                placeholder={hasPassword ? t('sshPasswordPlaceholder') : t('sshPasswordPlaceholderNew')}
                aria-describedby="connect-password-hint"
                {...composition}
                onChange={(event) => onField('password', event.target.value)}
              />
              <button
                type="button"
                className="btn ghost icon sm"
                title={draft.reveal ? t('sshPasswordHide') : t('sshPasswordReveal')}
                aria-label={draft.reveal ? t('sshPasswordHide') : t('sshPasswordReveal')}
                aria-pressed={draft.reveal}
                disabled={!keychain}
                onClick={onToggleReveal}
              >
                {draft.reveal ? <EyeOff /> : <Eye />}
              </button>
              {hasPassword ? (
                <button
                  type="button"
                  className="btn ghost icon sm"
                  title={draft.clearPassword ? t('sshPasswordKeep') : t('sshPasswordClear')}
                  aria-label={draft.clearPassword ? t('sshPasswordKeep') : t('sshPasswordClear')}
                  aria-pressed={draft.clearPassword}
                  data-danger={draft.clearPassword || undefined}
                  // Typing a new password already replaces the stored one, so
                  // "remove it" is not a second thing to decide at that point.
                  disabled={!keychain || Boolean(form.password)}
                  onClick={onToggleClear}
                >
                  {draft.clearPassword ? <Undo2 /> : <Eraser />}
                </button>
              ) : null}
            </div>
            <p className="note-line" id="connect-password-hint" data-tone={passwordTone}>
              {passwordHint}
            </p>
          </div>
        </Field>
      </div>

      <datalist id="connect-identities">
        {identities.map((path) => (
          <option key={path} value={path} />
        ))}
      </datalist>

      <div className="dialog-foot">
        {draft.error ? <span className="dialog-error">{draft.error}</span> : null}
        <span className="spacer" />
        <button type="button" className="btn ghost" onClick={onCancel}>
          <X />
          {t('confirmCancel')}
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={onSave}>
          {t('sshEditSave')}
        </button>
      </div>
    </>
  )
}

/** A labelled control. The wrapping `<label>` keeps the click target on the text. */
function Field({
  label,
  className,
  children
}: {
  label: string
  className?: string
  children: ReactElement
}): ReactElement {
  return (
    <label className={`field ${className ?? ''}`.trim()}>
      <span>{label}</span>
      {children}
    </label>
  )
}
