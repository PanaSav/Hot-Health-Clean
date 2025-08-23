<# 
  start-all.ps1
  Kills whatever is on the chosen port, starts the backend, starts ngrok, 
  fetches the public HTTPS URL, updates backend\.env (PUBLIC_BASE_URL=...), 
  then (optionally) opens your browser.

  Usage examples:
    Set-ExecutionPolicy -Scope Process Bypass -Force
    .\scripts\start-all.ps1
    .\scripts\start-all.ps1 -Port 5000 -NoBrowser
#>

[CmdletBinding()]
param(
  [int]$Port = 4000,
  [switch]$NoBrowser
)

function Kill-Port {
  param([int]$Port)
  $lines = netstat -ano | Select-String ":$Port\s"
  $pids = @()
  foreach ($l in $lines) {
    $t = ($l -split "\s+") | Where-Object { $_ -ne "" }
    if ($t.Length -ge 5 -and $t[-1] -match '^\d+$') { $pids += [int]$t[-1] }
  }
  $pids = $pids | Select-Object -Unique
  if ($pids.Count -gt 0) {
    Write-Host "⚠ Port $Port in use by PIDs: $($pids -join ', ')" -ForegroundColor Yellow
    foreach ($pid in $pids) {
      try { taskkill /PID $pid /F | Out-Null; Write-Host "✓ Killed $pid" -ForegroundColor Green } catch { Write-Host "… Couldn’t kill $pid" -ForegroundColor DarkYellow }
    }
  } else {
    Write-Host "✓ Port $Port is free" -ForegroundColor Green
  }
}

function Update-EnvValue {
  param(
    [string]$EnvPath,
    [string]$Key,
    [string]$Value
  )
  if (!(Test-Path $EnvPath)) { 
    Write-Host "Creating $EnvPath" -ForegroundColor Yellow
    "" | Out-File -Encoding utf8 $EnvPath
  }
  $content = Get-Content $EnvPath -Raw
  $pattern = "^\s*$Key\s*=\s*.*$"
  if ($content -match $pattern) {
    $new = ($content -split "`r?`n") | ForEach-Object {
      if ($_ -match $pattern) { "$Key=$Value" } else { $_ }
    }
    $new -join "`r`n" | Set-Content -Encoding utf8 $EnvPath
  } else {
    Add-Content -Encoding utf8 $EnvPath "`r`n$Key=$Value"
  }
  Write-Host "✓ Updated $Key in .env" -ForegroundColor Green
}

# --- Paths ---
$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)   # backend folder
Set-Location $root
Write-Host "📁 Working dir: $root" -ForegroundColor Cyan

# --- 1) Free the port ---
Kill-Port -Port $Port

# --- 2) Start backend ---
$env:PORT = "$Port"
Write-Host "🚀 Starting backend on port $Port ..." -ForegroundColor Cyan
$backend = Start-Process -PassThru -WindowStyle Minimized -FilePath "node" -ArgumentList "index.js" -WorkingDirectory $root
Start-Sleep -Seconds 2

# quick sanity check
try {
  $health = Invoke-WebRequest -Uri "http://localhost:$Port/healthz" -UseBasicParsing -TimeoutSec 4
  if ($health.StatusCode -ge 200 -and $health.StatusCode -lt 500) {
    Write-Host "✓ Backend responded at http://localhost:$Port" -ForegroundColor Green
  }
} catch {
  Write-Host "… Backend health check failed; continuing" -ForegroundColor DarkYellow
}

# --- 3) Start ngrok ---
Write-Host "🌐 Starting ngrok (http $Port) ..." -ForegroundColor Cyan
# Requires: ngrok installed and authed (`ngrok config add-authtoken <token>`)
$ng = Start-Process -PassThru -WindowStyle Minimized -FilePath "ngrok" -ArgumentList "http $Port"

# --- 4) Wait for public URL ---
$publicUrl = $null
for ($i=0; $i -lt 15; $i++) {
  try {
    $tunnels = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 3
    $pub = $tunnels.tunnels | Where-Object { $_.proto -eq "https" } | Select-Object -First 1
    if ($pub) { $publicUrl = $pub.public_url; break }
  } catch { }
  Start-Sleep -Milliseconds 800
}
if (-not $publicUrl) {
  Write-Host "⚠ Could not detect ngrok public URL (is ngrok installed & authed?)." -ForegroundColor Yellow
} else {
  Write-Host "✓ ngrok public URL: $publicUrl" -ForegroundColor Green
}

# --- 5) Update .env PUBLIC_BASE_URL ---
$envPath = Join-Path $root ".env"
if ($publicUrl) { Update-EnvValue -EnvPath $envPath -Key "PUBLIC_BASE_URL" -Value $publicUrl }

# --- 6) Open browser (optional) ---
if (-not $NoBrowser) {
  if ($publicUrl) {
    Start-Process $publicUrl
    $adminUrl = "$publicUrl/reports?password=$( [Uri]::EscapeDataString($env:ADMIN_PASSWORD ?? 'Hotest') )"
    Start-Process $adminUrl
  } else {
    Start-Process "http://localhost:$Port/"
    Start-Process "http://localhost:$Port/reports?password=Hotest"
  }
}

Write-Host ""
Write-Host "✅ All set." -ForegroundColor Green
Write-Host "Backend PID: $($backend.Id)  •  ngrok PID: $($ng.Id)" -ForegroundColor Gray
Write-Host "Stop everything with:  .\scripts\stop-all.ps1" -ForegroundColor Gray
