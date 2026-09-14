#!/usr/bin/env bash
# CodeWaifu installer (macOS / Linux). Idempotent: re-running replaces the app
# and re-merges hooks without duplicating anything.
#
#   curl -fsSL https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/scripts/install.sh | bash
#
# Flags:
#   --uninstall   remove hooks + relay scripts (agent configs are backed up first)
#   --purge       with --uninstall, also delete the app bundle
#   --hooks-only  register hooks for an app that is already installed
#   --version vX  pin a release tag instead of the latest one
set -euo pipefail

REPO="${CODEWAIFU_REPO:-flowinginthewind700/codewaifu}"
TAG=""
UNINSTALL=0
PURGE=0
HOOKS_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --hooks-only) HOOKS_ONLY=1 ;;
    --version) TAG="$2"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) die "unsupported architecture: $ARCH" ;;
esac

APP_DIR=""
BINARY=""

find_installed_app() {
  if [ -n "${CODEWAIFU_APP:-}" ] && [ -x "${CODEWAIFU_APP}" ]; then
    BINARY="$CODEWAIFU_APP"; return 0
  fi
  if [ "$OS" = "Darwin" ]; then
    for dir in /Applications "$HOME/Applications"; do
      if [ -x "$dir/CodeWaifu.app/Contents/MacOS/CodeWaifu" ]; then
        BINARY="$dir/CodeWaifu.app/Contents/MacOS/CodeWaifu"; APP_DIR="$dir"; return 0
      fi
    done
  else
    for bin in /opt/CodeWaifu/codewaifu "$HOME/.local/share/CodeWaifu/codewaifu" "$HOME/Applications/CodeWaifu/codewaifu"; do
      if [ -x "$bin" ]; then BINARY="$bin"; return 0; fi
    done
  fi
  return 1
}

run_cli() {
  [ -n "$BINARY" ] || die "no CodeWaifu app installed; drop --hooks-only or install the app first"
  CODEWAIFU_APP="$BINARY" "$BINARY" --cli "$@"
}

if [ "$UNINSTALL" = "1" ]; then
  if find_installed_app; then
    say "removing hooks (configs are backed up to ~/.codewaifu/backups)"
    run_cli uninstall || warn "hook removal reported a problem"
    if [ "$PURGE" = "1" ] && [ "$OS" = "Darwin" ] && [ -n "$APP_DIR" ]; then
      osascript -e 'tell application "CodeWaifu" to quit' 2>/dev/null || true
      sleep 1
      rm -rf "$APP_DIR/CodeWaifu.app"
      say "removed $APP_DIR/CodeWaifu.app"
    fi
  else
    warn "no installed app found; nothing to uninstall"
  fi
  exit 0
fi

if [ "$HOOKS_ONLY" != "1" ]; then
  [ "$OS" = "Darwin" ] || die "automated app install is macOS-only for now; on Linux grab the AppImage from the release page, then re-run with --hooks-only"

  if [ -z "$TAG" ]; then
    say "looking up the latest release of $REPO"
    TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*: *"//; s/"//')"
  fi
  [ -n "$TAG" ] || die "could not resolve a release tag (is the repo public and does a release exist?)"

  ASSET="CodeWaifu-${TAG#v}-mac-$ARCH.zip"
  URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  say "downloading $ASSET ($TAG)"
  curl -fL --retry 3 -o "$TMP/$ASSET" "$URL" || die "download failed: $URL"

  APP_DIR="/Applications"
  if [ ! -w "$APP_DIR" ]; then
    APP_DIR="$HOME/Applications"
    mkdir -p "$APP_DIR"
    warn "/Applications is not writable; installing to $APP_DIR"
  fi

  osascript -e 'tell application "CodeWaifu" to quit' 2>/dev/null || true
  sleep 1

  say "unpacking into $APP_DIR"
  rm -rf "$TMP/app"
  mkdir -p "$TMP/app"
  ditto -x -k "$TMP/$ASSET" "$TMP/app" 2>/dev/null || unzip -q "$TMP/$ASSET" -d "$TMP/app"
  [ -d "$TMP/app/CodeWaifu.app" ] || die "the archive did not contain CodeWaifu.app"

  rm -rf "$APP_DIR/CodeWaifu.app"
  ditto "$TMP/app/CodeWaifu.app" "$APP_DIR/CodeWaifu.app" 2>/dev/null || cp -R "$TMP/app/CodeWaifu.app" "$APP_DIR/CodeWaifu.app"
  # Unsigned build: drop the quarantine flag so the first launch is not blocked.
  xattr -dr com.apple.quarantine "$APP_DIR/CodeWaifu.app" 2>/dev/null || true
  BINARY="$APP_DIR/CodeWaifu.app/Contents/MacOS/CodeWaifu"
fi

find_installed_app || die "app installed but the binary is not executable: ${BINARY:-?}"

say "registering agent hooks (Codex + Claude Code)"
run_cli install

cat <<'NEXT'

Next steps
  1. open the companion:   open /Applications/CodeWaifu.app   (or your install dir)
     it greets you out loud and parks itself in the menu bar / tray.
  2. Codex gates third-party hooks behind a one-time trust prompt:
     open Codex, run /hooks, and trust the CodeWaifu entries.
     Claude Code needs nothing extra.
  3. check any time:       codewaifu status   (or: CodeWaifu --cli status)

Uninstall:  curl -fsSL .../install.sh | bash -s -- --uninstall [--purge]
NEXT
