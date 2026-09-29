# Démarrer le parcours documentaire

Ce guide concerne la branche unifiée et l'API de production PDF/DOCX. Le mode découverte SQLite reste une démonstration textuelle distincte, sans OCR ni embeddings.

## Préparer le service

Prérequis : Docker Compose pour le service complet, Node.js 22.13 ou supérieur pour Harness. Depuis le dépôt contenant cette documentation :

```bash
cd services/mass-classification
cp .env.example .env
```

Dans ce fichier, remplacer `POSTGRES_PASSWORD` et le mot de passe de `DATABASE_URL` par une même valeur privée. Configurer les origines autorisées. Puis :

```bash
docker compose build
docker compose up -d db redis
docker compose run --rm api python -m mass_classification.admin create-key --tenant default --role analyst
docker compose up -d api worker
curl http://127.0.0.1:8000/health/ready
```

La commande de création de clé affiche `key_id=...` puis `token=mc_...`. Conserver uniquement la valeur `mc_...` dans la configuration Harness. Les modèles peuvent être téléchargés au premier traitement ; leur disponibilité doit être anticipée en environnement hors ligne.

## Configurer Harness

À la racine du dépôt, installer les dépendances avec `npm ci`, copier `.env.example` vers `.env`, puis compléter :

```dotenv
MASS_CLASSIFICATION_URL=http://127.0.0.1:8000
MASS_CLASSIFICATION_API_KEY=mc_votre_cle
MASS_INPUT_ROOTS=/chemin/absolu/documents
MASS_MAX_UPLOAD_BYTES=52428800
ALLOWED_TOOLS=mass_capabilities,mass_profile_document,mass_submit_document,mass_get_document,mass_search_evidence
```

`MASS_INPUT_ROOTS` est une liste de dossiers séparés par des virgules. La résolution canonique refuse les liens symboliques sortant des racines. L'URL doit être fixée par l'opérateur ; les redirections sont refusées. Utiliser HTTPS si le trafic quitte la machine locale.

`npm run doctor` confirme l'enregistrement des outils, pas l'état des services distants. Le fournisseur `mock` valide des scénarios déterministes : pour une sélection libre des outils, configurer un modèle réel selon le [guide local](local-model.md).

## Appeler l'adaptateur directement

Exemple TypeScript à placer à la racine du dépôt, puis exécuter avec `npx tsx exemple.ts` après avoir configuré les variables d'environnement :

```typescript
import { MassClassificationTools } from './src/index.js';

process.loadEnvFile('.env');
const mass = await MassClassificationTools.create({
  endpoint: process.env.MASS_CLASSIFICATION_URL!,
  apiKey: process.env.MASS_CLASSIFICATION_API_KEY!,
  inputRoots: process.env.MASS_INPUT_ROOTS!.split(','),
});
const context = { signal: AbortSignal.timeout(60_000), sessionId: 'document-example' };
const tools = mass.tools();
const submit = tools.find(tool => tool.name === 'mass_submit_document')!;
const receipt = await submit.execute({ path: '/chemin/absolu/documents/dossier.pdf' }, context);
if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || typeof receipt.id !== 'string') {
  throw new Error('Réponse de soumission invalide');
}
const result = await mass.waitForDocument(receipt.id, { timeoutMs: 240_000, intervalMs: 3000 });
console.log(result);
```

L'attente retourne un état terminal `ready` ou `failed` : vérifier le statut avant d'utiliser l'analyse. L'annulation arrête l'attente côté client, pas une tâche déjà soumise au worker. Un nouvel envoi du même fichier dans le même tenant renvoie son identifiant existant.

Le résultat de document omet le champ de texte intégral `content`. Les analyses et passages de recherche peuvent néanmoins contenir des données sensibles. Harness peut les conserver dans ses traces ; ajuster `PERSIST_TRACES`, `PERSIST_MEMORY` et les règles de conservation.

## Revue humaine

Ajouter explicitement `mass_submit_feedback` à `ALLOWED_TOOLS` pour enregistrer une revue avec un rôle `analyst` ou `admin`. En utilisation directe de la classe, passer `enableFeedback: true`. L'application appelante doit recueillir la décision humaine : activer l'outil ne prouve pas cette validation.

## Limites du traitement

L'OCR porte sur toutes les pages PDF et les images raster lisibles des DOCX. Le texte et les cellules DOCX sont ensuite extraits nativement. Les médias DOCX illisibles par Pillow peuvent être ignorés ; la mise en page, l'ordre entre images et paragraphes, les cellules PDF et l'exhaustivité des contenus complexes ne sont pas garantis. Le profil structurel ne mesure pas encore la qualité OCR ni la sensibilité.
