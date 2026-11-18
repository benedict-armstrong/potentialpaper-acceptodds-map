# acceptodds map, as signals

A [PotentialPaper](https://github.com/PotentialHedge/potentialpaper) signal set: the
[acceptodds](https://acceptodds.com) paper map of ICLR 2027, copied over so any plugin, and search, can use it. The
[Paper map](https://github.com/benedict-armstrong/potentialpaper-paper-map) plugin draws it.

## Signals

| Signal        | Kind          | What it is |
| ------------- | ------------- | ---------- |
| `map.xy`      | vector, 2     | Where the paper sits on the map: a UMAP layout of its title, TL;DR, abstract and keywords, with neighbours from a reranker |
| `map.region`  | label         | Its broad area (Leiden, coarse), named by its most typical keywords |
| `map.cluster` | label         | Its close group (Leiden, fine), named the same way |
| `embedding`   | vector, 64    | OpenAI `text-embedding-3-small`, cut to 64 dimensions by PCA and scaled to whole numbers, for nearest papers |

They are declared in `potentialpaper-plugin.json`, whose `publisher` is the account that writes them: the bot
`acceptodds-map`, so the key the copy runs with can write these signals and nothing else. Papers are named
by OpenReview id, so a value waits for its paper if the site doesn't have it yet.

## How it is copied

`sync.mjs` (Node 22.5 or later) reads the map straight from acceptodds' database (`map_points`, `map_topics`, and
`listings` for each paper's OpenReview id) and sends the site only what changed since the last copy: the papers that
are new or whose values changed, and removals for papers that left the map. It keeps a short hash of each paper's
values in its state file to tell. A rebuild of the map, which moves most papers (over 30%), goes in whole instead, as
a new generation of the set published at once, so readers switch from the old map to the new one in one step. So does
the first copy, a copy after someone else published a generation, and `--force`.

It runs on the server that hosts acceptodds, in a container on acceptodds' database network
(`docker-compose.yml`), checking every 30 minutes:

```sh
SYNC_ENV=/path/to/sync.env docker compose up -d --build
docker compose logs -f sync
```

`sync.env` holds two secrets, and is not in the repo:

- `ACCEPTODDS_DATABASE_URL`: acceptodds' database, as the role `potentialpaper_reader`, which may only read
  `map_points`, `map_topics` and `listings`.
- `PP_TOKEN`: an API key of the publisher's account, the bot `acceptodds-map`, that may write.

By hand:

```sh
node sync.mjs                 # once: what changed since the last copy
node sync.mjs --force         # once, the whole map as a new generation
node sync.mjs --from-files map.json iclr2027.sqlite   # from the map builder's own files instead
```

`PP_SITE`, `AO_KIND` (`ICLR 2027`), `SOURCE` and `WATCH_MINUTES` change where it copies from and to, and how often.
