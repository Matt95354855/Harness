$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path $repoRoot '.harness\web'
$required = @(
    'C:\Users\Shadow\Models\gguf\gpt-oss-20b-mxfp4\gpt-oss-20b-MXFP4.gguf',
    'C:\Users\Shadow\Models\gguf\qwen3.6-27b-instruct-q4_k_m\qwen3.6-27b-instruct-Q4_K_M.gguf'
)

if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw 'Docker Desktop est introuvable.' }
foreach ($path in $required) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Modèle introuvable : $path" } }

# The native and Docker variants cannot own the GPU and port 3082 at the same time.
if (Get-NetTCPConnection -LocalPort 3082 -State Listen -ErrorAction SilentlyContinue) {
    & (Join-Path $PSScriptRoot 'stop-web.ps1')
    $deadline = (Get-Date).AddSeconds(45)
    do { Start-Sleep -Milliseconds 500 } while ((Get-NetTCPConnection -LocalPort 3082 -State Listen -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline)
    if (Get-NetTCPConnection -LocalPort 3082 -State Listen -ErrorAction SilentlyContinue) { throw "Le serveur Windows ne s'est pas arrêté." }
}
$stopPath = Join-Path $dataRoot 'stop.request'
if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath }

Push-Location $repoRoot
try {
    docker compose -f compose.docker.yaml up -d --build
    if ($LASTEXITCODE -ne 0) { throw "Le démarrage Docker a échoué." }
    docker compose -f compose.docker.yaml ps
} finally {
    Pop-Location
}
Write-Output 'Harness Docker : http://127.0.0.1:3082'
