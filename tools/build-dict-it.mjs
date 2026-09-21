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

// A vowel as Italian writes one, and as the IPA hears one. Up here with
// the others rather than beside stressFromIpa, because build() below runs
// the moment this module is evaluated and a const declared further down
// is not initialised yet when it does.
const SPELLED_VOWEL = /[aeiouàáèéêìíîòóôùúû]/i;
const HEARD_GLIDE = 'jw';
const HEARD_VOWEL = 'aeiouɛɔəɑæøyɨ';

await build({
  code: 'it',
  name: 'Italian',
  source: 'wiktextract-it.jsonl.gz',
  sourceUrl: 'https://kaikki.org/dictionary/Italian/kaikki.org-dictionary-Italian.jsonl.gz',
  freqFile: 'it-frequency.txt',
  freqUrl: 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/it/it_full.txt',
  out: 'data-it',
  // Bumping this makes the extension rebuild its Italian database on next start.
  version: 7,
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
 *   the IPA transcription   /parˈla.re/'s ˈ marks the stressed syllable.
 *                        This is the fallback for the many entries (most
 *                        nouns and adjectives) with no accented canonical
 *                        form, and it is now a proper alignment rather
 *                        than a count. See stressFromIpa.
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

/*
 * Which letter the ˈ in the IPA is pointing at.
 *
 * This used to count syllables from the end of the transcription and then
 * count the same number of vowel clusters back from the end of the
 * spelling. That works whenever the two agree about how many syllables
 * there are, and they often do not, because a written run of vowels can be
 * one spoken syllable or two and the spelling does not say which.
 * "scorciatoia" is the case that showed it: /skor.t͡ʃaˈto.ja/ is four
 * syllables, "oia" is one run of vowels but two of them, so the count came
 * up one short and the mark landed on the first a instead of the second o.
 * The same arithmetic put the stress in the wrong place in sequoia, utopia,
 * panacea, eresia, alopecia and about five thousand others.
 *
 * So the two are lined up against each other instead. Italian spells its
 * vowels one symbol each, so the vowels of the transcription and the vowel
 * letters of the spelling are the same list in the same order, and once
 * they are paired the answer is simply whichever letter the stressed vowel
 * is paired with. Nothing has to be counted, and nothing has to be assumed
 * about syllables at all.
 *
 * The one complication is the i that is not a vowel: in cia, cio, ciu, cie
 * and their g equivalents it is there to soften the consonant and is not
 * pronounced, so it has nothing to pair with. Dropping it is tried first
 * and keeping it second, because the rule has exceptions in both
 * directions, farmacia being one where the i really is a vowel. Whichever
 * reading makes the two lists the same length is the one that has lined
 * up, and if neither does, this declines and the caller guesses.
 */
function stressFromIpa(word, ipa) {
  if (!ipa) return null;
  const heard = heardVowels(ipa);
  if (heard.stressed === -1) return null;
  for (const dropSilentI of [true, false]) {
    const letters = spelledVowels(word, dropSilentI);
    if (letters.length === heard.count) return letters[heard.stressed];
  }
  return null;
}

/**
 * The vowels and glides of a transcription, in order, and which of them
 * carries the stress. The stressed one is the first vowel after the ˈ that
 * is not a glide: /ˈpjɛ.de/ is stressed on the ɛ, not on the j.
 */
function heardVowels(ipa) {
  const clean = ipa.replace(/^[/[]+|[/\]]+$/g, '');
  let count = 0;
  let stressed = -1;
  let after = false;
  for (const ch of clean) {
    if (ch === 'ˈ') { after = true; continue; }
    if (ch === 'ˌ') continue;               // secondary stress is not the question
    const glide = HEARD_GLIDE.includes(ch);
    if (!glide && !HEARD_VOWEL.includes(ch)) continue;
    if (after && !glide && stressed === -1) stressed = count;
    count++;
  }
  return { count, stressed };
}

/** Where each vowel letter is, optionally skipping the silent i of ciao. */
function spelledVowels(word, dropSilentI) {
  const at = [];
  for (let i = 0; i < word.length; i++) {
    if (!SPELLED_VOWEL.test(word[i])) continue;
    if (dropSilentI && word[i].toLowerCase() === 'i') {
      const before = (word[i - 1] || '').toLowerCase();
      const after = (word[i + 1] || '').toLowerCase();
      if ((before === 'c' || before === 'g') && 'aeou'.includes(after)) continue;
    }
    at.push(i);
  }
  return at;
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
