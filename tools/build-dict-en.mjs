/*
 * Torval, English dictionary build step
 *
 * English explained in English: a monolingual dictionary, for a reader
 * who is far enough along to stop translating. The other three builds
 * read the same dump for the language they explain, so this one is the
 * same job pointed at the English entries.
 *
 * It can also carry a Spanish definition on each entry, for a Spanish
 * speaker learning English. That is built by tools/glosses-en-es.mjs and
 * handed to the `glosses` hook below, both of which live on the
 * `english-for-spanish` branch along with the interface to read them in.
 *
 *   node tools/build-dict-en.mjs
 *
 * Downloads about 500 MB the first time, and keeps it in data/ so a
 * rebuild does not fetch it again.
 *
 * No stress marking and no recordings, see the profile in lang.js.
 */

import { build } from './wiktextract.mjs';

await build({
  code: 'en',
  name: 'English',
  source: 'wiktextract-en.jsonl.gz',
  sourceUrl: 'https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl.gz',
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
  version: 5,
  sourceNote: 'Wiktextract (kaikki.org), from the English Wiktionary, ' +
    'CC BY-SA 4.0; word frequency from hermitdave/FrequencyWords (OpenSubtitles), MIT, ' +
    'and Wikipedia word frequency (adno/wikipedia-word-frequency-clean), CC BY-SA 4.0',
  // English spelling does not say where the stress falls, so unlike Spanish
  // there is nothing to work out from the word itself.
  stressIndex: () => null
});
