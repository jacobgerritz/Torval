/*
 * Torval, what an English word means in Spanish
 *
 * The other three dictionaries are Wiktionary explaining a language to an
 * English speaker, which is one dump and no assembly. English explained to
 * a Spanish speaker is not published anywhere as one file, so it is put
 * together here out of three, in order of how much the source actually
 * knows about the word:
 *
 *   1. The Spanish Wiktionary's English entries. Real definitions, written
 *      in Spanish by people writing for Spanish readers. About 18,000
 *      words, and the best answer wherever there is one.
 *
 *   2. The English Wiktionary's own translation tables. Curated, tied to a
 *      particular sense, and present on maybe a tenth of entries.
 *
 *   3. The English Wiktionary's Spanish entries, read backwards. "casa"
 *      is defined as "house", so "house" is "casa". This is the biggest of
 *      the three by far, 55,000 English words, and the weakest, because a
 *      definition read backwards is an equivalent rather than a
 *      definition: it tells you the Spanish word, not what the English one
 *      means. Only glosses of one or two plain words are inverted, since
 *      inverting a sentence gives nonsense.
 *
 * The file for 3 is the one the Spanish build already downloads, so it
 * costs nothing extra to read.
 *
 * Everything lands in one map of word -> part of speech -> [gloss]. Where
 * two sources both know a word the better one wins outright rather than
 * being merged, because a definition and a bare equivalent read badly
 * stacked together.
 */

import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const POS = {
  verb: 'v', noun: 'n', 'proper noun': 'n', name: 'n', adj: 'adj',
  adv: 'adv', prep: 'prep', conj: 'conj', intj: 'intj', pron: 'pron',
  num: 'num', article: 'art', particle: 'prt', det: 'det'
};

/** Every line of a gzipped .jsonl dump, parsed. */
async function* rows(file) {
  const unzip = createGunzip();
  createReadStream(file).pipe(unzip);
  for await (const line of createInterface({ input: unzip, crlfDelay: Infinity })) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch { /* a truncated line, skip it */ }
  }
}

/*
 * The Spanish Wiktionary writes a definition as a sentence: "Casa." for
 * house, capital letter and full stop. Beside twenty other one-word
 * glosses in a popup that reads as shouting, so the two are brought into
 * line. The capital only goes where the word it defines is itself
 * lowercase, so "Londres" for London keeps its own.
 */
function tidy(gloss) {
  const raw = String(gloss).trim();
  if (!raw) return '';
  const trimmed = raw.replace(/\s*\.$/, '');
  // Several sentences keep their stops; a single phrase loses its last one,
  // which is the shape almost all of them have.
  const text = /[.!?]/.test(trimmed) ? raw : trimmed;
  if (/^[A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]/.test(text)) {
    return text[0].toLowerCase() + text.slice(1);
  }
  return text;
}

/** Put these glosses on this word, unless something better is there. */
function file(map, word, pos, glosses, rank) {
  if (!word || !pos || !glosses.length) return;
  let byPos = map.get(word);
  if (!byPos) { byPos = new Map(); map.set(word, byPos); }
  const already = byPos.get(pos);
  if (already && already.rank <= rank) return;
  byPos.set(pos, { rank, g: glosses.slice(0, 6) });
}

export async function glossesEnEs({ root, ensure }) {
  const map = new Map();

  // --- 1. definitions, from the Spanish Wiktionary -----------------------
  const spanish = join(root, 'data', 'wiktextract-en-es.jsonl.gz');
  await ensure(spanish,
    'https://kaikki.org/eswiktionary/Ingl%C3%A9s/kaikki.org-dictionary-Ingl%C3%A9s.jsonl');
  console.log('Reading', spanish);
  for await (const row of rows(spanish)) {
    const pos = POS[row.pos];
    if (!pos || !row.word) continue;
    const said = [];
    for (const sense of row.senses || []) {
      for (const gloss of sense.glosses || []) {
        const text = tidy(gloss);
        if (text && !said.includes(text)) said.push(text);
      }
    }
    file(map, row.word, pos, said, 1);
  }
  console.log(`  ${map.size} words defined in Spanish`);

  // --- 2. translation tables, from the English Wiktionary ----------------
  // Read in the same pass as the word list would be, except that the word
  // list is read by wiktextract.mjs and this runs before it. Reading the
  // half-gigabyte dump twice costs a minute and keeps the two jobs apart.
  const english = join(root, 'data', 'wiktextract-en.jsonl.gz');
  let translated = 0;
  for await (const row of rows(english)) {
    const pos = POS[row.pos];
    if (!pos || !row.word || !row.translations) continue;
    const said = [];
    for (const one of row.translations) {
      if (one.code !== 'es' || !one.word) continue;
      const text = String(one.word).trim();
      if (text && !said.includes(text)) said.push(text);
    }
    if (!said.length) continue;
    if (!map.has(row.word) || !map.get(row.word).has(pos)) translated++;
    file(map, row.word, pos, said, 2);
  }
  console.log(`  ${translated} more from the English Wiktionary's translation tables`);

  // --- 3. Spanish entries, read backwards --------------------------------
  const backwards = join(root, 'data', 'wiktextract-es.jsonl.gz');
  await ensure(backwards,
    'https://kaikki.org/dictionary/Spanish/kaikki.org-dictionary-Spanish.jsonl.gz');
  let inverted = 0;
  for await (const row of rows(backwards)) {
    const pos = POS[row.pos];
    if (!pos || !row.word) continue;
    for (const sense of row.senses || []) {
      if (sense.form_of || sense.alt_of) continue;
      for (const gloss of sense.glosses || []) {
        const text = String(gloss).trim();
        // One or two plain words only. "a building for human habitation"
        // inverted would file the whole sentence as an English headword.
        if (!text || /[;(),]/.test(text) || text.split(/\s+/).length > 2) continue;
        const key = text.toLowerCase().replace(/^to /, '');
        if (!/^[a-z][a-z' -]*$/.test(key)) continue;
        const had = map.get(key);
        if (had && had.has(pos) && had.get(pos).rank < 3) continue;
        const now = had && had.get(pos);
        const list = now && now.rank === 3 ? now.g.slice() : [];
        if (!list.includes(row.word)) list.push(row.word);
        if (!now) inverted++;
        file(map, key, pos, list, 3);
      }
    }
  }
  console.log(`  ${inverted} more from Spanish entries read backwards`);

  // The ranks were only ever for deciding which source wins. Hand back the
  // plain shape wiktextract.mjs expects.
  const plain = new Map();
  for (const [word, byPos] of map) {
    const out = new Map();
    for (const [pos, held] of byPos) out.set(pos, held.g);
    plain.set(word, out);
  }
  return plain;
}
