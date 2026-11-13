param(
  [string]$BaseDir = (Join-Path $env:USERPROFILE ".antigravity-i18n"),
  [string]$AsarPath = (Join-Path $env:LOCALAPPDATA "Programs\antigravity\resources\app.asar"),
  [switch]$SkipTaskRemove,
  [switch]$RemoveData
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

if (-not $SkipTaskRemove) {
  try {
    Unregister-ScheduledTask -TaskName "AntigravityI18nSelfHeal" -Confirm:$false -ErrorAction SilentlyContinue
  } catch {}
}

$patcher = Join-Path $BaseDir "patcher\asar-patch.mjs"
if ((Test-Path $AsarPath) -and (Test-Path $patcher)) {
  if (Test-FileLocked -Path $AsarPath) {
    Write-Error "app.asar is currently locked by Antigravity. Please close Antigravity and re-run uninstall.ps1."
    exit 1
  }
  & node $patcher unpatch $AsarPath | Out-Null
}

if ($RemoveData -and (Test-Path $BaseDir)) {
  Remove-Item -Path $BaseDir -Recurse -Force
}

Write-Output "Uninstalled Antigravity i18n cleanly."
