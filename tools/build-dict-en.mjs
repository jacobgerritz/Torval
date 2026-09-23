/*
 * Torval, English dictionary build step
 *
 * The other three builds read the English Wiktionary, which defines
 * Japanese, Italian and Spanish for an English speaker. English cannot
 * work that way, because the reader here is the one who does not have
 * English, so this build reads two dumps and puts them together.
 *
 *   The English Wiktionary's English entries are the word list. Millions
 *   of them, with the inflected forms that make a deinflector unnecessary
 *   for the irregular half of the language.
 *
 *   The Spanish Wiktionary's English entries are the definitions, in
 *   Spanish, for the twenty thousand or so words it has written up.
 *
 * A word with a Spanish definition gets it. A word without one keeps its
 * English definition, which for somebody already reading English is a real
 * answer rather than a gap: "chaotic: in a state of chaos" tells you what
 * you needed. That is what makes the dictionary usable at a level where
 * the interesting words are the uncommon ones.
 *
 *   node tools/build-dict-en.mjs
 *
 * Downloads about 550 MB the first time, and keeps it in data/ so a
 * rebuild does not fetch it again.
 *
 * No stress marking and no recordings, see the profile in lang.js.
 */

import { build } from './wiktextract.mjs';
import { glossesEnEs } from './glosses-en-es.mjs';

await build({
  code: 'en',
  name: 'English',
  source: 'wiktextract-en.jsonl.gz',
  sourceUrl: 'https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl.gz',
  // What an English word means in Spanish, assembled from three sources.
  // See tools/glosses-en-es.mjs.
  glosses: glossesEnEs,
  // One and a half million entries, most of them words nobody meets. See
  // the note beside rankLimit in wiktextract.mjs for where the line is and
  // why it is there.
  rankLimit: 150000,
  freqFile: 'en-frequency.txt',
  freqUrl: 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_full.txt',
  writtenFile: 'enwiki-frequency.tsv',
  writtenUrl: 'https://raw.githubusercontent.com/adno/wikipedia-word-frequency-clean/main/results/enwiki-frequency-20221020-lower.tsv.xz',
  out: 'data-en',
  // Bumping this makes the extension rebuild its English database on next start.
  version: 3,
  sourceNote: 'Wiktextract (kaikki.org), from the English and Spanish Wiktionaries, ' +
    'CC BY-SA 4.0; word frequency from hermitdave/FrequencyWords (OpenSubtitles), MIT, ' +
    'and Wikipedia word frequency (adno/wikipedia-word-frequency-clean), CC BY-SA 4.0',
  // English spelling does not say where the stress falls, so unlike Spanish
  // there is nothing to work out from the word itself.
  stressIndex: () => null
});
