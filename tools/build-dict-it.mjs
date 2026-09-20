/*
 * Torval, Italian dictionary build step
 *
 * build-dict.mjs's counterpart for Italian. Turns a Wiktextract dump of
 * Italian entries (word forms extracted from English Wiktionary by
 * kaikki.org, in the same spirit as JMdict but sourced from Wiktionary
 * rather than EDRDG/Jisho) into the small JSON chunks background.js already
 * knows how to stream into IndexedDB, under extension/data-it/ rather than
 * extension/data/, so switching to Italian never touches what a Japanese
 * install already has imported.
 *
 *   node tools/build-dict-it.mjs
 *
 * Downloads data/wiktextract-it.jsonl.gz (about 75 MB) and
 * data/it-frequency.txt (about 10 MB) if they are not already there.
 *
 * Everything that is not specifically Italian lives in wiktextract.mjs,
 * shared with the Spanish build. What is left here is where the stress
 * falls, which really is Italian's own problem: unlike Spanish, the
 * spelling does not say.
 */

import { build } from './wiktextract.mjs';

// A word letter, accented or not; used to find where the stress falls.
const VOWEL = 'aeiouàèéìòóùAEIOUÀÈÉÌÒÓÙ';
const ACCENTED = 'àèéìòóùÀÈÉÌÒÓÙ';

await build({
  code: 'it',
  name: 'Italian',
  source: 'wiktextract-it.jsonl.gz',
  sourceUrl: 'https://kaikki.org/dictionary/Italian/kaikki.org-dictionary-Italian.jsonl.gz',
  freqFile: 'it-frequency.txt',
  freqUrl: 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/it/it_full.txt',
  out: 'data-it',
  // Bumping this makes the extension rebuild its Italian database on next start.
  version: 5,
  // Where recorded pronunciations come from. The category is walked
  // once at build time; the id and ISO code are the two constants a
  // Lingua Libre filename is built from. See build-audio.mjs.
  voice: { category: 'Lingua Libre pronunciation-ita', qid: 'Q652', iso: 'ita' },
  sourceNote: 'Wiktextract (kaikki.org), from English Wiktionary, CC BY-SA 4.0; ' +
    'word frequency from hermitdave/FrequencyWords (OpenSubtitles), MIT',
  stressIndex
});

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
