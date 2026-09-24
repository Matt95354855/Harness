# Connexions externes

Harness 0.2 relie un LLM aux applications sans donner un accès implicite à la machine. Chaque capacité doit être activée, apparaît dans `npm run doctor` et reste soumise à `ALLOWED_TOOLS`, aux délais et aux limites de résultat.

## MCP et GitHub

Le client MCP prend en charge les serveurs distants en Streamable HTTP et les serveurs locaux en `stdio`. Il découvre leurs outils au démarrage et les expose sous un nom préfixé `mcp_<serveur>_...`.

```bash
mkdir -p .harness
cp config/mcp.example.json .harness/mcp.json
```

Puis placer un jeton GitHub à permissions fines dans `.env` :

```dotenv
GITHUB_TOKEN=github_pat_votre_jeton
MCP_CONFIG_PATH=.harness/mcp.json
```

L'exemple cible `https://api.githubcopilot.com/mcp/readonly` et limite les familles d'outils. Harness ne réalise pas encore le flux OAuth interactif d'un serveur MCP distant : il utilise les en-têtes configurés ou l'authentification d'un serveur `stdio`. Les valeurs `$NOM` et `${NOM}` référencent une variable d'environnement sans écrire son secret dans le JSON.

## Fichiers locaux

```dotenv
LOCAL_FILE_ROOTS=/Users/vous/Documents,/Users/vous/Projects
```

- `local_list` liste au plus 200 entrées ;
- `local_read` lit un fichier texte d'au plus 1 Mo ;
- `local_search` explore au plus 500 entrées et renvoie au plus 50 correspondances.

Les chemins sont résolus sous leur forme canonique. Un lien symbolique qui sort d'une racine autorisée est refusé. Aucun outil d'écriture ou d'exécution de commande n'est fourni.

## Google Drive

Créer une autorisation OAuth Google avec le scope `https://www.googleapis.com/auth/drive.readonly`, puis placer le jeton d'accès dans `.env` :

```dotenv
GOOGLE_DRIVE_ACCESS_TOKEN=votre_jeton_oauth
```

`drive_search` cherche dans les noms et le texte indexé. `drive_read` exporte les Google Docs en texte, les feuilles Google Sheets en CSV et lit les formats textuels simples. Les formats binaires sont refusés. Un jeton d'accès OAuth expire généralement ; une application durable devra ajouter un flux OAuth avec stockage chiffré et renouvellement.

## Internet

`web_search` trouve des pages avec un endpoint HTTP ou SearXNG. `web_fetch` lit une URL publique lorsque `WEB_ACCESS=true`.

```dotenv
SEARCH_PROVIDER=searxng
SEARCH_ENDPOINT=http://127.0.0.1:8080/search
WEB_ACCESS=true
```

`web_fetch` accepte seulement HTTP(S), refuse les identifiants dans l'URL, les destinations privées ou locales, les types non textuels et les réponses supérieures à 1 Mo. Il suit au plus trois redirections en revalidant chaque destination. Le contenu Web reste une donnée non fiable susceptible de contenir une injection de prompt.

## Vérification

```bash
npm run doctor
npm run check
```

Pour un petit modèle local, limiter `ALLOWED_TOOLS` aux outils nécessaires à la tâche réduit le contexte et les erreurs de sélection.
