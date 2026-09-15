/**
 * The Pro half of the IPC surface: ten `cw-pro:*` channels, all of them thin.
 *
 * Thin is the point. Every channel does at most three things - validate the
 * payload with the shared parser, hand the typed request to `ProService`, and
 * return the `ProResult` envelope it produced. No policy lives here: whether a
 * keystroke is safe to send, what a snooze means, when the widget gets summoned
 * are all decisions the service already made once, and a second copy of them in
 * the transport layer is how the bench and the bubble start to disagree.
 *
 * Two consequences worth stating, because they are the reason the file looks
 * repetitive rather than clever:
 *
 * - A rejected payload becomes a `ProResult` with the parser's code, never a
 *   thrown error. The renderer's `invoke` promise always resolves, so the bench
 *   can render every failure the same way it renders an offline herdr.
 * - Nothing here reads Electron state. `ProService` reaches the windows through
 *   its injected host, which keeps this file importable from a test.
 */
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipcChannels'
import {
  failResult,
  okResult,
  parseProAction,
  type ProReject,
  type ProResult
} from '../../shared/proIpc'
import { log } from '../log'
import { proParsers, rejected, type ProService } from './service'

/** Code for "our fault, not yours": an unexpected throw inside a handler. */
const INTERNAL = 'internal'

export function registerProIpc(pro: ProService): void {
  const handle = (
    channel: string,
    fn: (payload: unknown) => ProResult | Promise<ProResult>
  ): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, payload) => {
      try {
        return Promise.resolve(fn(payload)).catch((error) => {
          log('error', `pro ipc ${channel} failed`, String(error))
          return failResult(INTERNAL, String(error))
        })
      } catch (error) {
        log('error', `pro ipc ${channel} threw`, String(error))
        return Promise.resolve(failResult(INTERNAL, String(error)))
      }
    })
  }

  /** Parse, then run. One shape for the six channels that take a typed request. */
  const guard =
    <T>(
      parse: (payload: unknown) => T | ProReject,
      op: (request: T) => ProResult | Promise<ProResult>
    ) =>
    (payload: unknown): Promise<ProResult> => {
      const request = parse(payload)
      if (rejected(request)) return Promise.resolve(failResult(request.code, request.error))
      return Promise.resolve(op(request))
    }

  /**
   * The whole projection, on open.
   *
   * `replayFocus` is deferred by a tick on purpose: a bubble click creates this
   * window and emits the focus request in the same turn, and a push that lands
   * before the invoke resolves would select a task in a tree the renderer has
   * not drawn yet.
   */
  handle(IPC.proState, () => {
    const view = pro.view()
    setImmediate(() => pro.replayFocus())
    return okResult(view)
  })

  handle(IPC.proAction, guard(parseProAction, (request) => pro.act(request)))
  handle(IPC.proTask, guard(proParsers.task, (request) => pro.taskOp(request)))
  handle(IPC.proLedger, guard(proParsers.ledger, (request) => pro.ledgerOp(request)))
  handle(IPC.proRecovery, guard(proParsers.recovery, (request) => pro.recoveryOp(request)))
  handle(IPC.proPane, guard(proParsers.pane, (request) => pro.paneOp(request)))
  handle(IPC.proHost, guard(proParsers.host, (request) => pro.hostOp(request)))

  // These three take an opaque payload: the bridge and `applyPatch` are their
  // validators, and they already return envelopes.
  handle(IPC.proCommand, (payload) => pro.command(payload))
  handle(IPC.proCompanion, (payload) => pro.companionOp(payload))
  handle(IPC.proConfig, (payload) => pro.configOp(payload))
}
