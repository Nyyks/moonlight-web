# ICE-TCP passif — un chemin pour les réseaux qui ne laissent sortir aucun UDP

> Une école, un bureau ou un Wi-Fi d'invités qui bloque l'UDP sortant ne laisse aujourd'hui aucun
> chemin par le lien d'entrée : le tunnel et chaque rung WebRTC ont besoin d'ICE, et notre ICE-TCP
> ne peut former aucune paire avec un navigateur. Ce document décrit l'écoute TCP « passive » que
> l'hôte ajoute à libjuice pour combler ce trou, et sa sécurité, écrite avant le code.
> Go de Bruno le 23/10/2026 (« fais-le »), avec cette condition : « ne pas ouvrir une plus grande
> surface d'attaque ; si la sécurité est en régression, la proposer en booléen dans settings.json ».

## 1. Le constat, corrigé

**Le 22/10**, on a lu ceci : libjuice 1.7.1 ne fait que le TCP *actif* (il appelle, il n'écoute
jamais), et Chrome ne propose aucun candidat TCP. Actif contre rien, aucune paire. La première
moitié est juste. La seconde est **fausse** :

**Test 1 du 23/10, 09:26.** Le montage : Chrome 155, profil par défaut, sans fenêtre, à qui l'on a
donné à la main des candidats distants `tcp … typ host tcptype passive` vers deux écouteurs
(scripts : `scratchpad\ptcp\` de la session 271382d3).
- Chrome **appelle** : la connexion TCP part dans la seconde qui suit `addIceCandidate`, vers un
  autre hôte (WSL) comme vers 127.0.0.1.
- Suivent des STUN Binding Request en cadrage RFC 4571 (2 octets de longueur, puis 100 octets),
  USERNAME `distant:local`, environ 8 par seconde.
- Chrome a bien des candidats locaux `tcp/host/active :9`, visibles dans `getStats`, mais il ne les
  signale **jamais** dans `onicecandidate`. C'est ce qui faisait croire qu'il « n'a pas de TCP ».
- libwebrtc (`VerifyCandidate`) refuse un candidat distant sous 1024, sauf 80 et 443, et refuse 80
  et 443 sur une adresse privée. Un port haut passe partout.

Donc il suffit que l'hôte **annonce un candidat passif et écoute derrière**. Le navigateur n'a rien
à changer.

## 2. Ce qui change

**Patch libjuice** `third_party/patches/libjuice-ice-tcp-passive.patch` (mode `poll` seulement,
celui de libdatachannel ; `mux` et `thread` l'ignorent) :
- un mode `JUICE_ICE_TCP_MODE_ACTIVE_PASSIVE` : le TCP actif d'avant, plus une écoute ;
- à la création de l'agent, un socket TCP en écoute sur **la même adresse et le même port** que son
  socket UDP ; s'il ne peut pas s'y lier, pas de candidat passif, et rien d'autre ne change ;
- un candidat hôte `tcptype passive` par famille d'adresses, sur ce port ;
- une connexion acceptée n'est rattachée à l'agent qu'après la porte du §3.2. Elle devient alors
  son unique connexion TCP. Le candidat distant prflx qu'elle crée est TCP (`tcptype active`), et
  la paire qu'il forme est permise en mode passif ;
- `TCP_NODELAY` sur la connexion rattachée : le flux y passe, image par image.

**Patch libdatachannel** `third_party/patches/libdatachannel-ice-tcp-passive.patch` :
`rtc::Configuration::enableIceTcpPassive` (faux par défaut), lu seulement avec `enableIceTcp`.

**Serveur** :
- le réglage `ice_tcp_passive` (§3.6), transmis au worker comme `packet_marking` ;
- il vaut pour les rungs `-tcp` du flux (`SignalingServer::buildIceConfig`) et pour le tunnel
  (`ControlTunnel`), puisque c'est le tunnel qui échoue d'abord quand l'UDP est bloqué ;
- le candidat passif est réécrit vers l'IP publique et le port externe, comme le candidat UDP. Le
  trou TCP existe déjà : `RouterPortCore` mappe le port en TCP aussi, au même numéro que l'UDP.
  Pour le tunnel, qui ne réécrit que l'UDP, on ajoute un seul candidat TCP passif public.

## 3. Sécurité

### 3.1 Comparé à l'état actuel

| | Aujourd'hui | Avec l'écoute passive |
|---|---|---|
| Port TCP de la session (média ou tunnel) | mappé par UPnP sur le routeur, **personne derrière** : le SYN est refusé, ou jeté par le pare-feu de l'hôte | une écoute derrière, pendant la vérification ICE de cette session seulement |
| Code exposé avant authentification | sur le port UDP : `stun_read` + HMAC (MESSAGE-INTEGRITY) pour tout paquet | sur le port TCP : `accept`, la lecture d'**une** trame RFC 4571 de 1 Kio au plus, puis **le même** `stun_read` + HMAC. Aucun nouveau parseur |
| Ressources qu'un inconnu peut tenir | aucune côté TCP | au plus 4 connexions en attente par agent, 2 s chacune |
| Après authentification | DTLS (empreinte liée par MW-BIND-v1), puis SCTP/SRTP | identique : la connexion TCP n'est qu'un autre tuyau pour les mêmes octets |

### 3.2 La porte, avant toute allocation

Une connexion acceptée n'a rien d'autre qu'une entrée dans une petite table d'attente (socket,
adresse, échéance, tampon de 1 Kio fixe, dans la structure de l'agent : pas de `malloc` par
connexion). Rien d'autre ne lui est alloué : pas de candidat, pas de paire, pas d'entrée STUN.
Elle est **fermée** dès que l'une de ces conditions tombe :
- la longueur annoncée de la première trame est < 20 octets (un en-tête STUN) ou > 1024 ;
- la trame n'est pas un message STUN (`is_stun_datagram`), ou `stun_read` la refuse ;
- ce n'est pas un **Binding Request** avec MESSAGE-INTEGRITY ;
- `agent_verify_stun_binding` la refuse : le USERNAME doit commencer par notre ufrag local, et le
  HMAC doit être bon avec notre mot de passe ICE local (22 caractères base64, soit 132 bits
  aléatoires par agent, qui ne
  voyagent que dans la description signalée au navigateur, donc dans le tunnel ou le canal de
  signalisation authentifié) ;
- l'agent n'est pas en vérification (`CONNECTING` ou `CONNECTED`).

Ce n'est qu'une fois la porte passée que la trame entre dans `agent_input`, exactement comme un
paquet UDP. Elle y crée alors le candidat prflx et la paire, et l'agent répond.

### 3.3 Bornes

- **Première trame en 2 s** après l'`accept`, sinon fermeture (slowloris). Un navigateur l'envoie
  dans le même aller-retour que la poignée de main.
- **4 connexions en attente** au plus par agent. Au-delà, la nouvelle est acceptée puis fermée
  aussitôt, pour vider la file du noyau : elle ne prend pas la place d'une autre.
- Trames suivantes, une fois rattachée : le cadrage de libjuice tel qu'il est pour le TCP actif,
  soit 2 048 octets gardés au plus par trame et le reste jeté.
- **Une seule connexion rattachée par agent.** La première authentifiée gagne. Dès qu'elle l'est,
  l'écoute et toutes les connexions en attente sont fermées.

### 3.4 Durée de vie

L'écoute naît avec l'agent (début de la collecte des candidats) et se ferme au premier de ces
événements :
- une connexion TCP est rattachée ;
- ICE aboutit (`COMPLETED`), quel que soit le chemin : si l'UDP passe, l'écoute disparaît en
  quelques centaines de millisecondes ;
- ICE échoue (`FAILED`, au plus tard au bout des 39,5 s de `ICE_PAC_TIMEOUT`) ;
- l'agent est détruit (fin de session ou rung suivant).

Hors d'une session en cours de vérification, **aucun port TCP n'écoute**. C'est plus strict que
le trou UPnP, qui reste mappé pendant toute la vie du slot.

### 3.5 Après la porte

Une fois la connexion rattachée, le reste suit exactement les mêmes contrôles que l'UDP :
- le contrôle de consentement (RFC 7675) ;
- DTLS, dont l'empreinte est vérifiée contre celle que MW-BIND-v1 a liée ;
- l'authentification de session : PIN ou invitation.

Un tiers qui ne connaît pas le mot de passe ICE ne passe pas la porte, et un tiers qui le connaît
tient déjà le canal de signalisation.

### 3.6 Le reste, et le booléen

**Il reste une augmentation de la surface d'attaque, petite mais réelle.** Pendant la vérification
ICE, une écoute TCP joignable depuis Internet par le trou déjà mappé. Avant authentification, elle
expose une lecture de 1 Kio et un parseur STUN déjà exposé en UDP. On ajoute aussi un déni possible
du seul repli TCP : il suffit d'occuper les 4 places d'attente, ce qui demande de connaître le port
de la session et de soutenir 2 connexions par seconde.

La règle de Bruno s'applique donc : **`ice_tcp_passive`** dans `settings.json`, **désactivé par
défaut**, sans interface (son accord avant toute UI). Le passer à vrai par défaut se décidera après
la mesure de l'étape 2 (§5).

### 3.7 Défauts du chemin TCP de libjuice, corrigés dans le même patch

Notre ICE-TCP ne se connectait jamais à un navigateur, donc le chemin TCP de libjuice n'avait
jamais servi chez nous. Une fois rendu vivant, ASan et UBSan l'ont pris en défaut sous Linux (WSL,
23/10). Ces défauts sont corrigés dans le même patch :
- **Le fil de poll vidait une trame en attente sans le verrou d'envoi**, pendant qu'un fil
  applicatif (`juice_send`) écrivait le même contexte. Les octets s'entrelaçaient sur le fil, ce
  qui casse définitivement le cadrage RFC 4571 : une lecture hors limites sous ASan, et une
  donnée perdue une fois sur trente.
- La fermeture de la connexion se faisait aussi sans ce verrou.
- **Une trame à moitié écrite (tampon du noyau plein)** était signalée comme une erreur, avec
  l'errno de `send()` (-1) pris pour un code. Le poll n'était pas réveillé pour attendre POLLOUT :
  la fin de la trame attendait le prochain réveil.
- **Une connexion ouverte pendant le tour de poll** (TCP actif) faisait lire une case au-delà du
  tableau de `poll()`. Le traitement suit maintenant ce que la préparation a mis dans le tableau.

Reste, en amont et hors du patch :
- le parseur STUN lit des `uint32_t` non alignés (UBSan), sans effet sur x86-64 et ARM64 ;
- un échec d'intégrité STUN logue le mot de passe ICE local en WARN. Chez nous, ces lignes ne
  sortent qu'en mode verbeux (`RunFlags::applyVerboseLogging`).

## 4. Ports et pare-feu

- **Windows** : la règle de l'installeur porte sur le programme, tous protocoles : le TCP entrant
  passe sans autre règle. Une `--dev` est couverte par `scripts/dev-firewall-allow.ps1`, qui ouvre
  48550-48573 en TCP et en UDP.
- **Linux** : les paquets n'ouvrent que `48550:48573/udp` dans ufw et firewalld. Il faudra
  `48550:48573/tcp`, plus le pool du tunnel, pour qu'un hôte Linux au pare-feu actif accepte
  l'appel. C'est une modification d'empaquetage, à faire avec le passage du défaut à vrai.
- **macOS** : le pare-feu applicatif porte sur le programme.
- **Le port 443** : le seul que certaines écoles laissent sortir. Sur un même hôte, il sert déjà le
  HTTPS. Le partager imposerait de trier les connexions dans le listener (ClientHello TLS `0x16`
  contre une longueur RFC 4571 suivie d'un en-tête STUN). Ce sera en dernier, et seulement si les
  ports hauts sont bloqués là où ça compte.

## 5. Tests et étapes

1. ✅ **Test 1** (23/10, 09:26) : Chrome appelle un candidat passif (§1).
2. ✅ **Patch et tests unitaires** (23/10) : `backend/tests/test_ice_tcp_passive.c`, cible
   `run_juice_tests`, lancée par `run_coverage.bat` après `run_tests`. Deux agents libjuice dans
   le même processus, sur 127.0.0.1 seulement (aucune alerte du pare-feu).
   - Le premier écoute (`ACTIVE_PASSIVE`). Le second ne reçoit que ses candidats TCP passifs, et
     appelle en TCP actif.
   - On attend qu'ils se connectent et échangent des données sans aucun UDP.
   - Tests de la porte : sans trame, la connexion est fermée en 2 s ; une longueur hors bornes, un
     message qui n'est pas du STUN, un mauvais ufrag ou un mauvais HMAC la ferment ; la 5ᵉ
     connexion en attente aussi ; après `COMPLETED`, l'écoute refuse.
   - Passés sous Windows (MSVC, 10 sur 10) et sous Linux (gcc `-Wall -Wextra`, ASan, UBSan,
     ThreadSanitizer, en série).
3. **Banc** : une `--dev`, sur un créneau de 59, un Chrome dont l'UDP sortant est bloqué par le
   pare-feu de sa machine (et non par une stratégie Chrome, qui retire tous les candidats). On
   attend le tunnel puis le flux en TCP passif, à la place de `noRouteError`.
4. **Mesure** depuis un réseau qui ne laisse sortir que TCP 443/80. Le partage du 443 vient
   ensuite, et seulement si cette mesure l'exige.
