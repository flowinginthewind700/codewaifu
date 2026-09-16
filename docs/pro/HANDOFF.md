# Pro handoff

`main` @ the tray fix: the push route and `pro watch` (F9), the bundled
terminal font, boot auto-resume, the RobotWorld palette, one app with two modes
(the stage and the bench switch into each other), import of foreign
codex/claude sessions into the tree, and a tray that works on Linux -
typecheck, 1091 tests (plus the 12 Windows-only skips), `electron-vite build`
and `npm run test:e2e` (10 cases, needs a display) all green on Linux (Ubuntu,
node 20+, herdr 0.9.0). Verified platform is Linux; macOS is built for but not
yet run.

The spec is [MVP.md](./MVP.md) and it is still the authority: F1-F7, the
acceptance criteria in section 6, the phases in section 7. This file is the
other half - how to run what exists, which decisions are settled, and what is
known to be missing. F8 and F9 in the table below are not in the spec: F8 is
what F6's "scripts and agents can drive the bench" became once somebody typed
it, and F9 is what the same feature's "push, never poll" became once a terminal
wanted to sit and watch.

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
opened from the tray menu**, whose bench row carries the attention count when it
is non-zero. On Linux a left click on the tray icon opens that menu: the
platform's tray is a D-Bus StatusNotifierItem, which delivers no click event,
and `Tray.popUpContextMenu` is a mac/Windows API - the published menu is the
whole interaction there. On mac and Windows the left click summons the stage and
the right click opens the menu. Two other doors exist: `pro.openBenchOnLaunch: true` in the
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
`tests/e2e/artifacts/bench.png`. Four of its ten cases drive the *built CLI*
instead of the window: they spawn `electron <repo> pro state` the way
`~/.local/bin/codewaifu` does after `install.sh`, against the same faked herdr
and their own `CODEWAIFU_HOME`, and then read what a terminal would read - the
tree, the recovery tab, and exit 3 with "not running" on stderr when that home
is empty. The fourth runs `pro watch` and sends it a real SIGINT once the tree
is on the pipe, because "a person stopped it" has to leave 0 and the only way to
learn that is to signal a child process rather than emit one in-process. It is
the only place argv routing, the endpoint handshake and the renderers exist as
one artefact rather than as three green unit suites.

All four share one `beforeAll` that waits for `pro state --json` to report
`view.herdr.online`. The Bench window paints from the registry on disk, so a
painted tree row says nothing about whether the bridge has finished connecting,
and the wait reads the same verb and the same projection the cases assert
through - a window locator would only prove the renderer believes it.

The gate is deliberately not inside `npm test`: a box with no X display would
fail it for a reason that has nothing to do with the code, and jsdom cannot load
a bundle, which is the only thing this gate is for.

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
| F8 terminal control surface | `shared/proCli.ts`, `main/pro/cli.ts`, `main/cliIo.ts` | `proCli`, `topBarCounts`, the built-CLI cases in gate four | done |
| F9 push route + `pro watch` | `main/server.ts` (`/pro/stream`), `main/probe.ts` (`streamNdjson`), `shared/proCli.ts` (`diffProViews` + the change renderers), `main/pro/cli.ts` (`runProWatch`), `main/pro/service.ts` (`onChange`) | `server`, `proCli`, `proService`, the ctrl-c case in gate four | done |

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

The third surface is a terminal (F8). `codewaifu pro <verb>` reads the
projection the window reads - `state`, `attention`, `recovery`, `log` - and acts
on it with the same verbs: `answer`/`approve`/`deny`/`snooze`, `new`, `adopt`,
`park`/`resume`/`done`/`rm`. It takes no `--cli` in front of it, because a
control surface you have to remember a flag to reach is not a control surface;
the installer verbs keep the flag, since `install.sh` already passes it and
`codewaifu install` reading as "install the app" is a confusion worth keeping.
All the thinking is in `shared/proCli.ts` (argv to typed call, payload to text)
and the three impure things are in `main/pro/cli.ts` plus `main/cliIo.ts` (the
endpoint file, HTTP to the relay, the two file descriptors), which is why the
verb table is unit-tested with no app running while the round trip is tested
against the real relay. Exit codes mirror the relay's status classes so `curl`
and `codewaifu pro` agree about what went wrong: 0 ok, 2 bad arguments,
3 nobody home, 4 no such task, 5 understood and refused, 6 the app did not
accept our token. "Nobody home" is four different sentences with four different
fixes (`offlineText`), and one of them is reached from a **404**: an app older
than the bench answers `no route`, which is not a task that does not exist and
must not send a script off to look for one. There are two timeouts rather than
one - 5s for a cached GET, 25s for a write - because a single number either cuts
off `pro new` provisioning a workspace on a cold herdr or makes `pro state`
hang. Width is clamped to 60-160 columns and the id column is *measured* from
the ids on screen (6-20, and an id past the ceiling is clipped with the gap
kept, so the row still reads as two things), since a fixed width either
truncates a herdr workspace id or pads every row by fourteen spaces. Ids come
out whole because an id you cannot copy is a command you cannot type.

The terminal can also sit and watch (F9). `codewaifu pro watch` (aliases `tail`
and `follow`) prints the tree once and then one line per change, and it is the
one verb that does not finish: it reads `GET /pro/stream`, the only route that
pushes, whose frames are the *same* payload `/pro/state` answers with plus a
`kind`, so there is no second projection free to drift and a script that
understands one understands the other. Frames come from `ProService.onChange`,
notified inside `emitState` where the signature dedupe already lives, so a pane
repainting several times a second is one frame rather than a firehose; `null`
arrives once on shutdown, because a watcher still printing the last tree after
the bench is gone is describing a world that no longer exists. The diff
(`diffProViews`) and its words (`renderProChange`) are in `shared/proCli.ts`
with the rest of the rendering, which leaves `runProWatch` the three impure
things a pure module may not be: a socket, two signals, one file descriptor. A
change line is clock, tag, subject, whole id - the id is what the next command
takes, so the title is what gives way. A bench that comes back reprints the tree
instead of announcing every task as an arrival, which is the honest reading of a
set difference and useless to the person watching. Pings are swallowed unless
`--json` is on, since one every twenty seconds is liveness for the socket and
printing it would fill the screen with lines saying nothing happened - the noise
a watcher exists to remove. Ctrl-c exits 0 and a stream that ends exits 3, so
`while codewaifu pro watch; do ...; done` can be written; `pro watch | head -40`
is handled too, because an EPIPE on stdout is otherwise an uncaught exception
thrown over the last line we printed.

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
- **A cache is keyed on its inputs, not only on the clock.** `recoveryPlans`
  memoizes for 2s because a plan costs a statSync per task, and for most of the
  projection a TTL is the whole key. Recovery is the exception: herdr's
  availability is an input to every verdict, so the memo also records the
  availability it was computed under and misses when that flips. A TTL alone let
  the plans computed while the bridge was down answer the rebuild the reconnect
  triggered, and on a quiet bench nothing asks again - so one frame carried both
  "herdr is online" and a plan saying herdr is not running, in the projection
  whose job is to be read right after a restart. `tests/proService.test.ts` pins
  both halves: the miss on a reconnect inside the window, and the hit that keeps
  a memo a memo.
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
- **The CLI has no `send-keys` either.** Same rule, third surface: a terminal
  answers the attention queue and files tasks, it does not drive a pane. A verb
  that types into an agent's shell is an unattended keystroke with nobody
  watching the screen it lands on, and the CLI is the surface most likely to be
  called from a cron job.
- **Recovery is read-only from the CLI.** `pro recovery` prints the verdict, the
  reason and the numbered steps; applying a plan stays in the Bench window.
  Applying creates workspaces, launches an agent and types a re-prompt into a
  pane, and `recoveryOp` records `source: 'gui'` as its provenance - a fact a
  terminal could only lie about.
- **The CLI renders the projection, it does not keep a second one.** `recovery`
  is the same `GET /pro/state` route as `state`, sliced differently, so the
  count in the `state` footer and the count in `recovery` cannot drift apart;
  the e2e case asserts both strings off one seeded task.
- **The stream carries that same payload, not a change event.** A `/pro/stream`
  frame is `/pro/state`'s body plus `kind`, which is why the terminal cannot be
  told something the window was not. The smaller design - a frame per change,
  shaped like the change - would have been a second projection with its own idea
  of what a task is called, and the diff is exactly the kind of thing two
  implementations of it disagree about at 2am.
- **The watcher asks for nothing.** `pro watch` never calls `/pro/state`: the
  route writes the first frame before it subscribes and every later frame
  arrives because the bench moved. The round trip asserts the fake's
  `viewCalls()` does not change, since a watcher that quietly polls between
  pushes would pass every rendering test and still be a poll.
- **No timeout on the stream, and no reconnect either.** `requestJson`'s 5s read
  budget would cut a quiet watcher off and report a fault where nothing went
  wrong, so `streamNdjson` arms no timer at all: liveness is the relay's ping
  and the socket's own close. What it deliberately does not do is reattach - a
  stream that ends is exit 3 with the reason on stderr and the restart is the
  shell's job. That is gap 4, not a decision anybody should defend.
- **The watcher cap is a leak guard, not a product limit.** `PRO_STREAM_MAX` is
  16 subscribers, each a socket written to on every change; the 429 says "close
  one" and the CLI turns it into exit 5, the code for "understood and refused"
  rather than the one for "broken".
- **A burst is capped at twelve lines and then points at the tree.** herdr
  reconnecting marks every task at once, and forty identical transitions scroll
  the one you wanted off the screen. The cap is not a lie about the bench,
  because all of it is one keystroke away.
- **An attention change names the task, not the ask.** One line has one subject
  slot, and every other one-line surface leads with the task title too (the
  queue head, the companion bubble); the ask is what `pro attention` prints. The
  item's own title is the fallback, because a line naming nothing is the one a
  watcher cannot act on.
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

1. **Timing flake, half fixed.** One full-suite run in about six used to show a
   single failure in `steer` or `matchaVoice`. `steer.test.ts` now drives
   `confirmDelivery` on a fake clock and asserts `vi.getTimerCount()` instead of
   wall-clock elapsed, because "no poll happened" is what a timer count says
   exactly and says the same way on a loaded box. `matchaVoice` still does real
   synthesis (2.5s a render), so it remains the candidate for an occasional red
   run that does not reproduce.

   Gate four looked like it had one of its own, and it did not: the recovery
   case that failed one run in three with `offline` where it expected `lost` was
   a real bug wearing a flake's clothes. `recoveryPlans` memoized on a 2s TTL
   and on nothing else, while herdr's availability is an input to every verdict
   (`planRecovery` answers `offline` whenever the bridge is down). So the plans
   computed while the bridge was still connecting were still "fresh" for the
   rebuild the reconnect triggered, and on a quiet bench nothing invalidates
   again: the recovery tab then says "herdr is not running" over a task that is
   merely lost, and keeps saying it. A trace harness is what settled the
   question - it printed `online=true verdict=offline` and held that for 33s,
   and a race does not settle into a state. Fixed by keying the memo on the
   availability it was computed under as well as on the clock (section 5), and
   pinned by `tests/proService.test.ts`, the first direct test of the service:
   the reconnect case goes red on the old condition, and the case beside it goes
   red on the lazy fix, which is recomputing every time. The `beforeAll` wait
   from section 3 stays, because the built-CLI cases should not depend on when
   the bridge finishes connecting, but it was never the fix: the failure
   reproduced once with the wait in place, and that is what turned a suspected
   race into a bug hunt.
2. **macOS.** Nothing has been run there. The release plan ships Linux and
   Windows from CI first and leaves the mac build to a human on a mac
   ([docs/RELEASE.md](../RELEASE.md)). What has been checked from this side of
   it: the darwin voice runtimes resolve at the pinned versions
   (`sherpa-onnx-darwin-arm64@1.13.8`, and the `x64` build), and so does the FFI
   layer - `koffi@3.2.1` with `@koromix/koffi-darwin-arm64@3.2.1`, while the
   registry's latest is 3.3.0, so it is the pin that has to keep resolving.
   `build/` holds `icon.png` and no `icon.icns`, which is fine: electron-builder
   converts the png through app-builder's icon command, so `dist:mac` needs no
   icons toolset. CI fetches each target's voice runtime
   (`ensure-voice-runtime.mjs` per matrix entry), which is what lets an arm64
   runner ship a speaking x64 zip. There is still no macOS autostart:
   `install.sh --autostart` writes only `~/.config/autostart`, and no LoginItems
   path exists. The likely sharp edges at runtime are the menubar tray (the
   bench row is a menu item now, so a long label is a menu width rather than a
   menubar width), `alwaysOnTop` interplay with the Bench window, and the
   packaged binary's argv handling, which is now what `codewaifu pro` stands on.
   The Cmd/Ctrl chord table itself is pure and tested on both.
3. **The tree projection has no test of its own.** `buildBench`, `deriveGroups`,
   `groupKeyFor`, `groupLabelFor` and `compareTasks` in `shared/pro.ts` are the
   grouping and ordering every surface reads through, and they are covered only
   indirectly: `proCli.test.ts` builds its fixtures *with* `buildBench` and
   asserts the rendered rows, so a change that moves a task between groups or
   reorders two states arrives as a diff in somebody else's expectation. A
   `proTree.test.ts` pinning the group key (repo root, else workdir), the label,
   the ordering and the counts is the cheapest gap on this list.
4. **`pro watch` does not reattach.** A stream that ends or breaks exits 3 with
   the reason on stderr, which is the right exit code and thin ergonomics for a
   terminal left open across a laptop suspend or an app restart: CodeWaifu comes
   back and the watcher is still gone, silently. `streamNdjson` already hands
   back a `closed` reason, so reconnecting with a backoff and reprinting the
   tree is a small change in `runProWatch` - it needs a retry ceiling and a line
   saying "the bench went away, retrying", because a watcher that reconnects
   without telling you hides the restart it just survived.

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
- 状态：F1-F9 都已实现并有单测（1045 passed / 12 skipped，skipped 是 Windows 专用）。
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
- 终端是第三个操作面（F8）：`codewaifu pro state / attention / recovery / log` 读的是
  窗口读的同一个投影，`answer / approve / deny / snooze / new / adopt / park / resume /
  done / rm` 走的是同一批动词，而且**不用加 `--cli`**——要记住一个 flag 才够得着的
  控制面板不算控制面板；install/uninstall 保留 flag，因为 `install.sh` 已经在传，而
  `codewaifu install` 读成「安装这个 app」是值得保留的歧义。纯逻辑全在
  `shared/proCli.ts`（argv → typed call、payload → 文本），三件脏事（读 endpoint 文件、
  对 relay 发 HTTP、两个 fd）在 `main/pro/cli.ts` + `main/cliIo.ts`，所以动词表能在没有
  app 的情况下单测，回路又能对着真 relay 测。
  退出码对齐 relay 的状态类，`curl` 与 CLI 对「哪儿出错了」口径一致：0 正常 / 2 参数错 /
  3 没人接 / 4 找不到 / 5 听懂了但拒绝 / 6 token 不被接受。「没人接」是四种不同说法配四种
  不同修法（`offlineText`），其中一种从 **404** 进来：比 bench 老的 app 回 `no route`，
  那不是「任务不存在」，不能把脚本支去找一个不存在的任务。
  两个超时而不是一个：GET 5s（读的是缓存投影）、写 25s（`pro new` 在冷 herdr 上要建
  workspace 再拉 agent）；一个数字要么掐死 new，要么让 state 挂着。宽度锁 60-160 列，
  id 列宽是**量出来的**（6-20，超上限的裁掉但保留那一格空隙，一行仍读作两个东西），因为
  定宽要么截断 herdr 的 workspace id，要么给每行白送十四个空格；id 必须整只出来——抄不
  下来的 id 就是打不出来的命令。
  两件永远不做的事：CLI 没有 `send-keys`（它回答注意力队列、登记任务，不开车）；
  `pro recovery` 只读，应用恢复计划留在 Bench 窗口——应用会建 workspace、拉 agent、往
  pane 里打 re-prompt，而 `recoveryOp` 记的 provenance 是 `source: 'gui'`，终端在这件
  事上只能撒谎。e2e 里三个新用例直接跑**打好的 CLI**（`electron <repo> pro state`，
  自己的 `CODEWAIFU_HOME`，对着同一个假 herdr），这是 argv 路由、endpoint 握手和渲染
  第一次作为一个产物被验，而不是三个各自绿的单测。
- 终端还能挂着看（F9）：`codewaifu pro watch`（别名 `tail` / `follow`）先打一遍树，之后
  **每个变化一行**，ctrl-c 退出且退出码是 0——「人停的」和「它坏了」（3）必须分得开，否则
  `while codewaifu pro watch; do ...; done` 没法写。它读的是唯一一条推送路由 `GET /pro/stream`，
  帧就是 `/pro/state` 的 body 再加一个 `kind`，所以没有第二份投影可以漂；变化由
  `ProService.onChange` 推，通知点在 `emitState` 里（签名去重已经在那儿，pane 每秒重绘也只是
  一帧），关机时推一次 `null`——bench 都没了还在打最后一棵树，是在描述一个不存在的世界。
  心跳 ping 只在 `--json` 下打出来：它是给 socket 的活性证明，不是给人的新闻，二十秒一行
  「什么也没发生」正是 watcher 要消掉的噪音。一帧最多 12 行，超了就指向 `pro state`（herdr
  重连会一次标记所有任务，四十行相同的迁移会把你要的那行冲走）；bench 回来时**重打整棵树**，
  而不是把每个任务报成「新增」。变化行是「时钟 + 标签 + 主体 + 完整 id」，标题让位、id 不让位，
  因为 id 是下一条命令的参数；注意力那行报的是**任务名**而不是问题原文（一行只有一个主体位，
  队列头和浮窗气泡也都以任务名开头，问题原文是 `pro attention` 的活）。429（超过 16 个
  watcher）走退出码 5，文案是「先关一个」。`pro watch | head -40` 也不会炸：stdout 的 EPIPE
  被接住了，否则它是一条压在最后一行输出上的未捕获异常。e2e 第四例给真子进程发 SIGINT，
  量的就是这个 0。
- 服务层终于有了自己的测试（`tests/proService.test.ts`，第一个直测 `ProService` 的文件；
  此前它只被第四道闸当成一个整体产物验）。钉的是一个真 bug：recovery 计划那份 2 秒 memo
  过去只按**时钟**判新鲜，而「herdr 在不在线」是每个 verdict 的输入，于是重连触发的那次
  重建拿到的还是离线时算出来的计划——同一帧里既写着 herdr 已连接、又写着「herdr 没在跑」，
  而安静的 bench 上不会再有人来问第二次。修法是把 memo 也按「算它时的在线状态」做键，
  两个用例分别钉住「窗口内重连必须重算」和「重算不能变成每次都算」。
  第四道闸里那个「偶发 `offline` 而不是 `lost`」因此**不是 race**：trace 打出
  `online=true verdict=offline` 并稳定保持 33 秒——race 不会稳定成一个状态。
- 终端字体随 app 走（`4bd382c`）：mono 栈以前把宿主装没装的家族排在前面，没装
  JetBrains Mono 的机器就静默落到 DejaVu——「字体好怪」的截图就是这么来的。更隐蔽的
  一半是 xterm 在 `open()` 那一刻用 canvas 量一次字形、而 canvas 解不开 `var(--mono)`：
  woff2 还没解析完就 open 的 pane 会**一辈子**留着 fallback 的格宽，换行柱跟 PTY 的宽度
  对不上，行就在词中间断。现在 `@fontsource/jetbrains-mono` 打进 bundle（两个 renderer
  入口都 import 它的 CSS），`terminalFontsReady()` 等 `document.fonts` 确认加载完才建
  Terminal；`tokens.css` 的 `--mono` 与 `terminalFont.ts::MONO_FALLBACK` 由单测钉成同一串。
- 重启即续工（`c3c987d`）：恢复计划以前只给人看、等人点，agent 就在 herdr 里干等。
  `pro.autoResumeOnBoot`（默认开）现在有人读了：boot 时 `armAutoResume` 拿
  `session.snapshot` 当门——只有真缺 pane/会话的任务才进计划，`applyPlans` 每轮 boot 至多
  应用一次、每个任务有上限，herdr 重连再挣一次机会，全好的 bench 一次都不碰；播报走界面
  语言（中文用全角标点）。执行体是 `main/pro/herdr/launcher.ts`：经 herdr 起/续 agent，
  失败是双语 `Failure {en,zh}`、跨重试粘住、`describe()` 本地化、日志记 `.en`。
  「不装 herdr」和「装了但拒绝」从此是两句话而不是同一句英文。
- 配色换成 RobotWorld（`7104b3a`）：粉 + 紫炭是两套眼睛的两套疲劳。`tokens.css` 现在是
  RobotWorld 的暗色系统（`surface.dark`/`card.dark`/发丝线/代码底 + slate 文字阶 +
  单一绿 accent），每个 accent 都带 `-rgb` 三元组，半透明用法不再旁边躺一个硬编码 rgba；
  `styles.css`、`pro/bench.css` 里粉/紫字面量清零（rg 可验），xterm 主题与搜索高亮用站点
  同一组语法色（注释灰/字符串琥珀/关键字紫/调用青），bench 窗口底色与 Linux 无合成器时的
  不透明底色同步换掉，首帧不闪紫。浮窗角色本身的腮红是角色设定，不动。
- 还没做：macOS 实机验证——darwin 侧能从这边核实的都核实了（语音运行时与 koffi 在
  registry 上按 pin 版本可解、`build/` 只有 `icon.png` 没有 `icon.icns`、并且**没有**
  macOS 自启动：`install.sh --autostart` 只写 `~/.config/autostart`，没有 LoginItems
  这条路）；以及给树的投影（`buildBench` / `deriveGroups` / `groupKeyFor` /
  `compareTasks`）补一个自己的 `proTree.test.ts`，现在它们只被 `proCli.test.ts` 当
  fixture 工厂间接覆盖。
  还有一条是 `pro watch` **不重连**：流断了就是退出码 3 加原因，重开是 shell 的事，所以
  笔记本合盖再打开、或者 app 重启之后，那个终端窗口会安静地停在过去（第 6 节缺口 4）。
