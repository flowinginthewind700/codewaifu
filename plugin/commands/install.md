---
description: Install or repair the CodeWaifu desktop companion and register its agent hooks
allowed-tools: Bash(curl:*), Bash(bash:*), Bash(powershell:*), Bash(pwsh:*), Bash(open:*), Bash(CodeWaifu:*), Bash(codewaifu:*)
---

Install (or repair) CodeWaifu, the desktop companion that speaks agent events
out loud, lists every Codex / Claude Code thread and steers them.

Steps, in order:

1. Detect the platform: `uname -s` on POSIX, `$PSVersionTable` on Windows.
2. Run the official installer, exactly one of:
   - macOS / Linux: `curl -fsSL https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/scripts/install.sh | bash`
   - Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1` after downloading it, or
     `irm https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/scripts/install.ps1 -OutFile $env:TEMP/cw.ps1; & $env:TEMP/cw.ps1`
   The installer is idempotent; re-running it repairs hooks and replaces the app.
3. Verify with `<app binary> --cli status` (macOS: `/Applications/CodeWaifu.app/Contents/MacOS/CodeWaifu --cli status`).
   Expect `runner: installed` and both agents listed with their events.
4. Launch the companion so the user hears the greeting:
   - macOS: `open /Applications/CodeWaifu.app`
   - Windows: start `CodeWaifu` from the Start menu (do not block on it).
5. Tell the user the two things only a human can do:
   - Codex gates third-party hooks behind a one-time trust prompt: open Codex,
     run `/hooks`, trust the CodeWaifu entries.
   - The companion window is draggable and always-on-top; the tray icon quits it.

Never edit `~/.codex/hooks.json` or `~/.claude/settings.json` by hand: the CLI
merges them and backs them up. If the installer fails, show its output verbatim
and stop; do not improvise a hook entry.
