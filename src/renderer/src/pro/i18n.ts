/**
 * The Bench's copy table.
 *
 * Same shape as the widget's `renderer/src/i18n.ts` - a flat `{zh,en}` record,
 * a `Translate` that closes over one language, and no runtime language
 * negotiation. Two reasons it is a separate file rather than an extension of
 * the widget's: the bench has ~250 strings the widget will never render, and
 * the widget bundle must stay small enough to paint a Live2D model at 60fps.
 *
 * Interpolation is `{name}` placeholders filled by `fill()`. Keeping it a dumb
 * string replace (rather than a template engine) is deliberate: every string
 * here is also read by a human skimming a diff, and a plural rule that lives in
 * code instead of in the table is a plural rule nobody reviews.
 */
import type { Lang } from '@shared/protocol'
import { spawnFailure } from '@shared/pro'

const STRINGS = {
  /* ---------------------------------------------------------- shell */
  // The product, not the mode. The mode is the segmented control next to it, so
  // a name like CodeWaifu Pro here would claim two apps where there is one app
  // with two surfaces.
  brandName: { zh: 'CodeWaifu', en: 'CodeWaifu' },
  modeLabel: { zh: '模式', en: 'Mode' },
  modeStage: { zh: '舞台', en: 'Stage' },
  modeBench: { zh: '工作台', en: 'Bench' },
  backToStage: { zh: '回到舞台', en: 'Back to the stage' },
  booting: { zh: '正在启动工作台…', en: 'Starting the bench…' },
  /**
   * The two column toggles, and the two splitters between the columns.
   *
   * Named as a pair of verbs rather than one, because "Tasks" is not an
   * instruction: a control that hides something has to say so while it is still
   * visible, or the tooltip reads the same in both states and the panel
   * disappears for what looks like no reason.
   */
  collapseRail: { zh: '收起左侧任务树', en: 'Hide the task tree' },
  expandRail: { zh: '展开左侧任务树', en: 'Show the task tree' },
  collapseRight: { zh: '收起右侧面板', en: 'Hide the side panel' },
  expandRight: { zh: '展开右侧面板', en: 'Show the side panel' },
  /**
   * The splitter handles. Both gestures are named because the handle is a real
   * control: a seam you can only find with a mouse is a seam nobody without one
   * can move, and a width you cannot undo is a width you are stuck with.
   */
  splitRail: {
    zh: '拖动或按 ←/→ 调整任务树宽度 · Enter 恢复默认',
    en: 'Drag or press ←/→ to resize the tree · Enter resets'
  },
  splitRight: {
    zh: '拖动或按 ←/→ 调整侧栏宽度 · Enter 恢复默认',
    en: 'Drag or press ←/→ to resize the panel · Enter resets'
  },
  /** Said once, when a splitter is reset to the shipped width. */
  splitReset: { zh: '栏宽已恢复默认', en: 'Column width reset' },
  keyHints: {
    zh: 'j/k 移动 · Enter 打开 · i 聚焦终端 · c 连接 · t 开新终端 · 空格 筛选 · a/d/s 决策 · 1/2/3 切换',
    en: 'j/k move · Enter open · i focus pane · c connect · t shell · Space filter · a/d/s decide · 1/2/3 tabs'
  },
  /** `a/d/s` hit the head of the queue; this is what "that one has no such verb" says. */
  actionNotAvailable: {
    zh: '排在最前的这条不支持这个操作。',
    en: 'The top item does not take that action.'
  },
  /** Only reason a focus push earns a toast: the window came forward because she was clicked. */
  focusFromWidget: { zh: '已跳到看板娘指的任务', en: 'Jumped to the task she pointed at' },
  /**
   * A queue row was clicked for a task that is gone by the time the click lands.
   * herdr kills panes between state pushes, so a stale row is normal, not a bug -
   * but silently doing nothing reads as a broken button.
   */
  taskGone: { zh: '这个任务已经结束了。', en: 'That task is gone.' },

  /* ------------------------------------------------------- fault card */
  /**
   * Rendered by `FaultBoundary` when the bench itself threw. The copy leads with
   * the fact that decides whether this is a catastrophe: herdr owns the PTYs, so
   * a dead renderer has killed nobody and reloading is safe.
   */
  faultTitle: { zh: '工作台界面出错了', en: 'The bench UI hit an error' },
  faultBody: {
    zh: '崩的只是界面这一层 —— 你的代理还在 herdr 里跑着。重载之后任务树和账本会从磁盘和 herdr 重新推导回来。',
    en: 'Only the UI layer crashed - your agents are still running in herdr. After a reload the tree and the ledger are re-derived from disk and from herdr.'
  },
  /**
   * An error with no readable message. The kind chip is still on the card, so
   * this is not a dead end - and the same string is what "Copy details" puts
   * after the colon, which is why it reads as a sentence rather than a fragment.
   */
  faultUnknown: {
    zh: '这个错误没有留下可读的信息。',
    en: 'The error left no readable message.'
  },
  faultReload: { zh: '重载工作台', en: 'Reload the bench' },
  faultCopy: { zh: '复制详情', en: 'Copy details' },
  faultCopied: { zh: '已复制', en: 'Copied' },
  faultCopyFailed: {
    zh: '复制失败（窗口没焦点时会这样）—— 请截图这张卡片。',
    en: 'Copy failed (this happens when the window is unfocused) - screenshot this card instead.'
  },

  /* ---------------------------------------------------------- herdr */
  herdrOnline: { zh: 'herdr {version}', en: 'herdr {version}' },
  herdrOffline: { zh: 'herdr 未连接', en: 'herdr offline' },
  herdrStats: { zh: '{workspaces} 个工作区 · {panes} 个面板', en: '{workspaces} workspaces · {panes} panes' },
  herdrSocket: { zh: '套接字 {path}', en: 'socket {path}' },

  /* ---------------------------------------------------------- counts */
  countWorking: { zh: '运行中', en: 'working' },
  countBlocked: { zh: '待批', en: 'blocked' },
  countDone: { zh: '已完成', en: 'done' },
  countIdle: { zh: '空闲', en: 'idle' },
  countUnknown: { zh: '未知', en: 'unknown' },
  countNeedsMe: { zh: '需要我', en: 'needs me' },

  /* ---------------------------------------------------------- topbar */
  toggleSpeak: { zh: '语音播报', en: 'Speak' },
  toggleBubble: { zh: '气泡提醒', en: 'Bubbles' },
  toggleBadge: { zh: '托盘角标', en: 'Tray badge' },
  summonLabel: { zh: '召唤', en: 'Summon' },
  summonAlways: { zh: '总是', en: 'Always' },
  summonBlocking: { zh: '仅阻塞时', en: 'When blocked' },
  summonNever: { zh: '从不', en: 'Never' },
  companionShow: { zh: '召唤看板娘', en: 'Summon companion' },
  companionHide: { zh: '收起看板娘', en: 'Dismiss companion' },
  newTask: { zh: '新建任务', en: 'New task' },
  adopt: { zh: '接管现有工作区', en: 'Adopt workspaces' },
  snoozeAll: { zh: '全部稍后', en: 'Snooze all' },
  refresh: { zh: '重新发现 herdr', en: 'Re-discover herdr' },
  /**
   * The window controls the frameless bench paints itself.
   *
   * Named like the OS verbs they replace, because that is what the human is
   * looking for at the right end of a bar: minimise, close. Close is hide
   * here - the bench keeps running and her scrollback survives - but a
   * tooltip that explains that is a tooltip longer than the bar.
   */
  winMinimize: { zh: '最小化', en: 'Minimise' },
  winClose: { zh: '收起工作台', en: 'Close the bench' },

  /* --------------------------------------------------------- import */
  importTitle: { zh: '导入会话', en: 'Import sessions' },
  importHint: {
    zh: '看板娘在这台机器上看到的 codex / claude 会话。导入后它们会落进自己所在的目录分组，并带上「导入」标记。',
    en: 'The codex and claude sessions she can see on this machine. Imported ones land in the tree under their own directory, tagged as imported.'
  },
  importLoading: { zh: '正在扫描会话…', en: 'Scanning sessions…' },
  importEmpty: { zh: '还没有可导入的会话。', en: 'No sessions to import yet.' },
  importSelectAll: { zh: '全选', en: 'Select all' },
  importPicked: { zh: '已选 {n} / {total}', en: '{n} of {total} selected' },
  importClaimed: { zh: '已在树中', en: 'In the tree' },
  importLive: { zh: '这个会话刚刚还有动静', en: 'This session is live' },
  importAttach: { zh: '导入后立即接入', en: 'Attach right after import' },
  importAttachHint: {
    zh: '不勾选就先搁置：任务进树但不占终端，之后可以在任务卡上点「接管终端」。',
    en: 'Leave unticked to park them: they enter the tree without a terminal, and you can attach later from the task card.'
  },
  importSubmit: { zh: '导入 {n} 个', en: 'Import {n}' },
  importDone: { zh: '已导入 {n} 个会话', en: 'Imported {n} sessions' },
  importAttached: {
    zh: '已导入并接入 {attached} 个会话',
    en: 'Imported and attached {attached} sessions'
  },
  importSkipped: {
    zh: '{n} 个被跳过：目录不存在，或已经在树里。',
    en: '{n} skipped: missing directory, or already in the tree.'
  },

  /* ---------------------------------------------------------- tree */
  treeTitle: { zh: '任务', en: 'Tasks' },
  needsMeOnly: { zh: '只看待处理', en: 'Needs me only' },
  treeEmpty: {
    zh: '还没有任务。点「新建任务」开一个，「接管现有工作区」收 herdr 里在跑的，或「导入会话」把她看到的 codex / claude 会话收进来。',
    en: 'No tasks yet. Create one, adopt whatever herdr already has running, or import the sessions she can see.'
  },
  treeEmptyFiltered: { zh: '没有任务需要你处理。', en: 'Nothing needs you right now.' },
  treeEmptyFacet: { zh: '这个来源下还没有任务。', en: 'Nothing in the tree from that source yet.' },
  /** The facet chips. A filter, not a fourth group: the spine is directories. */
  filterLabel: { zh: '来源', en: 'Origin' },
  filterAll: { zh: '全部', en: 'All' },
  filterMine: { zh: '我建的', en: 'Mine' },
  filterImported: { zh: '不是这里建的', en: 'Imported' },
  originAdopted: { zh: '接管', en: 'adopted' },
  originImported: { zh: '导入', en: 'imported' },
  treeFoot: { zh: '{shown} / {total} 个任务', en: '{shown} of {total} tasks' },
  unfiled: { zh: '未归档', en: 'Unfiled' },
  /**
   * Renaming a task. The label names the row that will be edited (double-click
   * a row, or the pencil in the rail head for whatever `j/k` last highlighted),
   * and the hint gives the two keys because a field with no visible buttons has
   * no other way to say how it closes.
   */
  renameTask: { zh: '重命名任务（或在树里双击）', en: 'Rename this task (or double-click it in the tree)' },
  renameKeys: { zh: 'Enter 保存 · Esc 取消', en: 'Enter to save · Esc to cancel' },
  statusActive: { zh: '进行中', en: 'Active' },
  statusParked: { zh: '已搁置', en: 'Parked' },
  statusDone: { zh: '已完成', en: 'Done' },
  statusLost: { zh: '已失联', en: 'Lost' },

  /* ---------------------------------------------------------- task card */
  goalLabel: { zh: '目标', en: 'Goal' },
  nextLabel: { zh: '下一步', en: 'Next' },
  emptyGoal: { zh: '还没有记录目标', en: 'No goal recorded yet' },
  emptyNext: { zh: '还没有记录下一步', en: 'No next action recorded' },
  factBranch: { zh: '分支', en: 'Branch' },
  factDirty: { zh: '未提交', en: 'Dirty' },
  factSession: { zh: '会话', en: 'Session' },
  factTokens: { zh: 'tokens', en: 'tokens' },
  factStatus: { zh: '状态', en: 'Status' },
  factLast: { zh: '最近活动', en: 'Last activity' },
  factWorkdir: { zh: '目录', en: 'Directory' },
  factAgent: { zh: '代理', en: 'Agent' },
  dirtyCount: { zh: '{n} 个文件', en: '{n} files' },
  verbSteer: { zh: '插话', en: 'Steer' },
  verbInterrupt: { zh: '打断', en: 'Interrupt' },
  verbResume: { zh: '恢复', en: 'Resume' },
  verbHandoff: { zh: '交接', en: 'Handoff' },
  verbReveal: { zh: '打开目录', en: 'Reveal' },
  verbPark: { zh: '搁置', en: 'Park' },
  verbUnpark: { zh: '恢复进行', en: 'Unpark' },
  verbDone: { zh: '标记完成', en: 'Mark done' },
  verbReopen: { zh: '重新打开', en: 'Reopen' },
  verbRemove: { zh: '移除', en: 'Remove' },
  verbAttach: { zh: '接管终端', en: 'Attach' },
  steerPlaceholder: {
    zh: '给这个任务插一句话，回车发送…',
    en: 'Send a line to this task, Enter to send…'
  },
  steerNoPane: { zh: '这个任务当前没有活动面板，无法插话。', en: 'This task has no live pane to steer.' },
  interruptSent: { zh: '已发送 Esc', en: 'Sent Esc' },
  handoffCopied: { zh: '交接提示词已复制到剪贴板', en: 'Handoff prompt copied to the clipboard' },
  handoffFailed: { zh: '复制失败', en: 'Copy failed' },
  confirmRemoveTitle: { zh: '移除这个任务？', en: 'Remove this task?' },
  confirmRemoveBody: {
    zh: '记录会从工作台移除。下面这一项决定 herdr 里那个终端的去留。',
    en: 'The row leaves the bench. The box below decides what happens to its terminal in herdr.'
  },
  confirmRemoveCloseShell: {
    zh: '同时关闭 herdr 里的终端（里面正在跑的进程会一起结束）',
    en: 'Also close the terminal in herdr (anything running in it stops)'
  },
  /** Shown while the box above is unticked, because that choice has a tail. */
  confirmRemoveKeepShell: {
    zh: '不关闭：终端继续在 herdr 里跑，工作台不再显示它，顶栏会留一个一键关闭的入口。',
    en: 'Left running: the bench stops showing it, and the topbar keeps a one-click way to close it.'
  },
  /** Shown instead of the box, when there is nothing left to close. */
  confirmRemoveNoShell: {
    zh: '这一行没有正在运行的终端，移除只删记录。',
    en: 'This row has no terminal running, so removing it only drops the record.'
  },
  confirmRemove: { zh: '移除', en: 'Remove' },
  confirmCancel: { zh: '取消', en: 'Cancel' },

  /* ------------------------------------------------- removed but alive */
  /**
   * Removals that left the shell running. The chip exists so suppression is
   * never silent: a terminal you closed and can no longer find anywhere reads
   * as a bug, and the button on it is the way out.
   */
  declinedChip: {
    zh: '{n} 个已移除的终端仍在 herdr 里运行',
    en: '{n} removed terminals still running in herdr'
  },
  declinedTip: {
    zh: '你移除时选择了保留进程：工作台不再显示它们，但它们还开着。',
    en: 'You removed these and left the processes running. The bench no longer shows them.'
  },
  declinedClose: { zh: '全部关闭', en: 'Close them all' },
  /** What the toast says after a removal, which is the only proof it landed. */
  removedAndClosed: {
    zh: '已移除，herdr 里的终端也关掉了',
    en: 'Removed, and its terminal in herdr is closed'
  },
  removedStillRunning: {
    zh: '已移除，但 herdr 没能关掉那个终端，它还开着',
    en: 'Removed, but herdr did not close that terminal; it is still running'
  },
  purgedToast: { zh: '已关闭 {n} 个终端', en: 'Closed {n} terminals' },

  /* ---------------------------------------------------------- recovery */
  recoveryTitle: { zh: '恢复计划', en: 'Recovery' },
  recoveryBanner: { zh: '这个任务需要恢复', en: 'This task needs recovery' },
  applyPlan: { zh: '执行计划', en: 'Apply plan' },
  applyAll: { zh: '全部执行', en: 'Apply all' },
  reprompt: { zh: '用上下文重新提问', en: 'Re-prompt with context' },
  recoveryEmpty: { zh: '所有任务都完好，无需恢复。', en: 'Every task is intact. Nothing to recover.' },
  recoveryOffline: {
    zh: 'herdr 没有连接，无法判断任务是否还活着。',
    en: 'herdr is not connected, so nothing can be known about live tasks yet.'
  },
  recoveryCount: { zh: '{n} 个任务需要恢复', en: '{n} tasks need recovery' },
  verdictIntact: { zh: '完好', en: 'Intact' },
  verdictResumable: { zh: '可恢复会话', en: 'Resumable' },
  verdictRebuild: { zh: '需要重建', en: 'Rebuild' },
  verdictLost: { zh: '上下文丢失', en: 'Lost' },
  verdictOffline: { zh: '离线', en: 'Offline' },
  verdictParked: { zh: '已搁置', en: 'Parked' },
  stepWorkspace: { zh: '工作区', en: 'Workspace' },
  stepWorktree: { zh: '工作树', en: 'Worktree' },
  stepAgent: { zh: '启动代理', en: 'Start agent' },
  stepPrompt: { zh: '发送提示词', en: 'Send prompt' },
  stepNotice: { zh: '提示', en: 'Notice' },

  /* ---------------------------------------------------------- attention */
  queueTitle: { zh: '需要我', en: 'Needs me' },
  queueEmpty: { zh: '没有事情需要你处理。', en: 'Nothing needs you.' },
  queueEmptyBusy: {
    zh: '代理们都在跑。有东西被挡住时这里会立刻出现。',
    en: 'The agents are all running. Anything that blocks shows up here immediately.'
  },
  queueSnoozed: { zh: '已稍后', en: 'Snoozed' },
  kindPermission: { zh: '请求授权', en: 'Permission' },
  kindQuestion: { zh: '提问', en: 'Question' },
  kindReview: { zh: '待复查', en: 'Review' },
  kindStalled: { zh: '疑似卡住', en: 'Stalled' },
  kindFailed: { zh: '失败', en: 'Failed' },
  actionApprove: { zh: '批准', en: 'Approve' },
  actionDeny: { zh: '拒绝', en: 'Deny' },
  actionAnswer: { zh: '回答…', en: 'Answer…' },
  actionSnooze: { zh: '稍后 {n} 分钟', en: 'Snooze {n}m' },
  actionOpen: { zh: '打开面板', en: 'Open pane' },
  actionDone: { zh: '标记已看', en: 'Mark reviewed' },
  actionDismiss: { zh: '忽略', en: 'Dismiss' },
  actionReprompt: { zh: '重新提问', en: 'Re-prompt' },
  answerPlaceholder: { zh: '用文字回答，回车发送…', en: 'Answer in words, Enter to send…' },
  answerSend: { zh: '发送', en: 'Send' },
  answerNeedsText: { zh: '先写点内容再发送。', en: 'Write something first.' },
  sendsKeys: { zh: '将发送 {keys}', en: 'sends {keys}' },
  menuRowsHead: {
    zh: '它屏幕上的选项（按哪个就发哪个键）',
    en: 'Its own menu: each button sends that row key'
  },
  noRecipe: {
    zh: '没有 {agent} 的按键配方，不会盲发按键。用文字回答或打开面板。',
    en: 'No key recipe for {agent}, so nothing will be pressed blind. Answer in words or open the pane.'
  },
  waitedFor: { zh: '等了 {t}', en: 'waiting {t}' },
  whereUnknown: { zh: '未归档任务', en: 'Unfiled task' },

  /* ---------------------------------------------------------- ledger */
  ledgerTitle: { zh: '意图账本', en: 'Intent ledger' },
  ledgerEmpty: {
    zh: '还没有条目。代理的钩子事件、你按「记录」写下的决定都会落在这里。',
    en: 'Nothing recorded yet. Hook events and anything you capture land here.'
  },
  ledgerNoTask: { zh: '先选一个任务。', en: 'Select a task first.' },
  captureLabel: { zh: '记一笔', en: 'Capture' },
  capturePlaceholder: { zh: '发生了什么、决定了什么、下一步做什么…', en: 'What happened, what you decided, what is next…' },
  captureButton: { zh: '记录', en: 'Record' },
  ledgerKindGoal: { zh: '目标', en: 'Goal' },
  ledgerKindPlan: { zh: '计划', en: 'Plan' },
  ledgerKindDecision: { zh: '决定', en: 'Decision' },
  ledgerKindNext: { zh: '下一步', en: 'Next' },
  ledgerKindEvent: { zh: '事件', en: 'Event' },
  ledgerKindGit: { zh: 'Git', en: 'Git' },
  ledgerKindSession: { zh: '会话', en: 'Session' },
  ledgerKindMetric: { zh: '指标', en: 'Metric' },
  ledgerKindCheckpoint: { zh: '检查点', en: 'Checkpoint' },
  ledgerKindNote: { zh: '笔记', en: 'Note' },
  ledgerCount: { zh: '{n} 条', en: '{n} entries' },

  /* ---------------------------------------------------------- panes */
  panesTitle: { zh: '终端', en: 'Terminals' },
  noPanes: {
    zh: '这个任务没有活动面板。herdr 里它可能已经结束了 —— 看上面的恢复计划。',
    en: 'This task has no live pane. It may be gone from herdr - see the recovery plan above.'
  },
  noTask: { zh: '从左边选一个任务。', en: 'Pick a task on the left.' },

  /* ---------------------------------------------------- conversation */
  /**
   * The surface for a task with no pane. An imported session is still running
   * in the human's own terminal, so the bench cannot show its PTY - what it can
   * show is the transcript the agent writes for itself, which is the same file
   * the stage's chat view reads.
   */
  convoTitle: { zh: '会话记录', en: 'Conversation' },
  convoHint: {
    zh: '这个任务跑在工作台之外的终端里，这里读的是 agent 自己写下的记录文件。',
    en: 'This task runs in a terminal the bench does not own. What you are reading is the transcript the agent writes for itself.'
  },
  convoLoading: { zh: '正在读取记录…', en: 'Reading the transcript…' },
  convoEmpty: { zh: '记录还是空的。', en: 'Nothing in the transcript yet.' },
  convoNoSession: {
    zh: '这个任务还没有 agent 会话 id，暂时没有记录可读。它一开口，这里就会跟上。',
    en: 'This task has no agent session id yet, so there is no transcript to read. It will appear here as soon as the agent speaks.'
  },
  convoMissing: {
    zh: '找不到这个会话的记录文件：可能已被清理，或者会话跑在另一台机器上。',
    en: 'No transcript file for this session: it may have been cleaned up, or the session runs on another machine.'
  },
  convoFailed: { zh: '读取失败：{detail}', en: 'Read failed: {detail}' },
  convoRefresh: { zh: '重新读取', en: 'Re-read' },
  convoReveal: { zh: '打开记录文件', en: 'Reveal transcript file' },
  convoOlder: { zh: '载入更早的 {n} 条', en: 'Load {n} older' },
  convoDropped: { zh: '还有 {n} 条更早的消息', en: '{n} older messages' },
  convoTruncated: { zh: '（已截断）', en: '(truncated)' },
  convoLive: { zh: '跟随中', en: 'Following' },
  convoIdle: { zh: '已停止跟随', en: 'Not following' },
  convoTool: { zh: '工具', en: 'Tool' },
  convoReasoning: { zh: '思考', en: 'Reasoning' },
  convoMore: { zh: '展开', en: 'More' },
  convoLess: { zh: '收起', en: 'Less' },
  convoPlaceholder: { zh: '接着这个会话说一句…', en: 'Say something to this session…' },
  convoSend: { zh: '发送', en: 'Send' },
  convoSteerHint: {
    zh: 'Codex 走队列投递，Claude 没有注入接口、内容进剪贴板。',
    en: 'Codex takes a queue write; Claude has no injection API, so the text goes to your clipboard.'
  },
  steerSent: { zh: '已送达会话 {id}', en: 'Delivered to session {id}' },
  steerQueued: {
    zh: '已排队，但 {id} 现在没在读队列；内容也复制到剪贴板了',
    en: 'Queued, but {id} is not reading the queue right now; the text is also on your clipboard'
  },
  steerUndelivered: {
    zh: '{id} 收下了却没在超时内读取；内容已复制到剪贴板',
    en: '{id} accepted it but never read it in time; the text is on your clipboard'
  },
  steerNoCli: { zh: '找不到 codex CLI，内容已复制到剪贴板', en: 'Could not find the codex CLI; the text is on your clipboard' },
  steerFailed: { zh: '插话失败，内容已复制到剪贴板', en: 'Steering failed; the text is on your clipboard' },
  steerClaudeClipboard: {
    zh: 'Claude 没有注入接口，内容已复制到剪贴板，去它的终端粘贴',
    en: 'Claude has no injection API; the text is on your clipboard, paste it into its terminal'
  },
  phaseIdle: { zh: '未接管', en: 'Idle' },
  phaseStarting: { zh: '正在接管…', en: 'Attaching…' },
  phaseLive: { zh: '实时', en: 'Live' },
  /**
   * The center of the bench can show either the task's terminal or its
   * transcript. The terminal is what the agent sees (its own TUI, flat by
   * design); the transcript is what the agent said, with syntax colours.
   */
  centerViewLabel: { zh: '中间视图', en: 'Center view' },
  centerTerm: { zh: '终端', en: 'Terminal' },
  centerConvo: { zh: '对话', en: 'Transcript' },
  phaseRespawning: { zh: '重连中…', en: 'Reconnecting…' },
  phaseClosed: { zh: '已关闭', en: 'Closed' },
  phaseError: { zh: '桥接错误', en: 'Bridge error' },
  /**
   * The pane could not start its control process. Node's `spawn ... ENOENT` is
   * accurate and tells nobody what to do; these two are the fix each errno
   * implies, and `{path}` is the file that was tried.
   */
  paneErrNoBinary: {
    zh: '找不到 herdr：{path}。装上它，或在 ~/.codewaifu/config.json 里把 pro.herdrPath 指向可执行文件。',
    en: 'herdr was not found at {path}. Install it, or set pro.herdrPath in ~/.codewaifu/config.json to the binary.'
  },
  paneErrNotExecutable: {
    zh: 'herdr 无法执行：{path}。给它加执行权限（chmod +x），或把 pro.herdrPath 指向正确的文件。',
    en: 'herdr at {path} cannot be executed. Run chmod +x on it, or set pro.herdrPath to the right file.'
  },
  droppedFrames: { zh: '丢了 {n} 帧', en: '{n} frames dropped' },
  paneBell: { zh: '终端响铃', en: 'Terminal bell' },
  paneScrollBack: { zh: '已回看 {n} 行', en: '{n} lines back' },
  paneScrollBottom: { zh: '回到最新输出', en: 'Back to the live edge' },
  paneCopyFailed: { zh: '复制失败', en: 'Copy failed' },
  /* ------------------------------------------------------- attachments */
  /**
   * What a drag or a paste put into the input. It says "paths" rather than
   * "files" on purpose: the honest description of an attachment here is text the
   * agent can open, and a human who dropped a screenshot wants to know it landed
   * somewhere readable rather than that it was "uploaded".
   */
  attachPaths: { zh: '已插入 {n} 个文件路径', en: 'Inserted {n} file paths' },
  /** The clipboard held an image and writing it out did not work. */
  attachFailed: {
    zh: '剪贴板里的图片没能存成文件',
    en: 'The image on the clipboard could not be saved to a file'
  },
  attachDrop: { zh: '松手，把文件路径交给代理', en: 'Drop to hand the file paths to the agent' },
  attachDropField: { zh: '松手即插入路径', en: 'Drop to insert the paths' },
  paneZoomOn: { zh: '放大此面板', en: 'Zoom this pane' },
  paneZoomOff: { zh: '退出放大', en: 'Unzoom' },
  paneFocusHerdr: { zh: '在 herdr 里聚焦', en: 'Focus in herdr' },
  paneDetach: { zh: '释放终端', en: 'Release terminal' },
  paneDetachedNote: {
    zh: '已释放这个面板的终端桥接。代理仍在 herdr 里运行。',
    en: 'The bridge to this pane is released. The agent is still running in herdr.'
  },
  paneAttachedElsewhere: { zh: '另一个窗口正接管这个面板', en: 'Another window holds this pane' },
  /**
   * `i` found a pane in the projection but no terminal behind it: released, or
   * its bridge errored out. Distinct from `noPanes`, which is "herdr has no pane
   * for this task at all" and points at the recovery plan instead.
   */
  paneFocusLost: {
    zh: '这个面板没接住键盘 —— 可能已释放，点面板标题栏的插头重新接管。',
    en: 'That pane did not take the keyboard. It may be released - re-attach it with the plug in its header.'
  },
  paneSearchOpen: { zh: '搜索输出', en: 'Search output' },
  paneSearchPlaceholder: { zh: '在输出里查找…', en: 'Find in output…' },
  paneSearchPrev: { zh: '上一处', en: 'Previous match' },
  paneSearchNext: { zh: '下一处', en: 'Next match' },
  paneSearchClose: { zh: '关闭搜索', en: 'Close search' },
  paneSearchRegex: { zh: '正则表达式', en: 'Regular expression' },
  paneSearchCase: { zh: '区分大小写', en: 'Match case' },
  paneSearchNone: { zh: '无匹配', en: 'No results' },
  /** Past the addon's highlight limit only the total is known, so there is no "i". */
  paneSearchCount: { zh: '{n} 处', en: '{n} found' },
  paneSearchPosition: { zh: '{i} / {n}', en: '{i} of {n}' },
  /** The engine's own message is appended; it names the offending construct. */
  paneSearchBadPattern: { zh: '正则无效：{error}', en: 'Bad pattern: {error}' },
  paneSearchEmptyMatch: { zh: '这个正则会匹配空文本', en: 'That pattern matches empty text' },

  /* ---------------------------------------------------------- install */
  installTitle: { zh: 'herdr 没有运行', en: 'herdr is not running' },
  installBody: {
    zh: '工作台是 herdr 的驾驶舱：终端、工作区、断线恢复都由它持有。装上并启动 herdr 之后，这里会变成任务树。',
    en: 'The bench is a cockpit over herdr: it owns the terminals, the workspaces and the durability. Install it, start it, and this becomes your task tree.'
  },
  installHint: { zh: '安装：', en: 'Install:' },
  installRun: { zh: '启动会话：', en: 'Start a session:' },
  /**
   * A named session is invisible to discovery on purpose - the bench will not
   * attach itself to terminals nobody pointed it at - so the card has to say
   * how, or a running herdr looks exactly like a missing one.
   */
  installNamed: {
    zh: '命名会话（或写进配置 pro.herdrSession）：',
    en: 'Named session (or set pro.herdrSession):'
  },
  installError: { zh: '原因：{error}', en: 'Why: {error}' },
  installRetry: { zh: '重试', en: 'Retry' },
  proDisabledTitle: { zh: 'Pro 已关闭', en: 'Pro is switched off' },
  proDisabledBody: {
    zh: '配置里的 pro.enabled 是关的。打开它，工作台才会接管终端。',
    en: 'pro.enabled is off in your config. Turn it on and the bench will take over.'
  },
  proEnable: { zh: '打开 Pro', en: 'Enable Pro' },

  /* ---------------------------------------------------------- new task */
  newTaskTitle: { zh: '新建任务', en: 'New task' },
  fieldTitle: { zh: '标题', en: 'Title' },
  fieldGoal: { zh: '目标', en: 'Goal' },
  fieldWorkdir: { zh: '工作目录', en: 'Working directory' },
  fieldAgent: { zh: '代理', en: 'Agent' },
  fieldBranch: { zh: '分支', en: 'Branch' },
  fieldBase: { zh: '基线分支', en: 'Base branch' },
  fieldPrompt: { zh: '第一条提示词', en: 'First prompt' },
  titlePlaceholder: { zh: '修好登录超时', en: 'Fix the login timeout' },
  goalPlaceholder: { zh: '一句话说明这个任务要达成什么', en: 'One line on what done looks like' },
  promptPlaceholder: { zh: '可选：启动后立刻发给代理', en: 'Optional: sent to the agent on start' },
  browse: { zh: '浏览…', en: 'Browse…' },
  worktreeToggle: { zh: '新建 git worktree', en: 'New git worktree' },
  startToggle: { zh: '现在就启动代理', en: 'Start the agent now' },
  createTask: { zh: '创建任务', en: 'Create task' },
  workdirPlaceholder: { zh: '留空 = ~（主目录）', en: 'blank = ~ (home)' },

  /* ------------------------------------------------------ ssh + terminal */
  /**
   * Two topbar verbs and one palette. The wording keeps them apart on purpose:
   * `i` focuses a terminal that already exists, `t` opens a new shell, and `c`
   * connects to another machine - three things a user will conflate the moment
   * any two of them share a label.
   */
  sshConnect: { zh: '连接', en: 'Connect' },
  sshTerminal: { zh: '终端', en: 'Terminal' },
  // The key itself travels as a keycap in the tooltip (`kbd` on Tip), so the
  // label stays plain prose and `aria-keyshortcuts` carries the binding.
  sshConnectTitle: { zh: '连接机器', en: 'Connect to a machine' },
  sshTerminalTitle: {
    zh: '在选中任务的目录开一个 shell',
    en: 'Open a shell in the selected task directory'
  },
  sshTitle: { zh: '连接', en: 'Connect' },
  sshHint: {
    zh: '筛选已保存的机器和 ~/.ssh/config 里的别名，输入 user@host[:port]，或直接粘贴一整条 ssh 命令',
    en: 'Filter saved machines and ~/.ssh/config hosts, type user@host[:port], or paste a whole ssh command'
  },
  sshPlaceholder: { zh: 'user@host:port', en: 'user@host:port' },
  sshLoading: { zh: '正在读取机器列表…', en: 'Reading machines…' },
  sshEmpty: {
    zh: '没有已保存的机器，~/.ssh/config 里也没有可用的 Host。',
    en: 'No saved machines, and no usable Host in ~/.ssh/config.'
  },
  sshSourceSaved: { zh: '已保存', en: 'saved' },
  sshSourceConfig: { zh: 'config', en: 'config' },
  sshSourceHerdr: { zh: 'herdr', en: 'herdr' },
  /* The row built from whatever is in the input, when it names a box the roster
     does not already have. Labelled rather than left bare: connecting to a
     machine nobody has vetted should look different from connecting to one
     that was saved on purpose. */
  sshSourceTyped: { zh: '手输', en: 'typed' },
  /* A probe answers one question - "can I get in without typing a password?" -
     so every status is phrased as that answer rather than as an exit code. */
  sshProbeUnknown: { zh: '未测试', en: 'untested' },
  sshProbeOk: { zh: '可免密登录', en: 'passwordless' },
  /* The second green. Reachable, and worth the same colour, but a different
     fact: a key would need nothing from anybody, while this one is answered by
     a password we keep - and is therefore one `ssh-copy-id` from never being
     asked again. */
  sshProbePassword: { zh: '密码可登录', en: 'password works' },
  sshProbeAuth: { zh: '需要密码', en: 'needs a password' },
  sshProbeHostKey: { zh: '主机密钥未确认', en: 'host key not trusted' },
  sshProbeTimeout: { zh: '连接超时', en: 'timed out' },
  sshProbeUnreachable: { zh: '连不上', en: 'unreachable' },
  sshProbeNoSsh: { zh: '本机没有 ssh 命令', en: 'no ssh on this machine' },
  sshProbeError: { zh: '探测失败', en: 'probe failed' },
  sshProbeBusy: { zh: '测试中…', en: 'testing…' },
  sshTypedRow: { zh: '连接到 {target}', en: 'Connect to {target}' },
  sshTerminalRow: { zh: '本地终端', en: 'Local terminal' },
  sshTerminalHint: { zh: '在 {cwd} 开一个 shell', en: 'Open a shell in {cwd}' },
  sshHome: { zh: '主目录', en: 'home' },
  sshPin: { zh: '固定', en: 'Pin' },
  sshUnpin: { zh: '取消固定', en: 'Unpin' },
  sshPinned: { zh: '已固定 {label}', en: 'Pinned {label}' },
  sshUnpinned: { zh: '已取消固定 {label}', en: 'Unpinned {label}' },
  sshTest: { zh: '测试', en: 'Test' },
  /* ------------------------------------------------- edit + dismiss a row

     Two verbs, and the wording never blurs which is which. `edit` on a row we
     own rewrites our record; on a row that came from `~/.ssh/config` it forks
     one, because that file is read and never written. `dismiss` deletes a
     record of ours and hides a row somebody else reported - the same button,
     and the two toasts say which one happened. */
  sshEdit: { zh: '编辑', en: 'Edit' },
  sshEditTitle: { zh: '编辑机器', en: 'Edit machine' },
  sshEditNewTitle: { zh: '存为我的机器', en: 'Save as my machine' },
  sshEditHint: {
    zh: '改名字，或改 ssh 实际拨号的参数',
    en: 'Rename it, or change what ssh actually dials'
  },
  sshEditConfigHint: {
    zh: '这一行来自 ~/.ssh/config。CodeWaifu 不改你的配置文件：保存后会另存为自己的记录，并把原来那一行隐藏。',
    en: 'This row comes from ~/.ssh/config. CodeWaifu never rewrites your config: saving stores its own record and hides the original row.'
  },
  sshEditAliasHint: {
    zh: '改任何连接参数都会脱离 {alias} 这个别名，之后由 CodeWaifu 自己记住 host/端口/密钥。',
    en: 'Changing any connection field detaches the {alias} alias; CodeWaifu then remembers the host, port and key itself.'
  },
  sshFieldLabel: { zh: '名称', en: 'Name' },
  sshFieldHost: { zh: '主机', en: 'Host' },
  sshFieldPort: { zh: '端口', en: 'Port' },
  sshFieldUser: { zh: '用户', en: 'User' },
  sshFieldKey: { zh: '私钥', en: 'Identity file' },
  sshFieldJump: { zh: '跳板机', en: 'ProxyJump' },
  sshFieldAlias: { zh: 'config 别名', en: 'config alias' },
  sshPortDefault: { zh: '留空 = 22', en: 'blank = 22' },
  sshKeyNone: { zh: '不指定（用默认密钥）', en: 'none (use the default key)' },
  sshFieldPassword: { zh: '密码', en: 'Password' },
  /* ------------------------------------------------- a saved password

     The one secret this app keeps, and the wording is careful about what it
     promises. The keychain belongs to the OS, the field is never prefilled
     (main does not hand the plaintext to a renderer), and blank means "leave
     it alone" rather than "delete it" - deleting is its own button, so saving
     a half-filled form cannot quietly cost somebody a login. */
  sshPasswordPlaceholder: { zh: '留空 = 不改动', en: 'blank = unchanged' },
  sshPasswordPlaceholderNew: { zh: '可选，存进钥匙串', en: 'optional, kept in the keychain' },
  sshPasswordHint: {
    zh: '存进系统钥匙串，连接时自动应答密码提示；配好免密之后就可以清掉。',
    en: 'Kept in your OS keychain and typed for you when ssh asks; clear it once passwordless setup works.'
  },
  sshPasswordKept: { zh: '已存密码，留空则保持不变', en: 'A password is saved; leave blank to keep it' },
  sshPasswordReplace: { zh: '保存后替换已存的密码', en: 'Replaces the saved password' },
  sshPasswordWillClear: { zh: '保存后从钥匙串移除', en: 'Removed from the keychain on save' },
  sshPasswordReveal: { zh: '显示密码', en: 'Show password' },
  sshPasswordHide: { zh: '隐藏密码', en: 'Hide password' },
  sshPasswordClear: { zh: '移除已存密码', en: 'Remove the saved password' },
  sshPasswordKeep: { zh: '保留已存密码', en: 'Keep the saved password' },
  sshHasPassword: { zh: '已存密码', en: 'password saved' },
  sshPasswordStored: { zh: '密码已存进钥匙串', en: 'Password saved to the keychain' },
  sshPasswordCleared: { zh: '已从钥匙串移除密码', en: 'Password removed from the keychain' },
  sshPasswordFailed: { zh: '密码没能存进钥匙串', en: 'The password could not be saved to the keychain' },
  sshNoKeychain: {
    zh: '这台机器没有可用的系统钥匙串，密码无法保存——我们不会把它明文写到磁盘上。',
    en: 'This machine has no usable keychain, so a password cannot be saved - it will not be written to disk in plaintext.'
  },
  sshEditSave: { zh: '保存', en: 'Save' },
  sshEditNeedsHost: { zh: '主机不能为空', en: 'A host is required' },
  sshEditBadPort: {
    zh: '端口要在 1-65535 之间，或留空表示 22',
    en: 'Port must be between 1 and 65535, or blank for 22'
  },
  sshEdited: { zh: '已更新 {label}', en: 'Updated {label}' },
  sshForked: { zh: '已另存为 {label}，~/.ssh/config 原样未动', en: 'Saved as {label}; ~/.ssh/config untouched' },
  sshDismiss: { zh: '删除', en: 'Delete' },
  sshDismissHint: { zh: '从列表里删掉这条已保存的机器', en: 'Delete this saved machine from the list' },
  sshHide: { zh: '隐藏', en: 'Hide' },
  sshHideHint: {
    zh: '不再显示这一行（它来自 config/herdr，隐藏不会改动任何文件），可在「已隐藏」里恢复',
    en: 'Stop showing this row (it comes from config/herdr; hiding touches no files). Restore it under "Hidden".'
  },
  sshRemoved: { zh: '已删除 {label}', en: 'Deleted {label}' },
  sshHiddenRow: { zh: '已隐藏 {label}，可在「已隐藏」里恢复', en: 'Hid {label}; restore it under "Hidden"' },
  sshHidden: { zh: '已隐藏 {n}', en: 'Hidden {n}' },
  sshHiddenTitle: { zh: '已隐藏的机器', en: 'Hidden machines' },
  sshHiddenHint: {
    zh: '这些行是 ~/.ssh/config 或 herdr 报上来的，隐藏只影响这个列表，你的文件一个字都没动。',
    en: 'These rows were reported by ~/.ssh/config or herdr. Hiding only affects this list; your files are untouched.'
  },
  sshHiddenEmpty: { zh: '没有隐藏的机器', en: 'Nothing hidden' },
  sshHiddenPlaceholder: { zh: '筛选已隐藏的机器', en: 'Filter hidden machines' },
  /* An identity no source reports any more (the Host block was deleted, herdr
     stopped knowing the box). Restoring it drops the entry instead of bringing
     a row back, and this pill is what keeps that from reading as a dead click. */
  sshHiddenStale: { zh: '来源已消失', en: 'source gone' },
  sshRestore: { zh: '恢复', en: 'Restore' },
  sshRestoreHint: { zh: '让这一行重新出现在连接列表里', en: 'Show this row in the connect list again' },
  sshRestored: { zh: '已恢复 {label}', en: 'Restored {label}' },
  sshOpenConfig: { zh: '打开 ~/.ssh/config', en: 'Open ~/.ssh/config' },
  sshBack: { zh: '返回连接列表', en: 'Back to the connect list' },
  sshSetupKey: { zh: '配置免密', en: 'Passwordless' },
  sshSetupHint: {
    zh: '在终端里运行 ssh-copy-id，你需要输入一次远端密码',
    en: 'Runs ssh-copy-id in a terminal; you type the remote password once'
  },
  sshSetupStarted: {
    zh: '免密配置已在终端里开始，请按提示输入密码',
    en: 'Passwordless setup is running in the terminal; answer the password prompt'
  },
  sshConnected: { zh: '已连接 {label}', en: 'Connected to {label}' },
  sshTerminalOpened: { zh: '已打开终端', en: 'Terminal opened' },
  sshSendFailed: {
    zh: '窗格已打开，但连接命令没能输进去',
    en: 'The pane opened, but the connect line did not reach it'
  },
  sshNoTarget: { zh: '没有可连接的目标', en: 'Nothing to connect to' },
  /** The honest reason a terminal cannot open: herdr owns every PTY we show. */
  sshNeedHerdr: { zh: '终端需要 herdr 在运行', en: 'Terminals need herdr running' },
  sshKeysHint: {
    /* Alt (⌥ on mac) rather than bare letters: the input is a text field, so an
       unmodified `s` has to keep typing the hostname you are filtering on. */
    zh: '↑/↓ 选择 · Enter 连接 · Alt/⌥+P 测试 · +E 编辑 · +D 删除/隐藏 · +S 固定 · +K 免密',
    en: '↑/↓ select · Enter connect · Alt/⌥+P test · +E edit · +D delete/hide · +S pin · +K passwordless'
  },
  sshEditKeysHint: {
    zh: 'Tab 换字段 · Enter 保存 · Esc 取消',
    en: 'Tab to move · Enter to save · Esc to cancel'
  },
  sshHiddenKeysHint: {
    zh: '↑/↓ 选择 · Enter 恢复 · Esc 返回',
    en: '↑/↓ select · Enter restore · Esc back'
  },

  /* ---------------------------------------------------------- time */
  timeNow: { zh: '刚刚', en: 'just now' },
  timeSeconds: { zh: '{n} 秒', en: '{n}s' },
  timeMinutes: { zh: '{n} 分钟', en: '{n}m' },
  timeHours: { zh: '{n} 小时', en: '{n}h' },
  timeDays: { zh: '{n} 天', en: '{n}d' },
  timeAgo: { zh: '{t}前', en: '{t} ago' },
  never: { zh: '—', en: '—' },
  zoomResetHint: { zh: 'Ctrl+0 恢复默认', en: 'Ctrl+0 to reset' }
} as const

export type StringKey = keyof typeof STRINGS

export type Translate = (key: StringKey) => string

export function makeTranslator(lang: Lang): Translate {
  return (key: StringKey) => STRINGS[key][lang]
}

/** `{name}` interpolation. Unknown placeholders are left alone, not blanked. */
export function fill(t: Translate, key: StringKey, vars: Record<string, string | number>): string {
  let out = t(key)
  for (const [name, value] of Object.entries(vars)) {
    out = out.split(`{${name}}`).join(String(value))
  }
  return out
}

/**
 * A bridge's error line, in words worth putting on screen.
 *
 * main forwards whatever the child process said, and for a failed spawn that is
 * Node's own `spawn /path/herdr ENOENT`. The pane overlay is the only place a
 * user reads it, so a known failure becomes the fix it implies and anything
 * unrecognised is passed through byte for byte: a message we cannot classify is
 * still evidence, and a confident guess sends the user after the wrong problem.
 */
export function bridgeErrorText(t: Translate, error: string): string {
  const text = String(error || '')
  const failure = spawnFailure(text)
  if (!failure.reason || !failure.binary) return text
  if (failure.reason === 'no-binary') return fill(t, 'paneErrNoBinary', { path: failure.binary })
  return fill(t, 'paneErrNotExecutable', { path: failure.binary })
}
