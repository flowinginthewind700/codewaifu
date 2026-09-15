#!/usr/bin/env bash
# Release-asset naming, in one place.
#
# electron-builder expands `${arch}` *per target*, so the same x64 build is
# published under three different spellings:
#
#   CodeWaifu-0.3.0-linux-x86_64.AppImage     (AppImage uses uname -m)
#   CodeWaifu-0.3.0-linux-amd64.deb           (deb uses the Debian arch)
#   CodeWaifu-0.3.0-win-x64-setup.exe         (nsis/portable use node's arch)
#
# An installer that hardcodes one spelling works on the day it is written and
# breaks the first time a target changes. So instead of matching we *rank*:
# every candidate name is scored on how well its os and arch tokens fit this
# machine, and sidecars and foreign architectures are rejected outright. Pure
# functions over strings, no network, so vitest can drive them.

# Extensions that are metadata about an asset, never the asset itself. A
# `.AppImage.blockmap` already fails the suffix check below; the list exists so
# a future rename cannot turn a 200-byte delta file into "the installer".
ASSET_SIDECAR_RE='\.(blockmap|sig|asc|sha256|sha512|yml|yaml|json|txt|md5|sum)$'

# Every architecture spelling any target may emit, so a name that carries one
# can be recognised and checked against what this machine actually is.
KNOWN_ARCH_TOKENS="x64 x86_64 amd64 arm64 aarch64 armv7 armv7l armhf i386 i686 x86 riscv64 ppc64el"

# Same idea for operating systems. A Windows `.exe` is otherwise a perfectly
# good match for `pick_asset Linux x64 exe`: right extension, right arch.
KNOWN_OS_TOKENS="mac macos darwin osx linux win windows win32"

# Canonical arch -> every spelling electron-builder or a mirror may use.
arch_aliases() {
  case "${1:-}" in
    x64)   printf '%s\n' x64 x86_64 amd64 ;;
    arm64) printf '%s\n' arm64 aarch64 ;;
    *)     printf '%s\n' "${1:-}" ;;
  esac
}

# os token(s) a name may carry for a given `uname -s`. mac zips and dmgs say
# `mac`, Windows says `win`; the long spellings are accepted because a
# hand-rolled or mirror-renamed asset may use them.
os_tokens() {
  case "${1:-}" in
    Darwin)  printf '%s\n' mac macos darwin osx ;;
    Linux)   printf '%s\n' linux ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) printf '%s\n' win windows win32 ;;
    *)       printf '%s\n' "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" ;;
  esac
}

# Does `$1` contain `$2` as a whole token? Tokens are separated by `-`, `.` or
# the string ends. `_` is deliberately NOT a separator: the only underscore in a
# release name is the one inside `x86_64`, and treating it as a boundary would
# let an i386 asset match an x64 one.
has_token() {
  local name="$1" token="$2"
  [ -n "$token" ] || return 1
  case "$name" in
    "$token"|"$token"-*|"$token".*) return 0 ;;
    *-"$token"|*-"$token"-*|*-"$token".*) return 0 ;;
    *."$token"|*."$token"-*|*."$token".*) return 0 ;;
  esac
  return 1
}

# The arch token a name carries, or empty (exit 1) when it carries none.
carried_arch() {
  local name="$1" token
  for token in $KNOWN_ARCH_TOKENS; do
    if has_token "$name" "$token"; then printf '%s\n' "$token"; return 0; fi
  done
  return 1
}

# The os token a name carries, or empty (exit 1) when it carries none.
carried_os() {
  local name="$1" token
  for token in $KNOWN_OS_TOKENS; do
    if has_token "$name" "$token"; then printf '%s\n' "$token"; return 0; fi
  done
  return 1
}

# pick_asset <uname-s> <arch> <ext> [ext...]   (names on stdin, one per line)
#
# Prints the best matching name, or nothing and exit 1. Extensions are a
# preference order: `pick_asset Linux x64 AppImage deb` takes the AppImage and
# only falls back to the deb when no AppImage exists. Ties break by ascending
# name, so a mirror that lists assets in a different order still installs the
# same file.
pick_asset() {
  local os="${1:-}" arch="${2:-}"
  shift 2 || true
  local exts=("$@")
  [ ${#exts[@]} -gt 0 ] || return 1

  local best_name="" best_score=-1
  local name ext token score carried ok i
  while IFS= read -r name; do
    name="${name#"${name%%[![:space:]]*}"}"   # trim leading space
    name="${name%"${name##*[![:space:]]}"}"   # trim trailing space
    [ -n "$name" ] || continue
    case "$name" in */*) name="${name##*/}" ;; esac  # tolerate URLs and paths
    [ -n "$name" ] || continue

    if printf '%s' "$name" | grep -Eiq "$ASSET_SIDECAR_RE"; then continue; fi

    score=0
    ext=""
    for i in "${!exts[@]}"; do
      case "$name" in
        *".${exts[$i]}") ext="${exts[$i]}"; score=$(( (${#exts[@]} - i) * 2 )); break ;;
      esac
    done
    [ -n "$ext" ] || continue

    # A foreign arch is a hard reject, not a low score: installing an arm64
    # build on x64 fails later with a confusing exec-format error.
    carried="$(carried_arch "$name")" || carried=""
    if [ -n "$carried" ]; then
      ok=0
      while IFS= read -r token; do
        [ "$carried" = "$token" ] && { ok=1; break; }
      done < <(arch_aliases "$arch")
      [ "$ok" = 1 ] || continue
      if [ "$carried" = "$arch" ]; then score=$((score + 6)); else score=$((score + 2)); fi
    else
      score=$((score + 1))   # no arch token: usable, but the least specific
    fi

    # A foreign os is a hard reject as well: `win-x64-setup.exe` matches both
    # the arch and the extension, so without this Linux would happily download
    # an installer that can never run, and fail on something that never
    # mentions the operating system.
    carried="$(carried_os "$name")" || carried=""
    if [ -n "$carried" ]; then
      ok=0
      while IFS= read -r token; do
        [ -n "$token" ] || continue
        [ "$carried" = "$token" ] && { ok=1; break; }
      done < <(os_tokens "$os")
      [ "$ok" = 1 ] || continue
      score=$((score + 20))
    fi

    if [ "$score" -gt "$best_score" ] ||
       { [ "$score" -eq "$best_score" ] && [ -n "$best_name" ] && [[ "$name" < "$best_name" ]]; }; then
      best_score="$score"; best_name="$name"
    fi
  done

  [ -n "$best_name" ] || return 1
  printf '%s\n' "$best_name"
}

# version_of_tag v0.3.0 -> 0.3.0   (asset names carry the bare version)
version_of_tag() { printf '%s\n' "${1#v}"; }
