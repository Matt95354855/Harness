# Étape 6 — Fusion et garde-fous

## Périmètre livré

La politique `fusion:conservative:v1` est appliquée lors de la construction du résultat terminal de l'API de production. Elle ne relance pas les moteurs et ne modifie pas les analyses stockées. Harness transmet le résultat enrichi. Aucun changement SQL ni nouvelle configuration n'est nécessaire.

Le champ `classification_result.fusion` expose les scores des règles et du TNN séparément, la version neuronale déclarée, le moteur retenu, les contrôles et un diagnostic d'accord. Les scores heuristiques ne sont jamais moyennés avec les sorties softmax. La priorité de revue reste indépendante.

## Décisions

| Situation | Résultat |
| --- | --- |
| Règles présentes, modèle absent | Classification par règles, limitation explicite |
| Aucune règle, même avec prédiction neuronale | Abstention, aucune étiquette inventée |
| Maximum neuronal unique appartenant aux étiquettes des règles | Accord partiel (`overlap`), scores des règles inchangés |
| Maximum neuronal hors des étiquettes des règles | Résultat partiel, désaccord à examiner |
| Plusieurs maxima neuronaux à égalité numérique | Résultat partiel, ambiguïté à examiner |
| Sortie neuronale invalide ou taxonomie incompatible | Sortie rejetée ; résultat partiel si règles disponibles |
| Index tronqué et règles présentes | Résultat partiel |
| Scores de règles invalides | Échec explicite `invalid_rule_scores`, sans étiquette |

Le contrôle neuronal exige des nombres finis entre 0 et 1, une somme proche de 1 (tolérance absolue 0,0001) et exactement les classes `banking`, `investigation`, `media`. Les booléens et chaînes numériques sont refusés. L'égalité des maxima utilise une tolérance numérique, pas un seuil de confiance calibré. L'accord indique seulement une intersection avec les règles, pas une équivalence entre classification multi-étiquettes et prédiction neuronale.

`human_review_required` reste toujours vrai. Ce signal impose une revue au consommateur mais ne constitue ni un workflow d'approbation ni la preuve d'une revue réalisée. Une sortie brute rejetée reste consultable dans l'analyse historique ; elle n'est pas un score décisionnel.

## Limites assumées

Aucune calibration vérifiée n'est disponible dans cette version. Même un indicateur `calibrated` fourni dans les métadonnées ne peut autoriser le TNN à sélectionner ou renforcer une étiquette. Les scores neuronaux valides restent `uncalibrated`. Les états techniques `queued` et `processing` ne produisent toujours aucun résultat métier.

La pondération selon la qualité OCR, les seuils métier et la fusion statistique ne sont pas livrés : la qualité OCR n'est pas mesurée et aucun corpus annoté indépendant n'est fourni. Pour les activer, il faudra définir la taxonomie commune, constituer des jeux distincts d'entraînement/calibration/test, mesurer la calibration et les erreurs par type de document, puis lier une politique approuvée au checkpoint et à son rapport d'évaluation. Cette étape ne revendique donc aucun gain de précision métier.

## Validation

Validation du 29 septembre 2026 sur le commit `73761b4` : 98 tests Harness et 36 tests Python ciblés réussis localement ; CI GitHub réussie. Le [parcours documentaire réel](https://github.com/Matt95354855/Harness/actions/runs/36535694357) a également réussi. Ces résultats attestent le fonctionnement technique, pas la précision métier.

Les tests couvrent l'accord, le désaccord, les égalités, les valeurs invalides, la taxonomie incompatible, l'abstention sans règles, la troncature et l'impossibilité de contourner la politique avec un indicateur de calibration. La recette PDF/DOCX avec services réels vérifie aussi la politique, le moteur retenu et l'absence de prédiction inventée sans checkpoint. Les scénarios neuronaux restent des tests déterministes sur sorties synthétiques, pas une validation d'un TNN entraîné.
