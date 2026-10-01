# Image Docker locale du bot

L'image `harness-bot:local` contient l'application Web, le Harness et le serveur CUDA officiel de llama.cpp. Les poids GGUF ne sont pas copiés dans l'image : ils sont montés en lecture seule depuis `C:\Users\Shadow\Models\gguf`. Les conversations restent dans `.harness/web`, même après recréation du conteneur.

## Prérequis Windows

- Virtualisation activée dans l'UEFI/BIOS.
- WSL2 opérationnel.
- Docker Desktop démarré avec le moteur WSL2 et l'accès GPU NVIDIA.

Dans PowerShell **Administrateur**, installer les composants système puis redémarrer Windows :

```powershell
wsl --install --no-distribution
winget install --exact --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
Restart-Computer
```

Après le redémarrage, lancer Docker Desktop et vérifier :

```powershell
wsl --status
docker version
docker run --rm --gpus all nvidia/cuda:12.8.1-base-ubuntu24.04 nvidia-smi
```

## Construction et lancement

Depuis le dépôt `harness` :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-docker.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-docker.ps1
```

Ouvrir ensuite `http://127.0.0.1:3082`. Le script arrête d'abord la variante Windows native, car les deux variantes ne peuvent pas utiliser simultanément le port 3082 et la VRAM.

Commandes utiles :

```powershell
docker compose -f compose.docker.yaml logs -f --tail 200
docker compose -f compose.docker.yaml ps
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop-docker.ps1
```

Le port est publié uniquement sur la boucle locale Windows. Les ports de configuration et d'accès public ne sont pas publiés par cette composition. Mass Classification peut être relié à un service joignable depuis le conteneur avec `DOCKER_MASS_CLASSIFICATION_URL`; Google Drive utilise `GOOGLE_DRIVE_ACCESS_TOKEN`; les serveurs MCP se configurent dans `config/mcp.json`.
