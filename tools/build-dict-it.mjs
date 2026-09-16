/*
 * LLL, Italian dictionary build step
 *
 * build-dict.mjs's counterpart for Italian. Turns a Wiktextract dump of
 * Italian entries (word forms extracted from English Wiktionary by
 * kaikki.org, in the same spirit as JMdict but sourced from Wiktionary
 * rather than EDRDG/Jisho) into the same small JSON chunks background.js
 * already knows how to stream into IndexedDB, this time under
 * extension/data-it/ rather than extension/data/, so switching to Italian
 * never touches what a Japanese install already has imported.
 *
 *   node tools/build-dict-it.mjs
 *
 * Downloads data/wiktextract-it.jsonl.gz (about 75 MB) and
 * data/it-frequency.txt (about 10 MB) if they are not already there.
 */

import { createReadStream, readFileSync, writeFileSync,
  existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'data', 'wiktextract-it.jsonl.gz');
const SOURCE_URL = 'https://kaikki.org/dictionary/Italian/kaikki.org-dictionary-Italian.jsonl.gz';
const FREQ_FILE = join(ROOT, 'data', 'it-frequency.txt');
const FREQ_URL = 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/it/it_full.txt';
const OUT = join(ROOT, 'extension', 'data-it');
const CHUNK_BYTES = 4 * 1024 * 1024;

// Wiktextract's own part-of-speech strings, narrowed to the handful of codes
// LLL actually needs: 'v'/'n'/'adj' are what deinflect-it.js's rule table
// checks a candidate against (see typesAllow in lookup-common.js), and the
// rest exist purely for display, added to content.js's LABELS dict the same
// way JMdict's codes are. Anything not listed here (punctuation, symbols,
// interfixes, and the like) is not a word LLL has any use for.
const POS_MAP = {
  verb: 'v', noun: 'n', 'proper noun': 'n', name: 'n', adj: 'adj',
  adv: 'adv', prep: 'prep', conj: 'conj', intj: 'intj', pron: 'pron',
  num: 'num', article: 'art', particle: 'prt', prefix: 'pref', suffix: 'suf',
  abbrev: 'abbr'
};

// How many entries one inflected form may point at. A form like "stesse" is
// several words at once (a verb, an adjective, a noun), and all of them are
// worth offering; past a handful they are noise, and every one of them costs
// index size across four hundred thousand forms.
const ALIAS_LIMIT = 6;

// A word letter, accented or not; used to find where the stress falls.
const VOWEL = 'aeiouàèéìòóùAEIOUÀÈÉÌÒÓÙ';
const ACCENTED = 'àèéìòóùÀÈÉÌÒÓÙ';

async function main() {
  await ensure(SOURCE, SOURCE_URL);
  await ensure(FREQ_FILE, FREQ_URL);

  console.log('Reading', FREQ_FILE);
  const frequency = loadFrequency(FREQ_FILE);
  console.log(`  ${frequency.size} frequency ranks`);

  console.log('Reading', SOURCE);
  const entries = [];
  const index = new Map();     // term -> [entry ids]
  const aliases = [];          // [inflected form, the lemma it belongs to][]
  let lines = 0;
  let kept = 0;
  let stressed = 0;

  const gunzip = createGunzip();
  createReadStream(SOURCE).pipe(gunzip);
  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
  for await (const line of rl) {
    lines++;
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const entry = toEntry(row);
    if (!entry) {
      const target = aliasOf(row);
      if (target && target !== row.word) aliases.push([row.word, target]);
      continue;
    }

    kept++;
    if (entry.st !== undefined) stressed++;
    const id = entries.length;
    entries.push(entry);
    const list = index.get(entry.k[0]);
    if (list) list.push(id); else index.set(entry.k[0], [id]);
  }

  // Every inflected form, pointed at the entry it belongs to. These rows were
  // read past above: Wiktionary files "intere" as its own page saying only
  // "feminine plural of intero", which is not a definition and must not
  // become an entry. It is still exactly the fact a reader needs, though, and
  // throwing it away left four hundred thousand ordinary forms unfindable,
  // since a suffix-rule deinflector only ever covers the regular ones. So the
  // form earns an index term rather than an entry, resolved after the whole
  // dump has been read because a form is very often filed before its lemma.
  let aliased = 0;
  for (const [form, target] of aliases) {
    const ids = index.get(target);
    if (!ids) continue;                       // a lemma LLL had no use for
    let list = index.get(form);
    if (!list) { list = []; index.set(form, list); aliased++; }
    for (const id of ids) {
      if (list.length >= ALIAS_LIMIT) break;
      if (!list.includes(id)) list.push(id);
    }
  }
  console.log(`  ${aliased} inflected forms indexed onto the entry they inflect`);

  console.log(`  ${lines} lines read, ${kept} entries kept, ${index.size} searchable forms`);
  console.log(`  ${stressed} entries carry a stress mark`);

  let ranked = 0;
  for (const entry of entries) {
    const rank = frequency.get(entry.k[0]) || frequency.get(entry.k[0].toLowerCase());
    if (rank) { entry.q = rank; ranked++; }
  }
  console.log(`  ${ranked} entries carry a frequency rank`);

  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) {
    if (/^(entries|index)-\d+\.json$/.test(f) || f === 'meta.json') unlinkSync(join(OUT, f));
  }

  const entryChunks = writeChunks('entries', entries);
  const indexChunks = writeChunks('index', [...index.entries()]);
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify({
    // Bumping this makes the extension rebuild its Italian database on next start.
    version: 2,
    built: new Date().toISOString().slice(0, 10),
    entries: entries.length,
    terms: index.size,
    entryChunks,
    indexChunks,
    source: 'Wiktextract (kaikki.org), from English Wiktionary, CC BY-SA 4.0; ' +
      'word frequency from hermitdave/FrequencyWords (OpenSubtitles), MIT'
  }));

  console.log(`  wrote ${entryChunks} entry chunks + ${indexChunks} index chunks to extension/data-it/`);
}

/**
 * One Wiktextract line, converted to LLL's entry shape, or null if it is not
 * a word LLL can use: a non-Italian line (the dump mixes in the occasional
 * cross-reference), an inflected form or alternative spelling pointing at
 * some other headword rather than defining one of its own (form_of/alt_of,
 * the equivalent of JMdict simply not listing conjugated forms as their own
 * entries), or a part of speech LLL has no use for.
 */
function toEntry(row) {
  if (row.lang_code !== 'it' || !row.word) return null;
  const pos = POS_MAP[row.pos];
  if (!pos) return null;

  const senses = [];
  for (const sense of row.senses || []) {
    if (sense.form_of || sense.alt_of) continue;
    const tags = sense.tags || [];
    if (tags.includes('form-of') || tags.includes('alt-of')) continue;
    // "compound of the infinitive capire with ne" is not what capirne means,
    // it is where capirne came from. Left in, it is an entry that outranks
    // the verb it is made of, because it matches the surface form exactly
    // and the verb only matches after a guess. aliasOf sends the form to
    // capire instead.
    if (tags.includes('compound-of')) continue;
    const glosses = (sense.glosses || []).filter(Boolean);
    if (!glosses.length) continue;
    senses.push({ p: [pos], g: glosses });
  }
  if (!senses.length) return null;

  const entry = { k: [row.word], r: [row.word], s: senses, f: 0, kv: 1 };
  const stress = stressIndex(row);
  if (stress !== null) entry.st = stress;
  return entry;
}

/**
 * The lemma an entry-less row belongs to, or null if it belongs to none.
 *
 * Two shapes, both of which toEntry refuses and both of which are really a
 * pointer rather than a word:
 *
 *   form-of      "intere" -> intero, "capito" -> capire. Wiktextract says so
 *                outright, in form_of/alt_of.
 *
 *   compound-of  "capirne" -> capire, "mandarglielo" -> mandare: an
 *                infinitive with its clitics stuck on the end. These slip
 *                past the form-of filter because Wiktionary writes them as a
 *                gloss ("compound of the infinitive capire with ne") rather
 *                than as a form, so they arrive looking like definitions and
 *                then shadow the verb they are made of, answering a hover on
 *                capirne with a sentence about capirne instead of what
 *                capire means. The first link on the sense is the verb
 *                itself, which is what makes them recoverable at all: the
 *                gloss is prose, the link is data.
 */
function aliasOf(row) {
  if (row.lang_code !== 'it' || !row.word) return null;
  if (!POS_MAP[row.pos]) return null;
  const senses = row.senses || [];
  if (!senses.length) return null;

  for (const sense of senses) {
    const of = sense.form_of || sense.alt_of;
    if (of && of.length && of[0].word) return String(of[0].word);
  }
  for (const sense of senses) {
    if (!(sense.tags || []).includes('compound-of')) continue;
    const link = (sense.links || [])[0];
    if (link && link[0]) return String(link[0]);
  }
  return null;
}

/**
 * Where the stress falls, as a character index into the word, or null when
 * nothing here says. Two sources, tried in order:
 *
 *   the canonical form   many verb entries carry one, the headword itself
 *                        with an accent mark added purely to show the
 *                        stress (parlare -> parlàre); comparing the two
 *                        finds exactly which vowel it moved onto.
 *   the IPA transcription   /parˈla.re/'s ˈ marks the start of the stressed
 *                        syllable; counted from the end of the syllables and
 *                        matched against the same count of vowel clusters in
 *                        the spelling. This is the fallback for the many
 *                        entries (most nouns and adjectives) with no
 *                        accented canonical form, and it is an approximation
 *                        rather than a parse: Italian spelling and Italian
 *                        pronunciation do not divide into syllables quite
 *                        the same way, a diphthong is one spoken syllable
 *                        but can be two written vowels, so this can be
 *                        wrong for a word whose spelling and pronunciation
 *                        disagree about that. Nothing downstream trusts it
 *                        as more than a best guess: it is a bold letter in a
 *                        popup, not a citation.
 *
 * A word with neither is guessed at with Italian's default pattern, stressed
 * on the next-to-last syllable (parola piana), which is right far more
 * often than it is wrong, but is still only a guess.
 */
function stressIndex(row) {
  const word = row.word;
  const canonical = (row.forms || []).find((f) => (f.tags || []).includes('canonical'));
  if (canonical && canonical.form && canonical.form.length === word.length) {
    for (let i = 0; i < word.length; i++) {
      if (ACCENTED.includes(canonical.form[i]) && !ACCENTED.includes(word[i])) return i;
    }
  }

  const ipa = (row.sounds || []).map((s) => s.ipa).find(Boolean);
  const fromIpa = stressFromIpa(word, ipa);
  if (fromIpa !== null) return fromIpa;

  const runs = vowelRuns(word);
  if (runs.length >= 2) return runs[runs.length - 2].end - 1;
  if (runs.length === 1) return runs[0].end - 1;
  return null;
}

function stressFromIpa(word, ipa) {
  if (!ipa) return null;
  const clean = ipa.replace(/^\/+|\/+$/g, '');
  // A syllable boundary is written as '.', except right before a stress
  // mark, where the mark itself is the boundary and the dot is left out.
  const syllables = clean.split(/\.|(?=[ˈˌ])/).filter(Boolean);
  const stressed = syllables.findIndex((s) => s.includes('ˈ'));
  if (stressed === -1) return null;
  const fromEnd = syllables.length - stressed;   // 1 = last syllable

  const runs = vowelRuns(word);
  if (!runs.length) return null;
  const target = runs.length - fromEnd;
  const run = runs[target >= 0 ? target : 0];
  // The last vowel in a written cluster is usually the nucleus of a rising
  // diphthong (piède, buòno), which is the common case; not universally
  // true, which is exactly why this whole function is a fallback.
  return run.end - 1;
}

/** Maximal runs of vowel letters, the closest cheap proxy for syllable nuclei. */
function vowelRuns(word) {
  const runs = [];
  let i = 0;
  while (i < word.length) {
    if (!VOWEL.includes(word[i])) { i++; continue; }
    let j = i;
    while (j < word.length && VOWEL.includes(word[j])) j++;
    runs.push({ start: i, end: j });
    i = j;
  }
  return runs;
}

/** "word count" per line, already ranked by how common each word is. */
function loadFrequency(path) {
  const ranks = new Map();
  const lines = readFileSync(path, 'utf8').split('\n');
  let rank = 0;
  for (const line of lines) {
    const sp = line.lastIndexOf(' ');
    if (sp === -1) continue;
    const word = line.slice(0, sp);
    if (!word) continue;
    rank++;
    if (!ranks.has(word)) ranks.set(word, rank);
  }
  return ranks;
}

async function ensure(file, url) {
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  console.log('Downloading', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
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
