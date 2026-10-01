$ErrorActionPreference = 'Stop'
$dataRoot = Join-Path (Split-Path -Parent $PSScriptRoot) '.harness\web'
if (-not (Test-Path -LiteralPath $dataRoot)) { throw 'Serveur non installé.' }
[IO.File]::WriteAllText((Join-Path $dataRoot 'stop.request'), 'stop')
Write-Output 'Arrêt demandé au serveur, au modèle et au tunnel. Pour relancer, utilisez scripts/start-web.ps1.'
