# Auto-restart wrapper for rpow2 miner (gilang profile).
# Launched by Task Scheduler at user logon, runs hidden via PowerShell.
# Output is appended to miner-gilang.log next to this script.

$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot

$logFile  = Join-Path $PSScriptRoot 'miner-gilang.log'
$workers  = 10
$profile  = 'gilang'

# Trim the log if it gets crazy big (>50 MB) so we don't fill the disk.
if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 50MB)) {
    $tail = Get-Content $logFile -Tail 5000
    Set-Content -Path $logFile -Value $tail
}

"=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') wrapper started (PID=$PID) ===" |
    Out-File -FilePath $logFile -Append -Encoding UTF8

while ($true) {
    "=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') launching miner ===" |
        Out-File -FilePath $logFile -Append -Encoding UTF8
    try {
        # Redirect both stdout and stderr to the log file.
        & node 'rpow.js' 'mine' "--profile=$profile" "--workers=$workers" *>> $logFile
    } catch {
        $_ | Out-File -FilePath $logFile -Append -Encoding UTF8
    }
    "=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') miner exited, restart in 5s ===" |
        Out-File -FilePath $logFile -Append -Encoding UTF8
    Start-Sleep -Seconds 5
}
