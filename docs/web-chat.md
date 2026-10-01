# Harness Chat sur Windows

Application privée de chat, stockée et exécutée sur ce PC. L'inférence utilise les modèles GGUF installés et passe réellement par `Agent`, la mémoire et les outils du Harness.

## Accès et premier compte

- **Harness Setup** sur le bureau ouvre la configuration locale protégée par une clé aléatoire. Choisir un identifiant, un mot de passe unique (15 caractères minimum) et enregistrer le QR dans une application TOTP. Conserver les 8 codes de récupération dans un gestionnaire de mots de passe. Le code utilisé pendant la création ne peut pas être réutilisé immédiatement : attendre le suivant pour se connecter.
- **Harness Chat** ouvre `http://127.0.0.1:3082` sur ce PC sans page de connexion. Ce service écoute exclusivement sur l'adresse de boucle locale et vérifie l'origine et l'hôte des requêtes. L'accès public conserve le mot de passe et le second facteur.
- **Harness Public** ouvre l'adresse HTTPS du tunnel de test. L'adresse actuelle se trouve dans `.harness/web/public-url.txt`.
- Aucun compte ou mot de passe par défaut, aucune inscription sur Internet. La configuration écoute séparément sur `127.0.0.1:3081`. Ne jamais publier ce port.

## Conversations et modèles

Le sélecteur choisit GPT-OSS 20B MXFP4 ou Qwen3.6 27B Q4_K_M pour le prochain message. Un seul modèle est chargé à la fois, compte tenu des 16 Go de RAM et des 15 Go de VRAM du PC. Le changement peut prendre plusieurs dizaines de secondes. Le modèle chargé reste disponible ; un contrôle automatique le relance après une panne.

Les requêtes sont sérialisées (maximum quatre en attente/en cours). L'interface affiche l'attente et permet d'arrêter une réponse. Elle récupère son état après rechargement. L'interface utilise un suivi périodique, pas un faux affichage de jetons en streaming.

SQLite conserve les messages et les notes après redémarrage. Le contexte de calcul est de 4096 tokens : seule une fenêtre récente, bornée, de l'historique est présentée au modèle. Les notes du bouton **Mémoire** servent à garder explicitement les informations durables, même après changement de modèle. L'interface affiche les 200 derniers messages et les 500 conversations les plus récentes ; la base conserve les messages plus anciens. Ce n'est pas un système de recherche sémantique de tout l'historique.

Le chat charge maintenant tout le registre d'outils du Harness disponible au démarrage : calcul, recherche Web, lecture de pages et fichiers locaux en lecture seule. Les connecteurs Mass Classification, Google Drive et MCP sont ajoutés automatiquement quand leur service, leurs identifiants ou leur fichier de configuration sont présents. `GET /api/models` indique les outils actifs et les familles encore indisponibles.

Par défaut, les outils locaux peuvent parcourir le dossier parent des dépôts afin d'accéder à `harness` et `mass classification`. Ils ne peuvent ni écrire ni exécuter de commande. Les chemins sensibles (`.env`, `.harness`, `.git`, environnements virtuels, `node_modules`, bases de chat, identifiants et clés privées) sont masqués et refusés. Définir `LOCAL_FILE_ROOTS` avec une liste de chemins absolus séparés par des virgules pour réduire cette portée.

La recherche envoie les termes à DuckDuckGo et la lecture de page accepte uniquement les adresses HTTP(S) publiques avec des limites de taille et de redirection. Les réponses sont affichées comme texte/code, sans HTML actif.

## Sécurité mise en place

- Argon2id (64 MiB, 3 passes) pour les mots de passe, TOTP obligatoire, rejet des codes réutilisés ; codes de secours aléatoires stockés sous forme d'empreintes, utilisables une fois avec le mot de passe.
- Clé TOTP chiffrée AES-256-GCM. La clé de chiffrement et la base sont protégées par les ACL Windows (compte courant et SYSTEM). Les conversations ne sont **pas chiffrées dans SQLite** : activer BitLocker pour protéger le disque en cas de vol.
- Sessions aléatoires de 256 bits, seulement leurs empreintes sont stockées ; cookies HTTPS `__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`. Expiration après 30 minutes d'inactivité ou 24 heures absolues. Le suivi automatique des réponses ne prolonge pas l'inactivité.
- Déconnexion de tous les appareils et changement du mot de passe avec réauthentification (mot de passe actuel + nouveau code TOTP).
- Vérification stricte Host/Origin, JSON et jeton CSRF pour les écritures ; CSP restrictive, protection contre l'inclusion en iframe, limites de taille, requêtes SQL paramétrées et contrôle du propriétaire de chaque conversation.
- Limite globale des connexions et verrouillage du compte 15 minutes après 5 échecs ; le verrouillage du compte survit au redémarrage. Les protections globales en mémoire se réinitialisent au redémarrage.
- Le serveur d'inférence écoute exclusivement sur `127.0.0.1:8082`, sans exposition par le tunnel. Aucun port entrant de la box n'a besoin d'être ouvert.

Ces contrôles sont testés, mais ne constituent pas un audit de sécurité indépendant ni une garantie d'inviolabilité. Maintenir Windows, Node, llama.cpp et les dépendances à jour. TOTP ne protège pas autant du phishing qu'une passkey matérielle. Un administrateur ou logiciel malveillant sur le PC peut accéder aux données locales.

## Accès public et disponibilité réelle

En l'absence de domaine, `run-public-preview.ps1` utilise un **Cloudflare Quick Tunnel temporaire**, réservé aux tests. Le superviseur le relance s'il s'arrête et actualise le raccourci public. L'adresse change après redémarrage du tunnel ; ce mode n'a pas de garantie de disponibilité et ne remplace pas un hébergement permanent.

Pour une adresse stable : acquérir ou fournir un domaine, créer un tunnel Cloudflare nommé, le diriger **uniquement vers `http://127.0.0.1:3080`**, configurer le même hostname HTTPS dans `.harness/web/deployment.json` (`{"mode":"named","origin":"https://chat.votre-domaine.fr"}`), puis installer le connecteur en service Windows et réinstaller le raccourci de démarrage. Ajouter idéalement Cloudflare Access avec MFA comme seconde barrière. Ne pas activer de cache pour les routes de l'application.

Le stockage et l'inférence restent sur le PC, mais **Cloudflare termine TLS et relaie le trafic** de l'accès public : ce n'est pas un chiffrement de bout en bout qui exclut Cloudflare.

Le démarrage automatique actuellement installé se fait **à l'ouverture de la session Windows**, pas avant connexion. Un véritable service de démarrage système nécessite une installation administrateur adaptée. La veille et l'hibernation automatiques sur secteur ont été désactivées pour permettre l'hébergement ; les réglages sur batterie restent inchangés. Un PC éteint, une fermeture du capot provoquant la veille, une panne Internet ou une mise à jour Windows interrompent l'accès.

## Commandes et maintenance

Depuis le dossier `harness` :

```powershell
npm run build
npm run web:install
npm run web:setup
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop-web.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-web.ps1
```

Le superviseur redémarre Node après une panne et nettoie uniquement le processus llama.cpp qu'il a lancé. `stop-web.ps1` arrête proprement le serveur, le modèle et le tunnel ; `start-web.ps1` supprime la demande d'arrêt et relance le service. Pour désactiver le lancement automatique, retirer le raccourci **Harness Chat** du dossier Démarrage Windows après avoir arrêté le serveur.

Les données privées sont dans `.harness/web/` (ignoré par Git). Sauvegarder **tout ce dossier après arrêt propre**, notamment `chat.sqlite` et `encryption.key`, sur un support chiffré. Sans la clé, les secrets TOTP stockés ne sont plus lisibles. Ne pas partager ce dossier ni ses journaux. Les journaux du moteur tournent à 5 Mo ; les logs du serveur sont renouvelés à chaque redémarrage. Les événements de sécurité n'incluent pas les mots de passe ni les corps des requêtes.

Pour remettre une veille sur secteur de 15 minutes : `powercfg /change standby-timeout-ac 15`.

## Vérifications

```powershell
npm run web:test
npm run lint
npm run typecheck
```

Le test matériel explicite `npx tsx scripts/web-smoke.ts` nécessite d'arrêter le service normal (il utilise les mêmes ports). Il crée un compte et une base temporaires, teste la connexion MFA, une vraie réponse GPT-OSS, la mémoire réutilisée avec Qwen et un appel `calculate`, puis supprime uniquement ses données temporaires. Il n'utilise pas le compte personnel.

Références : [sessions OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [authentification OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), [tunnels Cloudflare](https://developers.cloudflare.com/tunnel/get-started/).
