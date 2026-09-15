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

const STRINGS = {
  /* ---------------------------------------------------------- shell */
  brandName: { zh: 'CodeWaifu Pro', en: 'CodeWaifu Pro' },
  brandSub: { zh: '工作台', en: 'Bench' },
  booting: { zh: '正在启动工作台…', en: 'Starting the bench…' },
  keyHints: {
    zh: 'j/k 移动 · Enter 打开 · i 进终端 · 空格 筛选 · a/d/s 决策 · 1/2/3 切换',
    en: 'j/k move · Enter open · i terminal · Space filter · a/d/s decide · 1/2/3 tabs'
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

  /* ---------------------------------------------------------- tree */
  treeTitle: { zh: '任务', en: 'Tasks' },
  needsMeOnly: { zh: '只看待处理', en: 'Needs me only' },
  treeEmpty: {
    zh: '还没有任务。点「新建任务」开一个，或「接管现有工作区」把 herdr 里已有的会话收进来。',
    en: 'No tasks yet. Create one, or adopt whatever herdr already has running.'
  },
  treeEmptyFiltered: { zh: '没有任务需要你处理。', en: 'Nothing needs you right now.' },
  treeFoot: { zh: '{shown} / {total} 个任务', en: '{shown} of {total} tasks' },
  unfiled: { zh: '未归档', en: 'Unfiled' },
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
    zh: '只会从工作台移除记录，herdr 里的面板和进程不受影响。',
    en: 'This only drops it from the bench. The pane and its process in herdr keep running.'
  },
  confirmRemove: { zh: '移除', en: 'Remove' },
  confirmCancel: { zh: '取消', en: 'Cancel' },

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
  phaseIdle: { zh: '未接管', en: 'Idle' },
  phaseStarting: { zh: '正在接管…', en: 'Attaching…' },
  phaseLive: { zh: '实时', en: 'Live' },
  phaseRespawning: { zh: '重连中…', en: 'Reconnecting…' },
  phaseClosed: { zh: '已关闭', en: 'Closed' },
  phaseError: { zh: '桥接错误', en: 'Bridge error' },
  droppedFrames: { zh: '丢了 {n} 帧', en: '{n} frames dropped' },
  paneBell: { zh: '终端响铃', en: 'Terminal bell' },
  paneCopyFailed: { zh: '复制失败', en: 'Copy failed' },
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
  needWorkdir: { zh: '先选一个工作目录。', en: 'Pick a working directory first.' },

  /* ---------------------------------------------------------- time */
  timeNow: { zh: '刚刚', en: 'just now' },
  timeSeconds: { zh: '{n} 秒', en: '{n}s' },
  timeMinutes: { zh: '{n} 分钟', en: '{n}m' },
  timeHours: { zh: '{n} 小时', en: '{n}h' },
  timeDays: { zh: '{n} 天', en: '{n}d' },
  timeAgo: { zh: '{t}前', en: '{t} ago' },
  never: { zh: '—', en: '—' }
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
