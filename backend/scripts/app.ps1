<#
  app.ps1 — Unified control script for Hot Health backend + ngrok
  Usage:
    .\scripts\app.ps1 start [-Port 4000] [-NoBrowser]
    .\scripts\app.ps1 stop
    .\scripts\app.ps1 restart [-Port 4000] [-NoBrowser]
#>

param(
  [Parameter(Mandatory = $true, Position=0)]
  [ValidateSet("start", "stop", "restart")]
  [string]$Action,

  [int]$Port = 4000,
  [switch]$NoBrowser
)

# ===================== Helpers =====================

function Kill-Port($port) {
  try {
    $pids = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    if ($pids) {
      Write-Host "Killing processes on port $port ..." -ForegroundColor Yellow
      foreach ($pid in $pids) { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue }
    }
  } catch { }
}

function Stop-All {
  Write-Host "Stopping backend + ngrok ..." -ForegroundColor Cyan
  Kill-Port 4000       # common default
  Kill-Port 5000       # alt used in your setup
  Kill-Port 4040       # ngrok web UI
  Get-Process ngrok -ErrorAction SilentlyContinue | ForEach-Object {
    try { Stop-Process -Id $_.Id -Force } catch { }
  }
  Write-Host "Stopped." -ForegroundColor Green
}

function Read-EnvValue([string]$EnvPath, [string]$Key, [string]$Default="") {
  if (!(Test-Path $EnvPath)) { return $Default }
  $content = Get-Content $EnvPath -Raw
  $lines = $content -split "`r?`n"
  foreach ($line in $lines) {
    if ($line -match "^\s*$Key\s*=\s*(.*)$") {
      $val = $matches[1].Trim()
      return $val
    }
  }
  return $Default
}

function Update-EnvValue([string]$EnvPath, [string]$Key, [string]$Value) {
  if (!(Test-Path $EnvPath)) { "" | Out-File -Encoding utf8 $EnvPath }
  $content = Get-Content $EnvPath -Raw
  $pattern = "^\s*$Key\s*=.*$"
  if ($content -match $pattern) {
    $new = ($content -split "`r?`n") | ForEach-Object {
      if ($_ -match $pattern) { "$Key=$Value" } else { $_ }
    }
    ($new -join "`r`n") | Set-Content -Encoding utf8 $EnvPath
  } else {
    Add-Content -Encoding utf8 $EnvPath "`r`n$Key=$Value"
  }
}

function Start-Backend([int]$PortToUse) {
  $env:PORT = "$PortToUse"   # override for this spawned process
  Write-Host "Starting backend on port $PortToUse ..." -ForegroundColor Cyan
  Start-Process -NoNewWindow -FilePath "node" -ArgumentList "index.js" -WorkingDirectory $PSScriptRoot\.. | Out-Null
  Start-Sleep -Seconds 2
}

function Start-Ngrok([int]$PortToUse) {
  # Adjust path if your ngrok.exe is elsewhere
  $ngrokCmd = "ngrok"
  Write-Host "Starting ngrok tunnel (http $PortToUse) ..." -ForegroundColor Cyan
  Start-Process -NoNewWindow -FilePath $ngrokCmd -ArgumentList "http $PortToUse" | Out-Null
  Start-Sleep -Seconds 2
}

function Get-NgrokPublicUrl {
  # Try for up to ~12 seconds
  for ($i=0; $i -lt 20; $i++) {
    try {
      $tunnels = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 3
      $pub = $tunnels.tunnels | Where-Object { $_.proto -eq "https" } | Select-Object -First 1
      if ($pub) { return $pub.public_url }
    } catch { }
    Start-Sleep -Milliseconds 600
  }
  return $null
}

function Open-Links([string]$BaseUrl, [string]$AdminPw, [switch]$NoBrowserSwitch) {
  $rootUrl  = $BaseUrl
  $adminUrl = "$BaseUrl/reports?password=$( [Uri]::EscapeDataString($AdminPw) )"
  Write-Host ""
  Write-Host "Ready:" -ForegroundColor Green
  Write-Host "  App:    $rootUrl"  -ForegroundColor Gray
  Write-Host "  Admin:  $adminUrl" -ForegroundColor Gray
  if (-not $NoBrowserSwitch) {
    Start-Process $rootUrl
    Start-Process $adminUrl
  }
}

# ===================== Main =====================

# backend folder (one level up from scripts\)
$backendRoot = Split-Path -Parent $PSScriptRoot
Set-Location $backendRoot

$envPath = Join-Path $backendRoot ".env"
$adminPw = Read-EnvValue -EnvPath $envPath -Key "ADMIN_PASSWORD" -Default "Hotest"

switch ($Action) {
  "stop" {
    Stop-All
    break
  }
  "start" {
    # free ports
    Kill-Port $Port
    Kill-Port 4040

    # start services
    Start-Backend -PortToUse $Port
    Start-Ngrok   -PortToUse $Port

    # determine base URL
    $publicUrl = Get-NgrokPublicUrl
    if ($publicUrl) {
      Update-EnvValue -EnvPath $envPath -Key "PUBLIC_BASE_URL" -Value $publicUrl
      Open-Links -BaseUrl $publicUrl -AdminPw $adminPw -NoBrowserSwitch:$NoBrowser
    } else {
      $fallback = "http://localhost:$Port"
      Open-Links -BaseUrl $fallback -AdminPw $adminPw -NoBrowserSwitch:$NoBrowser
      Write-Host "Note: Ngrok public URL not detected. Is ngrok installed & authed?" -ForegroundColor Yellow
    }
    break
  }
  "restart" {
    Stop-All
    Start-Sleep -Seconds 2
    # free ports again just in case
    Kill-Port $Port
    Kill-Port 4040

    Start-Backend -PortToUse $Port
    Start-Ngrok   -PortToUse $Port

    $publicUrl = Get-NgrokPublicUrl
    if ($publicUrl) {
      Update-EnvValue -EnvPath $envPath -Key "PUBLIC_BASE_URL" -Value $publicUrl
      Open-Links -BaseUrl $publicUrl -AdminPw $adminPw -NoBrowserSwitch:$NoBrowser
    } else {
      $fallback = "http://localhost:$Port"
      Open-Links -BaseUrl $fallback -AdminPw $adminPw -NoBrowserSwitch:$NoBrowser
      Write-Host "Note: Ngrok public URL not detected. Is ngrok installed & authed?" -ForegroundColor Yellow
    }
    break
  }
}
