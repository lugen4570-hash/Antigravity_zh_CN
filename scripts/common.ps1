Set-StrictMode -Version Latest

function Write-I18nLog {
  param(
    [string]$BaseDir,
    [string]$Message
  )
  try {
    $logDir = Join-Path $BaseDir "logs"
    if (-not (Test-Path $logDir)) {
      New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Add-Content -Path (Join-Path $logDir "i18n.log") -Value $line -Encoding UTF8
  } catch {}
}

function Enter-I18nMutex {
  param([string]$Name = "Local\AntigravityI18nHeal")
  $createdNew = $false
  $mutex = New-Object System.Threading.Mutex($false, $Name, [ref]$createdNew)
  try {
    $acquired = $mutex.WaitOne(0, $false)
  } catch [System.Threading.AbandonedMutexException] {
    $acquired = $true
  }
  if (-not $acquired) {
    $mutex.Dispose()
    return $null
  }
  return $mutex
}

function Exit-I18nMutex {
  param($Mutex)
  if ($null -ne $Mutex) {
    try { $Mutex.ReleaseMutex() } catch {}
    try { $Mutex.Dispose() } catch {}
  }
}

function Test-FileLocked {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $false }
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $stream.Close()
    $stream.Dispose()
    return $false
  } catch {
    return $true
  }
}

function Test-TargetRunning {
  param([string]$ProcessName = "Antigravity")
  if ([string]::IsNullOrWhiteSpace($ProcessName)) { return $false }
  return $null -ne (Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Get-AsarPatchStatus {
  param(
    [string]$BaseDir,
    [string]$AsarPath
  )
  $patcher = Join-Path $BaseDir "patcher\asar-patch.mjs"
  if (-not (Test-Path $patcher) -or -not (Test-Path $AsarPath)) {
    return "missing"
  }
  $raw = & node $patcher status $AsarPath 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($raw)) {
    return "error"
  }
  try {
    return (($raw | ConvertFrom-Json).status)
  } catch {
    return "error"
  }
}

function Invoke-AsarPatchAndScan {
  param(
    [string]$BaseDir,
    [string]$AsarPath
  )
  $patcher = Join-Path $BaseDir "patcher\asar-patch.mjs"
  $scanner = Join-Path $BaseDir "scripts\scan-new-strings.mjs"
  $resDir = Split-Path -Parent $AsarPath
  $appDir = Split-Path -Parent $resDir
  $verFile = Join-Path $appDir "version"
  $ver = if (Test-Path $verFile) { (Get-Content $verFile -Raw).Trim() } else { "orig" }
  $backupPath = Join-Path $BaseDir "backups\app.asar.bak.$ver"

  $patchOut = & node $patcher patch $AsarPath --backup $backupPath 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "asar-patch failed: $patchOut"
  }
  Write-I18nLog -BaseDir $BaseDir -Message "Patched ASAR ($AsarPath): $patchOut"

  if (Test-Path $scanner) {
    try {
      & node $scanner $BaseDir $resDir | Out-Null
    } catch {
      Write-I18nLog -BaseDir $BaseDir -Message "Non-fatal scan warning: $_"
    }
  }
}

function Show-I18nToast {
  param(
    [string]$BaseDir,
    [string]$Title = "",
    [string]$Body = ""
  )
  try {
    if ([string]::IsNullOrEmpty($Title)) {
      $Title = [System.Text.RegularExpressions.Regex]::Unescape("Antigravity \u6c49\u5316\u52a9\u624b")
    }
    if ([string]::IsNullOrEmpty($Body)) {
      $Body = [System.Text.RegularExpressions.Regex]::Unescape("Antigravity \u5df2\u66f4\u65b0\uff0c\u5173\u95ed\u5e76\u91cd\u65b0\u6253\u5f00\u540e\u5c06\u81ea\u52a8\u6062\u590d\u4e2d\u6587\u754c\u9762")
    }
    $cfgPath = Join-Path $BaseDir "config.json"
    if (Test-Path $cfgPath) {
      $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
      if ($cfg.toastOnLock -eq $false) { return }
    }
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $escapedTitle = [System.Security.SecurityElement]::Escape($Title)
    $escapedBody = [System.Security.SecurityElement]::Escape($Body)
    $xmlStr = "<toast><visual><binding template='ToastGeneric'><text>$escapedTitle</text><text>$escapedBody</text></binding></visual></toast>"
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xmlStr)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
    # Use PowerShell AppUserModelId so toast displays without requiring custom Start Menu shortcut registration
    $appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  } catch {
    Write-I18nLog -BaseDir $BaseDir -Message "Toast fallback ($Title): $Body"
  }
}
