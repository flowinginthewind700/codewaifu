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
  steerPlaceholder: { zh: '给这个线程插一句话…（Enter 发送，Shift+Enter 换行）', en: 'Send a message to this thread… (Enter to send, Shift+Enter for a newline)' },
  steerSend: { zh: '发送', en: 'Send' },
  steerPickFirst: { zh: '先选一个线程', en: 'Select a thread first' },
  steerUnsupported: { zh: '这个 agent 不支持直接插话，内容会复制到剪贴板', en: 'This agent has no injection API; the text will be copied to your clipboard' },
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
  secRelay: { zh: '本地中继', en: 'Local relay' },
  secHooks: { zh: 'Agent 接入', en: 'Agent hooks' },
  secAbout: { zh: '关于', en: 'About' },

  enabled: { zh: '启用伴侣', en: 'Companion enabled' },
  speak: { zh: '语音播报', en: 'Speak announcements' },
  popOnSessionStart: { zh: '新会话时弹出面板', en: 'Pop panel on session start' },
  alwaysOnTop: { zh: '总在最前', en: 'Always on top' },
  lang: { zh: '界面语言', en: 'UI language' },
  langAuto: { zh: '跟随内容', en: 'Match content' },
  voiceZh: { zh: '中文音色', en: 'Chinese voice' },
  voiceEn: { zh: '英文音色', en: 'English voice' },
  voiceAuto: { zh: '系统默认', en: 'System default' },
  rate: { zh: '语速', en: 'Rate' },
  testVoice: { zh: '试听', en: 'Test' },
  opacity: { zh: '不透明度', en: 'Opacity' },
  scale: { zh: '大小', en: 'Size' },
  bubbleMs: { zh: '气泡停留', en: 'Bubble time' },
  avatar: { zh: '形象', en: 'Avatar' },
  avatarBuiltin: { zh: '内置', en: 'Built-in' },
  avatarImage: { zh: '图片', en: 'Image' },
  chooseImage: { zh: '选择图片…', en: 'Choose image…' },
  autoInstallHooks: { zh: '启动时自动写入 hooks', en: 'Install hooks on launch' },

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
  seconds: { zh: '秒', en: 's' },
  version: { zh: '版本', en: 'Version' }
} as const

export type StringKey = keyof typeof STRINGS

export type Translate = (key: StringKey) => string

export function makeTranslator(lang: Lang): Translate {
  return (key: StringKey) => STRINGS[key][lang]
}
