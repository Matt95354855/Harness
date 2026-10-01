$ErrorActionPreference = 'Stop'
$dataRoot = Join-Path (Split-Path -Parent $PSScriptRoot) '.harness\web'
$stopPath = Join-Path $dataRoot 'stop.request'
if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath }
$scriptPath = Join-Path $PSScriptRoot 'run-web-supervisor.ps1'
$deploymentPath = Join-Path $dataRoot 'deployment.json'
if ((Test-Path -LiteralPath $deploymentPath) -and (Get-Content -LiteralPath $deploymentPath -Raw | ConvertFrom-Json).mode -eq 'preview') {
    $scriptPath = Join-Path $PSScriptRoot 'run-public-preview.ps1'
}
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Start-Process -FilePath $powershellExe -ArgumentList ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '"') -WindowStyle Hidden
