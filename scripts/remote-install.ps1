param(
  [string]$ArchiveUrl = "https://github.com/JUN-Genyan/Antigravity_zh_CN/archive/refs/heads/main.zip",
  [string]$BaseDir = (Join-Path $env:USERPROFILE ".antigravity-i18n"),
  [string]$AsarPath = (Join-Path $env:LOCALAPPDATA "Programs\antigravity\resources\app.asar"),
  [string]$ProcessName = "Antigravity",
  [switch]$SkipTaskRegister,
  [switch]$SkipPatch,
  [switch]$NoWait
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js (>= 18) is required. Please install it from https://nodejs.org/ and run again."
}

$tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("antigravity-zh-cn-" + [Guid]::NewGuid().ToString("N"))
$zipPath = Join-Path $tmpRoot "repo.zip"
$extractDir = Join-Path $tmpRoot "src"

try {
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
  Write-Host "[1/3] Downloading Antigravity_zh_CN..." -ForegroundColor Cyan
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $ArchiveUrl -OutFile $zipPath -UseBasicParsing

  Write-Host "[2/3] Extracting package..." -ForegroundColor Cyan
  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

  $installScript = Get-ChildItem -Path $extractDir -Filter "install.ps1" -Recurse |
    Where-Object { $_.FullName -match "[\\/]scripts[\\/]install\.ps1$" } |
    Select-Object -First 1

  if (-not $installScript) {
    throw "Could not find scripts/install.ps1 inside downloaded archive."
  }

  $repoRoot = Split-Path -Parent $installScript.DirectoryName
  Write-Host "[3/3] Installing Antigravity Chinese localization..." -ForegroundColor Cyan

  $invokeParams = @{
    SourceDir   = $repoRoot
    BaseDir     = $BaseDir
    AsarPath    = $AsarPath
    ProcessName = $ProcessName
  }
  if ($SkipTaskRegister) { $invokeParams.SkipTaskRegister = $true }
  if ($SkipPatch) { $invokeParams.SkipPatch = $true }
  if ($NoWait) { $invokeParams.NoWait = $true }

  & $installScript.FullName @invokeParams
  Write-Host "Done! Restart Antigravity if it is currently open." -ForegroundColor Green
} finally {
  if (Test-Path $tmpRoot) {
    Remove-Item -Path $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
