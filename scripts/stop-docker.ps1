$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    docker compose -f compose.docker.yaml down
    if ($LASTEXITCODE -ne 0) { throw "L'arrêt Docker a échoué." }
} finally {
    Pop-Location
}
Write-Output 'Le conteneur Harness est arrêté. Les conversations restent dans .harness/web.'
