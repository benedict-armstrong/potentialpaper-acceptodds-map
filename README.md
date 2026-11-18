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

`sync.mjs` (Node 22.5 or later, no dependencies) reads `GET /api/v1/map` and `GET /api/v1/map/export` from
acceptodds, and writes the whole map to the site as a new generation of the set, which it then publishes: readers
switch from the old map to the new one at once. It copies only when the map changed since the last copy.

```sh
PP_TOKEN=pp_live_… node sync.mjs                 # once, if the map changed
PP_TOKEN=pp_live_… node sync.mjs --force         # once, anyway
PP_TOKEN=pp_live_… node sync.mjs --watch         # every 30 minutes (WATCH_MINUTES)
PP_TOKEN=pp_live_… node sync.mjs --from-files map.json iclr2027.sqlite   # from the map builder's own files
```

`PP_TOKEN` is an API key of the publisher's account that may write. `PP_SITE`,
`AO_SITE`, `AO_KIND` and `SOURCE` change where it copies from and to.

A GitHub Actions workflow (`.github/workflows/sync.yml`) runs it every six hours with the `PP_TOKEN` secret, and on
demand.
