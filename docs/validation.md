# Rapport de validation initiale

Exécution locale du **24 septembre 2026**, sous macOS avec **Node.js 25.2.0**. Les chiffres ci-dessous décrivent cette version initiale et cet environnement ; ils ne constituent pas une garantie pour tous les modèles et systèmes.

| Contrôle | Résultat |
| --- | --- |
| ESLint | Réussi |
| Vérification TypeScript stricte | Réussie |
| Tests unitaires et d'intégration | **88 réussis, 0 échec, 0 ignoré** |
| Compilation ESM et déclarations | Réussie |
| Couverture des lignes rapportée par c8 | **98,16 %** |
| Couverture des branches rapportée par c8 | **91,35 %** |
| CLI `demo`, `doctor`, `run`, sortie JSON | Vérifiées |
| Recherche simple, multi-hop et outil personnalisé | Exemples exécutés avec succès |
| Persistance et restauration de mémoire | Vérifiées |
| Connexion HTTP native | Vérifiée avec serveur simulé sur `127.0.0.1` |

## Mesure d'orchestration

`npm run benchmark` a exécuté 10 tours de chauffe puis 100 tours mesurés, avec modèle simulé et traces disque désactivées :

- Latence médiane : **0,98 ms** par tour.
- 95e percentile : **1,56 ms** par tour.
- Cache : **99 succès sur 100 recherches identiques**, un seul appel au transport simulé.

Ces valeurs mesurent le fonctionnement du harness dans ce scénario. Elles excluent l'inférence d'un vrai LLM et ne doivent pas être présentées comme ses performances. La couverture indique quelles lignes ont été exercées ; elle ne prouve pas l'absence de bugs.

## Reproduire

```bash
npm ci
npm run check
npm run test:coverage
npm run demo
npm run doctor
npm run example:basic
npm run example:multi-hop
npm run example:advanced
npm run benchmark
```

Le workflow CI prévoit ces contrôles sur Node.js 22 et 24. Consulter le [résultat GitHub Actions](https://github.com/Matt95354855/Harness/actions/workflows/ci.yml) pour connaître leur statut sur la révision courante.

## Validation encore dépendante de l'environnement cible

- Aucun poids de LLM n'a été téléchargé pour ce rapport.
- La génération et le choix des outils par le futur modèle local restent à évaluer.
- Les endpoints de recherche réels n'ont pas été interrogés pendant les tests.
- La conversation interactive n'a pas été testée dans une session TTY automatisée complète.

La procédure de raccordement est disponible dans [le guide du modèle local](local-model.md).
