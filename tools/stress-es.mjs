/*
 * Torval, where the stress falls in a Spanish word
 *
 * Spanish is the easy one. Italian has to be told where its stress is,
 * because its spelling does not say and tools/build-dict-it.mjs has to read
 * it off a pronunciation or guess. Spanish spelling says, every time, in
 * three rules that have no exceptions:
 *
 *   a written accent wins outright                canción, árbol, reír
 *   otherwise, a word ending in a vowel, n or s
 *   is stressed on the next-to-last syllable      casa, joven, hablas
 *   otherwise, on the last                        hablar, ciudad, feliz
 *
 * That is the whole of it, and it is a definition rather than a heuristic:
 * the accent is written exactly when the first two rules would disagree.
 * So nothing here consults a pronunciation, and unlike the Italian build
 * there is no guess to fall back on and no ordinary word whose stress is
 * unknown.
 *
 * The work that is left is not knowing the rule but counting syllables,
 * which Spanish spelling also settles: two vowels are one syllable when at
 * least one of them is an unaccented i or u (bue-no, ciu-dad), and two
 * otherwise (ca-er, le-al). See nuclei() below.
 *
 * Its own file, apart from the build that uses it, so the test suite can ask
 * it about a word without building a dictionary to do so.
 */

const STRONG = 'aeoáéó';
const WEAK = 'iuü';
const ACCENTED = 'áéíóú';
const VOWEL = STRONG + WEAK + ACCENTED;

/**
 * Where the stress falls, as a character index into the word: which letter
 * to print in bold. Null only for something with no vowel in it at all.
 */
export function stressIndex(row) {
  const word = typeof row === 'string' ? row : row.word;
  if (!word) return null;
  // A dictionary headword can be a phrase ("dar a luz"); one bold letter is
  // not a useful thing to say about a phrase.
  if (/\s/.test(word)) return null;

  const lower = word.toLowerCase();
  const groups = nuclei(lower);
  if (!groups.length) return null;

  // A written accent is the answer wherever it is.
  for (const group of groups) {
    for (const at of group) if (ACCENTED.includes(lower[at])) return at;
  }

  const last = lower[lower.length - 1];
  const penultimate = VOWEL.includes(last) || last === 'n' || last === 's';
  const group = groups[groups.length - (penultimate && groups.length > 1 ? 2 : 1)];
  return loudest(lower, group);
}

/**
 * The letter in one syllable's vowels that carries the sound: the strong
 * vowel of a diphthong (bue-no is the e, ai-re is the a), or, when both are
 * weak, the second of them (ciu-dad is the u).
 */
function loudest(word, group) {
  for (const at of group) if (STRONG.includes(word[at])) return at;
  return group[group.length - 1];
}

/**
 * The syllable nuclei of a word, each as the list of vowel-letter positions
 * that belong to it.
 *
 * Two adjacent vowels are one syllable when at least one is an unaccented
 * weak vowel (i, u, ü): bue-no, ciu-dad, vein-te. They are two when both are
 * strong, or when the weak one carries an accent, which is what the accent
 * on país and reír is there to say. Three can combine the same way
 * (a-ve-ri-guáis).
 *
 * Two letters are not vowels here although they look like them. The u of
 * que, qui, gue and gui is written but not said, which is exactly why ü
 * exists, to say that this one is; and y is a consonant except at the end of
 * a word, where it closes a diphthong (rey, muy) and counts as an i.
 */
function nuclei(word) {
  const groups = [];
  let current = null;

  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    const isFinalY = ch === 'y' && i === word.length - 1;
    if (!VOWEL.includes(ch) && !isFinalY) { current = null; continue; }
    if (silentU(word, i)) { current = null; continue; }

    const weak = isFinalY || (WEAK.includes(ch) && !ACCENTED.includes(ch));
    const previous = current ? word[current[current.length - 1]] : null;
    const previousWeak = previous !== null &&
      WEAK.includes(previous) && !ACCENTED.includes(previous);

    if (current && (weak || previousWeak)) current.push(i);
    else { current = [i]; groups.push(current); }
  }
  return groups;
}

/** The unwritten u of que, qui, gue, gui. */
function silentU(word, i) {
  if (word[i] !== 'u' || i === 0) return false;
  const before = word[i - 1];
  const after = word[i + 1];
  if (before !== 'q' && before !== 'g') return false;
  return after === 'e' || after === 'i' || after === 'é' || after === 'í';
}
