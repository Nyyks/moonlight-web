# Shader d'upscaling MoonlightWeb — plan de la v0.4.1

Plan écrit le 10/10/2026, à exécuter après la release v0.4.0 ; décisions de lancement et parc corrigé au
§13 (19/10/2026). À la date du plan rien n'était commencé : aucun fichier du dépôt touché, aucune mesure
prise, aucun shader écrit. Les
chiffres cités viennent soit du dépôt (chapitre 15 du wiki, mémoires de banc, commentaires du code),
soit des sources externes listées au §10 ; chaque gain annoncé est marqué **[démontré]** (mesuré par
une source nommée, dans des conditions nommées) ou **[attendu]** (hypothèse à vérifier au banc).

Nom de travail du shader : `mwsr` (MoonlightWeb Super Resolution) dans le code et les réglages ;
le libellé de l'interface est au choix de Bruno. Le nom n'engage rien.

---

## 0. Résumé et verdict de réalisme

**Ce que le client fait aujourd'hui.** Le client porte déjà trois upscalers en deux saveurs : FSR1
(EASU + RCAS), SGSR1 et NIS, sur WebGL2 et sur WebGPU, choisis par la matrice de septembre
(chapitre 15 du wiki) : en SDR, Canvas2D sans enhancer par défaut, FSR1 WebGL2 sur un ordinateur et
SGSR1 WebGL2 sur un téléphone quand l'enhancer est coché ; en HDR, tout passe sur WebGPU. Sur WebGPU
chaque upscaler paie une passe de plus que son algorithme : la « passe 0 », qui recopie la texture
externe de la vidéo dans une texture ordinaire parce que les trois shaders ont besoin de
`textureGather`, que WebGPU refuse sur une `texture_external`. FSR1 y coûte donc trois passes
plein écran, SGSR1 et NIS deux. À résolution native, l'enhancer tourne quand même (EASU puis RCAS
à l'échelle 1, ou SGSR1 avec son vote de contour), et le présentateur le plus rapide mesuré en
SDR reste Canvas2D.

**Verdict, objectif par objectif.**

| Objectif | Verdict | Pourquoi |
|---|---|---|
| Plus rapide que SGSR1 sur mobile | **Réaliste mais étroit** [attendu] | Qualcomm mesure SGSR1 à 0,30-0,48 ms contre 0,16-0,25 ms pour un bilinéaire pur sur Adreno 660 → 8 Gen 2 (entrée 1240×576, sortie 1080p-1600p) : l'écart à battre est de 0,14-0,23 ms, soit le coût du noyau au-dessus du plancher qu'est la passe elle-même. Les leviers sont connus et mesurés ailleurs [démontré sur iPhone 12 par Atyuwen] : 5 taps bilinéaires au lieu de gathers (3,6 → 1,8 ms), f16 (5,4 → 4,7 ms), passe de copie évitée (0,7 ms), sortie anticipée. Mais SGSR1 a déjà une sortie anticipée et un seul gather sur le chemin plat : le gain net sur le noyau seul sera de l'ordre de 10-30 %, celui de la chaîne complète (sans la passe 0) plus net. Aucun chiffre public de SGSR1 ni de FSR1 n'existe sur Mali ni sur Apple, et aucun chiffre indépendant nulle part : tout est à mesurer. |
| Plus économe que SGSR1 sur batterie | **Plausible, non démontrable sans banc** | L'énergie d'une passe plein écran suit son temps GPU et sa bande passante ; une passe de moins et des échanges mémoire plus courts vont dans le bon sens. Aucune source publique ne donne un milliwatt pour un upscaler mobile ; le protocole du §7 fixe comment on le mesurera (puissance GPU sur Mac M1, décharge de batterie sur iPhone, capteurs sur le banc ARM). |
| Plus rapide que FSR1 ailleurs, à qualité comparable | **Réaliste sur le temps, à vérifier sur la qualité** | FSR1 sur WebGPU = passe 0 + EASU (4 gathers × 3 canaux, 12 taps) + RCAS : trois passes et deux textures intermédiaires. Une passe unique fusionnant upscale et netteté, sans passe 0, retire deux passes plein écran [démontré par l'architecture, gain à chiffrer]. La qualité est l'inconnue : EASU reste le noyau le plus net sur le texte ; un noyau à 5-9 taps bilinéaires sans le déringing 2×2 d'AMD peut sonner sur le texte à ×2 (Atyuwen : « artefacts rarement visibles », mais sur un jeu, pas sur du texte). Le critère « comparable » est chiffré au §8. |
| Upscale, downscale, HDR, 4:4:4 | **Réaliste** | Les chemins existent déjà dans le renderer (float16 linéaire, tone-map ACES, 4:4:4 négocié par codec) ; le shader doit seulement être écrit sans supposer [0, 1] et porter un mode de réduction correct, ce qu'aucun des trois upscalers actuels ne fait vraiment (NIS refuse la réduction, SGSR1 et EASU ne la filtrent pas). |
| Passage direct à résolution native | **Réaliste, avec une limite d'architecture** | Un canvas ne change jamais de type de contexte : on ne peut pas passer de WebGPU à Canvas2D en cours de flux, et l'échelle change en cours de flux. Le contournement se fait donc dans le renderer, par image (aucune passe d'enhancer, aucune texture intermédiaire, une seule écriture de la surface) et, quand l'enhancer est éteint, par le choix de Canvas2D au lancement comme aujourd'hui. Le « zéro copie » absolu n'existe que par l'élément `<video>`, mesuré 35-45 ms plus lent au clic : exclu par la règle de latence. |
| Latence, mémoire, énergie minimales | **Réaliste** | Une passe au lieu de deux ou trois, pas de texture intermédiaire, un bind group par image : c'est déjà moins que tout ce qui tourne aujourd'hui sur WebGPU. Reste le surcoût de présentation de WebGPU sur le thread principal (4 ms Windows, 10 ms macOS mesurés le 03/09 en fenêtre ; inversé plein écran), que le shader ne change pas : d'où le jumeau WebGL2. |

**Trois décisions d'architecture que le plan propose d'emblée** (à confirmer par Bruno au lancement) :

1. **Un seul algorithme, deux jumeaux.** La version WGSL (WebGPU) est la référence et la plus
   optimisée ; la version GLSL ES 3.00 (WebGL2) suit le même noyau à coût égal, parce que le noyau
   de base n'utilise que des échantillons bilinéaires : aucun `textureGather`, qui n'existe pas en
   WebGL2 (GLSL ES 3.10 seulement) et que la texture externe de WebGPU refuse de toute façon. Les
   accélérations propres à WebGPU (f16, opérations de quad, lecture directe de la texture externe,
   variante compute) sont des couches activées par constantes `override` : le GLSL ne les a pas, et
   le WGSL ne porte aucun échafaudage de compatibilité.
2. **Pas de passe 0 en SDR.** Le shader WGSL lit la `texture_external` directement
   (`textureSampleBaseClampToEdge`, et `textureLoad` là où il est pris en charge). Les chemins HDR
   gardent leur passe 0 (lecture des plans YUV ou tone-map) et alimentent la variante
   `texture_2d<f32>` du même noyau.
3. **Code original, règle de salle blanche.** Les sources étudiées (FSR1 MIT, SGSR1 BSD-3, NIS MIT,
   gist d'Atyuwen MIT) sont toutes compatibles avec la GPL-3.0-or-later du projet, mais le shader
   de la v0.4.1 n'en recopie aucune ligne : il en reprend les idées (taps bilinéaires, sortie
   anticipée, clamp anti-sonnerie, netteté fusionnée) et ses propres constantes. Les ports
   existants restent dans le dépôt comme références de banc et comme crans de l'échelle.

---

## 1. Le client aujourd'hui : architecture et points d'intégration

### 1.1 Les quatre présentateurs et leur routage

`frontend/js/stream/renderers/createRenderer.js` choisit le renderer une fois par flux, et
`StreamView.js` (vers les lignes 636-845) décide avant lui de ce qu'on lui demande :

| Renderer | Quand | Ce qu'il fait de l'image | Coût mesuré au dépôt |
|---|---|---|---|
| `Canvas2DRenderer` | SDR, enhancer éteint (défaut), ou `smooth2d` | `drawImage(VideoFrame)` direct, contexte `desynchronized` ; tampon à la taille de l'image, étirement CSS par le compositeur (ou tampon à la taille d'affichage avec `imageSmoothingQuality` haute en `smooth2d`) | 0,2-0,6 ms de rendu (03/09) ; clic → photon 11,6 ms en fenêtre, 30,3 plein écran (ch. 15) |
| `WebGlRenderer` | SDR, enhancer coché : `gl-fsr1` (ordinateur), `gl-sgsr` (téléphone, tablette, tout Snapdragon), `gl-nis` (debug) | contexte `desynchronized` ; gathers émulés par quatre `texelFetch` ; FSR1 en deux passes par FBO intermédiaire ; barrières `fenceSync` pour signaler au gouverneur un GPU en retard | 0,3-0,4 ms de soumission ; clic → photon +2-4 ms en fenêtre, 34-37 ms plein écran |
| `WebGpuRenderer` | HDR (toujours), ou saveur WebGPU demandée ; `off` = blit seul | passe 0 obligatoire avant tout enhancer ; SGSR1 et NIS une passe ensuite, FSR1 deux ; attente `onSubmittedWorkDone` à chaque image (contre-pression) ; canvas `rgba16float` + `toneMapping: extended` + `display-p3` en HDR | 4,6 / 8,0 ms (moyenne / p99) pour le blit seul en fenêtre (03/09) ; plein écran, les saveurs WebGPU ont gagné de 5-10 ms au clic (27-29,5 ms contre 34-37) |
| `VideoElementRenderer` | HDR HEVC (seul chemin HDR matériel), TV, ou « Video » du menu debug | trame écrite dans un `MediaStreamTrackGenerator` → `<video>` ; aucun shader possible | 35-45 ms plus lent au clic que tout canvas |

Deux faits de cette matrice pèsent sur le plan :

- **En SDR, la production ne tourne pas sur WebGPU.** La décision du 03/09 (WebGPU = 4 ms de rendu
  sous Windows, 10 sous macOS, un vsync entier au p99, pas d'équivalent de `desynchronized`) a mis
  les enhancers SDR sur WebGL2. Le wiki (15.3) note que le plein écran inverse la hiérarchie en
  faveur de WebGPU et demande de le confirmer sur du contenu de jeu avant de toucher au défaut. Un
  shader WGSL seul ne toucherait donc qu'au HDR et au menu debug : d'où le jumeau GLSL (§3.6) et
  la porte P4 qui remesure WebGPU contre WebGL2 avec le nouveau shader.
- **Le renderer ne change pas en cours de flux, l'échelle si.** Un canvas est `2d` ou `webgpu`
  pour toujours ; l'échelle change à chaque instant (fenêtre, plein écran, pinch-zoom quantifié par
  `_outputZoomScale`, rotation, et l'échelle de qualité qui baisse la résolution du flux sous
  congestion avec le message « résolution réduite, upscaling activé »). Toute décision « à
  l'échelle 1 » se prend donc **par image, dans le renderer**, pas au lancement.

### 1.2 La chaîne WebGPU, image par image

`WebGpuRenderer.draw(frame)` :

1. taille de sortie = boîte CSS × `devicePixelRatio` × zoom quantifié, bornée à 4096, à l'aspect de
   l'image ; le canvas est redimensionné si besoin ;
2. en HDR « readback » (`tonemap`, `linear`) : `frame.copyTo()` des plans 10 bits (décodage logiciel
   AV1 seulement), `writeTexture` vers trois `r16uint`, passe 0 = shader YUV → tone-map ACES ou
   lumière linéaire ; sinon `importExternalTexture(frame)` + bind group **par image** (la texture
   externe expire à la fin de la tâche) ; sur WebKit, passe 0 = tone-map depuis la texture externe
   (`tonemap-ext`) ;
3. `off` : une passe vers le canvas (blit ou tone-map) ; sinon passe 0 vers `inputTex`
   (`rgba8unorm`, ou `rgba16float` en HDR, à la résolution de l'image) ;
4. SGSR1 / NIS : une passe `inputTex` → canvas ; FSR1 : EASU → `intermTex` (résolution de sortie,
   même format) puis RCAS → canvas ; les uniformes sont réécrits à chaque image ;
5. sonde clic → photon : trois texels copiés du canvas vers un tampon mappable ;
6. `submit`, `frame.close()`, puis `await onSubmittedWorkDone()` : la promesse ne se résout qu'une
   fois le GPU fini, ce qui alimente le gouverneur (`lastDraw.waitMs`) et borne la file (deux dessins
   en vol au plus, `RenderPacing`).

Ce que cette chaîne coûte de plus que le strict nécessaire, et que le shader de la v0.4.1 peut
retirer :

- **la passe 0** : une passe plein écran à la résolution d'entrée, une écriture puis une lecture de
  `inW × inH × 4` octets (8 Mo + 8 Mo à 1080p, 16 + 16 en HDR float16) ; elle n'existe que parce
  que les trois shaders font des gathers ;
- **la texture intermédiaire de FSR1** à la résolution de sortie (écrite par EASU, lue par RCAS) ;
- **trois `createBindGroup`** et plusieurs `writeBuffer` par image, dont certains pour des valeurs
  qui ne changent qu'au redimensionnement ;
- **le clamp à [0, 1]** dans SGSR1 (`saturate`) et NIS (`clamp`), faux en HDR linéaire (seul FSR1
  passe la lumière de scène sans l'écrêter, ce que le wiki 15.5 a vérifié).

Au passage, deux écarts du port SGSR1 du dépôt par rapport à la source Qualcomm, relevés en lisant
les deux : seuil de contour 6/255 au lieu de 8/255, `EdgeSharpness` 1,5 au lieu de 2,0, et pas de
clamp ±23/255 du delta de luma. Rien à corriger pour ce plan, mais le banc comparera le port tel
qu'il est (c'est lui qui tourne chez les utilisateurs) et le dira.

### 1.3 Le gouverneur et l'échelle de dégradation

`EnhancerGovernor.js` ne descend l'échelle que dans un sens, `fsr1 → nis → sgsr → off`, sur trois
signaux : le coût de service du dessin au-delà de 80 % de l'intervalle d'arrivée des images, une
file de décodage au-delà de 4, ou plus de la moitié des dessins encore sur le GPU quand le suivant
arrive (barrières WebGL seulement : WebGPU ne fournit pas ce signal aujourd'hui). Le verdict est
mémorisé par appareil (`mw_enhancer_rung`) et la remontée est frileuse (15 s, doublée à chaque pari
perdu). Un invité a un budget fixe (8 ms) et pas de remontée.

Points d'intégration : la place de `mwsr` dans `ENHANCER_LADDER` (en dessous de `sgsr` s'il est
moins cher, ce qui est l'objectif ; sinon au-dessus), `ladderRung` / `rendererAlgo` pour le préfixe
`gl-`, et, si les requêtes d'horodatage entrent, un quatrième signal de coût GPU réel sur WebGPU
(aujourd'hui `gpuBehind` y est nul).

### 1.4 Les réglages, le menu, les chaînes

- `SettingsView.js` : une case « Video Enhancement » en production ; la liste des algorithmes
  (`auto`, `canvas2d`, `video`, `smooth2d`, `gl-sgsr`/`sgsr`, `gl-nis`/`nis`, `gl-fsr1`/`fsr1`)
  n'apparaît qu'en build debug ; `pickAutoEnhancer()` (`BrowserDetect.js`) résout `auto` ;
  `isSnapdragonGpu()` renifle la chaîne WebGL `UNMASKED_RENDERER_WEBGL`.
- i18n : trois catalogues (`en.json`, `fr.json`, `zh.json`), clés `settings.algo*`,
  `stream.statEnhancer`, `stream.enhancerOff` ; `npm run i18n` vérifie la complétude.
- Métriques de forme du flux : résolution, cadence, codec, HDR/4:4:4, bande de débit, backend,
  transport, LAN/Internet, classe d'appareil ; **pas** le nom de l'enhancer (à ajouter si on veut
  savoir ce qui tourne chez les utilisateurs ; décision de Bruno).
- Le worker vidéo (`VideoDecodeWorker.js`, opt-in) crée les mêmes renderers sur un
  `OffscreenCanvas`, sans `localStorage` ni `<video>` : tout réglage du shader lui est transmis par
  message, comme `algo` et `ceiling` aujourd'hui.

### 1.5 HDR et 4:4:4 tels qu'ils arrivent au shader

- **HDR** (StreamView `_hdrMode`) : `sink` (`<video>`, HEVC, pas d'enhancer), `linear`
  (AV1 logiciel, canvas float16, 1,0 = 203 nits, BT.2020 → P3, enhancer en lumière de scène),
  `tonemap` (AV1 logiciel, ACES vers un canvas SDR, puis enhancer), `tonemap-ext` (WebKit, ACES
  depuis la texture externe, puis enhancer), `browser` (tone-map du navigateur à l'import, puis
  blit). La contrainte de fond est documentée aux chapitres 13 et 15.5 du wiki : Chrome tone-mappe
  un `VideoFrame` HDR **à l'import** sur toute surface canvas ; seul `copyTo` d'une image décodée en
  logiciel garde le signal. Le shader ne peut rien à cela ; il doit juste accepter des valeurs
  au-delà de 1,0 et un seuil de contour qui n'est pas « 6/255 ».
- **4:4:4** : négocié par codec côté hôte (`GpuInfo::codecs444` : NVENC H.264 et HEVC, pas AV1 ;
  AMF et oneVPL rien), accepté par le client si `isConfigSupported` répond pour le profil RExt ou
  High 4:4:4 (`chroma444ClientCapability`), **SDR seulement** (le 10 bits 4:4:4 rend vert sur
  Chrome/Windows). Les images arrivent en I444 et `importExternalTexture` les convertit : le shader
  voit du RGB dont la chrominance porte autant de détail que la luminance. `this._yuv444` est connu
  de StreamView et peut descendre au renderer.

### 1.6 Les résolutions qu'on rencontre vraiment

- Ordinateur : flux Auto = la boîte de l'écran (ratio 1 en plein écran), « Match my screen »,
  taille fixée ; en fenêtre, **réduction** fréquente (×0,5-0,9) ; sous congestion, le flux descend
  d'un cran et l'upscale remonte à ×1,33-×2.
- Téléphone et tablette : Auto streame **jusqu'à 1440 lignes** quelle que soit la largeur de
  l'écran (commit `0201eaef`, pour la netteté du pinch-zoom) : sur un écran de 1080 lignes, le cas
  courant est une **réduction ×0,75**, et le zoom repasse au-dessus de 1. Un shader « upscale
  seulement » ne couvre donc pas l'usage mobile réel.
- Au-delà de ×2 : hôte 720p sur un 4K (×3) ; AMD ne documente rien au-delà de ×2 par dimension et
  le port mpv de FSR1 s'arrête à ×2 puis laisse mpv finir ; SGSR1 et NIS sont spécifiés pour ≤ ×2.

### 1.7 L'outillage de mesure existant

| Outil | Ce qu'il mesure | Réutilisable pour le plan |
|---|---|---|
| `PipelineDiag` + `[perf]` (console, `mw_perf_diag=1`) | soumission / attente du dessin, file de décodage, pertes par cause, images présentées contre décodées | oui : c'est le coût « vu de la page » ; il s'arrête avant le compositeur |
| Sonde clic → drapeau (`mwLatency.run()`, build debug, hôte Windows ; `probePixels` du renderer) | clic → pixel présenté, médiane et p90 sur dix clics | oui : seul instrument qui voit la présentation ; onglet visible obligatoire, Chrome dédié piloté par `scripts/bench/cdp.py` |
| `scripts/bench/` (campagne, `/bench`) | matrice codec × enhancer × 4:4:4 × HDR, clic → photon, rapport | oui pour la validation finale (P5) |
| `mw-scaler-bench` (hôte, D3D11) | temps GPU et PSNR des filtres de réduction, métrique de défilement (décalage d'1 px) | la méthode est reprise ; l'outil lui-même est côté hôte |
| `UltraPlayer.js` (POC Ultra) | `timestamp-query` quand l'adaptateur l'offre, `querySet` par passe, `gpuwait.py` | oui : le seul code du dépôt qui horodate des passes WebGPU ; à reprendre tel quel pour le labo |
| `hevc-psnr.py`, `scripts/bench/content/*.html` (texte fixe, défilement, clip) | PSNR par bande ; contenus reproductibles | oui |

Ce qui manque et que le plan ajoute : une **page de laboratoire** qui fait tourner N variantes de
shader sur les mêmes images, mesure le temps GPU par requêtes d'horodatage (ou par amortissement
sur un lot quand elles manquent) et relit les pixels pour les métriques de qualité ; une
**validation statique** des shaders en CI (aucun GPU n'y tourne aujourd'hui ; `npm run check` et
`vitest` seulement) ; des **tests dorés** sur un WebGPU logiciel.

### 1.8 Le parc de banc, et ses trous

| Machine | GPU | Rôle pour ce plan |
|---|---|---|
| DualRTX | Radeon 780M (iGPU), Arc A380, RTX 5060 Ti | trois GPU d'ordinateur, trois écrans ; encodeur et décodeur jamais sur le même GPU |
| N95 (`mw-intel`) | Intel UHD (Alder Lake-N) | iGPU faible, client Wi-Fi ; f16 y a déjà aidé (Lanczos-2 14 → 11,3 ms côté hôte) |
| UM790Pro | Radeon 780M | Windows / Ubuntu, client Ethernet |
| Mac M1 (Léo) | Apple M1 | **seule machine où la puissance GPU se lit** (`powermetrics`) ; créneaux de Bruno |
| `mw-arm` | Snapdragon 7c, Adreno 618 (Windows ARM, Chrome) | **seul Adreno du parc** ; génération ancienne (SGSR1 est mesuré par Qualcomm sur 660 → 8 Gen 2) |
| AMD 610M (192.168.1.190) | Radeon 610M | bon client, iGPU minimal |
| iPhone / iPad | Apple A / M | Safari (WebKit) ; WebGPU selon la version d'iOS ; batterie |
| Mi TV, Freebox POP | Mali-G31 | exclus de l'enhancer (mémoire ≤ 1 Go, TV) : hors cible |

**Trous** : aucun téléphone Android, aucun Mali de téléphone, aucun Adreno récent. L'objectif
« plus rapide que SGSR1 sur mobile » sera donc **démontré sur Adreno 618 et sur Apple**, et
seulement **extrapolé** aux Adreno 7xx/8xx et Mali-G7xx. Le plan le dit tel quel dans ses critères
(§8) ; un téléphone Android de prêt (Snapdragon 8 Gen 1 ou plus, et un Mali) est listé comme
dépendance souhaitable, pas bloquante.

---

## 2. Ce que disent les sources

Revue faite le 10/10/2026 sur les sources primaires (en-têtes de shaders, dépôts, billets, PDF
des éditeurs, articles), avec la convention du §0 : **[démontré]** = chiffre mesuré et publié par
une source nommée dans des conditions nommées ; **[affirmé]** = chiffre d'éditeur sans méthode ;
**[attendu]** = notre hypothèse. Les URL sont au §10.

### 2.1 FSR1 : EASU et RCAS (AMD, MIT)

- **EASU** : 12 taps en croix (un bloc 4×4 moins les coins) lus par **4 `textureGather` par
  canal** (12 instructions texture), luma approchée `0,5·B + 0,5·R + G`, analyse direction /
  longueur en quatre appels pondérés bilinéairement, noyau « Lanczos-2 approché » sans sinus ni
  racine (polynôme en `d²`), fenêtre tournée et étirée selon le contour, puis **déringing** par
  clamp entre le min et le max des 4 texels les plus proches. AMD vise ≤ 64 registres (36 pour
  la version 32 bits) ; le shader est « borné par le VALU » sur les GPU d'ordinateur.
- **RCAS** : croix à 5 taps, résolution analytique du poids de netteté qui n'écrête pas, limite
  fixe 0,1875, netteté en « stops » (0 = maximum), option de détection de bruit ; AMD interdit
  RCAS sans EASU (CAS sinon). La v1.0.2 inclut le tap central dans la borne.
- **Entrée** exigée : RGB perceptuel (sRGB ou gamma 2) dans [0, 1], anti-aliasé, sans bruit.
  Pour le HDR, l'en-tête livre un tone-mapper réversible (`c /= max3(c) + 1`) à appliquer avant
  et défaire après.
- **Échelles** : modes 1,3× / 1,5× / 1,7× / 2,0× par axe ; « 1x to 4x area » ; rien de documenté
  au-delà de 2× par axe ; le port mpv s'arrête à 2× et laisse mpv finir.
- **Coûts** : AMD donne des bornes par classe de GPU d'ordinateur, « 0,40 ms ou moins » à 4K sur
  RX 6800 XT / RTX 3080, 1,0 ms sur RX 5700 XT / RTX 2060 S [démontré par AMD, configuration
  citée mais pas la méthode] ; **aucun chiffre FSR1 sur Adreno ni Mali dans aucune source
  primaire**.
- **Variante f16** (`FsrEasuH`) : deux taps par opération empaquetée, coordonnées en f32 ; AMD la
  recommande par défaut (« no visible quality impact ») sauf sur les GPU sans f16 empaqueté et
  sur certains pilotes D3D11.

### 2.2 L'optimisation mobile d'Atyuwen (iPhone 12, 2021 ; gist MIT, billet CC BY-NC)

Un seul appareil (iPhone 12, A14), pixel shaders, 1772×819 → 2532×1170, méthode de mesure non
décrite. Chaque étape est mesurée [démontré] :

| Étape | EASU |
|---|---|
| version AMD, f32 | 5,4 ms (+ RCAS 0,9) |
| f16 | 4,7 |
| sans le déringing 2×2 | 4,3 |
| une seule analyse de direction sur des lumas interpolées | 3,8 |
| sortie anticipée bilinéaire si la direction est quasi nulle | 3,6 (« le shader est entièrement borné par la texture ») |
| **5 échantillons bilinéaires** (croix) au lieu des gathers, gathers différés au chemin contour | **1,8** |
| passe de copie évitée | 0,7 de plus gagnés |

Enseignements repris ici : la texture, pas l'ALU, est la limite sur ce GPU ; les échantillons
bilinéaires battent les gathers ; la sortie anticipée seule ne gagne presque rien si les gathers
restent sur le chemin plat. Réserves : le déringing supprimé (« artefacts rarement visibles », sur
un jeu), luma sans le bleu, pas de réduction ni de HDR ; la version fusionnée EASU + RCAS de 2025
applique la netteté sur l'anneau bilinéaire avec un facteur égal au ratio de rendu, sans
paramètre : une source d'idées, pas un composant. Le gist dépend de l'en-tête AMD.

### 2.3 SGSR1 (Qualcomm, BSD-3)

- **Un seul fragment shader** : un échantillon bilinéaire (la couleur de base), un `textureGather`
  du canal vert, un **vote de contour** (`edgeVote > 8/255`, sinon sortie bilinéaire), puis sur
  les contours trois gathers de plus (12 taps, bloc 4×4 moins les coins), poids
  `(x − 1)(x − 4)³` avec `x = 0,55·r² + terme de rang`, reconstruction d'une correction de luma
  bornée au min/max du 2×2 central, multipliée par `EdgeSharpness = 2`, ajoutée aux trois canaux.
  La chrominance reste bilinéaire. Précision `mediump` (couleurs) / `highp` (coordonnées).
- **Coûts, par Qualcomm, à fréquence GPU maximale, entrée 1240×576** [démontré, méthode non
  décrite] : SGSR1 0,476 / 0,356 / 0,295 ms et bilinéaire 0,248 / 0,196 / 0,156 ms sur Snapdragon
  888 / 8 Gen 1 / 8 Gen 2 (sorties 2340×1080 et 2400×1600). Le coût « suit linéairement la
  surface de sortie » ; le seuil n'y change rien. L'affirmation « deux fois plus rapide que les
  autres upscalers mobiles » n'a pas de méthode publiée [affirmé].
- **Aucune mesure indépendante** (ms, mW, PSNR) de SGSR1 n'a été trouvée, sur aucun GPU. Aucune
  mesure d'énergie d'un upscaler mobile nulle part. Le seul chiffre tiers (Arm, concurrent) est
  un gain d'images par seconde sur Immortalis-G720, sans ms.
- Contraintes : entrée tone-mappée et anti-aliasée, ≤ 2× par axe, pas de réduction, pas de HDR
  (seuils en `/255`, clamp à [0, 1]) ; `textureGather` n'existe pas en GLSL ES 3.00 : le port
  WebGL2 du dépôt émule chaque gather par quatre `texelFetch`.
- Le port WebGPU du dépôt diffère de la source : seuil 6/255, netteté 1,5, pas de clamp ±23/255
  (§1.2).
- **SGSR2** est temporel (profondeur, vecteurs de mouvement, jitter) : hors sujet pour un client
  qui ne reçoit que des images décodées ; ses coûts (0,9-1,1 ms en deux passes fragment sur
  8 Gen 3) servent seulement d'ordre de grandeur de « ce que coûte un multi-passes bien optimisé
  sur un Adreno haut de gamme ».

### 2.4 NIS, CAS et les noyaux classiques

- **NIS** (NVIDIA, MIT) : compute à mémoire partagée, luma 6×6, carte de contours à quatre
  directions, 64 phases de filtres, netteté USM intégrée ; **refuse toute échelle hors
  [1, 2] par axe** ; modes HDR (linéaire, PQ) et **lecture NV12 native** ; **aucun chiffre de
  coût publié**. Son port fragment du dépôt recalcule les 36 lumas par pixel : c'est le plus cher
  des trois à ce titre.
- **CAS** (AMD, MIT) : 5 ou 9 taps, entrée **linéaire** exigée, surface ≤ 4× ; pas de coût
  officiel.
- **Noyaux classiques** : Catmull-Rom en 9 échantillons bilinéaires (ou 5 sans les coins), B-spline
  en 4 ; Lanczos-2/3 sonne sur les contours durs ; Mitchell et les EWA sont les meilleurs
  réducteurs du test en anneau de Robidoux ; mpv réduit en lumière linéaire par défaut
  (`--linear-downscaling`), **élargit le noyau à la réduction** (`--correct-downscaling`) et a
  pris Hermite comme réducteur par défaut pour sa vitesse ; pour l'agrandissement il préfère la
  courbe sigmoïde à la lumière linéaire (moins de sonnerie).
- **Familles dirigées** (NEDI, iNEDI, ICBI, DCCI) : schémas 2× entiers en deux étapes, cent à
  mille fois le coût d'un bilinéaire, aucune implémentation GPU permissive maintenue : des idées
  (choisir la direction de plus faible dérivée seconde), pas des composants.
- **Shaders mpv / libplacebo** : RAVU (LGPL-3), nnedi3 (LGPL/GPL, quatre passes), FSRCNNX
  (licence ambiguë), Anime4K (MIT, réseaux de neurones réglés pour l'animation ; son port WebGPU
  tient « sous 3 ms » à 720p sur une RTX 3070 Ti, soit très loin du budget mobile),
  adaptive-sharpen (BSD, 25 positions), SSimSuperRes et KrigBilateral (LGPL-3, plusieurs passes).
  Aucun ne tient dans une passe fragment sous la milliseconde sur un iGPU ; aucun n'entre au
  produit.
- **Neuronal léger** (ESPCN, FSRCNN-s, edge-SR) : aucune donnée publique sous la milliseconde sur
  un iGPU à 1440p ; extrapolation à plusieurs ms. Écarté (§3.5).
- **Upscale conscient de la compression** : rien de publié pour un upscaler spatial temps réel sur
  du jeu à 10-50 Mbit/s ; les deux mécanismes « conscients des artefacts » des noyaux bon marché
  sont la borne 2×2 d'EASU et le détecteur de bruit de RCAS : la conception du §3.2 en reprend
  l'esprit (cohérence `a`, marge locale `H`).

### 2.5 Métriques et protocoles de qualité

- **Aucun éditeur** (AMD, NVIDIA, Qualcomm, Apple, Arm) ne publie de métrique objective pour son
  upscaler spatial : images côte à côte seulement.
- Le banc académique le plus proche de notre cas (SR+Codec, BMVC 2024 : vidéos réduites,
  compressées, puis agrandies, classées par des humains) trouve que **PSNR, SSIM et VMAF corrèlent
  mal** avec le jugement humain sur de la vidéo compressée agrandie (corrélation de rang 0,15 à
  0,45) ; LPIPS 0,43, ERQA 0,62, et un modèle sans référence 0,64 [démontré]. PSNR et SSIM restent
  des garde-fous de régression, pas des juges.
- **ꟻLIP** (NVIDIA, BSD-3, `pip install flip-evaluator`) est conçu pour comparer deux rendus à une
  distance de vue donnée (pixels par degré), donne une carte et une moyenne : le juge principal du
  plan, avec la carte pour voir *où* (texte, interface) l'écart se fait.
- **VMAF** exige référence et candidat à la même résolution, a un modèle 4K, et **récompense la
  netteté** : son mode NEG (« no enhancement gain ») est obligatoire dès qu'un sharpener est dans
  la boucle ; à titre indicatif seulement.
- **SSIMULACRA 2** (BSD-3) a des termes explicites de blocs et de sonnerie : utile pour vérifier
  qu'un upscaler n'amplifie pas les artefacts du codec.
- Vérité terrain : le rendu natif, réduit par un filtre fixe et identique pour tous les candidats
  (et dit dans le rapport) ; comparer au flux haute résolution réel mélange le bruit du codec à la
  référence et ne sert qu'en contrôle.

### 2.6 Mesurer le temps GPU et l'énergie

- **`timestamp-query` de WebGPU** : disponible largement (Chrome 121+ ; Safari aussi), mais
  **quantifié à 100 µs** par défaut dans Chrome ; le drapeau `chrome://flags/#enable-webgpu-developer-features`
  lève la quantification. Nos passes font 0,3-2 ms : le drapeau est obligatoire au labo, ou il
  faut empiler N dispatches identiques et diviser.
- **PIX** capture Chrome sous Windows (lancement depuis PIX, `--disable-gpu-sandbox`, symboles HLSL
  de Dawn) et montre la traduction D3D12 de Dawn (barrières comprises) ; **PresentMon** donne
  `GPU Busy` par image mais « moins précis sous HAGS, parfois d'environ 0,5 ms » (notre banc garde
  HAGS actif) ; **Xcode** capture Chrome sur macOS seulement avec un Chrome non signé, et aucun
  document ne couvre le processus GPU de Safari ; **`powermetrics`** donne la puissance GPU en mW,
  « estimée et possiblement inexacte » selon sa page de manuel : bon pour des deltas A/B sur la même
  machine, pas pour des absolus.
- **Mobile** : le compilateur hors ligne Mali (`malioc`) estime les cycles par unité (arithmétique,
  chargement, texture), le chemin le plus long et les registres, mode Vulkan compris, « à confirmer
  sur appareil » ; le compilateur hors ligne Adreno accepte SPIR-V, HLSL et GLSL et donne des
  comptes d'instructions ; Android GPU Inspector exige une application débogable (pas le Chrome
  de production) ; Perfetto lit les rails de puissance (ODPM, Pixel 6 et plus) et la fréquence GPU ;
  la méthode publiée par un studio (Wuthering Waves) est celle du plan : fenêtres de 30 s, luminosité
  fixe, même scène, A/B, **différences en mW et non valeurs absolues**.
- **Fréquences** : les chiffres de Qualcomm sont pris « à fréquence GPU maximale » ; en régime
  établi, après quelques minutes, on peut attendre 1,5 à 3 fois ces durées [attendu] : le rapport
  donnera les deux conditions.

### 2.7 WebGPU et WGSL dans les navigateurs du parc (lu dans les sources de Chrome, de WebKit et de Firefox le 10/10/2026)

**La texture externe.** Trois opérations seulement : `textureDimensions`, `textureLoad` à
coordonnées entières, `textureSampleBaseClampToEdge` ; ni `textureSample`, ni `textureGather`.
Dans Chrome, l'import est **sans copie** seulement si l'image décodée est une NV12 partagée lisible
par WebGPU et si l'espace demandé est `srgb` ou `display-p3` (le cas SDR matériel courant) ; alors
**chaque échantillon coûte deux fetches** (plan Y en pleine résolution, plan UV en demi, avec notre
sampler : chroma bilinéaire) et une multiplication 3×4, sans `pow` pour un flux BT.709 SDR (Chrome
assimile sa courbe à celle du sRGB). Tout le reste (I420 logiciel, P010 et 10 bits, 4:2:2, 4:4:4,
RGBA) passe par **une copie faite par Chrome** vers une image RGBA 8 bits avant notre shader : une
passe de plus, invisible pour nous, et le 10 bits perd sa précision (c'est pourquoi le renderer lit
lui-même les plans YUV en HDR). `textureLoad` sur externe = deux fetches entiers, chroma au plus
proche ; `textureSampleBaseClampToEdge` = un clamp calculé dans le shader plus les deux
échantillons. Safari (WebKit) fait de même : deux textures Metal par `CVPixelBuffer`, matrice
choisie d'après les métadonnées, formats 4:2:0, 4:2:2 et 4:4:4 en 8 et 10 bits liés sans copie, HDR
importé sans perte ; Firefox a les textures externes depuis la version 144 (Windows, macOS). Depuis
Chrome 137, une vue de texture ordinaire (`rgba8unorm`, `bgra8unorm`, `rgba16float`, un niveau)
peut être liée à un emplacement `texture_external` : un seul module WGSL peut servir les deux
feeds sur Chrome. L'objet externe expire quand la `VideoFrame` est fermée (après le `submit`), et un
bind group par image reste nécessaire ; Chrome ne ralentit plus la lecture vidéo à l'import depuis
la version 116.

**HDR.** `toneMapping: { mode: 'extended' }` sur un canvas `rgba16float` : Chrome 129 (ordinateur et
Android ; Linux en 144) ; Safari 26 : iOS fonctionne, macOS renvoyait `extended` mais affichait du
SDR (bug WebKit d'août 2025) ; Firefox : pas de canvas `rgba16float`. « extended » = aucune courbe
du navigateur, écrêtage à ce que l'écran sait montrer ; pas de PQ ni de HLG en sortie, pas d'API de
marge HDR (proposition W3C ouverte depuis juin 2025). Chrome 155-156 ajoute `srgb-linear` et
`display-p3-linear` comme espaces du canvas. Côté import, Chrome ne tone-mappe ni n'écrête, mais
fait passer le P010 par la copie 8 bits : le constat du wiki 15.5 tient toujours. WebGL n'a
toujours aucune sortie HDR (la proposition Khronos est ouverte depuis 2024).

**Fonctionnalités.** `shader-f16` : Chrome 120 (D3D12 : DXC + Shader Model 6.2 + opérations 16 bits
natives ; Vulkan : f16 + int16 + accès 16 bits aux tampons ; Metal : toujours), Safari : toujours,
Firefox : non exposé ; relevés de terrain (web3dsurvey) : ~71 % des Qualcomm, ~29 % des Adreno 6xx
(donc sans doute pas l'Adreno 618 du banc), ~97 % des 7xx, 100 % d'Apple et d'Arm. `subgroups`
(opérations de quad et de sous-groupe, **fragment et compute**) : Chrome 134 (D3D12 SM 6.0, Metal
Apple6 / Mac2, Vulkan avec l'étage fragment) ; WebKit a le code (Metal3) mais pas Safari 26.0 selon
les tables ; Firefox non. `timestamp-query` : Chrome 121 partout, **quantifié à 100 µs** sauf
drapeau développeur ; Safari 26 si compteur ; Firefox non. `adapter.info` (`vendor`,
`architecture` : « adreno-6xx », « adreno-7xx », « rdna4 », « blackwell »…) : Chrome 127, Safari 26,
Firefox 141 partiel. Immédiats (push constants) : Chrome 149-150 seulement ; `writeBuffer` deux
fois plus rapide depuis Chrome 144. Mode compatibilité : Chrome 146 (Android GLES 3.1 ; 15 % des
Android n'ont pas de Vulkan convenable), textures externes prises en charge, dérivées fines
absentes (les grossières suffisent au vote), jamais dans Safari. Chrome Android tourne sur Vulkan
depuis Android 12 (Adreno, Mali, Intel ; PowerVR sur Android 16). WebGPU dans Firefox : Windows
141, macOS Apple Silicon 147.

**Le canvas en écriture par compute.** `STORAGE_BINDING` est légal pour `rgba8unorm` et
`rgba16float`, pour `bgra8unorm` avec la fonctionnalité ; mais Chrome **recopie** le canvas sur
Android pour tout canvas storage ou BGRA, sur macOS pour `rgba8unorm`, sur Linux pour BGRA ; le
format préféré est `rgba8unorm` sur Android et Linux, `bgra8unorm` ailleurs. La passe fragment
vers le canvas est donc le seul chemin sans copie sur toutes les plateformes. Qualcomm écrit
« préférer les fragment shaders aux compute shaders » (le compute désactive la compression UBWC)
et recommande R10G10B10A2 comme format de rendu ; Arm dit la même chose pour le post-traitement
(réductions, agrandissements, flous : « les compute shaders peuvent être plus lents et moins
économes »).

**`copyExternalImageToTexture(VideoFrame → canvas)`** : légal avec `RENDER_ATTACHMENT | COPY_DST`,
mais Chrome l'implémente par la même texture externe **plus son propre pipeline de rendu plein
écran** (Dawn `CopyTextureForBrowser`) : jamais moins cher que notre triangle ; Firefox ne
l'accepte pas depuis une `VideoFrame`, Safari en 32 bits par pixel seulement. L'option tombe.

**Promotion en plan de composition.** Sous Windows, seuls les quads vidéo et les canvas « basse
latence » (Canvas2D `desynchronized`) sont candidats ; un canvas WebGPU ne l'est pas. Sous macOS, le
swap chain WebGPU est une IOSurface que le serveur de fenêtres présente et redimensionne. La mise
à l'échelle CSS d'un canvas (bilinéaire) est gratuite par rapport à une passe de plus : c'est ce
que fait déjà Canvas2D « Off », et c'est le vrai plancher de l'« agrandissement ».

**4:4:4.** Les formats `I444`, `I444P10`, `I444P12` existent dans WebCodecs ; sous Windows le HEVC
RExt matériel sort en AYUV (8 bits), Y410 ou Y416, que Chrome fait passer par la copie RGBA : la
chroma pleine résolution est conservée (aucun sur-échantillonnage), et la passe 0 économisée par
notre shader est alors celle de Chrome, pas la nôtre ; macOS et Android non vérifiés ; Safari lie
les formats 4:4:4 sans copie.

**Matrice** (première version stable ; « — » = absent ; « ? » = non vérifié) :

| Capacité | Chrome Win | Chrome macOS | Chrome Android | Chrome Linux | Safari iOS 26 | Safari macOS 26 | Firefox |
|---|---|---|---|---|---|---|---|
| WebGPU | 113 | 113 | 121 (Android 12+) | 144 (Intel), 147 (NVIDIA) | 26 | 26 | 141 Win, 147 macOS |
| `shader-f16` | 120 (DXC, SM 6.2) | 120 | 121 selon pilote | 144 / 155 | 26 | 26 | — |
| `timestamp-query` | 121 (100 µs) | 121 | 121 selon pilote | 144 | 26 si compteur | 26 | — |
| `subgroups` (fragment compris) | 134 | 134 | 134 selon pilote | 144+ | code WebKit, 26.0 ? | idem | — |
| `toneMapping: extended` | 129 | 129 | 129 | 144 | fonctionne | SDR en 26.0 (bug) | — |
| canvas `rgba16float` | 113 | 113 | 121 | 144 | 26 | 26 | — |
| `importExternalTexture(VideoFrame)` | 116 (NV12 sans copie) | 116 | 121 | 144 | 26 (sans copie) | 26 | 144 |
| `copyExternalImageToTexture(VideoFrame)` | 116 (passe interne) | 116 | 121 | 144 | 26 (32 bpp) | 26 | — |
| `adapter.info` | 127 | 127 | 127 | 144 | 26 | 26 | 141 partiel |
| `bgra8unorm-storage` | 113 | 113 | selon Vulkan | 144 | 26 | 26 | — |
| Mode compatibilité | 146 (D3D11 à l'étude) | 146 | 146 (GLES 3.1) | plus tard | jamais | jamais | non engagé |
| Immédiats | 149-150 | 149-150 | 149-150 | 149-150 | — | — | — |

### 2.8 Superoptimisation, SweetOpt, génération assistée, f16, fusion de passes

- **SweetOpt** (CeeJayDK, GPL-3 pour l'outil, versions 0.6 et 0.7 d'octobre 2026) cherche par
  énumération « le programme le moins cher, du plus petit au plus grand », plus une bibliothèque de
  réécritures, pour des **expressions** (quatre instructions, 24 opérations par région par défaut,
  cinq secondes par région) de shaders ReShade FX, HLSL SM5 et, depuis la 0.7, GLSL fragment ;
  **pas de WGSL**. Vérification par échantillonnage dense (un million de points, exhaustif sous
  2²⁴ valeurs), budgets d'erreur (exact, 8 bits couleur, coordonnées, absolu, relatif). Modèles de
  coût **d'ordinateur seulement** (RDNA 3 par défaut, NVIDIA Ada par ptxas, Intel Gen 12 et 7.5 ;
  rien pour Mali, Adreno ni Apple), coûts statiques. Résultats documentés en instructions, pas en
  temps d'image. Son banc annexe TexBench donne des mesures précieuses pour nous [démontré, GTX
  1660, RTX 5080, UHD 630] : un bilinéaire contre trois gathers contre quatre `Load` = 11,4 / 29,1 /
  57,5 unités sur GTX 1660 (sur Blackwell, quatre `Load` battent trois gathers) ; point et
  bilinéaire coûtent pareil jusqu'à 32 bits par texel ; le RGBA16F filtre à demi-vitesse sur NVIDIA
  et Intel Gen 9 ; les lectures à moins de 8 texels sont gratuites, plus chères au-delà de 16 ; un
  étalement vertical coûte plus qu'horizontal sur la plupart des cartes ; **écarter des tuiles 8×8
  entières divise le temps d'une passe lourde par deux, écarter un pixel sur deux ne gagne rien** ;
  une passe de réduction 4K → 1080p a coûté le même temps avec un bilinéaire ou quatre `Load` sur
  GTX 1660 (0,25 ms, bornée par la mémoire). Emploi ici : §6.3, sur le chemin contour une fois la
  structure fixée, résultat reporté à la main.
- **Superoptimiseurs** : STOKE (x86, abandonné), Souper (LLVM, archivé en 2025), GreenThumb, GEVO
  (mutations évolutives de noyaux CUDA mesurées sur GPU, +49 % en moyenne sur Rodinia), Mirage
  (programmes tensoriels), spirv-opt (« aucune garantie d'améliorer une métrique »), Shader
  Minifier (taille) : aucun n'optimise du WGSL ni n'a de modèle de coût mobile ; la méthode qui
  transfère est « mesurer dans la boucle, tolérer une erreur bornée ». Les analyseurs statiques
  utiles sont ceux du §6.2 : `malioc` (cycles par unité ; exemple Arm : un flou gaussien passe de
  4,53 à 0,96 cycle arithmétique en f16 et devient borné par la texture à 2,50), Radeon GPU
  Analyzer (`vk-offline`, ISA RDNA et registres sans pilote AMD), compilateur hors ligne Adreno
  (SPIR-V : instructions 32 et 16 bits, lectures texture, registres).
- **Le projet le plus proche du nôtre** : `rudybear/shaderopt` (MIT, 2026) optimise des shaders
  plein écran par réécritures exactes et sémantiques, prédicteur CPU puis mesure A/B/A/B sur GPU
  avec intervalle de confiance, sur une RTX PRO 6000 et une tablette Mali-G720. Verdicts [démontré]
  : les réécritures « de compilateur » (pliage, CSE, déroulage, `select`) font **0,0 ± 0,2 %** sur
  les neuf shaders (« le pilote les fait déjà ») ; les gains sont **algorithmiques** (un flou à neuf
  taps réécrit en cinq bilinéaires : +11 %, un PCF +24 % sur la tablette) ; le f16 explicite fait
  ≤ +1,9 % sur l'ordinateur « et souvent moins à cause des conversions », mais **+12 à +40 % sur le
  Mali-G720** ; bruit de mesure 0,1-0,9 %, porte à `max(2 %, bruit)`, porte de qualité **FLIP moyen
  0,01 et p99 0,05** : ce sont les seuils que le §8 reprend.
- **Boucles « modèle + harnais »** : KernelBench (2025 : moins de 15 % des noyaux générés battent
  PyTorch d'un coup ; avec dix tours de génération, exécution et profil, le taux monte beaucoup) ;
  NVIDIA avec DeepSeek-R1 en boucle fermée sur H100 (15 minutes par problème, « résultats
  préliminaires ») ; AlphaEvolve (boucle évolutive, +23 % sur un noyau de Gemini, +32 % sur
  FlashAttention) ; Sakana « AI CUDA Engineer » (annonce « 100× », puis rétractation : le système
  avait trouvé des failles dans l'évaluateur) ; Kevin-32B et METR documentent les **tricheries de
  récompense** (copier la référence, désactiver la synchronisation, réécrire le chronomètre).
  Enseignement unique et ferme : **le vérificateur doit être hors de portée du générateur** :
  temps GPU par horodatage, images vérifiées contre une référence indépendante, processus de mesure
  séparé. C'est la règle du §6.3. La lignée d'avant les LLM dit la même chose depuis vingt ans :
  simplification automatique de shaders d'Olano (2003) et Pellacini (2005), programmation génétique
  de Sitthi-Amorn et al. (2011 : des dizaines de milliers de variantes évaluées sur GPU, front de
  Pareto vitesse / erreur), Wang et al. (2014), Spire de He, Foley et Fatahalian (2016, successeur
  Slang). Les travaux « LLM et shaders » proprement dits (ShaderMatch, ShadAR) jugent la
  correction ou la créativité, jamais la vitesse.
- **f16, les faits** : Arm (guide des bonnes pratiques 2025) : « 16 bits suffit normalement pour le
  calcul d'une couleur de sortie », `highp` « jusqu'à deux fois les ressources et la moitié de la
  vitesse », vectoriser le f16 (`f16vec4`), éviter les conversions répétées, samplers `mediump`,
  coordonnées `highp` au-delà de 512-2048 texels (11 bits de mantisse) ; Apple (A8 et après) :
  registres 16 bits, « conversions typiquement gratuites », `half` pour les lectures de texture et
  les interpolants ; NVIDIA : Pascal (GTX 10x0) exécute le FP16 à **1/64** du débit FP32, Ampère et
  Ada à parité (gain de registres seulement) ; AMD : « Rapid Packed Math » à double débit depuis
  Vega, `-enable-16bit-types` ; Intel Xe-LP : double débit (source secondaire). WGSL : les
  textures échantillonnées sont `f32` seulement, donc **chaque fetch rend du f32** et un noyau f16
  paie une conversion par échantillon.
- **Fusion de passes et tuiles** : Arm : ne jamais agrandir par `vkCmdBlitImage` (« aller-retour
  mémoire inutile ») ; « idéalement, utiliser des fragment shaders pour le traitement d'image » ;
  les tuiles font 16×16 pixels avec 128 à 1024 bits de stockage par pixel, plus le format est large,
  plus la tuile est petite ; formats HDR recommandés RGB10_A2 et B10G11R11, RGBA16F seulement si
  nécessaire ; branches : « minimiser la divergence entre threads voisins », `min`/`max`/`mix` pour
  les petites branches, mais « brancher est généralement la meilleure solution » pour plusieurs
  chemins coûteux, et les flots uniformes par constantes de spécialisation. Apple : une lecture de
  texture « prend typiquement quelques centaines de cycles » et une sortie anticipée après une
  première lecture « fait attendre deux fois ». Mesures de taps [démontré] : Catmull-Rom en 16
  `Load`, 9 ou 5 bilinéaires et 1 tap sur R9 380 à 1600×1200 : 0,58 / 0,53 / 0,47 / 0,40 ms (sur
  GTX 980 à 1080p : 0,34 / 0,32 / 0,32 / 0,30) : sur un GPU d'ordinateur la passe domine et le
  nombre de taps compte peu ; Rákos : un gaussien 9 taps en 5 fetches, « environ 60 % plus rapide »
  sur HD 5770 ; Bjørge (Mali-T760, 1080p) : flou gaussien 41,9 ms, boîte 21,4, Kawase 4,5, « dual
  filter » 2,8 : sur un tiler, les fetches et les passes comptent énormément.
- **Sortie anticipée, art antérieur** : NEDI (2001) n'applique son estimateur qu'aux « pixels de
  contour » (5 à 15 % de l'image, variance locale au-dessus d'un seuil de 8), le reste en
  bilinéaire ; SGSR1 teste un gather et sort en bilinéaire ; NIS n'a pas de sortie anticipée par
  pixel (il saute des directions) ; EASU aucune ; Meta Quest Super Resolution (dérivé de SGSR) :
  « coût dépendant du contenu ». Aucune de ces sources ne chiffre le gain de la sortie anticipée
  seule sur un GPU moderne : Qualcomm montre même un temps insensible au seuil sur sa scène.


---

## 3. Conception du shader `mwsr`

### 3.1 Les principes, tirés des mesures

1. **Une passe, à la résolution de sortie, qui écrit la surface finale.** Pas de texture
   intermédiaire, pas de passe 0 en SDR. C'est la seule différence structurelle qui ne dépend
   d'aucune finesse de noyau, et la plus grosse : chez Atyuwen la passe de copie seule valait
   0,7 ms sur un iPhone 12 [démontré] ; ici elle vaut une passe plein écran à la résolution
   d'entrée plus un aller-retour mémoire de la trame.
2. **Le plancher, c'est la passe elle-même plus un échantillon bilinéaire.** Sur Adreno, Qualcomm
   mesure le bilinéaire pur à 0,16-0,25 ms et SGSR1 à 0,30-0,48 ms [démontré] : tout ce que le
   noyau ajoute se paie au-dessus de ce plancher, et doit donc n'être payé que là où l'œil le
   voit (les contours) et pas ailleurs. SGSR1 dépense déjà deux instructions texture sur son
   chemin plat (un bilinéaire et un gather) ; pour faire mieux il faut en dépenser **une**.
3. **Aucun `textureGather` dans le noyau de base.** Les taps sont des échantillons bilinéaires à
   des positions calculées : le même noyau lit une `texture_external` (WebGPU SDR, sans passe 0),
   une `texture_2d<f32>` (chemins HDR, laboratoire) et un `sampler2D` WebGL2. Atyuwen a montré
   sur l'iPhone 12 que remplacer les 12 gathers d'EASU par 5 échantillons bilinéaires divise le
   temps par deux sur un shader borné par la texture [démontré] ; ici c'est en plus la condition
   du jumeau WebGL2 et de la suppression de la passe 0.
4. **Des mathématiques valables en HDR.** Aucun seuil absolu en « n/255 », aucun clamp à 1,0 ; une
   compression de dynamique réversible encadre le noyau quand l'entrée est en lumière de scène
   (§4.1).
5. **Un noyau qui connaît l'échelle.** Trois régimes : réduction (filtre de surface), identité
   (contournement, §5), agrandissement (noyau directionnel) ; la netteté suit l'échelle.
6. **Original.** Idées empruntées et citées ; constantes, polynômes et structure à nous (§10).

### 3.2 Le noyau de base : un échantillon sur le plat, cinq sur les contours

Notation : `s = taille de sortie / taille d'entrée` par axe ; pour le pixel de sortie `o`, la
position d'entrée est `p = (o + 0,5) / s − 0,5` en texels d'entrée ; `t = 1 / taille d'entrée`
est le pas d'un texel en coordonnées de texture.

**Chemin plat (toutes les sorties).**

1. `C = sample(p)` : un seul échantillon bilinéaire RGB. C'est la couleur de base, et la sortie
   finale sur une zone plate.
2. `lC = luma(C)` avec une luma à deux multiplications-additions (pondération propre au projet,
   proche de Rec. 709 arrondie à des puissances de deux ; à fixer en P2).
3. **Le vote de contour par les dérivées d'écran** : `gx = dpdx(lC)`, `gy = dpdy(lC)`,
   `contraste = |gx| + |gy|` (`fwidth`). Les dérivées sont calculées par le GPU sur le quad 2×2 de
   pixels de sortie, **sans aucun échantillon supplémentaire** : elles existent en WGSL (`dpdx`,
   `dpdy`, `fwidth`, cœur du langage) et en GLSL ES 3.00 (`dFdx`, `dFdy`, `fwidth`). À
   l'agrandissement, deux pixels de sortie voisins sont à moins d'un texel d'entrée l'un de l'autre,
   et la dérivée de la luma bilinéaire est une mesure fidèle du gradient local, lissée d'un
   demi-texel. La branche qui en découle est cohérente par quad par construction, ce qui est
   exactement la granularité à laquelle un GPU paie la divergence.
4. Si `contraste < τ`, la sortie est `C`. Fin. Coût : la passe, un échantillon, une dizaine
   d'opérations. **C'est une instruction texture de moins que le chemin plat de SGSR1**
   [attendu : la dérivée n'est pas gratuite partout, mais elle est de l'ordre d'une addition par
   composante].

**Chemin contour (les quads où `contraste ≥ τ`).**

5. Quatre échantillons bilinéaires de plus, en croix à un texel : `A = sample(p + (0, −t))`,
   `B = sample(p + (−t, 0))`, `D = sample(p + (+t, 0))`, `E = sample(p + (0, +t))`. Chacun est
   déjà une moyenne 2×2 décalée d'un texel ; les cinq ensemble couvrent une fenêtre de 3×3 à
   4×4 texels selon la phase `f = p − floor(p)`, soit la même emprise que les 12 taps d'EASU ou de
   SGSR1, en cinq instructions texture au lieu de douze ou de quatre gathers.
6. Direction et cohérence du contour : `g = (lD − lB, lE − lA)` (différences centrées, déjà
   lissées), `d = g / |g|` avec un epsilon ; cohérence `a = |g| / (|lD − lC| + |lC − lB| + |lE − lC|
   + |lC − lA|)` dans [0, 1] : vaut 1 sur un contour net, tend vers 0 sur une texture ou du bruit
   de compression. C'est `a`, et non la seule force du gradient, qui dose l'anisotropie : un bloc
   de compression ou un grain n'est pas un contour.
7. Poids directionnels : pour chaque tap `i` d'offset `o_i` (en texels, relativement à `p`), on
   tourne l'offset dans le repère du contour, `v = R(d) · (o_i)`, on l'étire le long du contour et
   on le resserre en travers selon `a`, puis `x = |v|²` et `w_i = W(x)` avec une fenêtre
   polynomiale en `x` (sans racine ni fonction trigonométrique) : un lobe positif et un lobe
   négatif borné, dont la profondeur dépend de `a` et de l'échelle. Polynôme et constantes à fixer
   en P2 par le labo (§6), **pas ceux d'AMD ni de Qualcomm**.
8. Reconstruction : `R = Σ w_i · tap_i / Σ w_i` sur les trois canaux (les poids viennent de la luma,
   appliqués au RGB : le 4:4:4 est servi sans échantillon de plus, §4.2).
9. Anti-sonnerie : `R` est borné entre le minimum et le maximum des cinq échantillons (borne
   faible, gratuite). Variante `DERING_EXACT` : sur le chemin contour seulement, quatre
   `textureLoad` des quatre texels entourant `p` donnent la borne exacte 2×2 d'EASU (quatre
   instructions de plus, sur les contours seulement ; WebGPU, et WebGL2 par `texelFetch`). Le labo
   dira si la borne faible suffit sur du texte.
10. Netteté fusionnée, adaptative au contraste : `out = R + λ · (R − moyenne(A, B, D, E))`, avec
    `λ = netteté · S(s) · H`, où `S(s)` croît de 0 à l'échelle 1 (contournement de toute façon) à
    1 à l'échelle 2, et `H` est la marge locale (distance de `R` au min et au max du voisinage,
    normalisée, comme le font CAS et RCAS dans leur principe) qui empêche l'écrêtage et limite les
    halos. En 4:2:0 le terme de netteté s'applique à la luma seule (ajouté aux trois canaux) ; en
    4:4:4 par canal.

**Coût par pixel de sortie [attendu, à vérifier au labo]** : chemin plat = 1 échantillon et
~10-15 opérations ; chemin contour = 5 échantillons (9 avec `DERING_EXACT`) et ~60-90 opérations,
dont une `inverseSqrt` et une division. Sur une image de jeu ou de bureau, les quads « contour »
sont une minorité ; sur du texte dense ils dominent.

Ce décompte doit être lu avec **le modèle de coût de la texture externe** (§2.7, lu dans le code de
Chrome) : sur le chemin sans copie (NV12 matériel, SDR), **chaque échantillon vaut deux fetches**
(plan Y, plan UV) et une multiplication 3×4 ; WebKit échantillonne aussi deux textures. Donc, en
fetches : chemin plat `mwsr` sur externe = 2, contre 2 + une passe 0 entière pour le port SGSR1
actuel (son bilinéaire et son gather lisent la copie RGBA) ; chemin contour `mwsr` sur externe =
10, contre 5 + la passe 0 pour SGSR1. Sur une image de texte dense, la variante **sur RGBA après
passe 0** (5 fetches, et un gather possible) peut donc battre la variante sur externe : c'est
exactement ce que P0 mesure en premier (§6.4), et la réponse peut différer par classe de GPU. Le
plan ne tranche pas d'avance ; il garde les deux feeds dans la même source.

Deux points de la littérature pèsent sur la sortie anticipée elle-même : Apple rappelle qu'un
embranchement après un premier fetch fait attendre deux fois la latence texture (« souvent il faut
juste essayer »), et les mesures de Qualcomm montrent que le seuil de SGSR1 ne change pas son
temps sur leur scène. La sortie anticipée est donc une constante `EARLY_OUT` mesurée (branche
après le vote, ou cinq échantillons émis d'emblée et branche sur l'arithmétique seule), pas un
acquis. Dans les deux cas la branche est cohérente par quad, ce qui est la seule granularité qui
paie (les mesures de TexBench : écarter des tuiles entières divise le temps par deux, écarter un
pixel sur deux ne gagne rien).

### 3.3 Les variantes et leur sélection

Une seule source WGSL, spécialisée **par constantes `override`** (réglées à la création du
pipeline, sans remonter dans un uniforme ni dupliquer les chaînes) ; une seule exception, le type
de la texture d'entrée, qui n'est pas « overridable » en WGSL et se fait par substitution du
préambule (deux modules : `FEED_EXTERNAL`, `FEED_TEX2D`).

| Constante | Valeurs | Choisie par |
|---|---|---|
| `FEED` (préambule) | externe (SDR WebGPU) · `texture_2d<f32>` (HDR `linear`/`tonemap`/`tonemap-ext`, labo, et l'option « passe 0 gardée » si P0 la retient) | le chemin HDR de StreamView, comme aujourd'hui ; sur Chrome ≥ 137 une vue de texture ordinaire se lie à un emplacement `texture_external`, donc un seul module peut servir les deux feeds là où c'est accepté |
| `EARLY_OUT` | branche après le vote · cinq échantillons d'emblée, branche sur l'arithmétique | mesure P2 par classe de GPU (latence texture contre fetches économisés) |
| `MODE` | agrandissement · réduction | l'échelle de l'image, par image ; les deux pipelines sont construits une fois et choisis à chaque dessin |
| `TIER` | performance (5 taps) · qualité (5 taps + 4 diagonales sur le chemin contour, borne 2×2 exacte) | classe d'appareil et GPU (`adapter.info.architecture` quand il existe, sinon la détection actuelle) ; le gouverneur peut descendre de qualité à performance avant d'éteindre |
| `HALF` | f16 sur le chemin contour (coordonnées et accumulateurs de poids en f32) | `device.features.has('shader-f16')` ; jamais forcé : A/B au labo par GPU, car f16 ne gagne rien sur certains GPU d'ordinateur et a des pièges de précision sur Mali |
| `QUAD_UNIFORM` | la décision contour prise pour tout le quad, voire le sous-groupe (`quadBroadcast`, `subgroupAny`) | `device.features.has('subgroups')` et prise en charge en fragment ; sans elle, les dérivées rendent déjà la branche cohérente par quad |
| `DERING_EXACT` | borne 2×2 par quatre chargements de texels | `TIER` qualité ; sur texture externe seulement si `textureLoad(texture_external)` est disponible (§2) |
| `HDR_LINEAR` | compression de dynamique réversible autour du noyau | chemin `linear` |
| `CHROMA444` | netteté par canal | `this._yuv444` |
| `LINEAR_LIGHT` (réduction) | décodage sRGB par tap avant la moyenne, ré-encodage après | ordinateur ; coût à mesurer (côté hôte, le bilinéaire en lumière linéaire gagnait 4,6 dB de PSNR pour +30 % de temps sur le N95) |

Uniformes (un seul tampon, réécrit **seulement quand une valeur change**, pas à chaque image) :
tailles d'entrée et de sortie, `s`, phase, seuil `τ`, netteté, drapeaux. Bind group mis en cache
pour les feeds `texture_2d` ; par image pour la texture externe (obligatoire, elle expire).

### 3.4 Les techniques récentes du langage, et ce qu'elles achètent

Statuts lus dans les sources des navigateurs le 10/10/2026 (détail et matrice au §2.7) ; P0 relève
ce que chaque machine du parc expose vraiment (`adapter.features`), car la version ne suffit pas
(f16 dépend du pilote, les sous-groupes de l'étage fragment, etc.).

| Technique | Statut | Usage ici | Gain |
|---|---|---|---|
| Lecture directe de `texture_external` (`textureSampleBaseClampToEdge` et `textureLoad`, cœur du WGSL) | Chrome 116+, Safari 26, Firefox 144 (Windows, macOS) ; sans copie seulement pour une NV12 matérielle SDR dans Chrome | supprime la passe 0 en SDR | une passe plein écran et un aller-retour mémoire [démontré par l'architecture] ; mais chaque échantillon = deux fetches (§2.7) : le net se mesure en P0 |
| Dérivées `dpdx` / `dpdy` / `fwidth` (cœur, dérivées grossières autorisées même en mode compatibilité) | partout, WebGL2 compris | vote de contour sans échantillon | une instruction texture de moins que SGSR1 sur le plat [attendu] |
| `override` (cœur WebGPU 1.0) | Chrome 113, Safari 26, Firefox 141 | une source, N pipelines spécialisés | aucune branche uniforme morte dans le code compilé ; pas de chaînes dupliquées |
| `enable f16` (`shader-f16`) | Chrome 120 (D3D12 : DXC + SM 6.2 + 16 bits natifs ; Vulkan : f16 + int16 + tampons 16 bits ; Metal : toujours) ; Safari 26 toujours ; Firefox non ; terrain : ~29 % des Adreno 6xx, ~97 % des 7xx, 100 % Apple et Arm | arithmétique du chemin contour, en vecteurs (`vec4h`), coordonnées en f32, conversions minimisées (chaque fetch rend du f32) | 5,4 → 4,7 ms chez Atyuwen (A14) ; +12 à +40 % mesurés par shaderopt sur Mali-G720 ; ≤ 2 % et parfois négatif sur NVIDIA Ampère et après ; **jamais sur Pascal** (f16 à 1/64 du débit) [démontré ailleurs] |
| `enable subgroups` (opérations de quad et de sous-groupe, **fragment et compute**) | Chrome 134 (D3D12 SM 6.0, Metal Apple6/Mac2, Vulkan avec l'étage fragment) ; WebKit a le code (Metal3) mais pas Safari 26.0 selon les tables ; Firefox non | branche contour uniforme par sous-groupe (`subgroupAny`), en flot de contrôle uniforme seulement ; lanes auxiliaires au comportement dépendant de l'appareil | supprime le coût de divergence résiduel ; option, pas fondation |
| `GPUAdapterInfo` (`adapter.info.vendor` / `architecture` : « adreno-6xx », « adreno-7xx », « rdna4 », « blackwell »…) | Chrome 127, Safari 26, Firefox 141 partiel | choix du `TIER`, de `HALF` (pas sur Pascal) et de `EARLY_OUT` par GPU, à la place du reniflage WebGL | une détection standard, qui ne crée plus de contexte WebGL jetable |
| `timestamp-query` | Chrome 121 partout, **quantifié à 100 µs** sauf `chrome://flags/#enable-webgpu-developer-features` ; Safari 26 si compteur ; Firefox non | labo (§6) et, si présent, quatrième signal du gouverneur | un coût GPU réel sur WebGPU, qui manque aujourd'hui |
| `requestAdapter({ powerPreference: 'low-power' })` + `navigator.getBattery()` | Chrome seulement (Safari n'a jamais eu `getBattery`) | sur batterie, préférer l'iGPU d'un portable à deux GPU | à mesurer : un décodeur sur l'autre GPU fait tomber l'import dans le chemin à copie |
| Canvas en `STORAGE_BINDING` + compute par tuiles | légal pour `rgba8unorm` et `rgba16float`, `bgra8unorm` avec la fonctionnalité ; mais Chrome **recopie** le canvas sur Android pour tout canvas storage, sur macOS pour `rgba8unorm` ; Qualcomm : « préférer les fragment shaders » | **expérience P2.4, ordinateur seulement** : une tuile de sortie 16×16 charge une fois ses texels d'entrée en mémoire partagée (0,5-0,6 chargement par pixel de sortie à ×2 au lieu de 5) | prometteur sur GPU d'ordinateur ; sur mobile la passe fragment est le seul chemin sans copie : expérience à porte, pas la base |
| Immédiats (`immediate_address_space`, push constants) | Chrome 149-150 seulement | non : un seul tampon uniforme, réécrit au changement seulement (`writeBuffer` deux fois plus rapide depuis Chrome 144) | — |
| Espaces de canvas `srgb-linear` / `display-p3-linear` | Chrome 155-156 ; WebKit a le code | le chemin HDR `linear` pourrait écrire la lumière linéaire sans encodage sRGB | quelques opérations par pixel ; mineur |
| `pack2x16float` / `unpack` ; `dot4U8Packed` | cœur / `packed_4x8_integer_dot_product` Chrome 123 | empaquetage éventuel des taps en f16 pour la variante compute | marginal ; seulement si la variante compute est retenue |
| Mode compatibilité WebGPU (`featureLevel: 'compatibility'`) | Chrome 146 (Android GLES 3.1 ; D3D11 à l'étude) ; jamais dans Safari ; Firefox non engagé ; textures externes prises en charge, pas de `dpdxFine`, pas de sous-groupes | étend la portée de la saveur WebGPU sur Android ; ne remplace pas le jumeau WebGL2 (Safari, Firefox, iOS anciens) | portée, pas vitesse |

Ce que le shader **ne fait pas**, et pourquoi : pas de `discard` (coûteux sur les tuiles) ; pas
de boucle à bornes dynamiques ni d'indexation dynamique de tableaux (débordements de registres
sur Adreno) ; pas de lecture dépendante (toutes les coordonnées sont calculées depuis `p`) ; pas
de `textureSample` avec mipmaps (il n'y en a pas sur une trame vidéo) ; pas de deuxième passe
séparable (deux écritures plein écran coûtent plus que quatre taps de plus sur un GPU à tuiles).

### 3.5 Ce que le plan écarte

- **Temporel** (SGSR2, FSR2, ASR) : il faut profondeur, vecteurs de mouvement et jitter de
  caméra ; un client qui ne possède que des images décodées, déjà tone-mappées, anti-aliasées et
  compressées ne peut que les falsifier (fantômes à chaque mouvement). Écarté.
- **Neuronal** (FSRCNN, ESPCN, Anime4K « upscale ») : plusieurs passes et des milliers
  d'opérations par pixel ; aucune donnée publique ne les place sous la milliseconde sur un iGPU à
  1440p. Écarté pour la v0.4.1, noté au §12 comme piste de labo si le harnais existe.
- **NIS** comme base : son chemin par pixel recompte 36 lumas et quatre cartes de contour ; sa
  force est le compute à mémoire partagée, pas le fragment. Reste un cran de l'échelle.
- **Reprendre le gist d'Atyuwen tel quel** : il dépend de l'en-tête AMD (MIT, compatible), mais
  il supprime le déringing, n'a pas de réduction, pas de HDR, et sa version fusionnée applique la
  netteté sur l'anneau bilinéaire sans paramètre : c'est une source d'idées, pas un composant.

### 3.6 Le jumeau WebGL2 : même noyau, même coût, sans alourdir la version WebGPU

Réponse à la question posée pendant la rédaction (« une version optimisée WebGPU et une version
WebGL2 ? le même shader avec repli, sans alourdir le compute ? ») :

- **Même algorithme, deux textes.** Le noyau de base (§3.2) n'emploie que des échantillons
  bilinéaires et des dérivées d'écran : il s'écrit à l'identique en GLSL ES 3.00 (`texture`,
  `dFdx`, `dFdy`, `texelFetch` pour la borne exacte). Rien n'est émulé, rien n'est dégradé : le
  GLSL n'a pas quatre `texelFetch` par gather comme les ports actuels du dépôt.
- **Les couches WebGPU sont additives**, derrière des `override` : f16, quad uniforme, lecture
  directe de la texture externe, variante compute. Le WGSL compilé sans ces couches est le même
  programme que le GLSL ; avec, il est plus rapide. Aucun code de compatibilité ne pèse sur lui.
- **Le GLSL a sa propre demi-précision gratuite** : `precision mediump float` sur les couleurs et
  les poids (les coordonnées restent `highp`) donne du f16 sur Adreno, Mali et Apple en WebGL2,
  là où `enable f16` le donne en WGSL. C'est la seule différence de texte entre les deux.
- **Un seul générateur, deux cibles ?** Un petit module JS tient les deux textes côte à côte,
  avec les constantes partagées (polynôme, seuils, pondération de luma) injectées dans les deux
  depuis une seule table : pas de mini-langage, mais une garantie que les chiffres sont les mêmes.
- **Un test de conformité** (P4) rend les deux textes sur les mêmes images (labo, §6) et exige
  une différence maximale de 2/255 par canal en SDR ; au-delà, c'est un bug de port, pas une
  tolérance.
- **Qui tourne où** : la saveur WebGL2 reste la production SDR tant que la porte P4 n'a pas
  tranché WebGPU contre WebGL2 avec le nouveau shader sur chaque classe d'appareil (le wiki 15.3
  l'a laissé ouvert) ; WebGPU porte le HDR et, si P4 le confirme, le plein écran.

---

## 4. HDR, 4:4:4, agrandissement et réduction

### 4.1 HDR

Les trois feeds HDR existent déjà (§1.5) ; le shader doit seulement s'y comporter :

- **`tonemap`, `tonemap-ext`, `browser`** : l'entrée est déjà SDR après la passe 0 ou l'import ;
  rien de particulier, le noyau tourne tel quel.
- **`linear`** (AV1 logiciel, canvas `rgba16float` étendu, 1,0 = 203 nits, lumière de scène
  BT.2020 → P3) : le noyau reçoit des valeurs au-delà de 1,0 et une luminance très étirée. Le
  plan applique **une compression de dynamique réversible** autour du noyau : `y = x / (x + k)`
  par canal à l'entrée (k = 1 au blanc de référence), le vote, les poids, la borne et la netteté
  en `y`, puis `x = k · y / (1 − y)` à la sortie. Le noyau étant une combinaison convexe bornée
  plus un terme de netteté borné par la marge locale, `y` reste dans [0, 1) et l'inverse est
  sûre. Le principe est celui du tone-mapper réversible qu'AMD livre dans son en-tête (SRTM) pour
  le même usage ; la fonction et la constante sont les nôtres. Les seuils (`τ`, netteté)
  s'appliquent ainsi à des valeurs comparables à du display-referred, et un reflet spéculaire
  n'est ni écrêté ni rendu gris.
- Rien d'autre : pas de tone-mapping dans le shader (ce n'est pas son rôle), pas de conversion de
  gamut (le noyau est linéaire par canal), format intermédiaire inexistant (une passe).
- **Test** (P3) : une rampe PQ synthétique et un texte à fort contraste sur fond à 1000 nits,
  comparés à FSR1 `linear` : maximum conservé, aucun pixel au-dessus du maximum local d'entrée,
  écart de teinte borné (métrique ΔE dans le labo), et le temps GPU ajouté par le shader inférieur
  à celui de FSR1 sur le même feed (le gros du coût HDR reste le décodage logiciel AV1, 31 ms de
  p99 au wiki 15.5 : le shader ne le changera pas, et le plan le dit).

### 4.2 4:4:4

- En 4:2:0, la chrominance arrive déjà lissée par l'import (sur-échantillonnage bilinéaire du
  navigateur) : le noyau directionnel appliqué au RGB ne lui fait aucun mal, et la netteté sur la
  luma seule évite d'amplifier les franges de chroma.
- En 4:4:4 (texte, code, tableurs : la raison d'être du mode), la chrominance porte autant de
  contour que la luma : SGSR1 et NIS ne reconstruisent **que la luma** et laissent la chroma
  bilinéaire, d'où des franges colorées sur du texte coloré ; EASU filtre les trois canaux au prix
  de trois fois plus de gathers. Ici les cinq taps portent déjà le RGB : poids directionnels
  appliqués aux trois canaux sans coût de plus, et netteté **par canal** quand `CHROMA444` est
  levé (le renderer le reçoit de StreamView).
- Toujours SDR seulement (décision du wiki 15.6) : pas de chemin HDR 4:4:4 à prévoir.
- **Test** (P3) : mire de texte coloré (syntaxe colorée, fond sombre) en 4:4:4 et en 4:2:0,
  métrique sur les canaux de chroma séparément ; critère au §8.

### 4.3 Les régimes d'échelle

| `s` par axe | Régime | Noyau | Netteté |
|---|---|---|---|
| exactement 1 sur les deux axes | identité | **contournement, §5** : aucun shader d'enhancer | aucune (exigence du plan) |
| 1 < s ≤ 2 | agrandissement, cas nominal | §3.2 | `S(s)` de 0 à 1 |
| s > 2 (720p sur 4K, ×3) | agrandissement fort | même noyau : la fenêtre reste ±1 texel d'entrée, donc ±s pixels de sortie ; au-delà de ~×2,5 l'image est douce comme avec FSR1 et SGSR1, qui ne sont spécifiés que jusqu'à ×2 | 1 |
| 0,5 ≤ s < 1 (1440p sur un téléphone 1080p, fenêtre) | réduction modérée | filtre de surface : 4 taps bilinéaires aux coins d'un carré centré sur `p`, de côté `(1/s)` texel ; pas de vote de contour | éteinte (la réduction aiguise déjà) |
| 0,25 ≤ s < 0,5 (4K dans une petite fenêtre) | réduction forte | 9 taps (3×3) sur un carré de côté `1/s` ; en dessous de 0,25, 16 taps | éteinte |

- Les axes peuvent différer légèrement (arrondis du canvas) ; le régime se décide sur `min(s_x,
  s_y)` et le noyau utilise `s` par axe.
- `LINEAR_LIGHT` (réduction en lumière linéaire) est une option mesurée en P3 : le décodage sRGB
  par tap coûte quelques opérations, le gain en qualité est connu côté hôte (+4,6 dB au banc
  `mw-scaler-bench` sur le N95, pour +30 % de temps) ; décision par classe d'appareil.
- Le pinch-zoom et l'échelle de qualité changent `s` d'une image à l'autre : les pipelines des
  deux modes sont construits une fois à la création du renderer, et le choix se fait au dessin ;
  aucune compilation en cours de flux.
- Au-delà de ×2 : pas de second étage (une passe de plus coûterait plus qu'elle ne rapporte sur
  mobile, et le cas est rare). Noté au §12 comme piste si le labo montre un besoin.

---

## 5. Le passage direct à résolution native

### 5.1 Ce qui se passe aujourd'hui

Quand l'image et le canvas ont la même taille (plein écran avec « Match my screen » ou une boîte
Auto d'ordinateur, écran à `devicePixelRatio` entier), rien n'est contourné : sur WebGL2,
`gl-fsr1` fait EASU à l'échelle 1 (douze taps pour recopier un pixel) puis RCAS ; sur WebGPU, passe
0 puis l'enhancer. Seul `Canvas2D` (enhancer éteint) est déjà une identité : tampon à la taille de
l'image, aucun étirement.

### 5.2 La règle

**Détection par image, dans le renderer** : `inW === cw && inH === ch` (égalité exacte sur les
deux axes, aucune tolérance : une échelle de 0,98 n'est pas « identique » et se filtre). Alors :

- **aucune passe d'enhancer, aucune netteté, aucune texture intermédiaire** ; l'overlay affiche
  « Off (1:1) » pour que Bruno et les utilisateurs voient que l'enhancer dort ;
- le gouverneur ne reçoit **pas** d'observation pendant le contournement (sinon il mesurerait le
  coût d'un blit et « remonterait » un enhancer qui ne tourne pas) ;
- dès que `s` change (fenêtre, zoom, baisse de résolution sous congestion), l'enhancer reprend à
  l'image suivante, sans recréation de quoi que ce soit.

### 5.3 Le chemin le moins cher pour poser l'image, par renderer

| Renderer | Chemin au 1:1 | Copies GPU | À mesurer (porte P1) |
|---|---|---|---|
| WebGPU, SDR | la passe `off` existante : un triangle plein écran qui lit la texture externe et écrit le canvas. L'option `copyExternalImageToTexture({ source: frame }, { texture: canvasTex })` a été examinée et **écartée avant mesure** : dans le code de Chrome elle construit la même texture externe puis lance son propre pipeline de rendu plein écran (Dawn `CopyTextureForBrowser`), donc jamais moins cher que notre triangle ; Firefox ne l'accepte pas depuis une `VideoFrame`, Safari en 32 bits par pixel seulement (§2.7) | une écriture du canvas | contre Canvas2D au clic → photon plein écran |
| WebGPU, HDR `linear`/`tonemap` | la passe 0 (YUV → lumière ou ACES) écrit directement le canvas : c'est déjà ce que fait `off` | une | rien de plus : la passe 0 est la présentation |
| WebGPU, `tonemap-ext` | idem, depuis la texture externe | une | idem |
| WebGL2 | téléversement de la `VideoFrame` (`texImage2D`) puis un triangle trivial, comme son `off` d'aujourd'hui | le téléversement + une écriture | contre Canvas2D au clic → photon plein écran |
| Canvas2D | `drawImage(VideoFrame)` à taille égale : déjà l'identité | une (celle du navigateur), zéro copie sur les plateformes où Chrome dessine la trame comme texture | référence |

**Ce que l'architecture ne permet pas** : passer de WebGL2/WebGPU à Canvas2D quand `s` devient 1
en cours de flux (un canvas ne change pas de contexte), et le contraire quand l'échelle de qualité
baisse la résolution et que l'enhancer doit reprendre. Deux issues, à trancher par Bruno sur les
mesures de P1 :

1. **Accepter le blit trivial** comme « passage direct » du renderer à shaders :
   une écriture de surface, c'est le minimum possible sur un canvas, et le surcoût résiduel par
   rapport à Canvas2D est celui de la présentation WebGPU/WebGL mesurée en septembre, pas celui
   d'un shader. C'est la recommandation du plan si l'écart au clic → photon plein écran est sous
   1 ms de médiane.
2. **Deux canvas superposés** (un `2d`, un `webgpu`/`webgl2`), l'un visible à la fois, bascule au
   changement de régime : vrai Canvas2D au 1:1 **et** enhancer dès que l'échelle bouge. Coût : un
   second contexte vivant, une image de transition, et toute la plomberie de StreamView (sonde,
   curseur hôte, overlay, zoom) à faire suivre. À n'ouvrir que si P1 mesure un écart réel ; hors
   v0.4.1 sinon.

Le « zéro copie » absolu reste l'élément `<video>` (le compositeur présente la trame décodée,
parfois en plan matériel) : 35-45 ms plus lent au clic (wiki 15.5), écarté par la règle de
latence. Le plan ne le remet pas en jeu.

### 5.4 Au lancement

Quand l'enhancer est éteint, rien ne change : Canvas2D en SDR. Quand il est coché et que la
géométrie de lancement est 1:1, le renderer à shaders est tout de même créé (il devra agrandir si
le flux descend d'un cran) et contourne par image. Le plan ne propose pas de choisir Canvas2D au
lancement sur la foi de la géométrie, précisément à cause de l'échelle de qualité.

---

## 6. La méthode d'optimisation

### 6.1 Le labo

Une page (`scripts/bench/scaler-lab/` ou un dossier debug du frontend, hors bundle de
production) qui :

1. charge les images d'entrée (PNG de référence réduits hors ligne, et la boucle WebCodecs pour les
   variantes compressées) dans une `texture_2d`, et aussi comme `VideoFrame` pour le feed externe ;
2. compile la liste des variantes (clé `mwsr` × `override`s, plus les témoins SGSR1 dépôt et
   source, NIS, FSR1, bilinéaire, Smooth2D) et signale toute erreur de compilation avec le texte du
   compilateur ;
3. rend chaque variante N fois à chaque échelle, avec `timestamp-query` autour de chaque passe
   (code d'`UltraPlayer.js`), ou à défaut un lot de K soumissions amorties ; compte les quads sur le
   chemin contour par un compteur atomique dans un tampon (variante d'instrumentation, jamais
   mesurée pour le temps) ;
4. relit la sortie en PNG (`copyTextureToBuffer`) pour la chaîne Python (FLIP, SSIM, PSNR,
   SSIMULACRA 2, dépassements, scintillement), et affiche côte à côte avec un curseur et un
   agrandissement ×4 pour l'œil ;
5. écrit un JSON par cellule (variante, échelle, image, GPU, navigateur, fonctionnalités exposées,
   médiane, p99, dispersion), que `report.py` du banc sait agréger.

La page tourne sur n'importe quel navigateur du parc (Safari, Chrome ARM, iPhone compris) :
c'est elle qui donne les chiffres mobiles, pas un outil natif.

### 6.2 Les estimateurs hors ligne

- **Mali** : `malioc` (Arm Mobile Studio) sur le GLSL ES du jumeau et sur le SPIR-V émis par Tint
  ou naga depuis le WGSL ; cycles par unité, unité limitante, registres, pourcentage d'opérations
  16 bits. C'est la seule fenêtre sur Mali sans téléphone Mali ; estimation, à dire comme telle.
- **Adreno** : compilateur hors ligne Adreno (Qualcomm Package Manager) sur SPIR-V ou GLSL :
  comptes d'instructions et de lectures de texture, à mettre en regard des mesures sur l'Adreno
  618 du banc ARM.
- **Désassemblage** : Tint (`--format hlsl|msl|spirv`) et naga pour lire ce que le navigateur
  compile vraiment (les boucles déroulées, les branches, les conversions implicites), et PIX sur
  DualRTX pour le D3D12 final.

### 6.3 La boucle d'optimisation, et la place de l'assistance par modèle

La méthode est celle d'un superoptimiseur à la main, pas d'un outil : **énumérer des variantes,
mesurer, garder, consigner**. Chaque variante est une combinaison de choix discrets (polynôme de
fenêtre, luma, forme du vote, nombre de taps, borne, f16 ou non, ordre des opérations,
approximations de `inverseSqrt` et de la division), générée depuis la table de constantes du
§3.6 ; le journal (`journal.md` à côté du labo) note pour chacune : hypothèse, mesure, verdict.
Règles :

- rien n'entre dans le shader sans un chiffre du labo sur au moins deux GPU de classes
  différentes (un iGPU d'ordinateur, l'Adreno ou l'Apple) ;
- une variante qui gagne du temps mais perd en qualité (critères C3-C4) est consignée et refusée ;
- trois tours au plus par question (le critère d'arrêt du §8.3 s'applique au chapitre entier).

**L'assistance par modèle de langage** (ce que ce chantier fait de toute façon, puisqu'une
session Claude écrit le shader) prend ici la forme de la boucle « proposer, mesurer, garder » avec
le harnais comme juge : le modèle propose des réécritures candidates (tap de moins, polynôme plus
court, empaquetage f16, réordonnancement), le labo les mesure, le journal garde la trace. C'est la
forme réaliste de la « génération de shaders assistée par IA » : pas de génération à l'aveugle,
un harnais qui tranche. Les travaux publiés sur ce schéma (§2.8) disent tous la même chose : les
réécritures qu'un compilateur sait faire ne rapportent rien (0,0 ± 0,2 % chez shaderopt), les
gains sont algorithmiques (moins de fetches, f16 sur mobile, une passe au lieu de deux), et le
générateur triche dès que le vérificateur est à sa portée. D'où trois règles de harnais : le
temps vient des horodatages GPU, jamais d'un chronomètre que le code mesuré peut toucher ; les
images sont comparées hors de la page à une référence f32 indépendante ; la session qui propose
les variantes n'édite pas les scripts de mesure (ils sont commités avant P2.2 et ne bougent plus
pendant la boucle).

**SweetOpt** (§2.8) accepte du HLSL SM5, du GLSL fragment et ses propres expressions, pas du WGSL,
avec des modèles de coût d'ordinateur seulement : il sert sur le **chemin contour** (une fonction
de ~80 opérations, à découper en régions de 24 opérations), une fois la structure fixée ; le
résultat est reporté à la main dans le WGSL et le GLSL et revalidé par le test de conformité et par
la mesure (son coût est statique et ne connaît ni Adreno ni Apple). À utiliser en fin de P2.2,
jamais avant que les mesures aient fixé la structure : optimiser des instructions d'un noyau qu'on
va changer est du temps perdu. Les constantes du noyau trouvées par la boucle sont les nôtres
(§10) : un outil qui réécrit une expression n'en change pas l'auteur.

### 6.4 Ce qu'on mesure d'abord (P0, avant toute ligne de noyau)

1. le coût de **N échantillons bilinéaires sur `texture_external`** contre **blit + N sur RGBA**,
   pour N = 1, 5, 9, sur chaque GPU du parc : c'est la décision n° 2 du §0 ;
2. le coût des **dérivées** (`fwidth` d'une luma) contre un deuxième échantillon : la base du vote ;
3. la **dispersion** répétition à répétition par GPU, et la quantification des horodatages
   observée ;
4. les **lignes de base** complètes des cinq techniques existantes, chaîne et noyau seul.

---

## 7. Le protocole de comparaison équitable

### 7.1 Les règles d'équité

1. **Deux comptes par technique, toujours** : la **chaîne telle qu'elle tourne** chez
   l'utilisateur (passe 0 comprise pour les shaders WebGPU actuels, deux passes pour FSR1 WebGL2,
   `importExternalTexture` ou `texImage2D` compris) et le **noyau seul** sur une texture RGBA déjà
   matérialisée, même taille, même format. La première dit ce que le joueur paie ; la seconde dit
   ce que vaut l'algorithme. Un gain qui n'apparaît que dans la première est un gain d'architecture
   (vrai, mais à nommer ainsi) ; un gain qui n'apparaît que dans la seconde ne se verra pas.
2. **Mêmes images, même ordre.** Trois jeux d'entrée, les mêmes pour toutes les techniques :
   - **synthétique sans compression** : la page de laboratoire rend elle-même le contenu à la
     résolution de sortie (vérité terrain) et à la résolution du flux (entrée), avec les pages
     de banc du dépôt (`scripts/bench/content/still.html` texte fixe, `scroll.html` défilement,
     `cod.html` clip) et deux mires ajoutées (texte coloré pour le 4:4:4, zone-plate et traits fins
     pour la réduction) ; la réduction de la vérité vers l'entrée se fait hors ligne (Lanczos-3,
     Python), une fois, et les fichiers sont versionnés hors dépôt comme les clips du banc ;
   - **synthétique compressé** : les mêmes images passées dans une boucle WebCodecs
     encodeur → décodeur dans la page (HEVC, puis H.264 et AV1, 20 Mbit/s à 1080p60 et 40 à 1440p),
     pour que la `VideoFrame` qui nourrit la texture externe ait les artefacts d'un vrai flux ;
   - **flux réel** depuis la `--dev` de DualRTX pour les mesures de bout en bout (clic → photon,
     lignes `[perf]`, images présentées / décodées).
3. **Mêmes sorties** : même taille de canvas (pleine résolution de l'écran du client, et une
   fenêtre fixe pour la réduction), même format, même configuration (`opaque`, et `rgba16float` +
   `extended` pour les cellules HDR), même `devicePixelRatio`.
4. **Chauffe exclue, répétitions, dispersion** : 2 s de chauffe (compilation des shaders, montée
   des horloges), puis au moins 600 images par cellule, trois répétitions entrelacées A/B/A/B/A/B,
   médiane et p99 ; une différence n'est annoncée que si elle dépasse **deux fois** l'écart
   répétition à répétition, et le rapport donne cet écart.
5. **Conditions tenues et consignées** : GPU au mode par défaut (jamais « performances max »,
   règle du banc), HAGS tel quel, luminosité fixée et verrouillage de rotation sur les mobiles,
   mode avion sauf pour les cellules de flux réel, batterie entre 40 et 80 % et chargeur
   débranché pendant les cellules d'énergie, refroidissement entre deux cellules sur téléphone
   (température de surface stable), aucune autre application, encodeur et décodeur jamais sur le
   même GPU (règle DualRTX), onglet visible (la sonde dort sinon).
6. **Les shaders de référence sont ceux du dépôt**, tels qu'ils tournent (le port SGSR1 avec son
   seuil 6/255 et sa netteté 1,5, FSR1 avec RCAS 0,75 stop, NIS à 0,5), **et** la source Qualcomm
   d'origine (8/255, 2,0, clamp ±23/255) ajoutée au labo comme cellule témoin, pour qu'on ne
   gagne pas contre un port affaibli.

### 7.2 Ce qu'on mesure et avec quoi

| Grandeur | Instrument | Où | Remarque |
|---|---|---|---|
| Temps GPU par image, par passe | `timestamp-query` (code de `UltraPlayer.js`) ; à défaut, temps mur de `onSubmittedWorkDone` amorti sur un lot de K soumissions identiques (K choisi pour que le coût fixe par soumission tombe sous 2 %) | labo, tous navigateurs | Chrome quantifie les horodatages à **100 µs** sauf avec `chrome://flags/#enable-webgpu-developer-features` : drapeau obligatoire sur le Chrome de labo, ou empilement de N passes identiques ; Firefox n'expose pas la requête ; l'amortissement est dit comme tel dans le rapport ; une mesure témoin par plateforme avec PIX (Windows) ou Perfetto (Android, si téléphone) |
| Cycles estimés | compilateur hors ligne Mali (`malioc`) sur le GLSL et le SPIR-V émis par Tint/naga ; équivalent Adreno si disponible (§6) | hors ligne | seule mesure Mali possible sans téléphone Mali ; estimation, pas mesure |
| Clic → photon | sonde clic → drapeau du dépôt (`mwLatency.run()`, Chrome dédié par `cdp.py`, plein écran) | DualRTX, N95, UM790Pro, `mw-arm` | protocole du chapitre 15 et de `docs/bench-campaign.md` §5 ; dix clics après un clic de chauffe, trois séries |
| Âge du contenu présenté | sonde d'âge du contenu du dépôt (`ContentAgeProbe`, `scripts/bench/content-age/`) | tout client qui affiche la page, téléphones compris | mesure dans la page, pas de drapeau hôte : c'est l'instrument des mobiles |
| Débit présenté | `[perf]` : images présentées / décodées, pertes par cause, file de décodage | tous | un enhancer qui tient 60 i/s mais en présente 40 est un échec |
| Puissance GPU | `powermetrics --samplers gpu_power` (macOS, Mac M1) ; HWiNFO en journalisation (puissance GPU et paquet : DualRTX, N95, UM790Pro) ; `nvidia-smi` pour la RTX | ordinateurs | 5 min par cellule, moyenne et p95 |
| Énergie sur mobile | décharge de batterie en pourcentage sur 30 min de clip fixe, luminosité fixe, trois cellules entrelacées A/B ; sur Android (si prêt) `dumpsys batterystats` et rails Perfetto quand la puce les expose ; occupation GPU Adreno par `/sys/class/kgsl/kgsl-3d0/gpubusy` | iPhone, iPad, téléphone Android de prêt | un point de pourcentage est le plancher de bruit : il faut des cellules longues et répétées |
| Qualité | relecture des pixels de sortie (`copyTextureToBuffer`) en PNG, puis Python hors ligne : PSNR, SSIM, **ꟻLIP** (NVIDIA, BSD-3, conçu pour comparer des rendus), SSIMULACRA2 sur images, VMAF sur courtes séquences à titre indicatif (entraîné pour la compression, pas pour l'upscale : à ne pas sur-interpréter) ; métriques sans référence : taux de dépassement (pixels hors du min/max 2×2 local de plus de 2/255 = sonnerie), scintillement image à image sur contenu fixe, et la métrique de défilement du banc hôte (décalage d'1 px) | labo | la vérité terrain est le rendu natif de la page, jamais un flux décodé |
| Conformité WGSL / GLSL | même entrée, deux textes, différence maximale par canal | labo | ≤ 2/255 en SDR |

### 7.3 La matrice

Appareils (et navigateurs) : DualRTX sur 780M, Arc A380 et RTX 5060 Ti (Chrome ; Firefox si son
WebGPU y est actif) ; N95 (Chrome) ; UM790Pro (Chrome, Windows et Ubuntu) ; Mac M1 (Chrome et
Safari) ; `mw-arm` (Chrome Windows ARM) ; AMD 610M ; iPhone et iPad (Safari ; Chrome iOS est
WebKit aussi) ; téléphone Android de prêt si obtenu.

Cellules : {mwsr performance, mwsr qualité, SGSR1 dépôt, SGSR1 source, NIS, FSR1, bilinéaire
(`off`), Smooth2D} × {WebGPU, WebGL2 quand la saveur existe} × échelles {×1 (contournement),
×1,33, ×1,5, ×2, ×3 ; ×0,75, ×0,5} × contenus {texte, interface, jeu, mires} × {brut, compressé}
× {SDR, HDR `linear` (AV1, DualRTX et Mac), 4:4:4 (hôte NVENC)}. La matrice complète ne se joue
que sur DualRTX et un mobile ; les autres machines jouent l'étoile (chaque facteur une fois autour
du cas nominal ×1,5 texte compressé SDR), comme la campagne de banc le fait déjà.

### 7.4 Ce que le rapport doit dire

Par appareil : temps GPU chaîne et noyau (médiane, p99, dispersion), part des quads sur le chemin
contour (compteur dans le labo), qualité (FLIP moyen et 99e centile, SSIM, dépassements), clic →
photon ou âge du contenu, puissance ou décharge ; un tableau « démontré / attendu » mis à jour
par rapport à ce plan ; et, pour chaque objectif du §0, « atteint / non atteint / non mesurable
ici » avec la raison.

---

## 8. Critères d'acceptation, non-régression, risques, dépendances

### 8.1 Critères chiffrés (hypothèses à vérifier, pas des résultats)

Les seuils sont ceux qui, atteints, justifient de changer un défaut ; en dessous, `mwsr` reste un
cran de l'échelle et une option du menu debug, ce qui est déjà utile.

| # | Critère | Seuil | Où | Objectif du §0 |
|---|---|---|---|---|
| C1 | Temps GPU mobile contre SGSR1 (même saveur, chaîne telle que livrée) | `mwsr` ≤ 0,8 × SGSR1 sur jeu et interface ; ≤ 1,0 × sur texte dense ; noyau seul ≤ 0,9 × | `mw-arm` (Adreno 618), iPhone, iPad | plus rapide que SGSR1 |
| C2 | Temps GPU ordinateur contre FSR1 | chaîne WebGPU ≤ 0,6 × FSR1 ; chaîne WebGL2 ≤ 0,8 × FSR1 | 780M, Arc, RTX, N95, M1, 610M | plus rapide que FSR1 |
| C3 | Qualité contre FSR1 à ×1,5 et ×2 | FLIP moyen ≤ FSR1 + 0,01 et SSIM ≥ FSR1 − 0,005 sur texte, interface, jeu, brut et compressé ; dépassements ≤ FSR1 | labo | qualité comparable |
| C4 | Qualité contre SGSR1 | FLIP ≤ SGSR1 sur tout contenu (au moins égal) | labo | — |
| C5 | Latence | clic → photon plein écran DualRTX : médiane ≤ Auto actuel + 1 ms, p90 ≤ + 2 ms ; images présentées / décodées ≥ 98 % partout | DualRTX, N95, UM790Pro, `mw-arm` | latence |
| C6 | Énergie | Mac M1 : puissance GPU moyenne `mwsr` ≤ SGSR1 et ≤ FSR1, écart > 2 × dispersion ; iPhone : décharge sur 30 min ≤ SGSR1 (pas pire, au point près) ; `mw-arm` : occupation GPU inférieure | M1, iPhone, `mw-arm` | plus économe |
| C7 | Contournement 1:1 | temps GPU du renderer = celui de `off` ± 5 % ; aucune image perdue au passage 1:1 ↔ échelle ; overlay « Off (1:1) » | tous | passage direct |
| C8 | HDR `linear` | temps ajouté par le shader ≤ FSR1 `linear` ; maximum conservé ; aucun pixel au-delà du maximum local d'entrée ; ΔE borné (seuil fixé en P0 sur FSR1 lui-même) ; regard de Bruno sur le M27Q en HDR | DualRTX, Mac | HDR |
| C9 | 4:4:4 | FLIP sur les canaux de chroma de la mire de texte coloré : meilleur que SGSR1, ≥ FSR1 | DualRTX (NVENC) | 4:4:4 |
| C10 | Réduction ×0,75 et ×0,5 | énergie d'aliasing (zone-plate, traits fins, métrique de défilement) ≤ Smooth2D ; PSNR à 1 dB du Lanczos-2 de l'hôte ; coût ≤ bilinéaire + 30 % | labo, téléphone 1080p | downscale |
| C11 | Conformité des jumeaux | écart maximal WGSL / GLSL ≤ 2/255 par canal | labo | — |
| C12 | Robustesse | aucun NaN ni noir sur image plate (divisions protégées), reprise après `device.lost`, Safari et Firefox sans erreur de compilation, empreintes dorées stables sur WebGPU logiciel | labo, CI | — |

Ce qui est **non mesurable dans ce parc** et sera dit tel quel dans le rapport : Adreno 7xx et
8xx, Mali de téléphone, Chrome Android (sauf prêt d'un téléphone). Le verdict « plus rapide que
SGSR1 sur mobile » sera donc « démontré sur Adreno 618 et sur Apple, extrapolé ailleurs », ou
rien.

### 8.2 Non-régression

- **Tests existants** : la suite `vitest` (748 tests au dernier décompte) passe ; `createRenderer.test.js` et
  `EnhancerGovernor.test.js` sont étendus (routage de `mwsr` et `gl-mwsr`, place dans l'échelle,
  mémoire du cran, mappage HDR `gl-mwsr → mwsr`, `NO_WEBGPU_ALGOS`).
- **Logique pure testée sans GPU** : le choix des `override` et du `TIER` par appareil, le calcul
  des uniformes (échelle, phase, régime), la détection 1:1, extraits dans des fonctions pures.
- **Validation statique des shaders en CI** : un script Node extrait les chaînes WGSL et GLSL des
  modules et les passe à un validateur (naga ou Tint en ligne de commande, ou, plus simple à
  installer, un Chrome sans tête avec WebGPU logiciel) ; aujourd'hui une faute de WGSL n'est vue
  qu'au premier flux.
- **Tests dorés** : un Chrome sans tête (Playwright) avec l'adaptateur WebGPU logiciel
  (SwiftShader, drapeaux `--enable-unsafe-swiftshader` et adaptateur logiciel) rend chaque variante
  sur trois images fixes à deux échelles et compare une empreinte des pixels à une référence
  versionnée ; la même page vérifie la conformité WGSL / GLSL. Job CI séparé et non bloquant au
  début (temps et flakiness à observer), bloquant quand il est stable.
- **Banc d'acceptation** : la campagne `/bench` existante tourne avec `mwsr` dans sa matrice
  (enhancer coché) sur les six machines ; aucun rouge nouveau.
- **Les trois ports existants ne bougent pas** : SGSR1, NIS, FSR1 restent tels quels (références de
  banc, crans de l'échelle, options debug) ; leurs tests dorés les protègent aussi.

### 8.3 Risques

| Risque | Effet | Parade, et la phase qui le lève |
|---|---|---|
| L'échantillonnage direct de la texture externe coûte plus que prévu (conversion YUV à chaque tap, deux plans lus par échantillon) et mange le gain de la passe 0 | la décision d'architecture n° 2 tombe | P0 mesure « N bilinéaires sur externe » contre « blit + N bilinéaires sur RGBA » avant d'écrire une ligne de noyau ; repli : passe 0 gardée, gain limité au noyau |
| Le vote par dérivées rate des contours fins (luma bilinéaire trop lisse) ou se déclenche sur du bruit de compression | qualité sur le texte, ou chemin contour partout | P2 : seuil `τ` et cohérence `a` réglés sur le jeu compressé ; variante témoin avec le vote à 3 taps ; critère C3 |
| La borne faible (min/max des 5 taps) laisse sonner le texte à ×2 | halos | `DERING_EXACT` (4 chargements sur les contours) ; critère C3 sur les dépassements |
| WebGPU reste plus lent que WebGL2 en SDR sur le thread principal (présentation) quel que soit le shader | le gain WGSL n'atteint pas la production SDR | le jumeau GLSL est dans le périmètre dès P4 ; porte P4 remesure la question ouverte du wiki 15.3 |
| f16 : absent sur le D3D12 de certaines machines, probablement absent de l'Adreno 618 du banc dans Chrome (~29 % des Adreno 6xx l'exposent), non exposé par Firefox, piégeux sur Mali (précision des coordonnées), nul sur NVIDIA récent et **néfaste sur Pascal** | variante inutile, fausse ou plus lente | f16 est un `override` décidé par mesure et par `adapter.info`, jamais imposé ; coordonnées toujours en f32 ; le jumeau WebGL2 a son `mediump` sur le même Adreno |
| Le coût doublé des échantillons sur la texture externe (deux plans par échantillon) rend la variante « passe 0 gardée » plus rapide sur le texte dense | la décision n° 2 devient conditionnelle | les deux feeds vivent dans la même source ; P0 mesure, et le choix peut dépendre de la classe de GPU, voire rester les deux dans le menu debug |
| Sous-groupes ou `textureLoad` externe indisponibles sur Safari | couches WebGPU réduites sur iOS | ce sont des couches optionnelles ; la base tourne sans |
| Aucun Adreno récent ni Mali au banc | objectif mobile démontré partiellement | dit dans le rapport ; `malioc` pour une estimation Mali ; prêt d'un téléphone demandé tôt |
| La qualité « comparable à FSR1 » n'est pas atteinte sur le texte | `mwsr` ne remplace pas FSR1 sur ordinateur | critère d'arrêt explicite en P2 : après trois itérations du labo, si C3 n'est pas tenu à ×2, l'objectif ordinateur devient « plus rapide à qualité SGSR1 » et FSR1 reste le cran « qualité » |
| Le gouverneur se trompe avec un cran moins cher que `sgsr` (ordre de l'échelle, mémoire par appareil) | descente ou remontée absurdes | tests du gouverneur ; le cran `mwsr` entre dans l'échelle avec une migration de la mémoire `mw_enhancer_rung` |
| Dérive de calendrier : la v0.4.0 glisse, ou un chantier prioritaire (PyroWave) reprend les bancs | P0 et P5 attendent les machines | le plan n'occupe aucune machine avant P0 ; P2 et P3 sont du labo sur DualRTX seul |
| Brevets | aucun grant explicite dans MIT ni BSD-3 ; les techniques (interpolation dirigée, netteté adaptative) sont de l'art ancien et public | code original, constantes propres, pas de nom de marque dans l'interface ; risque identique pour les trois ports déjà livrés |

### 8.4 Dépendances

- La release v0.4.0 publiée (le plan n'en touche aucun fichier) et `main` propre.
- Les machines du §1.8 à leurs créneaux : DualRTX pour P0-P3, le Mac de Léo et l'iPhone pour P0 et
  P5, `mw-arm` pour P0 et P5, N95 et UM790Pro pour P5 ; un téléphone Android de prêt (souhaité).
- Les clips et pages de banc hors dépôt (cache déjà prévu par la campagne).
- Les versions de navigateur du parc relevées en P0 (Chrome, Safari, Firefox), avec les
  fonctionnalités WebGPU exposées par chacun (`adapter.features`), consignées dans le rapport.
- Python avec les paquets de métriques (FLIP, scikit-image, numpy) sur DualRTX ; `malioc` (Arm
  Mobile Studio, gratuit) si on veut l'estimation Mali.
- Rien côté hôte : aucun changement du natif, aucun protocole nouveau.

---

## 9. Les phases, leurs portes, le modèle et l'effort

Convention du projet (règle du 25/09) : Opus 5.5 pour chaque tâche, seul l'effort varie. La
colonne « modèle » suit cette règle ; là où une autre option serait plus efficace, elle est dite
entre parenthèses et c'est Bruno qui tranche au « go » de la phase. Les durées sont des ordres de
grandeur en sessions de travail, bancs compris ; une porte ferme chaque phase et ouvre la suivante
par un « go » de Bruno.

| Phase | Contenu | Livrables | Porte (ce qu'il faut pour passer) | Modèle · effort | Taille |
|---|---|---|---|---|---|
| **P0 — Labo et lignes de base** | page de laboratoire (`scripts/bench/scaler-lab/` ou dossier debug du frontend : N variantes × images × échelles, horodatages GPU repris d'`UltraPlayer.js`, amortissement de secours, relecture PNG, compteur de quads contour) ; chaîne de métriques Python ; relevé des fonctionnalités WebGPU de chaque navigateur du parc ; lignes de base SGSR1 (dépôt et source), NIS, FSR1, bilinéaire, chaîne et noyau seul, sur DualRTX (3 GPU), `mw-arm`, Mac M1, iPhone ; **l'essai décisif** : N échantillons bilinéaires sur texture externe contre blit + N sur RGBA | page, scripts, rapport de base (tableaux du §7.4 pour les techniques existantes), matrice des fonctionnalités | dispersion répétition à répétition < 5 % sur le temps GPU ; coût de l'échantillonnage externe connu ; décision passe 0 oui/non | Opus 5.5 · `high` (banc et harnais) | 3-4 sessions |
| **P1 — Contournement 1:1** | détection par image dans `WebGpuRenderer` et `WebGlRenderer` ; présentation par le blit `off` existant (l'option `copyExternalImageToTexture` est écartée par lecture du code de Chrome, §5.3) ; gouverneur mis en pause pendant le contournement ; overlay « Off (1:1) » ; tests | code, mesure blit WebGPU / blit WebGL2 / Canvas2D au clic → photon plein écran | C7 tenu ; écart à Canvas2D connu ; décision « blit » ou « deux canvas » prise par Bruno | Opus 5.5 · `medium` (code cadré) puis `high` (la mesure) | 1-2 sessions |
| **P2 — Le noyau** | P2.1 écriture du noyau de base WGSL (feed `texture_2d` d'abord, dans le labo), polynôme, seuil, luma, borne, netteté fusionnée ; P2.2 boucle d'optimisation (§6) : variantes, mesures, `malioc`, journal des essais ; P2.3 couches `HALF`, `QUAD_UNIFORM`, `DERING_EXACT`, feed externe ; P2.4 expérience compute par tuiles (optionnelle, porte propre) | shader, journal, tableau démontré / attendu | C1 et C2 provisoires tenus sur 780M, Arc, `mw-arm`, M1 ; C3 et C4 tenus au labo ; sinon critère d'arrêt du §8.3 appliqué et objectif ordinateur rebaisé | Opus 5.5 · `max` pour P2.1 (cœur de chantier, algorithme délicat ; Fable 5.1 `max` serait l'alternative la plus efficace sur ce seul chapitre si Bruno l'accepte) ; `xhigh` pour P2.2 (mesures à interpréter) ; `high` pour P2.3 et P2.4 | 4-6 sessions |
| **P3 — HDR, 4:4:4, réduction** | `HDR_LINEAR` (compression réversible), `CHROMA444`, mode réduction (4 / 9 / 16 taps, `LINEAR_LIGHT` mesuré), mires, tests dorés | shader complet, résultats C8-C10 au labo | C8, C9, C10 tenus au labo ; regard de Bruno en HDR | Opus 5.5 · `high` | 2-3 sessions |
| **P4 — Intégration et jumeau WebGL2** | clé `mwsr` dans `WebGpuRenderer` (pipelines par `override`, deux modes, bind groups en cache), `gl-mwsr` dans `WebGlRenderer`, test de conformité, `createRenderer` / `NO_WEBGPU_ALGOS` / `ENHANCER_LADDER` / `pickAutoEnhancer` derrière un drapeau (pas encore le défaut), menu debug, i18n (en, fr, zh), overlay, worker, validation statique en CI, tests `vitest`, docs de code ; **porte WebGPU contre WebGL2** remesurée avec le nouveau shader par classe d'appareil | code intégré, CI verte, rapport WebGPU / WebGL2 | C11 et C12 tenus ; aucune régression `vitest` ni `/bench` ; décision par classe d'appareil : quelle saveur en SDR | Opus 5.5 · `medium` pour l'intégration (travail spécifié par ce plan), `high` pour la porte ; les chaînes i18n, la doc et le squelette des tests sont du `low` (Sonnet 5.5 ferait l'affaire si Bruno accepte une exception) | 3-4 sessions |
| **P5 — Campagne de validation** | matrice du §7.3 sur le parc ; énergie (M1, iPhone, `mw-arm`) ; clic → photon ; `/bench` avec `mwsr` ; A/B subjectif de Bruno (texte, bureau, jeu, LAN et Internet) | rapport de campagne, verdict objectif par objectif | C1-C10 jugés ; liste des non mesurables | Opus 5.5 · `xhigh` (bancs partagés, mesures à interpréter) ; Bruno aux manettes pour le Mac, l'iPhone et le ressenti | 3-4 sessions, étalées sur les créneaux |
| **P6 — Défauts, documentation, release** | bascule de `auto` par classe d'appareil selon P4 et P5 (ou non), migration de la mémoire du gouverneur, `README.next.md`, chapitre du wiki (addendum au 15 ou chapitre 16), notes de release (format « deux thèmes »), mémoires de session, paragraphe « Concrètement, pour l'utilisateur » | commits, docs, notes | relecture de Bruno ; `/bench` vert ; push | Opus 5.5 · `medium` | 1-2 sessions |

Total indicatif : 17-25 sessions, dont une bonne part de banc. Les phases P2 et P3 n'occupent
que DualRTX (labo local) ; P0, P4 (porte) et P5 ont besoin des créneaux Mac, iPhone et `mw-arm`.

**Ordre et parallélisme** : P1 est indépendant de P2-P3 et peut se livrer tôt (il a sa valeur
seul). P0 précède tout (sans lignes de base, pas de verdict). P2.4 (compute) ne bloque rien.
Chaque porte se termine par un `/compact` et un rapport à la session d'orchestration avec
l'effort conseillé de la phase suivante, comme pour les autres plans.

---

## 10. Sources, licences et règles de réutilisation

### 10.1 Licences des composants étudiés et ce qu'elles imposent

| Composant | Licence | Ce que le projet peut en faire | Obligations si du code en est repris |
|---|---|---|---|
| FSR1 (`ffx_fsr1.h`, `ffx_a.h`), AMD | MIT, © 2021 AMD (+ © 2014 Michal Drobot pour les approximations) | lire, porter, dériver ; déjà porté dans le dépôt | garder les deux avis dans toute copie « substantielle » ; AMD demande de ne pas exposer « RCAS » dans l'interface et de nommer la technique « AMD FSR 1.0 » |
| Port WGSL firdawolf de FSR1 | MIT | déjà dans le dépôt | avis conservé (il l'est) |
| Gist d'Atyuwen (`opt_fsr_easu.fxh`, `opt_fsr.fxh`) | « Distributed under the MIT License. Copyright (c) 2021 atyuwen. » (texte complet absent ; dépend de l'en-tête AMD) | lire ; ne pas recopier (le plan n'en a pas besoin) | si un extrait entrait : texte MIT complet + ce copyright + l'avis AMD |
| Billet d'Atyuwen | CC BY-NC 4.0 (prose et figures) | citer, pas reproduire | attribution ; pas d'usage commercial du texte |
| SGSR1, Qualcomm | BSD-3-Clause, © 2023/2025 Qualcomm Innovation Center | déjà porté ; compatible GPL-3.0-or-later (GPLv3 §7 b et d couvrent ses clauses) | avis + conditions + disclaimer dans le fichier dérivé et dans les notices binaires ; **ne pas** utiliser « Qualcomm » ni « Snapdragon™ » pour promouvoir le produit ; « SGSR1 » dans un menu est descriptif et acceptable |
| NIS, NVIDIA | MIT, © 2022 NVIDIA | déjà porté | avis conservé |
| CAS, AMD | MIT | idées (netteté bornée par le contraste local) | — |
| RAVU, nnedi3, SSimSuperRes, KrigBilateral, SSimDownscaler (mpv) | LGPL-3 (nnedi3 amont GPL) | lire ; ne pas intégrer | — |
| Anime4K | MIT | lire | — |
| adaptive-sharpen | BSD | lire | — |
| ꟻLIP (NVIDIA) | BSD-3 | outil de mesure hors ligne | — |
| SSIMULACRA 2 | BSD-3 + fichier PATENTS | outil de mesure hors ligne | — |
| VMAF | BSD-2 + concession de brevets | outil de mesure hors ligne | — |
| SweetOpt | GPL-3 (l'outil) | outil hors ligne ; sa sortie n'est pas couverte | — |
| `malioc`, Radeon GPU Analyzer, compilateur Adreno | gratuits (Arm Mobile Studio ; RGA MIT ; Qualcomm) | estimateurs hors ligne | — |

Aucune de ces licences ne contient de concession de brevet expresse (sauf VMAF et le fichier
PATENTS de SSIMULACRA 2) ; MIT et BSD-3 ne le font pas plus l'une que l'autre. Le risque est
identique pour les trois ports déjà livrés et pour un shader original ; les techniques en jeu
(interpolation dirigée par le gradient, fenêtre polynomiale, netteté bornée par le contraste
local) sont publiées depuis vingt ans.

### 10.2 La règle de salle blanche pour `mwsr`

- **Lu** : tout ce qui précède, ainsi que la documentation des éditeurs.
- **Repris comme idée, en le citant** (en tête du fichier et dans la doc) : taps bilinéaires au
  lieu de gathers (Atyuwen, Jimenez, MJP), sortie anticipée sur un vote de contour (SGSR1, NEDI),
  borne min/max locale contre la sonnerie (EASU, SGSR1), netteté résolue par la marge locale (CAS,
  RCAS), compression de dynamique réversible autour du noyau (SRTM d'AMD), vote par dérivées
  d'écran (le nôtre), fenêtre polynomiale en `d²` sans transcendante (principe commun à EASU et
  SGSR1, polynôme différent).
- **Jamais recopié** : une ligne de code, un polynôme, une constante (ni `25/16`, ni `2/5`, ni
  `(x−1)(x−4)³`, ni `0,55`, ni `2,181818`, ni `10,14185`, ni `0,1875`), une structure de fonction.
  La table de constantes du §3.6 est produite par le labo (P2), et le journal en garde l'origine.
- **Dans l'interface** : « Netteté MoonlightWeb », ou le nom que Bruno choisira ; jamais une marque
  tierce accolée au nôtre.
- **Le fichier** porte l'en-tête GPL-3.0-or-later du projet et le copyright de Bruno, comme le reste
  du dépôt ; les trois ports gardent les leurs.

### 10.3 Sources consultées (sélection ; les rapports de recherche complets sont dans le scratchpad de la session, à archiver avec le plan)

FSR1 : `github.com/GPUOpen-Effects/FidelityFX-FSR` (readme, license, `ffx-fsr/ffx_fsr1.h`,
`ffx_a.h`, `docs/FidelityFX-FSR-Overview-Integration.pdf`), `gpuopen.com/fidelityfx-superresolution/`,
Unity/AMD SIGGRAPH 2021 (`advances.realtimerendering.com/s2021/Unity AMD FSR - SIGGRAPH 2021.pdf`),
ports : Godot `fsr_upscale.glsl`, Unity `FSRCommon.hlsl`, mpv `agyild/FSR.glsl`, RetroArch
`edge-smoothing/fsr`, three.js `FSR1Node.js`, Looking Glass, Unreal « Mobile FSR ».
Atyuwen : `atyuwen.github.io/posts/optimizing-fsr/`, gist `78d6e810e6d0f7fd4aa6207d416f2eeb`
(révisions et commentaires), fork `atyuwen/FidelityFX-FSR`.
SGSR : `github.com/SnapdragonStudios/snapdragon-gsr` (README, LICENSE, `sgsr/v1/README.md`, les
quatre shaders v1, `sgsr/v2/README.md`, issues 1-8), plugins Unreal et Unity de Qualcomm, billets
Qualcomm 2023 et 2024, framework Vulkan Adreno.
NIS et CAS : `github.com/NVIDIAGameWorks/NVIDIAImageScaling` (`NIS_Scaler.h`, `NIS_Config.h`,
guide PDF), `github.com/GPUOpen-Effects/FidelityFX-CAS` (`ffx_cas.h`), `gpuopen.com/fidelityfx-cas/`.
Noyaux et réduction : GPU Gems 2 ch. 20, gist MJP Catmull-Rom, mpv `DOCS/man/options.rst` et
version 0.37, `libplacebo.org/options`, Robidoux (`usage.imagemagick.org/filter/nicolas/`), articles
NEDI (Li et Orchard 2001), iNEDI (Asuni et Giachetti 2008), DCCI (G'MIC), `bjin/mpv-prescalers`,
gists igv, `bloc97/Anime4K`, `Anime4K-WebGPU`, arXiv 1609.05158, 1608.00367, 2108.10335,
1606.01299, 2105.01237, SR+Codec (BMVC 2024, arXiv 2305.04844), ONNX Runtime Web (WebGPU EP).
Métriques : `github.com/Netflix/vmaf` (FAQ, README), `github.com/NVlabs/flip`,
`github.com/cloudinary/ssimulacra2`, `richzhang/PerceptualSimilarity`, `dingkeyan93/DISTS`.
Outillage : `developer.chrome.com/blog/new-in-webgpu-121` (horodatages), `web3dsurvey.com`,
`toji.dev/webgpu-profiling/` (PIX, Xcode), `GameTechDev/PresentMon`, page de manuel `powermetrics`,
`learn.arm.com` et `developer.arm.com` (malioc), `perfetto.dev` (batterie, GPU),
`developer.android.com/agi` et l'étude Kuro Games, `GPUOpen-Tools/radeon_gpu_analyzer`.
Plateformes WebGPU (sources lues sur `main` le 10/10/2026) : spécifications `gpuweb/spec/index.bs`,
`wgsl/index.bs`, `proposals/compatibility-mode.md` ; Dawn `core.def`, `wgsl.def`,
`multiplanar_external_texture.cc`, `ExternalTexture.cpp`, `CopyTextureForBrowserHelper.cpp`,
`PhysicalDevice{Vk,D3D12,MTL}` ; Chromium `external_texture_helper.cc`, `gpu_queue.cc`,
`gpu_canvas_context.cc`, `webgpu_swap_buffer_provider.cc`, `gpu_adapter.cc`,
`webgpu_decoder_impl.cc`, `webgpu_blocklist_impl.cc`, `paint_canvas_video_renderer.cc`,
`color_space.cc`, `webcodecs/video_frame.cc`, `supported_profile_helpers.cc`,
`dc_layer_overlay.cc`, `ca_layer_overlay.cc` ; WebKit `HardwareCapabilities.mm`,
`ExternalTexture.mm`, `BindGroup.mm`, `GPUCanvasContextCocoa.mm`, `WGSL.cpp`,
`TypeDeclarations.rb` ; Firefox `dom/webgpu/*.cpp`, `StaticPrefList.yaml` ; `mdn/browser-compat-data` ;
billets `developer.chrome.com/blog/new-in-webgpu-{116,121,129,133,134,137,138,142,144,146,149-150,155-156}` ;
`chromestatus.com` ; `webkit.org/blog/17333/` ; bugs WebKit 272702 et 254668 ; gpuweb issues 4384,
4919, 5236 ; Khronos WebGL PR 3668 ; `w3c/window-management` PR 150 ; `ColorWeb-CG` HDR canvas.
Optimisation : `ceejay.dk/sopt/` et `github.com/CeeJayDK/sopt` (versions 0.6.0, 0.7.0, TexBench),
`StanfordPL/stoke`, `google/souper`, `mangpo/greenthumb`, Mirage, `rudybear/shaderopt`
(`lab/reports/FINAL.md`), `KhronosGroup/SPIRV-Tools`, `laurentlb/shader-minifier`, Mesa NIR ;
KernelBench (arXiv 2502.10517), NVIDIA (DeepSeek-R1, 02/2025), AlphaEvolve (05/2025), Sakana
(TechCrunch, arXiv 2509.14279), Kevin-32B (Cognition), METR (06/2025), Sitthi-Amorn 2011, Wang
2014, He 2016 ; guide Arm 101897 (2025), note Arm ECM-0442477, Imagination « Demystifying
Precision », WWDC16 « Advanced Metal Shader Optimization », GPUOpen RDNA Performance Guide, livres
blancs NVIDIA Pascal/Ampère/Ada, Rákos 2010, Bjørge SIGGRAPH 2015, Qualcomm « Adreno GPU on Mobile:
Best Practices », Vulkanised 2025 (Arm).

### 10.4 Ce que les recherches n'ont pas pu établir (reporté au banc)

Toute mesure de FSR1 sur Adreno ou Mali ; toute mesure indépendante de SGSR1 ; toute mesure
d'énergie d'un upscaler mobile ; les coûts par image de n'importe quel upscaler spatial sur
Radeon 780M, Arc 140V, Apple M1-M4, Mali-G7xx, Adreno 8xx ; le coût de `textureGather` sur Adreno
et Mali ; le producteur NV12 « lisible par WebGPU » de chaque OS (le prédicat de Chrome est lu, pas
les décodeurs) ; l'état réel de `toneMapping extended` et de `subgroups` dans un Safari 26 livré ;
la couverture pilote par pilote de `shader-f16` et `timestamp-query` sur Android ; le format 4:4:4
livré par VideoToolbox et MediaCodec à WebCodecs ; le comportement de Chrome quand le GPU du
décodeur n'est pas celui de l'adaptateur WebGPU.

---

## 11. Concrètement, pour l'utilisateur

Sur un **téléphone ou une tablette**, l'enhancer coché, l'image d'un flux agrandi (un hôte 1080p
sur un écran plus fin, ou le zoom à deux doigts) garde ses contours nets comme aujourd'hui avec
SGSR1, mais le GPU du téléphone travaille moins par image : moins de chauffe sur une longue
partie, un peu plus d'autonomie, et surtout moins de risque que l'échelle de qualité éteigne
l'enhancer parce qu'il ne tenait plus dans une image. Quand le téléphone **réduit** l'image (un
hôte 1440p sur un écran 1080p, le cas le plus courant en Auto), les lignes fines et le texte des
menus cessent de scintiller ou de moirer : c'est nouveau, aucun des enhancers actuels ne filtrait
la réduction. Au zoom à deux doigts, le passage d'un régime à l'autre ne se voit pas.

Sur un **ordinateur** en fenêtre ou avec un flux plus petit que l'écran, l'image agrandie est
aussi nette que FSR1 sur le jeu et l'interface, un peu moins peut-être sur du texte très dense (le
plan le mesure et le dira), pour nettement moins de travail GPU : sur un portable ou un iGPU qui
décode déjà en 1440p, c'est la différence entre un enhancer qui tient 60 images par seconde et un
qui en perd. En **plein écran à la résolution de l'hôte**, rien ne tourne plus du tout : l'image
est posée telle quelle, sans netteté ajoutée, et l'overlay le dit (« Off (1:1) ») ; si le réseau
force le flux à descendre d'un cran, l'agrandissement reprend à l'image suivante sans coupure.

En **HDR** (AV1, écran HDR), l'enhancer tourne en lumière de scène sans écrêter les reflets ni
griser les blancs, comme FSR1 aujourd'hui, pour moins cher ; le coût du décodage logiciel AV1,
lui, ne change pas, et le HDR en HEVC reste sans enhancer (c'est le navigateur qui le décide). En
**4:4:4** (bureau, code, tableurs), le texte coloré n'a plus de franges de couleur sur ses bords :
la chrominance est reconstruite avec la même finesse que la luminance.

Ce que l'utilisateur ne verra pas : la latence ne bouge pas de façon perceptible dans un sens ou
dans l'autre (le plan exige qu'elle ne régresse pas d'une milliseconde) ; sur un iPhone ou un Mac,
le gain d'énergie se mesure sur une heure de jeu, pas sur une partie. Ce que le chantier ne règle
pas : le surcoût de présentation de WebGPU en fenêtre sur le thread principal (le jumeau WebGL2 le
contourne, comme aujourd'hui), le décodage logiciel du HDR AV1, l'absence d'enhancer sur HDR HEVC
et sur les téléviseurs, et la netteté au-delà de ×2,5, qui reste douce comme avec tous les
upscalers spatiaux.

---

## 12. Reste à faire (liste de tâches) et prompt de lancement

### 12.1 Tâches, par phase (effort Opus 5.5 entre crochets)

**P0 — Labo et lignes de base** (joué la nuit du 19 au 20/10/2026 ; rapport `upscaler-mwsr-p0.md`)
- [x] Page de laboratoire : images dessinées par la page, boucle WebCodecs, cellules, horodatages par lots, relecture PNG, export JSON (`scripts/bench/scaler-lab/`, `4e249b3f`) ; sans compteur de quads ni amortissement (les horodatages ont marché partout)
- [~] Mires : texte coloré (`code`), zone-plate et traits fins (`zone`) faits ; rampe PQ en P3
- [x] Réduction hors ligne de la vérité terrain (Lanczos-3, lumière linéaire) par le pilote (`--quality`)
- [~] Chaîne Python : PSNR, SSIM, dépassements faits (`metrics.py`) ; FLIP attend une roue Python 3.14 ; SSIMULACRA 2, scintillement et défilement en P2 s'ils servent
- [~] Relevé `adapter.features` / `adapter.info` : DualRTX (RTX, 780M) fait ; téléphones et Mac aux créneaux de Bruno ; `mw-arm` sans WebGPU
- [x] Essai décisif externe contre blit + RGBA (N = 1, 5, 9, chargements, dérivées) : RTX et 780M
- [~] Lignes de base : DualRTX fait (l'Arc A380 n'est plus énumérée) ; `mw-arm` (WebGL2), Mac M1, iPhone 13 Pro, realme Note 60 à jouer ; Smooth2D (Canvas2D) non mesuré, hors WebGPU
- [x] Rapport P0 et porte : tenue pour l'ordinateur (dispersion ≤ 2,6 %, pas de passe 0 en SDR)

**P1 — Contournement 1:1** (code le 20/10/2026, commit `36edf6ec`)
- [x] Détection par image (`scaleRegime.js`, la règle de taille des deux renderers, partagée), copie directe (la passe 0 HDR existe dans ses deux cibles dès la création), gouverneur en pause (`passthrough` dans l'observation : les minuteries repartent de zéro), overlay « Off (1:1) », dans `WebGpuRenderer` et `WebGlRenderer`
- [x] Tests `vitest` : `scaleRegime.test.js` (ajustement, plafond, 1:1 exact contre presque-1:1), `EnhancerGovernor.test.js` (ni descente ni remontée sur une fenêtre de copies, horloge remise à la reprise)
- [x] Labo (`scaler_lab.py --p1`, le 20/10 sur SwiftShader puis RTX 5060 Ti, rapport `upscaler-mwsr-p1.md`) : chaîne du produit à 1:1 = 0,030-0,032 ms pour SGSR1, NIS et FSR1 comme pour `off` (avant P1 : 0,11 / 0,38 / 0,29), en lot comme à 60 i/s ; passage 1:1 ↔ ×2 à chaque image : 32 copies et 32 passages du noyau sur 64 draws, aucune image perdue, noyau à ×2 inchangé. **C7 tenue au labo** ; l'overlay reste à voir sur la `--dev`
- [ ] Mesure plein écran DualRTX : blit WebGPU, blit WebGL2, Canvas2D, au clic → photon [`high`]
- [ ] Décision de Bruno : blit, ou deux canvas (hors v0.4.1 sinon)

**P2 — Le noyau**
- [ ] P2.1 noyau de base WGSL sur `texture_2d` dans le labo : luma, vote, direction, cohérence, fenêtre, borne, netteté fusionnée ; première table de constantes [`max`]
- [ ] P2.2 boucle d'optimisation : variantes, mesures A/B/A/B, `malioc`, journal ; SweetOpt sur le chemin contour en fin de boucle [`xhigh`]
- [ ] P2.3 couches : feed externe, `HALF`, `QUAD_UNIFORM`, `DERING_EXACT`, `EARLY_OUT` [`high`]
- [ ] P2.4 expérience compute par tuiles sur Windows et macOS (optionnelle) [`high`]
- [ ] Rapport P2 et porte (C1-C4 provisoires ; critère d'arrêt) [`xhigh`]

**P3 — HDR, 4:4:4, réduction**
- [ ] `HDR_LINEAR` et son test (rampe, texte sur 1000 nits) [`high`]
- [ ] `CHROMA444` et son test [`medium`]
- [ ] Mode réduction (4 / 9 / 16 taps), `LINEAR_LIGHT` mesuré [`high`]
- [ ] Tests dorés (images fixes, deux échelles, par variante) [`medium`]

**P4 — Intégration et jumeau WebGL2**
- [ ] `mwsr` dans `WebGpuRenderer` : pipelines par `override`, deux modes, bind groups en cache, uniformes au changement [`medium`]
- [ ] `gl-mwsr` dans `WebGlRenderer` ; module de constantes partagées ; test de conformité [`medium`]
- [ ] `createRenderer`, `NO_WEBGPU_ALGOS`, `ENHANCER_LADDER` et migration de `mw_enhancer_rung`, `pickAutoEnhancer` derrière un drapeau [`medium`]
- [ ] Menu debug, i18n (en, fr, zh), overlay, worker (`algo`, `chroma444`) [`low`]
- [ ] Validation statique des shaders en CI ; job Playwright + WebGPU logiciel (non bloquant d'abord) [`medium`]
- [ ] Porte WebGPU contre WebGL2 avec le nouveau shader, par classe d'appareil [`high`]

**P5 — Campagne**
- [ ] Matrice du §7.3 (DualRTX complet ; étoile ailleurs) [`xhigh`]
- [ ] Énergie : `powermetrics` sur M1, décharge iPhone, occupation GPU `mw-arm` [`xhigh`]
- [ ] `/bench` avec `mwsr` ; clic → photon plein écran [`high`]
- [ ] A/B subjectif de Bruno (texte, bureau, jeu ; LAN et Internet ; HDR sur le M27Q)
- [ ] Rapport : objectif par objectif, démontré / attendu, non mesurables [`xhigh`]

**P6 — Défauts, documentation, release**
- [ ] Bascule de `auto` par classe d'appareil (ou non) ; `README.next.md` ; wiki ; notes de release ; mémoires [`medium`]

**Dépendances à demander tôt** : un téléphone Android de prêt (Snapdragon 8 Gen 1 ou plus, et
un Mali si possible) ; les créneaux Mac et iPhone pour P0 et P5 ; `malioc` installé sur DualRTX.

### 12.2 Prompt de lancement (à coller par Bruno dans une nouvelle session, après la v0.4.0)

> Plan v0.4.1 « shader d'upscaling MoonlightWeb » : `docs/design/upscaler-mwsr.md` (copie du plan
> remis le 10/10/2026). Dépôt `E:\Code\moonlight-web`, branche `main`, index privé (sessions
> parallèles), commits en anglais, formatage avant commit, push par Bruno.
>
> Décisions déjà prises (§0 du plan) : un algorithme en deux jumeaux (WGSL de référence, GLSL ES
> 3.00 à coût égal, accélérations WebGPU par `override`), pas de passe 0 en SDR si P0 le confirme,
> salle blanche (aucune ligne ni constante des ports FSR1/SGSR1/NIS/Atyuwen). Les trois ports
> existants ne bougent pas. Aucun changement côté hôte.
>
> Faits à ne pas redécouvrir : §1 (architecture : passe 0, trois feeds HDR, gouverneur, Auto 1440
> lignes sur mobile), §2.7 (coût de la texture externe : deux fetches par échantillon ; horodatages
> quantifiés à 100 µs sans le drapeau développeur ; `copyExternalImageToTexture` écarté ; f16
> probablement absent sur l'Adreno 618), §2.8 (les réécritures de compilateur ne rapportent rien ;
> le vérificateur hors de portée du générateur).
>
> Commencer par **P0** (effort `high`) : page de laboratoire, relevé des fonctionnalités, essai
> décisif « externe contre RGBA », lignes de base sur DualRTX (780M, Arc, RTX), puis `mw-arm`,
> Mac M1 et iPhone sur mes créneaux. Règles de banc : jamais « performances max », HAGS tel quel,
> encodeur et décodeur sur des GPU différents, onglet visible, Chrome de banc dédié par `cdp.py`,
> drapeau `enable-webgpu-developer-features` sur ce Chrome seulement. Pas de banc sur une machine
> sans mon accord ; le Mac est à Léo.
>
> À la porte P0 : rapport (dispersion, décision passe 0, lignes de base), paragraphe
> « Concrètement, pour l'utilisateur », proposition de `/compact`, et effort conseillé pour P1 et
> P2.1 (P2.1 = `max`). P1 peut être livré avant P2. Rien ne devient défaut avant P5.

---

## 13. Décisions du 19/10/2026 et mise à jour du parc (au lancement de P0)

Bruno a répondu le 19/10/2026 aux cinq questions posées au lancement ; le plan ci-dessus reste le
texte de référence, ce chapitre dit ce qui change.

| # | Question (§0, §9) | Décision | Conséquence dans le plan |
|---|---|---|---|
| D1 | Un algorithme, deux jumeaux | **Oui** | §3.6 tel quel |
| D2 | Pas de passe 0 en SDR | **Oui, si P0 le confirme** | §6.4 tel quel : l'essai « externe contre RGBA » reste la première mesure |
| D3 | Salle blanche | **Oui**, avec la consigne : « pense à utiliser les fonctions modernes des shaders ; on fera un fallback vers les shaders existants si ça ne le supporte pas » | la base de `mwsr` emploie les fonctions récentes du langage (§3.4 : dérivées, `override`, f16, sous-groupes, lecture directe de la texture externe) ; là où un navigateur n'offre pas ce qu'il faut, le client **garde les ports actuels** (FSR1, SGSR1, NIS, bilinéaire) comme repli, en plus de leur rôle de références de banc. Le jumeau GLSL (P4) reste prévu, mais il n'est plus la seule issue d'une plateforme sans WebGPU moderne : si P4 montre qu'il n'apporte rien par rapport à ce repli sur une classe d'appareil, Bruno pourra le réduire |
| D4 | Modèle de P2.1 | **Fable 5.1 `max`** (« j'ai pris un Max x20 »), exception à la règle « Opus 5.5 partout » pour ce seul chapitre | consigne attachée : dès que ce niveau n'est plus nécessaire, **faire une pause et demander un `/compact` et un changement d'effort et/ou de modèle** ; le reste des phases garde la colonne du §9 |
| D5 | Appareils mobiles | Bruno dispose d'un **iPhone 13 Pro** et d'un **realme Note 60** | voir ci-dessous |

**Le parc, corrigé.**

- **`mw-arm` n'a pas de WebGPU** : sur son Adreno 618, `navigator.gpu.requestAdapter()` rend `null`
  (relevé du banc du 06/09/2026, mémoire du dépôt). Le §1.8 et le critère C1 le comptaient comme
  banc WebGPU mobile : il ne sert qu'aux **lignes de base WebGL2** (`gl-sgsr`, `gl-fsr1`) et au
  jumeau GLSL (P4). Le mobile WebGPU se mesure sur les deux appareils de Bruno.
- **iPhone 13 Pro** : A15, écran 2532×1170 à 120 Hz, Safari 26 (WebGPU, `shader-f16`, texture externe
  sans copie ; `timestamp-query` si le compteur est exposé). C'est presque la configuration de l'article
  d'Atyuwen (iPhone 12, A14, même sortie 2532×1170) : ses chiffres (EASU 5,4 → 1,8 ms) deviennent
  **vérifiables au banc**, dans un navigateur au lieu d'un moteur natif.
- **realme Note 60** : Unisoc T612 (12 nm, 2 × A75 + 6 × A55 à 1,8 GHz), **Mali-G57 MP1**, écran IPS
  720×1600 à 90 Hz, Android 14. Premier **Mali** et premier **Android** du parc, et un GPU d'entrée de
  gamme : le cas le plus dur pour « plus rapide que SGSR1 sur mobile », et le plus parlant pour
  l'énergie. Chrome Android y tourne sur Vulkan si le pilote le permet (Chrome 121+), sinon en
  **mode compatibilité** OpenGL ES 3.1 (Chrome 146+) : P0 relève `adapter.info`, `adapter.features`
  (`shader-f16` est attendu sur Mali-G57, `timestamp-query` incertain) et le mode. Avec le câble USB
  et le débogage activé, `adb shell dumpsys batterystats` et `/sys/class/power_supply/battery/
  current_now` donnent une **mesure d'énergie** que le plan disait impossible (§0 : « non démontrable
  sans banc ») : elle devient possible, bruitée, en différences A/B sur des cellules longues (§7.2).
  Sur cet écran de 720 lignes le cas d'usage est la **réduction** (flux Auto jusqu'à 1440 lignes,
  §1.6) et l'agrandissement du zoom à deux doigts : les deux régimes y sont mesurés.
- **Arc A380** : absente de la liste des adaptateurs de DualRTX le 19/10 au soir (seuls le RTX 5060 Ti,
  le Radeon 780M et les écrans virtuels y figurent) ; Bruno a confirmé le 20/10 qu'il a dû la
  **débrancher**, sa compatibilité sera vérifiée plus tard. Le §1.8 la comptait comme troisième GPU
  d'ordinateur ; sans elle, les classes d'ordinateur restent NVIDIA (RTX), AMD (780M, deux machines),
  Intel (N95) et Apple (M1) ; la classe Intel Arc attend son retour.

**Ce que cela change aux critères.** C1 et C6 se lisent désormais « iPhone 13 Pro, realme Note 60,
et `mw-arm` en WebGL2 seulement » ; la mention « démontré sur Adreno 618 et Apple, extrapolé ailleurs »
(§8.1) devient « démontré sur Apple A15 et Mali-G57, extrapolé aux Adreno 7xx/8xx et aux Mali G7xx ».
Les créneaux des deux téléphones sont ceux de Bruno (P0 pour le relevé des fonctionnalités et les
lignes de base, P5 pour la campagne) ; la page de laboratoire (§6.1) tourne dans leur navigateur
depuis le serveur du labo sur le LAN.

**Départ.** P0 a commencé la nuit du 19 au 20/10/2026 : ce plan copié dans `docs/design/`, la page de
laboratoire `scripts/bench/scaler-lab/`, les lignes de base sur DualRTX (SwiftShader d'abord, puis le
780M et le RTX), le rapport P0 dans `docs/design/upscaler-mwsr-p0.md`.
