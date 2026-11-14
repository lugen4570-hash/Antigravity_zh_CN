param(
  [int]$OldPid = 0,
  [string]$AsarPath = (Join-Path $env:LOCALAPPDATA "Programs\antigravity\resources\app.asar"),
  [string]$ExePath = (Join-Path $env:LOCALAPPDATA "Programs\antigravity\Antigravity.exe"),
  [string]$OldHash = "",
  [string]$Relaunch = "0",
  [string]$BaseDir = (Join-Path $env:USERPROFILE ".antigravity-i18n"),
  [string]$ProcessName = "Antigravity",
  [switch]$SkipRelaunch,
  [int]$MaxWaitSeconds = 300
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\common.ps1"

$mutex = Enter-I18nMutex -TimeoutMs ($MaxWaitSeconds * 1000)
if ($null -eq $mutex) {
  Write-I18nLog -BaseDir $BaseDir -Message "Timed out waiting for i18n mutex."
  exit 1
}

try {
  Write-I18nLog -BaseDir $BaseDir -Message "Repatch bridge started (OldPid=$OldPid, Relaunch=$Relaunch)."

  $deadline = (Get-Date).AddSeconds($MaxWaitSeconds)

  # 1. Wait for old Antigravity process to exit
  if ($OldPid -gt 0) {
    while ((Get-Date) -lt $deadline) {
      $proc = Get-Process -Id $OldPid -ErrorAction SilentlyContinue
      if ($null -eq $proc) { break }
      Start-Sleep -Milliseconds 300
    }
  }

  # 2. Wait for NSIS installer to finish replacing app.asar (either hash changed or file unlocked & unpatched)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $AsarPath) {
      $locked = Test-FileLocked -Path $AsarPath
      if (-not $locked) {
        $curHash = (Get-FileHash -Path $AsarPath -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash
        $status = Get-AsarPatchStatus -BaseDir $BaseDir -AsarPath $AsarPath
        if ($status -eq "unpatched" -or ($OldHash -and $curHash -and $curHash -ne $OldHash)) {
          break
        }
      }
    }
    Start-Sleep -Milliseconds 500
  }

  # Give NSIS a brief moment to complete sibling bin files (e.g. language_server.exe)
  Start-Sleep -Milliseconds 600

  if (-not (Test-Path $AsarPath)) {
    Write-I18nLog -BaseDir $BaseDir -Message "ASAR missing after update wait: $AsarPath"
    exit 1
  }

  if ((Get-AsarPatchStatus -BaseDir $BaseDir -AsarPath $AsarPath) -ne "patched") {
    # Fallback Option A if a new unpatched Antigravity.exe raced ahead and locked app.asar
    if ((Test-FileLocked -Path $AsarPath) -or (Test-TargetRunning -ProcessName $ProcessName)) {
      Write-I18nLog -BaseDir $BaseDir -Message "New unpatched Antigravity running during repatch; waiting quietly after toast."
      Show-I18nToast -BaseDir $BaseDir
      while ((Test-FileLocked -Path $AsarPath) -or (Test-TargetRunning -ProcessName $ProcessName)) {
        Start-Sleep -Seconds 2
      }
    }
    if ((Get-AsarPatchStatus -BaseDir $BaseDir -AsarPath $AsarPath) -ne "patched") {
      Invoke-AsarPatchAndScan -BaseDir $BaseDir -AsarPath $AsarPath
    }
  }

  if ($Relaunch -eq "1" -and -not $SkipRelaunch) {
    if (-not (Test-TargetRunning -ProcessName $ProcessName) -and (Test-Path $ExePath)) {
      Write-I18nLog -BaseDir $BaseDir -Message "Relaunching patched Antigravity: $ExePath"
      Start-Process -FilePath $ExePath | Out-Null
    }
  }
} catch {
  Write-I18nLog -BaseDir $BaseDir -Message "Repatch bridge error: $_"
  exit 1
} finally {
  Exit-I18nMutex -Mutex $mutex
}
