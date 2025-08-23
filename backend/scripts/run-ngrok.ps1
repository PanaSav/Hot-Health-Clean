$ErrorActionPreference = "Stop"

function Get-NgrokExe {
  $candidates = @(
    "C:\ngrok\ngrok.exe",
    "$env:ProgramFiles\ngrok\ngrok.exe",
    "$env:USERPROFILE\ngrok\ngrok.exe"
  )
  foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
  throw "ngrok.exe not found. Run scripts\setup-ngrok.ps1 first."
}

function Start-Ngrok {
  param([string]$NgrokExe, [int]$Port = 4000)
  Start-Process -FilePath $NgrokExe -ArgumentList @("http", "$Port") -WindowStyle Minimized
  Write-Host "Starting ngrok tunnel to http://localhost:$Port ..."
}

function Get-NgrokPublicUrl {
  Write-Host "Waiting for ngrok public URL..."
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $resp = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -UseBasicParsing -TimeoutSec 3
      foreach ($t in $resp.tunnels) {
        if ($t.public_url -like "https://*") { return $t.public_url }
      }
    } catch { Start-Sleep -Milliseconds 500 }
    Start-Sleep -Milliseconds 500
  }
  throw "Timed out waiting for ngrok public URL."
}

function Update-EnvFile {
  param([string]$PublicUrl)
  $envPath = Join-Path (Split-Path -Parent $PSScriptRoot) ".env"
  if (!(Test-Path $envPath)) { throw "Cannot find backend\.env at $envPath" }

  $lines = Get-Content $envPath
  $found = $false
  $newLines = @()
  foreach ($line in $lines) {
    if ($line -match '^\s*PUBLIC_BASE_URL\s*=') {
      $newLines += "PUBLIC_BASE_URL=$PublicUrl"
      $found = $true
    } else {
      $newLines += $line
    }
  }
  if (-not $found) { $newLines += "PUBLIC_BASE_URL=$PublicUrl" }

  Set-Content -Path $envPath -Value ($newLines -join "`r`n") -Encoding UTF8
  Write-Host "Updated backend\.env PUBLIC_BASE_URL=$PublicUrl"
}

$exe = Get-NgrokExe
Start-Ngrok -NgrokExe $exe -Port 4000
$pub = Get-NgrokPublicUrl
Write-Host "ngrok public URL: $pub"
Update-EnvFile -PublicUrl $pub
Write-Host ""
Write-Host "Open on phone: $pub"
