param([int]$Port = 5173)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$logDir = Join-Path $projectDir 'server\data'
$logPath = Join-Path $logDir 'service.log'

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
Set-Location -LiteralPath $projectDir

$env:NODE_ENV = 'production'
$env:PORT = [string]$Port
$env:NODE_USE_ENV_PROXY = '1'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

# Use the current Windows proxy, so REST and WebSocket requests share its exit IP.
$target = [uri]'https://www.okx.com'
$proxy = [System.Net.WebRequest]::GetSystemWebProxy()
if (-not $proxy.IsBypassed($target)) {
  $proxyUrl = $proxy.GetProxy($target).AbsoluteUri.TrimEnd('/')
  $env:HTTPS_PROXY = $proxyUrl
  $env:HTTP_PROXY = $proxyUrl
}

while ($true) {
  try {
    & $nodeExe (Join-Path $projectDir 'server\index.js') 2>&1 | ForEach-Object {
      $_ | Out-File -FilePath $logPath -Append -Encoding utf8
    }
    $exitCode = $LASTEXITCODE
  } catch {
    $exitCode = 'launcher-error'
    "$(Get-Date -Format o) launcher error: $($_.Exception.Message)" | Out-File -FilePath $logPath -Append -Encoding utf8
  }
  "$(Get-Date -Format o) server exited ($exitCode); restarting in 5 seconds" | Out-File -FilePath $logPath -Append -Encoding utf8
  Start-Sleep -Seconds 5
}
