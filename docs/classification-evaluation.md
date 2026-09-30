# Étape 7 — Évaluation reproductible

## Ce qui est livré

Un évaluateur hors ligne compare des résultats de classification figés à un manifeste annoté. Il ne relance ni OCR, ni moteur, ni LLM et ne contacte aucun service. Il produit un rapport JSON reproductible avec les empreintes SHA-256 de ses deux entrées, la révision du code et l'identifiant de configuration déclarés.

L'outillage est implémenté et testé. **L'évaluation métier réelle reste à réaliser** : aucun corpus indépendant annoté ni checkpoint calibré n'est fourni. Les documents synthétiques de la recette servent uniquement à vérifier la chaîne technique.

## Utilisation

Pour constituer le manifeste sans lancer d'inférence, suivre la
[préparation du corpus de l'étape 8](corpus-preparation.md). Cet outil ne remplace
ni l'annotation indépendante ni l'exécution ultérieure du pipeline. Sa recette
est différée ; les résultats historiques de l'étape 7 ne le valident pas.

Depuis `services/mass-classification`, avec les dépendances du service installées :

```bash
python -m mass_classification.evaluation \
  --corpus /chemin/corpus.json \
  --predictions /chemin/resultats.json \
  --split test \
  --output /chemin/nouveau-rapport.json
```

L'installation du paquet expose aussi `mass-evaluate`. Le fichier de sortie doit être nouveau et son dossier doit exister. Une entrée invalide, un résultat manquant ou une tentative d'écrasement provoque une sortie 2. Le succès technique retourne 0 ; il ne constitue pas un seuil d'acceptation métier.

### Manifeste annoté

```json
{
  "version": "classification-corpus:v1",
  "dataset_id": "corpus-metier-v1",
  "annotation_provenance": "Protocole et référence de la campagne de revue",
  "synthetic": false,
  "documents": [{
    "document_id": "id-retourne-par-api",
    "sha256": "empreinte SHA-256 réelle du document, 64 caractères hexadécimaux minuscules",
    "group_id": "famille-dossier-001",
    "split": "test",
    "format": "pdf",
    "labels": ["banking"]
  }]
}
```

Cet exemple de structure contient une empreinte descriptive à remplacer ; ce n'est pas un jeu de données exécutable. Les classes acceptées sont `banking`, `investigation`, `media`. Plusieurs étiquettes sont possibles. Une liste vide signifie qu'aucune de ces classes n'est attendue, pas qu'une annotation manque.

Chaque document a un identifiant et une empreinte uniques. Les variantes d'un même dossier doivent partager un `group_id`. Une famille ne peut appartenir à plusieurs partitions (`train`, `calibration`, `test`). L'évaluateur contrôle le manifeste complet, puis évalue uniquement la partition demandée (`test` par défaut, ou `calibration`). Il refuse d'évaluer `train`.

Ces contrôles détectent les doublons exacts et les familles déclarées. Ils ne détectent pas automatiquement les quasi-doublons et ne prouvent pas qu'un modèle n'a jamais vu un document absent du manifeste. Il faut conserver l'historique d'entraînement et établir les familles avant le découpage.

### Résultats figés

Le second fichier contient `version: classification-evaluation-run:v1`, `run_id`, `source_revision`, `configuration_id` et une liste `observations`. Chaque observation contient `sha256` et `result`, ce dernier étant le champ `classification_result` terminal retourné par l'API de production.

Le fichier doit couvrir exactement les documents de la partition évaluée, y compris les échecs. Les identifiants supplémentaires, résultats dupliqués, empreintes différentes, étiquettes inconnues ou statuts incohérents sont refusés. Les résultats en cours ne peuvent pas être évalués. Les champs de provenance sont déclaratifs : les empreintes rendent un fichier identifiable, elles ne signent pas son origine.

Ne pas inclure de texte documentaire ni de secret dans ces fichiers. Les identifiants et références d'annotation peuvent eux-mêmes être sensibles : conserver corpus, exports et rapports métier dans un espace privé. Seuls les rapports sur données synthétiques sont publiés par la CI.

## Mesures et conventions

- **Précision, rappel et F1 micro** : compte global des vrais positifs, faux positifs et faux négatifs, pour une classification multi-étiquettes.
- **Mesures par classe** : mêmes comptes, avec le nombre d'étiquettes attendues (`support`).
- **F1 macro sur classes définies** : moyenne des F1 non nuls au sens mathématique (`null` exclu ; les F1 égaux à zéro sont inclus).
- **Couverture** : proportion de documents ayant des étiquettes, statuts `classified` ou `partial`. Un résultat partiel n'est pas assimilé à une décision autonome validée.
- **Abstention et échec** : taux séparés. Les étiquettes attendues non produites comptent comme faux négatifs, même en cas d'abstention ou d'échec.
- **Correspondance exacte** : toutes les étiquettes doivent correspondre, sans extra. La mesure globale divise par tous les documents ; la mesure sur sorties divise seulement par ceux ayant des étiquettes. Les abstentions, même avec annotation vide, ne sont pas comptées comme classifications exactes.
- **Ventilation PDF/DOCX** : mêmes mesures par format. Un dénominateur nul donne `null`, jamais une réussite ou un zéro inventé.

Le rapport ne contient ni moyenne arbitraire des scores de règles et neuronaux, ni taux de « confiance globale ».

## Diagnostics neuronaux, pas approbation

Pour les seules sorties neuronales disponibles, non rejetées, à taxonomie compatible et associées à une version de modèle, avec exactement une classe annotée :

- score de Brier multiclasse, somme des erreurs quadratiques par document puis moyenne (intervalle 0 à 2) ;
- ECE du label dominant sur dix intervalles de confiance de largeur 0,1, dernier intervalle incluant 1 ;
- effectifs, confiance moyenne et précision observée par intervalle ;
- effectifs exclus, avec motifs.

Les égalités utilisent un départage lexical reproductible pour ce diagnostic seulement. Les annotations multi-étiquettes ou vides sont exclues de ces diagnostics de distribution softmax. Mélanger plusieurs versions neuronales dans un même diagnostic est interdit. Sans sortie éligible, les mesures valent `null`.

Ce calcul ne calibre pas le modèle, ne mesure pas l'incertitude statistique et n'autorise aucune modification de la fusion. `approval_granted` reste `false`, même avec de bons scores. Les scores heuristiques des règles ne sont jamais traités comme des probabilités.

## Recette et suites

Validation sur le commit `a8b3373` : 98 tests Harness et 56 tests Python ciblés réussis, dont 20 nouveaux tests d'évaluation. La [recette avec services réels](https://github.com/Matt95354855/Harness/actions/runs/36589037305) a réussi et son artefact `synthetic-classification-evaluation` a été vérifié : deux documents, deux classifications `banking` attendues, F1 micro égal à 1 sur ces seuls exemples. Aucune sortie neuronale disponible : Brier/ECE à `null`, aucune approbation. La CI Node 22/24 et Python est également réussie.

Les tests unitaires vérifient les formules sur des cas calculables à la main, les partitions, les sorties incohérentes, les formats absents, les diagnostics neuronaux, la reproductibilité et la protection des rapports existants.

La recette GitHub `Mass real end-to-end` exporte les résultats réels de ses PDF/DOCX synthétiques, les compare aux annotations `banking` fixées dans le scénario et conserve le rapport comme artefact. Un score parfait sur ces deux pièces n'est pas une estimation de précision réelle.

Pour terminer l'étape métier : annoter un corpus représentatif, établir des familles sans fuite, figer des partitions distinctes, choisir des seuils d'acceptation selon les erreurs métier, évaluer la qualité OCR et calibrer un modèle sur la partition dédiée. L'évaluation du choix d'outils par le LLM est distincte et reste à construire. Aucune de ces validations n'est remplacée par les tests techniques.
