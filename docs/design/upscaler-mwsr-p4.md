# Upscaler `mwsr` — rapport de la phase P4 (intégration et jumeau WebGL2)

Plan : `upscaler-mwsr.md` (§3.6 le jumeau, §4.3 les régimes, §12.1 P4). Rapports précédents :
`upscaler-mwsr-p0.md` à `-p3.md`. Journal du labo : `scripts/bench/scaler-lab/journal.md` (J17, J18).
Session « Shader Upscaler », 21/10/2026 après-midi, Fable 5.1 `max` (gardé par Bruno après le
`/compact` de fin de P3). Commits `e965e9f9` (WebGPU), `031805ab` (jumeau GLSL et conformité),
`83aedfad` (échelle, menu, drapeau), `48bb8213` (CI).

## 1. Ce que P4 a construit

- **`mwsr` dans `WebGpuRenderer`** (`algo: 'mwsr'`) : un pipeline par régime (`mwsrRegimes()` :
  le noyau `up`, et les grilles de la réduction), tous construits à la création et spécialisés par
  `override` (`CHROMA444` quand le flux est 4:4:4, `R_DOWN` et `LINEAR_LIGHT` pour les grilles),
  le régime choisi par image par `mwsrRegime()` depuis la taille de l'image et celle du canvas, le
  bloc d'uniformes réécrit quand ces tailles changent, deux bind groups gardés avec la texture
  d'entrée. En SDR le canvas et la texture de la passe 0 sont créés avec leur format de vue `-srgb`
  (`viewFormats`) ; la réduction lit et dessine à travers ces vues, donc un échantillon bilinéaire
  est tout le filtre jusqu'à ×0,5, en lumière linéaire exacte, au coût de la copie (J15). Si le
  navigateur refuse les formats de vue, ou si le canvas est flottant (HDR), la réduction retombe sur
  la lumière logicielle et la grille 2×2. Le module f16 (`half`) est demandé à tout adaptateur qui a
  `shader-f16` et n'est pas NVIDIA (`WebGpuRenderer._requestDevice`), HDR compris ; le drapeau
  `yuv444` descend de `StreamView` et du worker.
- **Le jumeau GLSL ES 3.00** : `mwsrGlsl()` écrit le texte de chaque mode depuis les mêmes tables que
  `mwsrWgsl()` (les overrides cuits en constantes, deux `vec4` pour le bloc d'uniformes, `mediump`
  sur les couleurs et les poids du chemin contour) ; `WebGlRenderer` le joue sous la clé `gl-mwsr`,
  un programme par régime, le régime par image comme sur WebGPU ; la réduction y moyenne en lumière
  logicielle (un tampon WebGL2 n'a pas de vue sRGB). Les deux renderers rangent le pipeline ou le
  programme d'un régime sous la même clé (`mwsrRegimeKey()`).
- **L'échelle, le menu, le drapeau** : `mwsr` entre dans `ENHANCER_LADDER` entre `sgsr` et `off`
  (il coûte moins que SGSR1 sur tout GPU mesuré, 0,4 à 0,8 ×, pour la netteté de FSR1 : une session
  descendue garde une image nette un cran de plus) ; la mémoire du gouverneur range des noms, rien à
  migrer. `StreamView` route `mwsr` et `gl-mwsr` comme les trois ports (le HDR déplace la saveur
  WebGL2 vers WebGPU, l'overlay nomme les deux), le menu debug offre les deux saveurs (en, fr, zh),
  et `auto` prend `mwsr` dans les deux saveurs derrière le drapeau `localStorage.mw_mwsr = '1'`
  (`BrowserDetect.mwsrPreferred`) jusqu'à la décision de P6. Sans le drapeau, rien ne change pour
  `auto`.
- **Le labo** : la chaîne du produit avec la clé (`chain-mwsr`), la chaîne WebGL2 (`chain-gl-<passe>`,
  jeu `glchain`), captures et dumps des cellules chain (le canvas présenté copié dans la texture de
  sortie), images RGBA faites des mires avec `codec=none` (les texels exacts de la texture d'entrée),
  `chain-mwsr` dans les dorés ; le flux de conformité (`scaler_lab.py --conformity`, `p4_flows.py`) ;
  un mode `gl=1` de la page (WebGL2 seul, dumps par un canvas 2D) pour le Chrome où WebGPU est éteint ;
  un chien de garde du pilote (`--page-timeout`) ; le bouton `mwsr:fine=1`.
- **La CI** : un job `scaler-lab` (non bloquant) joue la conformité sur les adaptateurs logiciels d'un
  runner hébergé (Chrome stable, Python : websocket-client, numpy, Pillow, scikit-image) : chaque
  texte de shader que construisent les renderers y compile, la chaîne WebGPU donne l'image du noyau,
  le jumeau la même qualité. Le pilote trouve Chrome par `MW_CHROME` ou le PATH hors de DualRTX.

## 2. L'intégration WebGPU, vérifiée au pixel

Sur SwiftShader (`--swiftshader --golden`), la cellule `chain-mwsr` — le `WebGpuRenderer` du produit
sur un `OffscreenCanvas`, passe 0 comprise — a **l'empreinte exacte** du noyau (`mwsr`) sur les six
cas d'agrandissement (texte, jeu, code ; ×2 et ×1,33) et celle de la réduction par vues sRGB
(`mwsr:srgb=1`) sur les trois cas à ×0,5 (texte, zone-plate, code) : neuf sur neuf, `golden.json`
régénéré, les empreintes des autres cellules inchangées. Les vues sRGB du produit font donc ce que la
cellule du labo faisait ; le coût (le plancher) a été confirmé au GPU en P3 (J15, 14:33).

Deux détails du chemin : la table calculée (`LINEAR_LIGHT 1`, 2×2) sert quand `ctx.configure`
refuse `viewFormats` (essai dans un `try`, repli silencieux avec un avertissement console) et sur le
canvas `rgba16float` du HDR `linear` ; l'adaptateur NVIDIA n'a pas le module f16 (`half` n'y gagnait
rien, P2.3), les autres l'ont dès que `shader-f16` est là.

## 3. Le jumeau GLSL et la conformité (C11)

Le premier passage de conformité (SwiftShader, les deux côtés) a trouvé trois choses.

1. **`dFdy` de GL est `dpdy` de WebGPU changé de signe** : la fenêtre GL a son y vers le haut, le
   framebuffer WebGPU vers le bas. Sans la négation, la normale du contour sortait en miroir et les
   taps « le long » et « en travers » s'échangeaient sur toute diagonale : texte ×2 à 27,7 dB du noyau,
   28 % des pixels différents, écart maximal 221/255. Corrigé dans `mwsrGlsl()` (texte et test).
2. **Le dump d'une chaîne dessinait l'image du clip où en était le curseur** (le carré mobile des
   mires ailleurs que dans l'image des cellules du noyau : un bloc de 30×30 à 174/255). Les dumps et
   captures des chaînes dessinent maintenant la première image.
3. **La ligne de référence des dérivées « coarse » est le choix de l'implémentation**, et il diffère
   entre les deux espaces fenêtre : après la correction du signe, texte ×2 reste à 34,3 dB du noyau,
   25 % des pixels différents, 17 % au-delà de 2/255, maximum 76/255 ; les pixels plats concordent
   (0,6 % différents, par le vote au seuil), les pixels de contour diffèrent à 44 % mais **autant
   d'un côté que de l'autre de la bilinéaire** (écart moyen à la bilinéaire 20,55 contre 20,54/255,
   même côté 86 %). Le bouton `mwsr:fine=1` (dérivées `dpdxFine`/`dpdyFine` en WGSL) montre la
   sensibilité : le noyau coarse et le noyau fine diffèrent de 13 % des pixels au-delà de 2/255
   (max 83), et le GL n'est ni l'un ni l'autre (13,1 % contre fine, 16,9 % contre coarse). Ce n'est
   pas un bug de port : la direction du contour vient d'une estimation par quad dont la ligne de
   référence n'est pas spécifiée ; deux GPU différents sous le même WGSL peuvent différer autant.

Le critère C11 (« écart maximal WGSL/GLSL ≤ 2/255 ») est donc **reformulé en deux volets** dans le
flux de conformité :

- **pixels**, là où aucune dérivée n'intervient : la réduction. Mesuré : ≤ 1/255 sur texte et code à
  ×0,5 (2,2-4,5 % des pixels différents d'un niveau), 3/255 sur 0,009 % des pixels de la zone-plate
  (précision sous-texel différente des deux échantillonneurs : la tolérance admet 2/255 sur 99,9 % des
  pixels et 4/255 au plus). La chaîne WebGPU, elle, est tenue à l'identité : 0/255 sur les neuf cas ;
- **qualité égale face à la vérité terrain** pour le noyau (le flux `--quality` : mire au format de
  sortie, réduite Lanczos-3 en lumière linéaire vers l'entrée, ×2, texte, jeu, code) :

| contenu | | PSNR dB | SSIM | dépassements | FLIP |
|---|---|---|---|---|---|
| texte | `mwsr` WGSL | 17,41 | 0,8415 | 0 % | 0,071 |
| | `gl-mwsr` GLSL | 17,44 | 0,8425 | 0 % | 0,071 |
| | (bilinéaire / SGSR1 source / FSR1) | 16,99 / 17,81 / 17,57 | 0,816 / 0,857 / 0,845 | 0 / 2,3 / 0,3 % | 0,090 / 0,065 / 0,068 |
| jeu | `mwsr` WGSL | 35,84 | 0,8816 | 0 % | 0,019 |
| | `gl-mwsr` GLSL | 35,84 | 0,8816 | 0 % | 0,019 |
| | (bilinéaire / SGSR1 / FSR1) | 35,01 / 35,52 / 35,55 | 0,880 / 0,882 / 0,887 | 0 / 0,7 / 0,03 % | 0,020 / 0,018 / 0,017 |
| code | `mwsr` WGSL | 26,95 | 0,9555 | 0 % | 0,029 |
| | `gl-mwsr` GLSL | 26,96 | 0,9559 | 0 % | 0,029 |
| | (bilinéaire / SGSR1 / FSR1) | 26,96 / 26,86 / 27,35 | 0,953 / 0,945 / 0,951 | 0 / 4,9 / 1,3 % | 0,034 / 0,026 / 0,024 |

Le jumeau GLSL vaut le noyau WGSL à 0,000 FLIP, 0,025 dB et 0,001 SSIM près (seuils du flux : 0,002
FLIP, 0,1 dB, 0,1 % de dépassements) — et les deux se placent où P2 avait mis le noyau : entre le
bilinéaire et FSR1, sans dépassement. **C11 tenu sous cette forme.**

Pourquoi deux Chromes : forcer ANGLE sur SwiftShader (`--use-gl=angle --use-angle=swiftshader`)
éteint WebGPU dans ce Chrome, adaptateur de secours compris (essayé avec `--ignore-gpu-blocklist`,
`--use-webgpu-adapter=swiftshader` : `requestAdapter` rend `null`). Le côté WebGL2 tourne donc dans
son propre Chrome (`--webgl-swiftshader`, page en mode `gl=1`), le côté WebGPU dans le sien
(`--swiftshader`), chacun déposant ses dumps sous les mêmes noms, et le flux compare ce qui est sur le
disque ; sur un GPU (un Chrome pour les deux) un seul passage fait tout. Le premier essai, qui laissait
WebGL sur le GPU par défaut de la machine dans le Chrome du labo, pendait sans fin (une promesse jamais
résolue retenait le pilote, dix minutes perdues) : d'où le chien de garde `--page-timeout`, qui imprime
le journal de la page et fait échouer le cas.

## 4. Ce que P4 laisse

- **La porte P4** (`high`, plan §12.1) : WebGPU contre WebGL2 avec le nouveau shader, par classe
  d'appareil. Le labo a ce qu'il faut (`chain-mwsr`, `chain-gl-mwsr`, le jeu `glchain`, le mur par
  draw des deux côtés ; les horodatages GPU manquent au côté WebGL2 : `EXT_disjoint_timer_query_webgl2`
  à brancher si la porte en a besoin sur ordinateur). Elle demande le go de 59 pour le RTX et le 780M,
  et les créneaux de Bruno pour le Mac, l'iPhone (WebGL2 seul y était la production SDR), le realme
  et `mw-arm` (WebGL2 seul : Adreno 618 sans WebGPU). C'est aussi là que le drapeau `mw_mwsr` se
  joue sur la `--dev` (l'overlay, le menu, les deux saveurs, le 1:1).
- **Le realme** : `ext-mwsr` (l'externe y est RGBA : la passe 0 — 0,9 ms — serait évitable sur cette
  famille d'Android, décision par `frame.format`) ; le 4×4 sous ×0,25.
- **`malioc`** sur le texte GLSL (reporté depuis P2.2) : non installé sur DualRTX.
- **Validation statique** : aucun compilateur WGSL ou GLSL n'existe sous Node ; les tests `vitest`
  tiennent la structure des textes (constantes partagées, offsets des grilles, dérivées avant la
  branche, niveau explicite, rien d'interdit) et le job CI les compile pour de vrai sur SwiftShader.
- **La ligne de référence des dérivées** : si P5 montre une différence visible entre GPU (le même WGSL
  sur Apple, NVIDIA, AMD, Mali), le vote pourra prendre `dpdxFine`/`dpdyFine` (le bouton existe) ou
  un gradient symétrique à deux échantillons de plus ; rien ne l'indique aujourd'hui.
