# Journal du noyau `mwsr` (plan `docs/design/upscaler-mwsr.md`, §6.3)

Chaque entrée : hypothèse, mesure, verdict. Les temps viennent des horodatages GPU du labo
(`scaler_lab.py`), la qualité de `--quality` (PSNR, SSIM, dépassements contre la vérité terrain
rendue à la taille de sortie, entrée réduite en Lanczos-3 linéaire ; FLIP dès qu'une roue
Python 3.14 existe). SwiftShader donne les mêmes pixels que le RTX au centième de dB (P0 §4 bis) :
la qualité se mesure sur SwiftShader au fil de l'eau, les temps sur le RTX à la demande de la
session d'orchestration. Règle de salle blanche (§10.2) : les constantes ci-dessous sont les
nôtres, produites par ce journal.

## 2026-10-21 — J1, le noyau de base tel qu'écrit (`MwsrShader.js`, P2.1)

**Le texte.** Une passe, feed `texture_2d` d'abord. Cinq échantillons bilinéaires : le centre C,
puis, sur les quads que les dérivées d'écran de la luma désignent comme contour
(`|dpdx| · s_x + |dpdy| · s_y ≥ τ`, luma par texel d'entrée), deux échantillons **le long** du
contour (poids `W_ALONG · a`, lissage) et deux **en travers** (poids `−W_ACROSS · netteté · a`,
accentuation), tous à `R_ALONG` / `R_ACROSS` texels, dans le repère donné par les dérivées
(`ORIENT 1`) ou sur les axes (`ORIENT 0`, repère tiré des échantillons). `a` = cohérence =
`max(marche, crête) / variation` ∈ [0, 1] (marche `|X2 − X1|`, crête `|X1 + X2 − 2C|`, variation =
somme des quatre écarts à C), × `strength` (0 à 1:1, 1 dès `S_FULL`). Résultat borné par le min
et le max des cinq. Luma `(0,25, 0,625, 0,125)`.

**Première table** (J1) : `ORIENT 1`, `W_ALONG 0,35`, `W_ACROSS 0,2`, `R_ALONG 1`, `R_ACROSS 1`,
`S_FULL 1,5`, `W_MIN −0,24`, `τ 0,05`, netteté 1.

**Hypothèse H1.** À ×2, ce noyau se place entre le bilinéaire et FSR1 en PSNR/SSIM sur le texte,
sans dépassement.

**Mesure** (SwiftShader, `--quality`, 720p → 1440p, PSNR / SSIM / dépassement) :

| image | bilinéaire | SGSR1 (dépôt) | FSR1 | **mwsr J1** |
|---|---|---|---|---|
| `text` | 16,99 / 0,816 / 0 % | 18,13 / 0,869 / 4,4 % | 17,57 / 0,845 / 0,3 % | **16,85 / 0,816 / 0,7 %** |
| `code` | 29,98 / 0,977 / 0 % | 29,65 / 0,974 / 2,6 % | 30,36 / 0,975 / 0,7 % | **29,79 / 0,977 / 0,2 %** |
| `game` | 35,01 / 0,880 / 0 % | 35,61 / 0,883 / 0,7 % | 35,55 / 0,887 / 0,03 % | **35,45 / 0,881 / 0,01 %** |

**Verdict H1 : non tenue sur le texte.** J1 est au niveau du bilinéaire (−0,14 dB sur `text`,
+0,44 dB sur `game`), loin de FSR1. Lecture : avec des échantillons à ±1 texel sur une rampe
bilinéaire d'un texel, la paire en travers encadre la rampe entière et son masque flou ne redresse
la rampe que d'un facteur `(1 + 2·W_ALONG) / (1 + 2·W_ALONG + 2·W_ACROSS)` ≈ 1,3 ; la paire le long
dilue l'accentuation et lisse les glyphes de 12 px, dont tout est courbe ou extrémité. Les
constantes de J1 sont trop timides en travers et trop larges le long.

**Suite (J2)** : balayage `W_ALONG ∈ {0 ; 0,15}`, `W_ACROSS ∈ {0,2 ; 0,4}`, `W_MIN` jusqu'à −0,4,
`R_ACROSS ∈ {0,6 ; 1}`, `τ 0,02`, `ORIENT 0` contre `1`, sur `text`, `code`, `game`, `zone` et
l'étalon de Bruno à ×2 et ×1,33.

## 2026-10-21 — J2, le balayage des poids (SwiftShader, `--quality-cells`, ×2)

**Hypothèses.** H2a : sans lissage le long (`W_ALONG 0`), le texte remonte. H2b : plus
d'accentuation en travers (`W_ACROSS 0,4`, `W_MIN −0,4`) rapproche de FSR1 sur le texte. H2c :
les axes (`ORIENT 0`) valent le repère des dérivées sur du texte droit. H2d : `τ 0,02` change peu.

| variante (ORIENT 1 sauf dit) | `text` | étalon, tiers central | `game` |
|---|---|---|---|
| bilinéaire | 16,99 / 0,816 / 0 % | 31,56 / 0,928 | 35,01 / 0,880 / 0 % |
| FSR1 | 17,57 / 0,845 / 0,3 % | 32,26 / 0,940 (2,0 % entier) | 35,55 / 0,887 / 0,03 % |
| J1 (`W_ALONG 0,35`) | 16,85 / 0,816 / 0,7 % | 31,21 / 0,925 | 35,45 / 0,881 / 0,01 % |
| `W_ALONG 0` | 17,33 / 0,837 / 0,6 % | **32,09 / 0,935** | 35,73 / 0,881 / 0,01 % |
| `W_ALONG 0`, `W_ACROSS 0,4` | 17,37 / 0,841 / 1,2 % | 31,67 / 0,932 | **35,86** / 0,882 / 0,03 % |
| … + `W_MIN −0,4` | 17,38 / 0,843 / 1,7 % | 30,48 / 0,922 (3,0 %) | 35,33 / 0,881 / 0,14 % |
| `W_ALONG 0,15`, `W_ACROSS 0,4`, `W_MIN −0,4` | 17,20 / 0,834 / 1,3 % | 31,11 / 0,927 | 35,79 / 0,882 |
| `W_ALONG 0`, `W_ACROSS 0,4`, `W_MIN −0,4`, `R_ACROSS 0,6` | 17,22 / 0,836 / 1,4 % | 31,44 / 0,931 | 35,15 / 0,881 |
| `ORIENT 0`, `W_ALONG 0`, `W_ACROSS 0,4`, `W_MIN −0,4` | **17,62 / 0,854** / 2,3 % | 29,97 / 0,918 (4,0 %) | 35,15 / 0,881 / 0,17 % |
| `W_ALONG 0`, `W_ACROSS 0,4`, `W_MIN −0,4`, `τ 0,02` | 17,39 / 0,843 / 1,7 % | 30,43 / 0,921 (3,7 %) | 35,33 / 0,882 |

**Verdicts.** H2a tenue : le lissage le long à ±1 texel coûte partout (−0,5 dB sur `text`, −0,9 dB
au centre de l'étalon) ; `W_ALONG` passe à 0. H2b tenue sur le texte seulement : la force que le
texte réclame (`W_MIN −0,4`, pente ×5 sur la rampe) casse l'étalon (−1,6 dB au centre, 3 % de
dépassements) et `game` ; le dosage commun est `W_ACROSS 0,2-0,4` borné à `W_MIN −0,24…−0,3`. H2c :
les axes gagnent 0,25 dB sur du texte droit mais perdent 0,5 dB sur l'étalon à force égale : le
repère des dérivées reste la base. H2d tenue : `τ` entre 0,02 et 0,05 ne change rien aux chiffres
(les quads de contour du texte passent les deux seuils).

**Ce que J2 dit du noyau.** Sur ces images, ce qui paie est l'accentuation directionnelle en
travers de la rampe bilinéaire, pas le lissage le long ; en PSNR `mwsr` dépasse FSR1 sur `game`
(35,86 contre 35,55) et le rejoint au centre de l'étalon (32,09 contre 32,26) ; en SSIM FSR1 garde
0,005 sur `game` (EASU reconstruit la structure, un masque flou ne fait qu'affûter). **Les
dépassements** sont le point dur du critère C3 (« ≤ FSR1 ») : la borne des cinq échantillons
couvre trois texels, plus large que l'empreinte 2×2 de la métrique ; `text` est à 0,6 % contre 0,3 %
pour FSR1 dès `W_ALONG 0`. D'où la borne exacte 2×2 (`DERING 1`, quatre `textureLoad` sur les quads
de contour) ajoutée pour J3.

**Suite (J3)** : force intermédiaire (`W_ACROSS 0,3`, `W_MIN −0,3`), lissage le long à un
demi-texel (`R_ALONG 0,5`), `R_ACROSS 0,75`, `τ 0,08`, puis `DERING 1`.

## 2026-10-21 — J3, le dosage, le demi-texel le long, la borne exacte (SwiftShader)

**Hypothèses.** H3a : une force intermédiaire (`W_ACROSS 0,3`, `W_MIN −0,3`) tient le texte sans
casser l'étalon. H3b : un lissage le long **à un demi-texel** (`R_ALONG 0,5`, `W_ALONG 0,1-0,2`)
aide l'étalon sans coûter au texte (contrairement à ±1 texel, J2). H3c : la borne exacte 2×2
(`DERING 1`, quatre `textureLoad` sur les quads de contour) ramène les dépassements à zéro sans
perdre de netteté. H3d : à ×1,33 (1080p → 1440p, le cas courant d'un ordinateur) le noyau vaut FSR1.

Notation : W = `W_ALONG`, R = `R_ALONG`, A = `W_ACROSS`, M = `W_MIN`, D = `DERING 1` ; `R_ACROSS 1`,
`ORIENT 1`, `τ 0,05`, netteté 1 partout. PSNR / SSIM / dépassement ; étalon : tiers central.

| variante | `text` ×2 | étalon ×2 | `game` ×2 | `zone` ×2 | `code` ×2 | étalon ×1,33 | `text` ×1,33 |
|---|---|---|---|---|---|---|---|
| bilinéaire | 16,99 / 0,816 | 31,56 / 0,928 | 35,01 / 0,880 | 10,41 / 0,423 | 29,98 / 0,977 | 36,36 / 0,977 | 20,52 / 0,923 |
| FSR1 | 17,57 / 0,845 / 0,3 % | 32,26 / 0,940 / 2,0 % | 35,55 / 0,887 / 0,03 % | 10,79 / 0,484 / 3,4 % | 30,36 / 0,975 / 0,7 % | 35,94 / 0,976 / 5,0 % | 21,45 / 0,942 / 0,2 % |
| SGSR1 | 18,13 / 0,869 / 4,4 % | 31,28 / 0,930 / 6,8 % | 35,61 / 0,883 / 0,7 % | 10,80 / 0,491 / 0 % | 29,65 / 0,974 / 2,6 % | 34,55 / 0,970 / 5,0 % | 21,64 / 0,946 / 2,7 % |
| W0 A0,3 M−0,3 | 17,40 / 0,842 / 1,1 % | 31,59 / 0,932 / 1,1 % | 35,79 / 0,882 / 0,05 % | — | — | — | — |
| W0,2 R0,5 A0,3 M−0,3 | 17,37 / 0,839 / 0,5 % | 31,99 / 0,934 / 0,2 % | 35,82 / 0,882 / 0 % | 10,64 / 0,456 / 0,03 % | 30,00 / 0,978 / 0,06 % | 36,77 / 0,979 / 0,15 % | 21,45 / 0,942 / 0,4 % |
| **W0,2 R0,5 A0,3 M−0,3 D** | 17,38 / 0,840 / **0 %** | **31,99 / 0,934** / 0 % | 35,82 / 0,882 / 0 % | 10,64 / 0,456 / 0 % | **30,00 / 0,978** / 0 % | **36,79 / 0,979** / 0 % | 21,45 / 0,942 / 0 % |
| **W0,15 R0,5 A0,35 M−0,3 D** | 17,42 / 0,842 / 0 % | 31,82 / 0,933 / 0 % | **35,87 / 0,882** / 0 % | 10,65 / 0,459 / 0 % | 29,89 / 0,978 / 0 % | 36,55 / 0,978 / 0 % | 21,60 / 0,944 / 0 % |
| W0,1 R0,5 A0,4 M−0,3 D | **17,45 / 0,844** / 0 % | 31,67 / 0,933 / 0 % | 35,87 / 0,882 / 0 % | 10,66 / 0,460 / 0 % | 29,80 / 0,978 / 0 % | 36,10 / 0,977 / 0 % | **21,74 / 0,947** / 0 % |
| W0,2 R0,5 A0,4 M−0,4 D | 17,42 / 0,843 / 0 % | 31,51 / 0,931 / 0 % | 35,84 / 0,882 / 0 % | 10,67 / 0,461 / 0 % | 29,74 / 0,978 / 0 % | 36,35 / 0,978 / 0 % | 21,65 / 0,945 / 0 % |
| W0 A0,3 M−0,3, `R_ACROSS 0,75` | 17,22 / 0,835 | 31,73 / 0,932 | 35,39 / 0,881 | — | — | — | — |
| W0 A0,3 M−0,3, `τ 0,08` | 17,38 / 0,841 | 31,58 / 0,931 | 35,77 / 0,882 | — | — | — | — |

**Verdicts.** H3a tenue (la force intermédiaire est le bon milieu : `W_MIN −0,4` perd 0,5 dB sur
l'étalon pour rien sur le texte). H3b tenue : le demi-texel le long rend +0,4 dB au centre de
l'étalon à force égale, +0,2 dB sur `game`, pour −0,03 dB sur le texte, et divise les dépassements
par deux. H3c tenue : `DERING 1` met **tous les dépassements à 0 %** sur toutes les images, les PSNR
et SSIM ne bougent pas au centième ; le critère C3 « dépassements ≤ FSR1 » est acquis par
construction. H3d dépassée : **à ×1,33 `mwsr` bat FSR1** au centre de l'étalon (+0,85 dB, SSIM
+0,003) et sur le texte (+0,15 à +0,3 dB), là où RCAS, réglé pour ×2, sort 5 % des pixels de leur
plage. `R_ACROSS < 1` et `τ 0,08` ne rapportent rien : écartés.

**Bilan contre FSR1, en l'état (J3, `W0,15 R0,5 A0,35 M−0,3 D`)** : PSNR −0,15 dB sur `text` ×2,
−0,44 au centre de l'étalon ×2, +0,32 sur `game`, −0,47 sur `code`, −0,14 sur `zone` ; +0,6 sur
l'étalon ×1,33, +0,15 sur `text` ×1,33 ; SSIM dans −0,007…+0,003 (C3 veut ≥ FSR1 − 0,005 : l'étalon
×2 à −0,007 est le seul point sous la barre, à revoir avec FLIP) ; dépassements 0 % partout. Ce qui
manque encore à ×2 est de la reconstruction (SSIM), pas de la netteté : d'où J4, la courbe bornée
sur les marches (`SHAPE 1`), qui redresse la rampe sans masque flou ni dépassement.

**Première table de P2.1 (provisoire, avant J4)** : `ORIENT 1`, `W_ALONG 0,15`, `R_ALONG 0,5`,
`W_ACROSS 0,35`, `R_ACROSS 1`, `W_MIN −0,3`, `DERING 1`, `S_FULL 1,5`, `τ 0,05`, netteté 1.

## 2026-10-21 — J4, la courbe bornée sur les marches (`SHAPE 1`), rejetée

**Hypothèse H4.** Sur une marche, remplacer le masque flou par une courbe qui pousse le pixel de la
rampe vers son plateau le plus proche, bornée par les deux plateaux (aucun dépassement, aucun
`textureLoad` de plus), redresse la rampe aussi bien que le masque et rend de la structure (SSIM).

**Mesure** (base `W0,2 R0,5 A0,3 M−0,3`, `K_SHAPE` 0,5 / 0,8 / 1,0, avec et sans D) :

| | `text` ×2 | étalon ×2 (centre) | `game` ×2 | `zone` ×2 | `code` ×2 | étalon ×1,33 | `text` ×1,33 |
|---|---|---|---|---|---|---|---|
| J3, masque flou, D | 17,38 / 0,840 | 31,99 / 0,934 | 35,82 / 0,882 | 10,64 / 0,456 | 30,00 / 0,978 | 36,79 / 0,979 | 21,45 / 0,942 |
| `SHAPE 1`, K 0,5, D | 17,07 / 0,828 | 31,61 / 0,930 | 35,92 / 0,882 | 10,57 / 0,446 | 29,78 / 0,979 | 36,06 / 0,976 | 20,77 / 0,932 |
| `SHAPE 1`, K 1,0, D | 17,06 / 0,830 | 30,95 / 0,925 | 35,85 / 0,882 | 10,61 / 0,451 | 29,47 / 0,978 | 35,27 / 0,974 | 20,88 / 0,936 |

**Verdict : rejetée.** La courbe perd 0,3 dB sur le texte et 0,4 à 1 dB au centre de l'étalon à
×2, 0,7 dB sur le texte et l'étalon à ×1,33 ; seul `game` est à égalité. Lecture : `t` est lu sur la
luma de C entre lX1 et lX2 pris à ±1 texel, c'est-à-dire sur une rampe déjà lissée par le
bilinéaire ; la poussée agit donc là où la rampe est la plus pentue et pas sur ses pieds, qu'un
masque flou étire. Sans dépassement et sans `textureLoad`, elle n'a pourtant rien à offrir contre
`DERING 1`. `SHAPE` reste à 0 ; le texte du noyau le garde jusqu'au nettoyage de P2.2 (le
compilateur élimine la branche).

## 2026-10-21 — La première table de P2.1

`ORIENT 1`, `W_ALONG 0,15`, `R_ALONG 0,5`, `W_ACROSS 0,35`, `R_ACROSS 1`, `W_MIN −0,3`, `DERING 1`,
`SHAPE 0`, `S_FULL 1,5`, `EARLY_OUT 1`, luma `(0,25, 0,625, 0,125)`, `τ 0,05`, netteté 1 : les
défauts de `MwsrShader.js` depuis ce jour. Choisie entre la variante qui sert le mieux l'étalon
(`W0,2 A0,3`) et celle qui sert le mieux le texte (`W0,1 A0,4`) : à 0,17 dB de la première sur
l'étalon, à 0,03 dB de la seconde sur le texte, et la seule des trois qui bat FSR1 à la fois sur
`game` ×2, sur l'étalon ×1,33 et sur `text` ×1,33. La netteté (uniforme `sharp`) déplace le point
entre les deux à la demande, sans recompiler. Reste à mesurer : le temps GPU (RTX, puis 780M,
iPhone, realme), le coût de `DERING 1` sur la texture externe (P2.3), FLIP.

## 2026-10-21 — Temps GPU de la table sur le RTX 5060 Ti (`--p2`)

Noyau seul (`tex`) à ×2 vers 1440p : `text` 0,051 ms, `ui` 0,029, `game` 0,028 (plancher 0,028 ;
SGSR1 0,039-0,073 ; FSR1 0,247 ; NIS 0,31-0,44) ; à ×1,33 : 0,046 et 0,036. Sans la borne exacte :
0,039 sur `text`. Sans la sortie anticipée : 0,086 partout (= neuf fetches par pixel). Sur la texture
externe, sans passe 0 : 0,043-0,096 (la borne par `textureLoad` externe y coûte 0,03 : à refaire par
échantillons, P2.3). Le détail est dans `docs/design/upscaler-mwsr-p2.md` §1.4.

## 2026-10-21 — La table sur le Mac M1 Pro (créneau de 30 min, Chrome, `metal-3`)

Mur par itération sous contre-pression (`back`) / GPU `-single` (quantum 65,5 µs), ×2 → 1440p :
`text` : `mwsr` 0,26 / 0,39 ms, plancher 0,13 / 0,13, SGSR1 0,37 / 0,46, FSR1 1,27 / 1,77, NIS
2,6 / 2,0 ; `game` : `mwsr` 0,15 / 0,13 (au plancher), SGSR1 0,37 / 0,33. Sans sortie anticipée
0,42 partout ; borne exacte +1 quantum sur le texte. **Texture externe** : `ext-mwsr` 0,61 (`text`)
contre `blit` + `mwsr` ≈ 0,42 ; 0,23 contre 0,32 sur `game` : sur Apple, passe 0 par défaut (P2.3,
`override`). Chaîne 1:1 du produit (P1) : une passe, 48 copies / 48, `draw()` 1,3-1,5 ms. Détail :
`docs/design/upscaler-mwsr-p0.md` §4 quater.
