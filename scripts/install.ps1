# CodeWaifu installer (Windows). Idempotent.
#
#   irm https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/scripts/install.ps1 | iex
#
# Switches:
#   -Uninstall [-Purge]  remove the hooks, and with -Purge the app as well
#                        (agent configs are backed up before anything is touched)
#   -HooksOnly           register hooks for an app that is already installed
#   -Version 'v0.3.0'    pin a release tag instead of the latest one
#   -From PATH           install from a local artifact instead of downloading:
#                        a *-setup.exe, a *-portable.exe, or a win-unpacked build dir
#
# A piped `iex` cannot take switches, so pass them through a script block:
#   iex "& { $(irm https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/scripts/install.ps1) } -Uninstall"
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$Purge,
  [switch]$HooksOnly,
  [string]$Version = '',
  [string]$From = ''
)
$ErrorActionPreference = 'Stop'
$Repo = if ($env:CODEWAIFU_REPO) { $env:CODEWAIFU_REPO } else { 'flowinginthewind700/codewaifu' }
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\CodeWaifu'
$Exe = Join-Path $InstallRoot 'CodeWaifu.exe'

function Say($msg) { Write-Host "== $msg" -ForegroundColor Magenta }

# stderr, not Write-Error: $ErrorActionPreference is Stop here, so Write-Error
# throws and the user gets a stack trace where one sentence would do.
function Fail($msg) { [Console]::Error.WriteLine("error: $msg"); exit 1 }

# electron-builder ships win x64 only. On ARM that build runs emulated, which
# works -- but say so, or a slow first launch reads as a bug.
$Arch = 'x64'
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  Write-Warning 'Windows on ARM: installing the x64 build, which runs emulated.'
}

# A running companion holds CodeWaifu.exe open, and Windows will not replace a
# mapped image in place.
function Stop-App {
  Get-Process -Name CodeWaifu -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 600
}

function Get-Release($tag) {
  $uri = "https://api.github.com/repos/$Repo/releases/latest"
  if ($tag) { $uri = "https://api.github.com/repos/$Repo/releases/tags/$tag" }
  # Swallow the failure and let the caller turn $null into a sentence. Under
  # $ErrorActionPreference = Stop a 404 -- exactly what a repo with no published
  # release answers -- otherwise surfaces as a WebException nobody can act on.
  # Same reasoning as latest_release_tag() in install.sh.
  try { return Invoke-RestMethod -Uri $uri } catch { return $null }
}

# Setup first: it writes the Start-menu shortcut and the uninstaller entry. The
# portable exe is the fallback for a machine that refuses even a per-user
# install. Names come from the release itself, so a renamed artifact or a future
# arm64 build cannot 404 the way a spelled-out filename does.
function Resolve-WinAsset($assets) {
  foreach ($suffix in @('setup.exe', 'portable.exe')) {
    $hits = @($assets | Where-Object { $_.name -like "*-win-$Arch-$suffix" })
    if ($hits.Count -gt 0) { return $hits[0] }
  }
  return $null
}

# One install path for a downloaded artifact and for -From, so a local build is
# dogfooded through exactly what a user runs. Returns the exe the caller should
# treat as the app: a portable install does not sit at the default location, and
# handing the path back beats mutating a script-scope variable from inside a
# function that may be running under `iex "& { ... }"`.
function Install-Artifact($path) {
  if (-not (Test-Path -LiteralPath $path)) { Fail "no such file or directory: $path" }
  $item = Get-Item -LiteralPath $path
  if ($item.PSIsContainer) {
    $built = Join-Path $item.FullName 'CodeWaifu.exe'
    if (-not (Test-Path -LiteralPath $built)) { Fail "$path is not a CodeWaifu build directory (no CodeWaifu.exe)" }
    Stop-App
    Say "copying the build tree into $InstallRoot"
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
    Get-ChildItem -LiteralPath $item.FullName -Force | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $InstallRoot -Recurse -Force
    }
    return $Exe
  } elseif ($item.Name -like '*-portable.exe') {
    # The portable target is one self-extracting file: there is no tree to
    # unpack, so it becomes the app and the hooks point straight at it.
    $dest = Join-Path $InstallRoot $item.Name
    Stop-App
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
    Say "placing the portable build at $dest"
    Copy-Item -LiteralPath $item.FullName -Destination $dest -Force
    return $dest
  } else {
    # NSIS cannot replace the files of a companion that is still running.
    Stop-App
    Say 'running the installer (silent)'
    $proc = Start-Process -FilePath $item.FullName -ArgumentList '/S' -Wait -PassThru
    if ($proc.ExitCode -ne 0) { Fail "the installer exited with $($proc.ExitCode)" }
    return $Exe
  }
}

function Find-App {
  if ($env:CODEWAIFU_APP -and (Test-Path -LiteralPath $env:CODEWAIFU_APP)) { return $env:CODEWAIFU_APP }
  if (Test-Path -LiteralPath $Exe) { return $Exe }
  return $null
}

if ($Uninstall) {
  $app = Find-App
  if ($app) {
    Say 'removing hooks (configs are backed up to %USERPROFILE%\.codewaifu\backups)'
    & $app --cli uninstall
    if ($Purge) {
      Stop-Process -Name CodeWaifu -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
      Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
      Say "removed $InstallRoot"
    }
  } else {
    Write-Warning 'no installed app found; nothing to uninstall'
  }
  exit 0
}

if (-not $HooksOnly) {
  if ($From) {
    $local = $From
    if (-not [System.IO.Path]::IsPathRooted($local)) { $local = Join-Path (Get-Location).Path $local }
    $Exe = Install-Artifact $local
  } else {
    $tag = $Version
    if (-not $tag) { Say "looking up the latest release of $Repo" }
    $release = Get-Release $tag
    if (-not $release) {
      if ($tag) { Fail "could not read release $tag of $Repo (is that tag published, and is the repo public?)" }
      Fail "could not resolve a release tag for $Repo (no public release yet, or the GitHub API refused). Pin one with -Version 'vX.Y.Z', or install a local artifact with -From PATH."
    }
    $tag = $release.tag_name
    $asset = Resolve-WinAsset $release.assets
    if (-not $asset) { Fail "release $tag has no Windows $Arch setup or portable artifact" }
    $url = $asset.browser_download_url
    if (-not $url) { $url = "https://github.com/$Repo/releases/download/$tag/$($asset.name)" }
    $tmp = Join-Path $env:TEMP $asset.name
    Say "downloading $($asset.name) ($tag)"
    try { Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing } catch { Fail "download failed: $url" }
    $Exe = Install-Artifact $tmp
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path -LiteralPath $Exe)) { Fail "nothing landed at $Exe" }
}

$app = Find-App
if (-not $app) { Fail "CodeWaifu.exe not found under $InstallRoot" }

Say 'registering agent hooks (Codex + Claude Code)'
$env:CODEWAIFU_APP = $app
& $app --cli install
# $LASTEXITCODE only means something after a native command, so treat null as
# "nothing reported a failure" rather than as one.
if ($LASTEXITCODE) { Fail "hook registration failed (exit $LASTEXITCODE)" }

@'

Next steps
  1. launch CodeWaifu from the Start menu or desktop shortcut; it greets you
     out loud and parks itself in the tray.
  2. Codex gates third-party hooks behind a one-time trust prompt: open Codex,
     run /hooks, and trust the CodeWaifu entries. Claude Code needs nothing.
  3. check any time:  codewaifu status

Uninstall:  iex "& { $(irm https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/scripts/install.ps1) } -Uninstall"
            (add -Purge to take the app with it)
'@
