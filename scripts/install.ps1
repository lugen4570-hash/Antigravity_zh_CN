param(
  [string]$SourceDir = (Split-Path -Parent $PSScriptRoot),
  [string]$BaseDir = (Join-Path $env:USERPROFILE ".antigravity-i18n"),
  [string]$AsarPath = (Join-Path $env:LOCALAPPDATA "Programs\antigravity\resources\app.asar"),
  [string]$ProcessName = "Antigravity",
  [switch]$SkipTaskRegister,
  [switch]$SkipPatch,
  [switch]$NoWait
)

$ErrorActionPreference = "Stop"

foreach ($sub in @("runtime", "dict", "patcher", "scripts", "logs", "backups")) {
  $dest = Join-Path $BaseDir $sub
  if (-not (Test-Path $dest)) {
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
  }
}

foreach ($sub in @("runtime", "dict", "patcher", "scripts")) {
  $srcPath = Join-Path $SourceDir $sub
  if (Test-Path $srcPath) {
    Copy-Item -Path (Join-Path $srcPath "*") -Destination (Join-Path $BaseDir $sub) -Recurse -Force
  }
}

$cfgDest = Join-Path $BaseDir "config.json"
$cfgSrc = Join-Path $SourceDir "config.default.json"
if (-not (Test-Path $cfgDest) -and (Test-Path $cfgSrc)) {
  Copy-Item -Path $cfgSrc -Destination $cfgDest -Force
}

if (-not $SkipTaskRegister) {
  $healScript = Join-Path $BaseDir "scripts\self-heal.ps1"
  $userId = "$env:USERDOMAIN\$env:USERNAME"
  $startBoundary = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
  $argStr = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$healScript`""
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Antigravity i18n self-heal check</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$([System.Security.SecurityElement]::Escape($userId))</UserId>
    </LogonTrigger>
    <SessionStateChangeTrigger>
      <Enabled>true</Enabled>
      <StateChange>SessionUnlock</StateChange>
      <UserId>$([System.Security.SecurityElement]::Escape($userId))</UserId>
    </SessionStateChangeTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT30M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>$startBoundary</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$([System.Security.SecurityElement]::Escape($userId))</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>$([System.Security.SecurityElement]::Escape($argStr))</Arguments>
    </Exec>
  </Actions>
</Task>
"@
  Register-ScheduledTask -TaskName "AntigravityI18nSelfHeal" -Xml $xml -Force | Out-Null
}

if (-not $SkipPatch -and (Test-Path $AsarPath)) {
  $healScript = Join-Path $BaseDir "scripts\self-heal.ps1"
  $healArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $healScript, "-BaseDir", $BaseDir, "-AsarPath", $AsarPath, "-ProcessName", $ProcessName)
  if ($NoWait) {
    $healArgs += "-NoWait"
    & powershell.exe @healArgs
  } else {
    Start-Process -FilePath "powershell.exe" -ArgumentList (@("-WindowStyle", "Hidden") + $healArgs) | Out-Null
  }
}

Write-Output "Deployed Antigravity i18n runtime to $BaseDir"
