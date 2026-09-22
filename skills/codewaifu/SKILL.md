---
name: codewaifu
description: Install, repair, inspect or uninstall CodeWaifu, the desktop companion that speaks coding-agent events out loud, lists agent threads and steers them. Use when the user asks to install codewaifu, fix silent hooks, check the relay port, or remove it.
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
which merges hooks into every agent config it finds on the machine - Codex,
Claude Code, Cursor, Gemini CLI, Antigravity, Kimi CLI, ZCode, Kiro and Trae -
with backups - and writes a relay plugin for OpenCode and Pi, which have no hook
config at all.
An agent that is not installed gets nothing written. Never hand-edit those files
for this purpose; `--cli install` is idempotent and is also the repair path.

On Linux the user-space install lands in `~/.local/share/CodeWaifu` (extracted
AppImage tree), with a launcher at `~/.local/bin/codewaifu` and a desktop entry
in `~/.local/share/applications`. Nothing needs root; the `.deb` release asset is
the root-installed alternative at `/opt/CodeWaifu`.

Linux only, and expected: a user-space install cannot add an AppArmor profile or
a setuid sandbox helper, and Ubuntu 23.10+ sets
`kernel.apparmor_restrict_unprivileged_userns=1`, under which Chromium aborts
before any of our JavaScript runs. The installer detects that and marks the
install with `~/.local/share/CodeWaifu/.no-sandbox`, so the launcher passes
`--no-sandbox`; the log then reads `sandbox disabled (argv:--no-sandbox)`. That
warning is not a failure. To keep the Chromium sandbox instead, install the
`.deb` with `sudo apt install ./CodeWaifu-<ver>-linux-amd64.deb` (its postinst
adds the profile), or relax the sysctl - but do not chase the warning.

Then launch the app so the relay binds and the greeting plays: macOS
`open /Applications/CodeWaifu.app`, Linux
`setsid codewaifu >/dev/null 2>&1 < /dev/null &` (detached, or it dies with the
shell), Windows from the Start menu.

## Verify

`/Applications/CodeWaifu.app/Contents/MacOS/CodeWaifu --cli status`
(Windows: `%LOCALAPPDATA%\Programs\CodeWaifu\CodeWaifu.exe --cli status`).
On Linux use `codewaifu status` if the launcher is on `PATH`, otherwise
`~/.local/share/CodeWaifu/AppRun --cli status`. `--cli` still needs a display:
on a headless box wrap it in `xvfb-run -a`.

Healthy output: `app: running`, `relay: 127.0.0.1:<port>`, one aligned line per
agent - installed ones name their events, absent ones say so instead of
vanishing - and `runner: installed`. A `relay.conflict` note means the preferred
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
- Linux speaks nothing and the log names `espeak-ng`: install `espeak-ng` (the
  offline voice), and `playerctl` if the media transport buttons are dead (MPRIS).
- Linux shows no tray icon under GNOME: install
  `gnome-shell-extension-appindicator` - GNOME dropped legacy tray support, and
  the app only warns about it. The window itself is unaffected.
- Linux app exits at once with `platform failed to initialize`: no `DISPLAY`.
  Use a real session or `xvfb-run -a`.
- Linux missing shared libraries (`ldd ~/.local/share/CodeWaifu/codewaifu` shows
  `not found`): install `libgtk-3-0t64 libnss3 libasound2t64` (names vary by
  distro/release; `libasound2` before Ubuntu 24.04).
- Hooks fire but no bubble: the app was not running; events are not queued
  across launches by design.
- Log: `~/.codewaifu/codewaifu.log`.
