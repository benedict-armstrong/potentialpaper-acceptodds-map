#!/usr/bin/env node
// Copies the acceptodds paper map into a PotentialPaper signal set (this repo's manifest), whole, as one generation:
// every paper's place on the map, its region and cluster, and its small embedding. It starts a new generation, writes
// all of it, and publishes it, so readers switch from the old map to the new one at once.
//
//   PP_TOKEN=pp_live_… node sync.mjs               copy once, if acceptodds' map changed since the last copy
//   PP_TOKEN=pp_live_… node sync.mjs --force       copy even if it didn't
//   PP_TOKEN=pp_live_… node sync.mjs --watch       check every 30 minutes (WATCH_MINUTES), forever
//   PP_TOKEN=pp_live_… node sync.mjs --from-files map.json iclr2027.sqlite
//                                                  copy from the map builder's own files instead of acceptodds.com
//
// PP_TOKEN is an API key of the publisher's account (the manifest's "publisher") that may write. PP_SITE
// (https://papers.potentialhedge.com), AO_SITE (https://acceptodds.com), AO_KIND (ICLR 2027) and SOURCE (this repo on
// GitHub) say where from and to. The last copy's fingerprint is kept in .last-sync.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'potentialpaper-plugin.json'), 'utf8'));
const SET = manifest.id;
const PP_SITE = (process.env.PP_SITE ?? 'https://papers.potentialhedge.com').replace(/\/$/, '');
const AO_SITE = (process.env.AO_SITE ?? 'https://acceptodds.com').replace(/\/$/, '');
const AO_KIND = process.env.AO_KIND ?? 'ICLR 2027';
const SOURCE = process.env.SOURCE ?? 'github:benedict-armstrong/potentialpaper-acceptodds-map';
const STATE = join(here, '.last-sync');
/** Values a write carries; the site takes up to 5,000. */
const CHUNK = 4000;

const log = (...args) => console.log(new Date().toISOString(), ...args);

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'potentialpaper-acceptodds-map' } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/**
 * The map as one list: `{ points: [{ id, x, y, region, cluster, vector }], regions, clusters }`, `id` the paper's
 * OpenReview forum id. Points without one are left out, since nothing else names the paper.
 */
async function fromAcceptodds() {
  const kind = encodeURIComponent(AO_KIND);
  const [map, exported] = await Promise.all([
    getJson(`${AO_SITE}/api/v1/map?kind=${kind}`),
    getJson(`${AO_SITE}/api/v1/map/export?kind=${kind}`),
  ]);
  const at = new Map(exported.slugs.map((slug, i) => [slug, i]));
  const points = [];
  map.slugs.forEach((slug, i) => {
    const j = at.get(slug);
    const id = j === undefined ? null : exported.openreview[j];
    if (!id) return;
    points.push({
      id,
      x: map.x[i],
      y: map.y[i],
      region: map.region[i],
      cluster: map.cluster[i],
      vector: exported.vectors[j],
    });
  });
  return { points, regions: map.regions, clusters: map.clusters, skipped: map.slugs.length - points.length };
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

function fingerprint(map) {
  return createHash('sha256').update(JSON.stringify(map)).digest('hex');
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

/** Each point's four values, as the set's signals take them. */
function valuesOf(map) {
  const values = [];
  for (const p of map.points) {
    const paper = `openreview:${p.id}`;
    values.push({ paper, signal: 'map.xy', value: [p.x, p.y] });
    if (p.region !== null) values.push({ paper, signal: 'map.region', value: String(p.region) });
    if (p.cluster !== null) values.push({ paper, signal: 'map.cluster', value: String(p.cluster) });
    if (Array.isArray(p.vector) && p.vector.length === 64) values.push({ paper, signal: 'embedding', value: p.vector });
  }
  return values;
}

async function copy(map) {
  await site('POST', '/signal-sets', { source: SOURCE });
  const { generation } = await site('POST', `/signal-sets/${SET}/generations`);
  const values = valuesOf(map);
  for (let i = 0; i < values.length; i += CHUNK) {
    await site('PUT', `/signal-sets/${SET}/values?generation=${generation}`, { values: values.slice(i, i + CHUNK) });
    log(`wrote ${Math.min(i + CHUNK, values.length)} of ${values.length} values`);
  }
  for (const [signal, topics] of [
    ['map.region', map.regions],
    ['map.cluster', map.clusters],
  ]) {
    const labels = topics.map((t) => ({ key: String(t.number), title: t.label }));
    await site('PUT', `/signal-sets/${SET}/labels?generation=${generation}`, { signal, labels });
  }
  await site('POST', `/signal-sets/${SET}/generations/${generation}/publish`);
  return { generation, values: values.length };
}

async function once({ force, files }) {
  const map = files ? await fromFiles(...files) : await fromAcceptodds();
  const print = fingerprint(map);
  const last = existsSync(STATE) ? readFileSync(STATE, 'utf8').trim() : null;
  if (!force && print === last) {
    log(`the map hasn't changed (${map.points.length} papers); nothing to copy`);
    return;
  }
  log(`copying ${map.points.length} papers (${map.skipped} without an OpenReview id left out) to ${PP_SITE}`);
  const { generation, values } = await copy(map);
  writeFileSync(STATE, `${print}\n`);
  log(`published generation ${generation} of ${SET}: ${values} values`);
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
