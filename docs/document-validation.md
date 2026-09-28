# Validation du parcours documentaire

État vérifié le 25 septembre 2026 sur les branches de développement unifiées. Les résultats ne constituent pas une validation de production.

## Contrôles automatisés

| Contrôle | Résultat observé | Portée |
| --- | --- | --- |
| Harness | 98 tests réussis ; lint, typage et build réussis | Orchestration et adaptateurs, dont transports contrôlés |
| Python ciblé | 10 tests réussis | Démonstration, contrat de capacités, profilage |
| Services réels après étape 3 | Réussi, 2 min 20 s | PDF/DOCX, OCR, analyse, déduplication, feedback, recherche |
| Services réels après étape 4 | Réussi, 2 min 28 s | Même parcours avec empreintes et compteurs structurels vérifiés |

Preuves : [recette étape 3](https://github.com/Matt95354855/Harness/actions/runs/36139338676), [recette étape 4](https://github.com/Matt95354855/Harness/actions/runs/36142880989).

## Recette reproductible

Le workflow [mass-e2e.yml](../.github/workflows/mass-e2e.yml) démarre PostgreSQL/pgvector et Redis, installe Tesseract et les modèles, puis lance l'API et le worker. [mass-fixtures.py](../scripts/mass-fixtures.py) génère un PDF et un DOCX synthétiques. [mass-e2e.ts](../scripts/mass-e2e.ts) appelle directement l'adaptateur Harness.

Les assertions vérifient le texte visible uniquement dans une image, le montant d'un tableau, l'état `ready`, la classification `rules:v1`, la correspondance des SHA-256, les compteurs structurels, les doublons, le feedback, la recherche vectorielle et le refus d'une requête sans clé. Aucun service de base de données, OCR, embeddings ou transport HTTP n'est simulé dans cette recette.

Le workflow est déclenché sur les branches explicitement listées dans son fichier. Le déclenchement manuel GitHub sera disponible lorsque le workflow sera présent sur la branche par défaut. La CI ordinaire conserve les tests rapides ; elle ne lance pas automatiquement cette recette sur toutes les branches.

## Ce qui reste à évaluer

- Sélection autonome des outils par le LLM et routage adaptatif.
- Contrat métier normalisé et abstention, encore non implémentés.
- Précision OCR sur scans dégradés, langues et mises en page variées.
- Qualité de classification sur corpus annoté indépendant ; TNN entraîné et calibré.
- Isolation inter-tenants de bout en bout, reprise après panne, charge et restauration.

Les rapports [validation.md](validation.md) et [public-validation.md](public-validation.md) conservent les observations historiques du Harness et du petit modèle local. Leurs effectifs et scénarios ne doivent pas être assimilés à ceux de cette recette documentaire.
