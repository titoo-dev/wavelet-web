# Déploiement sur Vercel

Wavelet tourne entièrement dans Next.js (pages + routes `src/app/api/v1/`), sans service Node externe.

| Besoin | Service Vercel |
|---|---|
| Hébergement + API | Vercel Functions (Fluid compute, runtime Node.js) |
| Base de données | Postgres via la Marketplace (Neon) |
| Fichiers audio | Cloudflare R2, bucket **privé** (hors Vercel) |

## 1. Créer le projet

1. Importer le repo sur [vercel.com/new](https://vercel.com/new). Le preset Next.js est détecté et `npm run build` lance `prisma generate && next build`.
2. **Storage → Create → Neon (Postgres)**, puis le connecter au projet. `DATABASE_URL` est injectée automatiquement.
3. **Cloudflare R2** : voir [Stockage audio](#stockage-audio-cloudflare-r2). Ajouter `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` et `R2_SECRET_ACCESS_KEY` aux variables du projet.
4. **Settings → Environment Variables** : ajouter `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (l'URL de production), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, et si besoin `WAVELET_SERVICE_ARL`, `SPOTIFY_CLIENT_ID` et `SPOTIFY_CLIENT_SECRET` (voir `.env.example`). Recommandé : `WAVELET_ENCRYPTION_KEY` (chiffrement des ARL — **la même valeur en Production et en Preview** si elles partagent la base), `WAVELET_ADMIN_EMAILS` (qui peut changer la qualité serveur) et `CRON_SECRET` (nettoyage quotidien du stockage).
5. Dans la console Google OAuth, ajouter `https://<domaine>/api/auth/callback/google` aux redirect URIs.

## Lecture multi-appareils (Convex)

La Playback Session, les Devices et les Commands vivent sur Convex (`convex/`, docs/adr/0001) ; sans `NEXT_PUBLIC_CONVEX_URL`, chaque onglet joue seul comme avant.

1. Créer le projet Convex : `npx convex login`, puis `npx convex deploy` (déploiement de production). Noter l'URL `https://<nom>.convex.cloud`.
2. Sur le déploiement Convex : `npx convex env set BETTER_AUTH_URL https://wavelet.titosy.dev --prod`. Convex vérifie les JWT avec les clés de `${BETTER_AUTH_URL}/api/auth/jwks` (docs/adr/0002) ; l'`iss` doit être exactement cette URL.
3. Dans Vercel : `NEXT_PUBLIC_CONVEX_URL` (l'URL du déploiement, lue au build), et `CONVEX_DEPLOY_KEY` (Convex → Settings → Deploy key) pour redéployer les fonctions : `npx convex deploy` à chaque changement de `convex/` (à la main, ou en remplaçant la commande de build Vercel par `npx convex deploy --cmd 'npm run vercel-build'`).
4. La migration `jwks` (clés de signature du plugin `jwt`) part avec le prochain build, comme les autres.
5. Mobile : `WAVELET_CONVEX_URL` dans `env/prod.env` de l'app Flutter.

## 2. Schéma de la base

Le schéma est géré par des migrations Prisma (`prisma/migrations/`). Le build Vercel (`vercel.json` → `npm run vercel-build`) lance `prisma migrate deploy` avant `next build`, sur la connexion directe `DATABASE_URL_UNPOOLED` (le pooler Neon ne supporte pas les verrous de migration). Rien à faire à la main.

Pour modifier le schéma : éditer `prisma/schema.prisma`, puis lancer `npm run db:migrate -- --name <nom>` contre une base de dev. La migration générée est commitée, puis appliquée au prochain déploiement.

## 3. Développement local

```bash
vercel env pull .env.local   # R2_* du bucket de dev (+ variables non sensibles)
npm run dev
```

- **R2** : l'environnement Development a son propre bucket (`wavelet-music-dev`) et son propre token, qui n'a aucun droit sur le bucket de prod (`wavelet-music`).
- **Postgres** : les variables Neon sont « Sensitive » et ne sont pas récupérées par `vercel env pull`. En local, `DATABASE_URL` (dans `.env` ou `.env.local`) pointe vers un Postgres local, par exemple un conteneur Docker, ou vers une branche Neon de dev. Pour une base existante créée avant les migrations : `npx prisma db push`, puis `npx prisma migrate resolve --applied 0_init`.

## Fonctionnement du streaming

- **Premier play** (`/api/v1/stream-progressive/[trackId]`) : déchiffrement Deezer à la volée. Les octets déchiffrés sont d'abord écrits dans un fichier `/tmp`, et la réponse HTTP lit ce fichier au rythme du client, avec `Content-Length`. Les requêtes `Range` partielles sont servies en direct depuis le CDN Deezer, ce qui permet le seek dès la première écoute. Une fois le titre complet et vérifié, il est tagué puis uploadé dans R2 sous `tracks/{trackId}/{bitrate}.ext`. Cette persistance tourne dans `after()` (`maxDuration = 300`). Une deuxième écoute sur la même instance lit le même fichier ; sur une autre instance, la ligne `PersistLease` évite une seconde persistance et le titre joue en direct.
- **Plays suivants** : `/api/v1/stream-url/[trackId]` renvoie une URL R2 pré-signée d'une heure (avec `expiresAt`), lue directement par le navigateur (le transfert sortant R2 est gratuit et ne passe pas par Vercel). Si elle échoue (CORS, réseau), le lecteur bascule sur le proxy same-origin `/api/v1/stream/[trackId]`, qui gère les `Range`.
- `WAVELET_DISABLE_PRESIGNED_URLS=1` force le proxy pour tout le monde.
- **Stockage en panne ou qui refuse la lecture** (403, 5xx, config absente) : `/stream` redirige vers `/stream-progressive/[trackId]?live=1`, qui joue directement depuis Deezer sans repasser par le cache. Les lignes `StoredTrack` sont conservées.
- **Qualité** : la copie servie est choisie par `storage/cached-copy.ts` selon la qualité serveur (`maxBitrate`) plafonnée par la licence Deezer de l'auditeur. Une copie plus basse que ce qu'il peut écouter est re-persistée à la qualité demandée.
- **Nettoyage** : un cron Vercel quotidien (`vercel.json`) appelle `/api/v1/internal/gc` avec `CRON_SECRET`. Il supprime les copies sans référence depuis plus de 24 h et les objets orphelins sous `tracks/`. Sans `CRON_SECRET`, la route ne fait rien.
- **Après le premier déploiement** : lancer une fois `npx tsx scripts/repair-stored-track-keys.ts` (simulation), puis `--apply`. Le script supprime les anciennes lignes qui partageaient un même objet `music/…` entre plusieurs titres ; ces titres seront re-cachés sous leur propre clé.

## Stockage audio (Cloudflare R2)

Les fichiers audio sont dans R2 plutôt que dans Vercel Blob : en Hobby, Blob est limité à 10 Go de transfert par mois et bloque le store pendant 30 jours une fois la limite dépassée (c'est arrivé en octobre 2026). R2 n'a pas de frais de sortie et offre 10 Go de stockage gratuits.

- Deux buckets privés, région ENAM : `wavelet-music` (Production + Preview) et `wavelet-music-dev` (Development).
- CORS sur les deux : `GET`/`HEAD` depuis toutes les origines, en-têtes `range`, exposés `Content-Length`, `Content-Range`, `Accept-Ranges`, `Content-Type`, `ETag`. Les URL pré-signées restent la seule clé d'accès.
- Un token API de compte par bucket (permission « Workers R2 Storage Bucket Item Write », limitée au bucket). Identifiants S3 : `R2_ACCESS_KEY_ID` = id du token, `R2_SECRET_ACCESS_KEY` = SHA-256 (hex) de sa valeur.
- Code : `src/lib/wavelet/storage/r2.ts` (client signé avec `aws4fetch`), `R2StorageProvider.ts` (écritures), `src/lib/object-stream.ts` (lectures et URL pré-signées).

## Migration depuis les anciens stockages (S3 / MinIO / Vercel Blob)

Les fichiers ne sont pas migrés. Les lignes `StoredTrack` avec `storageType` `s3`, `local` ou `blob` sont supprimées automatiquement au premier play : le titre est re-streamé depuis Deezer, puis remis en cache dans R2.

La séparation de stems (Demucs, BullMQ, Redis) a été retirée. Elle demandait Python et torch, plusieurs Go de RAM, et des jobs plus longs que la durée maximale d'une fonction.
