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
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'data', 'JMdict_e.gz');
const OUT = join(ROOT, 'extension', 'data');
const SOURCE_URL = 'http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz';
const CHUNK_BYTES = 4 * 1024 * 1024;

// Word frequency, blended from two corpora that read nothing alike. JPDB comes
// from anime, manga, light novels and visual novels, the Japanese people
// actually read for fun; BCCWJ comes from newspapers, books, magazines and the
// web, a government-run sample of formal and everyday written Japanese. A word
// common in casual speech but rare in print, or the other way round, only shows
// up as ordinary once both are asked. A rank is attached to each entry here
// rather than shipped as a file of its own, because one number per entry costs
// nothing and saves the extension a whole second lookup.
const FREQ_FILE = join(ROOT, 'data', 'jpdb-frequency.zip');
const FREQ_URL = 'https://github.com/Kuuuube/yomitan-dictionaries/raw/main/' +
  'dictionaries/JPDB_v2.2_Frequency_Kana_2024-10-13.zip';
const FREQ_FILE_2 = join(ROOT, 'data', 'bccwj-frequency.zip');
const FREQ_URL_2 = 'https://github.com/Kuuuube/yomitan-dictionaries/raw/main/' +
  'dictionaries/BCCWJ_SUW_LUW_combined.zip';

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

  const frequency = await loadFrequency(FREQ_FILE, FREQ_URL);
  const frequency2 = await loadFrequency(FREQ_FILE_2, FREQ_URL_2);
  let ranked = 0;
  let blended = 0;
  for (const entry of entries) {
    const jpdb = bestRank(entry, frequency);
    const bccwj = bestRank(entry, frequency2);
    entry.q = combineRanks(jpdb, bccwj);
    if (entry.q) ranked++;
    if (jpdb && bccwj) blended++;
  }
  console.log(`  ${ranked} entries carry a frequency rank (${blended} from both corpora)`);

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
    version: 4,
    built: new Date().toISOString().slice(0, 10),
    entries: entries.length,
    terms: index.size,
    entryChunks,
    indexChunks,
    source: 'JMdict (EDRDG), CC BY-SA 4.0'
  }));

  console.log(`  wrote ${entryChunks} entry chunks + ${indexChunks} index chunks to extension/data/`);
}

/**
 * Read a Yomitan-format frequency list into "word\treading" -> rank.
 *
 * Both lists used here happen to share this format, so one reader does for
 * both. Either can give two ranks per word: how often it appears at all, and
 * how often it appears written in kana. The kana one is marked with ㋕. For
 * 日本語 those are #4705 and #140824 — the second only says that people rarely
 * write にほんご out in kana, which is not what "how common is this word"
 * means. So the plain rank wins wherever there is one, and the kana rank is
 * kept only for words that are always kana anyway, like every particle.
 */
async function loadFrequency(file, url) {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    console.log('Downloading frequency data from', url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }

  const files = unzip(readFileSync(file));
  const ranks = new Map();       // the plain rank
  const kanaOnly = new Map();    // the ㋕ rank, used only as a fallback

  for (const name of Object.keys(files)) {
    if (!name.includes('term_meta_bank')) continue;
    for (const [term, kind, data] of JSON.parse(files[name].toString('utf8'))) {
      if (kind !== 'freq') continue;

      const inner = data && data.frequency !== undefined ? data.frequency : data;
      const value = typeof inner === 'number' ? inner : inner && inner.value;
      if (!value) continue;

      const shown = typeof inner === 'object' ? String(inner.displayValue || '') : '';
      const key = data && data.reading ? term + '\t' + data.reading : term;
      const into = shown.includes('㋕') ? kanaOnly : ranks;
      const seen = into.get(key);
      if (!seen || value < seen) into.set(key, value);
    }
  }

  kanaOnly.forEach((value, key) => { if (!ranks.has(key)) ranks.set(key, value); });
  console.log(`  ${ranks.size} frequency ranks`);
  return ranks;
}

/**
 * The best (lowest) rank one frequency list has for this entry, across every
 * spelling and reading it carries. 見る is far commoner than 観る, so this
 * takes the best any of an entry's forms achieves, since that is the word.
 */
function bestRank(entry, frequency) {
  let best = 0;
  const forms = entry.k.length ? entry.k : entry.r;
  for (const form of forms) {
    for (const reading of entry.r) {
      const rank = frequency.get(form + '\t' + reading) || frequency.get(form);
      if (rank && (!best || rank < best)) best = rank;
    }
  }
  return best;
}

/**
 * Two ranks for the same word, from corpora that do not agree on much, folded
 * into one.
 *
 * A plain average would let a word that is common in one corpus and entirely
 * absent from the other drag the number toward "rare", which is backwards —
 * H (a light novel about a schoolgirl) not covering technical vocabulary a
 * newspaper covers constantly says nothing about how common that vocabulary
 * actually is. The harmonic mean instead rewards a word for doing well in
 * either list, while still favouring one that both lists agree is common over
 * one only a single list has heard of — two independent corpora agreeing on
 * "this word is common" is stronger evidence than either alone.
 */
function combineRanks(a, b) {
  if (a && b) return Math.round((2 * a * b) / (a + b));
  return a || b || 0;
}

/**
 * Just enough of the zip format to get the files out — the frequency list is
 * distributed as one, and this saves taking on a dependency to read it.
 */
function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip file');

  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = {};

  for (let i = 0; i < count; i++) {
    const nameLength = buffer.readUInt16LE(at + 28);
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);

    // The local header repeats the name and extra fields at its own lengths.
    const start = localAt + 30 +
      buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const body = buffer.subarray(start, start + compressed);
    files[name] = method === 0 ? body : inflateRawSync(body);

    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return files;
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

  // JMdict marks some spellings as not really for reading. The auxiliary verb
  // ます, for instance, carries the kanji 〼 tagged "sK" — a search-only form,
  // meaning "match this, but never show it to anyone". Honour that: keep every
  // spelling for matching, but sort the showable ones to the front and record
  // how many there are, so the popup can display a word the way it is written.
  const spellings = [];
  for (const m of xml.matchAll(/<k_ele>([\s\S]*?)<\/k_ele>/g)) {
    const keb = pick(m[1], 'keb');
    if (!keb) continue;
    const info = m[1];
    const rank = /&sK;|search-only kanji/.test(info) ? 2
      : /&rK;|&iK;|&oK;|&ateji;/.test(info) ? 1
      : 0;
    spellings.push({ keb, rank });
    score = Math.max(score, priorityOf(info));
  }
  spellings.sort((a, b) => a.rank - b.rank);
  for (const s of spellings) k.push(s.keb);
  const showable = spellings.filter((s) => s.rank < 2).length;
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

  // kv: how many of the spellings in `k` are fit to display.
  return { k, r, s: senses, f: score, kv: showable };
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
