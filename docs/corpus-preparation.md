# Étape 8 — Préparer le corpus métier

## Livraison et validation différée

`mass-corpus` prépare un corpus privé sans OCR, téléchargement, base de données,
appel de LLM ni inférence neuronale. Il inventorie les fichiers locaux, produit
un brouillon d'annotation et exporte, après revue explicite, le contrat
`classification-corpus:v1` utilisé par l'évaluateur de l'étape 7.

Cette étape prépare la validation métier ; elle ne la réalise pas. **Les tests
de cette livraison sont écrits mais n'ont pas été exécutés**, conformément au
report demandé. Aucun nouveau score, gain de précision, modèle calibré ou
choix autonome d'outil n'est revendiqué. Le routage et la fusion de production
ne changent pas. Ne pas déployer cette livraison sans sa validation ultérieure.

## 1 — Préparer les fichiers et les droits

Utiliser un dossier privé, stable pendant l'opération, hors du dépôt Git. Les
sous-dossiers sont parcourus ; seules les extensions PDF/DOCX sont retenues.
Les fichiers non documentaires sont ignorés. Les liens symboliques de dossiers
et les documents symboliques sont refusés, ainsi que les fichiers illisibles,
vides, trop gros ou dont la signature de base ne correspond pas au format.

La signature `%PDF` ou ZIP ne valide pas l'intégrité complète du PDF ou du
conteneur Word : le profilage serveur reste indispensable lors du traitement.
L'outil n'est pas un bac à sable contre une modification hostile du système de
fichiers pendant son exécution. Il ne faut pas l'utiliser sur un dossier partagé
en cours de modification.

DocLayNet est une piste pour la diversité des PDF, pas une annotation métier
directement compatible. Les catégories de mise en page et les familles du
dataset ne deviennent pas automatiquement `banking`, `investigation`, `media`.
Référence : <https://github.com/DS4SD/DocLayNet>. Vérifier les droits de la version
utilisée et conserver la référence de licence ; l'outil ne les vérifie pas en ligne.
Ajouter séparément de vrais DOCX. Aucun téléchargement n'est automatisé ici.

## 2 — Créer un inventaire à annoter

Depuis `services/mass-classification`, dans l'environnement Python du service :

```bash
python -m mass_classification.corpus inventory \
  --root /chemin/prive/documents \
  --dataset-id classcale-pilote-v1 \
  --source-reference 'Référence de la source et de sa version' \
  --rights-reference 'Référence de licence et conditions vérifiées par l’opérateur' \
  --synthetic false \
  --output /chemin/prive/annotations.json
```

Le paquet expose aussi `mass-corpus`. Le dossier de sortie doit exister et le
fichier ne doit pas exister. La limite par fichier est 52 428 800 octets,
modifiable avec `--max-bytes`. La lecture est bornée et calcule SHA-256 par blocs.
L'inventaire échoue sur les doublons exacts : choisir une version canonique et
conserver à part leur provenance avant de recommencer, sans supprimer les sources.

Le brouillon `classification-corpus-draft:v1` contient les chemins **relatifs**,
empreintes, tailles et formats. `labels`, `group_id`, `split` et `document_id`
sont initialement `null` ; `reviewed` et `rights_confirmed` sont `false`.
Les chemins relatifs et références restent potentiellement sensibles. Les
sorties sont créées exclusivement, avec permissions 0600 sur POSIX. Stocker aussi
le dossier dans un espace protégé et ne pas versionner ces données privées.

## 3 — Annoter indépendamment des prédictions

Établir un guide métier avec des cas positifs et négatifs avant de lire les
résultats du classifieur. Les mots-clés de `rules:v1` ne doivent pas servir de
vérité terrain : cela ferait seulement mesurer l'accord avec les règles.

Pour chaque document, renseigner :

| Champ | Décision attendue |
| --- | --- |
| `labels` | Une ou plusieurs classes parmi `banking`, `investigation`, `media` ; `[]` pour un document relu hors périmètre ; jamais `null` pour une annotation terminée |
| `reviewed` | `true` uniquement après la revue effective |
| `group_id` | Même identifiant pour toutes les pages, variantes, traductions ou duplications d'un même dossier |
| `split` | `train`, `calibration` ou `test`, attribué au groupe entier |
| `document_id` | Identifiant réel renvoyé ultérieurement par l'API pour ce fichier ; pas un identifiant inventé |

Définir les frontières de `banking` (pas tout document financier),
`investigation` (pas tout texte juridique) et `media` (pas toute occurrence du mot
article). Ce sont des questions de taxonomie à trancher par l'opérateur, pas des
nouveaux critères de classification ajoutés par cet outil.

Prévoir une seconde revue d'un sous-ensemble et un arbitrage des désaccords.
Décrire le protocole, sa version et la campagne dans `annotation_provenance`.
Confirmer `rights_confirmed: true` seulement après vérification des droits.
Ces déclarations ne sont pas des signatures ni une preuve automatique de revue.

Garder un test final intouché pendant les réglages. Définir les groupes avant
le découpage, éviter les quasi-doublons et noter l'historique d'entraînement.
L'outil ne détecte pas les similarités visuelles et ne fait pas de stratification
automatique. Le pilote envisagé de 300 pages PDF, 50 DOCX et 30 à 50 scénarios
LLM reste une proposition ; il n'est ni téléchargé, ni annoté, ni exécuté.

## 4 — Finaliser quand les ressources seront disponibles

L'annotation peut être commencée sans serveur. Après la soumission future des
documents au service, reporter leurs identifiants API en vérifiant la
correspondance avec l'empreinte. L'outil de préparation ne contacte pas l'API et
ne peut pas authentifier ces identifiants. L'évaluateur vérifie ensuite leur
cohérence avec les résultats figés.

```bash
python -m mass_classification.corpus finalize \
  --root /chemin/prive/documents \
  --draft /chemin/prive/annotations.json \
  --output /chemin/prive/corpus-v1.json
```

La finalisation relit les fichiers, vérifie empreinte, taille et format, exige
toutes les annotations et utilise le validateur `Corpus` existant. Il refuse
notamment les identifiants dupliqués et une famille répartie entre plusieurs
partitions. Une partition peut être vide : l'évaluateur refusera d'évaluer une
partition vide. Aucun équilibre statistique n'est certifié.

Le manifeste final omet chemins, tailles, références de droits et drapeaux de
revue pour respecter le contrat existant. Conserver **le brouillon relu avec le
manifeste**, ainsi que les sources et le protocole, dans le dossier privé de la
campagne. SHA-256 vérifie l'intégrité, pas la provenance ni la qualité des annotations.
L'export déterministe n'ajoute pas de date variable et ne remplace jamais un fichier.

Exporter ensuite les résultats terminaux API, y compris les échecs, et suivre
le [guide d'évaluation](classification-evaluation.md). Le succès de `finalize`
ne veut pas dire que les documents ont été traités ou bien classés.

## 5 — Recette à exécuter plus tard

Les tests hors ligne sont dans `tests/test_corpus.py`. Ils couvrent inventaire
sans annotations inventées, reproductibilité, contrat final, revue manquante,
hors périmètre, intégrité, doublons, fuite entre partitions, chemins, liens,
taille, signatures, sorties privées et protection des fichiers existants.

```bash
python -m pytest -q tests/test_corpus.py tests/test_evaluation.py
```

Puis lancer les contrôles complets du dépôt et la recette réelle PDF/DOCX.
Enfin seulement : corpus métier annoté, mesures OCR indépendantes, évaluation
du choix d'outils par un LLM réel, calibration éventuelle et tests de charge.
La commande ci-dessus est une procédure à exécuter, pas un résultat de test.

Codes de sortie : 0 pour une préparation réussie, 2 pour une entrée ou sortie
refusée. Les erreurs de validation n'impriment pas les chemins ni annotations
dans leur message. Une erreur d'écriture peut laisser une sortie partielle :
la conserver pour diagnostic et choisir un nouveau chemin avant de réessayer.
