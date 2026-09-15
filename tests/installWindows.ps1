# Runs one install.ps1 scenario in a child pwsh with the Windows-only cmdlets
# stubbed out (tests/stubs/installWindowsStubs.ps1), then asserts on what the
# installer actually did. The point is that the Windows install path stays
# testable on the ubuntu runners too, instead of only being exercised by
# whoever happens to have a Windows machine.
#
#   pwsh -NoProfile -File tests/installWindows.ps1 <scenario>
#
# Exits 0 when the scenario holds. vitest drives it (tests/installWindows.test.ts)
# and skips the whole file where pwsh is not installed.
#
# Known limit of the stand-in: $env:CODEWAIFU_APP points at a script, so the
# closing `--cli install` runs that instead of the packaged exe. A real .exe
# cannot be faked portably (a shebang'd CodeWaifu.exe runs on Linux and is a
# corrupt binary on Windows), so what is asserted about the payload is that the
# installer put files where it said it would.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Scenario)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
$installer = Join-Path $repo 'scripts/install.ps1'
$stubs = Join-Path $here 'stubs/installWindowsStubs.ps1'

$sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ('cw-win-' + [guid]::NewGuid().ToString('n'))
$fakeLocalAppData = Join-Path $sandbox 'appdata'
$tempDir = Join-Path $sandbox 'temp'
# The same path the installer computes for itself from LOCALAPPDATA. On a POSIX
# box the backslash is just part of one directory name, which is harmless here
# because both sides build it the same way.
$installRoot = Join-Path $fakeLocalAppData 'Programs\CodeWaifu'
$installedExe = Join-Path $installRoot 'CodeWaifu.exe'
$log = Join-Path $sandbox 'calls.log'
New-Item -ItemType Directory -Force -Path $sandbox, $fakeLocalAppData, $tempDir | Out-Null
Set-Content -LiteralPath $log -Value ''

# The installer ends by running the app it found. A script stands in for
# CodeWaifu.exe on every OS; it only has to exist and be callable, and it logs
# the arguments it was handed so a scenario can tell `--cli install` from
# `--cli uninstall`.
$fakeApp = Join-Path $sandbox 'fake-app.ps1'
Set-Content -LiteralPath $fakeApp -Value 'Add-Content -LiteralPath $env:CW_TEST_LOG -Value "app $($args -join '' '')"'

# Fixtures and switches a scenario needs before the installer runs.
$childArgs = @()
$plantApp = $true
switch ($Scenario) {
  'missing-tag' { $childArgs = @('-Version', 'v9.9.9') }
  'hooks-only' { $childArgs = @('-HooksOnly') }
  'uninstall' { $childArgs = @('-Uninstall') }
  'uninstall-nothing' {
    $childArgs = @('-Uninstall')
    # Nothing installed at all: the installer has to say so instead of guessing.
    $plantApp = $false
  }
  'uninstall-purge' {
    $childArgs = @('-Uninstall', '-Purge')
    # -Purge has to have something to remove.
    New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
    Set-Content -LiteralPath $installedExe -Value 'stub app'
  }
  'from-build-dir' {
    $buildDir = Join-Path $sandbox 'win-unpacked'
    $resources = Join-Path $buildDir 'resources'
    New-Item -ItemType Directory -Force -Path $resources | Out-Null
    Set-Content -LiteralPath (Join-Path $buildDir 'CodeWaifu.exe') -Value 'stub app'
    Set-Content -LiteralPath (Join-Path $resources 'app.asar') -Value 'stub asar'
    $childArgs = @('-From', $buildDir)
  }
  'from-missing' { $childArgs = @('-From', (Join-Path $sandbox 'nope')) }
}

# A child process, because install.ps1 calls `exit` and sets $ErrorActionPreference
# for the whole scope it is dot-sourced into.
$wrapper = Join-Path $sandbox 'run.ps1'
# Switch names stay bare: PowerShell binds a quoted `'-Version'` as a positional
# string, which lands in -From and turns the run into an install from a path
# called "v9.9.9".
$quoted = ($childArgs | ForEach-Object {
    if ($_.StartsWith('-')) { $_ } else { "'" + ($_ -replace "'", "''") + "'" }
  }) -join ' '
Set-Content -LiteralPath $wrapper -Value @"
`$ErrorActionPreference = 'Stop'
. '$stubs'
. '$installer' $quoted
# Under dot-sourcing `exit N` only unwinds the installer's scope and runs the
# code behind it; without this the child reports success for every failure.
# (A real `irm | iex` propagates the code by itself -- verified on pwsh 7.4.)
if (`$null -eq `$LASTEXITCODE) { exit 0 }
exit `$LASTEXITCODE
"@

$env:CW_TEST_SCENARIO = $Scenario
$env:CW_TEST_LOG = $log
$env:CW_TEST_INSTALL_ROOT = $installRoot
$env:LOCALAPPDATA = $fakeLocalAppData
$env:TEMP = $tempDir
$env:TMP = $tempDir
$env:CODEWAIFU_REPO = 'flowinginthewind700/codewaifu'
if ($plantApp) { $env:CODEWAIFU_APP = $fakeApp } else { Remove-Item Env:\CODEWAIFU_APP -ErrorAction SilentlyContinue }

$pwsh = (Get-Process -Id $PID).Path
$output = & $pwsh -NoProfile -NonInteractive -File $wrapper 2>&1 | Out-String
$status = $LASTEXITCODE

$script:failures = @()
function Check([bool]$ok, [string]$what) { if (-not $ok) { $script:failures += $what } }
function Said([string]$needle) { return [bool]($output -like "*$needle*") }
function Called([string]$needle) {
  return [bool](Select-String -LiteralPath $log -SimpleMatch -Pattern $needle -Quiet)
}
function Exists([string]$path) { return (Test-Path -LiteralPath $path) }

switch ($Scenario) {
  'setup-preferred' {
    Check ($status -eq 0) "expected exit 0, got $status"
    Check (Called 'get https://example.invalid/dl/CodeWaifu-0.3.0-win-x64-setup.exe') 'did not download the setup exe'
    Check (Called 'win-x64-setup.exe /S') 'did not run the downloaded installer silently'
    Check (Called 'app --cli install') 'never registered the agent hooks'
    Check (Exists $installedExe) 'no app in the install root'
    Check (@(Get-ChildItem -LiteralPath $tempDir).Count -eq 0) 'left the downloaded artifact in TEMP'
  }
  'portable-only' {
    Check ($status -eq 0) "expected exit 0, got $status"
    Check (Called 'get https://example.invalid/dl/CodeWaifu-0.3.0-win-x64-portable.exe') 'did not fall back to the portable build'
    Check (-not (Called 'start ')) 'ran a silent installer for a portable exe'
    Check (Exists (Join-Path $installRoot 'CodeWaifu-0.3.0-win-x64-portable.exe')) 'portable build was not placed in the install root'
    Check (Called 'app --cli install') 'never registered the agent hooks'
  }
  'foreign-only' {
    Check ($status -eq 1) "expected exit 1, got $status"
    Check (Said 'has no Windows x64 setup or portable artifact') "no asset complaint: $output"
    Check (-not (Called 'get ')) 'downloaded something from a release with no Windows asset'
  }
  'no-release' {
    Check ($status -eq 1) "expected exit 1, got $status"
    Check (Said 'could not resolve a release tag') "missing the actionable sentence: $output"
    Check (Said '-From') 'did not offer the local-artifact way out'
    Check (-not (Said 'WebException')) "leaked a raw exception: $output"
    Check (-not (Said 'At line')) "leaked a stack frame: $output"
    Check (-not (Exists $installRoot)) 'created an install root after giving up'
  }
  'missing-tag' {
    Check ($status -eq 1) "expected exit 1, got $status"
    Check (Said 'could not read release v9.9.9') "did not name the tag it could not read: $output"
    Check (Called 'releases/tags/v9.9.9') 'did not ask the API about the pinned tag'
  }
  'download-fails' {
    Check ($status -eq 1) "expected exit 1, got $status"
    Check (Said 'download failed: https://example.invalid/dl/CodeWaifu-0.3.0-win-x64-setup.exe') "no download complaint: $output"
  }
  'from-build-dir' {
    Check ($status -eq 0) "expected exit 0, got $status"
    Check (-not (Called 'rest ')) 'talked to the API despite -From'
    Check (-not (Called 'get ')) 'downloaded something despite -From'
    Check (Exists $installedExe) 'build tree was not copied'
    Check (Exists (Join-Path (Join-Path $installRoot 'resources') 'app.asar')) 'nested payload was not copied'
    Check (Called 'app --cli install') 'never registered the agent hooks'
  }
  'from-missing' {
    Check ($status -eq 1) "expected exit 1, got $status"
    Check (Said 'no such file or directory') "did not say the path is missing: $output"
  }
  'hooks-only' {
    Check ($status -eq 0) "expected exit 0, got $status"
    Check (-not (Called 'rest ')) '-HooksOnly resolved a release anyway'
    Check (-not (Called 'get ')) '-HooksOnly downloaded an artifact anyway'
    Check (Called 'app --cli install') 'never registered the agent hooks'
  }
  'uninstall' {
    Check ($status -eq 0) "expected exit 0, got $status"
    Check (Called 'app --cli uninstall') 'never removed the hooks'
    Check (-not (Called 'rest ')) 'resolved a release during an uninstall'
    Check (-not (Called 'get ')) 'downloaded an artifact during an uninstall'
    Check (Said 'backed up') 'did not mention the config backups'
  }
  'uninstall-purge' {
    Check ($status -eq 0) "expected exit 0, got $status"
    Check (Called 'app --cli uninstall') 'never removed the hooks'
    Check (-not (Exists $installRoot)) 'left the app behind after -Purge'
    Check (Said "removed $installRoot") "did not report the removal: $output"
  }
  'uninstall-nothing' {
    Check ($status -eq 0) "expected exit 0, got $status"
    Check (Said 'no installed app found') "did not say there is nothing to remove: $output"
    Check (-not (Called 'app ')) 'ran the CLI of an app that is not installed'
  }
  default {
    Check $false "unknown scenario: $Scenario"
  }
}

if ($script:failures.Count -gt 0) {
  foreach ($failure in $script:failures) { Write-Host "not ok - $failure" }
  Write-Host '--- installer output ---'
  Write-Host $output
  Write-Host '--- calls ---'
  if (Exists $log) { Get-Content -LiteralPath $log | ForEach-Object { Write-Host $_ } }
  Write-Host "--- sandbox kept at $sandbox"
  exit 1
}

Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "ok - $Scenario"
exit 0
