/*
 * Torval, turning a Wiktextract dump into a dictionary
 *
 * The shared half of build-dict-it.mjs and build-dict-es.mjs. Italian and
 * Spanish are read from the same source in the same shape (kaikki.org's
 * machine extraction of English Wiktionary), ranked by the same kind of
 * frequency list, and written into the same chunked JSON that background.js
 * streams into IndexedDB. Everything about that is here, once.
 *
 * What a language brings of its own is its dump, its frequency list, where
 * to write, and where the stress falls, which is the one genuinely
 * language-specific judgement in the whole build: Italian has to be told
 * (from a pronunciation, or guessed), Spanish can be worked out from the
 * spelling alone.
 *
 *   build({ code, name, source, sourceUrl, freqFile, freqUrl, out,
 *           version, sourceNote, stressIndex })
 */

import { createReadStream, readFileSync, writeFileSync,
  existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHUNK_BYTES = 4 * 1024 * 1024;

// Wiktextract's own part-of-speech strings, narrowed to the handful of codes
// Torval actually needs: 'v'/'n'/'adj' are what the deinflectors' rule tables
// check a candidate against (see typesAllow in lookup-common.js), and the
// rest exist purely for display, added to content.js's LABELS dict the same
// way JMdict's codes are. Anything not listed here (punctuation, symbols,
// interfixes, and the like) is not a word Torval has any use for.
const POS_MAP = {
  verb: 'v', noun: 'n', 'proper noun': 'n', name: 'n', adj: 'adj',
  adv: 'adv', prep: 'prep', conj: 'conj', intj: 'intj', pron: 'pron',
  num: 'num', article: 'art', particle: 'prt', prefix: 'pref', suffix: 'suf',
  abbrev: 'abbr'
};

// How many entries one inflected form may point at. A form like Italian
// "stesse", or Spanish "fue", is several words at once, and all of them are
// worth offering; past a handful they are noise, and every one of them costs
// index size across hundreds of thousands of forms.
const ALIAS_LIMIT = 6;

export async function build(lang) {
  const SOURCE = join(ROOT, 'data', lang.source);
  const FREQ_FILE = join(ROOT, 'data', lang.freqFile);
  const OUT = join(ROOT, 'extension', lang.out);

  await ensure(SOURCE, lang.sourceUrl);
  await ensure(FREQ_FILE, lang.freqUrl);

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
    const entry = toEntry(row, lang);
    if (!entry) {
      const target = aliasOf(row, lang);
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

  // A word built out of another word points at it, and the popup offers the
  // pointer as a link. A link to a page that is not there is worse than no
  // link, so the ones whose lemma never turned up as an entry of its own are
  // dropped here, while the index still holds headwords and nothing else.
  let pointed = 0;
  for (const entry of entries) {
    if (!entry.b) continue;
    if (index.has(entry.b)) pointed++; else delete entry.b;
  }
  console.log(`  ${pointed} entries point at the word they are built from`);

  // Every inflected form, pointed at the entry it belongs to. These rows were
  // read past above: Wiktionary files "intere" as its own page saying only
  // "feminine plural of intero", which is not a definition and must not
  // become an entry. It is still exactly the fact a reader needs, though, and
  // throwing it away left hundreds of thousands of ordinary forms unfindable,
  // since a suffix-rule deinflector only ever covers the regular ones. So the
  // form earns an index term rather than an entry, resolved after the whole
  // dump has been read because a form is very often filed before its lemma.
  let aliased = 0;
  for (const [form, target] of aliases) {
    const ids = index.get(target);
    if (!ids) continue;                       // a lemma Torval had no use for
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

  const entryChunks = writeChunks(OUT, 'entries', entries);
  const indexChunks = writeChunks(OUT, 'index', [...index.entries()]);
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify({
    // Bumping this makes the extension rebuild this language's database on
    // next start.
    version: lang.version,
    built: new Date().toISOString().slice(0, 10),
    entries: entries.length,
    terms: index.size,
    entryChunks,
    indexChunks,
    source: lang.sourceNote
  }));

  console.log(`  wrote ${entryChunks} entry chunks + ${indexChunks} index chunks ` +
    `to extension/${lang.out}/`);
}

/**
 * One Wiktextract line, converted to Torval's entry shape, or null if it is not
 * a word Torval can use: a line in another language (the dump mixes in the
 * occasional cross-reference), an inflected form or alternative spelling
 * pointing at some other headword rather than defining one of its own
 * (form_of/alt_of, the equivalent of JMdict simply not listing conjugated
 * forms as their own entries), or a part of speech Torval has no use for.
 */
function toEntry(row, lang) {
  if (row.lang_code !== lang.code || !row.word) return null;
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
  // A noun's gender, which is what puts the article on the card. Only
  // common nouns: "il Roma" is not a thing anybody says, so a proper noun
  // is left without one and article.js then has nothing to add. See
  // extension/article.js.
  if (row.pos === 'noun') {
    const gender = genderOf(row);
    if (gender) {
      entry.g = gender.g;
      if (gender.plural) entry.pl = 1;
    }
  }
  // A word that is made out of another word says so, even when it has a
  // meaning of its own. See builtFrom in content.js.
  const from = lemmaIn(row.senses || []);
  if (from && from !== row.word) entry.b = from;
  const stress = lang.stressIndex(row);
  if (stress !== null) entry.st = stress;
  return entry;
}

/**
 * A noun's gender and number, read off its headword template.
 *
 * Wiktionary writes the gender of an Italian or Spanish noun in the
 * template that draws the bold headword line, and kaikki hands those
 * arguments over untouched: {{it-noun|m}} for cane, {{it-noun|f}} for
 * casa, m-p for a word that only exists in the plural (graffiti),
 * mfbysense or m,f for one that is either depending on who it is about
 * (il/la turista). Occasionally a qualifier rides along, "m,f<q:rare>",
 * and is of no interest here.
 *
 * The senses carry the same fact in their tags, but far less cleanly: a
 * row's tags pool every sense's, including the "feminine plural of ..."
 * ones, so a masculine noun with a feminine plural form filed alongside it
 * comes out looking like both. The template says it once and says it about
 * the headword, which is the question being asked.
 *
 * Returns { g: 'm' | 'f' | 'mf', plural } or null when nothing says.
 */
export function genderOf(row) {
  const template = (row.head_templates || [])[0];
  const args = (template && template.args) || {};
  // Some rows name the language and part of speech positionally instead
  // ({{head|it|noun|g=m}}); then the gender, if there is one, is in g.
  const raw = String(args['1'] || '').match(/^[mfnp?]/i) ? args['1'] : (args.g || '');
  if (!raw) return null;

  let masculine = false;
  let feminine = false;
  let plural = false;
  for (const part of String(raw).replace(/<[^>]*>/g, '').split(',')) {
    const bare = part.trim().replace(/-(p|s)$/i, (m) => { if (m === '-p') plural = true; return ''; });
    if (/^(m|mf|mfbysense)$/i.test(bare)) masculine = true;
    if (/^(f|mf|mfbysense)$/i.test(bare)) feminine = true;
    if (/^p$/i.test(bare)) plural = true;
  }
  if (!masculine && !feminine) return null;
  return { g: masculine && feminine ? 'mf' : (masculine ? 'm' : 'f'), plural };
}

/**
 * The word an entry is built out of, if one of its senses names one.
 *
 * Two cases, and this reads the same fact for both. When *every* sense of a
 * row is a pointer, the row is not a word at all and aliasOf sends the whole
 * form to the lemma. When only some are, the row is a real entry with a real
 * definition and is kept, and the pointer in it used to be dropped: "farci"
 * is filed as both "compound of the infinitive fare with ci" and, regionally,
 * "to simulate; to act; to pretend", so it survives as an entry and the popup
 * answered with the definition alone. That is a true answer to a question
 * nobody asked. What a reader meeting farci needs is that it is fare,
 * whatever else it may also be, and the link to fare is exactly what the
 * dropped sense had in it.
 *
 * Wiktionary writes that pointer three ways, in descending order of how much
 * it is data rather than prose:
 *
 *   form_of/alt_of naming one word    "intere" -> intero, "hablando" -> hablar
 *   the sense's own links             the only reliable part of the two below
 *   form_of naming a whole phrase     "decírselo" is filed as a form of
 *                                     "decir combined with indirect object
 *                                     le/les and direct object lo", which is
 *                                     a sentence, not a headword
 *   compound-of                       "capirne" -> capire: an infinitive with
 *                                     its clitics on the end, written as a
 *                                     gloss rather than as a form, so it
 *                                     arrives looking like a definition and
 *                                     then shadows the verb it is made of
 */
function lemmaIn(senses) {
  for (const sense of senses) {
    const of = sense.form_of || sense.alt_of;
    if (!(of && of.length && of[0].word)) continue;
    const word = String(of[0].word);
    if (!/\s/.test(word)) return word;
    // Prose. The links beside it are the same fact as data, and the first
    // one is the headword the prose is about.
    const link = (sense.links || [])[0];
    if (link && link[0]) return String(link[0]);
  }
  for (const sense of senses) {
    if (!(sense.tags || []).includes('compound-of')) continue;
    // The first link on the sense is the verb itself; the gloss is prose,
    // the link is data.
    const link = (sense.links || [])[0];
    if (link && link[0]) return String(link[0]);
  }
  return null;
}

/** The lemma an entry-less row belongs to, or null if it belongs to none. */
function aliasOf(row, lang) {
  if (row.lang_code !== lang.code || !row.word) return null;
  if (!POS_MAP[row.pos]) return null;
  const senses = row.senses || [];
  if (!senses.length) return null;
  return lemmaIn(senses);
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

/**
 * Split an array into files of roughly CHUNK_BYTES each.
 *
 * Bytes, not characters. This counted string length, which is the same
 * number for Latin text and a third of the truth for Japanese, where every
 * kanji is three bytes of UTF-8: a "four megabyte" chunk of JMdict came out
 * at six and a half. That matters beyond tidiness, because the add-on
 * store's validator refuses to parse any file over five megabytes and
 * reports it as an error against the submission.
 */
function writeChunks(out, name, items) {
  let chunk = [];
  let bytes = 0;
  let n = 0;
  const flush = () => {
    if (!chunk.length) return;
    writeFileSync(join(out, `${name}-${String(n).padStart(3, '0')}.json`), JSON.stringify(chunk));
    n++;
    chunk = [];
    bytes = 0;
  };
  for (const item of items) {
    const json = JSON.stringify(item);
    const width = Buffer.byteLength(json, 'utf8');
    if (bytes + width > CHUNK_BYTES) flush();
    chunk.push(item);
    bytes += width + 1;
  }
  flush();
  return n;
}
