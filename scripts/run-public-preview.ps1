# Temporary HTTPS preview. The address changes whenever cloudflared restarts.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path $repoRoot '.harness\web'
$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
if (-not (Test-Path -LiteralPath $cloudflared)) { $cloudflared = (Get-Command cloudflared.exe -ErrorAction Stop).Source }
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$mutex = New-Object System.Threading.Mutex($false, 'Local\HarnessChatPublicPreview')
if (-not $mutex.WaitOne(0)) { exit 0 }
$tunnel = $null
try {
    New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
    $stopPath = Join-Path $dataRoot 'stop.request'
    while (-not (Test-Path -LiteralPath $stopPath)) {
        $logPath = Join-Path $dataRoot 'tunnel.err.log'
        $tunnel = Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3080') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataRoot 'tunnel.out.log') -RedirectStandardError $logPath
        $publicOrigin = $null
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            if ($tunnel.HasExited -or (Test-Path -LiteralPath $stopPath)) { break }
            if (Test-Path -LiteralPath $logPath) {
                $logContent = Get-Content -LiteralPath $logPath -Raw
                if ($logContent) {
                    $matchesFound = [regex]::Matches($logContent, 'https://[a-z0-9-]+\.trycloudflare\.com')
                    if ($matchesFound.Count -gt 0) { $publicOrigin = $matchesFound[0].Value; break }
                }
            }
            Start-Sleep -Seconds 1
        }
        if ($publicOrigin) {
            # Ask any current server to close its model before changing its canonical origin.
            $ownedServer = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like ('*' + (Join-Path $repoRoot 'dist\src\web\server.js') + '*') }
            if ($ownedServer) {
                [IO.File]::WriteAllText($stopPath, 'restart')
                for ($attempt = 0; $attempt -lt 40; $attempt++) {
                    if (-not (Get-Process -Id $ownedServer.ProcessId -ErrorAction SilentlyContinue)) { break }
                    Start-Sleep -Seconds 1
                }
                if (Get-Process -Id $ownedServer.ProcessId -ErrorAction SilentlyContinue) { throw 'Le serveur existant ne termine pas son arret.' }
                Start-Sleep -Seconds 6
                Remove-Item -LiteralPath $stopPath
            }
            $config = @{ mode='preview'; origin=$publicOrigin } | ConvertTo-Json
            [IO.File]::WriteAllText((Join-Path $dataRoot 'deployment.json'), $config)
            [IO.File]::WriteAllText((Join-Path $dataRoot 'public-url.txt'), $publicOrigin)
            $shell = New-Object -ComObject WScript.Shell
            $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Harness Public.lnk'))
            $link.TargetPath = 'explorer.exe'; $link.Arguments = $publicOrigin; $link.Save()
            $arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'run-web-supervisor.ps1') + '"'
            Start-Process -FilePath $powershellExe -ArgumentList $arguments -WindowStyle Hidden
            while (-not $tunnel.HasExited -and -not (Test-Path -LiteralPath $stopPath)) { Start-Sleep -Seconds 3 }
        }
        if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
        if (-not (Test-Path -LiteralPath $stopPath)) { Start-Sleep -Seconds 15 }
    }
} finally {
    if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
