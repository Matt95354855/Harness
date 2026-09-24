# Utiliser le modèle local

La configuration de référence utilise **Qwen3.5 0.8B Q8_0** avec `llama.cpp`. Elle a été validée sur un Mac Intel Core i7 avec 16 Go de mémoire, sans GPU : le modèle appelle réellement le calculateur du harness et obtient `60` pour `(12 + 8) * 3`.

Le fichier du modèle reste dans `models/`, qui est ignoré par Git. Il n'est donc jamais envoyé sur GitHub.

## Installation de référence sur macOS

Depuis la racine du dépôt :

```bash
brew install llama.cpp
mkdir -p models
curl --fail --location --continue-at - \
  --output models/Qwen3.5-0.8B-Q8_0.gguf \
  "https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf?download=true"
cp .env.example .env
```

Configurer ensuite `.env` avec :

```dotenv
LLM_PROVIDER=openai-compatible
LLM_MODEL=qwen3.5-0.8b-local
LLM_ENDPOINT=http://127.0.0.1:8080/v1
LLM_API_KEY=
SEARCH_PROVIDER=none
TEMPERATURE=0
HERMES_REFLECTION=false
HERMES_MULTI_HOP=false
ALLOWED_TOOLS=calculate
```

Le script fourni fixe le contexte à 4 096 jetons, utilise huit threads CPU, désactive le raisonnement caché et ne tente aucune accélération GPU :

```bash
npm run local:llm
```

Garder ce premier terminal ouvert. Dans un second terminal, lancer :

```bash
npm run doctor
npm run dev -- run "Calcule (12 + 8) * 3 avec l'outil calculate."
```

Pour arrêter le serveur, revenir dans son terminal et utiliser `Ctrl+C`.

## 1. Vérifier le harness seul

```bash
npm ci
npm run check
npm run demo
```

Ces commandes valident l'installation et les scénarios simulés. Le choix du modèle devra tenir compte de la mémoire de la machine, de son accélération matérielle et de la qualité de sortie JSON attendue.

## 2. Préparer le serveur

Harness attend une API compatible Chat Completions :

```text
POST <LLM_ENDPOINT>/chat/completions
```

Le chemin `/v1` appartient à l'endpoint de base lorsqu'il est utilisé par le serveur. Ne pas ajouter `/chat/completions` dans `LLM_ENDPOINT` : le client l'ajoute lui-même.

### Ollama

Lorsque Ollama et un modèle sont installés, démarrer son service et relever l'identifiant exact du modèle avec `ollama list`.

La documentation d'Ollama décrit son interface compatible sur `http://localhost:11434/v1`. Son service local n'exige pas de clé API pour ce client. [Référence officielle](https://docs.ollama.com/api/openai-compatibility).

```dotenv
LLM_PROVIDER=openai-compatible
LLM_ENDPOINT=http://127.0.0.1:11434/v1
LLM_MODEL=identifiant-exact-du-modele
LLM_API_KEY=
SEARCH_PROVIDER=none
```

### LM Studio

Dans LM Studio, charger le modèle choisi et démarrer le serveur local. Relever le port, l'identifiant de modèle et les éventuels réglages d'authentification affichés par votre installation.

La documentation de LM Studio présente l'endpoint compatible `http://localhost:1234/v1`. Adapter l'adresse si le serveur utilise un autre port. [Référence officielle](https://lmstudio.ai/docs/developer/openai-compat).

```dotenv
LLM_PROVIDER=openai-compatible
LLM_ENDPOINT=http://127.0.0.1:1234/v1
LLM_MODEL=identifiant-exact-du-modele
LLM_API_KEY=
SEARCH_PROVIDER=none
```

Reporter une clé dans `LLM_API_KEY` uniquement si le serveur choisi en exige une. Le harness ne démarre pas ces serveurs à votre place.

## 3. Appliquer la configuration

Créer `.env` à partir de `.env.example` si nécessaire, puis renseigner les valeurs choisies.

```bash
cp .env.example .env
```

Ne pas recopier ce fichier par-dessus une configuration déjà personnalisée. Les variables exportées dans le terminal ont priorité sur `.env`.

Pour commencer, conserver `SEARCH_PROVIDER=none`. Le modèle peut ainsi utiliser le calculateur local sans recherche distante. Le mode `fixture` reste disponible pour les démonstrations ; ses résultats sont synthétiques.

## 4. Valider une première exécution

```bash
npm run doctor
npm run dev -- run "Calcule (12 + 8) * 3 avec l'outil calculate."
npm run dev -- chat
```

En mode compatible, `doctor` contacte `GET /models`, affiche les modèles disponibles et vérifie l'identifiant configuré. Il échoue si ce modèle n'est pas présent ou si le serveur est inaccessible. Ce contrôle ne lance pas de génération ; le test de calcul qui suit vérifie le protocole de décision réel.

Vérifier dans la réponse et la trace que le modèle a proposé un appel `calculate` et que son résultat vaut `60`. Une simple réponse textuelle correcte ne prouve pas que le modèle a réellement appelé l'outil.

Tester ensuite une demande sans outil, une demande nécessitant plusieurs actions et une erreur volontaire de paramètre. Ces essais permettent d'évaluer le respect du protocole par le modèle ; ils complètent les tests unitaires du harness.

## Protocole attendu

Pour une décision, le modèle doit produire un objet JSON comportant une action, un résumé court et une confiance :

```json
{
  "nextAction": "TOOL",
  "summary": "Utiliser le calculateur pour obtenir le résultat.",
  "confidence": 0.95,
  "toolName": "calculate",
  "parameters": { "expression": "(12 + 8) * 3" }
}
```

Le schéma varie avec l'action : `SEARCH` attend une `query` ; `TOOL` attend `toolName` et `parameters`. Les prompts du harness fournissent les règles. La prise en charge de Chat Completions ne suffit pas à garantir la qualité des décisions d'un modèle donné.

## Activer une recherche réelle

Le fournisseur de recherche se configure indépendamment du modèle. Pour une instance SearXNG dont le format JSON est activé :

```dotenv
SEARCH_PROVIDER=searxng
SEARCH_ENDPOINT=http://127.0.0.1:8080/search
SEARCH_API_KEY=
```

Utiliser l'adresse réelle de votre instance. Le chemin `/search` doit être présent. Lancer une requête depuis le harness et vérifier que la trace indique des sources `searxng`, plutôt que `fixture`. Une instance locale peut elle-même interroger des moteurs distants.

Pour un endpoint JSON personnalisé, utiliser `SEARCH_PROVIDER=http` et le contrat détaillé dans [l'API de recherche](api.md#recherche).

## Dépannage

| Symptôme | Vérification |
| --- | --- |
| Connexion refusée | Vérifier que le serveur est démarré et que l'adresse et le port correspondent. |
| HTTP 404 | Vérifier `/v1` dans l'endpoint de base et l'identifiant exact du modèle. |
| HTTP 401 ou 403 | Vérifier l'authentification du serveur ; ne jamais copier une clé dans une issue. |
| Décision JSON invalide | Vérifier que le modèle suit les instructions structurées ; une température plus basse peut aider. |
| Réponse tronquée | Augmenter `MAX_TOKENS` dans les limites du contexte et de la mémoire disponibles. |
| Délai dépassé | Vérifier la charge du serveur, puis ajuster `LLM_TIMEOUT_MS` et `RUN_TIMEOUT_MS`. |
| Aucun outil appelé | Inspecter `nextAction`, la liste d'outils autorisés et la trace du run. |
| Recherche vide ou refusée | Vérifier l'endpoint de recherche et l'activation du format JSON sur l'instance. |

Les valeurs par défaut sont documentées dans [`.env.example`](../.env.example). Augmenter les budgets progressivement et relancer les mêmes tâches pour comparer les résultats.

## Ce qui reste à mesurer avec le modèle choisi

- Taux de décisions JSON valides.
- Réussite des appels d'outils et exactitude des réponses sur vos tâches.
- Latence au premier appel et après chargement du modèle.
- Usage mémoire, jetons et comportement lorsque les budgets sont atteints.
- Qualité des citations lorsque la recherche réelle est activée.

Ces mesures doivent être effectuées sur le modèle et la machine cible. Le benchmark simulé inclus dans le dépôt ne les remplace pas.
