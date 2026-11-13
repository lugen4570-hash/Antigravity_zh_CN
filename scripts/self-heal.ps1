param(
  [string]$BaseDir = (Join-Path $env:USERPROFILE ".antigravity-i18n"),
  [string]$AsarPath = (Join-Path $env:LOCALAPPDATA "Programs\antigravity\resources\app.asar"),
  [string]$ProcessName = "Antigravity",
  [switch]$NoWait
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

if (-not (Test-Path $AsarPath)) {
  exit 0
}

# Fast path before mutex if already patched
if ((Get-AsarPatchStatus -BaseDir $BaseDir -AsarPath $AsarPath) -eq "patched") {
  exit 0
}

$mutex = Enter-I18nMutex
if ($null -eq $mutex) {
  exit 0
}

try {
  if ((Get-AsarPatchStatus -BaseDir $BaseDir -AsarPath $AsarPath) -eq "patched") {
    exit 0
  }

  $locked = (Test-FileLocked -Path $AsarPath) -or (Test-TargetRunning -ProcessName $ProcessName)
  if ($locked) {
    Write-I18nLog -BaseDir $BaseDir -Message "Detected unpatched Antigravity while running/locked. Sending non-intrusive toast."
    Show-I18nToast -BaseDir $BaseDir
    if ($NoWait) {
      exit 0
    }
    # Release mutex while waiting so repatch-after-update.ps1 can take over if an update runs
    Exit-I18nMutex -Mutex $mutex
    $mutex = $null
    while ((Test-FileLocked -Path $AsarPath) -or (Test-TargetRunning -ProcessName $ProcessName)) {
      Start-Sleep -Seconds 2
    }
    $mutex = Enter-I18nMutex -TimeoutMs 10000
    if ($null -eq $mutex) {
      exit 0
    }
  }

  if ((Get-AsarPatchStatus -BaseDir $BaseDir -AsarPath $AsarPath) -ne "patched") {
    Invoke-AsarPatchAndScan -BaseDir $BaseDir -AsarPath $AsarPath
  }
} finally {
  Exit-I18nMutex -Mutex $mutex
}
