---
name: codewaifu
description: Install, repair, inspect or uninstall CodeWaifu, the desktop companion that speaks Codex/Claude Code events out loud, lists agent threads and steers them. Use when the user asks to install codewaifu, fix silent hooks, check the relay port, or remove it.
---

# CodeWaifu companion

CodeWaifu is a small Electron companion (menu bar / tray) that listens to agent
hooks over a loopback relay and speaks events with the system TTS. It also lists
every Codex and Claude Code thread and can steer them.

## Install / repair

Run the official installer; it is idempotent and safe to re-run:

- macOS / Linux: `curl -fsSL https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/scripts/install.sh | bash`
- Windows: download `scripts/install.ps1` from the repo and run
  `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1`

The installer downloads the latest release, puts the app in `/Applications`
(or `%LOCALAPPDATA%\Programs\CodeWaifu`), then runs `CodeWaifu --cli install`,
which merges hooks into `~/.codex/hooks.json` and `~/.claude/settings.json`
with backups. Never hand-edit those two files for this purpose.

Then launch the app (`open /Applications/CodeWaifu.app`) so the relay binds and
the greeting plays.

## Verify

`/Applications/CodeWaifu.app/Contents/MacOS/CodeWaifu --cli status`
(Windows: `%LOCALAPPDATA%\Programs\CodeWaifu\CodeWaifu.exe --cli status`).

Healthy output: `app: running`, `relay: 127.0.0.1:<port>`, both agents listed
with events, `runner: installed`. A `relay.conflict` note means the preferred
port was busy and the relay moved; that is normal and self-healing, because the
runners re-read `~/.codewaifu/endpoint.env` on every hook.

## Codex trust gate

Codex runs non-managed hooks only after a one-time confirmation: open Codex,
run `/hooks`, and trust the CodeWaifu entries. Until then Codex events stay
silent while Claude Code already works. Always mention this after installing.

## Uninstall

`<app binary> --cli uninstall` removes only CodeWaifu's hook entries (backups in
`~/.codewaifu/backups`). Add `--purge` through the installer to delete the app.

## Troubleshooting

- Nothing speaks: check `speak` and volume in the companion's Settings tab, and
  that the OS TTS voice for the chosen language exists.
- Hooks fire but no bubble: the app was not running; events are not queued
  across launches by design.
- Log: `~/.codewaifu/codewaifu.log`.
