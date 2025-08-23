$ErrorActionPreference = "Stop"

function Ensure-Ngrok {
  $ngrokDir = "C:\ngrok"
  $ngrokExe = Join-Path $ngrokDir "ngrok.exe"

  if (Test-Path $ngrokExe) {
    Write-Host "ngrok already installed at $ngrokExe"
    return $ngrokExe
  }

  Write-Host "Downloading ngrok to $ngrokDir ..."
  if (!(Test-Path $ngrokDir)) { New-Item -ItemType Directory -Force -Path $ngrokDir | Out-Null }

  $zipPath = Join-Path $env:TEMP "ngrok.zip"
  Invoke-WebRequest -Uri "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip" -OutFile $zipPath

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $ngrokDir)

  Remove-Item $zipPath -Force
  if (!(Test-Path $ngrokExe)) { throw "ngrok.exe not found after extraction." }
  Write-Host "ngrok installed at $ngrokExe"
  return $ngrokExe
}

# Main
$exe = Ensure-Ngrok

# If no authtoken yet, prompt and save
try {
  $cfg = & $exe config check 2>$null
} catch { }

$authtokenFile = Join-Path $env:USERPROFILE ".ngrok2\authtoken.txt"
if (!(Test-Path $authtokenFile)) {
  Write-Host ""
  Write-Host "Get your authtoken at: https://dashboard.ngrok.com/get-started/your-authtoken"
  $token = Read-Host "Paste your ngrok authtoken"
  if ([string]::IsNullOrWhiteSpace($token)) { throw "Authtoken is required." }
  & $exe config add-authtoken $token
  New-Item -ItemType Directory -Force -Path (Split-Path $authtokenFile) | Out-Null
  Set-Content -Path $authtokenFile -Value $token
  Write-Host "Authtoken saved."
} else {
  Write-Host "Authtoken already present."
}

Write-Host ""
Write-Host "Setup complete. Next, run scripts\start-all.ps1"
