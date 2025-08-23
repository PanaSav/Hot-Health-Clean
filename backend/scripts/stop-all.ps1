<#
  stop-all.ps1
  Kill backend + ngrok processes by port
  Usage:
    .\scripts\stop-all.ps1
#>

function Kill-Port($port) {
  $pids = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
  if ($pids) {
    Write-Host "⚠ Killing processes on port $port ..." -ForegroundColor Yellow
    foreach ($pid in $pids) { Stop-Process -Id $pid -Force }
  }
}

Write-Host "→ Stopping backend + ngrok ..." -ForegroundColor Cyan

Kill-Port 4000   # backend default
Kill-Port 5000   # alt backend port
Kill-Port 4040   # ngrok web UI

# Also stop ngrok.exe process if it’s hanging without port binding
$ngrok = Get-Process ngrok -ErrorAction SilentlyContinue
if ($ngrok) {
  Write-Host "⚠ Killing ngrok.exe process ..." -ForegroundColor Yellow
  $ngrok | Stop-Process -Force
}

Write-Host "✅ Stopped backend + ngrok" -ForegroundColor Green
