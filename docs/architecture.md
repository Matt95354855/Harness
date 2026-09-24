# Architecture

## Responsabilités

Harness est une bibliothèque TypeScript et une interface en ligne de commande. Son moteur coordonne un modèle, des outils et la mémoire d'une session. L'inférence reste la responsabilité du fournisseur de modèle.

| Composant | Rôle |
| --- | --- |
| `Agent` | Conduit une exécution, applique les budgets et relie les composants. |
| `LanguageModel` | Contrat minimal pour obtenir une complétion. |
| `LLMClient` | Transporte les requêtes vers un serveur Chat Completions compatible. |
| `PrismAdapter` | Rend des templates versionnés et valide les variables attendues. |
| Moteur de décision | Valide l'action structurée proposée par le modèle. |
| `ToolRegistry` | Déclare les capacités disponibles et leurs paramètres. |
| `ToolExecutor` | Valide, autorise, chronomètre et exécute un outil. |
| `SearchProvider` | Fournit une recherche réelle configurable ou des fixtures explicites. |
| `ConversationMemory` | Conserve les conversations, faits, décisions et statistiques. |
| `Logger` et traces | Exposent les événements et le résultat d'une exécution. |

Les dépendances sont injectables. Chaque agent dispose de son état ; partager délibérément une dépendance mutable entre plusieurs agents reste la responsabilité de l'appelant.

## Cycle d'exécution

1. Valider la demande et ouvrir une trace d'exécution.
2. Préparer le contexte borné avec l'historique, les faits utiles et les outils disponibles.
3. Demander au modèle une décision JSON et vérifier son schéma.
4. Exécuter l'action ou produire la réponse finale.
5. Ajouter les observations, décisions et statistiques, puis poursuivre si les budgets le permettent.
6. Terminer la trace et persister les données lorsque la configuration le demande.

`SEARCH` appelle `web_search` avec la requête choisie. `TOOL` cible un outil enregistré. `REFLECT` produit une réévaluation structurée pouvant demander l'arrêt de la boucle. `RESPOND` déclenche la synthèse des données disponibles.

Les itérations sont comptées par exécution. Elles ne constituent pas une limite cumulée de questions dans une conversation. Les réponses du modèle et les sorties d'outils sont validées avant d'alimenter l'étape suivante.

## Contrat du modèle

Le harness utilise du texte JSON dans les messages de complétion pour choisir les actions. Il ne dépend pas des fonctions propriétaires d'un serveur ni du mécanisme natif `tool_calls` de Chat Completions. Le modèle doit donc respecter le schéma de décision décrit dans [l'API](api.md).

Le moteur demande des résumés d'actions courts, destinés à l'observation. Il ne stocke pas de chaîne de pensée privée. Une réflexion supplémentaire reste un appel de modèle, avec un coût et une latence propres.

Le client HTTP expose aussi un décodage SSE pour les consommateurs directs de `LLMClient.stream()`. L'orchestrateur utilise les complétions complètes pour valider les décisions avant toute exécution d'outil.

## État et persistance

| Donnée | Portée et conservation |
| --- | --- |
| État d'agent | Copie consultable de l'exécution courante et de la conversation. |
| Mémoire | Historique borné, faits avec TTL, décisions bornées et statistiques d'outils. |
| Trace | Une exécution identifiée par `sessionId` et `runId`, son statut, ses événements et son usage. |
| Journaux | Événements filtrés par niveau, collection bornée et fichier optionnel avec rotation. |

La mémoire persistée est un document JSON validé au chargement. Un fichier absent représente une nouvelle mémoire ; un fichier corrompu produit une erreur. L'écriture utilise un fichier temporaire puis un renommage atomique. Ce stockage vise un usage local : il ne constitue pas une base transactionnelle et ne coordonne pas plusieurs processus écrivant dans le même fichier.

Les faits expirés sont écartés lors des accès à la mémoire. Lorsque le plafond est atteint, les faits de plus forte confiance sont conservés. Cette confiance est une métadonnée du harness, pas une preuve de vérité.

Les traces sont stockées par défaut dans `.harness/traces/`. La persistance de la conversation est désactivée par défaut. Les contenus utilisateur et les résultats d'outils peuvent apparaître dans les fichiers persistés : voir [SECURITY.md](../SECURITY.md).

## Limites et erreurs

- Les plafonds d'itérations et d'appels empêchent une boucle d'agent de poursuivre indéfiniment.
- Les entrées, le contexte, les réponses HTTP et les résultats d'outils disposent de limites de taille.
- Le délai global de l'agent s'ajoute aux délais des modèles et outils.
- Les requêtes HTTP transitoires peuvent être réessayées ; les erreurs de schéma et les autres erreurs permanentes sont signalées.
- Un appel d'outil en erreur produit un `ToolCall` au statut `failed`, visible pour la boucle. Une erreur fatale de l'agent fait rejeter `process()`.
- Les signaux d'annulation sont transmis aux composants coopératifs. Un outil personnalisé peut ignorer ce signal ; une tâche JavaScript synchrone peut bloquer le processus.

Le harness n'est pas une sandbox. Une liste d'outils autorisés limite les capacités offertes au modèle, mais le code enregistré conserve les permissions du processus Node.js.

## Performances

L'optimisation repose sur des limites mesurables : contexte borné, mémoire bornée, limitation de concurrence des outils et cache de recherche avec TTL et éviction LRU. Les réponses issues du cache sont clonées pour éviter les mutations partagées.

`npm run benchmark` mesure le coût du harness en mode simulé. Cela permet de comparer l'orchestration entre changements de code. Une évaluation de modèle réel devra mesurer séparément la latence d'inférence, les jetons, le taux de décisions valides et la réussite des tâches.

## Périmètre

Cette version n'inclut pas de téléchargement de modèles, d'interface web, de sandbox système, de service multi-utilisateur, de base vectorielle ou de planificateur distribué. Un modèle local réel et une recherche distante nécessitent une validation dans leur environnement cible.
