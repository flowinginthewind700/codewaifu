 # CodeWaifu Pro — MVP, derived from first principles

 > 中文速读：AI coding 的瓶颈已经不是"写代码"，而是**人的注意力**和**工作的存活率**。
 > 所以 Pro 不做编辑器、不做浏览器、不做 IDE，只做三件事：
 > **(1) 一眼看清哪个 agent 在等我**（分诊）、**(2) 不切终端就把决定做完**（就地决策）、
 > **(3) 崩溃/重启/三天后回来，工作能一键复活并且知道"当时要干什么"**（意图账本 + 恢复计划）。
> 终端由 herdr 托管，画面用 xterm.js 渲染，我们只拥有**意图、分诊、恢复**这三层——那是别人抄不走的部分。
> 第四个东西是别人没有的：**桌面上的 Live2D 伙伴和工作台是同一份状态的两张脸**——
> 工作台能把她召唤出来/收起来，她会用气泡和语音告诉你"哪个 agent 在等你"，
> 点她一下就跳回那个任务。她不是通知插件，是 bench 的环境信道。

 ## 1. The derivation

 Start from what is actually true when one human runs coding agents in 2026:

 1. **Generating code is cheap; deciding is not.** An agent emits a diff in seconds. A human
    verifying it takes minutes. The cost curve inverted, and every tool still built for the
    old curve (editors, diff viewers, file trees) optimizes the cheap side.
 2. **One human now runs N agents.** N is 3–20 in practice. Each agent, at unpredictable
    times, needs one of exactly four things: a permission decision, an answer to a question,
    a review, or nothing (it finished or died silently).
 3. **Human attention is the only scarce resource.** Sustainable rate is roughly one careful
    decision per 20–60 s, and a context switch costs minutes. So the product's job is to
    *spend attention only where it changes an outcome*, and to spend it fast.
 4. **Agents are processes, and processes die.** Laptops sleep, SSH drops, apps crash,
    machines reboot, terminals get closed by accident. Today the penalty is total: the
    conversation is gone and the human re-explains the task from scratch. That re-explanation
    is the largest single waste in the entire workflow, and no mainstream tool addresses it.
 5. **The terminal screen is a lossy, unstructured output channel.** Scrollback truncates,
    TUIs repaint over themselves, and nothing on screen is queryable. Anything the workbench
    needs to *know* must be captured at the event source (hooks) or read before it scrolls
    away. Screen scraping alone can never be ground truth.

 Two quantities follow, and they are the only ones worth optimizing:

 - **Decision latency** — time from "an agent needs me" to "that agent is unblocked".
   Triage, legibility and in-place action all serve this.
 - **Survivability** — probability that an interruption (crash, reboot, three days later,
   hand-off to another agent) costs *zero* re-explanation. Durability, the intent ledger and
   the recovery planner serve this.

 Anything that moves neither quantity is decoration. That sentence is the whole cut line for
 this MVP: it is why there is no editor, no diff viewer, no in-app browser, no dashboard.

 ### Three design laws

 1. **State lives in something that outlives the UI.** PTYs and layout → the herdr server
    process. Intent → an append-only, fsync'd ledger on disk. The GUI is disposable and must
    be fully re-derivable from those two. Closing the window is a non-event.
 2. **One screen answers four questions per task:** what is it, what did it do, what does it
    need from me, what happens next. If a task needs a second screen to act on, the design
    failed.
 3. **The default action is the right action.** Approve/deny/steer in one keystroke, no modal,
    no navigation, no "open the terminal and find the prompt".

 A fourth, weaker law: the human is not always looking at the screen, so an **ambient
 channel** (voice + glanceable badge) is a first-class capability, not a gimmick. And it has
 to run **both ways**: the bench must be able to summon the companion (show her, hide her,
 make her point at a task), and the companion must be able to act on the bench (a bubble
 click focuses the task that produced it; an approval spoken or tapped there unblocks the
 agent without the bench window ever coming forward). One state, two surfaces — the widget
 is not a notification plugin bolted onto the workbench, it is the same projection rendered
 for a human who is not looking at the screen. This is the piece CodeWaifu already has and
 no terminal-multiplexer competitor can copy quickly.

 ## 2. Where the moat is (and is not)

 Ranked by cost to copy:

 | # | Capability | Why it is hard to copy |
 |---|------------|------------------------|
 | 1 | **Recovery with intent** — ledger + planner | Everyone else restores *layout*; nobody restores *purpose*. This is a data model and a habit, not a feature. |
 | 2 | **Ground-truth triage** from hook events | herdr/cmux infer agent state from pixels and titles. We receive `permission_request` / `stop` / `session_start` from the agent itself, so we can answer a prompt without ever focusing its pane. |
 | 3 | **Ambient channel, both ways** — TTS + a Live2D companion that is a second surface of the same bench state | Requires a voice runtime, a hook pipeline, a desktop widget *and* a command channel between widget and bench. We ship the first three already; the fourth is a type and a bridge, not a research project. |
 | 4 | **Programmability** — the bench is an API | Agents can create tasks, post intent, ask questions and unblock each other. Adoption compounds. |

 Explicit non-moats we refuse to build: terminal rendering (xterm.js), PTY hosting and
 session durability at the process level (herdr), editing (VS Code), diffs (git / forge UI),
 browsing (a browser). **Pro is a control plane over a durable runtime.** We own intent,
 triage and recovery; we rent everything else.

 ## 3. Object model

 ```text
 Bench
  └─ Group        one per repo root / directory (auto-derived, never hand-filed)
      └─ Task     the durable unit of work  ← what the human thinks about
          ├─ workdir (repo root or a git worktree the task owns)
          ├─ agent   (kind + herdr session id for `resume`)
          ├─ panes   (herdr workspace/tab/pane ids, live state)
          ├─ intent  (goal, plan, decisions, next action — the ledger)
          └─ status  (active | parked | done | lost)
 ```

 A **Task** is the atom. Everything in the UI is a projection of the task list: the tree
 groups tasks, the attention queue filters tasks that need a decision, the pane grid renders
 the task that is focused, and the companion renders the same attention queue for a human
 whose eyes are somewhere else. Tasks are adoptable — on first run Pro imports whatever herdr
 already has, so nobody must change how they work to get value.

## 4. MVP features (the seven)

 ### F1 — Bench tree (left rail): the map of all work
 Directory-grouped, collapsible. Rows are tasks and each row carries its vitals: state dot
 (`working | blocked | done | idle | unknown`), agent kind, branch, dirty-file count, how long
 it has been blocked, last activity. Header shows fleet counts (`3 blocked · 5 working · 2
 awaiting review`) and a `needs me` filter. Keyboard-first (`j/k/enter/space`). Data comes
 from herdr `session.snapshot` + `events.subscribe` — push, never poll — enriched by hook
 events.

 ### F2 — Task lifecycle: create, adopt, park
 Create from the GUI: choose a directory → optionally "new worktree + branch" (herdr
 `worktree.create`) → launch the agent (`agent.start`) → a task exists with a live pane.
 Adopt: any herdr workspace without a task becomes an *unfiled* task on first sight.
 Park/done/archive are explicit human states that survive restarts. Task registry lives in
 `~/.codewaifu/pro/bench.json` (atomic write + read-back).

 ### F3 — Attention queue (triage): the one screen that matters
 A single sorted list of "needs me now", ordered by blocked-wait time, then unanswered
 questions, then finished-but-unreviewed. Each item shows the *actual decision*: for a
 permission prompt, the prompt text read from the pane (`pane.read --source detection`) plus
 the tool/command when the hook supplied it. In-place actions: **Approve**, **Deny**,
 **Answer…** (free text → `agent.send_keys` + Enter), **Snooze 10m**, **Open pane**. No
 terminal focus required — this is the candidate world-first, and it is only possible because
 of law 2 plus hook ground truth.

 ### F4 — Pane grid (right side): real terminals, rented from herdr
 xterm.js fed by the `herdr terminal session control <pane>` NDJSON bridge (base64 ANSI
 frames out; input/resize/scroll/release in). 1–4 panes per task, zoom, focus, send text.
 Killing the window kills nothing: herdr owns the PTYs. Above the panes sits the **task
 card**: goal, next action, branch/dirty, session id, and the verbs (Steer, Interrupt,
 Resume, Handoff, Reveal).

 ### F5 — Intent ledger + recovery planner: the moat
 `~/.codewaifu/pro/tasks/<taskId>.jsonl`, append-only, fsync'd, one JSON object per line:
 `goal | plan | decision | next | event | git | session | metric | checkpoint`. Written by
 hook events (automatic), by GUI capture (one keystroke: "record decision / next action"),
 and by `POST /pro/ledger` so an agent can state its own intent.

 On boot the **recovery planner** diffs the ledger against herdr reality and assigns each task
 a verdict:

 | Verdict | Meaning | One-click action |
 |---------|---------|------------------|
 | `intact` | pane alive, state known | nothing, just show it |
 | `resumable` | agent session id known, pane gone | relaunch with `codex resume <id>` / `claude --resume <id>` in the right workdir |
 | `rebuild` | worktree/dir or workspace missing | recreate workspace (+ worktree), then resume |
 | `lost` | no session id anywhere | show last goal + next action, offer "re-prompt with context" |

 `Apply plan` executes the whole thing. The same ledger powers **handoff**: copy a task's
 goal + decisions + next + git head as a prompt for a fresh agent (or a different model).

 Recovery layers, in order of who owns them:
 `L0` herdr process durability · `L1` herdr layout/snapshot restore · `L2` agent conversation
 resume (`resume <id>`, reported by hooks) · `L3` **intent ledger (ours)** · `L4` **recovery
 planner (ours)** · `L5` crash-proof self (fsync'd ledger; agents survive GUI death).

### F6 — Bench API: thin rails on existing infrastructure
 The loopback relay (already token-authenticated) grows `GET /pro/state`,
 `GET /pro/attention`, `POST /pro/answer`, `POST /pro/tasks`, `POST /pro/ledger/:taskId`, so
 scripts and agents can drive the bench. A `codewaifu-pro` skill later teaches agents to post
 intent and to unblock each other. The same `ProService` object backs the GUI, the HTTP API
 and the companion, so there is exactly one authority for "what needs me".

 Those rails now carry a third surface: `codewaifu pro <verb>` (F8, `shared/proCli.ts` +
 `main/pro/cli.ts`) is the same routes with argv in front and ASCII out, so a shell alias,
 a cron job and an agent can read and unblock the bench with no window open. Exit codes
 mirror the relay's status classes; there is no `send-keys`, and `pro recovery` is
 read-only because applying a plan is recorded with `source: 'gui'` provenance.

 Those rails now push, too (F9). `GET /pro/stream` is NDJSON of the `/pro/state` payload
 plus a `kind`, fed by `ProService.onChange` and capped at 16 watchers; `codewaifu pro watch`
 is the terminal that reads it - the tree once, then one line per change until ctrl-c
 (exit 0, so a shell loop can tell "I stopped it" from "it broke"), with `--json` streaming
 the raw frames. It is criterion 6.1's "updates arrive as events" extended past the window:
 a poll loop in a shell is the same waste as one in the renderer, and until now the only way
 to watch the bench from a terminal was to write that loop.

### F7 — Companion link: the widget and the bench are one product
 Two-way, by design, and the only feature here that no multiplexer can grow into.

 **Bench → companion.** A stage control summons or dismisses the Live2D widget
 (`show | hide | toggle`), and any attention item can be *handed to her*: she pops up,
 says the line, and her bubble carries the task so a click returns to it. The tray/hotkey
 path already exists; Pro only adds the command and the reason.

 **Companion → bench.** Every bubble an attention item produces is clickable and resolves to
 `focusTask(taskId, paneId?)`: the Bench window comes forward, the tree selects that task and
 the pane grid focuses that pane. Her expression follows the bench (`alert` while something is
 blocked, `talk` while announcing, `happy` when the queue drains), and the tray badge is the
 live attention count — glanceable without a window.

 **Spoken and typed decisions.** `answer` from the widget reuses the existing chat/steer
 input, so "approve the second one" or a free-text answer can be given without switching
 windows. The widget never owns state; it issues the same `AttentionAction` the Bench does.

 **Shipped differently, on purpose.** The free-text answer is a one-line composer in the
 bubble itself rather than the chat/steer input. The chat view is a mode, so "reuse the chat
 input" costs the very mode switch this feature exists to avoid; and a chat message is a
 `steer` to whichever thread is selected, not an `answer` to the item that asked, so routing
 one through the other lets a reply land on the wrong agent. The invariant this section is
 actually protecting survives intact: the widget owns no state, it issues the same
 `AttentionAction`, and the text reaches the pane through the same `agent.prompt` path as the
 Bench's queue - one implementation, one ledger line. It is capped and folded in
 `planAttentionAction` (`shared/pro.ts::answerText`) because an answer is delivered as
 keystrokes, where a newline is Enter and a TUI input buffer drops bytes past its length
 without complaining.

 The contract is one shared type (`CompanionCommand` / `CompanionNotice`) plus
 `src/main/pro/companion.ts`, which translates bench attention into notices and notice clicks
 back into bench commands. Per-kind toggles (`pro.ambient.{speak,bubble,summon}`) live in
 config so a headless CI box can run the bench with no widget at all.

## 5. Out of the MVP (deliberate cuts)

Built-in editor · diff viewer · in-app browser · cloud/mobile companion UI · multi-machine
SSH UI (herdr has it; we inherit later) · token/cost dashboards · plugin system ·
node-pty fallback when herdr is missing (the empty state is an **install card** instead) ·
theming · project management / issue tracking · a second Live2D model for
the bench (the companion is one widget with two jobs, not two widgets) · voice *recognition*
for approvals (speech out only; a misheard "deny" is worse than a keystroke).

 Cutting these is what keeps Pro a cockpit rather than an Orca-scale ADE.

**One cut was reversed.** Scrollback search shipped: `Ctrl+Shift+F` (`Cmd+F` on
macOS), with regex and case modes and a match counter. The reasoning that cut it -
the pane is a control surface, not a log reader - is wrong about the failure it
produces. Once the pane grid is the only view of an agent's output, the line you
need has usually scrolled off, and the alternative is a second terminal onto a
session herdr already owns. It cost a pure planner (`shared/findQuery.ts`, tested)
plus xterm's own SearchAddon, so this was a mistaken cut rather than a premature
one.

 ## 6. Acceptance criteria (MVP is done when)

 1. With herdr running, cold boot shows a correct tree of every workspace/pane with live
    states in **under 1 s**, and updates arrive as events (no polling loop in the log).
 2. `kill -9` the app → relaunch: tasks, groups and ledger intact; agents still working in
    herdr; **no duplicated panes**.
 3. Reboot the machine → launch → the recovery plan lists every task with a verdict; one click
    restores layout and relaunches agents with `resume <id>`; a task with no captured session
    id shows goal + next and offers re-prompt.
 4. A Codex/Claude permission prompt appears in the attention queue within ~1 s of the hook
    firing, and **Approve unblocks the agent without focusing its terminal**.
 5. 20 tasks across 4 repos stay scannable; keyboard-only navigation works; memory stays flat
    through an hour of busy output (frame deltas, not full repaints, and bridges only for
    visible panes).
 6. vitest covers: herdr NDJSON client + bridge frame parsing, ledger append/read/compact,
    planner verdicts, triage ordering and answers — against recorded fixtures.
 7. From the Bench, one control hides the companion and one brings her back; with the Bench
    window minimized, a permission hook makes her pop, speak, and show a bubble whose click
    restores the Bench **already focused on that task and that pane**. The attention count on
    the tray/badge equals the queue length in the Bench at all times (one source, two renders).

 ## 7. Phases

 | Phase | Deliverable | Verifiable without a GUI |
 |-------|-------------|--------------------------|
 | 0 | herdr installed, fixtures recorded, docs, repo hygiene | yes |
| 1 | `pro/herdr/*`: discovery, socket client, snapshot cache, event stream, terminal bridge | yes — the `codewaifu pro` verb family (through `watch`), unit tests, and four e2e cases that spawn the built CLI |
 | 2 | ledger + recovery planner + triage engine | yes — pure functions + tests |
 | 3 | Bench window: tree, attention bar, task card, xterm pane grid, IPC, config | manual + e2e smoke (`npm run test:e2e`) |
 | 4 | companion link (F7) + `/pro/*` HTTP API + agent skill | yes — the bridge is pure translation over `ProService`, unit-testable with a fake window handle |

 ## 8. Architecture map

 ```text
 src/shared/pro.ts            types shared by main/preload/renderer (Task, Group, AttentionItem, LedgerEntry, RecoveryPlan)
 src/main/pro/herdr/discovery.ts      find the binary + the right socket (HERDR_SOCKET_PATH, HERDR_SESSION, ~/.config/herdr[/sessions/<name>]/herdr.sock, Windows named pipe)
 src/main/pro/herdr/socket.ts         NDJSON request/response, one connection per call, timeouts, typed errors
 src/main/pro/herdr/client.ts         snapshot cache + events.subscribe stream + typed method wrappers
 src/main/pro/herdr/terminalBridge.ts spawn `herdr terminal session control`, parse frames, forward input/resize/scroll
 src/main/pro/ledger.ts               append-only JSONL, fsync, read, compact
 src/main/pro/recovery.ts             ledger vs reality -> RecoveryPlan (verdicts + steps)
 src/main/pro/triage.ts               attention queue: rank, snooze, answer actions
 src/main/pro/bench.ts                task registry (adopt/create/park), group derivation
 src/main/pro/companion.ts            attention -> CompanionNotice; widget click -> bench command
 src/main/pro/service.ts              the object main/index.ts talks to; owns lifecycle
 src/main/pro/ipc.ts + preload        allow-listed channels, plain data only
 src/renderer/src/pro/*               Bench window (tree, attention, task card, pane grid)
 ```

 ## 9. Risks and the honest answers

 - **herdr is a hard dependency.** Mitigation: it is one Rust binary with a documented
   install path, Apache-2.0, and it does L0/L1/L2 better than we could. Pro degrades to a
   read-only install card, never to a half-broken terminal.
 - **Two hook writers in one config file.** herdr installs its own entries into
   `~/.codex/hooks.json` and `~/.claude/settings.json`. Our `hooksMerge` must preserve foreign
   entries (it already merges by design; a regression test pins it).
 - **ANSI frame volume.** One bridge per *visible* pane only; hidden panes are read on demand
   via `pane.read`. Frames are deltas (`full:false`) and are dropped, never queued, if the
   renderer falls behind.
 - **State authority conflicts.** If we ever report agent state into herdr
   (`pane.report_agent`) we become lifecycle authority and must release it on exit
   (`pane.release_agent`) or leave stale state behind. MVP therefore *reads* herdr state and
   *writes* only the ledger; reporting ground truth into herdr is a Phase 4 experiment.
 - **Two windows, one truth.** The widget and the Bench are separate `BrowserWindow`s and
   could drift (stale badge, a bubble pointing at a task that is gone). Mitigation: the
   companion is a pure *render* of `ProService` state pushed over one channel, notices carry a
   `taskId` that the bridge re-resolves on click, and a click on a vanished task degrades to
   "show the bench" instead of doing nothing. `ProService.shutdown()` dismisses notices it
   issued, so quitting the bench cannot leave her pointing at a dead task.
 - **The widget must not become a second input surface for the terminal.** She announces and
   routes; typing into a pane stays in the pane grid. The single exception is `answer`, which
   goes through the same `agent.prompt` path as the attention queue, so there is one
   implementation of "send this text to that agent" and one audit-trail entry for it.
