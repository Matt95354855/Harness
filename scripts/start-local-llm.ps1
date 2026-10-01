[CmdletBinding()]
param(
    [ValidateSet("gpt-oss", "qwen")]
    [string]$Model = "gpt-oss",
    [int]$Port = 8080
)

$ErrorActionPreference = "Stop"

$modelRoot = if ($env:HARNESS_MODEL_ROOT) {
    $env:HARNESS_MODEL_ROOT
} else {
    Join-Path $env:USERPROFILE "Models\gguf"
}

$llamaServer = $env:HARNESS_LLAMA_SERVER
if ([string]::IsNullOrWhiteSpace($llamaServer)) {
    $command = Get-Command llama-server.exe -ErrorAction SilentlyContinue
    if ($command) {
        $llamaServer = $command.Source
    }
}
if ([string]::IsNullOrWhiteSpace($llamaServer)) {
    $llamaServer = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe\llama-server.exe"
}

if (-not (Test-Path -LiteralPath $llamaServer -PathType Leaf)) {
    throw "llama-server.exe est introuvable. Définissez HARNESS_LLAMA_SERVER ou installez llama.cpp."
}

if ($Model -eq "gpt-oss") {
    $modelPath = Join-Path $modelRoot "gpt-oss-20b-mxfp4\gpt-oss-20b-MXFP4.gguf"
    $modelLabel = "GPT-OSS 20B MXFP4"
    $modelArgs = @(
        "--gpu-layers", "all",
        "--fit", "on",
        "--fit-target", "2048",
        "--ctx-size", "4096",
        "--reasoning", "off"
    )
} else {
    $modelPath = Join-Path $modelRoot "qwen3.6-27b-instruct-q4_k_m\qwen3.6-27b-instruct-Q4_K_M.gguf"
    $modelLabel = "Qwen3.6 27B Instruct Q4_K_M"
    $modelArgs = @(
        "--gpu-layers", "auto",
        "--fit", "on",
        "--fit-target", "2048",
        "--fit-ctx", "2048",
        "--ctx-size", "2048",
        "--reasoning", "off"
    )
}

if (-not (Test-Path -LiteralPath $modelPath -PathType Leaf)) {
    throw "Modèle introuvable : $modelPath"
}

$commonArgs = @(
    "--model", $modelPath,
    "--alias", "harness-local",
    "--host", "127.0.0.1",
    "--port", "$Port",
    "--parallel", "1",
    "--jinja"
)

Write-Host "Démarrage de $modelLabel"
Write-Host "Endpoint Harness : http://127.0.0.1:$Port/v1"
Write-Host "Identifiant Harness : harness-local"
Write-Host "Arrêt : Ctrl+C"

& $llamaServer @commonArgs @modelArgs
exit $LASTEXITCODE
