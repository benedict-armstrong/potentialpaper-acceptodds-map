#!/usr/bin/env node
// Copies the acceptodds paper map into a PotentialPaper signal set (this repo's manifest): every paper's place on the
// map, its region and cluster, and its small embedding.
//
// Only what changed is sent. The last copy's state (STATE_FILE) keeps a short hash of each paper's four values, and a
// run sends just the papers that are new or whose values changed, and removes those that left the map. A rebuild of
// the map, which moves most papers, goes in whole as a new generation instead, published at once, so readers never see
// half the old layout and half the new; so does the first copy, and any copy after someone else published a generation.
//
//   node sync.mjs                                  copy once: what changed since the last copy
//   node sync.mjs --force                          copy the whole map, as a new generation
//   node sync.mjs --watch                          check every 30 minutes (WATCH_MINUTES), forever
//   node sync.mjs --from-files map.json iclr2027.sqlite
//                                                  copy from the map builder's own files instead
//
// ACCEPTODDS_DATABASE_URL is acceptodds' database, as a role that may only read map_points, map_topics and listings.
// PP_TOKEN is an API key of the publisher's account (the manifest's "publisher") that may write. PP_SITE
// (https://papers.potentialhedge.com), AO_KIND (ICLR 2027) and SOURCE (this repo on GitHub) say where from and to. The
// last copy's state is kept in STATE_FILE (.last-sync).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'potentialpaper-plugin.json'), 'utf8'));
const SET = manifest.id;
const PP_SITE = (process.env.PP_SITE ?? 'https://papers.potentialhedge.com').replace(/\/$/, '');
const AO_KIND = process.env.AO_KIND ?? 'ICLR 2027';
const SOURCE = process.env.SOURCE ?? 'github:benedict-armstrong/potentialpaper-acceptodds-map';
const STATE = process.env.STATE_FILE ?? join(here, '.last-sync');
/** Values a write carries; the site takes up to 5,000. */
const CHUNK = 4000;
/** The four signals each paper has. */
const SIGNALS = ['map.xy', 'map.region', 'map.cluster', 'embedding'];
/** Above this share of papers changed, it's a rebuild: copy it whole, as a new generation. */
const REBUILD_SHARE = 0.3;

const log = (...args) => console.log(new Date().toISOString(), ...args);

/**
 * The map as one list: `{ points: [{ id, x, y, region, cluster, vector }], regions, clusters }`, `id` the paper's
 * OpenReview forum id, from its listing's OpenReview link. Read straight from acceptodds' database
 * (ACCEPTODDS_DATABASE_URL, a role that may only read the map's tables). Points without an id are left out, since
 * nothing else names the paper.
 */
async function fromAcceptodds() {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: process.env.ACCEPTODDS_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      `select m.slug, m.x, m.y, m.region, m.cluster, m.vector, l.links
         from map_points m join listings l on l.slug = m.slug
        where m.kind = $1 order by m.slug`,
      [AO_KIND],
    );
    const topics = await client.query(
      'select level, number, label from map_topics where kind = $1 order by level, number',
      [AO_KIND],
    );
    const points = [];
    for (const r of rows) {
      const link = (r.links ?? []).find((l) => /^https:\/\/openreview\.net\/forum\?id=/.test(l.url));
      const id = link ? new URL(link.url).searchParams.get('id') : null;
      if (!id) continue;
      points.push({ id, x: r.x, y: r.y, region: r.region, cluster: r.cluster, vector: r.vector });
    }
    const level = (name) => topics.rows.filter((t) => t.level === name).map(({ number, label }) => ({ number, label }));
    return { points, regions: level('region'), clusters: level('cluster'), skipped: rows.length - points.length };
  } finally {
    await client.end();
  }
}

/** The same, from the builder's `map.json` and the scrape it was built from (which names each submission number). */
async function fromFiles(mapPath, sqlitePath) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  const byNumber = new Map(db.prepare('select number, id from submissions').all().map((r) => [r.number, r.id]));
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const points = [];
  for (const p of map.points) {
    const id = byNumber.get(Number(p.slug.split('-').pop()));
    if (!id) continue;
    points.push({ id, x: p.x, y: p.y, region: p.region, cluster: p.cluster, vector: p.vector ?? null });
  }
  return { points, regions: map.regions, clusters: map.clusters, skipped: map.points.length - points.length };
}

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** A paper's values, by signal, `null` where it has none: what the site holds for it. */
function paperValues(p) {
  return {
    'map.xy': [p.x, p.y],
    'map.region': p.region === null ? null : String(p.region),
    'map.cluster': p.cluster === null ? null : String(p.cluster),
    embedding: Array.isArray(p.vector) && p.vector.length === 64 ? p.vector : null,
  };
}
const paperHash = (p) => hash(paperValues(p)).slice(0, 16);
const labelsOf = (topics) => topics.map((t) => ({ key: String(t.number), title: t.label }));

/** What a copy leaves behind: the set's generation, each paper's hash, each label signal's. */
function stateOf(map, generation) {
  return {
    version: 2,
    generation,
    papers: Object.fromEntries(map.points.map((p) => [p.id, paperHash(p)])),
    labels: { 'map.region': hash(labelsOf(map.regions)), 'map.cluster': hash(labelsOf(map.clusters)) },
  };
}

/** The last copy's state; `{ legacy }` for the first version's, a fingerprint of the whole map. */
function readState() {
  if (!existsSync(STATE)) return null;
  const text = readFileSync(STATE, 'utf8').trim();
  try {
    const state = JSON.parse(text);
    if (state?.version === 2) return state;
  } catch {
    // Not JSON: the first version's fingerprint.
  }
  return /^[0-9a-f]{64}$/.test(text) ? { legacy: text } : null;
}

async function site(method, path, body) {
  const res = await fetch(`${PP_SITE}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.PP_TOKEN}`,
      'content-type': 'application/json',
      'user-agent': 'potentialpaper-acceptodds-map',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 1000)}`);
  return text ? JSON.parse(text) : null;
}

/** Each point's values as the site takes them; with `nulls`, a `null` removes a value the paper no longer has. */
function valuesOf(points, { nulls }) {
  const values = [];
  for (const p of points) {
    const paper = `openreview:${p.id}`;
    for (const [signal, value] of Object.entries(paperValues(p))) {
      if (value !== null || nulls) values.push({ paper, signal, value });
    }
  }
  return values;
}

async function writeValues(values, generation) {
  const at = generation ? `?generation=${generation}` : '';
  for (let i = 0; i < values.length; i += CHUNK) {
    await site('PUT', `/signal-sets/${SET}/values${at}`, { values: values.slice(i, i + CHUNK) });
    log(`wrote ${Math.min(i + CHUNK, values.length)} of ${values.length} values`);
  }
}

async function writeLabels(map, which, generation) {
  const at = generation ? `?generation=${generation}` : '';
  for (const [signal, topics] of [
    ['map.region', map.regions],
    ['map.cluster', map.clusters],
  ]) {
    if (which.includes(signal)) {
      await site('PUT', `/signal-sets/${SET}/labels${at}`, { signal, labels: labelsOf(topics) });
    }
  }
}

/** The whole map as a new generation, published at once. */
async function copyWhole(map) {
  await site('POST', '/signal-sets', { source: SOURCE });
  const { generation } = await site('POST', `/signal-sets/${SET}/generations`);
  await writeValues(valuesOf(map.points, { nulls: false }), generation);
  await writeLabels(map, ['map.region', 'map.cluster'], generation);
  await site('POST', `/signal-sets/${SET}/generations/${generation}/publish`);
  log(`published generation ${generation} of ${SET}: ${map.points.length} papers`);
  return generation;
}

async function once({ force, files }) {
  const map = files ? await fromFiles(...files) : await fromAcceptodds();
  const last = readState();
  const live = (await site('GET', `/signal-sets/${SET}`).catch(() => null))?.generation ?? null;
  const save = (generation) => writeFileSync(STATE, `${JSON.stringify(stateOf(map, generation))}\n`);
  const whole = async (why) => {
    log(`copying the whole map, ${map.points.length} papers (${map.skipped} without an OpenReview id left out): ${why}`);
    save(await copyWhole(map));
  };
  if (force) return whole('asked to');
  if (!last) return whole('no record of the last copy');
  if (last.legacy) {
    // The first version copied whole and kept a fingerprint: if the map is still the one it copied, the site has it.
    if (last.legacy !== hash(map)) return whole('the map changed since a copy that kept no per-paper record');
    save(live);
    log(`recorded the map the site already has (generation ${live}, ${map.points.length} papers)`);
    return;
  }
  if (last.generation !== live) return whole(`the site's live generation is ${live}, not the ${last.generation} last copied`);

  const changed = map.points.filter((p) => last.papers[p.id] !== paperHash(p));
  const here = new Set(map.points.map((p) => p.id));
  const gone = Object.keys(last.papers).filter((id) => !here.has(id));
  const labels = ['map.region', 'map.cluster'].filter(
    (signal) => last.labels[signal] !== hash(labelsOf(signal === 'map.region' ? map.regions : map.clusters)),
  );
  if (changed.length === 0 && gone.length === 0 && labels.length === 0) {
    log(`the map hasn't changed (${map.points.length} papers); nothing to copy`);
    return;
  }
  if (changed.length + gone.length > REBUILD_SHARE * map.points.length) {
    return whole(`a rebuild: ${changed.length} papers changed and ${gone.length} left`);
  }
  log(`${changed.length} papers new or changed, ${gone.length} left the map, labels changed: ${labels.join(', ') || 'none'}`);
  const removals = gone.flatMap((id) => SIGNALS.map((signal) => ({ paper: `openreview:${id}`, signal, value: null })));
  await writeValues([...valuesOf(changed, { nulls: true }), ...removals]);
  await writeLabels(map, labels);
  save(live);
  log(`updated generation ${live} of ${SET} in place`);
}

async function main() {
  const args = process.argv.slice(2);
  if (!process.env.PP_TOKEN) {
    console.error('PP_TOKEN is not set: an API key of the account the manifest names as publisher, that may write');
    process.exit(2);
  }
  const at = args.indexOf('--from-files');
  const files = at >= 0 ? [args[at + 1], args[at + 2]] : null;
  if (files && (!files[0] || !files[1])) {
    console.error('--from-files takes the map.json and the sqlite it was built from');
    process.exit(2);
  }
  const options = { force: args.includes('--force'), files };
  if (!args.includes('--watch')) return once(options);
  const minutes = Number(process.env.WATCH_MINUTES ?? 30);
  for (;;) {
    await once(options).catch((e) => log('failed:', e.message));
    await new Promise((r) => setTimeout(r, minutes * 60_000));
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
