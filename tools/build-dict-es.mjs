/*
 * Torval, Spanish dictionary build step
 *
 * build-dict-it.mjs's counterpart for Spanish, and the same source: the
 * Wiktextract dump of Spanish entries extracted from English Wiktionary by
 * kaikki.org. Everything shared with the Italian build lives in
 * wiktextract.mjs, and where the stress falls lives in stress-es.mjs, so
 * what is left here is which dump to read and where to put it.
 *
 *   node tools/build-dict-es.mjs
 *
 * Downloads data/wiktextract-es.jsonl.gz (about 90 MB) and
 * data/es-frequency.txt (about 15 MB) if they are not already there.
 */

import { build } from './wiktextract.mjs';
import { stressIndex } from './stress-es.mjs';

await build({
  code: 'es',
  name: 'Spanish',
  source: 'wiktextract-es.jsonl.gz',
  sourceUrl: 'https://kaikki.org/dictionary/Spanish/kaikki.org-dictionary-Spanish.jsonl.gz',
  freqFile: 'es-frequency.txt',
  freqUrl: 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/es/es_full.txt',
  out: 'data-es',
  // Bumping this makes the extension rebuild its Spanish database on next start.
  version: 3,
  // Where recorded pronunciations come from. The category is walked
  // once at build time; the id and ISO code are the two constants a
  // Lingua Libre filename is built from. See build-audio.mjs.
  voice: { category: 'Lingua Libre pronunciation-spa', qid: 'Q1321', iso: 'spa' },
  sourceNote: 'Wiktextract (kaikki.org), from English Wiktionary, CC BY-SA 4.0; ' +
    'word frequency from hermitdave/FrequencyWords (OpenSubtitles), MIT',
  stressIndex
});
