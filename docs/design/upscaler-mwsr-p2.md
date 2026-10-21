# Upscaler `mwsr` — rapport de la phase P2 (le noyau)

> Phase P2 du plan `upscaler-mwsr.md` (§3, §6, §9). Ce rapport suit les sous-phases : **P2.1**, le
> noyau de base et sa première table (21/10/2026, Fable 5.1 `max` par décision D4), puis P2.2 (la
> boucle), P2.3 (les couches), P2.4 (l'expérience compute). Le détail des essais est dans
> `scripts/bench/scaler-lab/journal.md` (J1 à J4) ; ici, ce qui en sort.

## 1. P2.1 — le noyau de base et sa première table

### 1.1 Le texte (`frontend/js/stream/renderers/MwsrShader.js`, commits `fa42a66c`, `8e9a5903`)

Une source WGSL, spécialisée par constantes `override`, le feed substitué dans le préambule
(`texture_2d<f32>` : chemins HDR et labo ; `texture_external` : SDR sans passe 0). Le vertex est le
triangle plein écran habituel ; le fragment, par pixel de sortie :

1. **Un échantillon bilinéaire** `C` à la position du pixel dans l'entrée, sa luma
   (`0,25 R + 0,625 G + 0,125 B`, Rec. 709 arrondie aux puissances de deux).
2. **Le vote** : les dérivées d'écran grossières de cette luma (`dpdxCoarse`, `dpdyCoarse`), ramenées
   en luma par texel d'entrée (× l'échelle), comparées à `τ` ; le quad entier prend la même branche.
   Un quad plat retourne `C` : une passe, un échantillon, une dizaine d'opérations. Les dérivées
   sont prises avant la branche, en flot de contrôle uniforme, comme WGSL l'exige ; après elle, les
   échantillons sont à niveau explicite (`textureSampleLevel`, `textureSampleBaseClampToEdge`).
3. **Sur un contour**, quatre échantillons bilinéaires de plus, dans le repère que donnent les
   dérivées (`ORIENT 1` ; `ORIENT 0` = la croix sur les axes, gardée pour le labo) : deux **le long**
   du contour à `R_ALONG` texels (poids `W_ALONG · a`, un lissage), deux **en travers** à `R_ACROSS`
   texels (poids `−W_ACROSS · netteté · a`, borné à `W_MIN` : une accentuation). `a` est la
   **cohérence** : `max(marche, crête) / variation` où marche = `|X2 − X1|`, crête =
   `|X1 + X2 − 2C|`, variation = la somme des quatre écarts de luma à `C` ; 1 sur un contour ou un
   trait net, vers 0 sur une texture, un grain ou un bloc de compression. Multipliée par la force
   (0 à 1:1, 1 dès `S_FULL`), de sorte que le noyau tend vers le bilinéaire quand le
   contournement 1:1 (P1) prend le relais.
4. **La borne.** Le mélange est borné par le min et le max des cinq échantillons, puis, `DERING 1`,
   par les **quatre texels d'entrée autour du pixel** (quatre `textureLoad` sur les quads de contour
   seulement) : l'empreinte exacte du bilinéaire, donc aucun pixel hors de sa plage locale.

Ce que le texte ne fait pas (plan §3.4) : pas de `textureGather`, pas de `discard`, pas de boucle,
pas d'indexation dynamique, pas de lecture dépendante du contenu (les positions viennent de `p` et
des dérivées). Le fichier porte les idées empruntées et leur source (taps bilinéaires, sortie
anticipée sur un vote, borne locale, netteté tenue par la plage), et le test
(`frontend/test/MwsrShader.test.js`) vérifie qu'aucune constante des noyaux voisins n'y entre.

### 1.2 La méthode

Qualité sur SwiftShader (mêmes pixels que le RTX au centième de dB, P0 §4 bis), par `--quality`
et `--quality-cells` : chaque variante est une cellule `mwsr:clé=valeur;…`, rendue sur la même entrée
(vérité réduite en Lanczos-3 linéaire) et mesurée contre la vérité (PSNR, SSIM, dépassements hors de
l'empreinte 2×2 ; FLIP attend une roue Python 3.14). Cinq images à ×2 (720p → 1440p) : `text`,
`code`, `game`, `zone`, l'étalon de Bruno ; deux à ×1,33 (1080p → 1440p) : l'étalon et `text`.
Quatre tours (J1 à J4, journal) : le noyau tel qu'écrit, le balayage des poids, le dosage et la
borne exacte, une courbe bornée sur les marches (rejetée). Temps GPU sur le RTX 5060 Ti ensuite
(§1.4).

### 1.3 La table, et la qualité contre les références

**Première table** : `ORIENT 1`, `W_ALONG 0,15`, `R_ALONG 0,5`, `W_ACROSS 0,35`, `R_ACROSS 1`,
`W_MIN −0,3`, `DERING 1`, `S_FULL 1,5`, `τ 0,05`, netteté 1.

Ce que les quatre tours ont appris :

- le **lissage le long du contour à ±1 texel coûte partout** (−0,5 dB sur `text`, −0,9 dB au centre
  de l'étalon) : à ×2 les glyphes de 12 px n'ont que des courbes et des extrémités ; à un
  **demi-texel**, il rend +0,4 dB au centre de l'étalon et divise les dépassements par deux ;
- ce qui paie est l'**accentuation directionnelle en travers** de la rampe bilinéaire : le texte en
  voudrait plus (`W_MIN −0,4` : +0,25 dB sur `text` droit avec les axes), les photos moins
  (−1,6 dB au centre de l'étalon à cette force) ; `W_ACROSS 0,35` borné à `−0,3` est le milieu, et la
  netteté (uniforme) déplace le point sans recompiler ;
- la **borne exacte 2×2** met les dépassements à **0 % sur toutes les images** sans bouger PSNR ni
  SSIM d'un centième : le critère C3 « dépassements ≤ FSR1 » est acquis par construction ;
- le repère des dérivées bat les axes sur du contenu naturel (+0,5 dB sur l'étalon à force égale)
  et perd 0,25 dB sur du texte droit : il reste la base ;
- `τ` entre 0,02 et 0,08, `R_ACROSS` < 1, la courbe bornée (`SHAPE`) : rien à gagner.

| image | bilinéaire | SGSR1 (dépôt) | FSR1 | **mwsr, table** |
|---|---|---|---|---|
| `text` ×2 | 16,99 / 0,816 / 0 % | 18,13 / 0,869 / 4,4 % | 17,57 / 0,845 / 0,3 % | **17,42 / 0,842 / 0 %** |
| `code` ×2 | 29,98 / 0,977 / 0 % | 29,65 / 0,974 / 2,6 % | 30,36 / 0,975 / 0,7 % | **29,89 / 0,978 / 0 %** |
| `game` ×2 | 35,01 / 0,880 / 0 % | 35,61 / 0,883 / 0,7 % | 35,55 / 0,887 / 0,03 % | **35,87 / 0,882 / 0 %** |
| `zone` ×2 | 10,41 / 0,423 / 0 % | 10,80 / 0,491 / 0 % | 10,79 / 0,484 / 3,4 % | **10,65 / 0,459 / 0 %** |
| étalon ×2, tiers central | 31,56 / 0,928 | 31,28 / 0,930 (6,8 %) | 32,26 / 0,940 (2,0 %) | **31,82 / 0,933 (0 %)** |
| étalon ×1,33, tiers central | 36,36 / 0,977 | 34,55 / 0,970 (5,0 %) | 35,94 / 0,976 (5,0 %) | **36,55 / 0,978 (0 %)** |
| `text` ×1,33 | 20,52 / 0,923 / 0 % | 21,64 / 0,946 / 2,7 % | 21,45 / 0,942 / 0,2 % | **21,60 / 0,944 / 0 %** |

PSNR / SSIM / dépassements (entre parenthèses : dépassements de l'image entière). Lecture contre
le critère C3 (« FLIP ≤ FSR1 + 0,01, SSIM ≥ FSR1 − 0,005, dépassements ≤ FSR1 ») :

- **à ×1,33, `mwsr` est au-dessus de FSR1** partout (+0,6 dB au centre de l'étalon, +0,15 dB sur le
  texte, SSIM +0,002), là où RCAS, réglé pour ×2, sort 5 % des pixels de leur plage ;
- **à ×2, `mwsr` vaut FSR1 à 0,15-0,45 dB près** en PSNR (au-dessus sur `game`, +0,32 dB), et en SSIM
  dans −0,007…+0,003 : l'étalon (−0,007) et `game` (−0,005) sont au bord du critère, le texte
  (−0,003) et `code` (+0,003) dedans. Ce qui manque à ×2 est de la **reconstruction** (EASU
  interpole douze texels dans une fenêtre tournée ; un masque flou directionnel n'en fait pas), pas de
  la netteté ni de la propreté : c'est la question de P2.2 et de `TIER` qualité (quatre diagonales) ;
- **les dépassements sont à 0 %** sur toutes les images, contre 0,03-5 % pour FSR1 et 0,7-6,8 % pour
  SGSR1 : sur les serifs et les contours de l'étalon, aucune sonnerie, par construction ;
- SGSR1 garde le meilleur PSNR sur le texte brut (18,13) en payant 4,4 % de dépassements, et passe
  sous le bilinéaire sur l'étalon : la règle de P0 tient (FSR1 est la référence à égaler, SGSR1 celle
  à battre sur la sonnerie, et `mwsr` la bat).

### 1.4 Le temps GPU (RTX 5060 Ti, `scaler_lab.py --p2`)

Passe du 21/10 au matin (Chrome 155 sans tête, `--enable-webgpu-developer-features`, adaptateur
épinglé, 3 tours entrelacés × 8 lots de 16 itérations, dispersion ≤ 1,8 % sauf FSR1 sur `game`
10 %). Temps GPU p50 en ms d'une passe vers 2560×1440 ; `tex-*` = noyau seul sur `rgba8` ; `ext-*`
= la chaîne telle qu'elle serait livrée en SDR, sans passe 0, sur la texture externe NV12 du
décodeur ; FSR1 = EASU → intermédiaire → RCAS (deux passes, sans sa passe 0 : +0,01 ms).

| cellule | `text` ×2 | `ui` ×2 | `game` ×2 | `text` ×1,33 | `game` ×1,33 |
|---|---|---|---|---|---|
| `tex-s1` (le plancher : une passe, un bilinéaire) | 0,028 | 0,028 | 0,028 | 0,028 | 0,028 |
| `tex-s5` / `tex-s9` (5 / 9 bilinéaires partout) | 0,047 / 0,085 | 0,047 / 0,085 | 0,047 / 0,085 | 0,047 / 0,085 | 0,047 / 0,085 |
| **`mwsr`** (la table, `DERING 1`) | **0,051** | **0,029** | **0,028** | **0,046** | **0,036** |
| `mwsr:dering=0` | 0,039 | 0,028 | 0,028 | 0,036 | 0,031 |
| `mwsr:early=0` (sans la sortie anticipée) | 0,086 | 0,085 | 0,086 | 0,086 | 0,085 |
| `mwsr:orient=0` (la croix sur les axes) | 0,052 | 0,029 | 0,028 | 0,046 | 0,037 |
| `ext-s1` / `ext-s5` | 0,028 / 0,057 | 0,028 / 0,057 | 0,028 / 0,057 | 0,030 / 0,066 | 0,029 / 0,060 |
| **`ext-mwsr`** (la chaîne SDR sans passe 0) | **0,096** | **0,048** | **0,043** | **0,088** | **0,067** |
| `ext-mwsr:dering=0` | 0,065 | 0,036 | 0,033 | 0,062 | 0,048 |
| `sgsr-repo` (noyau seul) | 0,073 | 0,039 | 0,066 | 0,066 | 0,065 |
| `fsr1` (EASU + RCAS) | 0,247 | 0,246 | 0,246 | 0,247 | 0,246 |
| `nis` | 0,441 | 0,310 | 0,421 | 0,510 | 0,551 |

**Lecture.**

1. **Le noyau est au plancher hors du texte** : 0,028-0,029 ms sur `game` et `ui`, le prix d'une
   passe à un bilinéaire. Le grain de `game`, qui déclenche le vote de SGSR1 partout (0,066), passe
   sous `τ` (0,05 de luma par texel) : la sortie anticipée fait son travail. Sur `text` (environ
   quatre quads sur dix sur le chemin contour, à lire par la règle de trois entre `tex-s1` et
   `tex-s9`), 0,051 ms.
2. **Contre les références, noyau seul** : SGSR1 × 0,42-0,74 (C1 « ≤ 0,9 » tenu ici ; le mobile
   dira), FSR1 × 0,11-0,21, NIS × 0,06-0,12. **Chaîne SDR** : `ext-mwsr` 0,043-0,096 ms contre
   ≈ 0,26 pour passe 0 + FSR1 et ≈ 0,09 pour passe 0 + SGSR1 (P0) : C2 « ≤ 0,6 × FSR1 » tenu avec
   marge (× 0,17-0,37).
3. **La sortie anticipée vaut 40-67 % sur ce GPU** : sans elle, 0,086 partout, le coût de neuf
   fetches par pixel (`tex-s9`). Le conseil d'Apple (« souvent il faut juste essayer ») est à
   remesurer sur l'A15 ; sur NVIDIA la branche gagne.
4. **La borne exacte coûte 0,01 ms sur le texte** (quatre `textureLoad` sur les quads de contour),
   rien ailleurs ; sur la **texture externe** elle coûte 0,03 ms (`textureLoad` externe = deux plans
   et une conversion par texel, comme P0 l'a vu) : P2.3 la fera par quatre échantillons au plus
   proche sur ce feed, ou la réservera au `TIER` qualité.
5. **La texture externe** ajoute 0,01-0,045 ms au noyau selon la part de contours (deux fetches par
   échantillon) ; c'est le prix de l'absence de passe 0, qui en économise 0,01-0,45 selon le GPU
   (P0) : la décision n° 2 tient sur le RTX ; le 780M et les téléphones la rejugent en P2.3.
6. Les axes (`ORIENT 0`) coûtent la même chose que le repère des dérivées : le choix s'est fait sur
   la qualité seule (§1.3).

### 1.5 Ce que P2.1 laisse à P2.2 et P2.3

- **P2.2** : la reconstruction à ×2 (SSIM) — `TIER` qualité avec les quatre diagonales et une
  fenêtre tournée sur neuf échantillons, le poids de la luma dans la borne, FLIP dès qu'il tourne ;
  la part des quads de contour par image (`SHOW 1` et un comptage hors ligne) ; `malioc` sur le GLSL
  du jumeau ; les constantes de l'échelle (`S_FULL`) sur ×1,5 et ×3.
- **P2.3** : le feed externe (`ext-mwsr`) et le coût de `DERING 1` par `textureLoad` sur une texture
  externe (P0 : plus cher que l'échantillon sur AMD et Apple → variante par échantillons au plus
  proche), `HALF`, `QUAD_UNIFORM`, `EARLY_OUT 0` contre 1 par classe de GPU.
- À nettoyer en fin de P2.2 : `SHAPE`/`K_SHAPE` (rejetés, J4) et `ORIENT 0` si rien ne les rappelle.
