---
description: Show whether the CodeWaifu companion is running and which agent hooks are registered
allowed-tools: Bash(CodeWaifu:*), Bash(codewaifu:*), Bash(curl:*)
---

Report the CodeWaifu companion state.

1. Run `<app binary> --cli status` (macOS: `/Applications/CodeWaifu.app/Contents/MacOS/CodeWaifu --cli status`;
   Windows: `%LOCALAPPDATA%\Programs\CodeWaifu\CodeWaifu.exe --cli status`). Add `--json` if you need fields.
2. Summarise in a few lines: app running (version/pid), relay address and whether
   the port moved (`relay.reason` / `relay.conflict`), per-agent registered events,
   and any warnings.
3. If `appRunning` is false, say so plainly and offer to launch it
   (`open /Applications/CodeWaifu.app` or the Start menu shortcut).
4. If an agent shows `not installed`, offer `/codewaifu:install` to repair.

Do not modify any config in this command; it is read-only.
