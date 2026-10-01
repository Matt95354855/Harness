$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$tokenFile = Join-Path $repoRoot '.harness\web\setup.token'
if (-not (Test-Path -LiteralPath $tokenFile)) { throw 'Lancez le serveur Harness avant de configurer votre compte.' }
$setupSecret = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
Start-Process "http://127.0.0.1:3081/#setup=$setupSecret"
