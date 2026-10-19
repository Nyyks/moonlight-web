# Upscaler `mwsr` — rapport de la phase P0 (labo et lignes de base)

> Phase P0 du plan `upscaler-mwsr.md` (§6.4, §7, §9), jouée la nuit du 19 au 20/10/2026 sur
> DualRTX. Ce que P0 devait établir avant toute ligne de noyau : le coût de l'échantillonnage
> direct de la texture externe contre « passe 0 + RGBA » (décision n° 2 du §0), le coût des
> dérivées d'écran (la base du vote), la dispersion des horodatages GPU par machine, et les
> lignes de base des cinq techniques en place, chaîne telle que livrée et noyau seul.
> Les téléphones (iPhone 13 Pro, realme Note 60), le Mac M1 et `mw-arm` restent à jouer aux
> créneaux de Bruno : ce rapport est **ordinateur seulement**, deux GPU.

## 1. L'instrument

`scripts/bench/scaler-lab/` : une page (`scaler-lab.html` + `scaler-lab.js`) et son pilote
(`scaler_lab.py`).

- **Les cellules** sont des chaînes de passes plein écran rendues dans une texture hors écran à
  la taille de sortie (le format du canvas, `bgra8unorm` sous Windows). Trois feeds, règle 1 du
  §7.1 : `ext-*` lit la `VideoFrame` décodée par une `texture_external` (aucune passe 0) ; `tex-*`
  lit une `rgba8unorm` déjà matérialisée (le noyau seul) ; `blit+*` paie d'abord la passe 0 du
  renderer (externe → `rgba8unorm`) puis le noyau : la chaîne que les enhancers WebGPU livrés
  paient aujourd'hui. `chain-*` pilote **le `WebGpuRenderer` du produit, inchangé**, sur un
  `OffscreenCanvas` (import, bind group par image, `draw()` attendu jusqu'à
  `onSubmittedWorkDone` comme la page le fait) ; ses passes sont horodatées de l'extérieur par
  des crochets sur les prototypes WebGPU (rien dans le produit).
- **Les shaders de référence sont lus dans le texte du module du produit** (`SGSR_WGSL`,
  `EASU_WGSL`, `RCAS_WGSL`, `NIS_WGSL`, `BLIT_WGSL`) : le labo mesure ce qui est livré. `sgsr-src`
  est le même port avec les constantes publiées par Qualcomm (seuil 8/255, netteté 2,0, delta
  borné à ±23/255), le témoin de la règle 6 du §7.1.
- **Les images** sont dessinées par la page à la taille d'entrée : `text` (trois colonnes de
  serif, comme `still.html`), `ui` (panneau sombre, cartes, lignes fines), `game` (dégradés,
  silhouettes nettes, grain, HUD). Les `VideoFrame` viennent d'une boucle WebCodecs
  encodeur → décodeur dans la page (H.264 High, 20 Mbit/s, matériel), avec un petit carré qui
  bouge pour que le clip ait des P-frames : la texture externe est une vraie **NV12 du décodeur**
  (`frame.format = "NV12"`, lue sans copie par Chrome, §2.7 du plan), pas une copie RGBA.
- **La mesure** : `timestamp-query` autour de chaque passe, Chrome lancé avec
  `--enable-webgpu-developer-features` (sinon les horodatages sont quantifiés à 100 µs) ; les
  itérations sont regroupées par lots de 16 dans un seul tampon de commandes, résolues une fois
  par lot, de sorte que l'aller-retour de la barrière n'entre jamais dans le chiffre GPU ; 2
  lots de chauffe, 8 lots mesurés, 3 tours entrelacés (ABBA), médiane, p90, p99, et la
  **dispersion** = écart des médianes de tour sur la médiane. `wall/iter` est en plus le temps mur
  `submit → onSubmittedWorkDone` ramené à l'itération. Le mode `pace=tick` soumet une itération
  toutes les 16,7 ms (le régime d'un flux à 60 i/s, horloges GPU au repos).
- Chrome 155.0.8059.84, sans tête (`--headless=new`), profil et drapeaux propres au labo, GPU
  choisi par `--use-adapter-luid` (les deux préférences `powerPreference` rendent le RTX sur
  cette machine ; le 780M n'est atteint que par son LUID, lu par `IDXGIFactory1`).

Validation d'abord sur l'adaptateur logiciel (SwiftShader, règle « WARP d'abord ») : les 27
cellules compilent, dessinent (recadrages PNG relus) et s'horodatent avant tout GPU réel.

## 2. Le parc, relevé

| Machine | GPU | `adapter.info` | Fonctionnalités utiles au plan |
|---|---|---|---|
| DualRTX | RTX 5060 Ti | `nvidia blackwell 0x2d04` | `shader-f16`, `subgroups`, `subgroup-size-control`, `timestamp-query`, `float32-filterable`, `bgra8unorm-storage`, `dual-source-blending`, `texture-formats-tier2` |
| DualRTX | Radeon 780M | `amd rdna-2 0x13c0` (Chrome dit « rdna-2 » pour ce gfx1103) | la même liste que le RTX : `shader-f16`, `subgroups`, `timestamp-query`, `float32-filterable`, `bgra8unorm-storage`, `dual-source-blending`, `texture-formats-tier2` |
| DualRTX | Arc A380 | **absente** de l'énumération DXGI le 19/10 (RTX ×3 dont deux doublons IddCx, AMD, Basic Render) | — |

Décodeur WebCodecs : H.264 matériel sur les deux GPU, sortie NV12.

## 3. RTX 5060 Ti

Dispersion tour à tour ≤ 1,7 % sur toutes les cellules en `back` ; horodatages à la
nanoseconde (0,007 ms se lit). Sortie 2560×1440 sauf la ligne ×1.

| Cellule (×2, 720p → 1440p) | texte | jeu | ×1,33 texte | ×1 texte (1080p) |
|---|---|---|---|---|
| `blit` (passe 0 seule, à la taille d'entrée) | 0,007 | 0,007 | 0,017 | 0,017 |
| `ext-s1` (1 bilinéaire sur l'externe) | 0,028 | 0,028 | 0,030 | 0,017 |
| `ext-s5` / `ext-s9` | 0,057 / 0,096 | 0,056 / 0,096 | 0,065 / 0,102 | 0,040 / 0,062 |
| `ext-l1` / `ext-l5` (`textureLoad` sur l'externe) | 0,028 / 0,066 | 0,028 / 0,066 | 0,031 / 0,071 | 0,018 / 0,041 |
| `ext-s1-fw` (1 bilinéaire + `fwidth` de la luma) | 0,028 | 0,028 | 0,033 | 0,019 |
| `tex-s1` / `tex-s2` (le plancher bilinéaire, et un 2ᵉ échantillon) | 0,028 / 0,028 | 0,028 / 0,028 | 0,028 / 0,028 | 0,016 / 0,016 |
| `tex-s5` / `tex-s9` | 0,047 / 0,084 | 0,047 / 0,085 | 0,047 / 0,085 | 0,026 / 0,047 |
| `tex-s1-fw` | 0,028 | 0,028 | 0,028 | 0,016 |
| `blit+tex-s1` / `blit+tex-s5` / `blit+tex-s9` | 0,037 / 0,056 / 0,093 | 0,037 / 0,056 / 0,093 | 0,050 / 0,069 / 0,106 | 0,034 / 0,045 / 0,066 |
| `sgsr-repo` / `sgsr-src` (noyau seul) | 0,073 / 0,073 | 0,066 / 0,066 | 0,066 / 0,066 | 0,039 / 0,039 |
| `nis` | 0,439 | 0,420 | 0,510 | 0,194 |
| `easu` / `rcas` / `fsr1` (EASU → interm → RCAS) | 0,187 / 0,056 / 0,247 | 0,188 / 0,056 / 0,246 | 0,188 / 0,057 / 0,247 | 0,104 / 0,031 / 0,137 |
| `blit+sgsr-repo` / `blit+fsr1` (la chaîne livrée, dans le labo) | 0,087 / 0,259 | 0,075 / 0,252 | 0,093 / 0,273 | 0,060 / 0,161 |
| `chain-off` / `chain-sgsr` / `chain-nis` / `chain-fsr1` (le renderer du produit, GPU) | 0,030 / 0,088 / 0,448 / 0,262 | 0,030 / 0,078 / 0,432 / 0,260 | — | — |
| `chain-*`, temps mur de `draw()` (import + barrière) | 2,66 / 3,94 / 4,27 / 4,15 | 2,25 / 3,65 / 3,51 / 3,55 | — | — |

Deux cas de plus sur le RTX : **×0,75 (1440p → 1080p, texte)** : `blit` 0,030 (la passe 0 écrit
l'entrée 1440p), `ext-s1` 0,020 contre `blit+tex-s1` 0,052, `ext-s5` 0,041 contre 0,063, `ext-s9`
0,062 contre 0,084 : en réduction la lecture directe gagne nettement, même ici ; `sgsr-repo` 0,039,
`fsr1` 0,137, `nis` 0,207. **×2 image d'interface** : `sgsr-repo` 0,038 (contre 0,073 sur le
texte : sa sortie anticipée joue), `nis` 0,309, `easu` 0,187 et `fsr1` 0,246 (sans sortie anticipée,
insensibles au contenu), feeds identiques au texte.

**Au régime d'un flux (`pace=tick`, une soumission toutes les 16,7 ms, ×2 texte)** : les
cellules `tex-*` gardent leurs chiffres (`tex-s1` 0,031, `sgsr-repo` 0,076, `easu` 0,188, `nis`
0,434) ; tout ce qui touche la texture externe ou enchaîne deux passes devient **bruyant** :
`ext-s1` 0,138 médian, p99 1,08 (dispersion 67 %) ; `blit` 0,014 médian, p99 0,22 ; `fsr1` 0,51
médian, p99 1,5 ; `blit+fsr1` 0,57 / 2,45. Et le temps mur par soumission est **3,3 à 3,8 ms quelle
que soit la cellule**, y compris `blit` à 0,014 ms de GPU : sur ce GPU, à 60 i/s, le prix d'une
image WebGPU est l'aller-retour de la soumission (processus GPU de Chrome, barrière), pas le
shader — c'est le « 4 ms Windows » du 03/09 retrouvé, et c'est ce que P1 et la porte P4
mesurent, pas P2.

**Ce que le RTX dit pour les quatre questions de P0.**

1. *Externe contre RGBA* : `ext-s1` = `tex-s1` = 0,028 ms, `ext-s5` 0,057 contre `blit+tex-s5`
   0,056, `ext-s9` 0,096 contre 0,093 : **à égalité**, la passe 0 ne coûte que 0,007-0,017 ms
   ici et l'échantillon externe ne coûte rien de plus que l'échantillon RGBA (le double fetch
   Y + UV est absorbé). `textureLoad` sur l'externe vaut l'échantillon (`ext-l1` 0,028) et un peu
   plus à cinq (0,066 contre 0,057). En `tick`, en revanche, l'externe est la source de tout le
   bruit (p99 1,08 ms contre 0,036 pour `tex-s1`) : la synchronisation avec le décodeur se paie
   par image et apparaît dans le temps de la passe.
2. *Dérivées* : `fwidth` de la luma coûte **zéro** (`tex-s1-fw` = `tex-s1`, `ext-s1-fw` =
   `ext-s1`), et un deuxième échantillon aussi (`tex-s2` = `tex-s1`) : la passe est bornée par
   l'écriture de la cible (14,7 Mo en 1440p), pas par le calcul ni par un fetch de plus. Le
   vote par dérivées est gratuit sur ce GPU.
3. *Dispersion* : ≤ 1,7 % en `back` ; 40-140 % sur les cellules externes en `tick`.
4. *Lignes de base, noyau seul à ×2* : bilinéaire 0,028 ; SGSR1 0,066-0,073 (2,4-2,6 × le
   plancher ; les constantes de Qualcomm ne changent rien au temps, comme leur README le dit) ;
   RCAS 0,056 ; EASU 0,19 ; FSR1 0,25 ; NIS 0,44. Chaîne livrée : SGSR1 0,088, FSR1 0,26, NIS
   0,45 ms (le renderer du produit, mesuré de l'extérieur, retrouve le labo à 0,01 ms près).

## 4. Radeon 780M (iGPU, mémoire partagée)

Dispersion tour à tour ≤ 2,6 % en `back` (5-6 % sur les deux cellules sous 0,5 ms). Le GPU
qui compte pour le plan : c'est lui qui ressemble à un portable ou à une tablette. GPU p50 en ms,
sortie 2560×1440 sauf les colonnes ×1 (1080p) et ×0,75 (1440p → 1080p).

| Cellule | ×2 texte | ×2 jeu | ×2 interface | ×1,33 texte | ×1 texte | ×0,75 texte |
|---|---|---|---|---|---|---|
| `blit` (passe 0 seule, à la taille d'entrée) | 0,114 | 0,109 | 0,114 | 0,254 | 0,253 | 0,450 |
| `ext-s1` | 0,462 | 0,437 | 0,433 | 0,453 | 0,259 | 0,300 |
| `ext-s5` / `ext-s9` | 1,324 / 2,214 | 1,322 / 2,223 | 1,321 / 2,218 | 1,371 / 2,313 | 0,794 / 1,349 | 0,862 / 1,495 |
| `ext-l1` / `ext-l5` | 0,557 / 1,751 | 0,558 / 1,756 | 0,559 / 1,755 | 0,564 / 1,758 | 0,319 / 0,990 | 0,331 / 0,992 |
| `ext-s1-fw` | 0,539 | 0,537 | 0,537 | 0,543 | 0,307 | 0,322 |
| `tex-s1` / `tex-s2` | 0,383 / 0,482 | 0,369 / 0,466 | 0,367 / 0,465 | 0,389 / 0,488 | 0,226 / 0,279 | 0,242 / 0,294 |
| `tex-s5` / `tex-s9` | 1,126 / 1,982 | 1,105 / 1,963 | 1,105 / 1,956 | 1,146 / 2,014 | 0,658 / 1,158 | 0,669 / 1,174 |
| `tex-s1-fw` | 0,465 | 0,451 | 0,447 | 0,468 | 0,271 | 0,282 |
| `blit+tex-s1` / `+s5` / `+s9` | 0,503 / 1,241 / 2,098 | 0,487 / 1,234 / 2,089 | 0,476 / 1,217 / 2,064 | 0,662 / 1,412 / 2,292 | 0,493 / 0,920 / 1,424 | 0,707 / 1,126 / 1,636 |
| `sgsr-repo` / `sgsr-src` | 2,475 / 2,486 | 2,477 / 2,489 | 1,110 / 1,109 | 2,142 / 2,146 | 1,275 / 1,282 | 1,278 / 1,284 |
| `nis` | 10,53 | 10,60 | 8,82 | 10,43 | 5,89 | 6,15 |
| `easu` / `rcas` / `fsr1` | 7,26 / 2,10 / 9,36 | 7,26 / 2,10 / 9,36 | 7,26 / 2,10 / 9,36 | 7,28 / 2,09 / 9,37 | 4,11 / 1,18 / 5,29 | 4,11 / 1,18 / 5,31 |
| `blit+sgsr-repo` / `blit+fsr1` | 2,81 / 9,48 | 2,61 / 9,48 | 1,26 / 9,47 | 2,66 / 9,65 | 1,62 / 5,56 | 1,88 / 5,77 |
| `chain-off` / `chain-sgsr` / `chain-nis` / `chain-fsr1` (renderer du produit, GPU) | 0,50 / 2,82 / 10,9 / 9,49 | 0,48 / 2,63 / 10,8 / 9,49 | — | — | — | — |
| `chain-*`, temps mur de `draw()` | 4,25 / 5,88 / 14,1 / 13,3 | 3,69 / 6,11 / 14,7 / 13,2 | — | — | — | — |

**Au régime d'un flux (`tick`, ×2 texte)** : tout ralentit de 1,2 à 2,6 × (horloges au repos) :
`tex-s1` 0,99, `ext-s1` 1,07, `sgsr-repo` 3,19, `easu` 8,03, `fsr1` 10,0, `nis` 11,1 ; dispersion
1-12 %, p99 proches des médianes (pas le bruit du RTX) ; temps mur par soumission 3,4 ms pour une
passe courte, 13,7 ms pour NIS. C'est le facteur « 1,5 à 3 × en régime établi » que le §2.6 du plan
annonçait, mesuré : 2,6 × sur le plancher.

**Lecture.**

- **Le plancher.** Une passe 1440p qui ne fait qu'un bilinéaire coûte 0,38 ms (17 Mo d'écriture
  et de lecture : ≈ 45 Go/s, la part de DDR5 d'un iGPU) : tout se paie au-dessus. Une passe 1080p
  0,23 ms.
- **La passe 0 coûte selon l'entrée** (0,11 ms à 720p, 0,25 à 1080p, 0,45 à 1440p) ; **l'échantillon
  externe coûte selon la sortie et le nombre de taps** : +0,08 ms pour 1 tap à 1440p, +0,20 pour 5,
  +0,23 pour 9 (les deux plans NV12 lus par échantillon, §2.7). D'où le verdict par cas, chaîne
  entière (`ext-sN` contre `blit+tex-sN`) :

  | | 1 tap | 5 taps | 9 taps |
  |---|---|---|---|
  | ×2 (720p → 1440p) | **externe −8 %** | passe 0 +7 % | passe 0 +5 % |
  | ×1,33 (1080p → 1440p) | **externe −32 %** | externe −3 % | égal |
  | ×1 (1080p) | **externe −47 %** | externe −14 % | externe −5 % |
  | ×0,75 (1440p → 1080p) | **externe −58 %** | externe −23 % | externe −9 % |

  Le noyau du plan lit **un** tap sur le plat et cinq sur les contours : sur tout contenu où les
  contours sont une minorité de quads, et sur tous les cas où l'entrée est grande (fenêtre, 1:1,
  réduction, c'est-à-dire l'usage ordinateur courant du §1.6), la lecture directe gagne ; elle ne
  perd que sur du texte dense à ×2 et de 5 à 7 %. **`textureLoad` sur l'externe coûte plus que
  l'échantillon** (0,56 contre 0,46 à 1 tap, 1,75 contre 1,32 à 5) : la borne exacte 2×2 de
  `DERING_EXACT` se fera par échantillons, pas par chargements, sur ce feed.
- **Les dérivées ne sont pas gratuites ici** : `fwidth` de la luma ajoute 0,08 ms à 1440p, à
  peu près un deuxième échantillon (`tex-s2` − `tex-s1` = 0,10) et moins de la moitié d'un
  échantillon de la croix (0,19 par tap au-delà du premier). Le vote par dérivées reste moins
  cher qu'un gather (SGSR1 : un bilinéaire + un gather = 2,5 ms sur ce contenu, soit 6,5 × le
  plancher, là où « un bilinéaire + `fwidth` » = 0,47, soit 1,2 ×).
- **Les lignes de base sont lourdes sur cet iGPU** : à ×2 vers 1440p, SGSR1 2,5 ms (6,5 × le
  plancher ; 1,1 ms sur l'image d'interface, où sa sortie anticipée joue ; identique sur « jeu »,
  dont le grain déclenche le vote partout), RCAS 2,1, EASU 7,3, **FSR1 9,4 ms**, **NIS 10,5 ms** ;
  à 1:1 en 1080p, FSR1 5,3 et NIS 5,9 ms pour recopier l'image. Dans le renderer du produit,
  `draw()` d'une image FSR1 prend 13 ms de temps mur, NIS 14 ms : à 60 i/s, l'enhancer seul
  mange la moitié du budget sur un 780M. La chaîne d'un bilinéaire (`chain-off`) : 0,5 ms de GPU,
  4,2 ms de mur — la soumission, comme sur le RTX.
- Les constantes de Qualcomm (seuil 8/255) ne changent pas le temps de SGSR1 (2,486 contre
  2,475).
- **Réserve** : ces chiffres absolus sont lents pour un 780M (Qualcomm donne SGSR1 à 0,3-0,5 ms
  sur Adreno vers 1080p-1600p) ; cet iGPU ne pilote aucun écran sur DualRTX et sa fréquence sous
  Chrome n'est pas connue. Les rapports entre cellules, mesurés dans les mêmes conditions, sont
  la donnée de P0 ; l'UM790Pro (même GPU, écran) recoupera les absolus en P5.

## 5. Réponses de P0 et porte

| Question (§6.4) | Réponse | Démontré / attendu |
|---|---|---|
| Externe contre passe 0 + RGBA | **Pas de passe 0 en SDR** (décision n° 2 confirmée). RTX : égalité ; 780M : la lecture directe gagne dès que l'entrée dépasse 720p ou que le noyau lit un tap sur le plat, et perd 5-7 % seulement sur du texte dense à ×2 avec cinq taps partout. Le feed `texture_2d` reste dans la même source (HDR, labo, et le repli si un mobile dit l'inverse). | démontré sur deux GPU d'ordinateur ; mobile à mesurer (iPhone, realme) |
| Coût des dérivées | gratuit sur NVIDIA, ≈ un deuxième échantillon sur l'iGPU AMD (+0,08 ms à 1440p), toujours bien moins qu'un gather | démontré |
| Dispersion | ≤ 1,7 % (RTX) et ≤ 2,6 % (780M) tour à tour en `back` ; porte « < 5 % » tenue. Horodatages à la nanoseconde avec le drapeau développeur. En `tick`, bruit sur les cellules externes du RTX (p99 × 30) : les mesures de P2 se font en `back`, et le régime `tick` sert à vérifier la chaîne, pas le noyau | démontré |
| Lignes de base | RTX : SGSR1 0,07, FSR1 0,25, NIS 0,44 ms (chaîne 0,09 / 0,26 / 0,45) ; 780M : SGSR1 2,5, FSR1 9,4, NIS 10,5 ms (chaîne 2,8 / 9,5 / 10,9), plancher bilinéaire 0,028 et 0,38 ms | démontré |

**Ce que ces chiffres changent au plan.**

- Les critères C2 (« chaîne WebGPU ≤ 0,6 × FSR1 ») sont **larges** sur ordinateur : un noyau à
  1 + 4 taps coûte 0,47-1,3 ms sur le 780M contre 9,4 pour FSR1 et 2,5 pour SGSR1. La question
  de P2 n'est pas la vitesse sur ordinateur, c'est la **qualité à FSR1** (C3) et la vitesse sur
  les téléphones (C1).
- Sur le RTX, et à 60 i/s sur les deux GPU, le coût qui compte est la **soumission** (3,3-4,2 ms
  de temps mur pour 0,03-0,5 ms de GPU) : P1 (contournement 1:1) et la porte P4 (WebGPU contre
  WebGL2) portent sur ce coût-là, pas sur le shader. Rien ne change à leur contenu.
- Le vote par dérivées coûte un demi-échantillon sur AMD : la variante `EARLY_OUT` « cinq
  échantillons d'emblée, branche sur l'arithmétique » (§3.2) a une raison de plus d'être mesurée
  en P2.
- `DERING_EXACT` par `textureLoad` sur l'externe est écarté sur ce feed ; par échantillons
  seulement.

**Porte P0** : tenue pour l'ordinateur (dispersion < 5 %, coût de l'externe connu, décision passe
0 prise). Il manque les téléphones et le Mac, qui ne bloquent pas P1 ni P2.1 (labo sur DualRTX)
mais entrent avant la porte P2.

## 6. Ce qui reste de P0

- Les deux téléphones et le Mac (créneaux de Bruno) : la page se sert depuis DualRTX
  (`scaler_lab.py --serve 0.0.0.0:8766`, règle de pare-feu à ouvrir), l'URL imprimée s'ouvre dans
  Safari ou Chrome, le résultat revient en `bench-out/scaler-lab/phone-*.json`. `mw-arm` en WebGL2
  seulement (pas de WebGPU sur l'Adreno 618).
- La chaîne Python des métriques de qualité (FLIP, SSIM, dépassements) n'est pas encore écrite :
  P0 a mesuré le temps ; la qualité arrive avec le noyau (P2), sur les recadrages que le labo
  sait déjà relire (`shot=1`).
- Les mires 4:4:4, zone-plate et PQ (P3).
