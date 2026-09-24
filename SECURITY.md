# Sécurité et traitement des données

## Modèle d'exécution

Harness est un processus Node.js local. Les outils enregistrés exécutent du code JavaScript avec les droits de ce processus. Le projet fournit une validation des paramètres, une liste d'outils autorisés et des limites d'exécution ; il ne fournit pas d'isolation système ni de frontière de sécurité entre code de confiance et code hostile.

Le registre contient un calculateur arithmétique qui analyse une grammaire limitée sans `eval`. La recherche n'est enregistrée que lorsqu'un fournisseur est fourni. Aucun outil de shell, d'accès au système de fichiers, à Google Drive, au Web ou à MCP n'est activé par défaut. Les outils de fichiers restent en lecture seule dans des racines canoniques déclarées. Le lecteur Web bloque les destinations locales et privées connues, mais un contrôle réseau externe reste recommandé dans un environnement hostile.

Un délai maximal arrête l'attente du harness et transmet un signal d'annulation. Il ne peut pas tuer une fonction synchrone qui bloque Node.js, ni garantir l'arrêt d'un outil personnalisé qui ignore ce signal. Exécuter du code non fiable exige une isolation supplémentaire hors de cette bibliothèque.

## Entrées et sorties du modèle

Les décisions du modèle sont validées avant exécution. Les noms d'outils, paramètres, types, valeurs autorisées et bornes sont vérifiés. Les paramètres inconnus sont rejetés. Les sorties d'outils doivent être sérialisables en JSON et respecter leur limite de taille.

Les résultats de recherche et le contexte stocké sont des données non fiables. Les prompts demandent au modèle de ne pas suivre les instructions qui pourraient y être incluses. Cette consigne réduit certaines erreurs ; elle ne garantit pas une protection contre toutes les injections de prompt.

## Réseau et secrets

- Le mode `mock` avec la recherche `fixture` ne contacte aucun fournisseur externe.
- Le mode compatible envoie le contexte au serveur défini par `LLM_ENDPOINT`.
- Les fournisseurs de recherche HTTP reçoivent les termes de recherche et, si elle est définie, une clé Bearer dédiée.
- Les URLs d'endpoint sont configurées par l'opérateur. Les clients n'acceptent pas les identifiants intégrés dans l'URL et refusent les redirections HTTP.
- Le harness n'est pas un proxy réseau public et ne filtre pas tous les réseaux privés. Ne pas laisser un utilisateur non fiable configurer ses endpoints.
- Utiliser HTTPS pour un serveur distant et limiter l'accès réseau aux serveurs locaux.

Conserver les clés dans l'environnement ou `.env`. Ne pas ajouter de secrets aux prompts, exemples, traces ou issues. Les fichiers `.env` locaux sont exclus de Git ; cet usage ne remplace pas un gestionnaire de secrets dans un déploiement partagé.

## Fichiers conservés

La persistance de la mémoire est optionnelle ; les traces sont activées par défaut. Les journaux sur disque sont optionnels. Les répertoires `.harness/`, de logs et de couverture ne doivent pas être versionnés.

Les écritures de mémoire et de traces utilisent un fichier temporaire privé et un renommage atomique. Les permissions de création sont restrictives sur les systèmes qui les honorent. Cela ne chiffre pas les données et ne corrige pas les permissions d'un répertoire parent déjà existant.

Le logger masque de manière indicative les clés de credentials connues et certains formats de jetons. **Ce filtrage n'est pas une garantie d'anonymisation.** La mémoire et les traces conservent des contenus de conversation et d'outils ; elles ne sont pas automatiquement débarrassées de tous les secrets. Inspecter tout fichier avant de le partager et choisir sa propre politique de conservation.

Le stockage JSON est prévu pour un écrivain par chemin de mémoire. Il ne fournit pas de verrouillage entre processus, de chiffrement, de contrôle d'accès par utilisateur ou de politique de rétention automatique.

## Signalement

Pour un problème sans donnée sensible, ouvrir une issue avec une reproduction minimale utilisant des fixtures. Ne pas publier de clé, de donnée personnelle ni de preuve d'exploitation contenant des secrets.

Si le dépôt propose le bouton GitHub **Report a vulnerability** dans l'onglet Security, l'utiliser pour un signalement sensible. Son activation dépend des réglages du propriétaire. Aucun délai de réponse ni programme de divulgation dédié n'est annoncé à ce stade.
