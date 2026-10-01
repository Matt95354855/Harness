# Mass Classification — service documentaire

Ce service Python fait partie de la plateforme Classcale unifiée. Il fournit l'ingestion, le profilage structurel, l'OCR, l'analyse par règles, l'indexation et la recherche de preuves. Harness pilote son API HTTP depuis la racine du dépôt.

Le parcours de production accepte les **PDF et DOCX contenant du texte, des images et des tableaux**. D'autres extracteurs subsistent dans le code hérité, mais leurs formats ne sont pas acceptés par l'API de production de cette branche.

## Documentation

- [Vue d'ensemble et état des étapes](../../README.md)
- [Installation et utilisation avec Harness](../../docs/document-workflow.md)
- [Profilage et limites](../../docs/unified-platform.md)
- [Tests et preuves de fonctionnement](../../docs/document-validation.md)
- [Référence technique historique](docs/README_TECHNIQUE.md)
- [Présentation du service d'origine](docs/README_ORIGINAL.md)

## Parcours actuel

1. L'API authentifie la clé, contrôle l'extension et la taille, calcule l'empreinte, déduplique dans le tenant et met le document en file.
2. Le worker vérifie le fichier et établit son profil structurel avant OCR. Les fichiers invalides, chiffrés nécessitant un mot de passe ou dépassant les limites sont rejetés.
3. Tesseract traite les pages PDF et les images DOCX lisibles. L'extraction native complète le texte et les cellules DOCX.
4. Les passages sont indexés ; NLP, règles et graphe produisent les analyses. Le profil est conservé dans `metadata.input_profile`.
5. Résultats, preuves et retours humains sont accessibles par l'API.

Les statuts de traitement sont `queued`, `processing`, `ready` et `failed`. Le [contrat métier v1](../../docs/classification-result.md) ajoute un résultat normalisé et une abstention lorsqu'aucune règle ne fournit d'étiquette. Une priorité de revue n'est pas une probabilité de fraude. Sans checkpoint approuvé compatible, le TNN ne fournit pas de prédiction.

L'étape 6 ajoute une [politique de fusion conservatrice](../../docs/classification-fusion.md) : scores séparés, contrôle des sorties neuronales, signalement des désaccords et revue humaine obligatoire. Aucun score neuronal ne renforce automatiquement les règles tant qu'une calibration vérifiée n'est pas prise en charge.

L'étape 7 ajoute un [évaluateur hors ligne](../../docs/classification-evaluation.md), disponible via `python -m mass_classification.evaluation` ou `mass-evaluate`. Il compare des sorties API figées à un manifeste annoté, contrôle les partitions et les empreintes, puis calcule précision, rappel, F1, abstention et diagnostics neuronaux éligibles. Il n'approuve aucun modèle et ne remplace pas la constitution d'un corpus métier indépendant.

L'étape 8 ajoute `python -m mass_classification.corpus` (ou `mass-corpus`) pour
inventorier des PDF/DOCX privés, préparer une annotation humaine et finaliser
un manifeste compatible avec l'évaluateur. Aucun document n'est envoyé, aucun
modèle n'est exécuté et aucune étiquette n'est déduite. **Tests écrits mais
exécution différée à la demande de l'opérateur.** Voir le
[protocole de préparation du corpus](../../docs/corpus-preparation.md).

## Routes utilisées par Harness

| Route | Usage |
| --- | --- |
| `GET /v1/capabilities` | Formats, prétraitement et indicateurs de disponibilité |
| `POST /v1/documents` | Soumission multipart et reçu asynchrone |
| `GET /v1/documents/{id}` | Statut, profil et analyse |
| `POST /v1/search` | Passages avec provenance |
| `POST /v1/documents/{id}/feedback` | Revue humaine |

Ces routes nécessitent une clé du tenant. Les écritures exigent un rôle `analyst` ou `admin`. Les contrôles de présence des composants dans `/v1/capabilities` ne remplacent pas une recette du worker.

## Découverte locale distincte

Depuis le dossier de ce service :

```bash
python -m pip install -r requirements-demo.txt
python -m mass_classification.demo
```

L'interface écoute sur `http://127.0.0.1:8000`. Elle utilise des exemples fictifs, SQLite et une recherche lexicale. Ses imports texte, limités à 5 Mio, ne valident pas le pipeline PDF/DOCX : elle n'exécute ni OCR, ni embeddings, ni TNN. Ne pas lancer la démonstration et l'API de production sur le même port.

## Validation et contribution

La CI du monorepo exécute les tests Python ciblés et les contrôles Harness. La recette avec services réels est décrite dans le [rapport documentaire](../../docs/document-validation.md). Les essais synthétiques ne mesurent ni la précision métier sur corpus réel, ni la charge de production.

La licence du service est conservée dans [LICENSE](LICENSE). Ne pas ajouter de données réelles ou de secrets aux contributions.
