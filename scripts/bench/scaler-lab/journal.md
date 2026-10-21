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

## 2026-10-21 — P2.2 ouverte (go de Bruno par 59) : J5, le palier qualité

**Hypothèse H5.** Ce qui manque à ×2 est de la reconstruction (SSIM −0,005…−0,007 contre FSR1 sur
l'étalon et `game`), pas de la netteté. Avec les **quatre coins de la grille 3×3 tournée** (`TIER 1`,
neuf échantillons sur les quads de contour), pondérés en fenêtre séparable (poids en travers × poids
le long, `W_CORNER` pour les forcer), un contour diagonal est lissé le long de lui-même et affûté en
travers comme un contour droit : SSIM remonte sur l'étalon sans perdre le texte. À mesurer :
`TIER 1` × `W_ALONG {0,15 ; 0,3}` × `R_ALONG {0,5 ; 1}` × `W_CORNER {1 ; 2}` contre la table, sur les
sept cas ; puis le coût (RTX : `tex-s9` 0,085 ms sur `text` ; M1 : 0,36 ms, au niveau de SGSR1 — le
palier qualité est un choix d'ordinateur). Outil : `mwsr:show=1` dans `--quality-cells` imprime la
part des pixels sur le chemin contour par image.

**Mesure J5** (SwiftShader ; T = `TIER 1`, K2 = `W_CORNER 2`, W/R = `W_ALONG`/`R_ALONG` ; PSNR / SSIM,
dépassements 0 % partout) :

| variante | `text` ×2 | étalon ×2 (centre) | `game` ×2 | `zone` ×2 | `code` ×2 (deux colonnes) | étalon ×1,33 | `text` ×1,33 |
|---|---|---|---|---|---|---|---|
| FSR1 | 17,57 / 0,845 | 32,26 / 0,940 | 35,55 / 0,887 | 10,79 / 0,484 | 27,35 / 0,951 | 35,94 / 0,976 | 21,45 / 0,942 |
| table (5 taps) | 17,42 / 0,842 | **31,82 / 0,933** | **35,87 / 0,882** | 10,65 / 0,459 | **26,88 / 0,956** | **36,55 / 0,978** | 21,60 / 0,944 |
| T | 17,58 / 0,850 | 31,12 / 0,929 | 35,80 / 0,882 | 10,68 / 0,463 | 26,56 / 0,955 | 36,11 / 0,977 | 21,85 / 0,949 |
| T K2 | **17,63 / 0,853** | 30,23 / 0,922 | 35,50 / 0,882 | **10,71 / 0,466** | 26,25 / 0,954 | 35,53 / 0,976 | **21,97 / 0,951** |
| T W0,3 | 17,55 / 0,849 | 31,09 / 0,929 | 35,81 / 0,882 | 10,68 / 0,463 | 26,56 / 0,955 | 36,09 / 0,977 | 21,81 / 0,948 |
| T W0,3 R1 | 17,34 / 0,842 | 30,91 / 0,926 | 35,85 / 0,882 | 10,66 / 0,459 | 26,53 / 0,955 | 35,91 / 0,976 | 21,54 / 0,943 |
| T W0,15 R1 | 17,46 / 0,846 | 31,12 / 0,929 | 35,84 / 0,882 | 10,67 / 0,461 | 26,61 / 0,955 | 36,11 / 0,977 | 21,70 / 0,946 |

Part des pixels sur le chemin contour (`SHOW 1`, `τ 0,05`) : `text` 35 %, étalon 29 % (28 % à ×1,33),
`game` 2 %, `zone` 50 %, `code` 14 %, `text` ×1,33 26 %.

**Verdict H5 : rejetée.** Les coins font gagner le texte (+0,16 à +0,37 dB, SSIM +0,007 à +0,011 ;
`T K2` **dépasse FSR1 sur le texte à ×2 et à ×1,33**, à 0 % de dépassement) mais perdent partout
ailleurs : −0,7 dB au centre de l'étalon à ×2, −0,4 à ×1,33, −0,07 à −0,37 sur `game`, −0,3 sur
`code`. Ce n'est donc pas la couverture des diagonales qui manque à l'étalon. Lecture : 71 % des
pixels de l'étalon passent **sous `τ`** et sortent en bilinéaire pur, là où EASU filtre chaque
pixel ; l'écart de SSIM sur les dégradés (peau, feuillage) serait dans ces 71 %, pas dans les
contours. D'où J6 : `τ` de 0,05 à 0 sur la table, avec la part de pixels traitée et son coût.
`TIER 1` reste une option de texte (un palier « bureau et texte » sur ordinateur), à décider en P4
par classe d'appareil ; `W_CORNER 2` est son meilleur réglage.

**FLIP sur J5** (dès ce jour : `metrics.py` passe par le venv `.flipenv`, Python 3.12 ; FLIP moyen
LDR, plus bas = mieux ; C3 : ≤ FSR1 + 0,01) :

| | `text` ×2 | étalon ×2 (image entière) | `game` ×2 |
|---|---|---|---|
| bilinéaire | 0,090 | — | — |
| FSR1 | 0,068 | 0,045 | 0,017 |
| SGSR1 | 0,067 | — | — |
| **table (5 taps)** | **0,072** | **0,052** | **0,019** |
| T | 0,073 | 0,056 | 0,019 |
| T K2 | 0,076 | 0,059 | 0,020 |

FLIP tranche contre les coins là où PSNR et SSIM les récompensaient sur le texte : la netteté
supplémentaire des diagonales n'est pas perçue comme une amélioration. **La table tient C3 en FLIP
sur les trois images** (texte 0,072 ≤ 0,078, étalon 0,052 ≤ 0,055 de justesse, `game` 0,019 ≤ 0,027) ;
`TIER 1` ne la tient pas sur l'étalon. `TIER`/`W_CORNER` vont au nettoyage avec `SHAPE`.

## 2026-10-21 — J6, le seuil du vote (`τ` de 0,05 à 0), rejeté comme explication

**Hypothèse H6.** Les 71 % de pixels de l'étalon qui passent sous `τ` sortent en bilinéaire pur ;
abaisser `τ` (jusqu'à traiter tout, `τ 0`) referme l'écart de FLIP et de SSIM avec FSR1 au prix
du temps.

| `τ` | étalon ×2 : centre PSNR / SSIM, FLIP entier, part traitée | `text` ×2 : PSNR / SSIM, FLIP, part | `game` ×2 : PSNR / SSIM, FLIP, part | étalon ×1,33 : centre, FLIP |
|---|---|---|---|---|
| FSR1 | 32,26 / 0,940, 0,045, 100 % | 17,57 / 0,845, 0,068 | 35,55 / 0,887, 0,017 | 35,94 / 0,976, 0,035 |
| 0,05 (table) | 31,82 / 0,933, 0,052, 29 % | 17,42 / 0,842, 0,072, 35 % | 35,87 / 0,882, 0,019, 2 % | 36,55 / 0,978, 0,038 |
| 0,03 | 31,84 / 0,935, 0,051 | 17,43 / 0,843, 0,071 | 35,87 / 0,882, 0,019 | 36,58 / 0,979, 0,038 |
| 0,02 | 31,85 / 0,935, 0,051, 48 % | 17,43 / 0,843, 0,071, 37 % | 35,87 / 0,882, 0,019, 4 % | 36,58 / 0,979, 0,038 |
| 0,01 | 31,85 / 0,936, 0,051, 61 % | 17,43 / 0,843, 0,071, 39 % | 35,89 / 0,883, 0,018, 19 % | 36,59 / 0,979, 0,038 |
| 0 | 31,85 / 0,936, 0,051, 100 % | 17,43 / 0,843, 0,070 | 35,90 / 0,884, 0,018 | 36,59 / 0,980, 0,038 |

**Verdict : rejetée.** Traiter tous les pixels rend 0,001 de FLIP et 0,003 de SSIM au centre de
l'étalon, rien en PSNR, pour deux fois plus de quads sur le chemin contour : l'écart avec FSR1
(FLIP 0,052 contre 0,045) tient à ce que le noyau fait **sur** les contours, pas à ce qu'il ne fait
pas à côté. `τ 0,05` reste (il tient le coût de `game` à 2 % de pixels traités ; `τ 0,01` l'enverrait à
19 % pour 0,001 de FLIP). Dernier tour sur la question de l'étalon (règle des trois tours, §8.3) :
J7, le rayon en travers (`R_ACROSS` 0,75-0,85, que l'étalon préférait en J3a) contre la force, jugé
en FLIP.

## 2026-10-21 — J7, le rayon en travers contre la force, jugé en FLIP (troisième et dernier tour sur l'étalon)

| variante (table sauf dit) | étalon ×2 : centre, FLIP | `text` ×2 : PSNR, FLIP | `game` ×2 : PSNR, FLIP | étalon ×1,33 : centre, FLIP | `text` ×1,33 : PSNR, FLIP |
|---|---|---|---|---|---|
| FSR1 | 32,26 / 0,940, 0,045 | 17,57, 0,068 | 35,55, 0,017 | 35,94 / 0,976, 0,035 | 21,45, 0,042 |
| table (`A 0,35`) | 31,82 / 0,933, 0,052 | 17,42, 0,072 | 35,87, 0,019 | 36,55 / 0,978, 0,038 | 21,60, 0,047 |
| **`W_ACROSS 0,3`** | **31,95 / 0,934, 0,051** | 17,41, **0,071** | 35,84, 0,019 | **36,76 / 0,979, 0,038** | 21,50, 0,047 |
| `R_ACROSS 0,75` | 31,83 / 0,933, 0,051 | 17,18, 0,074 | 35,52, 0,019 | 36,64 / 0,979, 0,037 | 21,31, 0,047 |
| `R_ACROSS 0,85` | 31,83 / 0,933, 0,051 | 17,29, 0,073 | 35,65, 0,019 | 36,64 / 0,979, 0,037 | 21,42, 0,047 |
| `R_ACROSS 0,75`, `A 0,45` | 31,79 / 0,933, 0,051 | 17,18, 0,074 | 35,52, 0,019 | 36,28 / 0,978, 0,037 | 21,46, 0,046 |
| `R_ACROSS 0,85`, `A 0,45` | 31,78 / 0,933, 0,051 | 17,29, 0,073 | 35,65, 0,019 | 36,14 / 0,977, 0,038 | 21,59, 0,046 |
| `R_ACROSS 0,75`, `A 0,45`, `M −0,4` | 31,18 / 0,929, 0,056 | 17,06, 0,084 | 35,27, 0,020 | 36,28 / 0,978, 0,037 | 21,46, 0,046 |
| `R_ACROSS 0,75`, `W_ALONG 0,25` | 31,86 / 0,933, 0,050 | 17,15, 0,074 | 35,52, 0,018 | 36,65 / 0,978, 0,037 | 21,23, 0,048 |

**Verdict.** Le FLIP est plat autour de la table (± 0,002 sur toutes les images) : l'écart avec
FSR1 sur l'étalon à ×2 (0,052 contre 0,045) ne se règle pas par le rayon ni par la force, il tient à
la reconstruction à douze texels d'EASU que cinq échantillons bilinéaires n'ont pas. **Trois tours
sur cette question (J5, J6, J7), on s'arrête** (règle du §8.3) ; C3 est tenu (étalon 0,052 ≤ 0,055).
Un gain net et gratuit : `W_ACROSS 0,3` au lieu de 0,35 (+0,13 dB au centre de l'étalon à ×2,
+0,2 dB à ×1,33, FLIP égal ou meilleur partout, −0,01 dB sur le texte) : **la table de P2.2 prend
`W_ACROSS 0,3`**, le reste inchangé. J8 ferme la boucle de qualité : `S_FULL` à ×1,33 et un
contrôle à ×3.

## 2026-10-21 — J8, la constante d'échelle et un contrôle à ×3 ; la table de P2.2

**`S_FULL` à ×1,33** (`W_ACROSS 0,3`) : 1,5 (force 0,66 à ×1,33) donne l'étalon au centre 36,76 /
FLIP 0,038 et le texte 21,50 / 0,047 ; 1,2 ou 1,33 (force 1) : étalon 36,08 / 0,040, texte 21,70 /
0,047 ; 2 (force 0,33) : étalon 36,92 / 0,039, texte 21,13 / 0,051. **`S_FULL 1,5` reste** : le
meilleur FLIP sur l'étalon, le texte à 0,2 dB de son meilleur.

**×3** (848×480 → 2544×1440, le 720p sur un 4K du plan §4.3) : étalon, centre 27,97 / 0,846, FLIP
0,076 contre FSR1 27,92 / 0,845 / 0,073 et SGSR1 27,67 / 0,841 / 0,076 ; `text` 15,02 / 0,723 / 0,111
contre FSR1 15,16 / 0,726 / 0,111 et SGSR1 15,45 / 0,747 / 0,099 (4,3 % de dépassements). Le noyau
tient FSR1 à ×3 sans réglage propre ; 0,3-0,4 % de dépassements y apparaissent (bords de l'image,
où les échantillons bloqués au bord et l'empreinte de la métrique divergent), rien au centre.

**La table de P2.2** (défauts de `MwsrShader.js`, le texte nettoyé des variantes rejetées) :
`W_ALONG 0,15`, `R_ALONG 0,5`, `W_ACROSS 0,3`, `R_ACROSS 1`, `W_MIN −0,3`, `DERING 1`, `S_FULL 1,5`,
`EARLY_OUT 1`, luma `(0,25, 0,625, 0,125)`, `τ 0,05`, netteté 1 ; repère des dérivées seul (la croix
sur les axes, la courbe bornée et les coins sont retirés du texte : J2, J4, J5).

**C3 en FLIP, table contre FSR1** (≤ FSR1 + 0,01) : `text` ×2 0,071 / 0,068 ; étalon ×2 0,051 /
0,045 ; `game` 0,019 / 0,017 ; `zone` 0,116 / 0,107 ; `code` 0,029 / 0,024 ; étalon ×1,33 0,038 /
0,035 ; `text` ×1,33 0,047 / 0,042 ; étalon ×3 0,076 / 0,073 ; `text` ×3 0,111 / 0,111 : **tenu
partout**, au plus serré sur `zone` (+0,009). Dépassements 0 % (hors bords à ×3). SSIM ≥ FSR1 − 0,005
tenu partout sauf l'étalon ×2 (−0,006) et `game` (−0,005, limite) ; PSNR : au-dessus de FSR1 sur
`game` ×2, l'étalon ×1,33 et le texte ×1,33, en dessous de 0,15-0,45 dB ailleurs à ×2.

## 2026-10-21 — P2.3 ouverte (go de Bruno) : J9, la texture externe contre la passe 0 sur le Mac

Créneau éclair sur le Mac M1 Pro (« commence par le Mac, Léo arrive »), cinq cas en 30 s, temps
mur par image sous contre-pression (ms), ×2 → 1440p sauf dit :

| chaîne | `text` | `game` | `ui` | `text` ×1,33 |
|---|---|---|---|---|
| passe 0 seule (`blit`) | 0,10 | 0,09 | 0,12 | 0,24 |
| noyau seul sur RGBA (`mwsr`) | 0,25 | 0,16 | 0,16 | 0,23 |
| **passe 0 + noyau (`blit+mwsr`)** | **0,32** | **0,195** | **0,195** | **0,295** |
| texture externe (`ext-mwsr`) | 0,56 | 0,21 | 0,27 | 0,57 |
| externe sans borne exacte | 0,51 | 0,20 | 0,22 | 0,38 |
| externe sans sortie anticipée | 1,12 | 1,09 | 1,07 | 1,12 |
| passe 0 + SGSR1 (chaîne livrée) | 0,43 | 0,39 | 0,26 | 0,40 |
| passe 0 + FSR1 (chaîne livrée) | 1,30 | 1,31 | 1,21 | 1,33 |

**Verdict.** Sur Apple, **la passe 0 gagne partout** (−8 % sur `game`, −26 % sur `ui`, −43 % sur le
texte, −48 % à ×1,33) : chaque échantillon de la texture externe y lit deux plans, et le chemin
contour en fait jusqu'à neuf. La décision n° 2 du plan (« pas de passe 0 en SDR ») ne tient que là où
l'échantillon externe ne coûte rien de plus que l'échantillon RGBA (NVIDIA, P0). La chaîne
passe 0 + `mwsr` vaut 0,5 à 0,75 × la chaîne SGSR1 livrée et 0,25 × FSR1 : **C1 tenue en chaîne sur
Apple**. Sans sortie anticipée, l'externe coûte 1,1 ms : la branche est vitale sur ce feed. À
confirmer sur le 780M et le RTX avec `blit+mwsr` dans les mêmes cellules ; si le gain de l'externe y
reste de l'ordre de 0,01 ms, **la passe 0 partout** est la règle la plus simple (un seul module, le
même chemin que le HDR et que le contournement 1:1).

## 2026-10-21 — P2.3, le code des couches (avant les passes 780M et RTX)

Ajouté au texte, à mesurer dès que DualRTX est rendue (« à toi » de 59) :

- **`DERING 2`** : la borne exacte par **quatre échantillons aux centres des texels** (un sampler
  linéaire rend le texel exactement là) au lieu de quatre `textureLoad` — pour la texture externe,
  où le chargement coûte deux plans et une conversion par texel (P0 : `ext-l` > `ext-s` sur AMD et
  Apple). Mêmes pixels que `DERING 1` par construction.
- **`half`** (option du module, pas un `override` : `enable f16` doit ouvrir le texte) : le chemin
  contour en f16 — lumas, cohérence, poids, mélange (`alias hf`, `alias h3`, `EPS_H 0,001` pour
  rester hors des dénormalisés) ; le vote, le repère et la borne restent en f32 ; le labo exige
  `f16=1` (fonctionnalité `shader-f16` demandée au device) et refuse la cellule sans elle.
- `QUAD_UNIFORM` : rien à écrire, la branche est uniforme par quad par construction (dérivées
  grossières) ; `subgroupAny` n'y ajouterait rien.
- `EARLY_OUT 0` reste jusqu'aux chiffres du 780M, puis sort du texte (perdant partout jusqu'ici).

Cellules `--p2` : `mwsr`, `mwsr:dering=0`, `mwsr:dering=2`, `mwsr:half=1`, `mwsr:early=0`,
`blit+mwsr`, `ext-mwsr`, `ext-mwsr:dering=0`, `ext-mwsr:dering=2`, les planchers et les références,
avec `f16=1` ; cinq cas. **Hypothèses H10** : (a) `DERING 2` ramène la borne sur l'externe au prix de
quatre échantillons (RTX : 0,096 → ~0,07 ; 780M : à voir) ; (b) `half` gagne peu sur ce noyau
(≤ 5 %, chemin borné par la texture) ; (c) sur le 780M comme sur le RTX, passe 0 + noyau et externe
sont à ± 0,02 ms, et la passe 0 partout est la règle.

## 2026-10-21 — J10, les couches sur le 780M et le RTX ; la décision « passe 0 partout »

Passes `--p2` du 21/10 (10:05-10:20), noyau seul (`tex`) et chaînes, GPU p50 en ms, ×2 → 1440p :

| cellule | 780M `text` | 780M `ui` | 780M `game` | 780M `text` ×1,33 | RTX `text` | RTX `ui` | RTX `game` | RTX `text` ×1,33 |
|---|---|---|---|---|---|---|---|---|
| plancher (`tex-s1`) | 0,385 | 0,366 | 0,365 | 0,381 | 0,028 | 0,028 | 0,028 | 0,028 |
| **`mwsr`** (table) | **1,408** | **0,652** | **0,577** | **1,233** | **0,051** | **0,029** | **0,028** | **0,046** |
| `mwsr:dering=0` | 1,107 | 0,548 | 0,496 | 0,995 | 0,039 | 0,028 | 0,028 | 0,036 |
| `mwsr:dering=2` (borne par échantillons) | 1,506 | 0,659 | 0,581 | 1,309 | 0,054 | 0,029 | 0,028 | 0,048 |
| **`mwsr:half=1`** (f16) | **1,270** | **0,590** | **0,523** | **1,125** | 0,053 | 0,029 | 0,028 | 0,047 |
| `mwsr:early=0` (sans branche) | 2,542 | 2,542 | 2,540 | 2,548 | 0,086 | 0,086 | 0,086 | 0,086 |
| **passe 0 + `mwsr`** | **1,534** | **0,761** | **0,737** | **1,510** | **0,060** | **0,037** | **0,037** | **0,068** |
| texture externe (`ext-mwsr`) | 2,361 | 0,983 | 0,920 | 2,073 | 0,096 | 0,048 | 0,043 | 0,088 |
| externe sans borne | 1,649 | 0,816 | 0,785 | 1,490 | 0,065 | 0,035 | 0,033 | 0,062 |
| externe, borne par échantillons | 2,404 | 1,037 | 0,971 | 2,154 | 0,097 | 0,047 | 0,043 | 0,088 |
| SGSR1 (noyau seul) | 2,476 | 1,116 | 2,477 | 2,131 | 0,073 | 0,039 | 0,066 | 0,066 |
| FSR1 | 9,32 | 9,35 | 9,36 | 9,37 | 0,247 | 0,243 | 0,246 | 0,247 |

Qualité sur le RTX (`--quality`, `f16=1`) : `half=1` et `dering=2` rendent **les mêmes pixels** que le
f32 au centième (texte 17,41 / 0,841 / FLIP 0,072 ; étalon 20,75 / 0,871 / 0,051).

**Verdicts H10.** (a) **La borne par échantillons ne gagne rien** (780M : +7 % sur le texte ; RTX :
égal ; externe : égal) : le surcoût de la texture externe est dans ses échantillons eux-mêmes (deux
plans), pas dans les chargements — `DERING 2` sort du texte. (b) **f16 vaut 9-10 % sur le 780M**,
rien sur le RTX (−4 %) : le module `half` est à prendre quand `shader-f16` est là, hors NVIDIA
(Apple et Adreno/Mali à mesurer, l'attendu est du même ordre ou mieux). (c) **La passe 0 gagne
partout** : 780M −20 à −35 % (1,53 contre 2,36 sur le texte), RTX −12 à −37 % (0,060 contre 0,096),
M1 −8 à −48 % (J9). La décision n° 2 du plan (« pas de passe 0 en SDR ») tenait pour un noyau à un ou
deux fetches par pixel ; avec cinq échantillons et quatre texels sur un tiers des pixels, les deux
plans de la NV12 coûtent plus que la copie RGBA qu'ils évitent. **Décision : passe 0 partout** —
`mwsr` lit `texture_2d` après la passe 0 existante du renderer, comme les autres enhancers et comme
le HDR ; un seul module, un seul bind group layout, le contournement 1:1 inchangé. Le feed `ext`
reste dans le générateur pour le labo (une future classe de GPU pourrait le remesurer). `EARLY_OUT 0`
sort du texte (perdant partout : 780M 2,54 = `tex-s9`, RTX 0,086, M1 ×2,7). Chaînes sur le 780M :
passe 0 + `mwsr` 1,53 contre passe 0 + SGSR1 ≈ 2,6-2,8 (P0) et passe 0 + FSR1 9,5 : **C2 tenue**
(× 0,16 de FSR1) ; avec `half` ≈ 1,38.
