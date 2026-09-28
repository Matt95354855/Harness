# Résultat de classification v1

Le service de production ajoute `classification_result` à `GET /v1/documents/{id}` sans retirer les champs existants. Le schéma JSON validé par Pydantic est accessible avec authentification sur `GET /v1/result-schema`. Harness conserve ce nouveau champ dans ses résultats de document.

## Cycle de vie

Le statut du document reste `queued`, `processing`, `ready` ou `failed`. `classification_result` vaut `null` pendant le traitement. Le résultat terminal porte une version `classification-result:v1` et un statut métier :

| Statut | Condition v1 |
| --- | --- |
| `classified` | Étiquettes par règles présentes, sans troncature d'index signalée |
| `partial` | Étiquettes présentes, indexation signalée comme tronquée |
| `abstained` | Analyse terminée sans étiquette par règles |
| `failed` | Échec du traitement, analyse manquante ou méthode non prise en charge |

`classified` ne garantit pas la qualité OCR ou la justesse métier. L'abstention v1 n'est pas calibrée statistiquement. L'absence de TNN est une limitation, pas un échec des règles.

## Données retournées

- `document_id` : référence de la pièce.
- `status` et `reasons` : issue et codes (`no_rule_label`, `index_truncated`, `processing_failed`, `missing_or_unsupported_analysis`).
- `labels` : étiquettes triées, scores entre 0 et 1 et `score_kind: heuristic`. Ce ne sont pas des probabilités.
- `review_priority` : priorité entre 0 et 100, distincte des scores, ou `null` sans analyse.
- `evidence` : termes déclenchant les règles avec identifiant du document et étiquette. Le type `rule_terms_not_passage_citations` distingue ces termes de citations localisées ; les passages restent accessibles via la recherche.
- `limitations` : scores heuristiques, qualité OCR non mesurée, éventuelle troncature et indisponibilité du modèle neuronal.
- `human_review_required` : toujours vrai ; ne prouve pas qu'une revue a été réalisée.
- `model_version` : `rules:v1`, ou `null` sans analyse exploitable.
- `neural_prediction_status` : `unavailable` ou `available_uncalibrated`. Les prédictions brutes restent dans `analysis.predictions` ; aucun mélange de scores n'est effectué.

Le profil et le plan restent dans les métadonnées existantes. Les erreurs techniques restent au niveau du document. Le résultat est calculé depuis les analyses stockées, sans migration SQL. La démonstration SQLite garde son contrat historique.

La qualité OCR, les seuils calibrés, la provenance par page ou cellule et l'arbitrage entre modèles restent à développer. Ces informations ne sont pas inventées par ce contrat.
