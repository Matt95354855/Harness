# API publique

Les contrats TypeScript sont définis dans [`src/core/types.ts`](../src/core/types.ts) et les exports de bibliothèque dans [`src/index.ts`](../src/index.ts). Les exemples ci-dessous supposent un fichier TypeScript placé à la racine du dépôt, exécuté avec `npx tsx nom-du-fichier.ts` après `npm ci`.

Après `npm run build`, la bibliothèque ESM est disponible dans `dist/src/index.js`, avec ses déclarations TypeScript. Le paquet n'est pas publié sur npm.

## Agent

```typescript
new Agent(config?: Partial<AgentConfig>, dependencies?: {
  llm?: LanguageModel;
  registry?: ToolRegistry;
  memory?: ConversationMemory;
  logger?: Logger;
  memoryOptions?: MemoryOptions;
});
```

| Méthode | Contrat |
| --- | --- |
| `process(input, { signal }?)` | Renvoie une `Promise<string>` contenant la réponse ; rejette en cas d'erreur fatale. |
| `getState()` | Renvoie un instantané de l'état, des appels d'outils et de la mémoire. |
| `getTrace()` | Renvoie la trace de la dernière exécution, si elle existe. |
| `getSessionId()` | Renvoie l'identifiant de la session. |
| `reset()` | Réinitialise l'état et la mémoire de l'agent. |

Un agent représente une conversation. Enchaîner ses appels avec `await` ; utiliser des instances distinctes pour des exécutions concurrentes.

Avec un `llm` injecté, le constructeur utilise des valeurs par défaut indépendantes de l'environnement. Les options explicites restent appliquées. Pour persister automatiquement une conversation, fournir `memoryOptions: { persistencePath: '.harness/memory.json' }` ; l'agent construit, charge puis sauvegarde cette mémoire. Un objet `memory` injecté garde sa propre configuration de chargement ; fournir aussi `memoryOptions.persistencePath` pour demander sa sauvegarde automatique. `reset()` démarre une nouvelle session en mémoire, sans supprimer de fichier sur disque.

```typescript
import { Agent } from './src/index.js';

const agent = new Agent({ maxIterations: 6, maxToolCalls: 3 });
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 30_000);

try {
  const answer = await agent.process('Calcule 8 * 7.', {
    signal: controller.signal,
  });
  console.log(answer);
} finally {
  clearTimeout(timer);
  console.log(agent.getTrace());
}
```

L'annulation termine l'attente et se propage aux composants qui respectent le signal. Elle ne peut pas interrompre une fonction JavaScript synchrone bloquante. Voir [SECURITY.md](../SECURITY.md).

### Configuration d'un agent

Les valeurs ci-dessous sont les valeurs par défaut du schéma. Les variables d'environnement chargées par l'application peuvent les remplacer ; les options explicites du constructeur personnalisent l'agent.

| Option | Défaut | Utilité |
| --- | --- | --- |
| `name` | `Harness` | Nom utilisé pour l'agent. |
| `model` | `mock` | Identifiant du modèle. |
| `maxIterations` | `8` | Nombre maximal de décisions par demande. |
| `temperature` | `0.2` | Température des requêtes au modèle. |
| `topP` | `0.9` | Paramètre d'échantillonnage. |
| `systemPrompt` | Instruction de précision et de traitement prudent des données | Instruction système de l'agent. |
| `maxContextChars` | `16000` | Taille maximale du contexte construit pour le modèle. |
| `maxInputChars` | `8000` | Longueur maximale d'une demande. |
| `maxToolCalls` | `12` | Nombre maximal d'appels d'outils par demande. |
| `maxTokens` | `1500` | Limite de génération par complétion. |
| `runTimeoutMs` | `120000` | Délai global d'exécution. |
| `toolTimeoutMs` | `10000` | Délai par appel d'outil. |
| `maxToolResultChars` | `12000` | Taille maximale du résultat sérialisé d'un outil. |
| `enableReflection` | `true` | Autorise la réflexion. |
| `reflectionInterval` | `3` | Intervalle de réflexion automatique. |
| `enableMultiHop` | `true` | Autorise plusieurs étapes d'acquisition d'informations. |
| `allowedTools` | Non défini | Autorise tous les outils du registre ; `[]` n'en autorise aucun. |
| `traceDir` | Option du schéma ; `.harness/traces` via la configuration par défaut | Répertoire de persistance des traces. |

`maxTokens` porte sur chaque réponse du modèle, pas sur un budget cumulé de jetons de toute la session. Les compteurs d'usage exposent les valeurs déclarées par le fournisseur.

### Charger et valider la configuration

`loadConfig(env?)` construit la configuration du modèle, de l'agent, de la recherche, de la mémoire et du logger. Il rejette les valeurs invalides. `validateConfig(env?)` renvoie une liste d'erreurs au lieu de quitter le processus.

Les booléens d'environnement acceptent les chaînes `true` et `false`. Les endpoints doivent être HTTP(S), sans identifiants, paramètres de requête ou fragment. Utiliser [`.env.example`](../.env.example) comme référence pour les noms des variables.

## Modèles

### Contrat minimal injectable

```typescript
interface LanguageModel {
  complete(request: LLMRequest): Promise<LLMResponse>;
}
```

`LLMRequest` contient `messages` et, de façon optionnelle, `temperature`, `topP`, `maxTokens` et `signal`. Les rôles disponibles sont `system`, `user` et `assistant`.

`LLMResponse` contient `content`, `model`, `finishReason` et `usage`, ce dernier exposant `promptTokens`, `completionTokens` et `totalTokens`.

### Client HTTP compatible

```typescript
import { LLMClient } from './src/index.js';

const llm = new LLMClient({
  endpoint: 'http://127.0.0.1:11434/v1',
  model: 'identifiant-exact-du-modele',
  timeoutMs: 60_000,
  maxRetries: 2,
});

const response = await llm.complete({
  messages: [{ role: 'user', content: 'Réponds en une phrase.' }],
  temperature: 0.2,
  maxTokens: 256,
});
console.log(response.content);
```

| Option | Défaut | Notes |
| --- | --- | --- |
| `endpoint` | Obligatoire | Base de l'API, généralement terminée par `/v1`. |
| `model` | Obligatoire | Identifiant exact exposé par le serveur. |
| `apiKey` | Non défini | Ajoute un en-tête `Authorization: Bearer …` si renseigné. |
| `timeoutMs` | `60000` | Délai de la requête, reprises comprises. |
| `maxRetries` | `2` | De 0 à 5 reprises pour les erreurs transitoires reconnues. |
| `maxResponseBytes` | `2000000` | Plafond du corps HTTP ou du flux SSE. |
| `fetch` | `globalThis.fetch` | Transport injectable pour les tests. |

Le client réessaie les erreurs réseau reconnues, HTTP 429 et HTTP 5xx avec un délai croissant. Il refuse les redirections. Un contenu invalide, vide ou déclaré tronqué produit une erreur. L'absence de statistiques d'usage est représentée par des zéros ; cela ne signifie pas que l'inférence n'a consommé aucun jeton.

`listModels(signal?)` appelle `GET /models` et renvoie les identifiants. Certains serveurs compatibles peuvent ne pas proposer cette route.

`stream(request, onChunk)` appelle Chat Completions en mode SSE et transmet les fragments de texte à `onChunk`. Une fois les données reçues, un flux interrompu n'est pas rejoué. L'agent utilise `complete()` pour ses décisions structurées ; le streaming est une API du client.

## Décisions et réflexion

L'action issue du modèle est l'une de `SEARCH`, `TOOL`, `RESPOND` et `REFLECT`. Les champs communs sont `summary` et `confidence`. Le harness ajoute le contexte d'exécution, comme le numéro d'itération.

```json
{
  "nextAction": "SEARCH",
  "summary": "Chercher des sources sur l'orchestration d'agents.",
  "confidence": 0.8,
  "query": "agent harness architecture"
}
```

`TOOL` utilise `toolName` et `parameters`. `RESPOND` déclenche une complétion de synthèse ; le résumé de décision n'est pas la réponse finale. `REFLECT` produit un `ReflectionResult` contenant `analysis`, `improvements` et `shouldContinue`.

Ces données servent à piloter et à observer les actions. Les champs de résumé ne doivent pas contenir de chaîne de pensée privée.

## Outils

### Définir un outil

```typescript
import { ToolExecutor, ToolRegistry, type Tool } from './src/index.js';

const uppercase: Tool = {
  name: 'uppercase',
  description: 'Convertit un texte en majuscules.',
  parameters: [{
    name: 'text',
    type: 'string',
    description: 'Texte à convertir.',
    required: true,
  }],
  async execute(params, context) {
    context.signal.throwIfAborted();
    return { text: (params.text as string).toLocaleUpperCase('fr') };
  },
};

const registry = new ToolRegistry();
registry.register(uppercase);

const executor = new ToolExecutor(registry, {
  allowedTools: ['uppercase'],
  timeoutMs: 1000,
});
const call = await executor.execute('uppercase', { text: 'bonjour' });
if (call.status !== 'completed') throw new Error(call.error);
console.log(call.result?.data); // { text: 'BONJOUR' }
```

Un outil reçoit des paramètres JSON et un `ToolContext` contenant `signal` et `sessionId`. Il renvoie une promesse de valeur JSON. Il doit vérifier les contraintes métier supplémentaires et transmettre le signal à ses propres opérations asynchrones.

### Registre

`new ToolRegistry(searchProvider?)` enregistre le calculateur `calculate`. Si un fournisseur de recherche est donné, il enregistre aussi `web_search`.

- `register(tool)` ajoute un nom unique conforme à `[a-z][a-z0-9_]{0,63}`.
- `get(name)` renvoie l'outil ou `undefined`.
- `listAll()` renvoie la liste des outils.
- `getFormattedDescription()` produit leur description pour le contexte du modèle.

Les paramètres supportent `string`, `number`, `boolean`, `array` et `object`. Ils peuvent être obligatoires, restreints à un `enum` de chaînes, ou disposer de bornes numériques `minimum` et `maximum`. Les objets et tableaux n'ont pas de schéma récursif déclaré par `ToolParameter` : l'outil reste responsable de leur structure métier.

### Exécuteur

```typescript
new ToolExecutor(registry, {
  timeoutMs: 10_000,
  maxResultChars: 12_000,
  maxConcurrency: 4,
  allowedTools: ['calculate'],
});
```

`execute(name, parameters, { signal?, sessionId? }?)` renvoie un `ToolCall`. Une erreur de validation, un outil inconnu, un refus d'autorisation, un résultat trop volumineux ou un délai dépassé donnent `status: 'failed'`, `error` et `result.success: false`. Le résultat trop volumineux est rejeté, pas tronqué en silence.

`executeParallel(calls, context?)` conserve l'ordre des appels dans sa liste de résultats et respecte `maxConcurrency`. Un outil asynchrone qui ignore son annulation conserve son créneau tant que sa promesse réelle n'est pas terminée.

Les statuts publics de `ToolCall` sont `pending`, `executing`, `completed` et `failed`. Chaque appel comprend un identifiant, les paramètres retenus, un horodatage ISO et sa durée en millisecondes.

### Calculateur intégré

L'outil `calculate` attend `{ "expression": "(2 + 3) * 4" }` et renvoie `{ "result": 20 }`. Il accepte les nombres, parenthèses et opérateurs `+`, `-`, `*`, `/`, `%`, `^` et `**`, avec des limites sur la longueur et le nombre de tokens. Il ne résout aucun identifiant et n'exécute pas de JavaScript. Les calculs utilisent les nombres à virgule flottante JavaScript.

## Recherche

Le contrat injectable est `search(query, signal?): Promise<SearchResponse>`. Une `SearchQuery` contient `query`, et éventuellement `maxResults`, `language`, `safeSearch` et `timeRange`.

`FixtureSearchProvider` fournit exclusivement des exemples synthétiques explicitement marqués. `HttpSearchProvider` interroge l'endpoint configuré. `SearchTool` expose n'importe quel `SearchProvider` sous le nom `web_search`.

```typescript
import { HttpSearchProvider, ToolRegistry } from './src/index.js';

const search = new HttpSearchProvider({
  endpoint: 'http://127.0.0.1:8080/search',
  format: 'searxng',
  timeoutMs: 10_000,
  cacheTtlMs: 300_000,
  maxCacheEntries: 100,
});
const registry = new ToolRegistry(search);
console.log(registry.listAll().map(tool => tool.name));
```

### Endpoint générique

Le fournisseur envoie un GET à l'endpoint exact, avec `q`, `num`, `lang`, `safe` et, si demandé, `tbs=qdr:d|w|m|y`. La réponse attendue est un objet JSON :

```json
{
  "results": [
    {
      "url": "https://example.org/article",
      "title": "Titre de la source",
      "snippet": "Extrait de la source"
    }
  ],
  "totalResults": 1
}
```

Le normaliseur accepte également `organic` au lieu de `results`, `link` au lieu de `url` et `content` ou `description` au lieu de `snippet`. Les résultats sans titre, avec URL invalide ou dupliquée sont ignorés. Les URLs retenues sont HTTP(S), sans identifiants intégrés ; les pages liées ne sont pas téléchargées par cet outil.

### Format SearXNG

Avec `format: 'searxng'`, les paramètres sont `q`, `format=json`, `language`, `safesearch=1|0` et éventuellement `time_range`. Les périodes acceptées sont `day`, `month` et `year` ; `week` est refusé pour ce fournisseur. L'instance doit autoriser le format JSON. L'adaptateur ne déploie pas d'instance SearXNG. [Contrat officiel de recherche](https://docs.searxng.org/dev/search_api.html).

### Cache et reprises

Par défaut : 5 résultats, au plus 10 par demande, délai de 10 secondes par tentative, 2 reprises, réponse HTTP limitée à 1 Mio, cache de 100 entrées pendant 5 minutes. Les clés de cache incluent les options de recherche. `cacheTtlMs: 0` ou `maxCacheEntries: 0` désactive le cache.

`getCacheStats()` renvoie `size`, `hits` et `misses`. `clearCache()` supprime les entrées conservées. Le client réessaie les erreurs réseau ou de délai reconnues ainsi que HTTP 408, 429 et 5xx. Il n'effectue pas de reprise automatique d'une réponse JSON mal formée.

`PidevTool` est un alias historique de `HttpSearchProvider`, sans intégration officielle de pi.dev.

## Templates

`new PrismAdapter()` enregistre les templates `hermes-thinking`, `reflection`, `synthesis` et `search-intent`. Les méthodes sont `registerTemplate(template)`, `render(name, variables)`, `listTemplates()` et `getTemplate(name)`.

```typescript
import { PrismAdapter } from './src/index.js';

const prompts = new PrismAdapter();
prompts.registerTemplate({
  name: 'greeting',
  version: '1',
  variables: ['name'],
  template: 'Bonjour {{name}}.',
});
console.log(prompts.render('greeting', { name: 'Alice' }).formatted);
```

Une variable obligatoire manquante ou un placeholder non déclaré produit une erreur. Les objets sont sérialisés en JSON. Le remplacement n'interprète pas récursivement les placeholders contenus dans une valeur. `PrismAdapter` est une implémentation locale et n'importe aucun SDK PrismML.

## Mémoire

`new ConversationMemory(options?)` accepte `maxTurns`, `maxFacts`, `maxDecisions`, `factTtlMs` et `persistencePath`.

| Méthode | Effet |
| --- | --- |
| `addTurn(turn)` | Ajoute un tour de conversation et garde les plus récents. |
| `addFact(fact)` | Ajoute un fait, applique l'expiration et conserve les plus fortes confiances. |
| `addDecision(decision)` | Ajoute une décision en respectant la limite de conservation. |
| `recordToolCall(call)` | Actualise les statistiques d'un appel terminal ; appeler une fois par appel. |
| `snapshot()` | Renvoie une copie défensive de la mémoire. |
| `getFormattedHistory()` | Formate l'historique pour l'utilisation dans un contexte. |
| `getRelevantFacts(query)` | Recherche textuellement les faits non expirés ; aucune recherche vectorielle. |
| `getLastSimilarDecision(context)` | Recherche textuellement une décision antérieure. |
| `getSummary()` | Renvoie les nombres de tours, faits, décisions et outils utilisés. |
| `saveToDisk(path?)` | Écrit la mémoire ; exige un chemin explicite ou configuré. |
| `loadFromDisk()` | Charge le chemin configuré ; fichier absent ignoré, fichier invalide rejeté. |
| `clear()` | Vide la mémoire en cours. |

Sans configuration, le constructeur de mémoire conserve 20 tours, 100 faits et 100 décisions. La configuration standard de l'application choisit 50 tours, 100 faits, 200 décisions et un TTL de 24 heures pour les faits. La persistance se configure explicitement ; les méthodes de lecture/écriture sont asynchrones.

Les statistiques sont limitées à 1000 noms d'outils distincts ; une nouvelle entrée au-delà de cette limite remplace la plus ancienne entrée créée.

Le fichier contient directement l'objet `Memory` avec `shortTerm`, `facts`, `decisions` et `toolsUsed`. Les dates sont des chaînes ISO 8601. Le stockage rejette les fichiers invalides et limite la taille à 16 Mio. Un chargement échoué ne remplace pas l'état courant.

## Journaux et traces

`new Logger(component, options?)` accepte `level`, `console`, `filePath`, `maxFileBytes` et `maxEntries`. Il expose `debug`, `info`, `warn`, `error`, `getLogs` et `clear`.

Le logger direct utilise par défaut le niveau `INFO`, la console activée, 1000 entrées et 1 Mio par fichier. La configuration de l'application désactive la console par défaut. Les événements de console sont écrits sur stderr ; les fichiers utilisent JSONL. Une rotation conserve le fichier courant et un fichier `.1`. Les erreurs d'écriture sont propagées.

Une `ExecutionTrace` contient notamment :

- `sessionId`, `runId`, `startTime` et éventuellement `endTime` ;
- `totalIterations`, `events` et `toolCalls` ;
- `usage` pour les jetons déclarés par le fournisseur ;
- `status` parmi `running`, `completed`, `failed`, `cancelled` et `limit_reached` ;
- `error` lorsqu'une erreur a été enregistrée.

`writeTrace(trace, directory)` écrit atomiquement un fichier nommé `<sessionId>-<runId>.json` et renvoie son chemin. `DecisionLog(directory).write(trace)` fournit le même mécanisme sous forme d'objet. Les identifiants de fichier doivent contenir uniquement des lettres, chiffres, tirets et underscores.

Le masquage de credentials du logger est indicatif. Les traces et la mémoire peuvent conserver les données fournies aux outils. Voir [la politique de sécurité](../SECURITY.md) avant de partager des fichiers.
