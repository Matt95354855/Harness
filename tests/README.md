# Stratégie de tests

```bash
npm test
npm run test:coverage
npm run check
```

Les tests utilisent `node:test`, les assertions strictes de Node.js et des fixtures déterministes. Aucun appel à un LLM commercial, téléchargement de modèle ou recherche web réelle n'est nécessaire.

## Tests unitaires

- Configuration invalide, valeurs nulles explicites et profils hors ligne.
- Templates, substitutions littérales et validation JSON.
- Client LLM : transport, erreurs HTTP, reprises, délais, limites de taille et streaming SSE fragmenté.
- Outils : calcul arithmétique, validation, autorisations, concurrence et annulation.
- Mémoire : expiration, éviction, copies défensives et persistance atomique.
- Journaux : niveaux, rotation, erreurs d'écriture et masquage des credentials connus.

## Tests d'intégration

- Parcours d'agent à plusieurs étapes, réflexion et synthèse des résultats observés.
- Limites par demande, annulation, erreur du modèle, outil en échec et récupération.
- Recherche HTTP générique et SearXNG, normalisation, cache TTL/LRU et transport interrompu.
- Serveur HTTP temporaire sur `127.0.0.1` pour vérifier les transports natifs de bout en bout.
- Ligne de commande dans des processus distincts, sortie JSON et codes de sortie.

Les dossiers temporaires créés par les tests de persistance sont supprimés à leur fin. Le test `demo` produit une trace locale dans le répertoire ignoré `.harness/`. Les tests de CLI interactive ne simulent pas une session TTY complète.

## Interpréter les résultats

Une suite verte valide le harness dans les scénarios couverts. Elle ne démontre pas la qualité d'un futur modèle, la disponibilité d'un serveur distant ou une isolation de sécurité. `npm run benchmark` mesure uniquement le coût de l'orchestration et l'efficacité du cache dans des scénarios simulés.

Le workflow [CI](../.github/workflows/ci.yml) exécute les contrôles et exemples avec Node.js 22 et 24. La procédure de connexion à un modèle réel est décrite dans [le guide local](../docs/local-model.md).
