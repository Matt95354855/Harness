# Suivi du cahier des charges

Ce document relie les 14 phases de `AGENT_HARNESS_IMPLEMENTATION.md` à l'implémentation du dépôt. Le cahier des charges est une référence fonctionnelle : les exemples incomplets ou les noms de services inexacts ont été corrigés au lieu d'être reproduits tels quels.

## Correspondance des 14 phases

| Phase | Livraison | Vérification reproductible |
| --- | --- | --- |
| 1. Structure et dépendances | Projet Node.js/TypeScript ESM, scripts, dépendances verrouillées et configuration d'analyse statique. | `npm ci`, `npm run check` |
| 2. Types et interfaces | Contrats stricts pour agents, modèles, décisions, outils, mémoire, recherche et traces. Dates sérialisées en ISO 8601. | `npm run typecheck` |
| 3. Configuration et client LLM | Configuration validée, fournisseur simulé, client Chat Completions, délais, annulation, reprises limitées et streaming SSE. | Tests de configuration et du client LLM |
| 4. Templates | `PrismAdapter` local, templates de décision, recherche, réflexion et synthèse, validation des variables. | Tests des templates |
| 5. Recherche | Fournisseur de fixtures, adaptateur HTTP générique et format SearXNG ; normalisation, validation, reprises et cache. | Tests de recherche et exemple basique |
| 6. Décision et réflexion | Actions structurées `SEARCH`, `TOOL`, `RESPOND`, `REFLECT`, validation JSON et réflexion. | Tests du moteur et de l'agent |
| 7. Registre et exécution | Outils extensibles, paramètres validés, autorisations, calculateur sans `eval`, délais et concurrence bornée. | Tests des outils et du calculateur |
| 8. Mémoire | Conversation, faits avec TTL, décisions, statistiques, limites et persistance JSON atomique validée. | Tests de mémoire et de persistance |
| 9. Journaux | Niveaux, format structuré, collecte bornée, rotation et masquage indicatif des credentials connus. | Tests du logger |
| 10. Agent principal | Boucle complète, outils génériques, budgets par run, synthèse, état, erreurs, annulation et traces. | Tests d'intégration et démonstration |
| 11. Exemples | Recherche simple, plusieurs étapes, outil personnalisé et mémoire persistante. | `npm run example:basic`, `npm run example:multi-hop`, `npm run example:advanced` |
| 12. Tests | Tests unitaires et d'intégration hors ligne, couverture disponible, workflow CI Node.js 22 et 24. | `npm test`, `npm run test:coverage` |
| 13. Documentation publique | README, architecture, contrats API, configuration, sécurité et guide de modèle local. | Exemples exécutables et lecture de `docs/api.md` |
| 14. Performances | Cache de recherche TTL/LRU, limites de contexte et de collections, concurrence bornée et benchmark reproductible. | Tests des limites et `npm run benchmark` |

Les livraisons de cette table concernent le harness et ses scénarios contrôlés. Elles ne déclarent pas un téléchargement, une intégration officielle de service tiers ou une campagne d'évaluation d'un LLM réel.

## Corrections des noms et intégrations

### PrismML

Le document initial présente PrismML comme un SDK de templating. La présence de la société ou de modèles sous ce nom ne constitue pas une documentation pour cette interface. L'[organisation Prism ML](https://huggingface.co/prism-ml) publie des modèles ; ce dépôt n'en importe aucun.

Le besoin fonctionnel de templates versionnés et de substitution de variables est couvert par un moteur local nommé `PrismAdapter`. Aucun SDK PrismML de templating n'est annoncé comme intégré. La dépendance `prisma` proposée dans le document n'a pas été ajoutée : elle ne répond pas à ce besoin.

### Hermes

[Hermes Agent](https://github.com/NousResearch/hermes-agent) est un projet distinct. Les fichiers de ce dépôt sous `src/hermes/` implémentent leur propre protocole de décision et de réflexion, avec une API injectable. Ils n'importent pas ce projet et ne prétendent pas en reprendre les performances.

### pi.dev

Le [site pi.dev](https://pi.dev/) présente un agent de programmation. Il n'établit pas le contrat de moteur de recherche supposé par l'exemple `https://api.pi.dev/v1/search`.

Le besoin de recherche est couvert par `HttpSearchProvider` et `SearchTool`, avec un endpoint choisi par l'opérateur. Le nom `PidevTool` est conservé comme alias historique de l'adaptateur générique ; aucun endpoint pi.dev n'est contacté par défaut. Les fixtures permettent de tester ce parcours sans clé ni service externe.

## Corrections techniques du prototype

- Les budgets d'itérations sont appliqués à chaque exécution.
- L'action `TOOL` exécute réellement les outils enregistrés.
- Les paramètres de l'agent sont transmis aux appels du modèle.
- Les dépendances et l'état sont propres aux instances, avec injection explicite.
- Les accès à la mémoire utilisent une API publique et des copies défensives.
- Les faits expirés sont supprimés et les faits de confiance supérieure sont conservés en priorité.
- Les erreurs de persistance sont signalées au lieu d'être silencieusement ignorées.
- Le calculateur analyse une grammaire arithmétique limitée au lieu d'évaluer du JavaScript.
- Les traces distinguent réussite, échec, annulation et limite atteinte.
- Les prompts demandent de courts résumés d'actions observables, sans chaîne de pensée privée.

## Validation et limites

La [validation initiale](validation.md) a réussi : 88 tests, analyse statique, typage strict, compilation et exemples. Les fonctionnalités des 14 phases sont couvertes avec les corrections d'intégration décrites ci-dessus.

La commande de référence est :

```bash
npm run check
npm run demo
npm run example:basic
npm run example:multi-hop
npm run example:advanced
npm run benchmark
```

Les tests de transport HTTP utilisent des réponses contrôlées. Le cache et les budgets font l'objet de tests dédiés ; le benchmark décrit un coût d'orchestration simulé, pas une mesure de débit d'inférence.

Le raccordement à un LLM installé sur la machine et la validation d'une recherche réelle constituent l'étape suivante, volontairement séparée. La procédure figure dans [local-model.md](local-model.md). Le harness ne prétend pas offrir de sandbox système, de service multi-utilisateur, de stockage distribué ou de garantie de résistance aux injections de prompt.
