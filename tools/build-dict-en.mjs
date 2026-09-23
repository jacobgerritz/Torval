/*
 * Torval, English dictionary build step
 *
 * The other three builds read the English Wiktionary, which defines
 * Japanese, Italian and Spanish for an English speaker. This one reads the
 * Spanish Wiktionary, which defines English for a Spanish speaker, which
 * is the whole point of it: somebody learning English out of Spanish needs
 * the glosses in Spanish.
 *
 *   node tools/build-dict-en.mjs
 *
 * Downloads data/wiktextract-en.jsonl.gz (about 46 MB uncompressed, and
 * published uncompressed, so it is gzipped on the way in) and two frequency
 * lists.
 *
 * It is a smaller dictionary than the others, because the Spanish
 * Wiktionary has written up far fewer English words than the English
 * Wiktionary has written up Spanish ones. That matters less than the
 * number suggests: what it does cover is the common vocabulary, which is
 * most of what anybody actually reads. Where an entry is missing, the word
 * is simply not marked, which is the same thing that happens to a name.
 *
 * No stress marking and no recordings, see the profile in lang.js.
 */

import { build } from './wiktextract.mjs';

await build({
  code: 'en',
  name: 'English',
  source: 'wiktextract-en.jsonl.gz',
  sourceUrl: 'https://kaikki.org/eswiktionary/Ingl%C3%A9s/kaikki.org-dictionary-Ingl%C3%A9s.jsonl',
  freqFile: 'en-frequency.txt',
  freqUrl: 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_full.txt',
  writtenFile: 'enwiki-frequency.tsv',
  writtenUrl: 'https://raw.githubusercontent.com/adno/wikipedia-word-frequency-clean/main/results/enwiki-frequency-20221020-lower.tsv.xz',
  out: 'data-en',
  // Bumping this makes the extension rebuild its English database on next start.
  version: 1,
  sourceNote: 'Wiktextract (kaikki.org), from the Spanish Wiktionary, CC BY-SA 4.0; ' +
    'word frequency from hermitdave/FrequencyWords (OpenSubtitles), MIT, ' +
    'and Wikipedia word frequency (adno/wikipedia-word-frequency-clean), CC BY-SA 4.0',
  // English spelling does not say where the stress falls, so unlike Spanish
  // there is nothing to work out from the word itself.
  stressIndex: () => null
});
