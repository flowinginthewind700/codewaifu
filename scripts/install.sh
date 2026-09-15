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
#   --from PATH   install from a local artifact instead of downloading
#                 (.zip / .app / build dir on macOS, .AppImage / .deb / build dir on Linux)
#   --autostart   Linux: also drop a copy of the .desktop entry into ~/.config/autostart
#
# Linux notes: everything installs into the user's home (~/.local/share,
# ~/.local/bin, ~/.local/share/applications) so no sudo is involved. The
# tradeoff is the Chromium sandbox -- see linux_probe_sandbox below. Users who
# want a sandboxed companion should install the .deb with apt instead.
set -euo pipefail

REPO="${CODEWAIFU_REPO:-flowinginthewind700/codewaifu}"
TAG=""
UNINSTALL=0
PURGE=0
HOOKS_ONLY=0
LOCAL=""
AUTOSTART=0

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --hooks-only) HOOKS_ONLY=1 ;;
    --version) TAG="$2"; shift ;;
    --from) LOCAL="$2"; shift ;;
    --autostart) AUTOSTART=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"

# The asset-ranking rules live in scripts/lib/assets.sh and are unit tested
# there. Source them when this script is run from a checkout; a `curl | bash`
# run has no sibling files, and resolve_release_asset() below carries a
# fallback for exactly that case.
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]%/*}/lib/assets.sh" ]; then
  # shellcheck source=scripts/lib/assets.sh
  . "${BASH_SOURCE[0]%/*}/lib/assets.sh"
fi

# Newest published release tag, or nothing at all when the API refuses: the repo
# is private, no release has been published yet, or the anonymous rate limit is
# spent. The empty result matters -- under `set -euo pipefail` a failing curl in
# a command substitution aborts the whole installer with a bare
# `curl: (22) The requested URL returned error: 404`, and the actionable die()
# below never gets to run. Both platform paths share this.
latest_release_tag() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*: *"//; s/"//' || true
}

die_no_tag() {
  die "could not resolve a release tag for $REPO (no public release yet, or the GitHub API refused). Pin one with --version vX.Y.Z, or install a local artifact with --from PATH."
}

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) die "unsupported architecture: $ARCH" ;;
esac

APP_DIR=""
BINARY=""

# Where a user-space Linux install lives. Overridable for a CI smoke test that
# must not touch the real home directory.
LINUX_ROOT="${CODEWAIFU_LINUX_ROOT:-$HOME/.local/share/CodeWaifu}"
LINUX_BIN="${CODEWAIFU_LINUX_BIN:-$HOME/.local/bin}"
LINUX_APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

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
    # AppRun first, everywhere. It is electron-builder's own launcher and it
    # already probes for unprivileged user namespaces (`unshare -Ur true`),
    # adding --no-sandbox only when the kernel or AppArmor refuses them. On
    # Ubuntu 24.04+ that probe fails for an unconfined binary, so this is the
    # difference between a companion that starts and one that FATAL-aborts
    # before Node ever loads. The raw binary is the fallback for a deb (root
    # install: AppArmor profile + setuid helper make the sandbox work) or a
    # plain build directory.
    local root
    for root in "$LINUX_ROOT" /opt/CodeWaifu "$HOME/Applications/CodeWaifu"; do
      if [ -x "$root/AppRun" ]; then BINARY="$root/AppRun"; APP_DIR="$root"; return 0; fi
      if [ -x "$root/codewaifu" ]; then BINARY="$root/codewaifu"; APP_DIR="$root"; return 0; fi
    done
  fi
  return 1
}

run_cli() {
  [ -n "$BINARY" ] || die "no CodeWaifu app installed; drop --hooks-only or install the app first"
  local -a flags=()
  # AppRun decides for itself. A raw binary gets the flag only when the
  # install-time probe proved this kernel cannot sandbox it, and an explicit
  # CODEWAIFU_SANDBOX=1 always wins so a security-conscious user can see the
  # real Chromium error instead of a silent workaround.
  case "$BINARY" in
    */AppRun) ;;
    *)
      if [ -z "${CODEWAIFU_SANDBOX:-}" ] && [ -f "$(dirname "$BINARY")/.no-sandbox" ]; then
        flags+=(--no-sandbox)
      fi
      ;;
  esac
  CODEWAIFU_APP="$BINARY" "$BINARY" --cli "$@" ${flags+"${flags[@]}"}
}

# ---------------------------------------------------------------------------
# Linux
# ---------------------------------------------------------------------------

# List the asset names of a release tag, one per line.
release_asset_names() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/$1" \
    | grep -o '"name": *"[^"]*"' | sed 's/.*: *"//; s/"$//'
}

# Pick which asset to download from a newline-separated list of names, in the
# caller's preference order. `pick_asset` is the real implementation; the
# fallback spells out the names our own electron-builder.yml emits, because
# ${arch} expands per target (x86_64 for AppImage, amd64 for deb).
resolve_release_asset() {
  local names="$1"; shift
  local ext cand
  if declare -F pick_asset >/dev/null 2>&1; then
    printf '%s\n' "$names" | pick_asset "$OS" "$ARCH" "$@" && return 0
    return 1
  fi
  for ext in "$@"; do
    for cand in $(asset_spellings "$ext"); do
      if printf '%s\n' "$names" | grep -Fxq "$cand"; then printf '%s\n' "$cand"; return 0; fi
    done
  done
  return 1
}

asset_spellings() {
  case "$1:$ARCH" in
    AppImage:x64)   printf '%s\n' "CodeWaifu-${TAG#v}-linux-x86_64.AppImage" ;;
    AppImage:arm64) printf '%s\n' "CodeWaifu-${TAG#v}-linux-arm64.AppImage" ;;
    deb:x64)        printf '%s\n' "CodeWaifu-${TAG#v}-linux-amd64.deb" ;;
    deb:arm64)      printf '%s\n' "CodeWaifu-${TAG#v}-linux-arm64.deb" ;;
    zip:x64)        printf '%s\n' "CodeWaifu-${TAG#v}-mac-x64.zip" ;;
    zip:arm64)      printf '%s\n' "CodeWaifu-${TAG#v}-mac-arm64.zip" ;;
  esac
}

# Turn any Linux artifact into a plain directory tree at $1. The AppImage is
# extracted rather than mounted: FUSE is often missing or blocked (containers,
# some corporate images), and an extracted tree is what lets us ship a launcher,
# a .desktop entry and an icon without root.
linux_unpack() {
  local src="$1" dest="$2" stage
  mkdir -p "$dest"
  case "$src" in
    *.AppImage)
      chmod +x "$src" || true
      say "extracting the AppImage (no FUSE mount needed)"
      stage="$(mktemp -d)"
      # APPIMAGE_EXTRACT_AND_RUN makes the runtime fork instead of mounting, so
      # this works with no /dev/fuse at all.
      ( cd "$stage" && APPIMAGE_EXTRACT_AND_RUN=1 "$src" --appimage-extract >/dev/null ) \
        || die "could not extract $src"
      [ -d "$stage/squashfs-root" ] || die "extraction produced no squashfs-root"
      cp -a "$stage/squashfs-root/." "$dest/" || die "could not copy the extracted tree"
      rm -rf "$stage"
      ;;
    *.deb)
      command -v dpkg-deb >/dev/null 2>&1 || die "dpkg-deb is required to unpack a .deb"
      stage="$(mktemp -d)"
      dpkg-deb -x "$src" "$stage" || die "dpkg-deb could not unpack $src"
      [ -d "$stage/opt/CodeWaifu" ] || die "the .deb did not contain opt/CodeWaifu"
      cp -a "$stage/opt/CodeWaifu/." "$dest/" || die "could not copy the extracted tree"
      rm -rf "$stage"
      warn "a .deb unpacked into \$HOME loses the sandbox its postinst would have set up;"
      warn "for a sandboxed companion run: sudo apt install $src"
      ;;
    *)
      [ -d "$src" ] || die "unsupported Linux artifact: $src (.AppImage, .deb or a build directory)"
      [ -x "$src/codewaifu" ] || die "$src does not look like a CodeWaifu build directory"
      cp -a "$src/." "$dest/" || die "could not copy $src"
      ;;
  esac
  [ -x "$dest/codewaifu" ] || die "the installed tree has no executable codewaifu"
}

# Empirical sandbox probe. Ubuntu 23.10+ refuses unprivileged user namespaces
# to any binary not covered by an AppArmor profile, and Chromium then FATAL
# aborts with "The SUID sandbox helper binary was found, but is not configured
# correctly" -- before Node loads, so no amount of in-app code can fix it. The
# only cures are a launcher that passes --no-sandbox, or a root install that
# adds the profile and setuid helper.
#
# We ask the binary itself instead of parsing sysctls: `--cli help` needs no
# display, exits in well under a second, and its answer is about *this* kernel
# and *this* build. Skipped when AppRun is present, because electron-builder's
# launcher already runs the same check at every start.
linux_probe_sandbox() {
  local bin="$LINUX_ROOT/codewaifu" marker="$LINUX_ROOT/.no-sandbox" out
  [ -x "$LINUX_ROOT/AppRun" ] && return 0
  [ -x "$bin" ] || return 0
  rm -f "$marker"
  say "checking whether Chromium can start sandboxed here"
  out="$(CODEWAIFU_SANDBOX=1 "$bin" --cli help 2>&1)" || true
  if printf '%s' "$out" | grep -Eiq 'suid sandbox helper|no usable sandbox|namespace sandbox|Failed to move to new namespace'; then
    : > "$marker"
    warn "this kernel will not let Chromium start sandboxed, so the launcher will pass --no-sandbox."
    warn "to get the sandbox back, either:"
    warn "  sudo apt install ./CodeWaifu-*-linux-amd64.deb   (AppArmor profile + setuid helper)"
    warn "  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"
    warn "then remove $marker"
  fi
}

# Absolute path of the best icon in the installed tree, for Icon= in the
# .desktop file. A bare name would only resolve through the hicolor theme
# search, which a $HOME install is not part of.
linux_icon_path() {
  local candidate
  for candidate in \
    "$LINUX_ROOT/usr/share/icons/hicolor/1024x1024/apps/codewaifu.png" \
    "$LINUX_ROOT/usr/share/icons/hicolor/512x512/apps/codewaifu.png" \
    "$LINUX_ROOT/usr/share/icons/hicolor/256x256/apps/codewaifu.png" \
    "$LINUX_ROOT/codewaifu.png"
  do
    if [ -e "$candidate" ]; then readlink -f "$candidate" 2>/dev/null || printf '%s\n' "$candidate"; return 0; fi
  done
  # Last resort: any png the tree ships, biggest directory name first.
  candidate="$(find "$LINUX_ROOT" -maxdepth 6 -name 'codewaifu*.png' -type f 2>/dev/null | sort | tail -1)"
  [ -n "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  return 1
}

# The launcher on PATH. Mirrors the npm package's bin/codewaifu.mjs: no
# arguments starts the companion, a subcommand goes to --cli, and an explicit
# --flag is passed through untouched.
linux_cli_wrapper() {
  local target="$1"
  mkdir -p "$LINUX_BIN"
  cat > "$LINUX_BIN/codewaifu" <<EOF
#!/bin/sh
# Generated by codewaifu/scripts/install.sh; rewritten on every install.
APP="$target"
[ -x "\$APP" ] || { echo "codewaifu: \$APP is gone; re-run the installer" >&2; exit 1; }
# Written by the installer's sandbox probe. This kernel refuses unprivileged
# user namespaces, and Chromium aborts before any in-app code can react, so the
# flag has to come from the launcher. AppRun does the same check itself and
# needs no marker.
if [ -f "\$(dirname "\$APP")/.no-sandbox" ]; then set -- "\$@" --no-sandbox; fi
if [ "\$#" -eq 0 ]; then exec "\$APP"; fi
case "\$1" in
  --*|-*) exec "\$APP" "\$@" ;;
  *)      exec "\$APP" --cli "\$@" ;;
esac
EOF
  chmod +x "$LINUX_BIN/codewaifu"
}

linux_desktop_entry() {
  local exec_path="$1" icon="${2:-codewaifu}"
  mkdir -p "$LINUX_APPS"
  cat > "$LINUX_APPS/codewaifu.desktop" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=CodeWaifu
GenericName=Agent companion
Comment=Desktop companion for Codex and Claude Code
Exec="$exec_path" %U
TryExec="$exec_path"
Icon=$icon
Terminal=false
Categories=Development;Utility;
# Must match the binary name Electron derives WM_CLASS from, or the dock keeps a
# second generic launcher pinned while the companion is running.
StartupWMClass=codewaifu
StartupNotify=true
Keywords=codex;claude;agent;companion;live2d;
X-GNOME-UsesNotifications=true
EOF
  chmod 0644 "$LINUX_APPS/codewaifu.desktop"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$LINUX_APPS" >/dev/null 2>&1 || true
  fi
}

linux_autostart() {
  local dest="$HOME/.config/autostart"
  mkdir -p "$dest"
  cp "$LINUX_APPS/codewaifu.desktop" "$dest/codewaifu.desktop"
  say "will start on login ($dest/codewaifu.desktop)"
}

# A missing libgtk/libnss is the classic "double-clicked, nothing happened".
# Say which ones, and the one command that fixes the usual set.
linux_check_libs() {
  local bin="$1" missing
  command -v ldd >/dev/null 2>&1 || return 0
  missing="$(ldd "$bin" 2>/dev/null | awk '/not found/ { print $1 }' | sort -u)" || true
  [ -n "$missing" ] || return 0
  warn "missing shared libraries -- the companion will not start until they are installed:"
  printf '       %s\n' $missing >&2
  warn "on Ubuntu/Debian: sudo apt install libgtk-3-0t64 libnotify4 libnss3 libxss1 libxtst6 libatspi2.0-0t64 libsecret-1-0 libasound2t64"
}

linux_purge() {
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "$LINUX_ROOT/codewaifu" >/dev/null 2>&1 || true
    sleep 1
  fi
  rm -rf "$LINUX_ROOT"
  rm -f "$LINUX_APPS/codewaifu.desktop" "$LINUX_BIN/codewaifu" \
        "$HOME/.config/autostart/codewaifu.desktop"
  say "removed $LINUX_ROOT, the .desktop entry and $LINUX_BIN/codewaifu"
}

install_linux() {
  local launcher icon
  if [ -n "$LOCAL" ]; then
    [ -e "$LOCAL" ] || die "no such file or directory: $LOCAL"
    case "$LOCAL" in
      /*) ;;
      *)  LOCAL="$PWD/$LOCAL" ;;   # keep the path valid after we cd elsewhere
    esac
    linux_unpack "$LOCAL" "$LINUX_ROOT"
  else
    if [ -z "$TAG" ]; then
      say "looking up the latest release of $REPO"
      TAG="$(latest_release_tag)"
    fi
    [ -n "$TAG" ] || die_no_tag

    # AppImage first: it needs no root and its AppRun launcher handles the
    # sandbox. The deb is the fallback for a distro without FUSE-less tooling.
    local names asset
    names="$(release_asset_names "$TAG")" || die "could not list the assets of $TAG"
    [ -n "$names" ] || die "release $TAG lists no assets"
    asset="$(resolve_release_asset "$names" AppImage deb)" \
      || die "release $TAG has no Linux AppImage or deb for $ARCH"

    local tmp url
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    url="https://github.com/$REPO/releases/download/$TAG/$asset"
    say "downloading $asset ($TAG)"
    curl -fL --retry 3 -o "$tmp/$asset" "$url" || die "download failed: $url"
    linux_unpack "$tmp/$asset" "$LINUX_ROOT"
  fi

  # A previous instance holding the old files open makes an in-place replace
  # look like it worked while the running app keeps the old code.
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "$LINUX_ROOT/codewaifu" >/dev/null 2>&1 || true
    sleep 1
  fi

  linux_probe_sandbox
  linux_check_libs "$LINUX_ROOT/codewaifu"

  # Prefer AppRun: it re-runs the userns probe on every start, so a kernel or
  # AppArmor change is picked up without reinstalling.
  if [ -x "$LINUX_ROOT/AppRun" ]; then launcher="$LINUX_ROOT/AppRun"; else launcher="$LINUX_ROOT/codewaifu"; fi

  say "installing into $LINUX_ROOT"
  linux_cli_wrapper "$launcher"
  icon="$(linux_icon_path || true)"
  linux_desktop_entry "$launcher" "${icon:-codewaifu}"
  [ "$AUTOSTART" = "1" ] && linux_autostart

  BINARY="$launcher"
  APP_DIR="$LINUX_ROOT"
  case "$LINUX_BIN" in
    *:"$PATH":*|"$PATH":*|*:"$PATH") ;;
    *) warn "$LINUX_BIN is not on PATH; add it to shell rc: export PATH=\"$LINUX_BIN:\$PATH\"" ;;
  esac
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
    if [ "$PURGE" = "1" ] && [ "$OS" != "Darwin" ]; then
      linux_purge
    fi
  else
    warn "no installed app found; nothing to uninstall"
  fi
  exit 0
fi

# Split by platform rather than nested, so the macOS body below keeps its shape
# and each branch reads top to bottom on its own.
if [ "$HOOKS_ONLY" != "1" ] && [ "$OS" != "Darwin" ]; then
  case "$OS" in
    Linux) install_linux ;;
    *)     die "unsupported platform: $OS" ;;
  esac
fi

if [ "$HOOKS_ONLY" != "1" ] && [ "$OS" = "Darwin" ]; then

  if [ -n "$LOCAL" ]; then
    # Local artifact: same unpack + place + hook steps as a download, so a build
    # can be dogfooded through the exact path users take.
    [ -e "$LOCAL" ] || die "no such file or directory: $LOCAL"
    SRC_APP=""
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    case "$LOCAL" in
      *.app) SRC_APP="$LOCAL" ;;
      *.zip)
        say "unpacking $LOCAL"
        mkdir -p "$TMP/app"
        ditto -x -k "$LOCAL" "$TMP/app" 2>/dev/null || unzip -q "$LOCAL" -d "$TMP/app"
        SRC_APP="$TMP/app/CodeWaifu.app"
        [ -d "$SRC_APP" ] || SRC_APP="$(find "$TMP/app" -maxdepth 3 -name CodeWaifu.app -type d | head -1)"
        ;;
      *)
        SRC_APP="$(find "$LOCAL" -maxdepth 3 -name CodeWaifu.app -type d | head -1)"
        ;;
    esac
    [ -n "$SRC_APP" ] && [ -d "$SRC_APP" ] || die "could not find CodeWaifu.app in $LOCAL"
  elif [ -z "$TAG" ]; then
    say "looking up the latest release of $REPO"
    TAG="$(latest_release_tag)"
  fi

  if [ -z "$LOCAL" ]; then
    [ -n "$TAG" ] || die_no_tag

    ASSET="CodeWaifu-${TAG#v}-mac-$ARCH.zip"
    URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT

    say "downloading $ASSET ($TAG)"
    curl -fL --retry 3 -o "$TMP/$ASSET" "$URL" || die "download failed: $URL"
    mkdir -p "$TMP/app"
    ditto -x -k "$TMP/$ASSET" "$TMP/app" 2>/dev/null || unzip -q "$TMP/$ASSET" -d "$TMP/app"
    SRC_APP="$TMP/app/CodeWaifu.app"
    [ -d "$SRC_APP" ] || die "the archive did not contain CodeWaifu.app"
  fi

  APP_DIR="/Applications"
  if [ ! -w "$APP_DIR" ]; then
    APP_DIR="$HOME/Applications"
    mkdir -p "$APP_DIR"
    warn "/Applications is not writable; installing to $APP_DIR"
  fi

  osascript -e 'tell application "CodeWaifu" to quit' 2>/dev/null || true
  sleep 1

  say "installing into $APP_DIR"
  rm -rf "$APP_DIR/CodeWaifu.app"
  ditto "$SRC_APP" "$APP_DIR/CodeWaifu.app" 2>/dev/null || cp -R "$SRC_APP" "$APP_DIR/CodeWaifu.app"
  # Unsigned build: drop the quarantine flag so the first launch is not blocked.
  # /usr/bin/xattr explicitly — a pip-installed `xattr` shadows it on some
  # machines and that one has no -r, so the recursive clear silently fails.
  clear_quarantine() {
    local xbin
    for xbin in /usr/bin/xattr "$(command -v xattr || true)"; do
      [ -n "$xbin" ] && [ -x "$xbin" ] || continue
      "$xbin" -dr com.apple.quarantine "$APP_DIR/CodeWaifu.app" >/dev/null 2>&1 || true
    done
    # A missing attribute is not a failure, so only complain if it survived.
    if /usr/bin/xattr -p com.apple.quarantine "$APP_DIR/CodeWaifu.app" >/dev/null 2>&1; then
      warn "com.apple.quarantine is still set; right-click > Open if Gatekeeper blocks the launch"
    fi
  }
  clear_quarantine
  BINARY="$APP_DIR/CodeWaifu.app/Contents/MacOS/CodeWaifu"
fi

find_installed_app || die "app installed but the binary is not executable: ${BINARY:-?}"

say "registering agent hooks (Codex + Claude Code)"
run_cli install

if [ "$OS" = "Darwin" ]; then
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
else
  cat <<NEXT

Next steps
  1. open the companion:   codewaifu          (or find CodeWaifu in your app grid)
     it greets you out loud and parks itself in the tray.
  2. Codex gates third-party hooks behind a one-time trust prompt:
     open Codex, run /hooks, and trust the CodeWaifu entries.
     Claude Code needs nothing extra.
  3. check any time:       codewaifu status

Installed:  $LINUX_ROOT
Launcher:   $LINUX_BIN/codewaifu
Menu entry: $LINUX_APPS/codewaifu.desktop

No tray icon? GNOME needs an AppIndicator host:
  sudo apt install gnome-shell-extension-appindicator   (Ubuntu ships it enabled)
then log out and back in.

Uninstall:  curl -fsSL .../install.sh | bash -s -- --uninstall [--purge]
NEXT
fi
