# Exemples exécutables

Lancer les commandes depuis la racine du dépôt, après `npm ci`. Tous ces exemples fonctionnent sans modèle installé ni service distant.

| Commande | Ce qu'elle vérifie |
| --- | --- |
| `npm run example:basic` | Décision, recherche sur fixtures, synthèse et trace. |
| `npm run example:multi-hop` | Deux requêtes distinctes, réflexion puis réponse. |
| `npm run example:advanced` | Outil `word_count`, autorisation explicite, sauvegarde et restauration de mémoire. |

`basic-search.ts` utilise le modèle de démonstration. Les deux autres exemples utilisent des décisions scriptées pour garantir un parcours reproductible. Leurs assertions vérifient les effets réels des outils ; les réponses rédigées restent des fixtures.

Les exemples basique et multi-hop produisent une trace dans `.harness/traces/`. L'exemple avancé utilise un répertoire temporaire qu'il nettoie après avoir vérifié la restauration.

Pour le prochain essai avec un vrai modèle, suivre [le guide local](../docs/local-model.md), puis utiliser `npm run dev -- run "Votre question"`. Les exemples de démonstration restent volontairement indépendants de cette configuration.
