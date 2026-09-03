/*
 * LLL — dictionary build step
 *
 * Turns the raw JMdict file (a ~120 MB XML document) into small JSON chunks the
 * extension can stream into its own database on first run. This runs once on
 * your machine; the extension never touches XML.
 *
 *   node tools/build-dict.mjs
 *
 * It downloads data/JMdict_e.gz if it is not already there.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'data', 'JMdict_e.gz');
const OUT = join(ROOT, 'extension', 'data');
const SOURCE_URL = 'http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz';
const CHUNK_BYTES = 4 * 1024 * 1024;

// How much weight each JMdict priority marker carries. Only used for ordering
// results, so the exact numbers matter less than their relative size.
const PRIORITY = {
  news1: 40, news2: 20, ichi1: 40, ichi2: 20,
  spec1: 40, spec2: 20, gai1: 30, gai2: 15
};

async function main() {
  if (!existsSync(SOURCE)) {
    mkdirSync(dirname(SOURCE), { recursive: true });
    console.log('Downloading JMdict from', SOURCE_URL);
    const res = await fetch(SOURCE_URL);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    writeFileSync(SOURCE, Buffer.from(await res.arrayBuffer()));
  }

  console.log('Reading', SOURCE);
  const xml = gunzipSync(readFileSync(SOURCE)).toString('utf8');

  const tags = readEntities(xml);
  const byDescription = new Map(Object.entries(tags).map(([k, v]) => [v, k]));
  console.log(`  ${Object.keys(tags).length} tag definitions`);

  const entries = [];
  const index = new Map();          // term -> [entry ids]
  let cursor = 0;

  for (;;) {
    const start = xml.indexOf('<entry>', cursor);
    if (start === -1) break;
    const end = xml.indexOf('</entry>', start);
    if (end === -1) break;
    cursor = end + 8;

    const entry = parseEntry(xml.slice(start + 7, end), byDescription);
    if (!entry) continue;

    const id = entries.length;
    entries.push(entry);
    for (const term of [...entry.k, ...entry.r]) {
      const list = index.get(term);
      if (list) list.push(id); else index.set(term, [id]);
    }
  }

  console.log(`  ${entries.length} entries, ${index.size} searchable forms`);

  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) {
    if (/^(entries|index)-\d+\.json$/.test(f) || f === 'meta.json' || f === 'tags.json') {
      unlinkSync(join(OUT, f));
    }
  }

  const entryChunks = writeChunks('entries', entries);
  const indexChunks = writeChunks('index', [...index.entries()]);
  writeFileSync(join(OUT, 'tags.json'), JSON.stringify(tags));
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify({
    // Bumping this number makes the extension rebuild its database on next start.
    version: 1,
    built: new Date().toISOString().slice(0, 10),
    entries: entries.length,
    terms: index.size,
    entryChunks,
    indexChunks,
    source: 'JMdict (EDRDG), CC BY-SA 4.0'
  }));

  console.log(`  wrote ${entryChunks} entry chunks + ${indexChunks} index chunks to extension/data/`);
}

/** Pull the <!ENTITY x "..."> definitions out of the DTD at the top of the file. */
function readEntities(xml) {
  const tags = {};
  const head = xml.slice(0, xml.indexOf(']>') + 2);
  for (const m of head.matchAll(/<!ENTITY\s+([\w-]+)\s+"([^"]*)">/g)) tags[m[1]] = m[2];
  return tags;
}

function parseEntry(xml, byDescription) {
  const k = [];
  const r = [];
  let score = 0;

  for (const m of xml.matchAll(/<k_ele>([\s\S]*?)<\/k_ele>/g)) {
    const keb = pick(m[1], 'keb');
    if (keb) { k.push(keb); score = Math.max(score, priorityOf(m[1])); }
  }
  for (const m of xml.matchAll(/<r_ele>([\s\S]*?)<\/r_ele>/g)) {
    const reb = pick(m[1], 'reb');
    if (reb) { r.push(reb); score = Math.max(score, priorityOf(m[1])); }
  }
  if (!k.length && !r.length) return null;

  const senses = [];
  let inheritedPos = [];
  for (const m of xml.matchAll(/<sense>([\s\S]*?)<\/sense>/g)) {
    const body = m[1];
    // JMdict only repeats <pos> when it changes; an absent one means "same as
    // the sense above". Getting this wrong breaks the part-of-speech check that
    // the deinflector relies on, so it is worth the extra state.
    const pos = collect(body, 'pos', byDescription);
    if (pos.length) inheritedPos = pos;

    const glosses = [...body.matchAll(/<gloss(?:\s[^>]*)?>([\s\S]*?)<\/gloss>/g)]
      .map((g) => decode(g[1]))
      .filter(Boolean);
    if (!glosses.length) continue;

    const sense = { p: inheritedPos, g: glosses };
    const misc = [...collect(body, 'misc', byDescription), ...collect(body, 'field', byDescription)];
    if (misc.length) sense.m = misc;
    senses.push(sense);
  }
  if (!senses.length) return null;

  return { k, r, s: senses, f: score };
}

function pick(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decode(m[1]) : null;
}

/**
 * Read repeated tag values, normalising them to short JMdict codes ("n", "v5k").
 * Depending on how the file was generated these arrive either as unexpanded
 * entity references (&n;) or as the full description text, so handle both.
 */
function collect(xml, tag, byDescription) {
  const out = [];
  for (const m of xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))) {
    const raw = m[1].trim();
    const entity = raw.match(/^&([\w-]+);$/);
    if (entity) out.push(entity[1]);
    else if (byDescription.has(raw)) out.push(byDescription.get(raw));
    else out.push(decode(raw));
  }
  return out;
}

function priorityOf(xml) {
  let score = 0;
  for (const m of xml.matchAll(/<(?:ke|re)_pri>([\s\S]*?)<\/(?:ke|re)_pri>/g)) {
    const tag = m[1].trim();
    if (PRIORITY[tag]) score += PRIORITY[tag];
    const nf = tag.match(/^nf(\d+)$/);
    if (nf) score += Math.max(0, 49 - Number(nf[1]));
  }
  return score;
}

function decode(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/** Split an array into files of roughly CHUNK_BYTES each. */
function writeChunks(name, items) {
  let chunk = [];
  let bytes = 0;
  let n = 0;
  const flush = () => {
    if (!chunk.length) return;
    writeFileSync(join(OUT, `${name}-${String(n).padStart(3, '0')}.json`), JSON.stringify(chunk));
    n++;
    chunk = [];
    bytes = 0;
  };
  for (const item of items) {
    const json = JSON.stringify(item);
    if (bytes + json.length > CHUNK_BYTES) flush();
    chunk.push(item);
    bytes += json.length + 1;
  }
  flush();
  return n;
}

main().catch((err) => { console.error(err); process.exit(1); });
