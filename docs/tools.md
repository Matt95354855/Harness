# Catalogue des outils

Les outils de ce dépôt couvrent les capacités du cahier des charges : recherche, calcul et ajout d'outils personnalisés. Leur enregistrement est explicite, leurs paramètres sont validés et chaque appel produit une trace.

| Outil | Disponible quand | Paramètres | Résultat |
| --- | --- | --- | --- |
| `calculate` | Tout registre standard | `expression` : chaîne arithmétique | `{ "result": nombre }` |
| `web_search` | Un fournisseur est passé au registre | `query`, puis options de recherche | Résultats normalisés, sources, durée et indicateur de cache |
| `word_count` | Exemple avancé uniquement | `text` : chaîne | `{ "words": nombre }` |
| `web_fetch` | `WEB_ACCESS=true` | `url` publique | Texte borné de la page |
| `local_list`, `local_read`, `local_search` | `LOCAL_FILE_ROOTS` défini | Chemins autorisés | Liste, contenu ou correspondances |
| `drive_search`, `drive_read` | Jeton Google Drive défini | Requête ou identifiant | Fichiers et contenu textuel |
| `mcp_<serveur>_<outil>` | Configuration MCP présente | Schéma annoncé par le serveur | Résultat MCP normalisé |

## Calculer

```typescript
import { ToolExecutor, ToolRegistry } from '../src/index.js';

const executor = new ToolExecutor(new ToolRegistry());
const call = await executor.execute('calculate', {
  expression: '(12 + 8) * 3',
});
console.log(call.result?.data); // { result: 60 }
```

Cet exemple peut être enregistré sous `examples/my-calculation.ts`, puis exécuté avec `npx tsx examples/my-calculation.ts`.

Le calculateur accepte `+`, `-`, `*`, `/`, `%`, `^`, `**`, les parenthèses, les nombres décimaux et la notation scientifique. Il respecte les priorités arithmétiques. Les identifiants JavaScript, appels de fonctions et valeurs non finies sont refusés. Les limites sont de 1024 caractères et 256 tokens de calcul ; les résultats utilisent la précision des nombres JavaScript.

## Rechercher

Le même outil `web_search` fonctionne avec trois fournisseurs :

- `FixtureSearchProvider` : données synthétiques, sans accès réseau ; le mode de démonstration l'utilise.
- `HttpSearchProvider` en format `generic` : votre endpoint JSON, configuré explicitement.
- `HttpSearchProvider` en format `searxng` : une instance SearXNG dont l'API JSON est activée.

```typescript
import {
  FixtureSearchProvider,
  ToolExecutor,
  ToolRegistry,
} from '../src/index.js';

const registry = new ToolRegistry(new FixtureSearchProvider());
const call = await new ToolExecutor(registry).execute('web_search', {
  query: 'architecture agent harness',
  maxResults: 3,
  language: 'fr',
  safeSearch: true,
});
console.log(call.result?.data);
```

`query` est obligatoire, de 1 à 2000 caractères. `maxResults` est un entier de 1 à 10, par défaut 5. `language` vaut `en` par défaut. `safeSearch` vaut `true`. Le filtre optionnel `timeRange` accepte `day`, `week`, `month`, `year` en générique ; SearXNG refuse `week`.

Une source retournée n'est pas une preuve de véracité. L'outil renvoie les extraits fournis par le moteur ; il ne télécharge pas les pages citées. Les détails du protocole HTTP sont dans [l'API](api.md#recherche).

## Autoriser et limiter

```typescript
const executor = new ToolExecutor(registry, {
  allowedTools: ['web_search'],
  timeoutMs: 10_000,
  maxResultChars: 12_000,
  maxConcurrency: 2,
});

const calls = await executor.executeParallel([
  { toolName: 'web_search', parameters: { query: 'agent memory' } },
  { toolName: 'web_search', parameters: { query: 'agent evaluation' } },
]);
```

Sans `allowedTools`, tous les outils enregistrés sont autorisés. Avec `[]`, aucun outil n'est autorisé. La CLI expose ce réglage via `ALLOWED_TOOLS` ; une variable vide désactive tous les outils.

Un appel invalide ou trop long retourne `status: 'failed'` avec une erreur consultable. Un résultat trop volumineux est rejeté. `executeParallel` préserve l'ordre des résultats et borne les exécutions actives ; l'agent principal, lui, choisit et exécute une action à la fois.

## Ajouter votre outil

L'[exemple avancé](../examples/advanced-agent.ts) définit un outil, l'enregistre, l'autorise puis vérifie son résultat et la restauration de la mémoire. Le [contrat public](api.md#définir-un-outil) montre un second exemple minimal.

Une nouvelle capacité doit définir des paramètres explicites, valider ses contraintes métier et respecter `context.signal`. Aucun outil ne doit interpréter un texte du modèle comme du code à exécuter. Les outils sont du code de confiance dans le processus Node.js ; voir [SECURITY.md](../SECURITY.md).
