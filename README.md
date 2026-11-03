# tf — torrent-finder

Full-screen terminal search engine for torrents. One query searches every source at once (The Pirate Bay, LimeTorrents, Nyaa, RuTracker, YTS, EZTV, 1337x…), results land in one sorted table, and `⏎` hands the torrent to [`dl`](https://github.com/Nexgear75/dl), which downloads it in the background.

```
 tf   ⌕ elden ring                                                           7/9 sources · 102 results · 0.9s
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ALL  GAMES  MOVIES  TV  MUSIC  APPS  BOOKS  ANIME                                           sort: seeders ↓
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
▌   ELDEN RING Tarnished Edition RUNE                                               Console          66.0 GB
▌   ▲ 71      ▼ 0         Lime                                                           2026-09-04  → dl ⏎
    ELDEN RING Shadow of the Erdtree-RUNE                                           PC/Games         66.0 GB
    ▲ 57      ▼ 0         TPB                                                                   2024-06-20
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
ELDEN RING Tarnished Edition RUNE  (.torrent)
/ search · ⏎ → dl · D folder · space mark · tab category · s sort · f filter · I sources · ? help · q quit
```

## No setup

Type `tf` and search. Behind the scenes tf runs its own private [Jackett](https://github.com/Jackett/Jackett) instance:

- if Jackett is missing, tf asks once and installs it with Homebrew (`brew install jackett`);
- it starts on a random local port with its own data folder (`~/.local/share/torrent-finder/jackett`), so an existing Jackett install is never touched;
- on first launch the default public sources are configured automatically; manage them later with `I` (no web UI, no API key to copy);
- everything stops when tf exits — `q`, Ctrl-C, closing the terminal, even `kill -9` (the backend sees its stdin close).

`dl-daemon` is woken up when a result is sent and keeps its own lifecycle: the download continues after tf exits; open `dl` to follow it.

## Install

Requirements: `cargo` and `bun` to build, [`dl`](https://github.com/Nexgear75/dl) to download (a `dl-daemon` whose `add` accepts `select: false`, otherwise multi-file torrents wait for a file choice in dl), Homebrew (or an installed `jackett`).

```sh
./scripts/install.sh          # installs tf and tf-backend into ~/.local/bin
```

## Usage

```sh
tf                  # open and type a search
tf elden ring       # open and search right away
```

### Keys

| Normal mode | |
|---|---|
| `/` `i` | new search (`↑` `↓` browse history, `tab` changes category) |
| `j` `k` / `↓` `↑` | move |
| `gg` / `G` | top / bottom |
| `ctrl-d` / `ctrl-u` | half page down / up |
| `⏎` | send to dl (dl's download folder) |
| `D` | send to dl, choosing the folder (path completion) |
| `space` | mark several results, then `⏎` sends them all · `u` clears marks |
| `tab` / `1`…`8` | category: ALL GAMES MOVIES TV MUSIC APPS BOOKS ANIME |
| `s` | sort: seeders → size → date → name |
| `f` | filters: min seeders, min/max size, sources |
| `o` | open the torrent page in the browser |
| `y` | copy the magnet |
| `I` | sources: `space` on/off, `a` add a public tracker, `dd` remove, `o` website |
| `?` | help |
| `q` | quit (stops the search engine) |

Seeders are green ≥ 50, yellow ≥ 5, red below. Multi-file torrents download every file (no file picker in dl).

### Sources

Configured on first launch: The Pirate Bay, YTS, EZTV, Nyaa, TorrentGalaxyClone, LimeTorrents, 1337x, kickasstorrents.to, RuTracker.RU. Any other public tracker supported by Jackett can be added with `I` → `a`.

1337x, kickasstorrents and EZTV sit behind Cloudflare challenges and need [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr), which tf does not run (yet): they show as *blocked by Cloudflare* in `I` and in the `x/y sources` counter. Disable them with `space` if the noise bothers you.

## Files

`~/.local/share/torrent-finder/` (or `$TF_DATA_DIR`):

| | |
|---|---|
| `jackett/` | Jackett's private data folder (config, API key, indexers) |
| `state.json` | first-run flag and disabled sources |
| `history.json` | search history |
| `torrents/` | `.torrent` files fetched for results without a magnet |
| `jackett.log`, `backend.log` | logs |

## Architecture

```
tf (Ink/React, compiled with bun) ──stdio JSON lines──▶ tf-backend (Rust/tokio)
                                                         ├─ Jackett child process (install, start, configure, stop)
                                                         ├─ one request per source in parallel → results streamed, merged by info-hash
                                                         └─ dl-daemon (Unix socket ~/.local/share/dl/dl.sock, woken up if needed)
```

- `backend/` — the Rust backend. The TUI starts it as a child: no daemon, no socket of its own.
- `tui/` — Ink 8 interface.

Protocol (one JSON object per line):

| Method | Params | |
|---|---|---|
| `status` | — | engine state: `checking` `missing` `installing` `starting` `configuring` `ready` `error` |
| `install_engine` / `retry_engine` | — | `brew install jackett` (streams `progress` events) / start again |
| `search` | `query`, `category?` | returns `{searchId}`; then events `search_start`, one `results` per source (full merged list), `search_done` |
| `cancel` | — | stops the running search |
| `indexers` / `catalog` | — | configured sources / public trackers that can be added |
| `set_indexer` / `add_indexer` / `remove_indexer` | `id`, `enabled?` | |
| `send` | `items: [{id,title,magnet,link}]`, `dir?` | magnet, else the Jackett link resolved to a magnet or a local `.torrent`; sent with `select: false` |
| `resolve` | `item` | magnet (or `.torrent` path) for one result |
| `dl_config` | — | dl's `download_dir` |

Development:

```sh
cd backend && cargo test && cargo build
cd tui && bun install && bun test && bun run dev    # uses backend/target/{release,debug}
```

Testing without touching your real setup: `TF_DATA_DIR`, `DL_SOCKET`, `DL_DATA_DIR`, `DL_DAEMON`, `TF_JACKETT`, `TF_BACKEND`.
