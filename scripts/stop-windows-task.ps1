$ErrorActionPreference = 'Stop'
$taskName = 'RSI-Bottom-Fishing-System'
$projectDir = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $projectDir 'server\index.js'
$port = 5173

try {
  $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/scan/status" -TimeoutSec 3
  if ($status.scan.running) {
    Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/scan/stop" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
  }
} catch {
  # The server may already be down.
}

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# Task Scheduler can leave the child Node process alive when stopping PowerShell.
# Only stop the process serving this project's expected port and entry point.
$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
  $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($serverProcess -and $serverProcess.Name -ieq 'node.exe' -and
      $serverProcess.CommandLine.IndexOf($serverPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    Stop-Process -Id $serverProcess.ProcessId -Force
  }
}
