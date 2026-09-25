# Plateforme unifiée Classcale

## Objectif

Réunir le Harness et Mass Classification dans un monorepo sans confondre leurs responsabilités. Le Harness décide quelles capacités autorisées utiliser et contrôle leur exécution. Mass Classification reste l'autorité pour l'ingestion, l'extraction, l'analyse et la provenance des résultats.

## État de l'étape 0

- le travail existant reste intact sur ses branches d'origine ;
- Mass Classification est stabilisé sur `integration/prepare-unified-platform` ;
- son historique est rattaché à celui du Harness ;
- son code est importé sous `services/mass-classification` ;
- la CI du monorepo vérifie séparément les composants TypeScript et Python ;
- aucun contrat réseau ou comportement de classification n'est modifié à ce stade.

## Architecture cible

```text
Entrée
  -> profilage déterministe
  -> politique de routage
  -> Harness
  -> adaptateur Mass Classification
  -> API et worker de classification
  -> résultat normalisé
  -> contrôle de qualité, abstention ou revue humaine
```

## Principes

1. Aucun modèle ne reçoit une capacité qui n'est pas explicitement autorisée.
2. Les documents bruts ne sont pas injectés inutilement dans le contexte du LLM.
3. Une prédiction indisponible n'est jamais remplacée par une valeur inventée.
4. Les règles, modèles, versions, preuves et limites restent distingués dans le résultat.
5. Les décisions sensibles conservent une revue humaine et une possibilité d'abstention.
6. Les secrets, clés API et contenus sensibles ne sont pas écrits dans les traces.

## Prochaines étapes

1. Définir le contrat commun de classification et ses statuts.
2. Exposer les capacités réellement disponibles dans Mass Classification.
3. Créer l'adaptateur HTTP asynchrone dans Harness.
4. Ajouter le profilage déterministe des entrées.
5. Construire le routeur adaptatif et ses règles d'abstention.
6. Ajouter les tests de bout en bout sur données synthétiques.
