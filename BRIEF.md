# torrent-finder — brief de projet

> Document de passation pour une nouvelle session Claude Code. Il contient tout le contexte nécessaire pour construire le projet de A à Z dans ce dossier (`~/Documents/Project/torrent-finder`).
> **Avant de coder, pose à l'utilisateur les questions de la section 12** (il veut valider les choix ouverts d'abord), puis enchaîne.

---

## 1. Contexte

- Utilisateur : macOS (Apple Silicon), shell zsh, langue **français** pour échanger. L'interface de l'app est **en anglais**.
- Compte GitHub : `Nexgear75` (gh CLI déjà authentifié).
- Il avait une app « Game Downloader » dont le code est perdu. L'idée est de la refaire en mieux : **un moteur de recherche de torrents dans le terminal**, qui agrège les plus gros sites (The Pirate Bay, 1337x, YTS, EZTV, Nyaa, etc.).
- Le résultat est envoyé à **`dl`**, son gestionnaire de téléchargement terminal déjà construit (voir §4), qui s'occupe du téléchargement.
- L'outil est neutre, comme Jackett/Prowlarr eux-mêmes. Ce qu'on télécharge relève de la responsabilité de l'utilisateur. Pas de discours à ce sujet dans l'app.

## 2. Objectif produit

Une TUI plein écran, rapide et pratique, navigable au clavier façon vim :

1. On tape une recherche et on voit les résultats de **tous les indexeurs** dans un seul tableau trié (seeders, taille, date, source).
2. On filtre par catégorie (jeux, films, séries, musique, logiciels, livres, anime…) et on trie.
3. Sur un résultat : `⏎` l'envoie à `dl`, qui commence à télécharger en arrière-plan.
4. On peut continuer à chercher et à envoyer d'autres résultats sans quitter.

**Contrainte clé, demandée explicitement : la machinerie doit être invisible.** L'utilisateur tape `tf` (nom à confirmer, §12) et ça marche. Il ne doit jamais :
- ouvrir l'interface web de Jackett ou Prowlarr ;
- copier une clé API ;
- configurer un indexeur à la main ;
- lancer ou arrêter un serveur lui-même.

## 3. Décisions déjà prises

| Sujet | Décision |
|---|---|
| Stack | **TUI Ink (React) compilée avec Bun + backend Rust**, la même que `dl`. |
| Sources | **Uniquement via Jackett et/ou Prowlarr** (API Torznab). Pas de scrapers maison. |
| Gratuité | Jackett et Prowlarr sont gratuits et open source. On n'utilise que des indexeurs publics. |
| Cycle de vie | **Tout est invisible** : le backend installe si besoin, configure, démarre et arrête Jackett/Prowlarr lui-même. |
| Envoi des téléchargements | Via le **socket Unix de `dl-daemon`**. Si le daemon ne tourne pas, on le **réveille** (même mécanisme que `dl`). Le téléchargement démarre tout de suite en arrière-plan, et ouvrir `dl` montre la progression. Pas de file d'attente sur disque, sauf en secours (§7.4). |
| Installation | Binaires dans `~/.local/bin` (déjà dans le PATH), via `scripts/install.sh`. |
| Dépôt | Git + dépôt GitHub **privé** sur `Nexgear75`, créé avec `gh`. |

## 4. Le projet existant `dl` (à connaître absolument)

- Code source : `~/Documents/Project/aria2-wrapper` (dépôt `github.com/Nexgear75/dl`, privé). **Lis son README et `daemon/src/server.rs` + `daemon/src/core.rs`** pour réutiliser les patterns.
- Binaires installés : `~/.local/bin/dl` (TUI) et `~/.local/bin/dl-daemon` (Rust).
- `dl-daemon` pilote `aria2c` (JSON-RPC) et `yt-dlp`. Il est **persistant** : quitter `dl` avec `q` laisse les téléchargements tourner, `Q` ou `dl --stop` l'arrête.
- Données : `~/.local/share/dl/` (`dl.sock`, `daemon.log`, `aria2.session`, `state.json`). Configuration : `~/.config/dl/config.toml` (`download_dir = "~/Downloads"`, etc.).

### 4.1 Protocole du socket `dl-daemon` (JSON lines)

Socket : `$DL_SOCKET` sinon `~/.local/share/dl/dl.sock`. Une requête par ligne :

```json
{"id": 1, "method": "add", "params": {"input": "magnet:?xt=urn:btih:…", "dir": "~/Downloads/Games"}}
```

Réponse : `{"id":1,"ok":true,"result":{"ids":["a:<gid>"],"errors":[]}}` ou `{"id":1,"ok":false,"error":"…"}`.
Le daemon pousse aussi `{"event":"state","data":{"downloads":[…],"global":{…}}}` toutes les 500 ms à chaque client connecté. Il faut ignorer ces lignes, ou s'en servir pour afficher l'état.

Méthodes utiles :

| Méthode | Params | Notes |
|---|---|---|
| `ping` | — | renvoie `"pong"` |
| `config` | — | `{download_dir, max_concurrent}` |
| `detect` | `{input}` | `{kind: http\|magnet\|torrent\|metalink\|video\|batch\|multi}` |
| `add` | `{input, dir?, video?}` | `input` peut être un magnet, une URL `.torrent`, un chemin local, ou **plusieurs liens séparés par des espaces** |
| `select` | `{id, indices: [u32]}` | choix des fichiers d'un torrent en statut `selecting` (indices aria2, à partir de 1) |
| `pause` / `resume` / `remove` | `{id}` (`remove` : `delete?`) | |
| `shutdown` | — | |

**Comportement important pour les torrents multi-fichiers.** Un magnet ajouté seul (pas en lot) est mis en pause après réception des métadonnées, avec le statut `selecting`. Il attend que l'utilisateur choisisse ses fichiers dans `dl`, où un sélecteur s'ouvre automatiquement. Un lot (plusieurs liens dans `input`) télécharge tout sans demander.
→ Pour torrent-finder, il faut décider (§12) entre trois possibilités :
- (a) laisser le choix se faire dans `dl` ;
- (b) faire le choix directement dans torrent-finder, en écoutant les events `state` jusqu'au statut `selecting` puis en appelant `select` ;
- (c) ajouter dans `dl-daemon` un paramètre `select: false` à `add` pour tout télécharger. C'est une petite modification de `core.rs::add` / `add_one`, qui a déjà le booléen `select`.

### 4.2 Réveiller le daemon

Même logique que `tui/src/lib/client.ts` dans `dl` :
1. Tenter de se connecter au socket.
2. En cas d'échec, `spawn("dl-daemon", [], {detached: true, stdio: "ignore"}).unref()`, puis réessayer toutes les 100 ms pendant 6 s.

Résolution du binaire : `$DL_DAEMON`, puis le dossier du binaire courant, puis le PATH.

### 4.3 Option : intégration inverse

Un raccourci dans `dl` (par ex. `s` ou `/`) qui lance `tf` pourrait être ajouté plus tard. C'est une question ouverte (§12).

## 5. Jackett et Prowlarr : ce qu'il faut savoir

État vérifié le 2026-11-03 sur la machine : **aucun des deux n'est installé**.
- `brew info jackett` → formule `jackett` 0.24.3003 (bottled).
- `brew info --cask prowlarr` → cask `prowlarr` 2.5.2.5491.

| | Jackett | Prowlarr |
|---|---|---|
| Install | `brew install jackett` (formule, binaire CLI) | `brew install --cask prowlarr` (app .app) |
| Recherche agrégée | **Oui, endpoint unique** `GET /api/v2.0/indexers/all/results?apikey=…&Query=…&Category[]=…` (JSON) ou Torznab `/api/v2.0/indexers/all/results/torznab/api?t=search&q=…` (XML) | `GET /api/v1/search?query=…&type=search&categories=…&indexerIds=…` avec header `X-Api-Key` (JSON) |
| Clé API | dans `ServerConfig.json` (champ `APIKey`) du dossier de données | dans `config.xml` (`<ApiKey>`) du dossier de données |
| Ajout d'indexeur par API | `POST /api/v2.0/indexers/{id}/config` (corps = config renvoyée par `GET` sur le même endpoint) | `GET /api/v1/indexer/schema` puis `POST /api/v1/indexer` |
| Indexeurs publics | Très nombreux, dont 1337x, thepiratebay, yts, eztv, nyaasi, torrentgalaxy… | Similaire |
| Dossier de données | configurable : `--DataFolder <dir>` | configurable : `-data=<dir>` |
| Port | `--Port <n>` (défaut 9117) | `config.xml` `<Port>` (défaut 9696) |

**Cloudflare.** Certains indexeurs (notamment **1337x**) exigent **FlareSolverr** : un autre service, basé sur un Chromium headless, que Jackett/Prowlarr appellent via son URL. Sans lui, 1337x échoue souvent. FlareSolverr se lance par Docker ou par binaire, et la gestion invisible doit le couvrir s'il est retenu (§12).

**Recommandation par défaut : Jackett comme moteur principal.**
- Endpoint agrégé `all` → une seule requête pour tous les indexeurs.
- Installation en CLI (formule), plus simple à démarrer et à arrêter en sous-processus qu'une app `.app`.
- Paramètres de lancement `--DataFolder`/`--Port` → on l'isole complètement dans nos propres dossiers.

Prowlarr est supporté derrière le même trait Rust (`Backend`) si l'utilisateur le préfère, ou en secours.

> ⚠️ **À vérifier en début de session avant de coder** (versions récentes) :
> - les flags exacts de lancement de Jackett (`jackett --help`) ;
> - le format de `ServerConfig.json` ;
> - les endpoints de config d'indexeur ;
> - le format JSON des résultats (`Results[]` : `Title`, `Tracker`, `CategoryDesc`, `Size`, `Seeders`, `Peers`, `PublishDate`, `MagnetUri`, `Link`, `Details`, `InfoHash`…).
>
> Utilise Context7 (règle utilisateur : docs via Context7) puis la doc GitHub du projet. Fais un spike réel : installer, lancer, interroger avec `curl`.

## 6. Fonctionnement invisible (spécification)

Le backend Rust (`tf-daemon` ou intégré à `tf`, voir §7) gère tout :

1. **Détection et installation.** Si `jackett` est absent du PATH et de Homebrew, demander **une seule fois** dans la TUI : « Install Jackett (free, via Homebrew)? [Y/n] ». Puis lancer `brew install jackett` en affichant la progression dans la TUI.
2. **Données isolées** dans `~/.local/share/torrent-finder/jackett/`, et non dans les dossiers globaux de Jackett. On ne casse donc pas une éventuelle installation existante de l'utilisateur.
3. **Démarrage** en sous-processus caché :
   - port libre choisi aléatoirement sur `127.0.0.1` ;
   - process group séparé et `kill_on_drop(true)` ;
   - stdout/stderr redirigés vers `~/.local/share/torrent-finder/jackett.log` ;
   - attente de disponibilité (poll HTTP) avec un spinner « Starting search engine… ».
4. **Lecture de la clé API** dans `ServerConfig.json` après le premier démarrage.
5. **Premier lancement** : configuration automatique d'une **liste d'indexeurs publics par défaut** (§12), sans aucune action de l'utilisateur. Ensuite, un écran **Indexers** dans la TUI permet d'activer ou de désactiver les sources, sans jamais ouvrir le web UI.
6. **Arrêt** : quand l'utilisateur quitte `tf`, Jackett (et FlareSolverr s'il est retenu) sont arrêtés proprement : SIGTERM, puis SIGKILL après 3 s. **Rien ne reste en mémoire.** Le daemon `dl` n'est pas concerné : il garde son propre cycle de vie.
7. **Erreurs indexeurs** : un indexeur en échec ne bloque pas les autres. On affiche un compteur discret, par exemple « 7/9 sources », avec le détail dans un panneau.

Pour réduire la latence au démarrage, à évaluer après mesure :
- lancer Jackett **dès l'ouverture**, pendant que l'utilisateur tape sa première recherche ;
- ou garder Jackett vivant quelques minutes après fermeture via un petit daemon. **Par défaut : tout s'arrête à la fermeture**, c'est la demande de l'utilisateur.

## 7. Architecture proposée

```
tf (Ink TUI, compilée bun) ──stdio JSON lines──▶ tf-backend (Rust/tokio)
                                                   ├─ gère le sous-processus Jackett (install, start, config, stop)
                                                   ├─ recherche (HTTP Jackett), normalisation, dédoublonnage, tri
                                                   └─ envoi vers dl-daemon (socket Unix ~/.local/share/dl/dl.sock)
```

### 7.1 Pourquoi un backend en processus enfant (stdio) et pas un daemon

Comme tout doit se fermer avec l'app, la TUI lance le backend Rust en enfant et lui parle en JSON lines sur stdin/stdout. À la fermeture de la TUI, le backend reçoit EOF et arrête Jackett. Pas de socket ni de daemon à gérer.

C'est différent de `dl`, et c'est voulu.

Le binaire Rust (`tf-backend`) est installé à côté de `tf`. La TUI le trouve dans `dirname(process.execPath)`, puis via `../backend/target/{release,debug}` en dev.

### 7.2 Protocole TUI ↔ backend (proposition)

- Requêtes : `{"id", "method", "params"}`. Réponses : `{"id", "ok", "result"|"error"}`.
- Events : `{"event": "status"|"results"|"progress", "data": …}`.

| Méthode | Rôle |
|---|---|
| `status` | état du moteur (`installing`, `starting`, `ready`, `error`) + nombre d'indexeurs |
| `search {query, categories?, sort?}` | lance une recherche. Si possible, les résultats arrivent **en flux par indexeur** (`results` events) pour un affichage progressif. Sinon, on garde l'appel `all` unique. |
| `cancel {searchId}` | annule une recherche en cours (nouvelle frappe) |
| `indexers` / `set_indexer {id, enabled}` | gestion des sources |
| `send {magnet\|link, dir?, select?}` | envoi vers dl-daemon (réveil inclus) |
| `install_engine` | installation brew avec progression |

### 7.3 Normalisation d'un résultat

```ts
interface Result {
  id: string;           // infohash si dispo, sinon hash(link)
  title: string;
  indexer: string;      // "1337x", "The Pirate Bay"…
  category: string;     // "PC/Games", "Movies/HD"…
  size: number;         // octets
  seeders: number;
  leechers: number;
  date: string | null;  // ISO
  magnet: string | null;
  link: string | null;  // URL .torrent (via proxy Jackett) si pas de magnet
  details: string | null; // page web du torrent
}
```

**Dédoublonnage** par infohash entre indexeurs : garder l'entrée avec le plus de seeders et lister les sources fusionnées. Le lien `.torrent` proxifié par Jackett marche aussi avec `dl` (`add` accepte une URL `.torrent`), mais seulement tant que Jackett tourne. Préférer le magnet quand il est disponible. Sinon, télécharger le `.torrent` dans un fichier temporaire et l'envoyer à `dl` par son chemin local.

### 7.4 Secours si dl-daemon est injoignable

Si le réveil échoue (binaire absent…), écrire le lien dans `~/.local/share/dl/inbox.txt` et l'indiquer clairement. Ce n'est utile que si on ajoute dans `dl-daemon` la lecture de cet inbox au démarrage. C'est optionnel, à discuter.

## 8. UX de la TUI

Même langage visuel que `dl` : badge d'en-tête inversé, couleurs cyan/gris, séparateurs `─`, picker arrondi, barre de saisie en bas façon vim.

```
 tf  ⌕ elden ring                                  9/9 sources · 142 results · 0.8s
──────────────────────────────────────────────────────────────────────────────────────
  ALL  GAMES  MOVIES  TV  MUSIC  APPS  BOOKS  ANIME            sort: seeders ↓
──────────────────────────────────────────────────────────────────────────────────────
▌ ELDEN RING Shadow of the Erdtree – v1.12 [FitGirl Repack]     PC/Games   54.2 GB
▌   ▲ 1 204  ▼ 312   1337x · TPB          2025-06-21                        → dl ⏎
  ELDEN.RING-RUNE                                               PC/Games   49.8 GB
    ▲ 640    ▼ 98    The Pirate Bay       2022-02-25
  …
──────────────────────────────────────────────────────────────────────────────────────
 SEARCH › elden ring
⏎ search · tab category · esc results
```

Raccourcis :

| Normal | |
|---|---|
| `/` `i` | nouvelle recherche (barre en bas, historique avec ↑↓) |
| `j` `k` `gg` `G` `ctrl-d` `ctrl-u` | navigation |
| `⏎` | envoyer à dl (dossier par défaut) |
| `D` | envoyer à dl en choisissant le dossier (autocomplétion de chemin comme dans dl) |
| `space` | marquer plusieurs résultats, puis `⏎` envoie le lot |
| `tab` / `1`…`8` | catégorie |
| `s` | cycle de tri : seeders → taille → date → nom |
| `f` | filtres : seeders min, taille min/max, sources |
| `o` | ouvrir la page du torrent dans le navigateur |
| `y` | copier le magnet |
| `I` | écran Indexers (activer/désactiver) |
| `?` | aide |
| `q` | quitter (arrête Jackett) |

Détails utiles :
- **recherche « as you type »** optionnelle, avec un debounce de 400 ms et l'annulation de la requête précédente, ou recherche à `⏎` seulement (§12) ;
- **historique** des recherches dans `~/.local/share/torrent-finder/history.json` ;
- coloration des seeders (vert ≥ 50, jaune ≥ 5, rouge < 5) ;
- résultats tronqués proprement (largeur réelle via `string-width`).

Mapping des catégories Torznab :

| Onglet | Codes Torznab |
|---|---|
| GAMES | 1000 (Console) + 4050 (PC/Games) |
| MOVIES | 2000 |
| TV | 5000 |
| MUSIC | 3000 |
| APPS | 4000 sauf 4050 |
| BOOKS | 7000 |
| ANIME | 5070 + indexeur nyaa |

## 9. Leçons apprises sur `dl` (à appliquer directement)

1. **Ink 8** a nativement `alternateScreen: true`, `useWindowSize()`, `usePaste()`. Utiliser `exitOnCtrlC: false` et gérer Ctrl-C soi-même. **Ne pas activer `incrementalRendering`.**
2. **Rafales de touches** : Ink livre parfois plusieurs touches dans une seule chaîne (`"j\r"`, `"dd"`, `"\r\x15/tmp"`). Copier `tui/src/lib/keys.ts::splitBurst` de `dl`. Utiliser une file d'événements traitée un par un (`setTimeout(step, 0)`) et un **`modeRef` mis à jour de façon synchrone**. Ne jamais insérer de caractères de contrôle dans un champ texte.
3. **Dialogues en promesses** : `ask()`, `pick()`, `confirm()` renvoient des promesses résolues par le handler clavier, ce qui donne des flux linéaires faciles à écrire (voir `App.tsx` de dl).
4. **Hauteurs** : chaque bloc doit tenir dans les lignes disponibles. Un contenu trop haut dans une `Box` à hauteur fixe se **chevauche** (Yoga compresse). Mettre `flexShrink={0}` sur les lignes et calculer les hauteurs à la main (voir `rowHeight`, `pickerHeight`).
5. **Compilation Bun** : `bun build --compile` échoue sur `react-devtools-core`, qu'Ink importe statiquement. Solution : le stub local `tui/stubs/react-devtools-core` de dl, ajouté en dépendance `file:`.
6. **Socket Unix** : chemin limité à environ 104 caractères. Le scratchpad de Claude est trop long, d'où les variables `DL_SOCKET` et `DL_DATA_DIR`.
7. **Processus enfants Rust** : `kill_on_drop(true)` + `process_group(0)`. Ne pas compter sur `--stop-with-process` d'aria2, qui est lent sur macOS.
8. **Tests TUI réels** dans tmux : `tmux new-session -d -s t -x 110 -y 30 "…"`, `tmux send-keys`, `tmux capture-pane -p`. Ne jamais tester avec le vrai dossier `~/Downloads` : toujours passer un `dir` de test. Les touches envoyées par tmux arrivent en rafales, ce qui est un bon test du point 2.
9. `rm` et `sed -i` : `~/.zshrc` est un **lien symbolique** vers `~/dotfiles/zsh/.zshrc`. Pour toute modif de dotfiles, éditer la cible.
10. L'utilisateur avait une ancienne **fonction zsh `dl`** (supprimée). Vérifier qu'aucune fonction ou alias ne masque le nom choisi : `type <nom>` dans `zsh -i -c`.
11. Les tests unitaires Bun ne doivent pas importer `App.tsx` : l'import d'Ink bloque `bun test`. Mettre la logique pure dans `src/lib/`.

## 10. Arborescence cible

```
torrent-finder/
├── BRIEF.md                 (ce fichier)
├── README.md
├── backend/                 (crate Rust : tf-backend)
│   └── src/{main.rs, protocol.rs, engine/{mod.rs, jackett.rs, prowlarr.rs}, search.rs, dl.rs, indexers.rs}
├── tui/                     (Ink + Bun : tf)
│   ├── src/{index.tsx, App.tsx, components/, lib/{backend.ts, keys.ts, format.ts, complete.ts, types.ts}}
│   └── stubs/react-devtools-core/
├── scripts/install.sh       (build + install dans ~/.local/bin)
└── .gitignore
```

## 11. Étapes de réalisation

1. **Questions §12** à l'utilisateur (AskUserQuestion, au plus 4 par appel, en plusieurs tours si besoin).
2. **Spike Jackett** :
   - `brew install jackett` (si l'utilisateur est d'accord) ;
   - lancement avec `--DataFolder` et `--Port` dans le scratchpad ;
   - lecture de l'API key ;
   - ajout d'un indexeur public par API ;
   - recherche `curl` sur `/indexers/all/results` ;
   - noter les formats exacts. Idem FlareSolverr si retenu.
3. Backend Rust : moteur Jackett (cycle de vie complet), recherche + normalisation + dédoublonnage, envoi à dl-daemon, tests unitaires (parsing, dédoublonnage, mapping catégories).
4. TUI Ink : recherche, tableau, catégories, tri, filtres, envoi, multi-sélection, écran indexers, aide.
5. Tests réels dans tmux de bout en bout. L'envoi vers dl doit pointer vers un dossier de test.
6. `scripts/install.sh`, README, `git init`, commit (avec la ligne `Co-Authored-By` fournie par l'environnement), `gh repo create Nexgear75/<nom> --private --source . --push`.
7. Vérifier que la commande finale marche dans un **nouveau** shell zsh.

## 12. Questions encore ouvertes (à poser avant de coder)

1. **Nom de la commande** : `tf`, `tfind`, `seek`, `gd` (clin d'œil à Game Downloader)… Vérifier qu'il n'entre pas en conflit avec une commande existante.
2. **Moteur** : Jackett seul (recommandé), Prowlarr seul, ou les deux avec choix automatique ?
3. **FlareSolverr pour 1337x** et les autres sites protégés par Cloudflare : l'installer et le gérer de façon invisible (plus lourd, via Chromium), ou se passer de ces sites ?
4. **Indexeurs activés par défaut** : proposer une liste à cocher (1337x, The Pirate Bay, YTS, EZTV, Nyaa, TorrentGalaxy, LimeTorrents, Kickass, RuTracker public…).
5. **Torrent multi-fichiers envoyé à dl** : choix des fichiers dans dl (a), dans torrent-finder (b), ou tout télécharger (c) ? (voir §4.1)
6. **Dossier de destination** : celui de dl par défaut, un dossier par catégorie (`~/Downloads/Games`…), ou demander à chaque fois ?
7. **Recherche** : en direct pendant la frappe, ou seulement à `⏎` ?
8. **Catégorie par défaut** au lancement : ALL ou GAMES ?
9. **Intégration inverse** : ajouter dans `dl` un raccourci qui ouvre torrent-finder ?
10. **Démarrage** : accepter quelques secondes de « Starting search engine… » à chaque lancement, ou garder Jackett en vie quelques minutes après la fermeture pour accélérer les relances ?

## 13. Décisions validées (2026-11-03)

| # | Question | Décision |
|---|---|---|
| 1 | Nom | **`tf`** (libre ; backend `tf-backend`) |
| 2 | Moteur | **Jackett seul** |
| 3 | FlareSolverr | **Non pour l'instant** (1337x activé mais peut échouer → compté dans « x/y sources ») |
| 4 | Indexeurs par défaut | TPB, YTS, EZTV, Nyaa, TorrentGalaxy, LimeTorrents, 1337x, Kickass, RuTracker (public) |
| 5 | Multi-fichiers | **(c) tout télécharger** : ajout de `select: false` à `add` dans dl-daemon |
| 6 | Dossier | **Celui de dl** (`download_dir`), `D` pour choisir |
| 7 | Recherche | **À ⏎ seulement** |
| 8 | Catégorie initiale | **ALL** |
| 9 | Intégration inverse | **Plus tard** |
| 10 | Démarrage | **Tout s'arrête à la fermeture** ; Jackett démarre dès l'ouverture |
| — | Install Jackett | Faite par l'utilisateur lui-même |

## 14. Résultats du spike Jackett (0.24.3003, 2026-11-03)

- Lancement : `jackett --DataFolder <dir> --Port <n> --ListenPrivate --PIDFile <f>` (le wrapper brew ajoute `--NoUpdates` et `exec` → un seul process .NET). `--DataFolder` marche sur macOS malgré l'aide. Prêt en ~1,8 s (poll `GET /UI/Login` → 200). SIGTERM : sortie < 1,5 s.
- `ServerConfig.json` créé dès le démarrage : champ `APIKey`. `AdminPassword: null`.
- **API admin** (`/api/v2.0/indexers…`) = cookie, pas d'apikey : `POST /UI/Dashboard` corps `password=` → 302 + `Set-Cookie: Jackett=…`.
- Liste : `GET /api/v2.0/indexers?configured=false` → 650 entrées `{id,name,type,configured,last_error,caps,…}`.
- Ajout : `GET /api/v2.0/indexers/{id}/config` puis `POST` du même JSON → 204. Suppression : `DELETE /api/v2.0/indexers/{id}`.
- IDs retenus : `thepiratebay yts eztv nyaasi torrentgalaxyclone limetorrents 1337x kickasstorrents-to rutracker-ru` (`torrentgalaxy` n'existe plus ; `rutracker` = semi-privé).
- Recherche : `GET /api/v2.0/indexers/{id|all}/results?apikey=…&Query=…&Category[]=…` → `{Results:[…], Indexers:[{ID,Name,Status(2=ok,1=err),Results,Error,ElapsedTime}]}`.
  **`all` attend l'indexeur le plus lent (rutracker-ru : 26 s)** → on interroge chaque indexeur en parallèle et on stream.
  Cache Jackett : requête répétée ≈ 4 ms.
- Résultat : `Title Tracker TrackerId CategoryDesc Category[] Size Seeders Peers(=seeders+leechers) PublishDate MagnetUri InfoHash Link Details Guid`.
- `Link` (proxy Jackett, contient l'apikey) : souvent **302 vers un magnet** (LimeTorrents), sinon le `.torrent`.
- Sans FlareSolverr : **1337x, kickasstorrents-to, EZTV échouent** (« Challenge detected but FlareSolverr is not configured »). YTS : 521 (site en panne ce jour-là).
