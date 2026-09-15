/**
 * Frame routing that deliberately lives outside React.
 *
 * A busy pane pushes tens of ANSI frames a second. Putting those in state -
 * even in a `useRef`-free closure that calls `setState` - re-renders the tree
 * on every frame, and acceptance criterion 5 asks for flat memory and a smooth
 * UI through an hour of busy output. So frames go straight from the IPC
 * listener to the xterm instance that owns the pane, and React never sees them.
 *
 * The bus is a plain module-level map keyed by pane id. A pane registers when
 * its component mounts and unregisters when it unmounts; frames for an
 * unregistered pane are dropped, which is the correct answer - herdr keeps the
 * PTY either way, and the next attach replays a full frame.
 *
 * Bridge *phase* changes are the opposite case: rare, and the pane header
 * renders them, so they are delivered to the sink and the sink calls its own
 * local `setState`. `lastBridge` keeps the current phase per pane so a header
 * that mounts after the push does not sit on "Attaching…" forever.
 */
import type { ProBridgePush, ProFramePush, ProFramesPush } from '@shared/proIpc'

export interface PaneSink {
  frame(frame: ProFramePush): void
  bridge(push: ProBridgePush): void
}

const sinks = new Map<string, PaneSink>()
const lastBridge = new Map<string, ProBridgePush>()

/** Register the sink for a pane. Returns the unregister function. */
export function registerPane(paneId: string, sink: PaneSink): () => void {
  if (!paneId) return () => undefined
  sinks.set(paneId, sink)
  return () => {
    // Only clear our own registration: a fast remount must not unregister the
    // newer sink that replaced us.
    if (sinks.get(paneId) === sink) sinks.delete(paneId)
  }
}

/** The most recent bridge push for a pane, for a header that mounted late. */
export function bridgeOf(paneId: string): ProBridgePush | null {
  return lastBridge.get(paneId) ?? null
}

export function routeFrames(push: ProFramesPush): void {
  for (const frame of push?.frames ?? []) {
    sinks.get(frame.paneId)?.frame(frame)
  }
}

export function routeBridge(push: ProBridgePush): void {
  if (!push?.paneId) return
  lastBridge.set(push.paneId, push)
  sinks.get(push.paneId)?.bridge(push)
}

/** Forget a pane entirely; called when a task loses its binding. */
export function forgetPane(paneId: string): void {
  sinks.delete(paneId)
  lastBridge.delete(paneId)
}
