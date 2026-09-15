# Cmdlet stand-ins for the Windows-only surface install.ps1 touches. Dot-source
# this *before* the installer: PowerShell resolves a function already in scope
# ahead of the real cmdlet, so the installer's own control flow runs unchanged
# on any OS that has pwsh.
#
#   $env:CW_TEST_SCENARIO     picks the behaviour below
#   $env:CW_TEST_LOG          collects what the installer did, one call per line
#   $env:CW_TEST_INSTALL_ROOT where a stubbed NSIS run "unpacks" the app
#
# tests/installWindows.ps1 drives this and asserts on the log; it is not meant
# to be run on its own.

function Write-InstallerLog($msg) { Add-Content -LiteralPath $env:CW_TEST_LOG -Value $msg }

function Invoke-RestMethod {
  [CmdletBinding()]
  param($Uri, $Headers)
  Write-InstallerLog "rest $Uri"
  if ($env:CW_TEST_SCENARIO -eq 'no-release' -or $env:CW_TEST_SCENARIO -eq 'missing-tag') {
    # Exactly what GitHub answers for a repo with no published release, and what
    # $ErrorActionPreference = Stop turns into a wall of WebException.
    throw [System.Net.WebException]::new('The remote server returned an error: (404) Not Found.')
  }
  $names = switch ($env:CW_TEST_SCENARIO) {
    'portable-only' { @('CodeWaifu-0.3.0-win-x64-portable.exe', 'CodeWaifu-0.3.0-mac-arm64.zip') }
    'foreign-only'  { @('CodeWaifu-0.3.0-linux-x86_64.AppImage', 'CodeWaifu-0.3.0-mac-x64.zip', 'latest-linux.yml') }
    default         { @('CodeWaifu-0.3.0-win-x64-setup.exe', 'CodeWaifu-0.3.0-win-x64-portable.exe', 'CodeWaifu-0.3.0-linux-x86_64.AppImage') }
  }
  [pscustomobject]@{
    tag_name = 'v0.3.0'
    assets   = @($names | ForEach-Object {
      [pscustomobject]@{ name = $_; browser_download_url = "https://example.invalid/dl/$_" }
    })
  }
}

function Invoke-WebRequest {
  [CmdletBinding()]
  param($Uri, $OutFile, [switch]$UseBasicParsing)
  Write-InstallerLog "get $Uri"
  if ($env:CW_TEST_SCENARIO -eq 'download-fails') { throw [System.Net.WebException]::new('boom') }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
  Set-Content -LiteralPath $OutFile -Value 'stub payload'
}

function Start-Process {
  [CmdletBinding()]
  param($FilePath, [string[]]$ArgumentList, [switch]$Wait, [switch]$PassThru)
  Write-InstallerLog "start $FilePath $($ArgumentList -join ' ')"
  # Stand in for the silent NSIS run, whose only observable effect is the tree
  # it unpacks under %LOCALAPPDATA%\Programs\CodeWaifu.
  $dest = Join-Path $env:CW_TEST_INSTALL_ROOT 'CodeWaifu.exe'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
  Set-Content -LiteralPath $dest -Value 'stub app'
  [pscustomobject]@{ ExitCode = 0 }
}
