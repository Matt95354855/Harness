# Contribuer à Harness

## Préparer l'environnement

Utiliser Node.js 22.13 ou plus récent et npm, puis exécuter :

```bash
npm ci
npm run demo
npm run check
```

Les tests et exemples utilisent des fournisseurs simulés. Une clé API ou un modèle local ne doit pas devenir nécessaire à leur exécution.

## Proposer une modification

1. Décrire le comportement attendu et le problème résolu dans une issue ou la pull request.
2. Créer une branche avec un nom explicite.
3. Garder la modification centrée sur le problème et respecter les contrats dans `src/core/types.ts`.
4. Ajouter un test pour tout nouveau comportement, correctif ou cas d'erreur pertinent.
5. Mettre à jour les exemples et la documentation lorsque l'API ou la configuration change.
6. Exécuter `npm run check` et les exemples concernés avant d'ouvrir la pull request.

La description d'une pull request doit préciser le problème, le comportement obtenu et les vérifications réalisées. Les résultats obtenus avec un fournisseur simulé doivent être identifiés comme tels.

## Conventions

- TypeScript strict, modules ESM et imports locaux avec extension `.js`.
- API asynchrones explicites et erreurs propagées ; ne pas transformer un échec en résultat réussi.
- Dépendances injectables pour les modèles, outils, transports HTTP et stockage quand c'est pertinent.
- Éviter les singletons d'état qui mélangent plusieurs sessions.
- Résultats d'outils sérialisables en JSON ; respecter le signal d'annulation reçu.
- Résumés d'actions courts dans les traces, sans demande de chaîne de pensée privée.
- Pas de clés API, de fichiers `.env`, de conversations réelles ou de traces personnelles dans Git.

Pour une nouvelle intégration externe, partir de sa documentation officielle et fournir un test HTTP contrôlé. Ne pas présenter un adaptateur générique comme une intégration officielle.

## Vérifications disponibles

| Commande | Usage |
| --- | --- |
| `npm run lint` | Règles de qualité du code. |
| `npm run typecheck` | Contrôle des types sans produire de fichiers. |
| `npm test` | Suite de tests. |
| `npm run build` | Vérification de la compilation et génération des déclarations. |
| `npm run test:coverage` | Rapport de couverture pour identifier les chemins non testés. |
| `npm run benchmark` | Comparaison locale des performances de l'orchestration simulée. |

La CI répète les contrôles sur Node.js 22 et 24. Un résultat de benchmark n'est pas un engagement de latence ; conserver le contexte matériel et logiciel lors d'une comparaison.

## Sécurité et licence

Ne pas publier de secret dans une issue. Consulter [SECURITY.md](SECURITY.md) pour les limites du modèle d'exécution.

Le propriétaire n'a pas encore choisi de licence de redistribution. Clarifier les conditions avec lui avant de réutiliser ou distribuer le code au-delà de ce qu'autorise GitHub.
