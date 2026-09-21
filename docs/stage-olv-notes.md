# 舞台模块对照 Open-LLM-VTuber 的优化清单

参考对象：[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)
（后端）与 [Open-LLM-VTuber-Web](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber-Web)
（前端舞台）。本文只谈**互动效果**与**表现效果**，结论都对着两边代码核过，
行号是写下时的 `main`（CodeWaifu @ 30731e3）。

> OLV 的 `WebSDK/`（`lappmodel.ts` 等）是 git submodule，取不到源文件；
> 涉及 SDK 内部行为的条目是从调用侧推断的，已标出。

## 结论先说

两个项目的强项互补，不是谁抄谁。

- OLV 强在**语义密度**：每句话带表情 + 动作、点击按命中区加权、模型常驻注视
  光标、空闲自动复位、闲久了主动搭话。
- CodeWaifu 强在**工程诚实度**：analyser 侧链 + 抽成纯函数的口型包络
  （`src/renderer/src/live2d/lip.ts`，attack 0.022 / release 0.14 / gain 3.5）、
  表情里剥掉嘴参数（`shared/expression.ts`，`tests/expression.test.ts` 钉住了
  那个「嘴恒全开」的实测 bug）、加载进度与 GL-lost 上报、语音会话 ack 看门狗。

该搬的是 OLV 那套**事件 → 表情/动作的映射**，不是它的音频链路。

## 互动（存在感优先）

### 1. 悬停即注视 — S

头眼跟随现在只在**按下**时生效：`host.ts:603` 的 `onPointerMove` 第一行就是
`if (!this.pointerCaptured) return`，光标从她脸上划过她毫无反应。OLV 的模型
常驻跟随光标，这是「她在那儿」最直接的信号。

做法：非按下态的 move 也喂 `this.model.setDragging(view.x, view.y)`，但乘一个
低增益（0.3 左右），按下时才给满值；`pointerleave` / 窗口 `blur` 归零。
⚠️ 窗口在 click-through 期间只有 Electron 转发的 move 会到达页面
（`App.tsx:335`、`stageVeil.ts` 头部注释写清了这套转发语义，且转发是
`mousemove` 而非 `pointermove`），所以 hover 跟随可能得复用 window 级监听，
不能只挂 canvas。

### 2. 逐命中区加权 tap 动作表 — M

OLV 的 `ModelInfo.tapMotions: {hitArea: {motionGroup: weight}}`
（`context_live2d-config-context.tsx:35-68`）让每个命中区独立配置；
`hooks_canvas_use-live2d-model.ts:363-377` 先 `anyhitTest` 拿命中区名，再
`startTapMotion(hitAreaName, tapMotions)`，另有 `pointerInteractive` 做每模型开关。

CodeWaifu 是二分支硬编码（`host.ts:620-627`）：头 → `setRandomExpression()`，
身 → `startRandomMotion("TapBody", NORMAL)`，整组等概率。而 HaruGreeter 的
TapBody 有 **27** 条、标签自带情绪（微笑/俏皮/否定/惊吓/生气…，
`src/shared/live2dCatalog.ts:68`，`src/shared/motion.ts` 有译名表），
等概率随机等于把这套素材浪费掉。

做法：目录里加 `tapMotions`（纯数据，可进 vitest），host 按权重表挑
`playMotionAt(group, index, PRIORITY_NORMAL)`。别沿用默认的 `PRIORITY_FORCE`
——那是舞台菜单「点名要看」的语义（`host.ts:723-730` 注释）。

现成的落点：`tests/motion.test.ts` 已经在 import `LIVE2D_CATALOG` 并断言
「随包角色的**每一条** motion 都有人工译名，不许回落成 `Tap Body 4`」。
同一份目录数据再加一张命中区权重表，测试照这个形状写（覆盖每个 hitArea、
权重和为 1、group 名存在于该角色），不用新造测试基建。

### 3. 事件语义 → 表情/动作映射扩面 — S/M

气泡有 **18** 种 kind（`Bubble.tsx` 的 `KIND_LABEL`：failed / question / review /
stalled / compact / interrupt / subagent…），但

- 手势只认 3 种：`App.tsx:72` 的 `GESTURE_KINDS = {stop, session_start, permission}`，
  用在 `App.tsx:271`；
- 表情只落到 5 个 mood：`ui.ts:126` 的 `expressionForKind` →
  `live2dMood.ts:16` 的 `CANDIDATES`。

OLV 是另一种密度：后端把 LLM 文本里的 `[emotion]` 标签抽出来
（`live2d_model.py:146-195` 的 `extract_emotion` / `remove_emotion_keywords`，
关键词表由 `prompts/utils/live2d_expression_prompt.txt` 注入系统提示），
随音频消息下发 `expressions`，前端每句换脸。

CodeWaifu 不需要让 LLM 打标签——**事件 kind 本身就是语义**。补齐
`expressionForKind` 的分支（failed → sad/coldness、question → surprise、
review → shy、stalled → angry…），再把 `GESTURE_KINDS` 换成一张
kind → mood 动作映射表。纯函数，直接补 `tests/`。

### 4. 空闲复位到默认脸 — S

`MANUAL_FACE_MS = 8000`（`App.tsx:77`）只保护「用户在舞台工具里手点的脸」不被
下一个 `speaking` tick 冲掉（`App.tsx:440-452`）；8 秒一过脸就交给下一条事件，
中间空档会停在怪表情上。OLV 在 IDLE 时调 `resetExpression()` 回到
`modelInfo.defaultEmotion`（`hooks_canvas_use-live2d-expression.ts:43-62`）。

`live2dMood.ts` 的 `idle` 候选已经有了（`['smile']`），只缺一个
「无事件 N 秒 → 设回 idle」的计时器。

⚠️ 这里有个结构差异值得先想清楚。OLV 的复位是挂在一台**显式状态机**上的
（`context/ai-state-context.tsx:17-51`：LOADING / IDLE / THINKING_SPEAKING /
WAITING / LISTENING / INTERRUPTED，`WAITING` 还有 2 秒自动回落 IDLE 的计时器，
`live2d.tsx:47-55` 监听 `aiState === IDLE` 才调 `resetExpression`）。
CodeWaifu 舞台上只有两个离散信号：`speaking` 布尔（`App.tsx:134`，来自
`runtime.speaking` 与语音状态推送）和 `lastKind`（最后一条事件的 kind）。
「空闲」不是一个已有状态，得自己定义——建议就用「最后一条事件 + 最后一次说话
都过去 N 秒」，别为此引入一台完整状态机；但要留意 `lastKind` 永远停在上一个
kind，`expressionForKind(lastKind, speaking)` 会在 `speaking` 翻回 false 时
把脸重算一次（`App.tsx:435-438`），复位计时器要和这个 effect 的顺序对齐，
否则会出现「复位完立刻又被 lastKind 覆盖」。

### 5. 接上 `onTap` — S

`host.ts:438` 定义了 `onTap(area)` 并在 `620-627` 三处调用，但
`Live2DAvatar.tsx` / `App.tsx` **没人订阅**（全库 rg 只命中 host.ts）。
摸头摸身现在是纯动作、无回应。接上后给一句短反应 + 一条对应动作，
文案复用 `shared/phrases.ts:201` 的 `pickPhrase`（已有按小时的问候池，
`phraseCount` 可用来判空）。

### 6. 可选的空闲主动搭话 — S/M

OLV 的 `context_proactive-speak-context.tsx` 是 idle `idleSecondsToSpeak`
（默认 5 秒）→ 发 `ai-speak-signal`（还带截图）让 AI 主动开口。
简化版不需要截图也不需要 LLM：idle N 秒 → 池子里挑一句 + 一条动作 +
可选 TTS，config 加开关，默认关。

### 7. 控制台调试面 — S

OLV 挂了 `window.Live2DDebug` 可以直接在控制台调动作/表情。CodeWaifu 要试一条
具名动作得走舞台菜单。开发期在 `Live2DAvatar.tsx` 暴露 host 句柄即可。

### 8.（拉伸，L，可选）按模型轮廓做点击穿透

OLV pet 模式把 hover 命中态经 IPC 报给主进程做像素级穿透。CodeWaifu 的
`.l2d` 是 `inset:0` 全铺 + `data-solid="1"`（`Live2DAvatar.tsx:262`、
`styles.css:419-433`），所以整个舞台框吞点击；判定在 `App.tsx:345` 的
`closest('[data-solid]')`，Linux 另有 `setShape` 那条路（`App.tsx:369`）。
做轮廓级穿透要同时改两套输入区域逻辑，收益不确定，列为可选。

## 表现（说话时最值钱）

### 1. 逐句表情 + 手势 + 气泡卡拉OK — M（单点收益最大）

句子边界在 main 侧**已经切好了**：`shared/speech.ts:108` 的 `speechUnits()`，
`tts.ts:210` 逐句合成，`voiceBridge.ts:150` 逐句 `send`。但 `SpeechChunk`
（`protocol.ts:123`）只有 `{id, wav, ms, end}`——文本和语义到 renderer 就丢了，
`Bubble.tsx` 只能整句一行显示，没有逐句同步。

OLV 每句做三件事（`hooks_utils/use-audio-task.ts:129-147`）：`setExpression(...)`
→ `startRandomMotion("Talk", PriorityNormal)` → 播这句音频。

做法：`SpeechChunk` 加 `text?` / `mood?` / `motionHint?`（可选字段，旧路径不受
影响），renderer 在 AudioContext 时间轴排程的同一处按句触发：切气泡文本 →
设表情 → 起一条 `PRIORITY_NORMAL` 动作。协议 + 映射都是纯逻辑，可进 vitest。

逐句文本显示 OLV 是做成独立字幕层并**可关**的
（`context/subtitle-context.tsx:46`，`showSubtitle` 默认 true）。CodeWaifu 的气泡
本来就在显示整句，改成逐句同步等于顺手拿到了字幕，不需要新层——但「只显示气泡
不朗读」这类已有配置得一起过一遍，别让逐句文本在静音模式下反而更吵。

### 2. 说话一开始就给动作 — S

不必等上一条落地：`speaking` 变 true 时先起一条动作。现在只有 3 种
`GESTURE_KINDS` 会动，其余 kind 说话时身体是僵的。

### 3. `lipGain` 接进配置 — S

prop 一路通到 `host.ts:440` → `host.ts:665`，但 `App.tsx:793-801` 渲染
`Live2DAvatar` 时**没传**，`config.ts` 里也没这个字段，所以永远吃
`DEFAULT_LIP_GAIN = 3.5`。按角色给默认（HaruGreeter 与 Mao 的嘴部幅度不同）
+ 一个设置滑杆（`SettingsTab.tsx` 已有 scale 滑杆可照抄）。

### 4. 气泡动效 — S

打字机入场、tone 切换过渡，纯 CSS，不动 `Bubble.tsx` 结构。

### 5. Live2D 缩放 — M（低优先）

`config.ts:74` 的 `scale`（0.6–2，clamp 在 `config.ts:288`）现在**只喂静态 SVG
`Avatar`**（`App.tsx:807` → `Avatar.tsx:20`），Live2D 分支完全没用它，也没有
滚轮缩放。OLV 是改 `_modelMatrix` 平移 + 滚轮缓动
（`hooks_canvas_use-live2d-resize.ts:11-14`：MIN 0.1 / MAX 5.0 /
EASING 0.3 / step 0.03，位置存 localStorage）。

⚠️ 权衡：CodeWaifu 拖她 = 移动**整个窗口**（IPC + rAF 批处理，
`Live2DAvatar.tsx:40` 的 `DRAG_THRESHOLD = 14`），OLV 拖的是模型本体。改窗口尺寸会牵动 Linux `setShape`
与 click-through 两条输入区域逻辑，所以先只做滚轮缩放（canvas 内改 view matrix，
不动窗口），别换拖拽语义。

### 6. 舞台背景 / 地面投影 — 低优先

OLV 有可选背景图与摄像头背景（`components_canvas_background.tsx:10-46`）。
动手前先读 `stageVeil.ts` 头部注释：跟随光标的透镜**曾被刻意移除**
（画在她 canvas 下面像一圈光环）。同一类视觉陷阱要绕开。

## 顺手小项

`stageVeil.ts:82` 每次 mousemove 都 `getBoundingClientRect()`（强制回流）。
缓存 rect，resize / 布局变化时失效。

`lip.ts` 的文件头注释写着「抽出来就能在 vitest 里用假 dt 步进直接断言
『音节之间有回落、静音后闭嘴、不会超界』」，但 `tests/` 下**没有**对应的测试
文件——`lipEnvelope` / `lipTarget` 目前只在 `lip.ts` 与 `host.ts` 里被引用。
注释承诺的那层保护是空的。这不是本清单引入的问题，但表现 3 要按角色改
`lipGain` 默认值，正好顺手把它补上：`lipEnvelope` 是纯函数，假 dt 步进几十行
就能钉住「attack/release 时间常数、静音后归零、输出不越 0..1」。

## 明确不抄的

- **OLV 的口型**：`_wavFileHandler` 逐句重解码，还要 monkeypatch `_lastRms`
  （`utils_audio-manager.ts:35-42` 打断时手动归零），且不支持流式。
  CodeWaifu 的 analyser 侧链（`voice.ts:201`）+ 纯函数包络 + 单测明显更好，保留。
- **OLV 的 3s taskInterval 队列**：CodeWaifu 是逐句流式 + ack，延迟更低。

打断可以对照着看一眼：OLV 停音频即 `releasePcmData()` 闭嘴 + `clearQueue()` +
`interrupted` 状态挡后续任务（`hooks_utils/use-interrupt.ts:16-33`）。
CodeWaifu 对应的是会话 ack 看门狗（`voiceBridge.ts` 的 ceiling/watchdog），
机制不同但目的一致，不必然要改。

## 建议顺序

1. 注视跟随（互动 1）+ `onTap` 短反应（互动 5）——都是 S，改完立刻活起来。
2. 表情/手势映射扩面（互动 3）+ 空闲复位（互动 4）——S/M，纯函数可补测。
3. 逐句元数据 + 卡拉OK 气泡（表现 1）——M，动协议，需要一次完整回归。
4. 其余按需。
