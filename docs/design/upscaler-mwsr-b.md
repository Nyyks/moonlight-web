# Upscaler `mwsr` — B : entrées YUV (NV12, P010), plans Y et UV, affûtage

Demandes de Bruno du 29/10/2026, relayées par la session de gestion des plans, et son go du même jour
(« continue avec les fix du comparateur et enchaîne sur B »). Règles : un shader neuf passe d'abord sur
SwiftShader et WARP ; **aucun banc sur un GPU réel avant le feu vert de la gestion des plans** ; jamais
l'encodeur et le décodeur sur le même GPU ; rien d'activé dans le produit sans le oui de Bruno.
Plan d'ensemble : `upscaler-mwsr.md`. Labo : `scripts/bench/scaler-lab/`.

## 1. Les demandes

1. **Entrées NV12 et 10 bits (P010)**, sur le modèle de `vt_metal.mm` (moonlight-qt de Bruno) : le plan
   Y en R8 ou R16, le plan UV en RG8 ou RG16, Y agrandi par MetalFX, UV par un bilinéaire (MPS), puis
   la conversion YUV → RGB au dessin final. Mots de Bruno : « C'est peut-être encore plus rapide si on
   upscale sur UV en bilinear et Y en MWSR. »
2. **Le shader travaille au choix sur Y et UV, sur Y seul ou sur UV seul.** « Le but n'est pas de rajouter
   des couches au shader actuel, mais que son pipeline soit optimisé pour supporter ces formats
   directement sans convertir inutilement. »
3. **Un banc dans MoonlightWeb** (pas sur le comparateur), avec la technique du navigateur, en 4:2:0 et
   en 4:4:4, sur les variantes du §3.
4. **Une sortie en RGB (sRGB) ou en YUV** selon un paramètre, RGB par défaut ; expliquer le sRGB (§4).
5. **L'affûtage** : « MWSR semble travailler un peu trop sur le sharpening, ce qui semble lui faire perdre
   quelques points en fidélité. » Des variantes à ×1,33 et ×2, en RGB, pour la meilleure fidélité (§5).

## 2. Ce que le navigateur donne (§2.7 du plan, et le renderer)

- **Chrome ne donne jamais les plans.** Une NV12 matérielle SDR est importée sans copie, mais seulement
  comme `texture_external` : chaque lecture va chercher Y et UV et applique la matrice. On ne peut lire
  ni le plan Y seul ni le plan UV seul.
- **Le 10 bits n'arrive pas en 10 bits.** P010, I420 logiciel, 4:2:2 et 4:4:4 passent par une copie RGBA
  8 bits que Chrome fait avant notre shader. Safari lie deux textures Metal sans copie, mais l'API WebGPU
  les cache de la même façon.
- **Les plans bruts ne s'obtiennent que par `VideoFrame.copyTo`**, une relecture vers la mémoire du
  processeur. Le chemin HDR du renderer le fait déjà, pour les décodeurs logiciels 10 bits, puis sa
  passe YUV recompose le RGB.
- **Donc, dans le navigateur, la passe 0 d'aujourd'hui est déjà la conversion minimale.** Elle lit la
  texture externe une fois par texel et écrit du RGBA 8 bits. Sans elle, MWSR lirait la texture externe
  à chacune de ses 5 à 10 prises : deux plans et une matrice par prise. P0 et P2 l'ont mesuré perdant
  sur tous les GPU.
- **Ce qui reste à gagner dans le navigateur :**
  - une passe 0 qui écrit Y (R8) et UV (RG8 en demi-résolution) au lieu du RGBA : 1,5 octet par pixel
    au lieu de 4 ;
  - un MWSR qui calcule sur Y seul : un canal au lieu de trois dans le chemin des bords ;
  - en HDR, la passe YUV de la relecture fondue dans MWSR, ce qui évite une texture `rgba16float`
    pleine résolution (8 octets par pixel, écrits puis relus).
- **Le gain complet, les plans lus tels quels et aucune conversion, n'existe que dans un renderer
  natif.** Par exemple `vt_metal.mm` ou un renderer D3D11 sur NV12 et P010 (vues R8/R8G8 et
  R16/R16G16). C'est le dossier `mwsr/` (HLSL, GLSL, C++) qui le porte. Son exemple D3D11 se teste
  sur WARP.

## 3. Les variantes

Un seul module (`MwsrShader.js`), d'où sortent WGSL, GLSL et HLSL comme aujourd'hui. Trois paramètres
de construction, pas une couche de plus :
- `INPUT` : `rgb` (aujourd'hui), `yuv` (deux textures, Y et UV : NV12, P010, NV24) ;
- `PLANES` : `yuv` (MWSR sur Y et sur UV), `y` (MWSR sur Y, UV au bilinéaire), `uv` (MWSR sur UV, Y au
  bilinéaire) ;
- `OUTPUT` : `rgb` (défaut), `yuv`.

| # | Variante | Demande de Bruno | Passes |
|---|---|---|---|
| V0 | Conversion RGB par le navigateur (passe 0 → RGBA), puis MWSR RGB : **la référence**, le produit d'aujourd'hui | « conversion RGB matérielle, puis MWSR » | 2 |
| V1 | Y en MWSR et UV au bilinéaire du sampler, chacun dans sa texture de sortie, puis composés en RGB : le modèle de `vt_metal.mm` | « UV bilinéaire matériel et Y en MWSR en parallèle » | 3 |
| V2 | Y en MWSR et UV au bilinéaire dans le même shader, sortie RGB | « UV bilinéaire et Y en MWSR dans le shader » | 1 (+ passe 0) |
| V3 | Y et UV en MWSR, les poids tirés de Y et appliqués à UV, sortie RGB | « UV et Y en MWSR » | 1 (+ passe 0) |
| V4 | Y et UV convertis en RGB dans MWSR, à chaque prise | « Y et UV convertis en RGB dans MWSR » | 1 (+ passe 0) |
| V5 | MWSR lit la texture externe, sans passe 0 (perdant en P0 et P2 : le témoin) | — | 1 |
| V6 | La chroma 4:2:0 refaite d'après les bords de Y (« chroma from luma »), même à ×1 | autre idée | 1 (+ passe 0) |
| V7 | HDR : la passe YUV de la relecture fondue dans MWSR (plans 10 bits lus par MWSR) | autre idée | 1 |

- En RGB, MWSR applique à R, G et B des poids tirés de la luma. Le même mélange appliqué à Y, U et V
  donne la même image, à la borne des texels près. V3 doit donc rendre V0 à 1/255 près : c'est son
  test sur SwiftShader.
- V2 laisse la couleur au bilinéaire ; c'est ce que fait `vt_metal.mm`, et la fidélité dira ce qu'on
  y perd.
- La passe 0 de V1 à V4 et de V6 : sur le navigateur, une passe « Y + UV » depuis la texture externe.
  Dans un renderer natif, rien : les plans du décodeur.
- 4:4:4 : UV en pleine résolution (NV24). V6 n'y sert à rien.
- 10 bits : plans en `r16float`/`rg16float` (filtrables partout), ou `r16unorm` là où l'adaptateur a
  la fonctionnalité.
- Le placement de la chroma : celui de Chrome (centré) partout, pour comparer à l'identique.

## 4. Le sRGB, en clair

- L'écran et le canvas attendent du RGB **encodé** : la courbe sRGB donne plus de valeurs aux sombres,
  là où l'œil distingue le mieux. Une vidéo décodée, une fois la matrice YUV → RGB appliquée, donne
  déjà du RGB encodé par une courbe presque identique (BT.709). **La sortie RGB n'a donc besoin
  d'aucune conversion sRGB** : la matrice suffit.
- Il faut repasser en **lumière linéaire** (décoder le sRGB, calculer, réencoder) seulement pour
  **moyenner** des pixels : une réduction. Une moyenne de valeurs encodées assombrit les détails
  clairs, par exemple un texte blanc fin sur noir. MWSR le fait déjà, gratuitement, par les vues
  `-srgb` des textures (P3).
- Pour **agrandir**, travailler sur les valeurs encodées est la règle : FSR1 en mode perceptuel,
  MetalFX « Perceptual » dans `vt_metal.mm`. C'est aussi moins cher.
- **Verdict** : sortie RGB par défaut, sans étape sRGB de plus. La sortie YUV ne sert qu'à un renderer
  natif qui convertit lui-même au dessin final (le `ps_draw_biplanar` de `vt_metal.mm`), jamais au
  canvas du navigateur.

## 5. L'affûtage (×1,33 et ×2, RGB)

- Aujourd'hui, la netteté vaut 1,85 à ×1,33 (l'œil de Bruno sur l'iPhone, J37), et la loi garde ce
  poids jusqu'à ×2 (J40). Le chemin plat ajoute un Catmull-Rom (`FLAT_C` 0,5), qui affûte aussi un peu.
- Les chiffres du README ne disent pas « trop » d'avance :
  - à ×2, NIS et SGSR1, plus affûtés, battent MWSR sur le texte (87,6 contre 86,1) ;
  - à ×1,33, FSR1 le bat sur le jeu (87,5 contre 85,9) ;
  - mais MWSR est premier sur le texte à ×1,33 (96,0).
  - Le balayage teste donc dans les deux sens.
- **Le balayage**, sur le texte et sur 0 A.D. du comparateur, à 1080p → 1440p et à 720p → 1440p :
  - la netteté de 0 à 2,5 ;
  - `W_ALONG` (le lissage le long du bord) 0, 0,15 et 0,3 ;
  - `FLAT_C` 0,33, 0,5 et 0,75.
  - Mesures : SSIM de la luma et des couleurs, FLIP, dépassement.
- **SwiftShader suffit** : la fidélité ne dépend pas du GPU, à 1/255 près. Ce banc peut donc tourner
  avant le feu vert.
- Résultat : une courbe par image et par échelle, et une recommandation. L'œil de Bruno tranche,
  puisque c'est lui qui a fixé 1,85.

## 6. Le banc

- **Où** : `scripts/bench/scaler-lab/`, la page qui fabrique de vraies NV12 de décodeur par WebCodecs.
  On y ajoute des cellules `mwsr-yuv:…`, avec les mêmes options que `mwsr:…`.
- **Les plans** :
  - pour le noyau seul, Y et UV fabriqués depuis l'image de test, en BT.709 à plage limitée, 8 et 10
    bits, 4:2:0 et 4:4:4 ;
  - pour la chaîne, la passe « Y + UV » depuis la texture externe, et `copyTo` pour le 10 bits.
- **L'encodeur** : le clip est encodé d'avance, par x264 en logiciel, et seulement décodé dans la page.
  Encodeur et décodeur ne sont donc jamais sur le même GPU.
- **Étape 1, maintenant (SwiftShader, puis WARP pour le HLSL)** :
  - chaque variante compile et dessine ;
  - V3 rend V0 à 1/255 près ;
  - la fidélité de chaque variante, sur les images du comparateur et de l'étalon ;
  - l'exemple D3D11 lit une NV12 sur WARP.
- **Étape 2, au feu vert** :
  - le temps GPU de chaque variante : horodatages par lots, comme en P0, chaîne et noyau seul ;
  - à 1080p → 1440p, 720p → 1440p et 1440p → 1440p (V6) ;
  - sur le RTX 5060 Ti, le 780M, puis les téléphones aux créneaux de Bruno.
- **Le verdict** : une variante ne passe que si elle garde la fidélité de V0 (ou la dépasse) et coûte
  moins. L'intégrer au produit attend le oui de Bruno.

## 7. L'ordre

1. Le balayage de l'affûtage sur SwiftShader, et ses courbes à Bruno.
2. Dans `MwsrShader.js` : `INPUT`, `PLANES` et `OUTPUT`, en WGSL d'abord ; puis les cellules du labo ;
   puis la validation sur SwiftShader ; puis la génération HLSL et l'exemple D3D11 sur WARP.
3. Au feu vert : les temps GPU.
4. Le verdict à Bruno, puis l'intégration s'il dit oui.
