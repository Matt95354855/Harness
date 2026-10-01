$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
    throw 'Docker Desktop est introuvable. Installez et démarrez Docker Desktop avec le moteur WSL2.'
}
docker info | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Le moteur Docker ne répond pas.' }

Push-Location $repoRoot
try {
    docker compose -f compose.docker.yaml build
    if ($LASTEXITCODE -ne 0) { throw "La construction de l'image Docker a échoué." }
    docker image inspect harness-bot:local --format 'Image créée : {{.RepoTags}} — {{.Size}} octets'
} finally {
    Pop-Location
}
