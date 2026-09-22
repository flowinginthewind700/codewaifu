# CodeWaifu

[产品落地页](https://robotworld.top/zh/codewaifu) · [English](README.md) · [发行版](https://github.com/flowinginthewind700/codewaifu/releases) · [MIT](LICENSE)

**住在编码 agent 旁边的桌面伙伴。** CodeWaifu 以一个小巧、可拖拽、始终置顶的
角色停在菜单栏里。它通过 hook 与插件机制监听 Codex、Claude Code、Cursor、
Gemini CLI、Antigravity、Kimi CLI、ZCode、OpenCode、Kiro、Pi 与 Trae,把每一个
需要你出面的事件说出来,维护一块实时线程看板,让你不离开键盘就能指挥它们,
顺手还能控制你的音乐播放器。

![CodeWaifu 桌面伙伴](docs/assets/companion.png)

## 为什么做这个

长时间的 agent 任务是沉默的:build 跑完了、权限请求在等你、线程空闲了——
你往往二十分钟后偶然瞥一眼才知道。CodeWaifu 把这些时刻变成一句话和一眼:
一句中文或英文的语音、角色头顶的气泡,以及一块写着每个 agent 此刻在干什么
的线程看板。

## 功能

- **替 agent 说话。** 十一种 agent 的 hook 事件(会话开始、结束、
  权限请求、通知、工具调用、上下文压缩、子代理、中断)都会变成一句简短语音,
  走系统 TTS;每类事件可单独开关,短语池保证同一件事不会两次说的一模一样。
  每种 agent 只注册它真正会发出的事件——名字不靠编,没装的 agent 一个字节的
  配置文件都不会写。

  | Agent | Hooks | 写入的文件 | 历史回放 + 插话 |
  |-------|-------|------------|------------------|
  | Codex | 支持 | `~/.codex/hooks.json` | 支持 |
  | Claude Code | 支持 | `~/.claude/settings.json` | 支持 |
  | Cursor Agent | 支持 | `~/.cursor/hooks.json` | 不支持 |
  | Gemini CLI | 支持 | `~/.gemini/settings.json` | 不支持 |
  | Antigravity | 支持 | `~/.gemini/config/hooks.json` | 不支持 |
  | Kimi CLI | 支持 | `~/.kimi-code/config.toml` | 不支持 |
  | ZCode | 支持 | `~/.zcode/cli/config.json` | 只读 |
  | Kiro | 支持 | `~/.kiro/hooks/codewaifu.json` | 不支持 |
  | Trae | 支持 | `~/.trae/hooks.json` | 不支持 |
  | OpenCode | 插件 | `~/.config/opencode/plugins/codewaifu-agent-state.js` | 不支持 |
  | Pi | 插件 | `~/.pi/agent/extensions/codewaifu-agent-state.ts` | 不支持 |

  最后一列是诚实的边界,它分成两半。读得开要有一份找得到也解得开的历史:
  Codex 与 Claude Code 写 JSONL,ZCode 把整段历史放在一个 SQLite 文件里
  (`~/.zcode/cli/db/db.sqlite`),这三家的历史面板打得开。插得进去则要有一条
  注入通道,而只有 Codex 有——它接受排队消息,所以那是唯一一条能直接打字的线程。
  Claude Code 与 ZCode 上,同一个输入框回落到剪贴板:文字帮你复制好,粘贴由你来做。
  另外八家照样说话、弹气泡、进账本和工作台的树。

  OpenCode 与 Pi 根本没有 hook 配置:它们各自会加载自己 `plugins/` 或
  `extensions/` 目录下的每一个文件,所以我们写进去的是一个很小的中继,把同样的
  事件 POST 到同一个回环端口。它在结构上就是发完即走——handler 不等请求返回就
  自己回去了,所以 CodeWaifu 关着、卡住或正在重启,都不会让你的 agent 付出任何代价。

  Kiro 与 Trae 是另外两种 JSON 形状。Kiro 会加载 `~/.kiro/hooks/` 下的每一个文件,
  所以我们那份以我们自己命名,和你自己写的 hook 并排放着:一个扁平数组,每项写
  自己的 `trigger`,顶层带 `version: "v1"`。Trae 只有一个全局的
  `~/.trae/hooks.json`,形状与 Claude Code 的嵌套结构一致,顶层 `version` 是数字
  `1`,合并时你自己的条目会原样带过去。两家都不接受别家那套会话 matcher,所以
  文件里一个都不写——省略 matcher 就是永远匹配,而一个只负责上报的 hook 要的
  正是这个。
- **默认双语。** 每条消息自动判定语言(出现一个汉字就切中文语音),也可以在
  设置里固定中文或英文。
- **开机是问候,不是闪屏。** 启动时按时间段从短语池里随机挑一句跟你打招呼。
- **线程看板。** 列出所有 Codex 线程、Claude Code 会话与 ZCode 会话及实时状态;
  三家都能点开读历史,对运行中的 Codex 线程可以直接排队插话,对没有注入接口的
  agent 则把消息复制到剪贴板。
- **媒体控制。** 播放 / 暂停 / 下一曲 / 上一曲,作用于当前占用系统媒体会话的
  播放器(macOS 的 Music 与 Spotify,Windows 的系统媒体,Linux 通过 `playerctl`
  作用于任意 MPRIS 播放器),面板里同步显示曲目。
- **守规矩的窗口。** 任意拖拽、始终置顶、可开启点击穿透,透明度与缩放滑杆,
  收起是 320px 的小气泡,展开是带标签页的完整面板。
- **会答话的托盘。** 托盘菜单可以显示/收起舞台、打开工作台(菜单项上带着
  注意力计数)、静音、修复 agent hooks、退出。Linux 上左键点图标就是这份菜单
  ——这个平台的托盘不投递点击事件,菜单即全部交互;macOS 与 Windows 上左键
  召唤她,右键才是菜单。
- **只走回环。** relay 只绑 `127.0.0.1`,除 `/health` 外所有路由都要带本机安装时
  生成的 token,并校验 Host 头。无遥测、无外联、不需要 sudo。

## Pro:你的 agent 终端的驾驶舱

浮窗回答的是「现在哪个 agent 需要我」。工作台回答下一个问题:它们每一个此刻在
干什么——不用开十一个窗口。Pro 是盖在 [herdr](https://github.com/herdrdev/herdr)
上的第二扇窗:那个持有 PTY 的持久终端运行时。任务、工作区、面板都活得比 Bench
关窗、机器睡眠、应用崩溃更久。

![CodeWaifu Pro 工作台](docs/assets/bench.png)

- **一棵树,所有仓库。** herdr 的工作区与任务,按你扫视的顺序排:先是需要你的,
  然后是正在跑的、跑完的。
- **终端是租的,不是自己的。** 每个面板是一条活的
  `herdr terminal session control` 连接:Unicode 11 宽字符、WebGL 渲染与降级、
  OSC 8 链接走 scheme 白名单、OSC 52 剪贴板、带正则与大小写模式的输出内搜索。
  历史在 herdr 那侧,所以滚轮与 `Shift+PageUp/Down` 翻的是这个面板真正跑过的输出——
  包括 Bench 挂上来之前跑的那部分;面板头有一个 chip 可以一键回到实时末端,因为
  往回翻的面板是**冻住**的,它会一直显示那个其实早就跑完的构建。
  关掉 Bench 不会杀死任何东西。
- **注意力队列。** 权限请求与阻塞项汇到一个列表,可批准 / 拒绝 / 稍后提醒;
  浮窗气泡也能直接用文字回答。
- **账本与恢复计划。** 每个决策 append-only 落盘;agent 会话死掉的任务会拿到
  一条可以执行或重新提问的恢复提示。
- **键盘优先。** `j/k` 移动、`Enter` 打开、`i` 把键盘交给终端、`Shift+Tab` 交回、
  `a/d/s` 决策、`1/2/3` 切面板、`c` 连接、`t` 开一个本地 shell、
  `Shift+PageUp/Down` 翻面板历史。`F2` 重命名光标所在的任务——一个任务活得比它
  最初的目标久,树里写的应该是它**现在**在干什么。
- **可以照你的样子塑形的驾驶舱。** 左右两栏都能从顶栏收起,中缝可以拖着调宽度,
  调好的宽度下次启动还记得。`Ctrl`/`Cmd` `+`/`-` 走一条固定的缩放档位,两个窗口
  共用同一档,`Ctrl/Cmd+0` 回到 100%,而且每次都会把你现在在哪一档说出来——
  不小心按错了也知道怎么退回去。
- **默认自己画窗口边框。** Bench 自己画顶栏,而不是向窗口管理器要一条只写着窗口
  名字的边框:顶栏可拖动,八条边可缩放,右端是最小化与关闭。想要 WM 那套装饰的
  话,在设置里把 `pro.benchFrame` 打开(切换会重开 Bench 窗口)。

Pro 先做 Linux,需要 herdr 0.9+ 在跑;没有 herdr 时 Bench 显示安装引导卡片,
不会崩。点托盘图标弹出菜单选「打开工作台」(菜单项上带着注意力计数),或把
`~/.codewaifu/config.json` 里的 `pro.openBenchOnLaunch` 设为 `true` 让它随启动打开。

## 安装

一行命令,macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/scripts/install.sh | bash
```

一行命令,Windows(PowerShell):

```powershell
irm https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/scripts/install.ps1 | iex
```

安装器会下载最新发行版,把应用放进 `/Applications`(Windows 为
`%LOCALAPPDATA%\Programs\CodeWaifu`,Linux 为 `~/.local/share/CodeWaifu`),
带备份地注册 agent hook,并打印接下来要做的事。重复执行即修复安装,不会重复
写入;`bash install.sh --uninstall --purge` 可以完整卸载。

安装器顺路装上 herdr——工作台(Bench)驱动的那个终端运行时,除非应用会去找的
位置已经有二进制了。`--no-herdr` 跳过这一步,`--herdr-only` 只做这一步:应用
装好了但 Bench 还显示安装引导卡片时,用它。herdr 下载失败只警告不中断,伴侣
本身没有它也是完整的。卸载不动 herdr,因为它托管的终端比这个应用活得久。

### Linux

两种受支持的形态,按你要不要 Chromium 沙箱来选:

| | 命令 | 装在哪 | 沙箱 |
| --- | --- | --- | --- |
| 用户态安装 | 上面那行一行命令 | `~/.local/share/CodeWaifu`,启动器 `~/.local/bin/codewaifu`,桌面入口进 `~/.local/share/applications` | 在拒绝非特权 user namespace 的内核上以 no-sandbox 运行 |
| 系统安装 | `sudo apt install ./CodeWaifu-0.3.0-linux-amd64.deb` | `/opt/CodeWaifu` | 完整沙箱:postinst 会写入 AppArmor profile 并安装 setuid sandbox helper |

用户态安装全程不需要 root,代价也正是它没法替你把沙箱配好。Ubuntu 23.10+
默认带 `kernel.apparmor_restrict_unprivileged_userns=1`,在这个内核下 Chromium
拒绝以「无 profile 约束」的身份启动——它在任何 JavaScript 跑起来之前就 abort,
所以应用内部无法自救。安装器接上的启动器(`AppRun`,electron-builder 在每个
AppImage 里都放了一份)每次启动都会探测这件事,只有内核真的拒绝时才补
`--no-sandbox`。想保住沙箱,要么装 `.deb`,要么放开这条限制:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

依赖的共享库(Ubuntu 桌面版本来就有;安装器会跑 `ldd` 并点名缺哪个):

```bash
sudo apt install libgtk-3-0t64 libnotify4 libnss3 libxss1 libxtst6 \
  libatspi2.0-0t64 libsecret-1-0 libasound2t64
```

可选项,每装一个就点亮一块功能:

- `playerctl` —— 媒体控制,对接任意 MPRIS 播放器(Spotify、Rhythmbox、VLC、
  mpd……)。没装的话那一行会显示 `playerctl not installed`。
- `espeak-ng` —— 系统语音兜底。自带的 Matcha 神经语音不需要额外安装,这只是
  它后面的第二选择。
- `gnome-shell-extension-appindicator` —— GNOME 默认没有托盘,不装它图标根本
  出不来。装完要注销再登录。

常用参数:`--autostart` 顺手把桌面入口复制进 `~/.config/autostart`(开机自启),
`--from <路径>` 用同一套代码路径安装本地 `.AppImage` / `.deb` / 构建目录,
`--version vX.Y.Z` 锁定发行版。

已在 Ubuntu 24.04(GNOME,X11)上实测。Wayland 会话下她照样能跑,但点击穿透
用的 input shape 与合成器探测都是 X11 调用,这两块是在 X11(或 XWayland)上
验证的。

### Windows

用户态安装,不弹 UAC:落在上面提到的 `%LOCALAPPDATA%` 目录里,NSIS 顺手写好
开始菜单快捷方式与卸载项;hook 与其它平台一样进各 agent 的配置目录。
一个发行版同时带 setup 与 portable 两个产物,安装器优先取 setup——
快捷方式与卸载项是它写的。构建是 x64 且未签名,SmartScreen 会问一次(先点
「更多信息」,再点「仍要运行」);Windows on ARM 上以模拟方式运行,安装器会
明说,而不是让你对着慢启动猜原因。

裸的 `| iex` 吃不掉开关,要用脚本块把参数递进去:

```powershell
iex "& { $(irm https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/scripts/install.ps1) } -From C:/builds/CodeWaifu-0.3.0-win-x64-setup.exe"
```

- `-From 路径` 用与下载完全相同的代码路径安装本地产物:`*-setup.exe`、
  `*-portable.exe`,或 `win-unpacked` 构建目录——最后这个正是 CI 产出的目录,
  也是不发版就试本地构建最快的方式。
- `-Version 'v0.3.0'` 锁定发行版,而不是取最新。
- `-HooksOnly` 为已装好的应用重新注册 hook。
- `-Uninstall [-Purge]` 移除 hook(会先备份 agent 配置),加 `-Purge` 连应用
  一起删。

验证到哪一步:windows-latest 上的 CI 每次都跑完整测试(含 12 个针对
`install.ps1` 的端到端场景,发布源是打桩的),再对打包出来的 exe 做无头自测
(`--cli help`、`--cli status --json`)。把 bash 那行安装命令粘进 Git Bash,
得到的是 PowerShell 的正确写法,而不是 `unsupported platform: MINGW64_NT-...`。
CI 看不到的是真实桌面会话:托盘图标、点击穿透、SmartScreen 提示与语音输出,
还需要在一台 Windows 机器上手工过一遍。

### 或者在 agent 里一句话安装

Claude Code,作为插件:

```text
/plugin marketplace add flowinginthewind700/codewaifu
/plugin install codewaifu@codewaifu
```

然后 `/codewaifu:install`。Codex,作为 skill:

```bash
mkdir -p ~/.codex/skills/codewaifu && curl -fsSL \
  https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/skills/codewaifu/SKILL.md \
  -o ~/.codex/skills/codewaifu/SKILL.md
```

装好之后,在任意一个 agent 里说「安装 codewaifu」就够了:skill 与插件命令走的
是同一个安装器。

### 首次启动

1. 打开应用。它会跟你打招呼,然后停进菜单栏(macOS)或托盘(Windows、Linux)。
2. Codex 对第三方 hook 有一次性信任确认:打开 Codex,执行 `/hooks`,信任
   CodeWaifu 的条目。其余 agent 都无需任何操作。
3. 开一个 agent 会话。结束事件、权限请求、通知从此以语音和气泡到达。

环境要求:macOS 12+、Windows 10+,或 glibc 桌面版 Linux(Ubuntu 22.04+、
Debian 12+、Fedora 40+;x64),外加支持 hooks 的较新版本 Codex CLI /
Claude Code——或者 Cursor Agent、Gemini CLI、Antigravity、Kimi CLI、ZCode、
OpenCode、Kiro、Pi、Trae 中的任意一个。

## 工作原理

```text
任意 agent 的 hook
        |  stdin = 事件 JSON
        v
~/.codewaifu/hooks/run-hook.sh        失败开放:任何路径都 exit 0、
        |                             先排空 stdin、2 秒超时,并且先打
        |                             /health 确认对端真是 CodeWaifu,
        v                             绝不把会话数据 POST 给陌生端口
回环 relay(127.0.0.1,token + Host 校验)
        |
        +--> 事件规划 --> TTS 队列 --> 系统语音(中 / 英)
        +--> 气泡 + 线程看板 + 媒体栏(渲染层)
```

relay 地址在 socket 绑定之后才写入 `~/.codewaifu/endpoint.env`,runner 每次
hook 都重新读它。这正是端口策略敢随便搬家而不改任何 agent 配置的原因。

OpenCode 与 Pi 不走这个 shell runner——它们没有可以指向 runner 的 hook 配置。
它们的插件读同一个 `endpoint.env`、打同一个 `/health` 预检、POST 同样形状的事件
JSON,所以下游那条 relay 根本不知道也不需要知道事件是哪一种形态送来的。

### 端口策略

1. **固定。** `CODEWAIFU_PORT`(或设置里勾选「固定端口」)是承诺:端口被占用时
   CodeWaifu 会大声报告冲突,而不是悄悄换端口。
2. **粘滞。** 不固定时优先尝试上一次成功的端口,防火墙规则和使用习惯都不被打断。
3. **内核分配。** 仍被占用就 `listen(0)` 让系统挑一个空闲端口,并在界面与日志里
   说明这次搬家。任何情况下都不致命。

第二个 CodeWaifu 实例会通过 endpoint 文件发现第一个,并且拒绝抢它的端口,
只把这件事告诉你。

## CLI

打包后的二进制同时是 CLI,安装器与 agent 因此不需要重新实现一遍 hook 合并:

```bash
/Applications/CodeWaifu.app/Contents/MacOS/CodeWaifu --cli install     # 注册 hook
/Applications/CodeWaifu.app/Contents/MacOS/CodeWaifu --cli status      # 应用 / relay / hook 状态
/Applications/CodeWaifu.app/Contents/MacOS/CodeWaifu --cli say 你好    # 立刻说一句
/Applications/CodeWaifu.app/Contents/MacOS/CodeWaifu --cli uninstall   # 移除 hook(先备份)
```

所有命令都支持 `--json`,方便脚本消费。

### 在终端里开工作台

同一个二进制也能驱动 Pro,所以 shell alias、cron 任务和 agent 都能不开窗口读到
工作台。`codewaifu` 在 Linux 上已经在 PATH 里(安装器写 `~/.local/bin/codewaifu`),
macOS 上由应用自己在每次启动时写同一个启动器到 `~/.local/bin`,应用搬家了就重新
指过去 —— 不是我们写的文件一律不碰,所以 `npm i -g` 的 wrapper 或你自己的 alias
都还在。Windows 用打包好的二进制,在下面每条命令前加 `--cli`。

```bash
codewaifu pro                        # 动词表
codewaifu pro state                  # 树:分组、任务、实时状态、谁在等你
codewaifu pro watch                  # 树先打一遍,之后每个变化一行,ctrl-c 退出
codewaifu pro attention              # 排好序的队列,带着回答所需的 id
codewaifu pro answer <id> "可以,继续"
codewaifu pro approve <id>           # 或 deny <id>、snooze <id> --minutes 30
codewaifu pro new "修掉这个 flaky 测试" --dir ~/dev/thing --agent codex
codewaifu pro recovery               # 上次中断后还剩什么,以及接回来要哪几步
codewaifu pro log <taskId> --digest  # 目标 / 计划 / 已做的决定 / 下一步
codewaifu pro park <taskId>          # 不再统计它;它的 pane 继续跑
codewaifu pro rm <taskId>            # 只删这一行;加 --close 连它下面的终端一起关
codewaifu pro purge                  # 关掉之前移除时留下来的那些终端
codewaifu pro term                   # 就在这里开一个本地 shell

codewaifu pro ssh                    # 名册:已 pin 的、~/.ssh/config 的、herdr 报的
codewaifu pro ssh ls --hidden        # 被收起来的行,key 在前(key 就是 restore 的参数)
codewaifu pro ssh <target>           # 开一个 pane 直接拨号
codewaifu pro ssh add|edit|rm|restore <target>
codewaifu pro ssh test <target>      # 免密能不能进:一句话回答,不是退出码
codewaifu pro ssh setup <target>     # 把它变成免密(--plan 只打印不敲)
```

每个动词都支持 `--json`。输出是 ASCII,按终端宽度收在 60-160 列之间;id 一律完整
打印——抄不下来的 id,就是打不出来的命令。

`watch` 是同一套轨道的推送端:先把树打一遍,之后每个变化一行,直到 ctrl-c——而
ctrl-c 的退出码是 0,所以 shell 循环能分清「是我停的」和「它坏了」。`watch --json`
改吐原始 NDJSON 帧,给宁愿自己 diff 的脚本用。工作台最多同时供 16 个 watcher,
超了会明说(退出码 5),而不是悄悄把所有人的流降级。

退出码是契约而不是心情,所以轮询能分清「没人等我」和「没人在家」:0 成功、
2 参数不对、3 工作台或 herdr 没在跑、4 没有这个任务或条目、5 听懂了但拒绝、
6 应用不认我们的 token。

有两件事它永远不做。它不往 agent 的终端里敲键:ssh 那几个动词开的是自己的
pane,敲的也只是它刚给你看过的那一行;回答 agent 一律走待办队列。
`pro recovery` 也是只读的——执行一份恢复计划会建工作区、拉起 agent、往 pane 里
打一段重启提示,而账本要记下是谁下的手,所以计划由 Bench 窗口执行,终端负责报告。

`pro rm` 默认只删记录、让终端继续跑,和 Bench 窗口里那个勾选框是同一个分岔。
故意留下的进程也是看不见的进程,所以顶栏有一个 chip 报出它们的数量,
`pro purge` 一次全关。

## 你的数据

CodeWaifu 写的所有东西都在 `~/.codewaifu`(Windows:`%USERPROFILE%\.codewaifu`):
`config.json`、`endpoint.env`、生成的 hook runner、`codewaifu.log`,以及它动过的
每个 agent 配置的带时间戳备份。hook 合并是增量且幂等的,同一文件里其他工具的
条目逐字节保留;卸载只删除 CodeWaifu 自己的条目。

## 开发

```bash
npm install
npm run dev          # electron-vite 热重载
npm test             # vitest,1105 个测试:relay 测试台、Pro 桥接、真实 TTS
npm run test:e2e     # 需要显示器;先构建,约二十秒
npm run typecheck
npm run dist:mac     # 或 dist:win;产物在 release/
node --experimental-strip-types scripts/build-icon.mjs   # 重新生成 build/icon.png
```

渲染层是 React + 手写 CSS 设计系统(不引 UI 库),主进程是零运行时依赖的
Node/Electron,图标在构建期由符号距离场画出来——仓库保持纯文本。

## 诚实的局限

- 目前未签名:macOS 首次启动会有 Gatekeeper 提示(安装器会清掉隔离属性),
  Windows SmartScreen 可能询问一次。
- 语音使用系统自带声音,质量取决于系统装了什么。
- Linux 上非 root 安装时伙伴以 no-sandbox 运行:用户态安装没法写入 Chromium
  想要的 AppArmor profile。要沙箱就走 `.deb`。
- 插话对 Codex 线程是排队注入;其余 agent 没有受支持的注入接口,因此走剪贴板,
  提示里会点名是给哪个 agent 的。

## 许可证

MIT,见 [LICENSE](LICENSE)。
