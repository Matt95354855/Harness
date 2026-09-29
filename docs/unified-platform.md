# Plateforme unifiée Classcale

## Objectif

Réunir le Harness et Mass Classification dans un monorepo sans confondre leurs responsabilités. Le Harness décide quelles capacités autorisées utiliser et contrôle leur exécution. Mass Classification reste l'autorité pour l'ingestion, l'extraction, l'analyse et la provenance des résultats.

## Fondation livrée à l'étape 0

- le travail existant reste intact sur ses branches d'origine ;
- Mass Classification est stabilisé sur `integration/prepare-unified-platform` ;
- son historique est rattaché à celui du Harness ;
- son code est importé sous `services/mass-classification` ;
- la CI du monorepo vérifie séparément les composants TypeScript et Python ;
- cette étape initiale ne modifiait pas le comportement métier ; les étapes 2 à 4 ont ensuite ajouté les capacités, l'adaptateur et le profilage.

## Architecture cible (partiellement implémentée)

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
5. Le feedback humain est disponible sur activation explicite. L'abstention v1 couvre l'absence d'étiquette par règles ; la calibration reste à réaliser.
6. La clé Mass est conservée dans la configuration et envoyée par en-tête HTTP. Les traces peuvent contenir des paramètres, extraits et analyses sensibles : leur stockage et leur conservation doivent être configurés par l'opérateur.

## Contrat documentaire initial

La plateforme unifiée accepte uniquement les fichiers PDF et DOCX. Ils peuvent contenir du texte, des images et des tableaux. Le prétraitement suit cet ordre :

1. OCR Tesseract des pages PDF et des images incorporées aux DOCX ;
2. extraction native du texte PDF, des paragraphes DOCX et des cellules de tableaux DOCX ;
3. normalisation, segmentation, analyse et classification.

La route authentifiée `GET /v1/capabilities` expose cet ordre et les limites configurées. La détection OCR vérifie la présence de l'exécutable Tesseract sur l'hôte API ; celle du TNN vérifie la présence de `approved.pt` et `approved.json`. Ces contrôles ne prouvent ni la disponibilité sur un worker distant, ni la compatibilité ou la qualité des poids. Le champ `abstention_supported` du contrat actuel ne constitue pas une implémentation de l'abstention métier : son périmètre est défini par le contrat de résultat v1. Pour les PDF, la structure exacte des cellules des tableaux n'est pas garantie.

## État et travaux restants

1. Contrat commun v1 implémenté : [structure, statuts et limites](classification-result.md).
2. Capacités implémentées : PDF et DOCX uniquement dans l'API de production, OCR en première étape, limites de détection précisées ci-dessus.
3. Adaptateur HTTP implémenté et testé avec services réels : soumission, statut, analyse, preuves et feedback.
4. Profilage déterministe implémenté : `mass_profile_document` vérifie localement la taille, la signature et l'empreinte sans transfert. Le worker analyse ensuite la structure avant OCR et conserve `metadata.input_profile` avec l'analyse.
5. Première version du routeur déterministe livrée : parcours PDF/DOCX et blocage technique avant OCR. Adaptation à la qualité et abstention métier à poursuivre.
6. [Fusion et garde-fous](classification-fusion.md) : politique conservatrice implémentée, contributions séparées et désaccords signalés. Pondération statistique et calibration restent conditionnées à l'évaluation sur corpus annoté.
7. Évaluation métier : corpus annoté, calibration et mesures de qualité à constituer.
8. Recette de bout en bout : premier parcours synthétique réussi ; extension aux erreurs, à l'isolation inter-tenants et à la fiabilité du LLM à poursuivre.
9. Exploitation : validation de charge, restauration et déploiement à réaliser.

Les étapes 2 à 4 ont précédé la formalisation de l'étape 1, désormais implémentée. Les statuts de traitement restent distincts des statuts du champ `classification_result`.

## Profilage v1

Le profil local ne contient ni texte extrait ni chemin du document. Il vérifie la signature de base ; pour DOCX, la validité du conteneur Word reste vérifiée sur le serveur. Autoriser `mass_profile_document` dans `ALLOWED_TOOLS` et définir `MASS_INPUT_ROOTS` pour l'utiliser.

Le profil serveur calcule le SHA-256, compte les pages PDF, références d'images PDF, médias DOCX et tableaux XML DOCX. Il signale la présence de texte natif sans l'inclure dans le profil. Les fichiers chiffrés nécessitant un mot de passe, corrompus ou dépassant les limites sont rejetés avant OCR. Les archives DOCX sont bornées en taille décompressée et en nombre d'entrées ; les déclarations DTD et entités du XML principal sont rejetées.

Les pages DOCX et les tableaux PDF restent inconnus sans rendu ou analyse de mise en page. La langue, la sensibilité et la qualité OCR ne sont pas déduites de la seule structure : elles restent respectivement `unknown`, `not_assessed` et `not_measured`. Les compteurs d'images n'évaluent pas leur contenu. L'OCR reste obligatoire.

## Plan d'exécution v1

Le worker construit un plan déterministe depuis le profil validé et la présence de Tesseract sur sa propre machine. Un PDF sélectionne `pdf_ocr_native` ; un DOCX sélectionne `docx_image_ocr_native_tables`. Les deux parcours conservent les règles, embeddings et graphe existants. Cette version n'effectue ni sélection de modèle par qualité, ni arbitrage par LLM.

Le plan est persisté dans `metadata.classification_plan` et un événement `classification_planned` est audité avant l'extraction. Harness peut le consulter via `mass_get_document`, y compris après un blocage OCR. `planned` signifie qu'un parcours a été sélectionné, pas que le traitement a réussi : utiliser le statut du document pour cela.

Si Tesseract manque, le plan devient `blocked` et le document échoue explicitement. Aucun repli silencieux vers le seul texte natif n'est utilisé. Le blocage technique n'est pas une abstention de classification. Les poids topologiques restent conditionnels au checkpoint et au graphe ; leur présence ne garantit pas leur qualité. Le contrat v1 formalise désormais l'abstention en absence d'étiquette par règles.
