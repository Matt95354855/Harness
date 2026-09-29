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

## Contrat documentaire initial

La plateforme unifiée accepte uniquement les fichiers PDF et DOCX. Ils peuvent contenir du texte, des images et des tableaux. Le prétraitement suit cet ordre :

1. OCR Tesseract des pages PDF et des images incorporées aux DOCX ;
2. extraction native du texte PDF, des paragraphes DOCX et des cellules de tableaux DOCX ;
3. normalisation, segmentation, analyse et classification.

La route authentifiée `GET /v1/capabilities` expose cet ordre, les limites actives, la disponibilité de Tesseract et celle d'un éventuel checkpoint approuvé. Pour les PDF, les tableaux sont d'abord restitués comme texte OCR ; la structure exacte des cellules n'est pas garantie à ce stade.

## Prochaines étapes

1. Définir le contrat commun de classification et ses statuts.
2. Exposer les capacités réellement disponibles dans Mass Classification. **En cours : PDF et DOCX uniquement, OCR en première étape.**
3. Créer l'adaptateur HTTP asynchrone dans Harness. **En cours : soumission, statut, preuves et feedback.**
4. Profilage déterministe implémenté : `mass_profile_document` vérifie localement la taille, la signature et l'empreinte sans transfert. Le worker analyse ensuite la structure avant OCR et conserve `metadata.input_profile` avec l'analyse.
5. Construire le routeur adaptatif et ses règles d'abstention.
6. Ajouter les tests de bout en bout sur données synthétiques.

## Profilage v1

Le profil local ne contient ni texte extrait ni chemin du document. Il vérifie la signature de base ; pour DOCX, la validité du conteneur Word reste vérifiée sur le serveur. Autoriser `mass_profile_document` dans `ALLOWED_TOOLS` et définir `MASS_INPUT_ROOTS` pour l'utiliser.

Le profil serveur calcule le SHA-256, compte les pages PDF, références d'images PDF, médias DOCX et tableaux XML DOCX. Il signale la présence de texte natif sans l'inclure dans le profil. Les fichiers chiffrés nécessitant un mot de passe, corrompus ou dépassant les limites sont rejetés avant OCR. Les archives DOCX sont bornées en taille décompressée et en nombre d'entrées ; les déclarations DTD et entités du XML principal sont rejetées.

Les pages DOCX et les tableaux PDF restent inconnus sans rendu ou analyse de mise en page. La langue, la sensibilité et la qualité OCR ne sont pas déduites de la seule structure : elles restent respectivement `unknown`, `not_assessed` et `not_measured`. Les compteurs d'images n'évaluent pas leur contenu. L'OCR reste obligatoire. Le routeur adaptatif de l'étape 5 n'est pas encore implémenté.
