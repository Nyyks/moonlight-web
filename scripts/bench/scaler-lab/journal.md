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
