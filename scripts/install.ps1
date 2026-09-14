# CodeWaifu installer (Windows). Idempotent.
#
#   irm https://raw.githubusercontent.com/flowinginthewind700/codewaifu/main/scripts/install.ps1 | iex
#
# Switches: -Uninstall [-Purge] | -HooksOnly | -Version 'v0.1.0'
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$Purge,
  [switch]$HooksOnly,
  [string]$Version = ''
)
$ErrorActionPreference = 'Stop'
$Repo = if ($env:CODEWAIFU_REPO) { $env:CODEWAIFU_REPO } else { 'flowinginthewind700/codewaifu' }
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\CodeWaifu'
$Exe = Join-Path $InstallRoot 'CodeWaifu.exe'

function Say($msg) { Write-Host "== $msg" -ForegroundColor Magenta }

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
  $tag = $Version
  if (-not $tag) {
    Say "looking up the latest release of $Repo"
    $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    $tag = $latest.tag_name
  }
  $asset = "CodeWaifu-$($tag.TrimStart('v'))-win-x64-setup.exe"
  $url = "https://github.com/$Repo/releases/download/$tag/$asset"
  $tmp = Join-Path $env:TEMP $asset
  Say "downloading $asset ($tag)"
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

  Say 'running the installer (silent)'
  $proc = Start-Process -FilePath $tmp -ArgumentList '/S' -Wait -PassThru
  if ($proc.ExitCode -ne 0) { throw "installer exited with $($proc.ExitCode)" }
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}

$app = Find-App
if (-not $app) { throw "CodeWaifu.exe not found under $InstallRoot" }

Say 'registering agent hooks (Codex + Claude Code)'
$env:CODEWAIFU_APP = $app
& $app --cli install

@'

Next steps
  1. launch CodeWaifu from the Start menu or desktop shortcut; it greets you
     out loud and parks itself in the tray.
  2. Codex gates third-party hooks behind a one-time trust prompt: open Codex,
     run /hooks, and trust the CodeWaifu entries. Claude Code needs nothing.
  3. check any time:  codewaifu status

Uninstall:  irm .../install.ps1 | iex -Uninstall [-Purge]   (run the file form to pass switches)
'@
