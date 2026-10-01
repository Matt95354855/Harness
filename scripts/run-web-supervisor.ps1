$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path $repoRoot '.harness\web'
$nodeExe = Join-Path $env:LOCALAPPDATA 'Programs\nodejs-24.19.0\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) { $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source }
$mutex = New-Object System.Threading.Mutex($false, 'Local\HarnessChatSupervisor')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
    New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
    $stopPath = Join-Path $dataRoot 'stop.request'
    $entry = Join-Path $repoRoot 'dist\src\web\server.js'
    while (-not (Test-Path -LiteralPath $stopPath)) {
        foreach ($name in @('server.out.log', 'server.err.log')) {
            $log = Join-Path $dataRoot $name
            if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 5000000) {
                Move-Item -LiteralPath $log -Destination "$log.1" -Force
            }
        }
        $process = Start-Process -FilePath $nodeExe -ArgumentList @('"' + $entry + '"') -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataRoot 'server.out.log') -RedirectStandardError (Join-Path $dataRoot 'server.err.log')
        $process.WaitForExit()
        # If Node crashed, remove only the orphaned llama process it actually spawned.
        Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object {
            $_.ParentProcessId -eq $process.Id -and $_.CommandLine -match '--port 8082'
        } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        if (-not (Test-Path -LiteralPath $stopPath)) { Start-Sleep -Seconds 5 }
    }
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
