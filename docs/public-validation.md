# Produire des preuves publiques

Cette recette vérifie le Harness avec le modèle local et les connecteurs réellement configurés. Elle est conçue pour une capture de terminal, un dépôt GitHub ou une page de présentation : ses résultats ne contiennent ni jeton, ni contenu personnel, ni chemin local.

## Données utilisées

- une expression arithmétique fixe ;
- les fichiers publics du dépôt Harness (`package.json` et le code source) ;
- la page publique et stable `example.com` ;
- le dépôt GitHub public `Matt95354855/Harness` ;
- une recherche Web publique si un moteur est configuré ;
- une recherche Google Drive seulement si l'opérateur fournit volontairement un compte de test.

Les jetons GitHub et Google restent dans l'environnement du processus. Ils ne sont écrits ni dans les rapports ni dans les traces publiables.

## Préparation

Dans un premier terminal, démarrer le modèle local :

```bash
npm run local:llm
```

Dans un second terminal, vérifier la configuration :

```bash
npm run doctor
```

## Lancer la recette

Avec GitHub :

```bash
GITHUB_TOKEN="$(gh auth token)" npm run acceptance
```

Sans GitHub :

```bash
npm run acceptance
```

La sortie reste courte. Un scénario affiche `PASS` uniquement lorsque la trace contient le nom attendu, un statut `completed` et la preuve prévue dans le résultat de l'outil. `SKIP` signifie que la connexion n'est pas configurée ; ce statut ne doit pas être présenté comme une réussite.

## Rapports

Deux fichiers locaux sont produits :

- `.harness/acceptance-latest.md` pour GitHub ou le site ;
- `.harness/acceptance-latest.json` pour une exploitation automatisée.

Le dossier `.harness` est ignoré par Git. Relire le rapport Markdown avant de le copier volontairement dans une publication. Les traces détaillées ne sont pas nécessaires pour la capture principale ; elles servent seulement à auditer un résultat contesté.
