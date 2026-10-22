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

## 2026-10-21 — J11, le feed HDR tel qu'il est, et le noyau dessus (C8, qualité)

**Le feed.** Le plan (§4.1) attendait de la lumière de scène linéaire et prévoyait une compression
réversible autour du noyau. La passe 0 HDR du renderer (`tonemapPq`, courbe 2) écrit en réalité des
valeurs **encodées sRGB, prolongées au-delà de 1,0** (`linToSrgb(P * scaled)` sur un canvas
`rgba16float` en `toneMapping: extended`) : 203 nits = 1,0, 1000 nits ≈ 2,0, 10000 nits ≈ 5,3. La
dynamique est déjà compressée par la courbe ; le noyau, borné par ses propres échantillons et sans
aucun `clamp` à 1,0, tourne dessus sans changement. **La compression du plan est sans objet.**

**L'instrument.** `hdr=1` dans la page (textures et cibles `rgba16float`, image `f16:<url>`,
relecture en demi-flottants), mires de `hdr_mires.py` (rampe PQ grise et rouge, douze marches avec un
trait sombre, rayures 1000 / 0,5 nits, dégradé ; texte 0,5 sur 1000 nits, 1000 sur 10, rouge P3 sur
blanc ; l'image `game` de la page poussée à 1000 nits), vérité au format du feed, entrée réduite en
lumière linéaire (Lanczos-3), `metrics_hdr.py` : ΔE ITP (BT.2124, ICtCp depuis des nits BT.2020),
PSNR et SSIM en PQ, maximum, dépassement du max local 2×2 en nits (1 % + 0,5 nit).

Passe SwiftShader du 21/10 (les pixels y sont ceux du RTX : contrôle SDR identique à P2 au centième),
720p → 1440p :

| mire | cellule | ΔE ITP moy | p99 | centre moy | PSNR PQ | max nits (× entrée) | dépassement |
|---|---|---|---|---|---|---|---|
| rampe | bilinéaire | 34,26 | 352 | 29,4 | 17,19 | 10718 (0,972) | 0 % |
| rampe | FSR1 | **30,73** | **331** | 25,9 | **17,87** | 11348 (**1,030**) | **5,16 %** |
| rampe | SGSR1 | 41,06 | 334 | 33,1 | 17,00 | 10073 (0,914) | 1,47 % |
| rampe | **`mwsr`** | 31,32 | 352 | **23,6** | 17,70 | 10791 (0,979) | **0 %** |
| texte | bilinéaire | 15,76 | 251 | 2,26 | 22,72 | 1139 (0,887) | 0 % |
| texte | FSR1 | 16,71 | 252 | 2,61 | 22,52 | 1418 (**1,104**) | **4,81 %** |
| texte | SGSR1 | 34,51 | 267 | 3,04 | 20,24 | 1083 (0,843) | 17,65 % |
| texte | **`mwsr`** | **15,38** | 257 | **2,14** | **22,76** | 1149 (0,894) | **0 %** |
| jeu | bilinéaire | 3,65 | 22,9 | 5,24 | 38,47 | 1078 (0,872) | 0 % |
| jeu | FSR1 | 3,64 | 23,2 | 5,44 | 37,91 | 1354 (**1,095**) | 0,18 % |
| jeu | SGSR1 | 4,07 | 40,4 | 5,95 | 36,69 | 1075 (0,870) | 0,97 % |
| jeu | **`mwsr`** | **3,54** | **20,7** | **4,97** | **39,14** | 1162 (0,940) | **0 %** |

Part du chemin contour : rampe 12 %, texte 28 %, jeu 2 %. Le « max » se lit contre l'entrée : la
réduction Lanczos-3 en lumière linéaire sonne elle-même à 1285 nits sur le texte à 1000 ; `mwsr` garde
le maximum local de l'entrée et ne le dépasse jamais, FSR1 y ajoute 10 % (RCAS n'a pas de borne au-delà
de 1,0). SGSR1 écrête à 1,0 sur son chemin contour (`saturate`) : inutilisable en HDR, comme prévu.

**Verdict H11.** Qualité de C8 **tenue** : ΔE ITP moyen de `mwsr` ≤ FSR1 sur le texte (−8 %) et le jeu
(−3 %), +2 % sur la rampe (mais −9 % au centre) ; maximum conservé ; 0 % au-delà du maximum local
contre 5 % pour FSR1 ; aucun changement de texte. Le temps ajouté (C8, « ≤ FSR1 `linear` ») se mesure
sur le RTX (J14). Le module `half` sur le feed HDR (valeurs jusqu'à 5,3) : pixels à vérifier sur le RTX.

## 2026-10-21 — J12, la réduction (C10) : la lumière linéaire d'abord, la grille ensuite

Mode `down` du texte : grille k×k d'échantillons bilinéaires répartie sur l'empreinte du pixel de
sortie (1/s texel par axe), étendue `R_DOWN`, moyenne en valeurs encodées (`LINEAR_LIGHT 0`), en
gamma 2 (1 : carré, racine) ou en sRGB exact (2 : 15 `pow` par pixel à 4 taps). Référence : le
Lanczos-2 de l'hôte en lumière linéaire (`p3_flows.lanczos_linear`) ; `smooth2d` = `drawImage` de
Canvas2D en qualité `high` (le Smooth2D du critère) ; FSR1 et SGSR1 hors de leur domaine, tels que le
client les ferait tourner aujourd'hui ; `alias` = RMS de l'erreur dans l'anneau de la zone-plate dont
la fréquence dépasse la Nyquist de sortie, `flat` = RMS autour de la moyenne (le moiré lui-même),
`lines` = PSNR de la moitié des traits fins. SwiftShader, 21/10.

| échelle, image | cellule | PSNR | FLIP | alias | flat | lines |
|---|---|---|---|---|---|---|
| ×0,75 texte | bilinéaire = Smooth2D | 26,00 | 0,055 | | | |
| ×0,75 texte | FSR1 / SGSR1 | 23,51 / 23,69 | 0,050 / 0,051 | | | |
| ×0,75 texte | 2×2, encodé | 26,85 | 0,070 | | | |
| ×0,75 texte | **2×2, gamma 2** | **28,55** | 0,054 | | | |
| ×0,75 texte | 2×2, sRGB | 28,90 | 0,051 | | | |
| ×0,75 texte | 2×2 sRGB, étendue 0,75 / 0,5 | 28,47 / 27,20 | 0,050 / 0,048 | | | |
| ×0,75 code | bilinéaire / FSR1 | 32,99 / 31,37 | 0,022 / 0,017 | | | |
| ×0,75 code | 2×2 encodé / gamma 2 / sRGB | 32,95 / 33,91 / 34,08 | 0,029 / 0,023 / 0,022 | | | |
| ×0,75 zone | bilinéaire = Smooth2D | 17,67 | | 0,165 | 0,186 | 17,9 |
| ×0,75 zone | FSR1 / SGSR1 | 15,20 / 16,05 | | 0,235 / 0,209 | 0,294 / 0,255 | 15,9 / 16,5 |
| ×0,75 zone | 2×2 encodé / gamma 2 / sRGB | 18,84 / 20,37 / 20,70 | | 0,133 / 0,109 / 0,104 | 0,105 / 0,103 / 0,104 | 19,1 / 20,9 / 21,3 |
| ×0,5 texte | bilinéaire (= boîte 2×2) | 24,77 | 0,077 | | | |
| ×0,5 texte | FSR1 / SGSR1 | 22,95 / 22,04 | 0,063 / 0,070 | | | |
| ×0,5 texte | **2×2, gamma 2** | **30,63** | **0,015** | | | |
| ×0,5 texte | 2×2, sRGB | 30,76 | 0,025 | | | |
| ×0,5 texte | 3×3 encodé / gamma 2 | 26,35 / 31,46 | 0,093 / 0,054 | | | |
| ×0,5 code | bilinéaire / FSR1 | 30,58 / 29,01 | 0,031 / 0,024 | | | |
| ×0,5 code | 2×2 gamma 2 / sRGB | 32,79 / 32,99 | 0,012 / 0,008 | | | |
| ×0,5 zone | bilinéaire = Smooth2D | 16,86 | | 0,166 | 0,143 | 17,0 |
| ×0,5 zone | FSR1 | 14,41 | | 0,266 | 0,270 | 16,6 |
| ×0,5 zone | 2×2 gamma 2 / sRGB | 20,16 / 20,32 | | 0,094 / 0,090 | 0,133 / 0,134 | 18,8 / 18,9 |
| ×0,5 zone | 3×3 encodé / gamma 2 | 18,23 / 20,46 | | 0,141 / 0,104 | 0,091 / 0,088 | 18,7 / 20,7 |
| ×0,33 texte | bilinéaire / FSR1 / SGSR1 | 19,5 / 19,5 / 19,4 | 0,096 / 0,095 / 0,097 | | | |
| ×0,33 texte | Smooth2D | 25,98 | 0,099 | | | |
| ×0,33 texte | 3×3 encodé / gamma 2 / sRGB | 24,93 / 31,80 / 31,81 | 0,085 / 0,014 / 0,022 | | | |
| ×0,33 texte | **3×3 étendue 1,25, gamma 2** / sRGB | **35,07** / 34,52 | 0,034 / 0,024 | | | |
| ×0,33 texte | 4×4 encodé / sRGB | 25,55 / 33,29 | 0,093 / 0,030 | | | |
| ×0,33 zone | bilinéaire / FSR1 | 9,8 / 9,6 | | 0,367 / 0,375 | 0,354 / 0,363 | 10,6 / 10,2 |
| ×0,33 zone | Smooth2D | 16,67 | | 0,148 | 0,078 | 16,3 |
| ×0,33 zone | 3×3 encodé / gamma 2 / sRGB | 16,09 / 20,30 / 20,63 | | 0,147 / 0,058 / 0,052 | 0,085 / 0,076 / 0,075 | 15,3 / 18,0 / 18,3 |
| ×0,33 zone | **3×3 étendue 1,25, gamma 2** / sRGB | 22,65 / **23,69** | | 0,068 / 0,056 | **0,043** / 0,044 | 22,5 / 23,3 |
| ×0,33 zone | 4×4 sRGB / 4×4 étendue 1,25 sRGB | 20,02 / 20,40 | | 0,084 / 0,101 | 0,063 / 0,041 | 19,0 / 21,2 |

**Verdicts H12.** (a) **La lumière linéaire est le terme décisif** : +2,5 dB (×0,75) à +6 dB (×0,5) et
+12 dB (×0,33 contre le bilinéaire) sur le texte, FLIP divisé par trois à cinq ; la moyenne en valeurs
encodées assombrit toute structure fine (le gris moyen d'un damier sort à 0,5 encodé au lieu de 0,73),
ce que PSNR et FLIP sanctionnent tous deux. Le sRGB exact gagne ≤ 0,35 dB sur le gamma 2 et perd en
FLIP sur le texte ×0,5 : **`LINEAR_LIGHT 1` par défaut**, 2 en option là où quinze `pow` ne coûtent
rien (classe d'ordinateur, J14). (b) **Grilles** : à ×0,5 la grille 2×2 à l'étendue 1 est la boîte
exacte, et FLIP la préfère nettement à la 3×3 (0,015 contre 0,054 sur le texte) ; en dessous de ×0,5,
la 3×3 à l'étendue 1,25 vaut +2,7 dB sur le texte et −40 % de moiré (`flat` 0,044 contre 0,076) à FLIP
égal ; la 4×4 ne fait pas mieux à ×0,33 (régime < ×0,25 non mesuré, laissé au plan). **Table :
0,5 ≤ s < 1 → 2×2, étendue 1 ; 0,25 ≤ s < 0,5 → 3×3, étendue 1,25 ; s < 0,25 → 4×4, étendue 1,25**
(`MWSR_DOWN_TAPS`, `mwsrRegime()`). (c) Contre le critère : énergie d'aliasing ≤ Smooth2D partout
(×0,33 : 0,068 contre 0,148 ; `flat` 0,043 contre 0,078) ; PSNR contre le Lanczos-2 de l'hôte 28,5 à
35 dB sur le texte ; le coût (« ≤ bilinéaire + 30 % ») se mesure au RTX et au 780M (J14). FSR1 et SGSR1
en réduction sont pires que le bilinéaire (FSR1 : 27 à 50 % de dépassements à ×0,33) : c'est ce que le
client WebGPU fait aujourd'hui avec un enhancer allumé sur un flux plus grand que l'écran.

## 2026-10-21 — J13, le 4:4:4 (C9) et la netteté par la luma

Mires `code` (syntaxe VS Code sur fond sombre) et `codeiso` (les mêmes couleurs ramenées à une luma
Rec. 709 à 5/255 près du fond : chaque contour n'est qu'un contour de chroma), entrée brute (4:4:4) et
la même passée par un pipeline 4:2:0 simulé (`p3_flows.chroma_420` : Y'CbCr 709, chroma moyennée 2×2 et
remontée en bilinéaire, ce que fait l'import du navigateur). `CHROMA444 1` : vote sur le canal à la
pente la plus forte, cohérence et poids par canal. `LUMA_SHARP 1` (expérience) : netteté par la luma
seule, teinte des échantillons conservée. ×2, 720p → 1440p, SwiftShader.

| mire, entrée | cellule | FLIP | PSNR Cb / Cr | ΔE00 moy / p99 | dépassement | part contour |
|---|---|---|---|---|---|---|
| code 4:4:4 | bilinéaire | 0,034 | 36,94 / 37,69 | 1,653 / 23,7 | 0 % | |
| code 4:4:4 | SGSR1 | 0,026 | 36,98 / 37,73 | **1,563** / 24,2 | 4,92 % | |
| code 4:4:4 | FSR1 | **0,024** | **37,07** / 37,70 | 1,626 / **23,6** | 1,30 % | |
| code 4:4:4 | `mwsr` | 0,029 | 36,62 / 37,21 | 1,614 / 24,6 | 0 % | 14,4 % |
| code 4:4:4 | `mwsr:c444=1` | 0,029 | 36,58 / 37,18 | 1,623 / 24,7 | 0 % | 16,0 % |
| code 4:4:4 | `mwsr:lsharp=1` | 0,030 | 36,79 / 37,49 | 1,568 / 24,5 | 0 % | |
| code 4:2:0 | bilinéaire | 0,040 | 34,64 / 35,59 | 1,827 / 24,3 | 0 % | |
| code 4:2:0 | SGSR1 | 0,032 | 34,66 / 35,61 | 1,748 / 25,4 | 1,11 % | |
| code 4:2:0 | FSR1 | **0,031** | **34,79** / 35,73 | 1,743 / 24,3 | 1,17 % | |
| code 4:2:0 | `mwsr` | 0,036 | 34,70 / 35,65 | 1,742 / 25,3 | 0 % | 14,5 % |
| code 4:2:0 | `mwsr:c444=1` | 0,036 | 34,71 / 35,66 | 1,737 / 25,2 | 0 % | 15,5 % |
| code 4:2:0 | `mwsr:lsharp=1` | 0,036 | 34,76 / 35,69 | **1,716** / 25,2 | 0 % | |
| codeiso 4:4:4 | bilinéaire = SGSR1 = `mwsr` | 0,014 | 34,57 / 40,62 | 0,752 / 13,0 | 0 % | 0,1 % |
| codeiso 4:4:4 | FSR1 | **0,008** | **34,94 / 42,00** | **0,654** / 11,4 | 1,16 % | |
| codeiso 4:4:4 | **`mwsr:c444=1`** | 0,011 | 34,55 / 41,39 | 0,675 / 12,1 | 0 % | 11,7 % |
| codeiso 4:2:0 | bilinéaire = `mwsr` | 0,027 | 30,17 / 36,17 | 1,415 / 24,6 | 0 % | 0,0 % |
| codeiso 4:2:0 | FSR1 | 0,026 | 30,38 / 36,37 | 1,359 / 24,3 | 0,15 % | |
| codeiso 4:2:0 | `mwsr:c444=1` | 0,026 | 30,30 / 36,28 | 1,367 / 24,6 | 0 % | 8,5 % |

Réglages de `c444` essayés sur `codeiso` (netteté 1,5 et 2, τ 0,03, `W_ACROSS` 0,45, `W_ALONG` 0,25) :
ΔE00 0,665 à 0,680, FLIP 0,010 à 0,011 — aucun levier, la table reste celle de la luma. Contrôle SDR à
×2 (texte, jeu, code) : le défaut rend les pixels de P2 au centième ; `c444` y vaut +0,08 dB sur le
texte (la mire a des parties colorées) et rien ailleurs ; `lsharp` −0,06 dB et FLIP +0,002 sur le texte,
rien sur le jeu et le code ; en HDR (J11) `lsharp` perd 0,1 à 0,2 % de ΔE ITP sur les trois mires.

**Verdicts H13.** (a) Sur la syntaxe colorée ordinaire, la luma voit déjà chaque contour : le vote par
canal n'y change pas les pixels (14,4 → 16,0 % de quads, mêmes chiffres) ; le défaut égale FSR1 en
ΔE00 (4:4:4 1,614 contre 1,626 ; 4:2:0 1,742 contre 1,743), reste 0,1 à 0,4 dB sous lui en PSNR de
chroma, et seul des cinq sans dépassement. (b) Sur les bords **isoluminants**, le cas que le mode
existe pour servir, la luma seule ne voit rien (0,1 % de quads, `mwsr` = bilinéaire = SGSR1) ; `c444`
les voit (11,7 %) : FLIP 0,014 → 0,011, ΔE00 −10 %, SSIM 0,9751 → 0,9785, un cheveu derrière FSR1
(0,675 contre 0,654 ; FSR1 affûte tous les canaux par construction, et dépasse 1,2 %). **C9 : mieux que
SGSR1 partout, égal à FSR1 en ΔE00 sur la syntaxe, derrière lui de 3 % sur les bords isoluminants** :
tenu pour la première moitié, à 3 % près pour la seconde. `CHROMA444` reste dans le texte, pour les flux
4:4:4 (`StreamView._yuv444`, P4) ; coût nul quand il est à 0 (constante de pipeline), à mesurer à 1
(J14). (c) **`LUMA_SHARP` sort du texte** : −0,03 de ΔE00 sur la chroma (marginal), perdant en luma SDR
et en HDR.

## 2026-10-21 — J14, les temps de P3 sur le 780M et le RTX (C8 temps, C10 coût, `c444`)

Passes `--p3` du 21/10 (13:55-13:58, créneau de 59 ; Chrome sans tête épinglé par `--use-adapter-luid`,
adaptateur vérifié par une sonde avant chaque passe : `NVIDIA GeForce RTX 5060 Ti`, `AMD Radeon(TM)
Graphics` RDNA 2), GPU p50 en ms, trois tours. Le feed HDR : textures et cible `rgba16float`, mire
`text` de `hdr_mires.py` chargée en demi-flottants ; les réductions en SDR (`bgra8unorm`).

**Feed HDR (C8 temps)**, 720p → 1440p et 1080p → 1440p :

| cellule | 780M ×2 | 780M ×1,33 | RTX ×2 | RTX ×1,33 |
|---|---|---|---|---|
| plancher (`tex-s1`, cible f16) | 0,642 | 0,860 | 0,056 | 0,056 |
| FSR1 | 9,51 | 9,57 | 0,247 | 0,250 |
| SGSR1 | 2,502 | 2,404 | 0,069 | 0,066 |
| **`mwsr`** | **1,517** | **1,390** | **0,058** | **0,057** |
| `mwsr:half=1` | 1,387 | 1,292 | 0,058 | 0,057 |

Pixels sur le RTX (`--hdr-quality`, f16) : `half=1` rend ceux du f32 au millième de ΔE ITP (rampe
31,335 contre 31,325 ; texte 15,376 = 15,376 ; jeu 3,541 contre 3,540), même maximum en nits (10791 /
1156 / 1159), 0 % de dépassement ; et le RTX rend les chiffres de SwiftShader (J11) au centième.

**Réduction (C10 coût)**, `text` ×0,75 (1440p → 1080p), `text` ×0,5 (1440p → 720p), `zone` ×0,33
(2160p → 720p) ; `mwsr` = la table de J12 (2×2 étendue 1, 2×2 étendue 1, 3×3 étendue 1,25 ;
`LINEAR_LIGHT 1`) :

| cellule | 780M ×0,75 | 780M ×0,5 | 780M ×0,33 | RTX ×0,75 | RTX ×0,5 | RTX ×0,33 |
|---|---|---|---|---|---|---|
| plancher (`tex-s1`) | 0,246 | 0,145 | 0,336 | 0,016 | 0,007 | 0,016 |
| FSR1 | 5,284 | 2,364 | | 0,136 | 0,062 | |
| SGSR1 | 1,284 | | | 0,039 | | |
| **`mwsr`** (table) | **0,541** | **0,246** | **1,059** | **0,022** | **0,009** | **0,026** |
| `mwsr:ll=2` (sRGB exact) | 1,585 | 0,709 | 1,426 | 0,048 | 0,021 | 0,040 |
| `mwsr:taps=9` | 1,174 | 0,559 | (table) | 0,048 | 0,022 | (table) |
| `mwsr:taps=16` | | 0,920 | 1,692 | | 0,037 | 0,039 |
| `mwsr:rdown=1.25;ll=2` | | | 1,425 | | | 0,040 |
| **`mwsr` / plancher** | **2,20** | **1,69** | **3,15** | **1,40** | **1,30** | **1,66** |

**4:4:4**, `code` ×2 (720p → 1440p) : 780M plancher 0,379, `mwsr` 0,899, `mwsr:c444=1` 0,964 (+7 %) ;
RTX 0,028, 0,039, 0,042 (+8 %).

**Verdicts H14.** (a) **C8 temps : tenu**, largement : sur le feed HDR `mwsr` vaut 0,16 × FSR1 sur le
780M (1,52 contre 9,51 ms) et 0,23 × sur le RTX (0,058 contre 0,247). La cible f16 coûte à tous
+0,26 ms sur le 780M (plancher 0,385 → 0,642) et le noyau y ajoute les mêmes ≈ 0,9 ms qu'en SDR ; sur
le RTX l'écriture f16 cache le noyau (plancher +2 %). `half` : −9 % sur le 780M, comme en SDR, et les
mêmes pixels jusqu'à 10 000 nits (valeurs ≤ 5,3) : le module f16 est sûr sur le feed HDR. Il reste à
C8 le regard de Bruno sur le M27Q (P5). (b) **`c444=1` : +7-8 %** sur les deux GPU (cohérence et
poids par canal sur le chemin contour) : à prendre quand `StreamView._yuv444` l'annonce, coût nul
sinon (constante de pipeline, chemin supprimé). (c) **C10 coût : non tenu** à la lettre (« ≤
bilinéaire + 30 % ») : 2,20 / 1,69 / 3,15 × le plancher sur le 780M, 1,40 / 1,30 / 1,66 × sur le RTX,
le seul point dans le critère étant le RTX à ×0,5. En absolu : 0,54 ms pour une sortie 1080p sur le
780M (3 % d'une image à 60 Hz), 1,06 ms pour 720p depuis 2160p en 3×3. Lecture : le plancher est un
seul échantillon bilinéaire ; la grille en fait k² et y ajoute le décodage et l'encodage, et sur le
780M cette arithmétique pèse autant que les échantillons (`ll=2` ×2,9, le 4×4 ×3,7 pour rien, J12).
Contre ce que le client fait aujourd'hui en réduction avec un enhancer allumé : FSR1 5,28 ms (×10) et
SGSR1 1,28 (×2,4), tous deux pires que le bilinéaire en qualité (J12). `LINEAR_LIGHT 2` sort des
défauts partout (×2,2 même sur le RTX) et reste une option. (d) **Piste J15, les vues sRGB** : une vue
`rgba8unorm-srgb` sur la texture de la passe 0 et une vue `bgra8unorm-srgb` sur le canvas font
décoder par l'échantillonneur et encoder par la cible, gratuitement et en sRGB exact (`ll=0` au prix de
`ll=0`) ; et l'unique échantillon bilinéaire du plancher devient lui-même un filtre en lumière
linéaire — à ×0,5 exactement c'est la boîte 2×2 de la table, pixel pour pixel, au coût du plancher.
Qualité sur SwiftShader en J15 ; coût au 780M au prochain créneau. La décision sur le coût de C10
appartient à Bruno (porte P3, rapport §6).

## 2026-10-21 — J15, la réduction par vues sRGB : la lumière linéaire faite par le matériel

Idée : une vue `rgba8unorm-srgb` sur la texture d'entrée et une vue `bgra8unorm-srgb` sur la cible
font décoder chaque texel par l'échantillonneur *avant* le filtrage, et encoder le résultat à
l'écriture — sRGB exact, sans une instruction, sur tout GPU WebGPU (`viewFormats` à la création de la
texture et dans la configuration du canvas). Dans le labo (SDR) : `viewFormats` sur `inTex` et
`outTex`, cellules `tex-s1-srgb` (le bilinéaire du plancher à travers les vues) et `mwsr:srgb=1` (la
grille à travers les vues, `LINEAR_LIGHT 0`). SwiftShader, contre le Lanczos-2 de l'hôte en lumière
linéaire (la référence de C10), mires `text` et `zone` ; `mwsr` = la table de J12 (lumière
logicielle, `ll=1`) ; `mwsr:ll=2` = la même grille en sRGB exact *calculé* (décodage après chaque
échantillon bilinéaire).

| échelle, mire | cellule | PSNR | FLIP | ΔE00 | alias | flat |
|---|---|---|---|---|---|---|
| ×0,75 texte | bilinéaire = Smooth2D | 26,00 | 0,055 | 1,810 | | |
| ×0,75 texte | **bilinéaire, vues sRGB** | **30,18** | 0,027 | **1,060** | | |
| ×0,75 texte | `mwsr` 2×2 (`ll=1`) | 28,55 | 0,054 | 1,446 | | |
| ×0,75 texte | `mwsr:ll=2` | 28,90 | 0,051 | 1,365 | | |
| ×0,75 texte | 2×2, vues sRGB | 27,19 | **0,020** | 1,195 | | |
| ×0,75 zone | bilinéaire = Smooth2D | 17,67 | 0,204 | 7,76 | 0,165 | 0,186 |
| ×0,75 zone | **bilinéaire, vues sRGB** | **22,57** | 0,055 | 3,94 | 0,074 | 0,159 |
| ×0,75 zone | `mwsr` 2×2 (`ll=1`) | 20,37 | 0,210 | 6,12 | 0,109 | 0,103 |
| ×0,75 zone | `mwsr:ll=2` | 20,70 | 0,200 | 5,82 | 0,104 | 0,104 |
| ×0,75 zone | 2×2, vues sRGB | 21,98 | **0,036** | **3,38** | **0,037** | **0,093** |
| ×0,5 texte | bilinéaire = Smooth2D | 24,77 | 0,077 | 2,288 | | |
| ×0,5 texte | **bilinéaire, vues sRGB** = 2×2 vues = `ll=2` | **30,76** | 0,025 | **1,051** | | |
| ×0,5 texte | `mwsr` 2×2 (`ll=1`) | 30,63 | **0,015** | 1,083 | | |
| ×0,5 zone | bilinéaire = Smooth2D | 16,86 | 0,213 | 9,89 | 0,166 | 0,143 |
| ×0,5 zone | **bilinéaire, vues sRGB** = 2×2 vues = `ll=2` | **20,32** | **0,030** | **5,07** | **0,090** | 0,134 |
| ×0,5 zone | `mwsr` 2×2 (`ll=1`) | 20,16 | 0,068 | 5,46 | 0,094 | 0,133 |
| ×0,33 texte | bilinéaire (= vues sRGB : échantillon ponctuel) | 19,48 | 0,096 | 3,60 | | |
| ×0,33 texte | Smooth2D | 25,98 | 0,099 | 1,94 | | |
| ×0,33 texte | `mwsr` 3×3 (`ll=1`) | **35,07** | 0,034 | 0,683 | | |
| ×0,33 texte | `mwsr:ll=2` | 34,52 | 0,024 | 0,736 | | |
| ×0,33 texte | **3×3, vues sRGB** | 32,23 | **0,022** | 0,685 | | |
| ×0,33 texte | 2×2, vues sRGB | 29,46 | 0,043 | 1,49 | | |
| ×0,33 zone | bilinéaire (= vues sRGB) | 9,77 | 0,173 | 21,8 | 0,367 | 0,354 |
| ×0,33 zone | Smooth2D | 16,67 | 0,299 | 10,8 | 0,148 | 0,078 |
| ×0,33 zone | `mwsr` 3×3 (`ll=1`) | 22,65 | 0,197 | 5,16 | 0,068 | 0,043 |
| ×0,33 zone | `mwsr:ll=2` | 23,69 | 0,168 | 4,32 | 0,056 | 0,044 |
| ×0,33 zone | **3×3, vues sRGB** | **30,04** | **0,018** | **1,27** | **0,013** | **0,039** |
| ×0,33 zone | 2×2, vues sRGB | 16,86 | 0,072 | 8,13 | 0,107 | 0,113 |

**Verdicts H15.** (a) **Décoder avant de filtrer n'est pas décoder après** : `ll=2` décode des
échantillons bilinéaires déjà mélangés en gamma, les vues décodent les texels. À ×0,5 les deux
coïncident (les échantillons tombent sur les texels : 30,76 dB, pixel pour pixel) ; dès que les
échantillons sont entre les texels (×0,75, ×0,33) le mélange en gamma à l'intérieur de chaque
échantillon biaise la moyenne : sur la zone-plate à ×0,33, 23,7 dB (`ll=2`) contre 30,0 (vues),
aliasing 0,056 contre 0,013, FLIP 0,168 contre 0,018. (b) **Entre ×0,5 et 1:1, un seul échantillon
bilinéaire à travers les vues suffit** : à ×0,75 il bat toutes les grilles en PSNR (30,18 contre
27,2-28,9 sur le texte, 22,57 contre 20,4-22,0 sur la zone), divise le FLIP du plancher par deux
(0,027 ; 0,055 contre 0,204 sur la zone) et l'aliasing par 2,2 (0,074 ≤ Smooth2D 0,165) ; la 2×2 à
travers les vues fait un peu mieux en FLIP et en aliasing (0,020 ; 0,037) pour 3 dB de moins et
quatre échantillons. À ×0,5 c'est la boîte exacte de la table. **Son coût est le plancher** (c'est
l'échantillon que le client fait déjà) : **C10 (×0,75, ×0,5) tenu en coût (+0 %) et en qualité**,
mieux qu'avec la grille de J12. *Confirmé au GPU (passe de 14:33, trois tours) : les vues ne coûtent
rien (`tex-s1-srgb` = `tex-s1` : 780M 0,241 = 0,241 ms à ×0,75, RTX 0,016 = 0,016) et l'échantillon
unique vaut le plancher (780M 0,250 à ×0,75, 0,146 = 0,146 à ×0,5 ; RTX 0,016 et 0,007, égaux) ; la
2×2 à travers les vues coûte sa grille calculée (0,539 = 0,539), comme `ll=0` : sur le 780M aussi, ce
sont les échantillons qui coûtent, pas le carré et la racine ; seul le `pow` de `ll=2` pèse.* (c) **Sous ×0,5, la 3×3 à travers les vues** : sur la zone-plate
+7,4 dB, aliasing ÷ 5 et FLIP ÷ 11 contre la même grille en lumière logicielle ; sur le texte −2,8 dB
de PSNR (32,2 contre 35,1) mais FLIP 0,022 contre 0,034 à ΔE00 égal — l'œil (FLIP) la préfère, le
PSNR non ; la 2×2 n'y suffit pas (16,9 dB sur la zone). Neuf échantillons sans arithmétique : au GPU
(14:33) la 3×3 à travers les vues coûte sa grille calculée (780M 1,041 contre 1,058 ms ; RTX 0,026
les deux), 3,1 × le plancher ; le plancher y est un échantillon ponctuel (9,8 dB sur la zone,
inutilisable), le « + 30 % » n'y a pas de sens, la référence utile est Smooth2D, que le navigateur
paie sur le CPU. (d) **Décisions** : `MWSR_DOWN_TAPS_SRGB = [[0,5, 1, 1], [0,25, 9, 1,25], [0, 16,
1,25]]`, `mwsrRegime(…, { srgb: true })` rend `taps 1` jusqu'à ×0,5 et `linearLight 0` ; la table
logicielle (`MWSR_DOWN_TAPS`, 2×2 d'abord, `LINEAR_LIGHT 1`) reste pour les feeds sans vue sRGB (le
`rgba16float` du HDR, un navigateur qui refuserait `viewFormats`). Ce que le renderer fait en P4 :
`viewFormats: ['rgba8unorm-srgb']` sur la texture de la passe 0, `viewFormats: [format + '-srgb']`
dans la configuration du canvas SDR, et en mode `down` lier la vue sRGB de l'entrée et dessiner dans
la vue sRGB du canvas (`getCurrentTexture().createView({ format })`) ; en mode `up` et à 1:1 les vues
ordinaires (le noyau travaille en gamma, à dessein). Dorés : `mwsr:srgb=1` ajouté aux trois cas de
réduction, `golden.json` régénéré.

## 2026-10-21 — J16, le realme Note 60 (Mali-G57 MP1, Chrome Android) : le reste de P0, `mwsr`, la réduction

Créneau de Bruno (14:26-14:31) : la page servie en HTTPS depuis DualRTX (`scaler_lab.py --serve
0.0.0.0:8766 --tag realme`, huit liens courts, résultats `bench-out/scaler-lab/phone-realme-*.json` ;
aucune règle de pare-feu à ouvrir : les règles entrantes « Python » existantes couvrent le port sur le
profil public du LAN). Adaptateur `arm valhall` (WebGPU de Chrome Android) ; `shader-f16`,
`timestamp-query`, `subgroups`, `float32-filterable`, `texture-formats-tier2`, ASTC et ETC2 ; décodeur
H.264 matériel à **sortie RGBA** (pas NV12 : un échantillon de la texture externe vaut un échantillon
RGBA, `ext-s1` = `tex-s1`). Les horodatages d'un lot s'additionnent (×2 texte : lot 18,0 ms contre
18,6 à une soumission par itération ; plancher 3,6 contre 4,8) : lecture directe, les cas `-single`
sont inutiles ici. Dispersion ≤ 2 % sauf les cellules sous 2 ms (p90 jusqu'à ×1,6 : bruit d'horloge).
2 tours × 4 lots × 8 itérations. GPU p50 en ms :

| cas | plancher | externe `ext-s1` | SGSR1 | FSR1 | **`mwsr`** | `half=1` | `dering=0` | passe 0 + `mwsr` |
|---|---|---|---|---|---|---|---|---|
| ×2 texte, 720p → 1440p | 3,60 | 3,67 | 24,5 | 83,1 | **18,0** | 16,3 | 13,2 | 18,8 (0,92 + 17,9) |
| ×2 jeu | 3,67 | 3,74 | 23,3 | 83,1 | **8,78** | 7,60 | 7,41 | 9,90 (0,92 + 9,11) |
| ×1,33 texte, 1080p → 1440p | 3,60 | | 22,5 | 83,2 | **16,7** | 14,9 | 12,3 | |
| **l'écran du realme** : texte, 720p → 1600×720 | 1,18 | 1,25 | 8,39 | 26,0 | **5,90** | 5,31 | 4,33 | 6,75 (0,85 + 5,96) |

Chaînes du produit à ×2 texte (`chain-*`, une image par tampon) : `off` 4,00 ms de GPU pour 22,3 ms de
mur par `draw()` ; SGSR1 26,3 / 46,7 ; FSR1 85,3 / 110.

Réduction, texte :

| cas | plancher | plancher, vues sRGB | `mwsr` 2×2 (`ll=1`) | **un échantillon, vues sRGB** | 2×2, vues sRGB | `ll=2` | FSR1 |
|---|---|---|---|---|---|---|---|
| ×0,67, 1080p → 1600×720 | 1,31 (p90 2,10) | 1,18 | 3,80 | **1,18** | 3,80 | | 26,0 |
| ×0,5, 1440p → 720p | 1,05 | 0,92 | 3,08 | **0,98** | | 8,06 | |

**Verdicts H16.** (a) **C1 tenue sur le Mali** : noyau seul `mwsr` / SGSR1 = 0,74 (texte ×2), 0,38
(jeu), 0,74 (texte ×1,33), 0,70 (écran) — le critère dit ≤ 0,9 noyau seul, ≤ 0,8 jeu, ≤ 1,0 texte ;
avec `half` 0,66 / 0,33 / 0,66 / 0,63 ; chaîne passe 0 + `mwsr` 18,8 contre la chaîne SGSR1 26,3
(0,72). C2 au passage : 0,22 × FSR1. (b) À la taille de l'écran (1600×720), passe 0 + `mwsr` =
6,75 ms par image (`half` ≈ 6,1, `dering=0` ≈ 5,2) : tient dans les 11,1 ms d'une image à 90 Hz,
large à 60 Hz ; la chaîne SGSR1 y fait 9,6 ms et FSR1 27 ms — ce que le client propose aujourd'hui sur
ce téléphone fait tomber des images. (c) `half` vaut 10 % sur Mali, comme sur le 780M : à prendre ;
`dering=0` vaut 27 % sur le texte et 16 % sur le jeu : le cran performance existe. (d) **La passe 0
coûte 0,85-0,92 ms** à 720p sur ce téléphone, où la texture externe est déjà RGBA (`ext-s1` =
`tex-s1`) : 13-15 % du noyau à la taille de l'écran ; `ext-mwsr` n'était pas dans les liens (à mesurer
au prochain créneau : si l'externe RGBA vaut la texture, la passe 0 est évitable sur cette famille
d'Android, décision P4 par `frames.format`). (e) **Réduction : l'échantillon unique à travers les vues
sRGB coûte le plancher** (1,18 = 1,18 à ×0,67 ; 0,98 contre 0,92-1,05 à ×0,5) : **C10 tenu en coût sur
la machine du critère** (« téléphone 1080p ») ; la grille 2×2 coûte 3,2 × le plancher, vues ou pas (sur
Mali ce sont les échantillons, pas l'arithmétique), `ll=2` 7,7 ×. (f) Le mur par `draw()` de la chaîne
`off` (22 ms pour 4 ms de GPU) dit le coût CPU du chemin du renderer sur ce SoC (Unisoc T612) : à
regarder en P5 sur le flux réel, hors shader.

## 2026-10-21 — J17, P4.1 : la clé `mwsr` du `WebGpuRenderer`, et la chaîne du produit dans les dorés

Intégration (commit `e965e9f9`) : un pipeline par régime (`mwsrRegimes()`), tous à la création ;
`viewFormats` `-srgb` sur le canvas SDR (`ctx.configure`, dans un `try` : repli lumière logicielle) et
sur `_inputTex` ; la réduction lit la vue sRGB de l'entrée et dessine dans celle du canvas, le noyau les
vues ordinaires ; `half` demandé à la création du device hors NVIDIA ; `CHROMA444` depuis `yuv444`
(StreamView, worker). Labo : cellule `chain-mwsr` (le renderer du produit sur un `OffscreenCanvas`) ;
captures et dumps des chaînes par `transferToImageBitmap` → `copyExternalImageToTexture` vers la
texture de sortie ; avec `codec=none` les chaînes reçoivent des `VideoFrame` RGBA faites des mires (les
texels exacts de la texture d'entrée du labo) ; `dump=all` n'exclut plus les chaînes.

Dorés (SwiftShader, `--golden`, 22 s les neuf cas) : `chain-mwsr` = `mwsr` au bit près sur les six cas
d'agrandissement (texte, jeu, code ; 720p et 1080p → 1440p) et = `mwsr:srgb=1` sur les trois cas à
×0,5 ; les empreintes des autres cellules inchangées (`mwsrRegimes()` n'a pas touché au texte).
Trois tours pour y arriver : la chaîne ne tournait pas (« no VideoFrame » : les mires ne faisaient pas
d'images sans codec), puis n'était pas dumpée (`dump=all` filtrait les chaînes). Verdict H17 : **le
produit fait ce que la cellule faisait**, vues sRGB comprises ; le coût des vues a été confirmé au GPU
en J15.

## 2026-10-21 — J18, P4.2 : le jumeau GLSL (`gl-mwsr`) et la conformité des jumeaux (C11)

`mwsrGlsl()` depuis les mêmes tables (overrides en constantes, deux `vec4` d'uniformes, `mediump` sur
le chemin contour), `WebGlRenderer` sous `gl-mwsr`. Au labo : `chain-gl-<passe>` (jeu `glchain`) ;
mais forcer ANGLE sur SwiftShader (`--use-gl=angle --use-angle=swiftshader`) éteint WebGPU dans ce
Chrome (`requestAdapter` rend `null`, avec ou sans `--ignore-gpu-blocklist`,
`--use-webgpu-adapter=swiftshader`), et sans ce forçage WebGL partait sur le GPU par défaut de la
machine (interdit sans go) et, de plus, **pendait** : une promesse jamais résolue a retenu le pilote dix
minutes (`Runtime.evaluate` avec `awaitPromise`). D'où : un mode `gl=1` de la page (WebGL2 seul, dumps
par un canvas 2D, mêmes noms de fichiers), `--webgl-swiftshader` au pilote (un second Chrome), le flux
`--conformity` qui compare ce qui est sur le disque, et le chien de garde `--page-timeout` (le journal
de la page, le cas échoue).

Premier passage (texte ×2, GLSL contre `mwsr`) : 27,7 dB, 28 % des pixels différents, max 221/255 ;
à ×0,5 : un bloc de 30×30 à 174/255. Trois causes :

1. **le signe de `dFdy`** : fenêtre GL y vers le haut → `dFdy` = −`dpdy` ; sans la négation la normale
   est en miroir et les taps le long / en travers s'échangent sur les diagonales. Corrigé : 34,3 dB,
   25 % différents, 17 % au-delà de 2/255, max 76 ;
2. **l'image dumpée** : la chaîne dessinait l'image du clip où en était le curseur (le carré mobile).
   Corrigé (première image) : la réduction passe à ≤ 1/255 (texte, code), 3/255 sur 0,009 % de la
   zone-plate ;
3. **la ligne de référence des dérivées coarse** : plats concordants (0,6 % différents, vote au
   seuil), contours différents à 44 % mais autant d'un côté que de l'autre de la bilinéaire (écart
   moyen à la bilinéaire 20,55 contre 20,54/255). Essai `mwsr:fine=1` (`dpdxFine`/`dpdyFine`) : coarse
   contre fine = 13,4 % des pixels au-delà de 2/255, max 83 ; GL contre fine 13,1 %, contre coarse
   16,9 % : le GL n'est ni l'un ni l'autre — la ligne du quad que prend une dérivée coarse est le choix
   de l'implémentation et diffère entre les deux espaces fenêtre. Inhérent, pas un bug de port.

Verdict H18 : **C11 reformulé**, tenu sous sa nouvelle forme. Pixels : chaîne WebGPU identique (0/255,
neuf cas) ; jumeau GLSL ≤ 2/255 sur 99,9 % des pixels et ≤ 4 au plus là où aucune dérivée n'intervient
(réduction : 1/255 ; zone-plate 3/255 sur 0,009 % = précision sous-texel des échantillonneurs).
Qualité face à la vérité terrain (`--quality`, ×2) :

| contenu | `mwsr` WGSL : PSNR / SSIM / FLIP | `gl-mwsr` GLSL | bilinéaire | FSR1 |
|---|---|---|---|---|
| texte | 17,41 / 0,8415 / 0,071 | 17,44 / 0,8425 / 0,071 | 16,99 / 0,816 / 0,090 | 17,57 / 0,845 / 0,068 |
| jeu | 35,84 / 0,8816 / 0,019 | 35,84 / 0,8816 / 0,019 | 35,01 / 0,880 / 0,020 | 35,55 / 0,887 / 0,017 |
| code | 26,95 / 0,9555 / 0,029 | 26,96 / 0,9559 / 0,029 | 26,96 / 0,953 / 0,034 | 27,35 / 0,951 / 0,024 |

0 % de dépassement des deux côtés ; le jumeau vaut le noyau à 0,000 FLIP et 0,025 dB près. Le job CI
`scaler-lab` (non bloquant) rejoue les deux côtés sur un runner hébergé.

## 2026-10-21 — J19, la CI : la chaîne WebGPU noire sur le runner Linux, la capture par la texture

Première exécution du job `scaler-lab` (CI 39627353471, signalée par 59) : côté WebGPU (SwiftShader
Subzero sur Ubuntu), `chain-mwsr` hors tolérance sur les neuf cas, ~100 % des pixels, PSNR 0,4 à
15,6 dB ; en qualité, `chain-mwsr` à 0,45 / 7,14 / 14,94 dB (texte, jeu, code) avec SSIM ≈ 0 et 95-99 %
de dépassements, le noyau seul sain (18,43 / 35,93 / 27,08 : les polices d'Ubuntu, pas celles de
DualRTX). Ces PSNR sont ceux d'une **image noire** contre les trois mires (le texte presque blanc à
0,45 dB, le code sombre à 15) : le `transferToImageBitmap()` d'un `OffscreenCanvas` WebGPU ne rend pas
l'image présentée sur ce chemin logiciel Linux, alors qu'il la rendait au bit près sous Windows (J17).

Correctif : pendant le dessin du dump, un crochet sur `GPUCanvasContext.getCurrentTexture` donne au
renderer une texture du labo (même device, format, taille et `viewFormats` que la swap chain, `COPY_SRC`),
relue par `copyTextureToBuffer` sur ce device puis écrite dans la texture de sortie du labo ; la chaîne
WebGL2 garde son tampon de dessin. Sur DualRTX (SwiftShader) : toujours exact sur les neuf cas dorés,
conformité OK des deux côtés. Pour qu'une exécution que personne ne regarde dise ce qui s'est passé :
les lignes console des renderers et tous les avertissements vont dans le journal de la page, les
erreurs non capturées des devices du produit rejoignent celles du passage, le pilote garde le journal de
la page avec chaque résultat (`pageLog`), le flux de conformité imprime le renderer et le GPU de chaque
chaîne. Au passage : une page dont l'import statique du module échouait restait muette jusqu'au
délai (un cas sur douze côté WebGL2, 18:10) — import dynamique rapporté en résultat (rechargé aussitôt
par la règle des transitoires), et une page muette au délai est rechargée une fois. Verdict H19 :
**à confirmer par la prochaine exécution de la CI** ; si la chaîne y reste fausse avec la texture relue
directement, c'est le renderer sur cette plateforme et non plus la lecture.

## 2026-10-21 — J20, la porte P4 sur ordinateur : WebGPU contre WebGL2 à shader égal

**La question** (plan §3.6, §8.1, wiki 15.3) : avec le même algorithme dans les deux renderers du
produit, quelle saveur en SDR par classe d'appareil ? Le jeu `--p4` (`p4_flows.py`) joue les chaînes du
produit `off`, SGSR1, FSR1 et `mwsr` dans les deux saveurs, sur les mêmes images (douze images H.264
décodées), à ×2 (texte, jeu, interface), ×1,33 et ×0,67 (4K → 1440p), saturé (`back`) et à 60 i/s
(`tick`), 48 draws par chaîne en deux tours ABBA. Trois chiffres par draw : **`submit`**, le temps du
thread principal (WebGPU : `lastDraw.submitMs` du renderer, encodage et soumission ; WebGL2 : la durée de
`draw()`, qui ne fait qu'empiler) ; **`done`**, du début du draw à la fin du GPU (WebGPU : `draw()`
lui-même, qui attend `onSubmittedWorkDone` ; WebGL2 : une barrière `fenceSync` sondée tâche par tâche) ;
**`gpu`**, le temps du GPU seul (WebGPU : les passes horodatées, passe 0 et noyau ; WebGL2 :
`EXT_disjoint_timer_query_webgl2` autour du draw, téléversement compris).

Trois pièges de l'instrument, trouvés sur SwiftShader avant tout GPU : (1) **`gl.finish()` de Chrome est
un flush** (« Intentionally a flush, not a finish » dans `webgl_rendering_context_base.cc`) : au premier
essai `done` valait `submit` (0,16 ms) quand l'horodatage lisait 28 ms ; la barrière sondée par
`getSyncParameter` (ce que lit le renderer lui-même pour savoir si le GPU est en retard) rend 38 ms,
cohérent ; (2) le niveau H.264 de l'encodeur du labo (5.0, 22 080 macroblocs) refuse la 4K : niveau 5.1
au-delà ; (3) la page `gl=1` ignorait `pace=tick`. L'horodatage WebGL2 existe sur ANGLE D3D11 (RTX,
780M) et sur ANGLE-SwiftShader.

**Passes** (go de 59, un GPU à la fois, Chrome sans tête épinglé par LUID, sonde WebGPU + WebGL2 avant
chaque jeu) : 780M 21:44-21:45 (dix pages, une minute) puis ×0,67 à 21:49 ; RTX 21:46-21:48 ; aucun
processus restant. À 60 i/s, p50 en ms, `done` WebGPU / WebGL2 (`gpu` entre parenthèses) :

| cas | GPU | `off` | SGSR1 | FSR1 | **`mwsr`** |
|---|---|---|---|---|---|
| ×2 texte | RTX | 4,37 / 2,09 (0,03 / 0,12) | 4,06 / 1,77 (0,09 / 0,21) | 4,65 / 3,23 (0,57 / 1,42) | **4,29 / 2,01** (0,07 / 0,34) |
| ×2 jeu | RTX | 4,24 / 2,08 | 3,61 / 1,64 | 4,50 / 3,06 | **3,99 / 1,77** (0,05 / 0,09) |
| ×1,33 texte | RTX | 5,44 / 3,26 | 4,07 / 3,19 | 4,40 / 3,20 | **4,09 / 2,16** (0,14 / 0,12) |
| ×0,67 texte | RTX | 8,49 / 1,87 | 4,45 / 1,75 | 4,04 / 1,92 | **4,59 / 3,28** (0,21 / 0,23) |
| ×2 texte | 780M | 4,62 / 4,09 (0,53 / 0,66) | 6,84 / 6,06 (2,81 / 2,69) | 13,34 / 10,55 (9,42 / 7,92) | **5,61 / 4,75** (1,59 / 1,38) |
| ×2 jeu | 780M | 4,34 / 3,84 | 6,59 / 5,70 | 13,75 / 11,17 | **5,00 / 4,25** (0,81 / 0,81) |
| ×2 interface | 780M | 4,57 / 3,94 | 6,00 / 4,42 | 13,50 / 10,93 | **5,45 / 4,13** (0,84 / 0,83) |
| ×1,33 texte | 780M | 5,05 / 5,57 | 7,75 / 7,00 | 13,78 / 12,24 | **6,30 / 5,80** (1,57 / 1,40) |
| ×0,67 texte | 780M | 7,10 / 8,88 (0,70 / 1,57) | 9,47 / 10,27 | 16,08 / 15,12 | **7,59 / 9,30** (1,57 / 1,98) |

Saturé : RTX `mwsr` 3,3-3,7 ms (WebGPU) contre 0,81-0,87 (WebGL2), 4 × ; 780M 3,4-4,7 contre 2,6-4,1,
1,15-1,5 ×. Thread principal à 60 i/s : égal, 0,25-0,35 ms p50 des deux côtés (RTX ×1,33 : 0,28 contre
0,44 pour WebGL2) ; le p99 de 48 draws est leur maximum, et des arrêts isolés de 100 à 300 ms
apparaissent dans les deux saveurs (une image sur quarante-huit, pas une tendance).

**Lecture.** Le shader est à égalité sur le GPU : `mwsr` WGSL et GLSL à ±15 % l'un de l'autre, le
WebGL2 comptant en plus le téléversement de l'image. Ce qui sépare les saveurs est la chaîne autour :
l'import de la texture externe, la soumission et l'attente `onSubmittedWorkDone` coûtent 4 ms sur le RTX
quelle que soit la passe (`off` compris, 0,03 ms de GPU pour 4,4 ms de `done`), et 0,5 à 1,3 ms de plus
que WebGL2 sur le 780M. L'observation du wiki 15.3 tient avec le nouveau shader : **sur ordinateur,
WebGL2 reste la saveur SDR** (RTX 1,9-2,3 × à 60 i/s ; 780M 1,1-1,2 ×, « égalité dans les marges, la
production reste », WebGL2 saturé). Une exception, à peser en P6 : la **réduction 4K → 1440p sur le
780M**, où les vues sRGB (un échantillon décodé par le matériel, J15) et un import 4K moins cher donnent
WebGPU 7,6 ms contre 9,3 (0,82 ×, GPU 1,57 contre 1,98) ; sur le RTX, où le GPU n'est pas le goulot, WebGL2
garde l'avantage même là (1,40 ×). Verdict H20 : **WebGL2 en SDR sur RTX et 780M**, la décision par
classe d'appareil reste ouverte pour Apple et Mali (créneaux de Bruno, mêmes liens `--serve --p4`).
Tables complètes : `bench-out/scaler-lab/p4rtx-gate.md`, `p4amd-gate.md` (`--p4-table`).

**Le drapeau `mw_mwsr` sur la `--dev` de DualRTX** (22:04-22:14, créneau de 59, `--dev` de 09e31b38
vérifiée au hachage, deux Chrome sans tête : l'un tout SwiftShader, l'autre ANGLE sur l'AMD épinglé et
WebGPU sur SwiftShader, décodage logiciel, flux de l'écran 1, image vive, aucune erreur console) : `auto`
+ drapeau → « WebGL MWSR » (684×384 → ×1,34) ; `auto` sans drapeau → « WebGL FSR1 » ; `gl-mwsr` choisi →
« WebGL MWSR » ; `mwsr` choisi sans WebGPU → Canvas2D (le repli de toute saveur WebGPU) ; `mwsr` choisi
avec WebGPU → « MWSR », renderer créé avec les vues sRGB ; flux 896×504 dans un canvas 896×504 → « Off
(1:1) ». Le menu debug des deux saveurs n'apparaît qu'en mode debug du serveur (réglage de la `--dev`
non touché) : couvert par les tests unitaires.

## 2026-10-21 — J21, le repli du renderer WebGPU quand l'import d'une image est refusé

Décision de Bruno (relayée par 59, 22:20) : l'écran noir de la CI se corrige avant la v0.4.1. Choix :
**copier l'image dans la texture d'entrée** plutôt que revenir à Canvas2D — l'upscaler continue de
tourner, rien ne change à l'écran ni dans l'overlay. Dès le premier refus d'`importExternalTexture`,
`draw()` fait `createImageBitmap(frame)` puis `copyExternalImageToTexture` dans `inputTex` (`COPY_DST`
ajouté) : la copie tient lieu de passe 0 ; la copie nue vers le canvas (`off`, 1:1) lit `inputTex` par un
blit `texture_2d` (`BLIT_TEX_WGSL`). L'import est retenté tous les 300 draws (un refus passager rend le
chemin rapide de lui-même) ; un seul avertissement console ; un draw qui échoue n'est journalisé qu'une
fois par message distinct. En HDR le bitmap est le rendu SDR du navigateur : une image, pas l'image HDR.

Vérification : test `vitest` à device simulé (`WebGpuRendererImport.test.js`, cinq cas : import
accepté, refusé puis copié avec une seule ligne, retenté 300 draws plus tard, chemin upscaler sans passe
0, journal une fois par message) ; suite complète 1659 tests verts ; labo `importfail=1` (le crochet
refuse l'import aux seuls devices du produit) : **dorés exacts sur les neuf cas** par le repli comme par
l'import, conformité OK. Reste la mesure du coût du repli sur un GPU (créneau à demander à 59) : sur
SwiftShader la chaîne `chain-mwsr` passe par le bitmap sans écart de pixel.

**Le coût du repli, 22/10 00:21-00:23 (780M, créneau de 59 ; même sonde et mêmes conditions que la
porte ; `scaler_lab.py --p4 --extra importfail=1 --tag p4amdbm`, table par
`p4_fallback_compare.py bench-out/scaler-lab p4amd p4amdbm`).** `done` p50 de la chaîne WebGPU `mwsr`,
repli contre import : ×2 texte 5,34 contre 4,11 ms saturé (×1,30) et 6,55 contre 5,61 à 60 i/s
(×1,17) ; ×2 jeu ×1,21 / ×1,22 ; ×2 interface ×0,98 / ×1,02 ; ×1,33 texte ×1,26 / ×1,20 ; réduction
×0,67 (entrée 4K) 11,45 contre 6,42 (×1,78) et 13,34 contre 7,60 (×1,76). Témoin : les cellules WebGL2
des deux passes, que `importfail` ne touche pas, dérivent de 0,91 à 1,21 (médiane 1,03). Lecture :
≈ +1 ms par image à 720p → 1440p (au-dessus du bruit sur la plupart des lignes, pas toutes), +5 à 6 ms
quand l'entrée est en 4K (le bitmap d'une image 4K). Le fil principal n'est pas plus chargé (`submit`
p50 égal ou plus bas : la création du bitmap est asynchrone) ; le temps GPU horodaté baisse de 5 à
15 % (la passe 0 n'est plus une passe, la copie passe par la file) et de moitié à ×0,67. Chemin de
secours seulement, jamais le chemin normal : acceptable, une image vaut mieux qu'un écran noir.

## 2026-10-22 — J22, mw-arm à distance : pas de GPU pour un Chrome lancé par SSH

Créneau de 59 (00:26-00:38). Recette : tunnel SSH (`-L 9222` pour DevTools, `-R 8767` pour le serveur
du labo), `scaler_lab.py --remote-cdp 9222 --http-port 8767 --gl` depuis DualRTX, la page en
`http://127.0.0.1:8767` vue de mw-arm (contexte sécurisé, aucun certificat à accepter). Trois
constats. (1) Une tâche planifiée `Interactive` reste en file (`Queued`) : personne n'est connecté à la
console de mw-arm. (2) Un Chrome `--headless=new` lancé depuis la session SSH (séance 0) n'a **aucun
GPU** (`gl=disabled`, aucun adaptateur énuméré) ; avec `--use-gl=angle --use-angle=d3d11
--ignore-gpu-blocklist`, l'Adreno 618 est énuméré et `webgl: enabled`, mais chaque contexte est perdu à
la création et le domaine finit bloqué (« Web page caused context loss and was blocked ») : la séance 0
n'a pas accès au périphérique. (3) Couper le bac à sable du processus GPU n'est pas une option sans
l'accord de Bruno. La porte `mw-arm` se fait donc avec sa console ouverte (Bruno connecté) : la tâche
`Interactive` du 06/09 marche alors, et la même recette `--remote-cdp` s'applique. Tout rendu à 00:38 :
0 Chrome, tâche et profil effacés, tunnel fermé, aucun GPU de DualRTX pris.

## 2026-10-22 — J23, la porte P4 sur l'iPhone 13 Pro (Safari, iOS 26.5) : WebGPU gagne partout

Créneau de Bruno (08:51-09:31, liens servis depuis DualRTX, `--tag iphone --p4 --screen 2532x1170`,
18 pages, consignes relayées par 59). Les deux chaînes du produit sur WebKit (adaptateur `apple`, WebGPU
avec horodatages, WebGL2 sans timer). `done` p50 en ms, WebGPU / WebGL2, `mwsr` :

| cas | saturé | 60 i/s |
|---|---|---|
| ×2 texte 720p → 1440p | 2,96 / 7,40 | 3,76 / 7,12 |
| ×2 jeu | 2,26 / 7,00 | 3,06 / 7,62 |
| ×2 interface | 2,06 / 6,68 | 3,14 / 7,58 |
| ×1,33 texte | 2,70 / 10,96 | 3,12 / 12,38 |
| ×0,67 texte (entrée 4K) | 2,82 / 29,08 | 3,80 / 29,26 |
| écran ×2 texte 1264×584 → 2532×1170 | 2,58 / 6,32 | 3,52 / 6,80 |
| écran ×2 jeu | 2,42 / 6,34 | 3,44 / 6,78 |
| écran ×1,33 texte | 2,80 / 9,74 | 3,06 / 10,52 |
| écran ×0,67 texte | 2,90 / 23,56 | 3,66 / 23,14 |

Verdict de la règle : **WebGPU** dans les deux régimes (`done` 0,25-0,53 ×, fil principal 0,01-0,05 ×).
La cause est l'envoi de l'image : sur WebKit, `texImage2D` d'une VideoFrame coûte au fil principal 2,5 ms
à 540p, 3,1 à 720p, 6,7 à 1080p et 19-24 ms à 4K (`submit` des `chain-gl-*`), quand l'import WebGPU vaut
0,02-0,16 ms ; le GPU lui-même (`mwsr` 1,3-2,4 ms horodatés à ×2) n'est pas en cause. Conséquence : en
WebGL2, l'iPhone ne tient pas 60 i/s dès une entrée 1080p. Proposition pour Bruno (plan §9, classe Apple
mobile) : la saveur SDR y est WebGPU quand il est là (iOS 26), `gl-mwsr` sinon.

Deux pièges de passe. (1) Chaque page a été postée deux fois : la seconde, plus lente (28-32 s au lieu de
3-7), était le **realme sur les mêmes liens**, ouvert en parallèle par Bruno (reconnu à l'agent
utilisateur, fichiers renommés `phone-realme-*`, journal J26) ; cru d'abord un préchargement de Safari, la
page attend désormais d'être visible avant de mesurer et compte le temps caché (`hiddenMs`), et la table
lit, parmi les fichiers postés d'un cas, une passe complète (toutes les cellules du cas, aucune erreur) au
premier plan, la plus courte à défaut (`_best_posted`) : les fichiers de P0 du même tag ne comptent plus.
(2) Le motif `phone-<tag>-<cas>-*.json` attrapait aussi les fichiers du cas `-tick` : corrigé avant la
passe.

## 2026-10-22 — J24, la porte P4 sur le Mac M1 Pro (Chrome 155 sans tête, `metal-3`)

Créneau de Bruno (09:15-09:16, Mac rendu à 09:18) : Chrome de labo lancé par SSH dans la session de Léo
(`open -na "Google Chrome" --args --headless=new --remote-debugging-port=9223 …`, profil jetable,
`--mute-audio`), piloté depuis DualRTX par `scaler_lab.py --remote-cdp 9223 --http-port 8769 --p4
--screen 3600x2338` à travers `ssh -L 9223 -R 8769` ; mot pour Léo par osascript (launchd gui/501),
retiré à la fin ; 16 cas sur 18 (les deux « réduction à 1,5 × l'écran », entrée 5400×3504, sans encodeur
H.264 au niveau 5.1 : limite du labo). `done` p50 en ms, WebGPU / WebGL2, `mwsr` :

| cas | saturé | 60 i/s |
|---|---|---|
| ×2 texte | 1,46 / 2,43 | 4,48 / 3,21 |
| ×2 jeu | 1,05 / 2,12 | 3,70 / 3,54 |
| ×2 interface | 1,05 / 2,03 | 4,08 / 3,86 |
| ×1,33 texte | 1,48 / 2,76 | 4,75 / 3,97 |
| ×0,67 texte (entrée 4K) | 1,37 / 5,63 | 4,79 / 5,68 |
| écran ×2 texte 1800×1168 → 3600×2338 | 2,23 / 4,14 | 5,57 / 4,51 |
| écran ×2 jeu | 1,77 / 3,17 | 5,04 / 3,45 |
| écran ×1,33 texte | 1,60 / 4,94 | 5,57 / 5,08 |

Verdict de la règle : saturé, **WebGPU** (0,50-0,60 ×, fil principal 0,03 contre 0,10 ms) ; à 60 i/s,
**égalité dans les marges** (WebGPU 1,05-1,40 × WebGL2, son fil principal 0,54-0,67 ms contre 0,19-0,25)
→ la saveur de production, WebGL2, reste sur Mac dans Chrome. Même lecture que sur RTX et 780M : la chaîne
WebGPU cadencée paie l'attente de présentation, pas le shader (GPU horodaté égal). Réduction ×0,67 à
60 i/s : WebGPU 0,84 ×. Safari macOS non mesuré (le labo pilote Chrome).

## 2026-10-22 — J25, la porte P4 sur mw-arm (Adreno 618, WebGL2 seul) : 8 cas, puis hors réseau

Créneau de 59 (09:15-09:26), Bruno connecté à la console : la tâche planifiée `Interactive` lance un Chrome
sans tête avec DevTools, piloté par `--remote-cdp 9222 --http-port 8767 --gl --screen 1920x1080` à travers
le tunnel (la recette de J22 marche dès qu'une session console existe : WebGL2 sur l'Adreno,
`EXT_disjoint_timer_query_webgl2` présent). À 09:26 mw-arm a quitté le réseau (DevTools puis SSH coupés) :
8 cas sur 18, les tailles standard sauf la réduction 4K, aucun cas à la taille de l'écran ; le ménage
(Chrome, tâche, profil, scripts) attend son retour. GPU p50 en ms par image, 720p → 1440p (machine qui
pagine : p99 de 0,3 à 9 s sur toutes les cellules, à lire sur les p50 seulement) :

| cas, saturé / 60 i/s | `gl-off` | `gl-sgsr` | `gl-fsr1` | `gl-mwsr` | mwsr / SGSR1 |
|---|---|---|---|---|---|
| ×2 texte | 2,57 / 2,61 | 10,61 / 10,62 | 21,33 / 21,38 | 8,15 / 7,01 | 0,77 / 0,66 |
| ×2 jeu | 2,60 / 2,59 | 8,24 / 8,37 | 21,43 / 21,50 | 5,20 / 6,26 | 0,63 / 0,75 |
| ×2 interface | 2,55 / 2,57 | 5,70 / 7,69 | 21,40 / 21,36 | 6,35 / 6,42 | 1,11 / 0,83 |
| ×1,33 texte | 2,61 / 2,82 | 10,94 / 10,89 | 21,70 / 21,74 | 6,97 / 7,02 | 0,64 / 0,64 |

`done` p50 : `gl-mwsr` 14-17 ms, `gl-off` 12-15, `gl-fsr1` 29-35. Verdict : pas de WebGPU, donc WebGL2
par nécessité ; `gl-mwsr` y tourne sans erreur, tient 60 i/s (FSR1 non) et coûte 0,63-0,77 × SGSR1 (le
choix Auto actuel sur Snapdragon, `isSnapdragonGpu()`) sur texte, jeu et ×1,33, égal sur l'interface
(1,11 saturé, 0,83 à 60 i/s : le bruit de cette machine) : **C1 tenue sur l'Adreno 618**. Proposition pour
Bruno : l'Auto Snapdragon passe à `gl-mwsr` avec le drapeau. Les cas manquants ne changent pas cette
lecture ; mw-arm n'est pas redemandé pour eux.

## 2026-10-22 — J26, la porte P4 sur le realme Note 60 (Mali-G57 MP1, Chrome Android) : égalité

Bruno a ouvert les liens de l'iPhone sur le realme en même temps (09:14-09:31) : 17 pages sur 18 postées
sous le tag `iphone` (les 21 fichiers Android, reconnus à l'agent utilisateur, renommés `phone-realme-*`),
les cas « écran » donc à la taille de l'iPhone (2532×1170), pas à la sienne (1600×720) ; le serveur
préparé pour lui (port 8768) n'a pas servi. Deux téléphones en parallèle ne se gênent pas : chacun mesure
son GPU et son fil principal, le serveur ne fait que livrer la page et recevoir le JSON. `done` p50 en ms,
WebGPU / WebGL2, `mwsr` :

| cas | saturé | 60 i/s |
|---|---|---|
| ×2 texte 720p → 1440p | 37,3 / 38,0 | 37,3 / 38,4 |
| ×2 jeu | 29,0 / 30,7 | 29,2 / 31,2 |
| ×2 interface | 30,1 / 31,8 | 29,4 / 31,8 |
| ×1,33 texte | 36,4 / 46,8 | 38,0 / 46,4 |
| ×0,67 texte (entrée 4K) | 38,1 / 97,5 | 38,1 / 97,0 |
| 1264×584 → 2532×1170 texte | 32,6 / 34,2 | 32,6 / 34,1 |
| 1264×584 → 2532×1170 jeu | 29,5 / 30,0 | 29,9 / 30,8 |

Verdict de la règle : **égalité dans les marges** dans les deux régimes (WebGPU 0,78-0,98 ×, fil principal
égal, 2,1-2,4 ms des deux côtés) → la saveur de production, WebGL2, reste sur Mali ; la réduction 4K →
1440p est la seule où WebGPU s'impose (0,39 ×, vues sRGB contre la grille 2×2). À lire avec la taille :
une sortie 1440p (3,7 Mpx) vaut 3,2 écrans de ce téléphone, le plancher de la chaîne (`off`, copie et
présentation) y est déjà 22-23 ms et `mwsr` ajoute 7 à 15 ms de GPU (18 ms horodatés sur le texte, 9,7 sur
le jeu) : aucune saveur n'y tient 60 i/s, alors qu'à sa taille `mwsr` coûte 5,9 ms (J16). Manque la page
18 (réduction à 1,5 × l'écran de l'iPhone), sans incidence ; les cas à la taille du realme, refaits
ensuite, sont à l'addendum.

**Addendum (10:12-10:16), les huit cas à la taille du realme.** Bruno a ouvert les liens /11 à /18 sur le
realme seulement, servis par `--tag realme --p4 --screen 1600x720` (port 8768) : huit pages au premier plan
(`hiddenMs` 0), sans erreur, 15-21 s chacune. La table de la porte écarte désormais un fichier posté à une
autre taille ou dans un autre régime que le cas (`_posted_shape`, `p4_flows.py`) : les sept pages « écran »
à la taille de l'iPhone et une page de P0 du 21/10 n'y entrent plus. `done` p50 en ms, WebGPU / WebGL2,
`mwsr` :

| cas | saturé | 60 i/s |
|---|---|---|
| écran ×2 texte 800×360 → 1600×720 | 20,8 / 23,1 | 20,8 / 23,1 |
| écran ×2 jeu | 18,1 / 20,7 | 18,1 / 20,5 |
| écran ×1,33 texte 1200×536 → 1600×720 | 21,4 / 24,8 | 19,3 / 25,4 |
| écran ×0,67 texte 2400×1080 → 1600×720 | 18,6 / 37,3 | 19,0 / 36,7 |

À la taille de son écran, **WebGPU passe devant partout** : 0,87-0,90 × à ×2, 0,76-0,86 × à ×1,33,
0,50-0,52 × en réduction (2,2-2,6 ms de moins par image à ×2, 3,4-6,1 à ×1,33, 18 en réduction), fil
principal égal (1,9-2,3 ms des deux côtés ; 3,1 en WebGL2 sur la réduction). L'avance vient du plancher de
la chaîne, pas du shader : `off` 14,6-15,8 ms en WebGPU contre 18,4-20,3 en WebGL2 (35 ms sur la réduction,
l'envoi d'une image 2400×1080), et au-dessus de son plancher `mwsr` ajoute 2,4-6,3 ms en WebGPU, 1,1-5,8 en
WebGL2 ; GPU horodaté 4,1-6,9 ms, 0,45-0,74 × SGSR1 en agrandissement (C1 tenue). Aucune des deux ne finit
son image sous 16,7 ms. La règle, jugée sur les tailles standard, reste « égalité » ; appliquée à ces cas,
elle le resterait de justesse (texte ×2 à 0,901 et 0,903). Pour la décision par classe : sur Mali, WebGPU
gagne 2 à 6 ms par image à la taille de l'écran, 18 ms quand le flux est plus grand que l'écran.

## 2026-10-22 — J27, la porte P4 relue : le labo s'arrête à la fin du GPU, la saveur se choisira au clic-photon

Question de Bruno (10:33) : pourquoi « WebGL2 reste » sur le realme avec 6 et 18 ms de gain, et que
disait le clic-photon déjà mesuré ? Sa crainte : une régression si l'on ne regarde pas la chaîne entière.

- **La règle** (`GATE_WIN` 0,9, `GATE_MAIN` 1,2 ou 0,25 ms, `p4_flows.py`) a été posée par la session le
  21/10 en écrivant la porte, pas par Bruno. Trois limites : elle est relative (10 % de 2 ms sur le RTX,
  de 20 à 37 ms sur le realme) ; elle juge des sorties 1440p, 3,2 écrans du realme ; elle juge `done`,
  du début du draw à la fin du GPU, avant le compositeur.
- **Le clic-photon déjà mesuré**, sonde `mwLatency`, toujours sur ordinateur. Wiki 15.3 (septembre, RTX) :
  en fenêtre ×1,07, WebGL2 13,9-15,1 ms contre WebGPU 14,0-15,7, égaux à la médiane, WebGL2 meilleur de
  1-2 ms au p90 ; en plein écran ×2, WebGL2 34,2-37,2 contre WebGPU 26,8-29,5, WebGPU devant de 5-10 ms
  avec 20-40 ms de dispersion sur dix clics. Rapport P1 §6 (21/10, 780M, plein écran 1:1) : Canvas2D
  26,9, WebGPU 27,6, WebGL2 30,6 ms, égaux à ± 3 ms ; les 4 ms de soumission WebGPU du labo y sont
  absorbées tant que l'image tient dans la période.
- **Lecture.** Sur ordinateur, le labo (WebGL2 deux fois plus tôt sur le RTX) et le photon plein écran
  (WebGPU devant) se contredisent ; le rapport P4 disait avoir répondu à la question du wiki 15.3, c'est
  corrigé (§5). Sur le realme, une image prend 18 à 37 ms, plus que la période : le dessin y est sur le
  chemin critique et l'écart du labo a plus de chances de passer au photon, sans preuve. Sur mobile,
  `desynchronized` n'aurait pas d'effet d'après `BrowserDetect.js` (les compositeurs mobiles
  resynchronisent) : l'asymétrie WebGL2/WebGPU du dernier saut n'y jouerait pas, et la sonde, qui lit
  l'image dessinée dans la page et pas l'écran, y serait plus juste que sur ordinateur.
- **Décision de Bruno (go 10:42)** : aucune classe ne change de saveur sur la foi du labo seul ; d'abord
  le clic-photon des deux téléphones. Protocole : la `--dev` de DualRTX avec `latency_flag_enabled` et le
  mode debug (`ClientLog` remonte alors la console du téléphone au journal client de l'hôte) ; WebGPU
  `mwsr` contre WebGL2 `gl-mwsr` par `video_enhancement_algo`, Canvas2D pour témoin ; flux 720p (×1,25 sur
  le realme) et 1080p (réduction) ; séries de 10 clics entrelacées ; le realme piloté par adb sans fil et
  DevTools (Bruno autorise la manipulation), l'iPhone par l'inspecteur web de Safari du Mac de Léo en
  Wi-Fi ; caméra au ralenti (repère gris de la sonde) si un écart reste ambigu. Créneau via 59.

## 2026-10-22 — J28, le clic-photon des téléphones : la sonde biaisée, l'échelle qui coupe, pas de régression WebGPU

Créneau de 59 (10:52, priorité donnée par Bruno), `--dev` de DualRTX sur `da7468f0` avec le drapeau et le
mode debug, Display 1 capturé (kiosque `still.html?anim=1`, pointeur parqué sur `click-target`). Scripts et
vidéos dans le scratchpad de la session (`photon/`) ; rien du produit n'a changé.

- **La sonde se mesure elle-même sur téléphone.** Pendant qu'elle guette le drapeau, WebGL2 relit ses
  trois pixels par un `readPixels` synchrone après chaque dessin, Canvas2D par `getImageData`, WebGPU en
  asynchrone (`copyTextureToBuffer` + `mapAsync`). Sur le realme, `mwLatency.run` donnait WebGPU 43-46 ms
  contre WebGL2 74-77 et le présentateur simple 72-90 : un artefact de la relecture, abandonné.
- **Méthode sans relecture.** La page envoie le clic (`mwLatency._sendClick(null)`) et montre au même
  instant un flash coloré dans le DOM (trois rAF) ; l'écran composé est enregistré (`adb shell
  screenrecord` sur le realme, ~52 i/s ; l'enregistrement d'écran d'iOS sur l'iPhone, 60 i/s) et l'on lit,
  par clic, le délai du flash au drapeau (`rec_analyse2/4.py` : zone du drapeau trouvée dans l'image,
  flashs groupés par mesure). Le dernier saut du compositeur, commun au DOM et au canvas, s'annule : les
  absolus sont sous le vrai clic → photon, les écarts valent. Pas de 120 Hz résolu : l'unité est l'image
  d'enregistrement (16,7 ms), lissée par des clics non synchronisés.
- **Piège : la mémoire de l'échelle.** `EnhancerGovernor` retient par appareil où l'échelle est descendue
  (`localStorage.mw_enhancer_rung`) ; les séries de sonde l'avaient fait descendre, et toute la première
  matrice du realme (11:08-11:18) a démarré amélioration coupée : `Enhancer starts at off (setting
  gl-mwsr)` au journal client, rien à l'écran. Cette matrice (v1) compare donc les présentateurs simples.
  Ensuite : clé effacée avant chaque lancement, relue après (les descentes sont muettes dans la console).
- **realme Note 60, Chrome 155, 60 Hz, sortie 1280×720 (v1, présentateurs sans amélioration, 2 × 14
  clics).** WebGL sans passe deux fois (réglage `off`, et réglage `gl-mwsr` démarré à `off`), WebGPU sans
  passe une fois (réglage `mwsr` démarré à `off`). 960×540 : 38,7 ms (séries 38,7 / 38,7) et 42,9 (38,6 /
  47,1) pour WebGL, 43,3 (47,9 / 38,7) pour WebGPU, tous à 52 i/s. 1920×1080 : 43,2 et 45,5 pour WebGL à
  30 i/s, 38,8 pour WebGPU à 53-55 i/s. Le fil principal de WebGL sature en 1080p : une image sur deux
  n'est pas présentée.
- **L'échelle coupe l'upscaler sur le realme, dans les deux saveurs (v2, 12:25).** Avec la mémoire
  effacée, `gl-mwsr` comme `mwsr` sont descendus à `off` pendant la série, en 2 s : la passe ne tient pas
  une image à ×1,33 (le labo P4 mesurait 21-25 ms par image à la taille de l'écran). Dans le produit, sur
  ce téléphone, la saveur ne choisit donc que le présentateur simple qui reste : v1.
- **Upscaler maintenu (v3, 12:29-12:38, labo seulement).** L'échelle neutralisée sur la page de test
  (`EnhancerGovernor.prototype.update` → `null` par un import du même module ; vérifié après chaque série :
  mémoire vide, correctif en place), 2 × 14 clics par saveur, une série témoin. 960×540 (×1,33) :
  `gl-mwsr` 35,7 ms (31,8 / 39,6 ; médiane 32,7), `mwsr` 45,3 (46,0 / 44,5 ; médiane 41,1), témoin 51,3
  (médiane 48,8). 1920×1080 (réduction) : `gl-mwsr` 40,6 (40,6 / 40,6 ; médiane 32,7) à 30 i/s, `mwsr` 68,8
  (93,4 avec deux à-coups de 458 et 280 ms / 44,3 ; médiane 48,7) à 50-58 i/s, témoin 53,0 à 30 i/s. Forcé,
  WebGPU arrive environ une image plus tard que WebGL2, mais montre presque deux fois plus d'images en
  1080p. L'écart entre deux séries identiques atteint lui aussi une image (témoin 960 : médiane 33,5 en v1,
  48,8 en v3) : la phase entre la cadence de l'hôte et l'écran du téléphone tient toute une série.
- **iPhone 13 Pro, Safari d'iOS 26.5, 120 Hz, canvas 1445×813 (11:49-11:54, Bruno au signet).** 120
  drapeaux vus, 100 clics appariés (un flash de trois rAF à 120 Hz échappe parfois à l'enregistrement à
  60 i/s, au hasard). 1280×720 (×1,13) : `gl-mwsr` 34,4 ms (15 clics), `mwsr` 28,1 (19). 1920×1080 (×0,75) :
  WebGL simple 38,6 (19 ; 36,9 sur les réglages de Bruno, 14), `gl-mwsr` 33,3 (14), `mwsr` 37,7 (19).
  WebGPU − WebGL2 : −6,4 ms en 720p (IC 90 % −13,4 à 0), +4,4 en 1080p (−1,0 à +10,0). Pas de régression,
  et aucune descente de l'échelle pendant les six mesures.
- **La mesure du rafraîchissement sous charge.** En 1080p WebGL, le client annonce un écran plus lent que
  le vrai : 35-39 Hz sur le realme (l'hôte, sans diviseur proche, reste à 60 i/s), 112-115 Hz sur l'iPhone
  (l'hôte passe à 56-58 i/s et perd son verrou de cadence). Avec `mwsr` sur WebGPU, l'iPhone reste mesuré à
  120 Hz et le flux à 60 i/s verrouillé. Hors du chantier : signalé à 59 pour la cadence.
- **Verdict.** iPhone : WebGPU confirmé, sans régression au photon et avec une cadence plus stable.
  realme : à ×1,33, l'upscaler ne survit à l'échelle dans aucune saveur (la réduction n'a pas été rejouée
  échelle active) ; il reste le présentateur simple, égal à
  960×540 et meilleur en WebGPU à 1080p (×1,8 images) ; forcé, `mwsr` coûte une image de plus que
  `gl-mwsr`. La décision par classe reste à Bruno (plan §9, P6). Incident : `stream.dev` et
  `stream.moonlightweb.top` injoignables de 11:39 à 11:44 (ligne rendez-vous de la `--dev` perdue puis
  reprise), signalé à 59.

## 2026-10-22 — J29, le troisième repli de l'import, l'abandon du renderer, la CI rejouée sous Linux

Décisions de Bruno du 22/10 (plan §9) : un troisième repli de l'import (`VideoFrame.copyTo` vers RGBA
puis `writeTexture`), la bascule sur `gl-<algo>` puis Canvas2D quand tout échoue N fois de suite, et la
règle de sortie du job CI « Upscaler lab ». Codés au go de Bruno, après le `/compact`.

- **Ce que disait la CI du 22/10 au matin (run 39737555924, la première avec le repli bitmap de J21).**
  Côté WebGPU, 24 problèmes : l'import refusé, puis « Failed to copy content from external image » sur
  la copie du bitmap, puis les cellules du noyau et leurs dumps en « A valid external Instance reference
  no longer exists ». Rejoué à l'identique dans le WSL Debian de DualRTX (Chrome 156 stable, SwiftShader,
  sans GPU : `/dev/dxg` masqué dans un espace de montage à part, le chargeur Vulkan réduit à l'ICD
  SwiftShader de Chrome, `CI=1` comme sur le runner).
- **Le vrai coupable : le canvas, pas la copie.** Une page de sonde nue sur la même plateforme : l'import
  est refusé, mais la copie du bitmap et `copyTo` → `writeTexture` marchent (pixels exacts, toutes les
  tailles du labo, isolation cross-origin ou non). Ce qui casse, c'est le **canvas WebGPU** : à son premier
  `getCurrentTexture`, la swap chain ne trouve aucune mémoire partagée à allouer (stderr : « Could not find
  SharedImageBackingFactory … WebgpuSwapChainTexture », « SharedImageStub: Unable to create shared
  image »), Chrome détruit le device (`lost` : « destroyed », « Device was destroyed. ») et coupe
  l'instance WebGPU de toute la page (tous les autres devices, celui du labo compris) ; un nouveau
  `requestAdapter` repart. Le 21/10, le dessin mourait à l'import, avant le canvas : le noyau était
  épargné. Le repli bitmap de J21 a mené le dessin jusqu'au canvas, et l'instance est tombée avec lui.
  Le renderer du produit ignorait la perte « destroyed » : sur cette plateforme il restait noir pour de bon.
- **Le produit (`WebGpuRenderer`).** Trois voies d'entrée : l'import, puis la copie du bitmap dans
  `inputTex`, puis la lecture (`copyTo` en RGBA, `writeTexture` dans `readbackTex`, que la passe 0 copie
  comme la texture externe ; pipeline fait à la première lecture, au format d'`inputTex`, flottant en HDR).
  Un `copyTo` qui ne sait pas convertir est reconnu par l'accesseur du membre `format` (WebIDL lit tous
  les membres qu'il connaît) : sinon il rendrait les plans NV12 de l'image, vus comme des couleurs. Le
  refus du bitmap se redemande avec l'import (tous les 300 draws, et tout de suite après une image
  perdue). Une image est perdue quand aucune voie ne l'a prise, que le dessin a levé une exception ou
  que son travail ne s'est pas achevé sur un device resté debout ; 30 de suite (une demi-seconde à 60 i/s)
  et le renderer abandonne (`failed`). Il abandonne aussi quand son device est perdu avant d'avoir fini
  une image (le cas Linux : chaque nouveau device subirait le même sort) ou ne revient pas. Une perte
  « destroyed » n'est plus ignorée : elle n'est la sienne qu'une fois le renderer libéré. Pendant que les
  images sont copiées, un dessin à la fois (`serialDrawsOnly`) : deux dessins qui attendent pourraient
  arriver dans le désordre, et la lecture n'a qu'un tampon.
- **La page (`StreamView`).** Au tick de 500 ms, un renderer qui a abandonné passe la main, une fois :
  `rendererAfterFailure` donne la passe qu'il faisait sur son jumeau WebGL2 (le réglage en plafond,
  l'échelle reprise à son barreau), la copie simple sur le présentateur que la page prend pour elle, et
  `createVideoRenderer` répond par Canvas2D si WebGL2 refuse. Fil principal seulement : dans le worker
  (option de debug, coupée par défaut) le renderer abandonne mais reste, son `OffscreenCanvas` est le sien.
- **Le labo.** `importfail=2` refuse aussi la copie du bitmap, `importfail=3` la lecture ; `nopresent=1`
  fait dessiner les chaînes WebGPU dans une texture du labo à chaque image (le crochet des dumps de J19,
  étendu), et la conformité le passe toujours ; une chaîne dont la dernière image n'est entrée par aucune
  voie, ou dont le renderer a abandonné, échoue en le disant. **La règle du job (`p4_flows.conformity`)** :
  sortie 0 quand les seuls problèmes sont des chaînes non applicables, chacune une annotation
  `::warning::` sous GitHub Actions ; sortie 1 pour une vraie différence ou une image manquante, avec une
  annotation `::error::`.
- **Vérifications.** `vitest` : `WebGpuRendererImport.test.js` 17 cas (les cinq de J21, la lecture, ses
  refus, l'abandon par images perdues, par travail inachevé, par device détruit, par reprise impossible,
  la reprise d'un device qui avait dessiné), `rendererAfterFailure` 4, `StreamViewRendererFailed.test.js`
  6 ; suite complète 1686 tests verts, couverture 94,0 % ; deux mutations (limite à 31, « destroyed » de
  nouveau ignoré) attrapées. SwiftShader sous Windows (Chrome 155) : conformité OK des deux côtés ;
  `importfail=1` et `2`, 9 paires dorées exactes sur 9 ; `importfail=3`, non applicable, sortie 0. Sous
  Linux (WSL, Chrome 156, la plateforme du runner) : côté WebGPU, conformité OK, la chaîne entrée par le
  bitmap (import refusé) exacte sur les 9 cas et de qualité identique sur les 3 vérités terrain ; par la
  lecture (`importfail=2`) exacte aussi ; `importfail=3` sous `GITHUB_ACTIONS` : une annotation
  `::warning::`, sortie 0.
- **Une vraie différence, révélée sous Linux.** Les paires du jumeau WebGL2 se comparent pour la
  première fois sous Linux (jusqu'ici les dumps du noyau manquaient) : **zone plate 2560×1440 → 1280×720,
  `chain-gl-mwsr` contre `mwsr`, max 45/255, 1,01 % des pixels au-dessus de 2/255 : hors tolérance**,
  sortie 1 au pas WebGL2 (sous Windows : 3/255, 0,009 %). Les dumps d'une plateforme à l'autre : le
  jumeau GL est identique au bit près sous Linux et sous Windows ; c'est le côté WebGPU qui bouge, et pas
  le noyau : le bilinéaire nu du labo (`tex-s1`) diffère déjà de 36/255 sur 1,4 % des pixels (la moitié
  droite, où la mire approche Nyquist), `mwsr` de 45, les vues sRGB de 49. Chrome 155 et 156 sous Linux
  donnent les mêmes images au bit près (Chrome for Testing 155.0.8059.84) : c'est la plateforme, pas la
  version. Piste : l'interpolation des varyings du triangle plein écran côté WebGPU de SwiftShader
  (le jumeau GL, identique partout, ne dépend pas d'elle de la même façon) ; non vérifiée. Le texte, lui,
  diffère partout entre les deux plateformes : l'entrée elle-même, les polices du système.
- **Verdict.** Le troisième repli et la bascule sont en place et vérifiés ; la chaîne WebGPU du produit
  redevient jugeable sur le runner. Avec la règle décidée, le job sortira en 1 au pas WebGL2 sur la
  seule réduction de la zone plate. À Bruno : la garder comme différence connue, ou juger cette paire
  contre l'écart des deux bilinéaires nus des deux API sur les mêmes pixels (un changement de méthode
  de C11).

## 2026-10-23 — J30, le comparateur côte à côte (`compare.html`), pour l'œil et le téléphone

Demande de Bruno (23/10) : une page qui compare visuellement les algorithmes côte à côte sur son image
1440p, en réduction (1440 → 1080, 1440 → 720) et en agrandissement (720 → 1440, 1080 → 1440, l'entrée
étant une réduction bicubique), avec le choix et l'ordre des algorithmes (natif, mw, fsr1, sgsr1, nis),
des bandes horizontales ou verticales, les réglages derrière un petit bouton, le zoom à deux doigts et
le déplacement à un doigt, et deux chiffres par algorithme : la qualité contre l'original et la moyenne
du temps sur 1000 itérations.

- **La page** (`scripts/bench/scaler-lab/compare.html`, `compare.js`, `compare-worker.js`), servie
  comme le labo depuis la racine du dépôt (`scaler_lab.py --serve` imprime son lien, `/compare`) : les
  renderers du produit eux-mêmes (`WebGpuRenderer`, `WebGlRenderer`, un par API, la passe changée par
  `setAlgo` comme l'échelle le fait), chacun sur un `OffscreenCanvas` à la taille de sortie ; « natif »
  est `drawImage` bilinéaire (qualité `low`), « Smooth2D » la qualité `high`, en option. L'entrée est
  une `VideoFrame` RGBA de l'image (pas de codec). Les sorties sont capturées (`transferToImageBitmap`,
  sinon `createImageBitmap` du canvas) et dessinées dans des bandes sous un même zoom et un même
  déplacement : par défaut la **même zone** dans chaque bande, vue 1:1 (un pixel de sortie par pixel
  d'écran), centrée ; l'autre mode coupe une image continue. Au-dessus de 1:1 le voisin le plus proche
  (les pixels se voient) ; en dessous l'afficheur réduit lui-même, et le dit.
- **Les deux chiffres.** Qualité : SSIM de la luma (fenêtre gaussienne de Wang, σ 1,5, bord coupé : la
  définition de `metrics.py`) et PSNR RGB, contre l'image à 1440p ; à 1080p et 720p, contre sa réduction
  bicubique (Catmull-Rom, support élargi, espace gamma : le `BICUBIC` de Pillow), qui est aussi l'entrée
  des agrandissements, la même référence servant aux deux sens. Temps : la moyenne de `iters` (1000)
  images après 20 de chauffe, de l'appel du dessin à la fin du GPU, le `done` du labo (WebGPU l'attend
  dans `draw()`, WebGL2 par une fence scrutée tâche par tâche, Canvas2D par la lecture d'un pixel), en
  pause pendant les gestes ; le p50 est dans le tableau du panneau. Les réductions et le SSIM (par bandes
  de 64 lignes) tournent dans un worker.
- **API « auto »** : la décision de Bruno du 22/10 (plan §9), WebGL2 partout et WebGPU sur iPhone et
  iPad ; WebGPU ou WebGL2 au choix (WebGL2 quand WebGPU manque ou refuse). Cinq cas, dont 720 → 1080,
  ajouté (la demande écrivait deux fois 720 → 1440). L'état est dans la requête de la page (et le dernier
  dans localStorage) : un lien se partage.
- **Vérifié sur SwiftShader (Chrome 155 headless sous Windows, `00_Background.png`, ×2, 20 itérations)**,
  par un pilote CDP du scratchpad. Côté WebGL2 (ANGLE sur SwiftShader) : cinq sorties, SSIM natif 0,857,
  MW 0,871, FSR1 0,881, SGSR1 0,879, NIS 0,875 (PSNR 21,6 à 22,1 dB sur l'image entière : l'ordre des
  repères du 20/10). Côté WebGPU (adaptateur logiciel, `soft=1`) : les quatre mêmes à 10⁻⁴ près. Molette,
  glisser, pincement à deux points et double appui conformes ; l'émulation 390×844 à 3× en bandes
  horizontales lisible, le panneau utilisable au doigt. Non vérifié : la capture d'un canvas WebGPU sous
  Safari (le repli `createImageBitmap` est là, et un échec se lirait « capture noire » sur la bande).
- **L'image** : `C:\Test\test.png`, servie sous `/test/`, à défaut l'étalon `00_Background.png` ;
  `test.png` n'existait sur aucun disque de DualRTX le 23/10. Le panneau accepte aussi un fichier.
