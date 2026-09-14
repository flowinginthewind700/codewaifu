import type { Lang } from '@shared/protocol'

/**
 * Panel copy. Kept next to the renderer (not in `shared/phrases.ts`, which is
 * spoken copy) because these strings are read, not said out loud.
 */
const STRINGS = {
  tabThreads: { zh: '会话', en: 'Threads' },
  tabLog: { zh: '事件', en: 'Log' },
  tabSettings: { zh: '设置', en: 'Settings' },
  expand: { zh: '展开面板', en: 'Expand panel' },
  collapse: { zh: '收起面板', en: 'Collapse panel' },
  mute: { zh: '静音', en: 'Mute voice' },
  unmute: { zh: '取消静音', en: 'Unmute voice' },
  hide: { zh: '隐藏', en: 'Hide' },
  quit: { zh: '退出', en: 'Quit' },
  dragHint: { zh: '拖我移动位置', en: 'Drag me to move' },

  threadsEmpty: {
    zh: '还没有会话。启动 Codex 或 Claude Code 后，这里会列出每个线程。',
    en: 'No threads yet. Start Codex or Claude Code and every session shows up here.'
  },
  threadsFilter: { zh: '搜索会话…', en: 'Search threads…' },
  threadsLiveOnly: { zh: '只看运行中的会话', en: 'Running threads only' },
  threadsNoMatch: { zh: '没有匹配的会话。', en: 'No thread matches that filter.' },
  threadsHint: {
    zh: '点开一条会话可以读完整对话，也能直接插话。按 / 搜索。',
    en: 'Open a thread to read the whole conversation and steer it. Press / to search.'
  },
  groupLive: { zh: '运行中', en: 'Running' },
  groupToday: { zh: '今天', en: 'Today' },
  groupWeek: { zh: '本周', en: 'This week' },
  groupOlder: { zh: '更早', en: 'Earlier' },

  chatBack: { zh: '返回会话列表', en: 'Back to threads' },
  chatReadAloud: { zh: '朗读这段', en: 'Read aloud' },
  chatReveal: { zh: '打开记录文件', en: 'Reveal transcript file' },
  chatRefresh: { zh: '刷新', en: 'Refresh' },
  chatLoading: { zh: '正在读取对话…', en: 'Reading the conversation…' },
  chatMissing: {
    zh: '找不到这个会话的记录文件，可能已经被清理了。',
    en: 'The transcript file for this thread is gone — it may have been cleaned up.'
  },
  chatEmpty: { zh: '这个会话还没有对话内容。', en: 'Nothing in this conversation yet.' },
  chatLoadOlder: { zh: '加载更早的 {n} 条', en: 'Load {n} older' },
  chatNewMessages: { zh: '{n} 条新消息', en: '{n} new' },
  chatToBottom: { zh: '回到最新', en: 'Latest' },
  chatThinking: { zh: '思考过程', en: 'Thinking' },
  chatSubagentThinking: { zh: '子代理思考', en: 'Subagent thinking' },
  chatTruncated: { zh: '太长，已截断', en: 'truncated' },
  chatMore: { zh: '展开全文', en: 'Show more' },
  copy: { zh: '复制', en: 'Copy' },
  copied: { zh: '已复制', en: 'Copied' },
  steerClipboardPlaceholder: {
    zh: 'Claude Code 没有插话接口，写好的内容会复制到剪贴板…',
    en: 'Claude Code has no injection API — your text is copied to the clipboard…'
  },
  steerPlaceholder: { zh: '给这个线程插一句话…（Enter 发送，Shift+Enter 换行）', en: 'Send a message to this thread… (Enter to send, Shift+Enter for a newline)' },
  steerSend: { zh: '发送', en: 'Send' },
  steerPickFirst: { zh: '先选一个线程', en: 'Select a thread first' },
  steerUnsupported: { zh: '这个 agent 不支持直接插话，内容会复制到剪贴板', en: 'This agent has no injection API; the text will be copied to your clipboard' },
  // Outcomes of a steer. `codex queue` exits 0 even when the session never
  // reads the queue, so the three Codex cases are told apart for the user.
  steerSent: { zh: '已送达 Codex 会话 {id}', en: 'Delivered to Codex thread {id}' },
  steerQueued: {
    zh: '会话 {id} 空闲：已排入 Codex 队列，但没人确认它会读取；已复制到剪贴板，粘贴最稳妥',
    en: 'Thread {id} is idle: queued for Codex, but nothing confirms it will be read — also copied to your clipboard'
  },
  steerUndelivered: {
    zh: '会话 {id} 正在工作，不会读取队列消息；已复制到剪贴板，到那个终端粘贴即可',
    en: 'Thread {id} is working and does not read the queue; the text is on your clipboard — paste it into that terminal'
  },
  steerNoCli: { zh: '找不到 codex CLI，内容已复制到剪贴板', en: 'Could not find the codex CLI; the text is on your clipboard' },
  steerFailed: { zh: '插话失败，内容已复制到剪贴板', en: 'Steering failed; the text is on your clipboard' },
  steerClaudeClipboard: {
    zh: 'Claude Code 不支持外部插话，内容已复制到剪贴板，粘贴即可',
    en: 'Claude Code cannot be injected from outside; the text is on your clipboard — paste it in'
  },
  live: { zh: '实时', en: 'live' },
  updated: { zh: '更新', en: 'updated' },
  justNow: { zh: '刚刚', en: 'just now' },
  minutesAgo: { zh: '分钟前', en: 'min ago' },
  hoursAgo: { zh: '小时前', en: 'h ago' },

  logEmpty: { zh: '还没有事件。', en: 'No events yet.' },
  clear: { zh: '清空', en: 'Clear' },

  secVoice: { zh: '语音', en: 'Voice' },
  secEvents: { zh: '播报事件', en: 'Announce' },
  secLook: { zh: '外观', en: 'Appearance' },
  secWindow: { zh: '窗口与快捷键', en: 'Window & hotkey' },
  hotkey: { zh: '全局快捷键', en: 'Global hotkey' },
  hotkeyHint: {
    zh: '在任意应用间召唤或收起伴侣。输入框有内容且聚焦时快捷键不会触发,免得打断正在写的句子。点击按钮后按下新组合键,Esc 取消。',
    en: 'Summon or hide the companion from any app. It stays idle while a non-empty input here holds focus, so it never yanks the window away mid-sentence. Click, press a new combo, Esc cancels.'
  },
  hotkeyRecord: { zh: '按下新快捷键…', en: 'Press new keys…' },
  hotkeyInvalid: {
    zh: '需要至少一个修饰键 + 字母 / 数字 / F 键',
    en: 'Needs a modifier plus a letter, digit or F-key'
  },
  secRelay: { zh: '本地中继', en: 'Local relay' },
  secHooks: { zh: 'Agent 接入', en: 'Agent hooks' },
  secAbout: { zh: '关于', en: 'About' },

  enabled: { zh: '启用伴侣', en: 'Companion enabled' },
  speak: { zh: '语音播报', en: 'Speak announcements' },
  popOnSessionStart: { zh: '新会话时弹出面板', en: 'Pop panel on session start' },
  alwaysOnTop: { zh: '总在最前', en: 'Always on top' },
  lang: { zh: '播报语言', en: 'Spoken language' },
  langAuto: { zh: '跟随内容', en: 'Match content' },
  voiceEngine: { zh: '语音引擎', en: 'Voice engine' },
  engineMatcha: { zh: '神经语音', en: 'Neural' },
  engineSystem: { zh: '系统语音', en: 'System' },
  engineMatchaHint: {
    zh: '本地 Matcha-TTS，中英混读是一句连贯的人声，首次需下载约 134MB 模型',
    en: 'Local Matcha-TTS: mixed zh/en reads as one human voice. One-time ~134MB model download.'
  },
  engineSystemHint: {
    zh: '系统自带语音，无需下载；中英混读会切成两个音色',
    en: 'Built-in OS voices, nothing to download; mixed zh/en switches between two voices.'
  },
  autoDownload: { zh: '自动下载模型', en: 'Download model automatically' },
  neuralModel: { zh: '模型', en: 'Model' },
  neuralReady: { zh: '已就绪', en: 'ready' },
  neuralDownloading: { zh: '下载中', en: 'downloading' },
  neuralExtracting: { zh: '解压中', en: 'extracting' },
  neuralLoading: { zh: '加载引擎', en: 'loading engine' },
  neuralMissing: { zh: '模型未下载', en: 'model not downloaded' },
  neuralUnavailable: { zh: '本机不支持神经语音', en: 'neural voice unavailable here' },
  neuralError: { zh: '下载失败', en: 'download failed' },
  neuralRetry: { zh: '重试下载', en: 'Retry download' },
  neuralDownload: { zh: '立即下载', en: 'Download now' },
  neuralColdLoad: { zh: '冷启动 {ms} ms', en: 'cold load {ms} ms' },
  voiceZh: { zh: '中文音色', en: 'Chinese voice' },
  voiceEn: { zh: '英文音色', en: 'English voice' },
  voiceAuto: { zh: '系统默认', en: 'System default' },
  rate: { zh: '语速', en: 'Rate' },
  testVoice: { zh: '试听', en: 'Test' },
  uiLang: { zh: '界面语言', en: 'Interface language' },
  uiLangAuto: { zh: '跟随系统', en: 'Follow the system' },
  uiLangHint: {
    zh: '跟随系统时按 macOS / Windows 的首选语言显示，目前只区分中英文',
    en: 'Following the system reads the OS preferred language; only Chinese and English are distinguished'
  },
  surface: { zh: '背景材质', en: 'Surface' },
  surfaceGlass: { zh: '液态玻璃', en: 'Liquid glass' },
  surfaceSolid: { zh: '不透明', en: 'Opaque' },
  surfaceHint: {
    zh: '液态玻璃能透出桌面，毛玻璃模糊保证文字仍然可读；不透明适合花哨壁纸和录屏分享',
    en: 'Liquid glass lets the desktop show through a heavy blur; opaque is for busy wallpapers and screen sharing'
  },
  clearStage: { zh: '人物区域完全透明', en: 'Clear area behind her' },
  clearStageHint: {
    zh: '收起时她直接站在桌面上，身后没有卡片；只有她和状态胶囊会挡住鼠标，其余区域的点击会落到下层窗口',
    en: 'While collapsed she stands straight on the desktop with no sheet behind her; only she and the status pill catch the mouse, clicks elsewhere fall through to the window below'
  },
  opacity: { zh: '不透明度', en: 'Opacity' },
  scale: { zh: '大小', en: 'Size' },
  bubbleMs: { zh: '气泡停留', en: 'Bubble time' },
  avatar: { zh: '形象', en: 'Avatar' },
  avatarBuiltin: { zh: '内置', en: 'Built-in' },
  avatarImage: { zh: '图片', en: 'Image' },
  avatarLive2d: { zh: '数字人', en: 'Live2D' },
  character: { zh: '角色', en: 'Character' },
  live2dHint: {
    zh: '拖她可以移动窗口，点头换表情，点身体触发动作',
    en: 'Drag her to move the window; tap the head for expressions, the body for motions'
  },
  chooseImage: { zh: '选择图片…', en: 'Choose image…' },
  autoInstallHooks: { zh: '启动时自动写入 hooks', en: 'Install hooks on launch' },

  l2dPreparing: { zh: '正在准备数字人', en: 'Preparing avatar' },
  l2dCached: { zh: '已读本地缓存', en: 'Loaded from cache' },
  l2dFirstRun: {
    zh: '首次下载约 {mb} MB，之后走本地缓存',
    en: 'First run downloads ~{mb} MB, then it stays cached'
  },
  l2dFailed: { zh: '数字人没能启动', en: 'The avatar could not start' },
  l2dRetry: { zh: '重试', en: 'Retry' },

  evSessionStart: { zh: '会话开始（含问候）', en: 'Session start (greeting)' },
  evStop: { zh: 'Agent 完成', en: 'Agent finished' },
  evPermission: { zh: '权限请求', en: 'Permission requests' },
  evNotification: { zh: '通知', en: 'Notifications' },
  evTool: { zh: '工具调用', en: 'Tool calls' },
  evCompact: { zh: '上下文压缩', en: 'Context compaction' },
  evSubagent: { zh: '子代理', en: 'Subagents' },
  evPrompt: { zh: '我发出的提示', en: 'My prompts' },

  relayPort: { zh: '端口', en: 'Port' },
  relayAuto: { zh: '自动', en: 'Auto' },
  pinPort: { zh: '固定端口', en: 'Pin port' },
  relayState: { zh: '当前', en: 'Now' },
  relayConflict: { zh: '端口冲突', en: 'Port conflict' },
  relayDuplicate: { zh: '已有实例', en: 'Another instance' },
  endpointFile: { zh: 'endpoint.env', en: 'endpoint.env' },
  openFolder: { zh: '打开目录', en: 'Open folder' },
  hooksRepair: { zh: '重新写入 hooks', en: 'Repair hooks' },
  hooksRemove: { zh: '移除 hooks', en: 'Remove hooks' },
  hooksCodex: { zh: 'Codex', en: 'Codex' },
  hooksClaude: { zh: 'Claude Code', en: 'Claude Code' },
  installed: { zh: '已接入', en: 'installed' },
  notInstalled: { zh: '未接入', en: 'not installed' },
  notFound: { zh: '未检测到', en: 'not detected' },
  trustNeeded: {
    zh: 'Codex 需要你手动信任一次：打开 Codex，输入 /hooks，选择信任 CodeWaifu 条目。',
    en: 'Codex gates third-party hooks: open Codex, run /hooks once, and trust the CodeWaifu entries.'
  },
  mediaUnavailable: { zh: '没有检测到正在播放的应用', en: 'No controllable player found' },
  report: { zh: '汇报当前状态', en: 'Report status' },
  reportAria: { zh: '汇报当前 coding 状态', en: 'Read out the current coding status' },
  expression: { zh: '表情', en: 'Expression' },
  expressionRandom: { zh: '随机', en: 'Random' },
  motion: { zh: '动作', en: 'Motion' },
  motionRandom: { zh: '随机', en: 'Random' },
  seconds: { zh: '秒', en: 's' },
  version: { zh: '版本', en: 'Version' }
} as const

export type StringKey = keyof typeof STRINGS

export type Translate = (key: StringKey) => string

export function makeTranslator(lang: Lang): Translate {
  return (key: StringKey) => STRINGS[key][lang]
}
