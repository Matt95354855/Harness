# Adaptateur DocLayNet

L’adaptateur compare un modèle local OpenAI-compatible aux annotations COCO de DocLayNet. Il envoie le texte extrait des cellules JSON et la géométrie normalisée des objets ; les modèles GGUF actuellement installés ne sont pas des modèles vision, donc les pixels PNG ne sont pas envoyés au endpoint texte.

La campagne de référence du 1 octobre 2026 est documentée dans [`doclaynet-benchmark-2026-10-01.md`](doclaynet-benchmark-2026-10-01.md). Les commandes ci-dessous utilisent `npm.cmd`, recommandé sous PowerShell lorsque `npm.ps1` est bloqué par la stratégie d’exécution.

Pour une campagne pratique de 500 pages aléatoires mais reproductibles, utiliser `--sample 500` avec un seed fixe. Le même seed reprend exactement les mêmes pages avec `--resume` :

```powershell
npm.cmd run doclaynet:eval -- --split test --sample 500 --seed 20261001 `
  --max-objects 12 --objects-per-request 4 --max-tokens 1400 `
  --attempts 4 --request-timeout-ms 180000 --health-wait-ms 30000 `
  --retry-delay-ms 2000 --endpoint http://127.0.0.1:8080/v1 `
  --model harness-local --output .harness/doclaynet/gpt-oss-random-500.json --resume
```

Depuis la racine de `harness` :

```powershell
# GPT-OSS déjà servi sur 8082
npm.cmd run doclaynet:eval -- --split test --start 0 --limit 20 --max-objects 12 `
  --objects-per-request 4 --max-tokens 1400 --attempts 4 `
  --endpoint http://127.0.0.1:8082/v1 --model harness-local `
  --output .harness/doclaynet/gpt-oss-stable-test.json

# Après arrêt du serveur précédent, démarrer Qwen sur 8080
npm run local:llm:qwen

# Dans un autre terminal, reprendre exactement le même échantillon
npm.cmd run doclaynet:eval -- --split test --start 0 --limit 20 --max-objects 12 `
  --objects-per-request 4 --max-tokens 1400 --attempts 4 `
  --endpoint http://127.0.0.1:8080/v1 --model harness-local `
  --output .harness/doclaynet/qwen-stable-test.json
```

Le rapport contient la validité JSON, l’accuracy, le macro-F1 par classes supportées, les métriques par classe et les sorties brutes bornées par page. L’adaptateur attend le endpoint `/health`, réessaie les appels après un redémarrage de `llama.cpp`, découpe les objets en lots et écrit un checkpoint après chaque page. Pour reprendre un run interrompu :

```powershell
npm.cmd run doclaynet:eval -- --split test --start 0 --limit 20 --max-objects 12 `
  --objects-per-request 4 --max-tokens 1400 --attempts 4 `
  --endpoint http://127.0.0.1:8082/v1 --model harness-local `
  --output .harness/doclaynet/gpt-oss-stable-test.json --resume
```

## API Mass Classification

Le service utilise `services/mass-classification/.env`, est configuré sur `127.0.0.1:8000`, et le Harness autorise les outils Mass sur les PDF extraits de DocLayNet. Après démarrage de Docker :

```powershell
$docker = "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe"
Set-Location services/mass-classification
& $docker compose build
& $docker compose up -d db redis
& $docker compose run --rm api python -m mass_classification.admin create-key --tenant default --role admin
& $docker compose up -d api worker
Invoke-RestMethod http://127.0.0.1:8000/health/ready
```

Copier ensuite le token `mc_...` retourné dans `harness/.env` à la variable `MASS_CLASSIFICATION_API_KEY`. Pour soumettre les mêmes pages à l’API et conserver ses résultats dans le rapport :

```powershell
$env:MASS_CLASSIFICATION_API_KEY = 'mc_...'
npm.cmd run doclaynet:eval -- --split test --start 0 --limit 2 --mass `
  --endpoint http://127.0.0.1:8082/v1 --output .harness/doclaynet/gpt-oss-mass.json
```

Les résultats Mass sont enregistrés séparément des métriques DocLayNet : les règles et le TNN Mass n’emploient pas directement les 11 labels de layout du dataset.
