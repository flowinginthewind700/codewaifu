---
description: Remove CodeWaifu hooks and relay scripts, keeping backups of the agent configs
allowed-tools: Bash(curl:*), Bash(bash:*), Bash(powershell:*), Bash(CodeWaifu:*), Bash(codewaifu:*)
---

Uninstall CodeWaifu's agent integration.

1. Confirm with the user first: this removes the hooks from
   `~/.codex/hooks.json` and `~/.claude/settings.json` (both are backed up to
   `~/.codewaifu/backups` first) and deletes the relay runner scripts. Other
   tools' hook entries in those files are preserved.
2. Run `<app binary> --cli uninstall` while the app is still installed.
3. Ask whether the app bundle should go too; only then run the installer with
   `--uninstall --purge` (macOS/Linux) or `-Uninstall -Purge` (Windows).
4. Mention that the plugin itself can be removed separately with `/plugin`.
