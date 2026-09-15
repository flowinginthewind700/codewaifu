# Pro handoff

`main` @ `18fe279` - typecheck, 753 tests and `electron-vite build` all green on
Linux (Ubuntu, node 20+, herdr 0.9.0). Verified platform is Linux; macOS is built
for but not yet run.

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

Pixels are not obtainable on this machine: GNOME's Screenshot D-Bus answers
`AccessDenied` to us, and `import`/`xwd` return blank pixmaps for Electron windows
under mutter. Verify the Bench over CDP instead: `npm run dev --
--remote-debugging-port=9229`, then `curl -s 127.0.0.1:9229/json/list` for the
`CodeWaifu Pro` target and `Runtime.evaluate` against its DOM. That is how the two
blank-frame renderer crashes in section 4 were found, and it is the cheapest way to
see the pane grid after touching renderer code.

## 3. Gates

Run all three before every commit; there is no lint script.

```bash
npm run typecheck && npx vitest run && npx electron-vite build
```

`npm run typecheck` runs **both** tsconfigs. `tsconfig.node.json` has
`noUnusedLocals` and `noUnusedParameters`, so an unused import fails the build
rather than warning. `tests/installWindows.test.ts` self-skips off Windows
(that is the 12 skipped in the count).

## 4. What is built

| Feature | Owner | Pinned by | State |
|---------|-------|-----------|-------|
| F1 tree rail | `renderer/src/pro/TreeRail.tsx` | `proClient`, `proSocket` | done |
| F2 create / adopt / park | `main/pro/bench.ts`, `NewTaskDialog.tsx` | `proCommand` | done |
| F3 attention queue | `main/pro/triage.ts`, `AttentionQueue.tsx` | `proCommand`, `hookEvent` | done |
| F4 pane grid | `main/pro/herdr/terminalBridge.ts`, `Pane.tsx`, `PaneGrid.tsx` | `proBridge`, `proNdjson` | done |
| F5 ledger + recovery | `main/pro/ledger.ts`, `recovery.ts`, `LedgerPanel.tsx`, `RecoveryPanel.tsx` | `proLedger` | done |
| F6 HTTP API | `main/server.ts` (`/pro/*`) | `server` | done |
| F7 companion link | `shared/companionLink.ts`, `main/pro/companion.ts`, `App.tsx` | `proIpcHost`, `proCommand` | done except free-text answers |

Acceptance criteria 6.1-6.4 and 6.7 are exercised by unit tests against recorded
fixtures (`tests/fixtures/herdr/`, captured with
`scripts/capture-herdr-fixtures.mjs`). 6.5 (20 tasks over 4 repos, keyboard-only,
flat memory for an hour) and 6.6's GUI half are still **manual** - nobody has run
the hour.

The terminal itself (F4) carries what a real terminal has: Unicode 11 widths,
WebGL rendering with a DOM fallback on context loss, links out to the OS browser
through a scheme allow-list, OSC 52, copy/paste chords that never claim Ctrl+C, a
bell light in the pane header, and scrollback search with a match counter
(`Ctrl+Shift+F`, `Cmd+F` on macOS).

The renderer has no error boundary and no tests of its own, so a throw inside a
mount effect unmounts the tree and the window is a blank frame while the main log
stays clean. Two crashes shipped that way and were found only over CDP:
`shared/lang.ts` reading `process.env` in a module the bench imports, and `Pane.tsx`
constructing the terminal with `allowProposedApi: false` before loading the
Unicode11 addon, which is a proposed API. Both are fixed; the lang one is pinned by
a test that deletes `globalThis.process`, and the pane grid was verified live over
CDP against a running herdr session (one pane, task list, attention queue and
recovery panel all rendering).

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
- **Attach does not replay scrollback.** A pane shows output produced from
  the moment of attach; a terminal that keeps a backlog replays history at the
  user forever (`terminalBridge.ts`). An idle pane is therefore legitimately
  empty, and with WebGL active its DOM rows are empty too (two canvases carry
  the pixels) - neither is a bug. Proven live by typing `echo ...` into the pane
  with trusted CDP key events and watching the find bar count the matches.
- **Terminal output is untrusted.** It is the only string in the app we do not
  author, so links leave through the `openExternal` host op behind an
  http/https/mailto allow-list that runs in main.
- **Comment voice.** ASCII only, and a comment explains the failure mode being
  prevented rather than restating the line below it.

## 6. Known gaps, in the order they should be taken

1. **A renderer crash is a blank frame.** No error boundary and no renderer
   tests, so a mount-time throw leaves an empty window and a clean main log; see
   section 4 for the two that shipped and section 2 for the CDP recipe that sees
   the Bench without pixels. The smallest fix is an error boundary that prints the
   message in-window; the real one is a Playwright smoke that mounts `pro.html`.
2. **Free-text answers from the widget.** F7's "answer" and "reprompt" paths take
   a fixed verb; typing a real sentence into a bubble was deliberately deferred.
   The plumbing (`AttentionAction`, `agent.send_keys`) is there.
3. **No e2e smoke for the Bench.** Phase 3 in MVP.md asks for "manual + e2e
   smoke". There is no Playwright in this repo yet; the widget has none either.
4. **The hour of busy output has not been run.** Acceptance 6.5. The WebGL
   renderer has a fallback path for a lost context and for no WebGL at all, but
   neither the memory claim nor the fallback has been observed on real hardware.
5. **Pane-level spawn failures show raw errno.** Discovery explains a missing
   herdr in prose, but a bridge whose `spawn` throws ENOENT surfaces
   `spawn ... ENOENT` in the pane header tooltip.
6. **Timing flake.** One full-suite run in about six showed a single failure in
   `steer` or `matchaVoice`; both do real waiting and neither reproduced on
   rerun. Worth converting to a fake clock if it recurs.
7. **Docs.** `README.md` / `README.zh-CN.md` describe the 0.3.0 companion and
   never mention Pro. No screenshot of the Bench.
8. **macOS.** Nothing has been run there. The likely sharp edges are the menubar
   tray (a long `Open Bench (12)` label), `alwaysOnTop` interplay with the Bench
   window, and voice-runtime packaging via `npm run dist:mac`. The Cmd/Ctrl chord
   table itself is pure and tested on both.

## 7. 中文速览

- 跑起来：`npm install && npm run dev`，然后**托盘菜单 → Open Bench** 打开工作台。
  想让启动就打开，把 `~/.codewaifu/config.json` 里的 `pro.openBenchOnLaunch` 设为
  `true`。
- 提交前三道闸：`npm run typecheck && npx vitest run && npx electron-vite build`。
  没有 lint 脚本；`tsconfig.node.json` 开了 `noUnusedLocals`，多余 import 会直接红。
- 前提：机器上要有 herdr（这里验证用的是 0.9.0）。没有 herdr 时 Bench 会退化成安装
  引导卡片，不会崩。
- 数据落盘：`~/.codewaifu/pro/bench.json` 是任务注册表，`~/.codewaifu/pro/tasks/*.jsonl`
  是每个任务的意图账本（append-only + fsync）。GUI 是可丢弃的，重启后由这两样加
  herdr 现状重新推导。
- 状态：F1-F7 都已实现并有单测；本轮补齐了终端本身的质量（Unicode 11 宽字符、
  WebGL 渲染与降级、链接走系统浏览器、OSC 52 剪贴板、复制粘贴不抢 Ctrl+C、
  响铃指示、输出内搜索 Ctrl+Shift+F / macOS 上 Cmd+F），并修掉一个真 bug：
  resync 之后桥接进程会以每秒 4 次的速度无限重启。
- 命名会话：discovery 不猜会话名。`pro.herdrSession` 留空（或纯空白）时落到环境变量
  `HERDR_SESSION`；配置里写了名字（包括字面 `default`）就以配置为准。
- 这台机器上 dev 要加 `ELECTRON_DISABLE_SANDBOX=1`；正式版 companion 在跑时 dev 不起
  relay（`endpoint.env` 被占），要验 F6 先退正式版。
- 截图在这台机器拿不到：GNOME 的 Screenshot D-Bus 回 `AccessDenied`，`import`/`xwd`
  对 Electron 窗口只给空白像素。验 Bench 走 CDP：`npm run dev --
  --remote-debugging-port=9229`，对 `CodeWaifu Pro` 这个 target 做 `Runtime.evaluate`。
  两个白屏 renderer 崩溃（shared/lang.ts 读 `process.env`、Pane 的 `allowProposedApi`）
  就是这么抓到的，现已修复；pane 网格对着真实 herdr 会话验过渲染。
- 还没做：renderer 的错误边界与 e2e、浮窗里的自由文本回答、连续一小时高输出的内存
  实测、README 里的 Pro 章节、macOS 实机验证。
