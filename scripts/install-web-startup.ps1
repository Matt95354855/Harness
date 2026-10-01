$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path $repoRoot '.harness\web'
New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
# Restrict the database, model logs and encryption key to this Windows account and SYSTEM.
& icacls.exe $dataRoot /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Impossible de protéger le dossier privé.' }
# Children inherit this private root. Applying inheritable-only ACEs directly to files
# can leave files with an empty DACL on repeated installs, so reset child ACLs instead.
Get-ChildItem -LiteralPath $dataRoot -Force | ForEach-Object {
    & icacls.exe $_.FullName /reset /T /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Impossible de proteger un fichier prive.' }
}
$scriptPath = Join-Path $PSScriptRoot 'run-web-supervisor.ps1'
$deploymentPath = Join-Path $dataRoot 'deployment.json'
if ((Test-Path -LiteralPath $deploymentPath) -and (Get-Content -LiteralPath $deploymentPath -Raw | ConvertFrom-Json).mode -eq 'preview') {
    $scriptPath = Join-Path $PSScriptRoot 'run-public-preview.ps1'
}
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '"'
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'Harness Chat.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powershellExe
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $repoRoot
$shortcut.WindowStyle = 7
$shortcut.Description = 'Harness Chat : interface locale et supervision du moteur'
$shortcut.Save()
$desktop = [Environment]::GetFolderPath('Desktop')
foreach ($item in @(@{ Name='Harness Chat'; Args=''; Url='http://127.0.0.1:3082' }, @{ Name='Harness Setup'; Args=('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'open-web-setup.ps1') + '"'); Url='' })) {
    $link = $shell.CreateShortcut((Join-Path $desktop ($item.Name + '.lnk')))
    if ($item.Url) { $link.TargetPath = 'explorer.exe'; $link.Arguments = $item.Url }
    else { $link.TargetPath = $powershellExe; $link.Arguments = $item.Args; $link.WindowStyle = 7 }
    $link.Save()
}
Write-Output 'Demarrage automatique installe a la connexion Windows. Dossier prive protege.'
Start-Process -FilePath $powershellExe -ArgumentList $arguments -WindowStyle Hidden
