/**
 * Typed herdr methods over the raw socket request.
 *
 * Two rules keep this file boring on purpose:
 *
 * 1. Every wrapper returns *parsed* shared types (`Snapshot`, `PaneInfo`,
 *    `CreatedResult`), never the raw envelope. The rest of Pro must not know
 *    that herdr spells things in snake_case.
 * 2. Every wrapper is one `request()`. There is no caching and no state here —
 *    that is `session.ts`'s job. A client that hides a cache is a client whose
 *    staleness nobody can reason about.
 *
 * Parameter names and required fields mirror herdr's own API schema
 * (`herdr api schema --json`); a mismatch there is a hard `invalid_request`,
 * not a silently ignored field.
 */
import {
  parseAgentInstance,
  parseCreated,
  parsePane,
  parsePaneRead,
  parsePong,
  parseSnapshot,
  parseWorkspace,
  resultType,
  type AgentInstance,
  type AgentStatus,
  type CreatedResult,
  type PaneInfo,
  type PaneReadResult,
  type PongResult,
  type Snapshot,
  type WorkspaceInfo
} from '../../../shared/herdr'
import { request, type ConnectFn, type SocketOptions } from './socket'

export interface ClientOptions {
  socketPath: string
  timeoutMs?: number
  connect?: ConnectFn
}

export type ReadSource = 'visible' | 'recent' | 'recent_unwrapped' | 'detection'
export type ReadFormat = 'text' | 'ansi'
export type SplitDirection = 'right' | 'down'

export class HerdrClient {
  private readonly socketPath: string
  private readonly options: SocketOptions

  constructor(options: ClientOptions) {
    this.socketPath = options.socketPath
    this.options = { timeoutMs: options.timeoutMs, connect: options.connect }
  }

  get endpoint(): string {
    return this.socketPath
  }

  /** Escape hatch for a method this file does not wrap yet. */
  async call(method: string, params: unknown = {}): Promise<Record<string, unknown>> {
    return request(this.socketPath, method, params, this.options)
  }

  async ping(): Promise<PongResult | null> {
    return parsePong(await this.call('ping'))
  }

  async snapshot(): Promise<Snapshot | null> {
    return parseSnapshot(await this.call('session.snapshot'))
  }

  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const result = await this.call('workspace.list')
    const raw = Array.isArray(result.workspaces) ? result.workspaces : []
    return raw.map((entry) => parseWorkspace(entry)).filter(nonNull)
  }

  async listAgents(): Promise<AgentInstance[]> {
    const result = await this.call('agent.list')
    const raw = Array.isArray(result.agents) ? result.agents : []
    return raw.map((entry) => parseAgentInstance(entry)).filter(nonNull)
  }

  async createWorkspace(input: {
    cwd?: string | null
    label?: string | null
    focus?: boolean
    env?: Record<string, string>
  }): Promise<CreatedResult> {
    return parseCreated(
      await this.call('workspace.create', {
        cwd: input.cwd ?? null,
        label: input.label ?? null,
        focus: input.focus ?? false,
        env: input.env ?? {}
      })
    )
  }

  /**
   * A linked worktree plus the workspace that shows it. This is the "give this
   * task its own branch and directory" verb, and the reason a task can be
   * rebuilt after its directory disappeared.
   */
  async createWorktree(input: {
    cwd?: string | null
    branch?: string | null
    base?: string | null
    path?: string | null
    label?: string | null
    focus?: boolean
    trustRepository?: boolean
    workspaceId?: string | null
  }): Promise<CreatedResult> {
    return parseCreated(
      await this.call('worktree.create', {
        cwd: input.cwd ?? null,
        branch: input.branch ?? null,
        base: input.base ?? null,
        path: input.path ?? null,
        label: input.label ?? null,
        focus: input.focus ?? false,
        trust_repository: input.trustRepository ?? false,
        workspace_id: input.workspaceId ?? null
      })
    )
  }

  async createTab(input: {
    workspaceId?: string | null
    cwd?: string | null
    label?: string | null
    focus?: boolean
  }): Promise<CreatedResult> {
    return parseCreated(
      await this.call('tab.create', {
        workspace_id: input.workspaceId ?? null,
        cwd: input.cwd ?? null,
        label: input.label ?? null,
        focus: input.focus ?? false
      })
    )
  }

  async splitPane(input: {
    direction: SplitDirection
    targetPaneId?: string | null
    workspaceId?: string | null
    cwd?: string | null
    ratio?: number | null
    focus?: boolean
    env?: Record<string, string>
  }): Promise<PaneInfo | null> {
    const result = await this.call('pane.split', {
      direction: input.direction === 'down' ? 'down' : 'right',
      target_pane_id: input.targetPaneId ?? null,
      workspace_id: input.workspaceId ?? null,
      cwd: input.cwd ?? null,
      ratio: input.ratio ?? null,
      focus: input.focus ?? false,
      env: input.env ?? {}
    })
    return parsePane(result.pane) ?? parseCreated(result).pane
  }

  async closePane(paneId: string): Promise<boolean> {
    return resultType(await this.call('pane.close', { pane_id: paneId })) === 'ok'
  }

  async closeWorkspace(workspaceId: string, closeGroup = false): Promise<boolean> {
    return (
      resultType(await this.call('workspace.close', { workspace_id: workspaceId, close_group: closeGroup })) === 'ok'
    )
  }

  async focusPane(paneId: string): Promise<boolean> {
    return resultType(await this.call('pane.focus', { pane_id: paneId })) === 'ok'
  }

  async focusWorkspace(workspaceId: string): Promise<boolean> {
    return resultType(await this.call('workspace.focus', { workspace_id: workspaceId })) === 'ok'
  }

  async renameWorkspace(workspaceId: string, label: string): Promise<boolean> {
    return resultType(await this.call('workspace.rename', { workspace_id: workspaceId, label })) === 'ok'
  }

  async renamePane(paneId: string, label: string | null): Promise<boolean> {
    return resultType(await this.call('pane.rename', { pane_id: paneId, label })) === 'ok'
  }

  async zoomPane(paneId: string, mode: 'toggle' | 'on' | 'off' = 'toggle'): Promise<boolean> {
    return resultType(await this.call('pane.zoom', { pane_id: paneId, mode })) === 'pane_zoom'
  }

  /**
   * Absolute scroll: `offset_from_bottom` 0 is the live edge. This exists
   * because the bridge's `terminal.scroll` is relative and its `lines` is a
   * `u16`, so "jump to the bottom" cannot be expressed as a large downward
   * scroll - a pane with more than 65535 lines of history would stop short.
   * The returned pane carries herdr's post-scroll offset, which is what the
   * caller shows next.
   */
  async scrollPane(paneId: string, offsetFromBottom: number): Promise<PaneInfo | null> {
    const result = await this.call('pane.scroll', {
      pane_id: paneId,
      offset_from_bottom: Math.max(0, Math.trunc(offsetFromBottom))
    })
    return parsePane(result.pane)
  }

  /**
   * Read a pane without focusing it. `detection` is the source herdr's own
   * agent detection uses, so it shows a permission prompt the way the agent
   * framed it; `visible` is what the user would see right now.
   */
  async readPane(
    paneId: string,
    options: { source?: ReadSource; lines?: number; format?: ReadFormat; stripAnsi?: boolean } = {}
  ): Promise<PaneReadResult | null> {
    return parsePaneRead(
      await this.call('pane.read', {
        pane_id: paneId,
        source: options.source ?? 'detection',
        lines: options.lines ?? null,
        format: options.format ?? 'text',
        strip_ansi: options.stripAnsi ?? true
      })
    )
  }

  async sendText(paneId: string, text: string): Promise<boolean> {
    return resultType(await this.call('pane.send_text', { pane_id: paneId, text })) === 'ok'
  }

  /**
   * Named keys ("enter", "y", "escape"). This is how approve/deny reach an
   * agent whose prompt is a keystroke rather than a line of text.
   */
  async sendKeys(paneId: string, keys: readonly string[]): Promise<boolean> {
    return resultType(await this.call('pane.send_keys', { pane_id: paneId, keys: [...keys] })) === 'ok'
  }

  /**
   * Launch an agent into an existing pane. `kind` is herdr's agent id
   * (codex|claude|copilot|...), `args` are passed through to it. Resume is not a
   * separate method: `args` carries `resume <id>` / `--resume <id>`.
   */
  async startAgent(input: {
    name: string
    kind: string
    paneId: string
    args?: readonly string[]
    timeoutMs?: number
  }): Promise<AgentInstance | null> {
    const result = await this.call('agent.start', {
      name: input.name,
      kind: input.kind,
      pane_id: input.paneId,
      args: [...(input.args ?? [])],
      timeout_ms: input.timeoutMs ?? null
    })
    return parseAgentInstance(result.agent)
  }

  /**
   * Free-text answer to a prompt. `wait` optionally blocks until the agent
   * leaves a status, which is how "Answer" can report success instead of
   * hoping the keystrokes landed.
   */
  async promptAgent(input: {
    target: string
    text: string
    wait?: { until?: readonly AgentStatus[]; timeoutMs?: number } | null
  }): Promise<AgentInstance | null> {
    const result = await this.call('agent.prompt', {
      target: input.target,
      text: input.text,
      wait: input.wait
        ? { until: [...(input.wait.until ?? [])], timeout_ms: input.wait.timeoutMs ?? null }
        : null
    })
    return parseAgentInstance(result.agent)
  }

  async agentSendKeys(target: string, keys: readonly string[]): Promise<AgentInstance | null> {
    const result = await this.call('agent.send_keys', { target, keys: [...keys] })
    return parseAgentInstance(result.agent)
  }

  async waitAgent(input: {
    target: string
    until?: readonly AgentStatus[]
    timeoutMs?: number
  }): Promise<AgentInstance | null> {
    const result = await this.call('agent.wait', {
      target: input.target,
      until: [...(input.until ?? [])],
      timeout_ms: input.timeoutMs ?? null
    })
    return parseAgentInstance(result.agent)
  }

  async focusAgent(target: string): Promise<boolean> {
    return resultType(await this.call('agent.focus', { target })) === 'ok'
  }
}

function nonNull<T>(value: T | null): value is T {
  return value !== null
}
