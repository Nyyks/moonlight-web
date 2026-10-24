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
- **Le même matin, sur l'iPhone de Bruno (Safari 26.5, WebGPU)** : la page marche, SSIM à 0,001 près
  celles de SwiftShader (Natif 0,856, MW 0,870, FSR1 0,880, SGSR1 0,879, NIS 0,874), mais zoom et
  déplacement mettaient plusieurs secondes à suivre le doigt. Deux causes, corrigées. Le chrono Canvas2D
  ne rendait la main qu'une image sur dix (un `drawImage` de `VideoFrame` 1440p plus la lecture d'un
  pixel, dix fois de suite : une seconde d'écran figé sur un téléphone) : une tâche entre chaque image,
  hors mesure, pour les trois API. Et l'afficheur, un `drawImage` de bitmap 1440p par bande et par image,
  dessine en WebGL2 : chaque sortie est une texture (mipmappée) envoyée une fois, une image est un clear
  et un quad par bande, `texelFetch` à partir de 1:1 (les pixels tels quels, sans le doute d'un
  échantillon sur une arête de texel) ; le tracé Canvas2D reste le repli sans WebGL2, et sur
  `?viewer=2d`. Vérifié sur SwiftShader par le pilote : même tableau, gestes conformes, émulation
  390×844 identique à 99,8 % au tracé Canvas2D (le reste : les chiffres des pastilles). Au doigt sur
  l'iPhone, 08:04 : « fluidité du zoom : ok ».
- **La butée (Bruno, 08:04)** : on pouvait sortir l'image entière de la bande. Les bords de l'image ne
  passent plus le centre du cadre (la bande en « même zone », la page en « image continue »), à tout
  zoom : au plus une moitié de noir par axe. En butée le glisser suit l'image (l'ancre du geste est
  resuivie : le doigt qui revient la déplace aussitôt) et le pincement va pas à pas depuis le dernier
  événement, pour la même raison. Vérifié par le pilote sur SwiftShader : bureau, ajustement puis un
  glisser trop loin de chaque côté, l'arrêt aux valeurs attendues ; émulation 390×844 en bandes
  horizontales, deux glissers vers le bas et la droite, idem.

## 2026-10-23 — J31, la netteté de `mwsr` à l'œil de Bruno : balayage `--quality`, deux curseurs dans le comparateur

**Le constat (iPhone, Safari 26.5, WebGPU, 08:10-08:15).** 1080p → 1440p, 100 images : MWSR
**3,69 ms** contre FSR1 8,12, SGSR1 5,10, NIS 68,2 (« bien plus rapide que les autres ») ; mais sur le
texte à ×17, à ×1,33 comme à ×2, « moins sharp que FSR1 et SGSR1, un peu trop flou ». Natif
(Canvas2D) y mettait 435 ms par image : Safari dessinait la `VideoFrame` faite de pixels par le CPU ;
le comparateur dessine maintenant le canvas du niveau (543c5cd5), 300 images par défaut.

**Le levier.** La netteté est l'uniforme `sharp` (× `W_ACROSS` 0,3), bornée par `W_MIN` −0,3 : à
netteté 1 la borne n'était jamais atteinte, et toute netteté > 1 n'agissait que sur les contours peu
cohérents (a < 1). `W_MIN` passe à **−0,5** (71b7cebc ; pixels identiques à netteté 1, golden OK),
`setMwsrTuning({tau, sharp})` sur les deux renderers (jamais appelé par le produit), et deux curseurs
dans `compare.html` (netteté 0,5-2, τ 0,01-0,1 ; l'état dans le lien). À ×1,33 la force vaut 0,667
(`S_FULL` 1,5) : la netteté 1,5 y donne les poids de la table à ×2.

**Balayage** (SwiftShader, `--quality`, `text` / `game` / étalon, ×2 = 1280×720 → 1440p et ×1,33 =
1080p → 1440p ; PSNR / SSIM / FLIP, l'étalon au tiers central pour PSNR et SSIM ; « ac » = pente moyenne
de la luma sur les contours de la vérité terrain, rapportée à la sienne, 1 = aussi raide ; dépassements
0 % pour toutes les variantes `mwsr`, `DERING` oblige) :

| variante | `text` ×2 | `game` ×2 | étalon ×2 | `text` ×1,33 | `game` ×1,33 | étalon ×1,33 |
|---|---|---|---|---|---|---|
| FSR1 | 17,57 / 0,845 / 0,068 · ac 0,55 · dép. 0,3 % | 35,55 / 0,887 / 0,017 · 0,88 | 32,26 / 0,940 / 0,045 · 0,58 · dép. 2 % | 21,45 / 0,942 / 0,042 · 0,77 | 37,92 / 0,933 / 0,013 · 1,00 | 35,94 / 0,976 / 0,035 · 0,82 · dép. 5 % |
| SGSR1 | 18,13 / 0,869 / 0,067 · 0,66 · dép. 4,4 % | 35,61 / 0,883 / 0,018 · 0,96 | 31,28 / 0,930 / 0,052 · 0,62 · dép. 6,8 % | 21,64 / 0,946 / 0,050 · 0,86 · dép. 2,7 % | 37,70 / 0,925 / 0,014 · 1,04 | 34,55 / 0,970 / 0,040 · 0,87 · dép. 5 % |
| `mwsr`, netteté 1 (table) | 17,41 / 0,842 / 0,071 · 0,51 | 35,84 / 0,882 / 0,019 · 0,88 | 31,95 / 0,934 / 0,051 · 0,53 | 21,50 / 0,942 / 0,047 · 0,74 | 37,99 / 0,920 / 0,012 · 0,96 | 36,76 / 0,979 / 0,038 · 0,73 |
| netteté 1,25 | 17,44 / 0,844 / 0,072 · 0,52 | 35,84 / 0,882 / 0,019 · 0,91 | 31,53 / 0,931 / 0,054 · 0,55 | 21,65 / 0,945 / 0,047 · 0,76 | 38,09 / 0,920 / 0,013 · 0,97 | 36,40 / 0,978 / 0,039 · 0,75 |
| **netteté 1,5** | 17,43 / 0,844 / 0,075 · 0,53 | 35,66 / 0,882 / 0,020 · 0,94 | 30,93 / 0,927 / 0,057 · 0,57 | **21,76 / 0,948 / 0,047 · 0,77** | **38,13 / 0,920 / 0,013 · 0,99** | 35,84 / 0,976 / 0,040 · 0,76 |
| netteté 1,75 | 17,39 / 0,843 / 0,079 · 0,54 | 35,39 / 0,881 / 0,020 · 0,96 | 30,26 / 0,921 / 0,059 · 0,58 | 21,82 / 0,949 / 0,049 · 0,78 | 38,10 / 0,920 / 0,013 · 1,01 | 35,12 / 0,974 / 0,042 · 0,77 |
| netteté 2 | 17,34 / 0,842 / 0,082 · 0,54 | 35,33 / 0,881 / 0,020 · 0,96 | 29,97 / 0,918 / 0,060 · 0,58 | 21,81 / 0,950 / 0,052 · 0,79 | 38,00 / 0,920 / 0,013 · 1,02 | 34,29 / 0,971 / 0,043 · 0,78 |
| 1,5 + `S_FULL` 1,25 | — | — | — | 21,77 / 0,950 / 0,053 · 0,79 | 37,96 / 0,920 / 0,013 · 1,02 | 33,96 / 0,970 / 0,044 · 0,78 |
| 1,5 + τ 0,03 | 17,43 / 0,844 / 0,075 (36 % des pixels au noyau, contre 35) | 35,67 / 0,882 / 0,020 (2,7 % contre 2,0) | 30,91 / 0,927 / 0,057 (40 % contre 29) | 21,77 / 0,948 / 0,047 | 38,16 / 0,921 / 0,013 (8,2 % contre 1,6) | 35,84 / 0,977 / 0,040 (37 % contre 28) |
| 1,5 + `R_ACROSS` 1,25 | 17,44 / 0,846 / 0,080 · 0,53 | 36,02 / 0,882 / 0,019 · 0,95 | 30,81 / 0,925 / 0,056 · 0,57 | — | — | — |

**Lecture.** La netteté 1,5 amène le texte à l'acuité de FSR1 à ×1,33 (0,77 = 0,77) avec un meilleur
PSNR et un meilleur SSIM que lui (21,76 / 0,948 contre 21,45 / 0,942), le même FLIP qu'à 1, et
`game` au niveau de FSR1 (0,99 contre 1,00) avec le meilleur PSNR de la table ; à ×2 elle reste à 0,015
de FSR1 sur le texte, le dépasse sur `game`. Son prix, c'est l'étalon (une scène douce, où FSR1 tire
sa netteté de 2 à 5 % de dépassements, des halos) : −1 dB au centre à ×2 et −0,9 dB à ×1,33 par
rapport à la table, mais toujours **au-dessus de FSR1 à ×1,33** (35,84 contre 35,94 au centre, FLIP
0,040 contre 0,035) ; à ×2 le critère C3 déborde de peu (FLIP 0,057 contre 0,055 admis, SSIM −0,0065
contre −0,005), avec 0 % de dépassements contre 2 % pour FSR1. 1,25 tient C3 partout mais ne change
presque rien à l'œil (acuité +0,02) ; 1,75 et 2 sortent de C3 sur le texte à ×2 (FLIP 0,079-0,082).
`S_FULL` 1,25 (force pleine à ×1,33) : −2,8 dB au centre de l'étalon, rejeté ; τ 0,03 : rien aux
chiffres pour cinq fois plus de pixels au noyau sur `game` à ×1,33, rejeté ; `R_ACROSS` 1,25 : +0,36 dB
sur `game` mais le FLIP du texte à 0,080, à revoir seulement si Bruno trouve 1,5 insuffisant.
**Proposition : netteté 1,5 par défaut** (une constante, `MWSR_UNIFORMS.sharp`), à appliquer après le
signal de 59 (un banc C4 sert l'arbre de travail), golden à refaire ; l'œil de Bruno tranche, par les
curseurs du comparateur (1 / 1,25 / 1,5 / 1,75 sur l'iPhone, bande contre bande).

**Où va le PSNR (09:50, sur les dumps du balayage, le masque `mwsr:show=1`).** Étalon à ×1,33 : 72 % des
pixels sont sur le chemin plat, où `mwsr` **est** le bilinéaire (31,10 dB = `tex-s1`), FSR1 y fait 31,45 ;
sur les 28 % de contours, FSR1 19,20, `mwsr` 18,97 (netteté 1), 18,92 (1,5), 18,79 (2), bilinéaire 18,77.
L'avance de FSR1 sur l'image entière (+0,25 dB au labo, +0,6 dB dans le comparateur de Bruno avec
l'entrée bicubique, 25,1 contre 24,5) vient donc **pour l'essentiel du chemin plat** (douze texels
d'EASU contre un échantillon bilinéaire, le prix de la vitesse) et pour le reste de la reconstruction
des contours ; la netteté ne peut pas l'acheter (elle baisse le PSNR des contours, comme RCAS). Sur la
mire `text`, les plats sont à 40,1 (= bilinéaire) contre 42,4 pour FSR1, les contours montent avec la
netteté (15,75 → 16,02 → 16,07). Le comparateur sur SwiftShader donne les chiffres de l'iPhone au
centième (natif 24,20, `mwsr` 24,54 / 24,57 / 24,52 à 1 / 1,5 / 2, FSR1 25,17, SGSR1 24,83).

**À l'œil (09:50, captures du comparateur sur SwiftShader, WebGL2, les libellés du coin haut gauche de
l'étalon à ×4 puis ×4 au plus proche voisin).** « Ori.png », blanc sur sombre : natif mou avec un halo
gris ; 1,0 un peu plus défini ; **1,5 nettement plus net** (bords plus blancs et plus sombres, les
boucles du n et du g lisibles) ; 2,0 plus net encore, près de FSR1 ; FSR1 le plus propre ; SGSR1 le plus
dur, mais en escalier sur le O. « 1440p.png », sombre sur clair avec les franges colorées du ClearType :
tous proches, 1,5 et 2 un peu plus contrastés que 1, FSR1 ≈ 2 ; seul SGSR1 paraît « plus net », par ses
blocs ; la cohérence `a` prend ces franges pour de la texture et retient le noyau. Verdict : la netteté
1,5 se voit sur le texte, 2 rapproche de FSR1 sur fond sombre pour −0,1 dB et +0,003 de FLIP ; **le PSNR,
lui, ne bougera qu'avec un chemin plat mieux reconstruit** (un Catmull-Rom à quatre échantillons
bilinéaires en palier qualité, +3 échantillons partout : à chiffrer, au go de Bruno).

**Décision de Bruno (09:55), devant les planches : netteté 2,0 par défaut**, et un chemin plat mieux
reconstruit « en paramètres » (J33). Appliqué à 10:05 : `MWSR_UNIFORMS.sharp` 2,0, le test unitaire,
`golden.json` refait (chaîne = noyau sur les neuf cas), conformité OK des deux côtés (jumeau WebGL2 :
FLIP 0,000, PSNR ≤ 0,038 dB, 0 % de dépassement ; réductions au mètre des bilinéaires), `npm run check`
vert, 1717 tests verts. Le curseur du comparateur monte à 3. Chiffres de 2,0 (J31) : texte ×1,33 21,81 /
0,950 / FLIP 0,052 (FSR1 21,45 / 0,942 / 0,042), acuité 0,79 (FSR1 0,77) ; étalon ×1,33 au centre 34,29
(table 36,76, FSR1 35,94), FLIP 0,043 (0,035) ; `game` 38,00 (FSR1 37,92).

**Appliqué (09:10, signal de 59 à 08:55)** : `MWSR_UNIFORMS.sharp` 1,5 dans `MwsrShader.js`, le test
unitaire qui épinglait 1 mis à jour, `golden.json` refait sur SwiftShader (la chaîne du produit égale
au noyau sur les neuf cas, `chain-mwsr` = `mwsr`), conformité C11 OK des deux côtés (WebGPU 0/255
partout ; jumeau WebGL2 contre le noyau : FLIP 0,000, PSNR à 0,027 dB, 0 % de dépassement, les écarts
de pixels restant ceux des dérivées, connus), `npm run check` vert, 1717 tests verts. C'est un
changement du rendu du produit, à dire dans les notes de version ; le comparateur part désormais de 1,5
et le bouton « Défauts du produit » y ramène. Le verdict de Bruno à l'œil reste attendu.

## 2026-10-23 — J32, C11 option 2 : la réduction du jumeau jugée contre les bilinéaires nus

Décision de Bruno (23/10, par 59) sur la question de J29 : **option 2**, juger l'écart
`chain-gl-mwsr` / `mwsr` d'une réduction contre l'écart des deux bilinéaires nus des deux API sur les
mêmes pixels, au lieu de garder la zone plate comme différence connue. Entre-temps la CI de ac6d705b
(run 39912544431) sortait rouge au pas WebGL2 sur **les trois** réductions 2560×1440 → 1280×720, pas la
seule zone plate : `code` max 4/255, 0,173 % au-dessus de 2/255 ; `text` max 5/255, 2,80 % (18,6 % de
pixels différents) ; `zone` max 45/255, 1,01 %.

**La méthode (`p4_flows.py`).** Sur chaque cas de réduction, les deux côtés dumpent aussi leur
bilinéaire nu : `tex-s1` (la cellule du labo, WebGPU) et `chain-gl-off` (la copie simple du produit,
WebGL2), un échantillon bilinéaire au centre du pixel de sortie dans les deux cas. Leur écart est
imprimé (« the samplers' own difference ») et sert de mètre à la paire du jumeau : part de pixels
au-delà de 2/255 ≤ 4 × la leur, maximum ≤ 2 × le leur, jamais sous la tolérance fixe (0,1 %, 4/255).
Le 4 : un pixel de la grille 2×2 diffère dès qu'un de ses quatre échantillons diffère ; le 2 : la
lumière gamma-2 (carré, racine) élargit l'écart d'un échantillon près du noir. Les agrandissements
restent « reported (derivatives) » et jugés par la qualité ; `ci.yml` ne change pas (mêmes commandes).

**Rejeu de la plateforme du runner (WSL Debian, Chrome stable, SwiftShader, sans GPU, la recette de
J29), les deux côtés, sortie 0 et 0 :**

| réduction 2560×1440 → 1280×720 | bilinéaires nus (`chain-gl-off` / `tex-s1`) | jumeau (`chain-gl-mwsr` / `mwsr`) | verdict |
|---|---|---|---|
| `code` | 2/255, 3,80 % de pixels différents, 0 % au-delà de 2 | 2/255, 3,95 %, 0 % | OK |
| `text` | 1/255, 4,96 %, 0 % | 1/255, 4,48 %, 0 % | OK |
| `zone` | **36/255, 1,44 %, 0,854 %** | 45/255, 1,47 %, 1,013 % | OK (≤ 4 × 0,854 %, ≤ 2 × 36) |

La zone plate donne au bit près les chiffres de la CI (45/255, 1,47 %, 1,013 %, 42,5 dB) : c'est bien
la plateforme, et l'écart du jumeau y est celui des échantillonneurs (36/255 sur 0,85 % pour un seul
échantillon). `text` et `code` passent ici sous la tolérance fixe (1 à 2/255, 0 %), là où le runner
voit 5/255 sur 2,8 % : sur le runner, la différence est donc dans l'**entrée** que chaque Chrome
dessine lui-même (la mire de texte, par Canvas2D : rastérisation CPU d'un côté, ANGLE sur SwiftShader
de l'autre, un bord de glyphe à quelques 255ᵉ près), pas dans le noyau ; le mètre des bilinéaires la
porte par construction, puisqu'il voit la même entrée que le jumeau. À vérifier sur le runner au
prochain push de Bruno ; si `text` y restait hors du mètre, ce serait une vraie différence à lire.

**Côté Windows (SwiftShader, les deux côtés, sortie 0 et 0)** : bilinéaires nus `code` 1/255 (2,12 % de
pixels différents, 0 % au-delà de 2), `text` 1/255 (4,89 %, 0 %), `zone` 4/255 (0,48 %, 0,011 %) ; le
jumeau 1/255, 1/255 et 3/255 (0,009 %) : la différence du jumeau est bien celle des échantillonneurs,
ici comme sous Linux. Qualité du jumeau contre le noyau inchangée (FLIP 0,000, PSNR ≤ 0,027 dB).

## 2026-10-23 — J33, le chemin plat en paramètres : un cubique d'échantillons bilinéaires

Décision de Bruno (09:55) : « un chemin plat mieux reconstruit, oui, en paramètres ». Le constat de J31
(le chemin plat **est** le bilinéaire, et c'est là que FSR1 prend son avance sur les pixels plats, 72 %
de l'étalon à ×1,33) appelait une reconstruction meilleure qu'un échantillon, sans changer le produit.

**Les paramètres (`MwsrShader.js`, 3c42d89d).** Deux constantes de pipeline, dans les deux jumeaux :
`FLAT_TAPS` (1 : l'échantillon bilinéaire, le défaut ; 5 ou 9 : le cubique de Mitchell-Netravali à
B 0 et C `FLAT_C` sur les 4×4 texels autour de la position) et `FLAT_C` (0,5 = Catmull-Rom ; plus haut,
lobe négatif plus profond). Le cubique est lu comme les échantillons bilinéaires que le GPU pèse pour
rien (Jimenez, Pettineo) : sur chaque axe les deux texels du milieu par un échantillon à leur point
médian pondéré (`tc + w2 / (w1 + w2)`), les deux texels extérieurs par un échantillon chacun ; neuf
échantillons, ou cinq sans les quatre coins (les plus petits poids), le reste renormalisé ; le résultat
borné par les échantillons eux-mêmes, comme le chemin contour. Pour le comparateur, `setMwsrOverrides()`
sur les deux renderers reconstruit les pipelines ou les programmes (jamais appelé par le produit) ; la
page a un sélecteur « chemin plat » et un curseur « lobe C » ; les cellules du labo prennent `flat=` et
`fc=`. Vérifié : golden identique (le défaut ne change pas un pixel), conformité OK des deux côtés,
1718 tests, `npm run check`.

**Balayage (SwiftShader, `--quality`, PSNR entier / plat / contours par le masque `show=1`, SSIM,
dépassements ; FSR1 en repère) :**

| ×1,33 | étalon : entier / plat / contours · SSIM · dép. | `game` | `text` |
|---|---|---|---|
| FSR1 | 24,15 / 31,45 / 19,20 · 0,941 · 5,0 % | 37,92 / 39,80 / 24,47 · 0,933 · 0,4 % | 21,45 / 42,37 / 15,69 · 0,942 · 0,2 % |
| `mwsr` (netteté 2) | 23,74 / 31,10 / 18,79 · 0,936 · 0 % | 38,00 / 39,44 / 25,46 · 0,920 · 0 % | 21,81 / 40,11 / 16,07 · 0,950 · 0 % |
| CR5 (C 0,5) | 23,78 / 31,35 / 18,79 · 0,938 · 0,05 % | 38,16 / 39,67 / 25,46 · 0,925 · 0 % | 21,83 / 41,51 / 16,07 · 0,951 · 0 % |
| **CR9 (C 0,5)** | **23,78 / 31,35 / 18,79 · 0,938 · 0,05 %** | **38,24 / 39,79 / 25,46 · 0,928 · 0 %** | **21,83 / 41,60 / 16,07 · 0,951 · 0 %** |
| CR9, C 0,75 | 23,78 / 31,38 / 18,79 · 0,939 · 0,18 % | 38,27 / 39,83 / 25,46 · 0,929 · 0,02 % | 21,83 / 41,89 / 16,07 · 0,951 · 0,01 % |
| CR9, C 1 | 23,78 / 31,36 / 18,79 · 0,938 · 0,37 % | 38,28 / 39,84 / 25,46 · 0,929 · 0,04 % | 21,83 / 41,98 / 16,07 · 0,951 · 0,01 % |

| ×2 | étalon | `game` | `text` |
|---|---|---|---|
| FSR1 | 20,79 / 22,84 / 17,99 · 0,874 · 2,0 % | 35,55 / 38,03 / 22,02 · 0,887 · 0,03 % | 17,57 / 35,13 / 13,04 · 0,845 · 0,3 % |
| `mwsr` (netteté 2) | 20,52 / 22,80 / 17,55 · 0,862 · 0 % | 35,33 / 37,96 / 21,61 · 0,881 · 0 % | 17,34 / 33,56 / 12,82 · 0,842 · 0 % |
| CR5 | 20,53 / 22,83 / 17,55 · 0,866 · 0,01 % | 35,37 / 38,04 / 21,61 · 0,884 · 0 % | 17,35 / 34,57 / 12,82 · 0,843 · 0 % |
| **CR9** | **20,54 / 22,84 / 17,55 · 0,867 · 0,03 %** | **35,39 / 38,07 / 21,61 · 0,886 · 0 %** | **17,35 / 34,61 / 12,82 · 0,843 · 0 %** |

**Lecture.** Sur les pixels plats, CR9 à C 0,5 **rejoint FSR1** : étalon 31,35 contre 31,45 et 22,84 =
22,84, `game` 39,79 contre 39,80 et 38,07 contre 38,03, `text` à 0,5-0,8 dB ; CR5 en prend les deux
tiers ; C au-delà de 0,5 n'ajoute que des dépassements. Sur l'image entière le gain est ce que la part
d'erreur des plats permet : +0,24 dB sur `game` à ×1,33 (MWSR passe devant FSR1 : 38,24 contre 37,92),
+0,04 sur l'étalon, +0,02 sur le texte ; SSIM +0,003 à +0,008 (étalon ×2 : 0,862 → 0,867, FSR1 0,874).
Pourquoi si peu sur l'étalon : 28 % de ses pixels sont des contours et portent **87 % de l'erreur**
(18,8 dB contre 31 sur les plats) ; là, c'est la reconstruction à cinq échantillons contre les douze
texels d'EASU (J7, trois tours, on s'arrête) et la netteté 2 (18,79 contre 18,97 à netteté 1) qui
comptent, pas le chemin plat. Le comparateur sur SwiftShader (entrée bicubique, ×1,33) dit la même
chose : CR9 0,9415 / 24,57 contre 0,9386 / 24,52 (FSR1 0,948 / 25,17) ; coût CPU ×3,7 sous SwiftShader,
qui ne dit rien d'un GPU. **À Bruno** : le temps et l'œil sur l'iPhone (⚙ → chemin plat CR9, C 0,5 ;
la texture externe y paie deux fetches par échantillon, donc neuf au lieu d'un sur 72 à 98 % des
pixels) ; si le temps passe, CR9 à C 0,5 est la valeur à retenir, en palier qualité ou par défaut.

## 2026-10-23 — J34, un chemin plat quadratique à trois échantillons (`FLAT_TAPS 3`), et la zone du regard en paramètres

**La question de Bruno (10:50, après l'iPhone).** CR5 à netteté 1,85 lui plaît, mais sa capture de
11:02 (1080p → 1440p, WebGPU, 100 images) dit le prix : MWSR **5,66 ms** avec CR5 contre 3,9 ms
nu, SGSR1 5,70, FSR1 8,96 — le chemin plat à cinq échantillons sur 72 à 98 % des pixels mange
l'avance. « Un Catmull-Rom 3, si ça existe ? » Il n'existe pas : le cubique lit quatre texels par
axe, trois échantillons bilinéaires par axe (la paire du milieu fusionnée, les deux extérieurs
seuls), neuf en deux dimensions, cinq sans les coins — le plancher de Jimenez ; en dessous il
faudrait lâcher un axe. Ce qui existe en trois, c'est le **quadratique interpolant de Dodgson
(1997)** : trois texels par axe, le plus proche et son voisin du côté de l'échantillon fusionnés en
un échantillon bilinéaire à leur barycentre, le lointain, de poids négatif (jusqu'à −1/16), en un
échantillon ponctuel ; le coin lâché et le reste renormalisé : trois échantillons. Sa faiblesse,
connue d'avance : à mi-chemin entre deux texels (`h = ±0,5`) le poids lointain s'annule et il
redevient bilinéaire, précisément où le cubique apporte le plus. Go de Bruno (11:0x, par 59) :
en option de labo, le défaut du produit inchangé. Fait (6fbc3627) : `FLAT_TAPS 3` dans les deux
jumeaux, borné par ses échantillons ; « quadratique, 3 échantillons » dans le comparateur
(`flat=3`) ; vérifié par les deux Chromes de SwiftShader : mêmes chiffres des deux côtés (SSIM
0,9403, PSNR 24,56 sur l'étalon à ×1,33), golden intact (le défaut ne change pas un pixel).

**Balayage (SwiftShader, `--quality`, netteté 1,85, PSNR entier / plat / contours par le masque
`show=1` ; FSR1 en repère) :**

| ×1,33 (1080p → 1440p) | nu (bilinéaire) | Q3 | CR5 | FSR1 |
|---|---|---|---|---|
| étalon (28 % de contours) | 23,78 / 31,10 / 18,84 | 23,80 / 31,20 / 18,84 | 23,82 / 31,35 / 18,84 | 24,15 / 31,45 / 19,20 |
| `game` (1,6 %) | 38,07 / 39,44 / 25,70 | 38,18 / 39,60 / 25,70 | 38,24 / 39,67 / 25,70 | 37,92 / 39,80 / 24,47 |
| `text` (26 %) | 21,82 / 40,11 / 16,07 | 21,82 / 40,32 / 16,07 | 21,83 / 41,51 / 16,07 | 21,45 / 42,37 / 15,69 |
| SSIM étalon / game / text | 0,937 / 0,920 / 0,950 | 0,938 / 0,924 / 0,950 | 0,939 / 0,925 / 0,950 | 0,941 / 0,933 / 0,942 |

| ×2 (720p → 1440p) | nu | Q3 | CR5 | FSR1 |
|---|---|---|---|---|
| étalon (29 %) | 20,53 / 22,80 / 17,58 | 20,55 / 22,84 / 17,58 | 20,55 / 22,83 / 17,58 | 20,79 / 22,84 / 17,99 |
| `game` (2,0 %) | 35,34 / 37,96 / 21,65 | 35,39 / 38,04 / 21,65 | 35,39 / 38,04 / 21,65 | 35,55 / 38,03 / 22,02 |
| `text` (35 %) | 17,37 / 33,56 / 12,86 | 17,38 / 34,50 / 12,86 | 17,38 / 34,57 / 12,86 | 17,57 / 35,13 / 13,04 |
| SSIM étalon / game / text | 0,863 / 0,881 / 0,843 | 0,866 / 0,884 / 0,843 | 0,867 / 0,884 / 0,844 | 0,874 / 0,887 / 0,845 |

**Lecture.** À ×2, Q3 **vaut CR5** sur les pixels plats (et FSR1 : étalon 22,84 = 22,84, `game`
38,04 contre 38,03) : les centres des pixels de sortie tombent à un quart de texel (`h = ±0,25`),
là où le quadratique est au mieux, à un cheveu du cubique. À ×1,33, un pixel sur quatre par axe
tombe à mi-chemin et Q3 prend la **moitié** du gain de CR5 sur l'étalon et `game` (31,20 entre
31,10 et 31,35 ; 39,60 entre 39,44 et 39,67), un cinquième sur `text` (40,32 : les plats du texte
sont les bords des lettres, à toutes les phases). Dépassements 0 % partout. Pour trois
échantillons au lieu de cinq : à mesurer sur l'iPhone (lien `flat=3` à netteté 1,85, le même
réglage que son CR5 : chemin plat et netteté sont indépendants, les contours ne bougent pas d'un
centième de dB entre nu, Q3 et CR5).

**La zone du regard (go de Bruno, §15.2 du plan), en paramètres.** Faite le même jour dans les deux
jumeaux : la constante `GAZE` (0 par défaut, le texte d'avant au pixel près) et la table
`MWSR_ZONE` (centre 0,5 / 0,5, demi-axes 0,2 / 0,45, anneau 0,75, τ 0,02 et netteté 2,5 au
centre) ; `z = (1 − smoothstep(1, 1 + anneau, d)) · gaze`, `τ' = mix(τ, τc, z)`, `netteté' =
mix(n, nc, z)` ; `FLAT_ZONE` : le chemin plat CR ou Q3 dans la zone seule ; `SHOW 2` peint z. Le
poids `gaze` suit le mouvement de l'image dans le produit (`GazeZone.js` : bits par pixel et par
seconde des images delta, 0,25 → 0 et 1,0 → 1, montée 1 s, descente 3 s, par pas de 1/64 ; test
unitaire : un bureau immobile reste à 0, un flux 1080p à 19 Mbit/s passe 0,9 en 2,5 s, retombe
sous 0,1 en 9 s), ou est tenu à 1 par le comparateur. Produit : rien d'allumé, clé de labo
`mw_mwsr_gaze` (téléphones et tablettes, jamais un client de bureau), coupée par défaut. Jumeaux :
d'accord sur le comparateur avec la zone et `FLAT_ZONE` (SSIM 0,93671 / 0,93670, PSNR 24,458 des
deux côtés, SwiftShader).

**Mesure (SwiftShader, `--quality` à ×1,33, netteté 1,85 à la table, poids tenu à 1 ; PSNR dedans
l'ellipse verte / sur l'anneau / dehors, 28,3 % / 36,7 % / 35,0 % des pixels, poids moyen 47,9 %) :**

| ×1,33 | table | zone (τc 0,02, nc 2,5) | table + CR5 | zone + CR5 | zone + CR5 dans la zone seule | FSR1 |
|---|---|---|---|---|---|---|
| étalon | 35,22 / 25,46 / 20,59 | 32,82 / 25,31 / 20,59 | 35,32 / 25,48 / 20,63 | 32,84 / 25,33 / 20,63 | 32,84 / 25,31 / 20,59 | 36,35 / 25,81 / 20,94 |
| `game` | 37,83 / 38,80 / 37,59 | 37,34 / 38,72 / 37,59 | 37,96 / 39,01 / 37,75 | 37,40 / 38,88 / 37,75 | 37,40 / 38,80 / 37,59 | 37,44 / 39,06 / 37,33 |
| `text` | 21,82 / 21,64 / 22,02 | 21,65 / 21,60 / 22,02 | 21,83 / 21,65 / 22,03 | 21,66 / 21,61 / 22,03 | 21,66 / 21,60 / 22,02 | 21,44 / 21,28 / 21,66 |
| SSIM entier | 0,950 / 0,920 / 0,937 | 0,950 / 0,921 / 0,932 | 0,950 / 0,925 / 0,939 | 0,951 / 0,925 / 0,933 | 0,951 / 0,923 / 0,932 | 0,942 / 0,933 / 0,941 |
| part de pixels au noyau | 26,3 / 1,6 / 27,7 % | 27,1 / 9,5 / 37,3 % | | | | |

(SSIM et parts dans l'ordre `text` / `game` / étalon.)

**Lecture.** Dehors, rien ne bouge au centième : la périphérie est la table, comme voulu, et
`FLAT_ZONE` la rend au bilinéaire (20,59 contre 20,63 avec CR5 partout). Dedans, le PSNR baisse —
comme toute netteté ici (J31) : à 2,5 les contours du noyau s'écartent de la vérité terrain, et
τ 0,02 fait passer six fois plus de pixels de `game` par le noyau (1,6 → 9,5 %) ; le SSIM monte
un peu sur `text` et `game`, baisse sur l'étalon, dont le centre est un dégradé doux que τ 0,02
commence à « accentuer ». Les chiffres ne tranchent pas une préférence de netteté : c'est l'œil de
Bruno sur l'iPhone, avec les anneaux et les six curseurs (`gaze=1` dans le lien) ; les premières
valeurs sont celles du labo. Le temps sur un vrai GPU est à lire dans le coin de la bande (un
`length`, un `smoothstep`, deux `mix` de plus par pixel, et les pixels de plus au noyau au centre).

## 2026-10-23 — J35, le noir plus pâle des traits fins : la borne des cinq échantillons du chemin contour

**Constat de Bruno (iPhone, 12:13-12:16, 1080p → 1440p, ×16 sur l'emblème sombre de l'étalon) :**
« J'ai essayé différentes approches, toutes ont une couleur plus pâle sur le noir. » MWSR à
netteté 2,00, nu, CR5, Q3, avec ou sans zone : les traits sombres de l'emblème sortent gris-brun là
où FSR1 et SGSR1 les gardent noirs (ses captures : MWSR SSIM 0,936-0,940 · PSNR 24,4-24,5 ·
4,4-5,1 ms ; FSR1 0,948 · 25,2 · 7,9-8,3 ms ; SGSR1 0,946 · 24,8 · 4,4-5,0 ms).

**Pistes.** L'espace de couleur, non : le mode `up` lit et écrit les valeurs encodées (les vues sRGB
ne servent qu'à la réduction, J15), comme FSR1 et SGSR1. La cause est la borne du chemin contour
(plan §3.2, point 9) : `blend()` borne son résultat entre le minimum et le maximum de ses **cinq
échantillons bilinéaires**, puis `DERING 1` par les quatre texels. Sur une marche, les deux bornes se
valent (les échantillons en travers, à ±1 texel, atteignent les plateaux). Sur un **trait d'un
texel** — une crête — l'échantillon central est l'extrême des cinq, et la première borne épingle le
pixel à son mélange bilinéaire : à ×1,33 les colonnes de sortie tombent à 0, 0,75, 1,5 et 2,25
texel, et un trait noir D sur un fond O ne sort jamais plus sombre que 0,5·D + 0,5·O et
0,75·D + 0,25·O, quelle que soit la netteté (à netteté 2, le mélange voudrait 1,33·D − 0,33·O au
point milieu ; la borne le lui interdit). EASU et SGSR1 ne bornent que par les quatre texels voisins
(`min4`/`max4`), et leurs lobes négatifs, puis RCAS, font descendre le trait vers D : le noir « plus
profond » de leurs bandes. Le chemin plat n'est pas en cause : un trait noir sur orange passe par le
vote, CR5 et Q3 n'y sont jamais appelés (leurs bornes épingleraient de même, au demeurant).

**Mesure (SwiftShader, `--quality` à ×1,33 ; « traits fins » = pixels sombres de la référence,
Y < 0,25, avec un pixel clair, Y > 0,4, à deux pixels de part et d'autre : 5,55 % des pixels de
`text`, 0,32 % de l'étalon ; biais = luma de sortie − référence, + = plus pâle ; p1 = premier centile
de luma sur les pixels du chemin contour) :**

| ×1,33 | biais traits étalon / `text` | p1 contour étalon / `text` | PSNR étalon / `text` / `game` | SSIM étalon / `text` / `game` | FLIP étalon |
|---|---|---|---|---|---|
| MWSR table (2,0 ; cinq échantillons, puis texels) | +0,139 / +0,197 | 0,002 / 0,059 | 23,74 / 21,81 / 38,00 | 0,936 / 0,950 / 0,920 | 0,043 |
| `dering=2` à 2,0 (texels seuls) | +0,091 / +0,090 | 0,000 / 0,000 | 24,08 / 22,18 / 37,56 | 0,938 / 0,958 / 0,920 | 0,044 |
| `dering=2` à 1,5 | +0,102 / +0,121 | 0,000 / 0,000 | 24,30 / 22,20 / 37,83 | 0,942 / 0,954 / 0,920 | 0,038 |
| `dering=2` à 1,5 + CR5 | +0,102 / +0,121 | 0,000 / 0,000 | 24,33 / 22,22 / 37,98 | 0,944 / 0,955 / 0,925 | 0,037 |
| `dering=2` à 1,0 | +0,118 / +0,161 | 0,000 / 0,000 | 24,29 / 21,86 / 37,81 | 0,942 / 0,947 / 0,920 | 0,033 |
| FSR1 | +0,124 / +0,189 | 0,000 / 0,014 | 24,15 / 21,45 / 37,92 | 0,941 / 0,942 / 0,933 | 0,035 |
| SGSR1 (source) | +0,114 / +0,178 | 0,000 / 0,016 | 23,75 / 21,73 / 37,65 | 0,921 / 0,947 / 0,925 | 0,042 |

Dépassements : 0 % pour tous les MWSR (la borne 2×2 tient la sonnerie), FSR1 5,0 % sur l'étalon.
En moyenne sur tous les pixels sombres (Y < 0,25), MWSR n'était pas plus pâle que FSR1 (biais
+0,0148 contre +0,0144 sur l'étalon) : l'écart est tout entier dans les traits et les extrêmes,
que le zoom ×16 de Bruno regarde.

**Lecture.** La borne des cinq échantillons, « faible et gratuite » (§3.2), est surtout fausse sur
les crêtes. Levée (`DERING 2`, aucune instruction de plus : les quatre texels sont déjà chargés), les
traits reviennent à la profondeur de la référence (p1 0,059 → 0,000 sur `text`, biais des traits
divisé par deux) et tout monte sur `text` (+0,37 dB, SSIM 0,950 → 0,958) et sur l'étalon (+0,34 dB à
2,0, +0,56 à 1,5) ; `game` perd 0,44 dB à netteté 2,0 (ses rares pixels sombres au noyau sont
maintenant poussés sous la référence : biais −0,043 sur la bande 0-0,1), 0,17 dB à 1,5, et rien en
SSIM. La netteté se redose : à 1,5 avec CR5, MWSR passe FSR1 sur les trois mesures de l'étalon
(24,33 / 0,944 / 0,037 contre 24,15 / 0,941 / 0,035) et de `text`, à égalité de PSNR sur `game`
(37,98 / 37,92 ; le SSIM 0,925 / 0,933 reste à FSR1). Sur le comparateur même (SwiftShader, image
par défaut, 1080p → 1440p, `dr=2&sharp=1.5&flat=5&fc=0.5`) : MWSR SSIM 0,951 · PSNR 25,52 contre
FSR1 0,948 · 25,17 et SGSR1 0,946 · 24,83 — là où les captures de Bruno donnaient 0,937-0,940 ·
24,4-24,5 à MWSR.

**Jumeaux** : d'accord sur le comparateur (WebGPU, adaptateur logiciel : 0,95124 · 25,518 ; WebGL2
SwiftShader : 0,95130 · 25,524). Test unitaire J35 (les deux textes, la constante cuite dans le
GLSL) ; golden de la table inchangé, conformité C11 refaite des deux côtés : OK (jumeau WebGL2 contre
noyau : FLIP 0,000, 0,007 dB) ; 1726 tests, `npm run check`. Les cellules `chain-*` du labo n'acceptent pas d'options — elles les ignorent en silence et
rendent la cellule nue : à savoir avant de s'y fier. **Produit** : `DERING` reste 1 ; dans le
comparateur, `dr=2` et ⚙ → « borne (arêtes) » ; à l'œil de Bruno, avec la netteté (1,5 ?) et CR5.
S'il valide, le défaut du produit change, et la netteté avec, sur son oui explicite.

**Faux pas de banc.** La première passe « WebGPU » du comparateur a été lancée sans `api=webgpu` ni
`soft=1` dans le lien ; le Chrome du pilote, qui n'épingle WebGL que par la page, a pris la
RTX 5060 Ti en WebGL2 pendant quelques secondes (figures 0,95131 · 25,525, cohérentes avec
SwiftShader ; aucun mode d'écran touché ; C4 de f1 était fini). Le pilote force désormais ces deux
paramètres en mode `gpu`.

## 2026-10-23 — J36, le comparateur sur le parc : six configurations par appareil, pour le choix de Bruno

**Demande de Bruno (12:46)** : « un benchmark sur tous les PC (Mac et realme compris) avec la même
image, en Q3, Q5, dering 2, avec et sans focus, à la taille en pixels de l'iPhone comme mes captures ».
Lu comme : l'étalon `00_Background.png`, le cas 1080p → 1440p de ses captures (×1,33), 300 images par
bande, et trois réglages — Q3 (`flat=3`, netteté 2,0), CR5 (`flat=5`, 2,0) et « borne texels » (`dr=2`,
netteté 1,5, CR5 : le candidat de J35) — chacun sans et avec la zone du regard (`gaze=1`, valeurs de la
table, poids tenu à 1) : six pages par appareil, la saveur « auto » du produit (WebGL2 sur PC, Mac et
Mali ; WebGPU sur l'iPhone). FSR1 et SGSR1 dans les mêmes pages, en repère.

**Outillage** : `scratchpad/fleet/compare_fleet.py` (DevTools de l'appareil par tunnel SSH ou `adb
forward`, le lab servi en http sur `127.0.0.1:8767` par tunnel inverse ou `adb reverse`, la table lue
dans `window.mwCompare`, les lignes d'adaptateur du renderer gardées, une capture par page) ;
`dualrtx.py` (Chrome sans tête épinglé par `--use-adapter-luid`, sonde WebGL2 + WebGPU sur une page du
lab avant toute mesure — `navigator.gpu` n'existe pas sur une URL `data:` — ; les LUID lus dans
`HKLM\SOFTWARE\Microsoft\DirectX`, 780M `0,88263`, RTX `0,77960` toujours bons) ; `summary.py`
(médiane des passes). Sur le realme, `/json/new` répond 500 : les onglets sont faits par le point
d'entrée navigateur (`Target.createTarget`, `activateTarget`, `closeTarget`), Chrome mis au premier
plan par `am start -n`. Conditions de 59 : UM790Pro écarté (test de Qwergin), N95 et mw-arm avec une
tâche planifiée Interactive — que mon classifieur a refusé d'enregistrer à distance : Bruno a lancé
lui-même les deux scripts par ssh depuis son poste (`ssh mw-arm powershell -NoProfile -Command - <
start-arm.ps1`, 14:15), un Chrome sans tête collé à sa console mourant avec elle ; Mac libre (dit par Bruno), mot pour Léo affiché puis retiré, Chrome dédié
`--mute-audio` ; DualRTX annoncé début et fin.

**Mesures (ms par image, moyenne de 300 images ; médiane des passes ; la saveur entre parenthèses) :**

| appareil (saveur) | passes | Q3 | Q3 + zone | CR5 | CR5 + zone | borne texels 1,5 CR5 | borne texels + zone | FSR1 | SGSR1 |
|---|---|---|---|---|---|---|---|---|---|
| iPhone 13 Pro, Safari (WebGPU `mwsr`, captures de Bruno 12:13-12:16) | 1 | 4,41 | 4,82 (100 images) | 4,82 | 5,13 | — | — | 7,94-8,26 | 4,39-5,04 |
| Mac M1 Pro, Chrome 155 (WebGL2 `gl-mwsr`) | 3 | 3,28 | 4,38 | 3,70 | 3,37 | 3,35 | 3,43 | 4,20 | 3,44 |
| DualRTX RTX 5060 Ti, Chrome sans tête (WebGL2 `gl-mwsr`, comparateur corrigé, 24/10 08:18, J38) | 1 | 0,98 | 0,94 | 0,96 | 1,03 | 0,98 | 0,93 | 0,91-1,99 | 0,94-1,78 |
| DualRTX 780M, Chrome sans tête (WebGL2) | 1 | 6,13 | 5,86 | 5,85 | 9,46 | 5,32 | 5,67 | 14,93 | 6,60 |
| UM790Pro, Radeon 780M, Chrome 155 sans tête (WebGL2 `gl-mwsr`, 18:09, J37) | 1 | 5,06 | 4,27 | 4,15 | 4,12 | 4,09 | 4,07 | 5,73-7,15 | 4,07-7,28 |
| N95 (mw-intel), Intel UHD, Chrome 155 sans tête (WebGL2) | 1 | 19,3 | 17,5 | 16,5 | 17,2 | 17,2 | 16,3 | 33,3 | 18,2 |
| mw-arm, Snapdragon 7c, Adreno 618, Chrome 156 sans tête (WebGL2 `gl-mwsr`, comparateur corrigé, 24/10 10:47, J38) | 1 | 21,6 | 18,3 | 20,4 | 20,0 | 21,5 | 18,1 | 31,5-80,3 | 19,3-69,5 |
| realme Note 60, Mali-G57, Chrome 155 (WebGL2) | 1 | 51,6 | 57,3 | 59,2 | 62,1 | 52,6 | 59,3 | 125 | 73 |

Passe par passe : Mac Q3 3,52 / 3,13 / 3,28, Q3 + zone 3,53 / 4,53 / 4,38, CR5 3,24 / 3,70 / 4,74,
CR5 + zone 8,01 / 3,22 / 3,37, borne texels 3,09 / 4,60 / 3,35, avec zone 3,30 / 4,38 / 3,43 (machine
chargée : load 5, les jeux de Léo en fond) ; 780M FSR1 de 11,4 à 17,2 et SGSR1 de 6,0 à 10,7 d'une page
à l'autre. Qualité (la même sur tous les appareils, au millième : les shaders sont déterministes) :

| réglage | SSIM | PSNR |
|---|---|---|
| Q3 | 0,940 | 24,5 |
| Q3 + zone | 0,937 | 24,5 |
| CR5 | 0,941 | 24,6 |
| CR5 + zone | 0,938 | 24,5 |
| borne texels, 1,5, CR5 | 0,951 | 25,5 |
| borne texels + zone | 0,945 | 25,3 |
| FSR1 / SGSR1 | 0,948 / 0,946 | 25,2 / 24,8 |

**Lecture.** (1) Le réglage ne change le temps que sur les téléphones : Q3 contre CR5, +9 % sur l'iPhone
(4,41 → 4,82) et +15 % sur le realme (51,6 → 59,2) ; sur le Mac, le 780M et le N95 l'écart est dans le
bruit des passes (N95 : Q3 19,3 contre CR5 16,5, dans l'autre sens, une passe). La borne texels ne coûte rien de plus que CR5, comme prévu (780M 5,3, realme 52,6, Mac 3,35).
(2) La zone du regard à poids 1 coûte +0,3-0,4 ms sur l'iPhone (+7-9 %), +3 à +7 ms sur le realme (+5 à
+11 %), rien de lisible sur le Mac et le 780M ; sur toute l'image elle retire 0,003-0,006 de SSIM et
0,1-0,2 dB (la netteté 2,5 au centre, J34). (3) Partout, MWSR reste loin sous FSR1 (iPhone 4,4-5,1
contre 8, Mac 3,4 contre 4,2, 780M 5-6 contre 15, N95 16-19 contre 29-36, realme 52-62 contre 125) et
au niveau ou sous SGSR1 (4,4-5,0 ; 3,4 ; 6,6 ; 17-22 ; 73). (4) À qualité égale ou meilleure que FSR1 (0,951 / 25,5 contre 0,948 / 25,2)
pour le temps de CR5, le candidat de J35 est la configuration à proposer à Bruno ; Q3 reste l'économie
des téléphones (-9 à -15 %) pour un dixième de SSIM en moins au millième.

**Manques et ratés.** Le N95 est fait (14:20-14:23, quatre connexions ssh, tâche retirée et vérifiée).
**Le mw-arm est invalide** : avec le même pilote, les trois algorithmes sortent à 310-350 ms par image
en médiane (MWSR 312, FSR1 350, SGSR1 340 ; moyennes 372, 359 et 1 574), dix fois un tracé 1440p sur
son Adreno 618 — un micro-banc dans le même Chrome donne 30 ms par tracé plein écran trivial, la fence
du comparateur correcte (300 sondages de 0,1 ms), `gl.finish()` 0,2 ms (un flush), et un tracé sur
huit figé 18 s. Un surcoût commun aux trois, donc hors shader : le portable à 3,6 Go qui pagine (893 Mo
libres, fichier d'échange en service, Discord et Parsec dans la session de Martin), ou l'import d'une
VideoFrame par tracé sur le pilote Qualcomm ; à reprendre avec le lab (recette du 22/10, lire les p50),
pas avec le comparateur. Le pilote a reçu `--ws-timeout` (une réponse DevTools peut prendre des minutes
sur une machine qui pagine) et la colonne p50. L'UM790Pro attend la fin du test de Qwergin et l'accord
explicite de Bruno. La passe RTX (13:12) est **invalide** : MWSR
mesuré à 125 ms par image, FSR1 jamais fini, le processus GPU de ce Chrome avec un compteur de
plantage récent (`--gpu-recent-crash-count`), et le pilote resté pendu 18 min sur sa socket DevTools
morte au lieu d'abandonner (délai de socket de 60 s ajouté depuis) ; tuée à 13:30:50 à la demande de
59, qui tenait f1 en attente ; un créneau RTX de deux minutes est demandé pour plus tard. Les deux
premiers essais DualRTX avaient échoué avant toute mesure (`navigator.gpu` absent sur `data:`, `wmic`
absent de Windows 11 26200) : les LUID n'étaient pas en cause.

## 2026-10-23 — J37, la borne des texels seuls par défaut (`DERING 2`) ; le comparateur sur NVIDIA, trois régimes

**Décision de Bruno (15:14, par 59)** : `DERING 2`, la borne des arêtes par les quatre texels seuls (J35),
devient le défaut du produit ; CR5, la netteté et la zone du regard restent comme avant (bilinéaire, 2,0,
zone coupée), en attente de ses décisions. Sa préférence à l'œil à ×1,33 (iPhone, 14:51) : plat Q3,
netteté 1,85, texels seuls, sans zone, 4,02 ms, SSIM 0,948, PSNR 25,4 dB contre FSR1 0,947 / 25,1 à
9,23 ms. À ×2 (720p → 1440p), MWSR lui paraît « baveux » à côté de FSR1, sur l'iPhone comme sur le DualRTX
(0,874 / 21,9 dB contre 0,880 / 22,1) : c'est structurel (J31 : raideur des contours 0,53-0,54 contre 0,55,
FLIP 0,057 contre 0,045 sur l'étalon ; la netteté sature sur `W_MIN`, le chemin plat n'affûte pas la
texture, RCAS si). Trois voies lui sont proposées : accepter ; FSR1 au-dessus de ×1,6 par le gouverneur là
où l'appareil le paie (FSR1 à 1440p : iPhone 8-9 ms, Mac 4,2, 780M 14,9, N95 33) ; un affûtage borné dans
MWSR au-delà de ×1,6 (étude). Décision attendue.

**Appliqué (16:33-16:45)** : `DERING: 2` dans `MWSR_OVERRIDE_SPEC` (les deux jumeaux lisent la même
table), le test unitaire (le défaut à 2 ; le GLSL cuit `DERING = 1u` sur demande), le comparateur
(`MWSR_DEF.dr` suit le produit : « texels seuls » par défaut, `dr=1` rend l'ancienne borne, étiquetée
« borne cinq puis texels »), le design §3.2 (9). `golden.json` refait sur SwiftShader (`chain-mwsr` =
`mwsr` au bit près sur les neuf cas) et revérifié par `--golden-check` ; conformité : côté WebGPU
`chain-mwsr` = `mwsr` exact partout ; côté WebGL (SwiftShader, « renderer on ANGLE (Google, Vulkan 1.3.0
(SwiftShader Device …)) » dans le journal de la passe) jumeau contre noyau text 0,057 dB, game 0,010,
code 0,020, FLIP 0,001 / 0,000 / 0,000 : OK ; 1726 tests, `npm run check` vert ; commit du jour sur
l'index privé. Pilote du parc : `dr=1` épinglé sur q3 / q3f / q5 / q5f, pour garder la borne mesurée en J36.

**Faux pas et fausse alerte.** La passe « côté WebGPU » (`--swiftshader --conformity`) crée un contexte
WebGL2 sur l'adaptateur par défaut, ici la RTX de l'écran, avant que le garde-fou `soft=1` de la page ne
le rejette : quelques millisecondes, aucune cellule rendue ; signalé à 59. Puis la table de conformité a
comparé au noyau d'aujourd'hui des clichés `conf-q-*-chain-gl-mwsr.png` **du 21/10** (noms sans étiquette
ni date ; leurs FLIP 0,071 / 0,019 / 0,029 sont ceux de J20) et conclu « pas la même qualité » : une heure
de fausse alerte sur « la RTX rend autre chose ». Une relance avec `--use-angle=swiftshader` côté WebGPU
coupe WebGPU (`requestAdapter returned null`), comme le commentaire du pilote le dit ; seule la passe
`--webgl-swiftshader` produit les clichés du jumeau. À faire un autre jour : l'âge de chaque cliché dans
la table, et « périmé » pour ce qui précède la passe.

**Le comparateur sur NVIDIA, en cours.** Trois régimes vus sur le DualRTX, aucun n'étant le temps GPU :
(1) le Chrome de Bruno, fenêtre du comparateur recouverte par une autre (14:49) : 110 ms par image pour
les trois shaders, Natif 0,46 ms, mesuré en premier, fenêtre encore visible ; (2) le même Chrome, fenêtre
seule au premier plan sur DISPLAY5 à 120 Hz (59, par l'extension, 16:29) : Natif 8,03 ms, MWSR 11,04,
FSR1 8,47, SGSR1 12,38, la cadence de l'écran : chaque itération attend une image du compositeur ; (3) un
Chrome sans tête épinglé sur la RTX 0 (bus 01:00 ; épinglage vérifié par la croissance des compteurs WDDM
du processus GPU pendant un dessin, le cumul comptant l'énumération des adaptateurs au démarrage) :
« chrono 225/300 » après 45 s, ~180 ms par itération, et au micro-banc (8 tours) : dessin trivial 1440p +
barrière 1,61 ms, import VideoFrame de canvas / VideoFrame CPU / ImageBitmap / canvas + dessin + barrière
4,77 / 2,67 / 0,94 / 1,12 ms, mais `WebGlRenderer` gl-mwsr sur `OffscreenCanvas(16,16)` redimensionné au
premier draw : 128 ms (110-132), 0,17 ms sans barrière ; avec une VideoFrame CPU 4 tours à 125 ms puis
0,9-3,9 ; avec une ImageBitmap 0,2-4. Le produit n'est pas en cause : la porte P4 (J20) a mesuré gl-mwsr
à 0,81-0,87 ms sur la RTX avec le labo, qui donne au renderer un OffscreenCanvas à la taille de sortie,
et le stream dessine dans le canvas visible. Second micro-banc prêt : trois sortes de canvas sur 30 tours,
requête de temps GPU, FSR1 et SGSR1, empreinte SHA-256 de la sortie sur une entrée déterministe, relevée
d'abord sur SwiftShader ; sur la RTX au go de Bruno (scripts de séance, hors dépôt).

**Second micro-banc (16:53, RTX 0 épinglée et vérifiée, 35 s, référence SwiftShader relevée avant).** La RTX
rend juste : PSNR contre SwiftShader sur la même entrée déterministe, gl-mwsr 63,1 dB (écart max 58/255 sur
0,10 % des pixels), gl-fsr1 61,9, gl-sgsr 62,9, toutes au-dessus du seuil de 45 dB fixé d'avance ; même
empreinte pour les trois sortes de canvas. Et les 125 ms ne sont pas du GPU : la requête de temps GPU donne
0,076 ms par dessin gl-mwsr 1440p. Tours (p50) : renderer sur OffscreenCanvas(16,16) 12 tours à 122-163 ms
puis 18 à 3-15 ; sur OffscreenCanvas(2560,1440) 30 tours sur 30 à 117-142 ; sur un canvas d'élément 3-8 dès
le troisième ; un renderer neuf sur OffscreenCanvas(16,16) avec begin/endQuery autour du dessin 0,9 ms ;
gl-fsr1 et gl-sgsr sur OffscreenCanvas 117-143. Lecture : la barrière attend une soumission D3D que le dessin
et le flush du comparateur ne provoquent pas sur ce pilote NVIDIA ; un canvas d'élément (commit du
compositeur) ou une requête de temps (endQuery) la forcent. C'est la clé des trois régimes : une soumission
par image d'écran dans une fenêtre visible, une soumission périodique sinon. Le produit dessine dans le
canvas visible du stream : non concerné. Troisième micro-banc prêt (barrière seule, finish, readPixels 1×1,
endQuery, flushs explicites, deux témoins nus sur OffscreenCanvas) : la gagnante deviendra le « done » du
comparateur sur WebGL2 ; UM790Pro : recette du N95 avec le LUID du 780M lu dans le registre, au go de 59.

**UM790Pro (18:09, au go de 59 après le « fait » de Bruno ; 50 s pour les six pages, 3 connexions ssh).** Chrome 155
sans tête dans la session Minis par une tâche planifiée Interactive lancée par Bruno lui-même (`ssh mw-um790win
powershell -NoProfile -Command - < start-um790.ps1`), épinglé sur le Radeon 780M par son LUID lu dans
`HKLM\SOFTWARE\Microsoft\DirectX` (l'entrée Radeon vue en dernier : la clé garde les vieux adaptateurs), vérifié
avant toute mesure (renderer WebGL2 `ANGLE (AMD, AMD Radeon 780M Graphics, D3D11)`, le pilote s'arrête sinon) ;
Chrome arrêté et tâche retirée à la fin (« chrome left: 0 », « task left: 0 »), prod, DEV, Sunshine, Parsec et les
deux mstsc intacts, aucun écran touché. Ligne ajoutée au tableau de J36 : Q3 5,06 ms, Q3 + zone 4,27, CR5 4,15,
CR5 + zone 4,12, borne texels 1,5 CR5 4,09, avec zone 4,07 ; FSR1 5,73-7,15, SGSR1 4,07-7,28 selon la page (la
première mesure d'une page neuve, pas le GPU : même écart que sur le 780M du DualRTX). Qualité au millième près
celle du tableau (0,951 / 25,5 dB pour la borne texels, 0,940 / 24,5 pour Q3) : les shaders sont déterministes.
Lecture : sur ce 780M sous Windows, MWSR coûte 4,1 ms quel que soit le réglage, FSR1 6 et SGSR1 4 à 7 ; la borne
texels, défaut depuis 15:14, est la meilleure des six en qualité au même temps. Piège levé au passage, après la
question de Bruno (« Je dois lancer quoi comme commande ? ») : un script lu sur l'entrée standard par
`powershell -Command -` n'exécute un bloc multi-lignes qu'après une ligne vide et le jette en fin de fichier sans
erreur ; la première version du script avait une boucle multi-lignes et se serait arrêtée avant la tâche. Réécrit
en une instruction par ligne et répété à blanc en local avant la ligne (les scripts N95 et mw-arm n'avaient pas
de bloc). Restent le troisième micro-banc RTX et la correction du « done » du comparateur, au go de 59.

**Troisième micro-banc (19:14, RTX 0 épinglée et vérifiée, 29 s ; go de Bruno par 59).** Dix façons de finir un
dessin gl-mwsr 1080→1440 du `WebGlRenderer` sur OffscreenCanvas, dix tours chacune après deux de chauffe (p50) :
barrière seule 122 ms ; `gl.finish()` puis barrière 125 ; `readPixels` 1×1 puis barrière 122 ; requête de temps
(`beginQuery`/`endQuery` TIME_ELAPSED) autour du dessin puis barrière **4,7 ms** (temps GPU 1,7-2,7 ms, horloges au
repos) ; canvas d'élément, barrière seule 8,0 ms sur cinq tours puis 0,8-1,3 ; offscreen de nouveau 129 ;
flush-barrière-flush 114 ; flush, tâche, flush, barrière 130 (pics 300-870) ; contexte nu sur
OffscreenCanvas(2560×1440), attributs du renderer, dessin trivial + barrière 0,90 ms ; attributs par défaut 0,84.
Lecture : ni `finish`, ni `readPixels`, ni les flushs ne font soumettre sur ce pilote ; seule la requête de temps le
fait (et le commit du compositeur sur un élément, quantifié à la période d'écran) ; et un contexte nu n'a pas le
problème : c'est un pas du chemin du renderer avec une VideoFrame (banc 1 : contexte nu + même VideoFrame 2,7 ms ;
renderer + ImageBitmap 0,2-4 ms ; renderer + VideoFrame CPU lent quatre tours puis rapide) qui laisse le travail
non soumis ; candidat à vérifier un autre jour, la barrière que le renderer pose lui-même à chaque dessin
(`_setFence`, lue au dessin suivant). Produit non concerné (canvas visible, porte P4 0,8 ms).

**Correction du comparateur (19:20, commit local du soir).** `compare.js` : sur WebGL2, quand
`EXT_disjoint_timer_query_webgl2` existe, `timeAlgo` enveloppe chaque dessin (chauffe comprise) dans une requête
TIME_ELAPSED créée, ouverte, fermée après le dessin et supprimée, puis la barrière comme avant ; sans l'extension
(Safari, Firefox) rien ne change, et là la soumission est immédiate (Mac, Intel, Mali, 780M mesurés sains). Aucun
changement d'UI, `frontend/` intact (gel de 59 jusqu'à 02:30). Test sur SwiftShader (Chrome sans tête, aucun moteur
3D n'a bougé, `softcompare.py` de séance) : q5 MWSR 44,4 ms, FSR1 90,4, SGSR1 69,8 ; d2 39,9 / 107,2 / 48,8 ;
qualité 0,941 / 24,6 et 0,951 / 25,5, chemin `gl-mwsr:frame` : les chiffres d'avant la correction (référence du
banc 2 : 40 / 89 / 48). Restent, au go : la RTX à remesurer au comparateur (sa ligne du parc) et mw-arm à refaire ;
la boucle de mesure du labo (`scaler_lab`) n'a pas ce « done » et ses chiffres RTX de P4 étaient sains (0,8 ms) ;
à faire un autre jour : la colonne du temps GPU par la même requête.

## 2026-10-24 — J38, la RTX au comparateur corrigé : les trois shaders au plancher d'une passe

**Contexte.** Go de Bruno à 07:5x par 59, « à toi » à 08:18 après le banc c2 de dualgpu (les deux cartes rendues
à 180 W, topologie d'origine). Recette épinglée de J36 (`dualrtx.py --gpu rtx0`) : Chrome sans tête, profil
propre, muet, `--use-adapter-luid=0,77960` (LUID 0x13088 inchangé : pas de redémarrage depuis le 19/10), sondes
WebGL2 et WebGPU « NVIDIA », croissance des compteurs WDDM pendant un dessin 21 043 sur 0x13088 et 0 sur le 780M,
NVENC 0 session, plafond 130 s ; 32 s au total, « chrome left: 0 », ni --dev ni écran touchés.

**Mesures (ms par image, 300 images, chemin `gl-mwsr:frame`)** : Q3 0,98 (p50 0,85), Q3 + zone 0,94, CR5 0,96,
CR5 + zone 1,03, borne texels 1,5 CR5 0,98, avec zone 0,93 ; FSR1 0,91-1,99 et SGSR1 0,94-1,78 selon la page ;
qualité au millième celle de la table (0,951 / 25,5 pour la borne texels). Ligne ajoutée au tableau de J36 ; la
passe du 23/10 à 15:20 (180 ms par itération, le régime 3 de J37) est remplacée.

**Lecture.** Avec la requête de temps autour du dessin, la barrière du comparateur revient en 1 ms sur NVIDIA, le
chiffre du labo à P4 (0,8 ms) : les trois shaders sont au plancher d'une passe plein écran sur cette carte, et
les écarts entre réglages (0,93-1,03) sont le bruit d'une page à l'autre, comme ceux de FSR1 et SGSR1 (première
mesure d'une page neuve). Le comparateur donne maintenant sur NVIDIA ce qu'il donnait déjà sur AMD, Intel et
Apple ; reste mw-arm (Qualcomm, Adreno 618), à la ligne de Bruno après le test dualgpu.

**mw-arm (10:26-10:47, au mot de 59 après le test dualgpu ; Chrome 156 sans tête lancé par la ligne de Bruno,
tâche Interactive ; serveur du lab relancé sur 8767, Claude Code l'ayant arrêté pour mémoire basse ; 4 connexions
ssh).** D'abord la sonde CR5 avec le comparateur corrigé de la veille : toujours 298 ms par image (p50 210), FSR1
341, SGSR1 1 098, la machine saine cette fois (949 Mo libres, échange 464 Mo, charge 1) : la correction de J37 ne
mord pas sur ce pilote. Quatre micro-bancs dans le même Chrome (`cdpeval.py` à travers le tunnel : `rtxbench.js`,
`armbench2.js` à `armbench4.js`, 6 à 16 s chacun) :
(1) contexte nu : dessin trivial + barrière 2,8-8 ms, envoi d'une VideoFrame 1080p + dessin 11-14 ms (35 pour une
VideoFrame CPU), bitmap 9 ; renderer : dessin + barrière 167-215 ms quel que soit l'intrant (VideoFrame, bitmap),
l'appel lui-même 0,7 ms ; (2) le redimensionnement du canvas hors de cause : nu, né à 2560×1440 ou redimensionné
comme le renderer (16 → 1920×1080 → 2560×1440), 3-5 ms ; renderer sans redimensionnement (720p → 1080p) 196 ms ;
(3) les suspects un à un dans le renderer : **sa barrière par dessin retirée (`_setFence` / `_checkFence`) → 26 ms** ;
requête de temps gardée jusqu'après la barrière → 21 ms (temps GPU 12-15 ms) ; `gl.finish()` 201 ; gl-fsr1 224,
gl-sgsr 232, copie simple `off` 175 : ce n'est pas le noyau ; (4) la durée de vie de la requête : supprimée aussitôt
fermée (la correction de J37) → 195 ms, barrière du renderer retirée ou non (189) ; gardée jusqu'après la barrière →
23 ms ; lue → 19 ms ; sans requête ni barrière du renderer → 16 ms.

Lecture : sur le pilote D3D11 de Qualcomm comme sur celui de NVIDIA, un objet de synchronisation laissé en attente (la
barrière que le renderer pose après chaque dessin et lit au dessin suivant ; ou une requête fermée puis supprimée
avant d'être achevée) retarde de 120 à 190 ms l'achèvement vu par la barrière suivante ; une requête de temps vivante
jusqu'à la barrière lève l'attente sur les deux pilotes. La boucle du labo n'a pas le problème parce qu'elle mesure
par lots. **Correction** : `compare.js` garde la requête jusqu'après `glDone` et la supprime ensuite (un dessin qui
lève laisse la sienne, supprimée au suivant) ; prettier et `node --check` verts ; SwiftShader inchangé (q5 46,7 /
93,6 / 70,2 ; d2 40,2 / 112,2 / 48,2 ; qualité 0,941 / 24,6 et 0,951 / 25,5). Sonde CR5 ensuite : 18,5 ms (p50 16,8),
FSR1 34,7, SGSR1 23,7, les chiffres du labo de J25 (`done` p50 14-17 et 29-35). **Les six pages (300 images)** :
Q3 21,6 (p50 15,8), Q3 + zone 18,3, CR5 20,4, CR5 + zone 20,0, borne texels 1,5 CR5 21,5, avec zone 18,1 ; FSR1
31,5-80,3 et SGSR1 19,3-69,5 selon la page (machine bruyante, première mesure d'une page neuve) ; qualité au millième
celle de la table. Ligne ajoutée au tableau de J36 : sur l'Adreno 618 sous Windows, MWSR coûte 18-22 ms par image
à 1080p → 1440p quel que soit le réglage (p50 15-18), sous SGSR1 et loin sous FSR1, comme au labo (0,63-0,77 ×
SGSR1 en J25). Ménage vérifié (« chrome left: 0 », « task left: 0 »), tunnel fermé, 0 ssh.

Question pour le produit (P5, à Bruno ; rien changé) : la barrière par dessin du renderer sert au gouverneur
(`takeGpuBehind`, part des dessins dont le GPU n'a pas fini au dessin suivant). Sur un canvas d'élément le
compositeur soumet à chaque image et la barrière du RTX signale en 1 ms (banc 3 de J37) ; sur Qualcomm en flux réel,
vérifier au `/bench` avec `mwsr` qu'elle ne compte pas de faux « GPU en retard » (ce serait une descente d'échelle
injustifiée sur mw-arm).
