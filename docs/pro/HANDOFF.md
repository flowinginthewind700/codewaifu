# Pro handoff

`main` @ `97fd122` - typecheck, 834 tests (plus the 12 Windows-only skips),
`electron-vite build` and the new `npm run test:e2e` (6 cases, needs a display)
all green on Linux (Ubuntu, node 20+, herdr 0.9.0). Verified platform is Linux;
macOS is built for but not yet run.

The spec is [MVP.md](./MVP.md) and it is still the authority: F1-F7, the
acceptance criteria in section 6, the phases in section 7. This file is the
other half - how to run what exists, which decisions are settled, and what is
known to be missing.

## 1. What Pro is

A cockpit over herdr. herdr owns the PTYs and the process durability; Pro owns
intent, triage and recovery. Killing the Bench window, the app, or the machine
does not kill anybody's agent - that is the whole reason the split exists, and it
is why no code here spawns an agent shell. The binary this was verified against
is herdr 0.9.0 at `~/.local/bin/herdr`.

## 2. Run it

```bash
npm install
npm run voice:runtime   # optional: Matcha/sherpa voice assets
npm run dev
```

`npm run dev` starts the companion widget and the tray icon. **The Bench is
opened from the tray menu: `Open Bench`** (the label carries the attention count
when it is non-zero). Two other doors exist: `pro.openBenchOnLaunch: true` in the
config file, and clicking an attention bubble that carries no task.

Config lives in `~/.codewaifu/config.json` under `pro.*`; every key and its
default is declared in `src/shared/config.ts::ProConfig`. Pro's own state is
`~/.codewaifu/pro/bench.json` (task registry) and
`~/.codewaifu/pro/tasks/<taskId>.jsonl` (one append-only intent ledger per task).
Both are written temp-file + fsync + rename + read-back, in `src/main/pro/env.ts`.

herdr discovery order, in `src/main/pro/herdr/discovery.ts`: `pro.socketPath` /
`HERDR_SOCKET_PATH`, then `pro.herdrSession` / `HERDR_SESSION`, then
`~/.config/herdr[/sessions/<name>]/herdr.sock`, then a Windows named pipe. With no
herdr on the machine the Bench degrades to an install card rather than failing.
Discovery never wildcards `sessions/`: an empty or whitespace `pro.herdrSession`
falls through to `HERDR_SESSION`, while a config value that names something
(including the literal `default`) wins over the environment. On this box dev also
needs `ELECTRON_DISABLE_SANDBOX=1`, and the relay plus `/pro/*` only start in the
instance that owns `~/.codewaifu/endpoint.env` - with the installed companion
running, a dev run logs `another CodeWaifu is already running; relay not started`,
so quit the installed app first when F6 is what you are verifying. Dev builds take
a `-dev` suffix on `userData` so they can sit next to the installed app; config and
Pro state stay in `~/.codewaifu` unless `CODEWAIFU_HOME` points elsewhere.

Pixels are obtainable now, but only from the smoke test: `npm run test:e2e`
leaves `tests/e2e/artifacts/bench.png`, a screenshot of the Bench it just launched
against a faked herdr socket, and it is the only screenshot this machine will give
anyone. GNOME's Screenshot D-Bus still answers `AccessDenied` to us and
`import`/`xwd` still return blank pixmaps for Electron windows under mutter, so a
*live* session is still CDP: `npm run dev -- --remote-debugging-port=9229`, then
`curl -s 127.0.0.1:9229/json/list` for the `CodeWaifu Pro` target and
`Runtime.evaluate` against its DOM. That is how the two blank-frame renderer
crashes in section 4 were found; the smoke test is the same look with a harness
around it, so it runs before a crash ships rather than after.

## 3. Gates

Run all three before every commit; there is no lint script.

```bash
npm run typecheck && npx vitest run && npx electron-vite build
```

A fourth gate is separate because it needs a display, a build and about twenty
seconds:

```bash
npm run test:e2e
```

It launches `out/main/index.js` under Electron against a faked herdr socket
(`tests/e2e/fakeHerdr.ts`, NDJSON over a unix socket) and asserts that the Bench
window paints a tree row, shows no crash card, is not sitting on the install card
and throws nothing while its bundle is evaluated; the screenshot lands in
`tests/e2e/artifacts/bench.png`. It is deliberately not inside `npm test`: a box
with no X display would fail it for a reason that has nothing to do with the code,
and jsdom cannot load a bundle, which is the only thing this gate is for.

`npm run typecheck` runs **both** tsconfigs. `tsconfig.node.json` has
`noUnusedLocals` and `noUnusedParameters`, so an unused import fails the build
rather than warning. `tests/installWindows.test.ts` self-skips off Windows
(that is the 12 skipped in the count).

A `.tsx` test belongs to `tsconfig.web.json` and a `.ts` test to
`tsconfig.node.json`, and neither project lists the other's sources. So a `.tsx`
test must not import `tests/helpers/pro.ts`: that helper pulls in
`src/main/server`, and the web project answers with TS6307 ("file is not listed
within the file list of project") rather than a type error. Build the fixture
locally instead; widening the include to silence it would drag electron into the
web project.

In the build output, `assets/useIme-*.js` is around 235 kB and is not the IME
hook. It is the chunk both entries share - react, react-dom, scheduler, lucide -
named by vite after the smallest module in it, which happens to be `useIme.ts`
now that both the widget and the bench import it.

## 4. What is built

| Feature | Owner | Pinned by | State |
|---------|-------|-----------|-------|
| F1 tree rail | `renderer/src/pro/TreeRail.tsx` | `proClient`, `proSocket` | done |
| F2 create / adopt / park | `main/pro/bench.ts`, `NewTaskDialog.tsx` | `proCommand` | done |
| F3 attention queue | `main/pro/triage.ts`, `AttentionQueue.tsx` | `proCommand`, `hookEvent` | done |
| F4 pane grid | `main/pro/herdr/terminalBridge.ts`, `Pane.tsx`, `PaneGrid.tsx` | `proBridge`, `proNdjson`, `findQuery`, `termKeys`, `bridgeErrorText` | done |
| F5 ledger + recovery | `main/pro/ledger.ts`, `recovery.ts`, `LedgerPanel.tsx`, `RecoveryPanel.tsx` | `proLedger` | done |
| F6 HTTP API | `main/server.ts` (`/pro/*`) | `server` | done |
| F7 companion link | `shared/companionLink.ts`, `main/pro/companion.ts`, `App.tsx` | `proIpcHost`, `proCommand`, `companionLink`, `bubbleAnswer` | done |

Acceptance criteria 6.1-6.4 and 6.7 are exercised by unit tests against recorded
fixtures (`tests/fixtures/herdr/`, captured with
`scripts/capture-herdr-fixtures.mjs`). 6.5 has been run once, on Linux, by
`scripts/soak-bench.mjs`: 20 busy tasks over 4 herdr workspaces, 78
keyboard-only selection cycles, per-process RSS every 20s for an hour. The
memory curve is a bounded GC sawtooth rather than a climb and not one of the
178 samples dropped a frame; the numbers, and the one caveat that comes with
them, are in `docs/pro/soak.md`. 6.6's GUI half is the fourth gate in section 3.

The terminal itself (F4) carries what a real terminal has: Unicode 11 widths,
WebGL rendering with a DOM fallback on context loss, links out to the OS browser
through a scheme allow-list - plain URLs *and* OSC 8 hyperlinks, which is what
`ls --hyperlink`, cargo, pytest and git emit on purpose - OSC 52, copy/paste
chords that never claim Ctrl+C, a bell light in the pane header, and scrollback
search with regex and case modes plus a match counter (`Ctrl+Shift+F`, `Cmd+F` on
macOS). Scrollback is 10 000 rows, which is a ceiling rather than a growth rate:
xterm keeps three 32-bit words per cell in a circular buffer, and only the
selected task's panes are mounted at all. The keyboard reaches a terminal on `i`
and comes back on Shift+Tab; the bench never hands it over unasked.

What the pane deliberately does not carry is written down with its reasons in
`thirdparty/README.md` under "Read and refused": no OSC 133 prompt marks (herdr
owns PTY spawn, so "jump to the last prompt" is not ours to build), no kitty
keyboard protocol (`Ctrl+I` stays `Tab`), no inline images.

A question can be answered in words from either surface (F7). The widget's
bubble grows one row - an Answer chip, a single-line field, a Send - and widens
to 244px while composing, because a field narrower than a dozen characters hides
the sentence being typed and the window has the room. It is pinned for as long as
the composer is open: its own hold timer is suspended and `shouldClearBubble`
stands down, since the push that reports "the queue drained" is exactly the one
an in-flight answer causes. A notice arriving mid-sentence is held and shown on
the way out with whatever hold it has left. The Bench's queue has had an answer
box all along; what changed there is the keyboard.

Both composers fold and cap through the same `answerText` in `shared/pro.ts`,
called from `planAttentionAction` rather than from either UI, so what the ledger
records is what the pane received. An answer is delivered by typing it, so a
newline is Enter and an unbounded length is a TUI input buffer that drops bytes
without complaining: neither failure is loud, which is why both are handled in
the plan. The Bench field hard-caps with `maxLength`; the bubble warns instead,
because a widget that silently discards the end of a sentence is worse than one
that says so. `reprompt` is not folded - it compiles a multi-line brief.

The renderer is wrapped in `FaultBoundary` (`pro/main.tsx`), so a throw in a render
or a mount effect is a card carrying the kind, the message, four frames and two
buttons instead of an empty window next to a clean main log. Every decision the
card makes about the error lives in `shared/renderFault.ts` - guarded property
reads, no serialisation - because there is no boundary behind the boundary. Its
first sentence is the one that matters: herdr owns the PTYs, so a dead renderer
has killed nobody and reloading is safe.

That card exists because two crashes shipped as blank frames and were found only
over CDP: `shared/lang.ts` reading `process.env` in a module the bench imports, and
`Pane.tsx` constructing the terminal with `allowProposedApi: false` before loading
the Unicode11 addon, which is a proposed API. Both are fixed and the lang one is
pinned by a test that deletes `globalThis.process`. Neither was caught by a green
suite, because until `tests/faultBoundary.test.tsx` no test in this repo could
render a pro component: 14 jsdom cases now mount the boundary for real (including
what React dev's guarded-callback replay does to a thrown value whose getters
throw), and `renderFault.test.ts` pins the pure half with 20 more. The pane grid
itself was verified live over CDP against a running herdr session (one pane, task
list, attention queue and recovery panel all rendering).

The smoke test in section 3 now catches both of those crashes at the layer they
failed in: it loads the built bundle, which is the one artefact a green jsdom
suite never sees.

## 5. Settled decisions

These are argued in the code comments where they live; do not re-litigate them
without reading those first.

- **One authority.** `ProService` backs the GUI, `/pro/*` and the companion.
  `view()` is the single projection and the single "is Pro on" predicate - the
  tray, the HTTP 503 and the widget all read it.
- **Pure decisions live in `src/shared/*.ts`** with no DOM and no electron
  import, and are tested in `tests/*.test.ts`. `hotkey.ts`, `termKeys.ts`,
  `companionLink.ts`, `proIpc.ts` are the precedents. A rule that cannot be
  unit-tested has not been written down yet.
- **IPC verbs are folded before comparison** and the parser returns the canonical
  literal the service switches on (`proIpc.ts`). Comparing a lower-cased verb
  against a camelCase literal made six user-visible buttons dead on arrival
  while reporting "unknown op", which reads like a version mismatch.
- **Frame counters are per connection.** herdr numbers frames per control
  connection, so any counter that survives a respawn turns the next frame into a
  false gap. See `terminalBridge.ts::spawnChild`.
- **Drops are bounded and a resync backs off.** Frames are dropped rather than
  queued, one respawn is armed no matter how many frames were dropped, and a
  drop-driven resync doubles its delay to a 4s ceiling because a resync costs a
  full repaint.
- **Search takes Ctrl+Shift+F, not Ctrl+F.** Plain Ctrl+F is readline
  forward-char, vim's page-down and less's next-page; claiming it fails silently,
  because nothing errors and the cursor just stops moving right. The decision
  lives in the pure table at `src/shared/termKeys.ts` next to the copy chords, so
  the keys that must reach the PTY are pinned by a test rather than by a
  component behaving well today.
- **The find bar is an overlay, not a row.** Taking layout height would fire the
  ResizeObserver, which fits the terminal and pushes the new size to the PTY, so
  opening find would reflow the agent's screen. Its match counter has a fixed
  width floor for the same reason: the bar must not move while somebody types.
- **The companion never becomes a second keyboard.** There is deliberately no
  `input` or `keys` verb on the companion channel; `proCommand.test.ts` pins
  their absence.
- **An answer is a verb, not an exception to that rule.** The bubble sends
  `act`/`answer` with text and lets `planAttentionAction` decide what reaches the
  pane; it never sends keystrokes. `routeCanAnswer` reads the action list main
  already validated rather than re-deriving verbs from the item's kind, because a
  second derivation is how a bubble ends up offering a button the service will
  refuse - and a dead button is worse than no button.
- **A half-typed answer outranks every push.** The composer pins the bubble:
  its hold timer is suspended and `shouldClearBubble` returns false. The push
  that would otherwise take it down is the one an in-flight answer causes, so
  honouring it deletes the sentence; what the human gets instead is a refused
  send, out loud. The pin has to hand back a clock on close, or an Escape leaves
  the question up until the next push happens to clear it.
- **Delivery is confirmed by `code`, not by `ok`.** When the item is already
  gone, `resolveCommand` degrades the command to "show that task" and answers
  `ok`; reporting that as delivered is the one expensive lie this feature could
  tell, because somebody walks away believing an agent is unblocked when all that
  happened was a window came forward. The two outcomes have separate strings.
- **Answer normalization lives in the plan, not in the UI.** Three callers reach
  `planAttentionAction` (the Bench box, the bubble, `POST /pro/answer`) and only
  the last one can still carry a newline - a single-line field sanitizes its own
  value before our code sees it. Folding in the plan is what keeps the ledger
  equal to what the pane received, and the cap counts code points so a cut never
  leaves a lone surrogate to be typed into a terminal.
- **IME guards are wiring, so the wiring is what gets tested.** `shared/ime.ts`
  already pins the predicate, with all three signals and the post-compositionend
  grace window; `bubbleAnswer.test.tsx` and `attentionAnswer.test.tsx` mount both
  composers and assert that a composing Enter, a `keyCode === 229` Enter and the
  macOS commit Enter after compositionend all fail to send. Removing the guards
  from `Bubble.tsx` turns exactly three cases red, which is the point: a bare
  `key === 'Enter'` reads correctly, passes review, and ships half-typed pinyin.
- **Attach does not replay scrollback.** A pane shows output produced from
  the moment of attach; a terminal that keeps a backlog replays history at the
  user forever (`terminalBridge.ts`). An idle pane is therefore legitimately
  empty, and with WebGL active its DOM rows are empty too (two canvases carry
  the pixels) - neither is a bug. Proven live by typing `echo ...` into the pane
  with trusted CDP key events and watching the find bar count the matches.
- **Terminal output is untrusted.** It is the only string in the app we do not
  author, so links leave through the `openExternal` host op behind an
  http/https/mailto allow-list that runs in main.
- **OSC 8 links are output, not navigation.** xterm's built-in handler for them is
  a `confirm()` reading "WARNING: This link could potentially be dangerous" and
  then `window.open()`. Ours go through the same allow-list as every other
  untrusted string and open in the OS browser, where the user's session is.
- **A search is planned before it is run.** `shared/findQuery.ts` compiles the
  pattern with the exact flags SearchAddon will use, and refuses a pattern that
  matches the empty string (`a*`, `^`, `(?:)`) because that "succeeds" with a
  highlight on every cell boundary and a count in the tens of thousands that is
  arithmetically right and useless. SearchAddon lets the compile throw escape from
  a debounce timer; the bar now shows the engine's reason in the counter that
  otherwise shows the match count, and a mode toggle rescans immediately rather
  than waiting for the next keystroke.
- **`i` is the only door into a terminal.** MVP F7's "focusTask focuses that pane"
  is grid selection and deliberately not keyboard focus: a companion bubble that
  brought the window forward and quietly took the keyboard would send the next `d`
  into the agent's shell instead of denying the head of the queue, which breaks the
  a/d/s loop F3 calls the whole product. Both ways `i` can fail are shown and say
  different things, because "this task has no panes" and "that pane is released"
  have different fixes. Shift+Tab is the way out; xterm's helper textarea sits in
  the tab order ahead of the pane header buttons, so tabbing alone cannot escape.
- **The fault card asks nobody for anything.** No `proApi`, no config, no context,
  no import of `Bench`, and its language comes from `navigator` rather than from
  the user's `uiLang` setting - a card in the wrong language still beats a blank
  frame. Its copy button shows a refusal rather than swallowing it, because a
  silent failure there is a lost bug report, and the usual cause (an unfocused
  window) is exactly the state a crash can leave you in.
- **Renderer tests opt into jsdom per file** with a `// @vitest-environment jsdom`
  pragma, so the node environment stays the default and the thirty-odd pure suites
  keep running without a DOM. The price is two things in `vitest.config.ts` that
  must mirror `electron.vite.config.ts`: the `@shared` alias and
  `esbuild.jsx: 'automatic'` (a `.tsx` test sits outside both tsconfig projects, so
  esbuild cannot discover `react-jsx`).
- **Comment voice.** ASCII only, and a comment explains the failure mode being
  prevented rather than restating the line below it.

## 6. Known gaps, in the order they should be taken

1. **Timing flake.** One full-suite run in about six showed a single failure in
   `steer` or `matchaVoice`; both do real waiting and neither reproduced on
   rerun. Worth converting to a fake clock if it recurs.
2. **macOS.** Nothing has been run there. The likely sharp edges are the menubar
   tray (a long `Open Bench (12)` label), `alwaysOnTop` interplay with the Bench
   window, and voice-runtime packaging via `npm run dist:mac`. The Cmd/Ctrl chord
   table itself is pure and tested on both.

## 7. 中文速览

- 跑起来：`npm install && npm run dev`，然后**托盘菜单 → Open Bench** 打开工作台。
  想让启动就打开，把 `~/.codewaifu/config.json` 里的 `pro.openBenchOnLaunch` 设为
  `true`。
- 提交前三道闸：`npm run typecheck && npx vitest run && npx electron-vite build`。
  没有 lint 脚本；`tsconfig.node.json` 开了 `noUnusedLocals`，多余 import 会直接红。
  第四道闸单独跑：`npm run test:e2e`——要显示器、要先构建、约二十秒，所以不在
  `npm test` 里：没有 X 的机器会因为它红，而红的理由跟代码无关。
- 前提：机器上要有 herdr（这里验证用的是 0.9.0）。没有 herdr 时 Bench 会退化成安装
  引导卡片，不会崩。
- 数据落盘：`~/.codewaifu/pro/bench.json` 是任务注册表，`~/.codewaifu/pro/tasks/*.jsonl`
  是每个任务的意图账本（append-only + fsync）。GUI 是可丢弃的，重启后由这两样加
  herdr 现状重新推导。
- 状态：F1-F7 都已实现并有单测（842 passed / 12 skipped，skipped 是 Windows 专用）。
- 面板桥接起不来时不再吐裸 errno：ENOENT 变成「装上 herdr，或把 pro.herdrPath
  指到可执行文件」，EACCES/EPERM 变成「chmod +x」，认不出的消息原文照抄；重试
  退避 1s→8s，一帧到达就把错误文案和连续计数一起清零。
- 验收 6.5 的一小时在 Linux 上跑过了：20 个忙任务、4 个工作区、78 次纯键盘选择、
  每 20 秒一次逐进程 RSS。内存是有界锯齿而非单调增长，178 个样本 0 丢帧；数字与
  那句保留意见在 docs/pro/soak.md。README 两份也补了 Pro 一节与工作台截图。
  终端这一层分两轮补齐质量：Unicode 11 宽字符、WebGL 渲染与降级、链接走系统浏览器、
  OSC 52 剪贴板、复制粘贴不抢 Ctrl+C、响铃指示、输出内搜索（Ctrl+Shift+F / macOS 上
  Cmd+F）；这一轮再加上搜索的正则与大小写模式、非法 pattern 把拒绝原因写进计数器、
  OSC 8 超链接改走主进程白名单（不再弹 xterm 自带的 confirm）、scrollback 4000 ->
  10000 行（只挂载选中任务的 pane，所以这是上限不是增长速率）、`i` 把键盘交给终端、
  Shift+Tab 交回来。早先还修掉一个真 bug：resync 之后桥接进程以每秒 4 次无限重启。
- 问题能用文字回答了（F7 收尾）：浮窗气泡多一个「回答」chip + 单行输入框，Bench 队列里
  原有的回答框修掉了中文输入法（Enter 选词不再把半截拼音当答案发出去）。chip 只在
  `routeCanAnswer` 认可时出现——它读的是主进程已按 `attentionActions` 校验过的 action
  列表，不再从 kind 二次推导，否则气泡会长出一个点了没反应的按钮。
  文本统一走 `shared/pro.ts::answerText` 折叠空白并按 400 个码位截断，调用点在
  `planAttentionAction`，所以 Bench、浮窗、`POST /pro/answer` 三条路发出去的与账本记下的
  是同一行字：答案是「打」进 pane 的，换行就是 Enter（会先把半句提交掉），按码位截断才
  不会把 emoji 劈成半个代理对。`reprompt` 故意不折叠，它是多行恢复简报。
  打字期间气泡被钉住：hold 计时器停、`shouldClearBubble` 让路，因为「队列空了」那条推送
  正是一次在途回答自己造成的，照着清就删掉了人正在写的句子；期间到达的 notice 会被暂存，
  关输入框时按剩余时长补播。发送结果只认 `code === 'sent'`：条目已不在时
  `resolveCommand` 会降级成「把窗口带到那个任务」并回 `ok`，那不能说成「已送达」。
  新增 39 例（`proAttention` / `companionLink` / `bubbleAnswer` / `attentionAnswer`），
  其中把 `Bubble.tsx` 的 IME 守卫拆掉会正好红 3 例——这就是「守卫真在生效」的证据。
  注意 `.tsx` 测试属于 `tsconfig.web.json`，不要 import `tests/helpers/pro.ts`（它会拽进
  `src/main/server`，报 TS6307），fixture 就地写。
- 命名会话：discovery 不猜会话名。`pro.herdrSession` 留空（或纯空白）时落到环境变量
  `HERDR_SESSION`；配置里写了名字（包括字面 `default`）就以配置为准。
- 崩了不再白屏：`pro/main.tsx` 用 `FaultBoundary` 包住整棵树，卡片第一句是你的代理还在
  herdr 里跑着（PTY 归 herdr，renderer 死了没杀掉任何人，重载安全）。
  卡片对错误的所有判断都在 `shared/renderFault.ts`：读属性一律带 try、绝不 JSON.stringify，
  因为边界后面没有第二层边界。
  这也是本仓库第一批 renderer 测试：`tests/faultBoundary.test.tsx` 用 jsdom 真挂了 14 例，
  `renderFault.test.ts` 20 例盯纯逻辑。
  此前 `npm test` 连一个 pro 组件都渲染不出来，所以两次白屏崩溃都是绿的。跑 `.tsx` 测试
  靠 `vitest.config.ts` 里的 `@shared` alias 与 `jsx: 'automatic'`，改
  `electron.vite.config.ts` 的 alias 时要同步。
- 这台机器上 dev 要加 `ELECTRON_DISABLE_SANDBOX=1`；正式版 companion 在跑时 dev 不起
  relay（`endpoint.env` 被占），要验 F6 先退正式版。
- 截图在这台机器拿不到：GNOME 的 Screenshot D-Bus 回 `AccessDenied`，`import`/`xwd`
  对 Electron 窗口只给空白像素。验 Bench 走 CDP：`npm run dev --
  --remote-debugging-port=9229`，对 `CodeWaifu Pro` 这个 target 做 `Runtime.evaluate`。
  唯一的例外是 `npm run test:e2e` 留下的 `tests/e2e/artifacts/bench.png`：它截的是
  测试自己起的那个 Bench，也是这台机器给得出的唯一一张像素。
  两个白屏 renderer 崩溃（shared/lang.ts 读 `process.env`、Pane 的 `allowProposedApi`）
  就是这么抓到的，现已修复；pane 网格对着真实 herdr 会话验过渲染。
  同类崩溃现在会在窗口里显示成一张卡片，CDP 回到它本来的用途：看渲染结果，而不是找
  崩溃的唯一手段。
- Bench 的 e2e 有了：`tests/e2e/proSmoke.e2e.ts` 用 playwright-core 的 `_electron`
  真起 `out/main/index.js`，对端是 `tests/e2e/fakeHerdr.ts` 的假 herdr（unix socket
  上的 NDJSON，只回 `ping` / `session.snapshot` / `events.subscribe`），断言窗口画出
  任务行、没有崩溃卡片、不在安装引导卡片上、bundle 求值不抛异常。jsdom 渲染不了
  打包后的 document，而两次白屏都是 bundle 层的失败，所以这道闸只能真起进程。
  「不抛异常」靠一次 reload：`pageerror` 的监听器在 `electron.launch` 返回之后才绑得
  上，第一次求值抛的异常已经是历史；reload 用同一个 module graph 再求值一遍，这次
  有人听。把 `throw` 塞进打好的 bundle 里验过：6 例红 4 例，其中就有这一例。
- 还没做：连续一小时高输出的内存实测、pane spawn 失败时裸露的 errno、README 里的
  Pro 章节、macOS 实机验证。
