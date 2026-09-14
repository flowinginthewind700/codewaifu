# CodeWaifu

[Landing page](https://robotworld.top/en/codewaifu) · [中文文档](README.zh-CN.md) · [Releases](https://github.com/flowinginthewind700/codewaifu/releases) · [MIT](LICENSE)

**A desktop companion that lives next to your coding agents.** CodeWaifu sits in
your menu bar as a small, draggable, always-on-top character. It listens to
Codex and Claude Code through their hook systems, speaks every event that needs
you out loud, keeps a live board of all your agent threads, lets you steer them
without leaving the keyboard, and drives your music player while you work.

![CodeWaifu companion](docs/assets/companion.png)

## Why

Long agent runs are silent. A build finishes, a permission request waits, a
thread goes idle - and you find out twenty minutes later, when you happen to
look. CodeWaifu turns those moments into a voice and a glance: a spoken line in
Chinese or English, a bubble above the character, and a thread list that shows
what every agent is doing right now.

## Features

- **Speaks your agents.** Hook events from Codex and Claude Code (session start,
  stop, permission request, notification, tool call, compaction, subagent,
  interrupt) become short spoken lines through the system TTS, with per-event
  toggles and a phrase pool so the same event never sounds identical twice.
- **Bilingual by default.** Language is auto-detected per message (one CJK
  character switches the voice), or pinned to Chinese / English in Settings.
- **A greeting, not a splash screen.** On launch the companion says something
  time-of-day appropriate, chosen at random from a pool.
- **Thread board.** Every Codex thread and Claude Code session with live status;
  steer a running Codex thread by queueing a message, or copy the message for
  agents without an injection API.
- **Media transport.** Play / pause / next / previous for the player that owns
  your system session (Music and Spotify on macOS, system media on Windows),
  with the current track shown in the panel.
- **A window that behaves.** Draggable anywhere, always-on-top, click-through
  when you want it ghosted, opacity and scale sliders, collapses to a 320px
  bubble and expands to a full panel with tabs.
- **Loopback only.** The relay binds `127.0.0.1`, every route except `/health`
  needs a per-install token, and the Host header is validated. No telemetry,
  no network egress, no sudo.

## Install

One line, macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/scripts/install.sh | bash
```

One line, Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/scripts/install.ps1 | iex
```

The installer downloads the latest release, places the app in `/Applications`
(or `%LOCALAPPDATA%\Programs\CodeWaifu`), registers the agent hooks with
backups, and prints what to do next. Re-running it repairs an install.

### Or install it from inside your agent

Claude Code, as a plugin:

```text
/plugin marketplace add flowinginthewind700/codewaifu
/plugin install codewaifu@codewaifu
```

then `/codewaifu:install`. Codex, as a skill:

```bash
mkdir -p ~/.codex/skills/codewaifu && curl -fsSL \
  https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/skills/codewaifu/SKILL.md \
  -o ~/.codex/skills/codewaifu/SKILL.md
```

After that, saying "install codewaifu" in either agent is enough: the skill and
the plugin commands both drive the same installer.

### First launch

1. Open the app. It greets you and parks in the menu bar (macOS) or tray
   (Windows).
2. Codex gates third-party hooks behind a one-time trust prompt: open Codex,
   run `/hooks`, and trust the CodeWaifu entries. Claude Code needs nothing.
3. Start an agent session. Stop events, permission requests and notifications
   now arrive as speech and bubbles.

Requirements: macOS 12+ or Windows 10+, and Codex CLI and/or Claude Code recent
enough to support hooks. Linux works for hooks and speech where a TTS backend
exists; media transport is macOS/Windows only.

## How it works

```text
Codex / Claude Code hook
        |  stdin = event JSON
        v
~/.codewaifu/hooks/run-hook.sh        fail-open: exit 0 on every path,
        |                             drains stdin, 2s timeout, and a /health
        |                             preflight so session data is never POSTed
        v                             to a port that is not CodeWaifu
loopback relay (127.0.0.1, token + Host check)
        |
        +--> event planner --> TTS queue --> system voice (zh / en)
        +--> bubble + thread board + media bar (renderer)
```

The relay address is published to `~/.codewaifu/endpoint.env` after the socket
is bound, and the runners re-read it on every hook. That is what makes the port
policy safe: the port may move at any time and no agent config needs editing.

### Port policy

1. **Pinned.** `CODEWAIFU_PORT` (or Settings with "pin port") is a promise: if
   the port is taken, CodeWaifu reports the conflict loudly instead of moving.
2. **Sticky.** Without a pin, the last working port is tried first, so firewall
   rules and muscle memory keep working.
3. **Kernel-assigned.** If that is taken by something else, `listen(0)` picks a
   free port and the move is announced in the UI and the log. Never fatal.

A second CodeWaifu instance detects the first through the endpoint file and
refuses to steal its port, saying so instead.

## CLI

The packaged binary doubles as a CLI, so installers and agents never reimplement
hook merging:

```bash
/Applications/CodeWaifu.app/Contents/MacOS/CodeWaifu --cli install     # register hooks
/Applications/CodeWaifu.app/Contents/MacOS/CodeWaifu --cli status      # app, relay, hooks
/Applications/CodeWaifu.app/Contents/MacOS/CodeWaifu --cli say hello   # speak now
/Applications/CodeWaifu.app/Contents/MacOS/CodeWaifu --cli uninstall   # remove hooks (backed up)
```

Every command accepts `--json` for scripting.

## Your data

Everything CodeWaifu writes lives in `~/.codewaifu` (Windows:
`%USERPROFILE%\.codewaifu`): `config.json`, `endpoint.env`, the generated hook
runners, `codewaifu.log`, and timestamped backups of every agent config it
touches. Hook merging is additive and idempotent; entries from other tools in
the same files are preserved byte-for-byte. Uninstall removes only CodeWaifu's
own entries.

## Development

```bash
npm install
npm run dev          # electron-vite dev with hot reload
npm test             # vitest, 188 tests incl. a live relay harness
npm run typecheck
npm run dist:mac     # or dist:win; artifacts land in release/
node --experimental-strip-types scripts/build-icon.mjs   # regenerate build/icon.png
```

The renderer is React + a hand-rolled CSS design system (no UI kit), the main
process is plain Node/Electron with no runtime dependencies, and the icon is
drawn from signed distance fields at build time - the repo stays text-only.

## Limitations, honestly

- Builds are unsigned for now, so macOS shows a Gatekeeper warning on first
  launch (the installer clears the quarantine flag) and Windows SmartScreen may
  ask once.
- Speech uses the OS voices; quality depends on what your system ships.
- Steer can queue into Codex threads; for Claude Code it copies the message to
  your clipboard, because there is no supported injection API.

## License

MIT - see [LICENSE](LICENSE).
