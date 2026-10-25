# Lyrics Stories — spec et plan d'implémentation

Statut : **spécifié, spike validé** (2026-10-24). Un rendu de 30 s en 1080p prend environ 41 s sur Vercel (2 vCPU) avec 170 Mo de RAM ; le détail est dans l'ADR 0004. L'étape 1 est faite : Theme Stills en JPEG 720×1280, rendus en 20 à 50 ms. L'étape 2 est faite : Story Render, avec un rendu réel de 25 s en 1080p en 14 s en local (`scripts/e2e-story.ts`). Les étapes 3 et 4 (mobile) sont les prochaines. Le vocabulaire est défini dans `CONTEXT.md` (§ Lyrics Stories). Les décisions et leurs raisons sont dans docs/adr/0004 (rendu dans une fonction Vercel), 0005 (le client envoie les lignes) et 0006 (garde-fous).

## Ce que voit l'utilisateur (mobile, v1)

1. **Point d'entrée**, au choix :
   - le bouton « Partager en story » de la vue paroles (Now Playing) ;
   - un appui long sur une ligne de paroles, qui démarre la sélection à cette ligne ;
   - « Partager en story » dans le menu d'actions d'un titre, qui ouvre la sélection pour ce titre même s'il n'est pas en lecture.
   - Un titre sans paroles synchronisées (`hasUsableSync` faux) n'a pas de partage en story : le bouton est masqué dans le menu et grisé dans la vue paroles.
2. **Lyrics Range** :
   - on touche une première ligne puis une dernière ;
   - la durée s'affiche, et une ligne qui ferait dépasser 30 s ne peut pas être ajoutée ;
   - il faut au moins 5 s.
   - Un bouton lance la **Preview** de l'extrait sur ce téléphone. Elle reste hors de la Playback Session et, sur un Remote, met en pause l'Active Device.
3. **Story Theme** : un carrousel de 4 **Theme Stills** (Pochette floutée, Palette, Minimal, Vinyle), rendus par le serveur. Le dernier thème choisi est retenu.
4. **Rendu** :
   - écran de progression ; l'utilisateur peut le quitter ;
   - une notification locale « Ta story est prête » le prévient ;
   - en cas d'échec : message et bouton Réessayer.
5. **Résultat** :
   - le MP4 est téléchargé puis lu en boucle ;
   - deux boutons : **Partager** (feuille du système, `share_plus`) et **Enregistrer dans la galerie**.

## Règles

| Sujet | Règle |
|---|---|
| Extrait | 5 à 30 s, par lignes entières. Début = 1re ligne − 0,3 s (jamais < 0). Fin = début de la ligne qui suit la dernière, ou + 4 s si c'est la dernière de la chanson, plafonnée à la durée du titre. Fondus d'entrée et de sortie de 0,3 s. Les 30 s portent sur [début, fin]. |
| Vidéo | MP4 1080×1920, 30 fps, H.264 (yuv420p, `+faststart`), AAC 192 kbps. |
| Animation | Ligne par ligne sur les horodatages LRC : ligne courante mise en avant, les autres estompées, défilement. Pas de mot à mot (les parsers suppriment les balises au mot). |
| Contenu | Paroles, titre, artiste, petit filigrane « Wavelet ». Ni lien ni QR code. |
| Écritures | Latin, cyrillique, grec : Geist, avec Noto Sans en secours. Un glyphe absent ne doit pas faire échouer le rendu. |
| Paroles | Envoyées par le client (ADR 0005) : 1 à 30 lignes de 200 caractères maximum, caractères de contrôle retirés, horodatages croissants. |
| Audio | Copie en cache dans R2 (`findCachedCopy`), sinon la plage est déchiffrée depuis Deezer avec l'ARL de l'utilisateur, à la qualité plafonnée par sa licence (`capByLicence`). |
| Limites | 1 Story Render en cours par utilisateur, 20 par jour (les échecs ne comptent pas). Theme Stills : limite par minute contre les abus, sans quota journalier. |
| Réutilisation | Même utilisateur, titre, plage (début et fin en ms), thème et texte (hash) dans les 24 h : on renvoie le Story Render existant. |
| Durée de vie | Le MP4 sous `stories/{userId}/{renderId}.mp4` dans R2 n'est plus téléchargeable 24 h après être prêt (le statut passe à `expired`). Le cron quotidien l'efface au passage suivant, donc au plus 48 h après. La ligne est purgée après 7 jours. Pour un effacement à 24 h pile, ajouter une règle de cycle de vie R2 sur le préfixe `stories/` (1 jour). |
| Accès | Connecté uniquement, chacun ne voit que ses Story Renders. Le MP4 est servi par une URL pré-signée d'1 h. |

## Thèmes

Chaque thème est une fonction pure `draw(ctx, frame)`. `frame` contient le temps, les lignes, l'index de la ligne courante et sa progression, la pochette, la palette et les métadonnées. Les fonds statiques (pochette floutée, dégradé) sont pré-calculés une seule fois par rendu.

- **Pochette floutée** : fond = pochette floutée et assombrie, pochette nette en haut, paroles au centre, titre et artiste sous la pochette.
- **Palette** : dégradé tiré de `seedFromPixels` (`cover-palette.ts`, partagé avec CoverTheme), grosse typographie expressive.
- **Minimal** : fond noir, typo Geist, petite pochette en bas, très sobre.
- **Vinyle** : la pochette en disque qui tourne (rotation selon `t`), paroles en dessous.

Le Theme Still est la frame du milieu de la première ligne : même `draw`, rendue en PNG.

## Architecture

### Web (`wavelet-web`)

```
src/lib/story/
  range.ts          # validation d'une Lyrics Range + bornes de l'extrait (marge, fin, plafond 30 s)  — pur
  timeline.ts       # t → ligne courante, progression, opacités, défilement                         — pur
  layout.ts         # découpe des lignes en lignes visuelles, taille de police, sans débordement   — pur (mesure injectée)
  themes/{blurred-cover,palette,minimal,vinyl}.ts + index.ts
  fonts.ts          # enregistrement de Geist + Noto Sans (assets/fonts/)
  audio-source.ts   # extrait audio → fichier /tmp : copie R2 (URL pré-signée) ou plage Deezer déchiffrée
  render.ts         # pipeline : fond pré-calculé → frames RGBA → ffmpeg (stdin) + audio → MP4 /tmp → R2
  limits.ts         # en cours / quota journalier / réutilisation
src/app/api/v1/stories/
  route.ts                 # POST : crée ou réutilise un Story Render, puis after(render)  (maxDuration 300, runtime nodejs)
  [renderId]/route.ts      # GET : statut, progression, URL pré-signée quand prêt
  stills/route.ts          # POST : PNG d'un Theme Still
prisma : modèle StoryRender + migration
internal/gc : supprime les MP4 > 24 h et les lignes > 7 j, et passe en échec les lignes bloquées en rendering depuis > 6 min
```

**Modèle `StoryRender`** :
- champs : `id`, `userId`, `trackId`, `theme`, `startMs`, `endMs`, `linesHash`, `lines` (JSON, pour pouvoir relancer), `title`, `artist`, `coverUrl`, `status` (`queued` | `rendering` | `ready` | `failed`), `progress` (0–1), `storagePath`, `error`, `createdAt`, `readyAt` ;
- index sur (`userId`, `createdAt`) et sur (`userId`, `trackId`, `theme`, `startMs`, `endMs`, `linesHash`).

**Dépendances** :
- `ffmpeg-static` (binaire Linux x64) ;
- `@napi-rs/canvas` (canvas natif, binaires précompilés, sans dépendances système) ;
- Pas de `sharp` : `@napi-rs/canvas` décode la pochette, la floute (`ctx.filter`) et en tire la palette.
- Il faut vérifier que `next.config` embarque bien le binaire ffmpeg dans la fonction (`outputFileTracingIncludes`) et que le bundle reste sous 250 Mo.

**Audio d'un titre pas en cache** :
- On demande de préférence du MP3 (CBR) : l'offset en octets d'un instant se calcule alors avec le débit, et on déchiffre la plage [début − 1 s, fin + 1 s] arrondie aux blocs de 2 048 octets (`stripe.ts`). ffmpeg recale ensuite précisément avec `-ss`.
- Pour du FLAC, on lit depuis le début jusqu'à la fin de l'extrait.

### Mobile (`wavelet_mobile`)

```
lib/features/story/
  story_api.dart            # createStory, getStory, getThemeStill (ajout aussi dans wavelet_api.dart)
  range_selection.dart      # état de sélection (pur) : ajout / retrait de lignes, durée, plafond 30 s, bornes de l'extrait
  story_flow_screen.dart    # sélection (réutilise la vue paroles) → thèmes → rendu → résultat
  theme_carousel.dart       # Theme Stills
  render_progress.dart      # suivi du statut (toutes les 2 s, recul progressif), notification locale
  story_result_screen.dart  # video_player en boucle, Partager, Enregistrer
lyrics_view.dart            # mode sélection (bouton + appui long)
track_actions_sheet.dart    # entrée « Partager en story »
```

Packages à ajouter : `video_player`, `gal` (galerie), `flutter_local_notifications`. Déjà présents : `dio` (téléchargement), `share_plus` (partage d'un `XFile`), `path_provider`.

## Plan d'implémentation

Chaque étape est une PR avec ses tests (règle « fix-bug-once » de CLAUDE.md). Les modules nouveaux sont ajoutés au tableau « Locked-in surface » et à `coverage.include`.

| # | Étape | Contenu | Fini quand |
|---|---|---|---|
| 0 ✅ | **Spike de faisabilité** (bloquant) — fait le 2026-10-24 : 41 s en 1080p, 21 s en 720p, branche `spike/story-render` (jetable) | Route jetable sur une Preview Vercel : 30 s, un thème, `@napi-rs/canvas` → `ffmpeg-static`, audio d'une copie R2 de dev. On mesure le temps, la mémoire, la taille du bundle et les cold starts. | Rendu < 120 s et bundle < 250 Mo. Sinon on passe en 720p, ou on revoit l'ADR 0004. |
| 1 ✅ | **Cœur pur + Theme Stills** | `range.ts`, `timeline.ts`, `layout.ts`, les 4 thèmes, `fonts.ts`, la route `stills`, l'OpenAPI. | Tests unitaires des bornes et de la timeline, PNG de chaque thème vérifié à l'œil (script `scripts/story-stills.ts`). |
| 2 ✅ | **Story Render serveur** | Modèle + migration, `audio-source.ts`, `render.ts`, POST et GET, réutilisation, limites, GC, `maxDuration`. | Tests des routes (création, réutilisation, quota, 1 en cours, accès d'un autre utilisateur → 404, échec → `failed` et réessayable). Le script `scripts/e2e-story.ts` fait un rendu réel (compte de service Deezer + LRCLIB, sans base ni R2) puis vérifie la durée, le 1080×1920 et l'AAC. |
| 3 | **Mobile : sélection** | `range_selection.dart`, mode sélection dans la vue paroles (bouton, appui long), entrée dans le menu d'actions, Preview de l'extrait. | Tests unitaires de la sélection, tests de widget de la vue paroles. |
| 4 | **Mobile : thèmes, rendu, partage** | Carrousel de Theme Stills, suivi + notification locale, téléchargement, écran de résultat, Partager, Enregistrer dans la galerie, permissions Android et iOS. | Tests de widget, puis essai sur l'émulateur Pixel_4a et un vrai téléphone : partage vers Instagram, TikTok et Facebook. |
| 5 | **Livraison** | `CLAUDE.md` (stack + tableau), `docs/vercel.md`, client Dart si utilisé, `npm run e2e`, mise en prod du web, mobile v1.8.0 via Firebase. | Une story postée depuis la prod. |

**Parallélisme** : une fois l'étape 1 mergée (le contrat d'API est figé dans l'OpenAPI), les étapes 3–4 (mobile) et l'étape 2 (serveur) peuvent avancer en même temps. Elles touchent des dépôts différents.

## Risques et inconnues

- **Temps de rendu sur Vercel**. Les 900 frames 1080p sont encodées sur 1 à 2 vCPU. C'est l'objet du spike. Leviers : preset x264 `veryfast`, ne redessiner que les couches qui changent, 720p en dernier recours.
- **Taille du bundle** : ffmpeg pèse environ 75 Mo et le canvas environ 30 Mo. C'est à vérifier dès le spike.
- **`after()` interrompu** : un rendu tué reste en `rendering`. Le GC le passe en échec, et le mobile affiche l'échec si le statut ne bouge plus après le délai maximal.
- **Plage Deezer d'un titre en FLAC** : on lit depuis le début, plus lent. Il faut préférer le MP3 pour les extraits.
- **Droits** : les réseaux peuvent couper le son. C'est accepté (ADR 0006), il n'y a rien à contourner.
