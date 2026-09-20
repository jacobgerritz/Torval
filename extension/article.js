/*
 * Torval, the article a noun is learned with
 *
 * "cane" is half a card. A noun in Italian or Spanish is not learned as a
 * bare spelling, it is learned with its gender, and the way a native speaker
 * carries gender around is not a label reading "masculine" but the article
 * in front of the word: il cane, la casa, l'amico, gli studi, el agua.
 * A card that says only "cane" teaches the word and quietly leaves out the
 * one thing about it you have to know to use it in a sentence.
 *
 * So the article goes on the card, joined to the word. Which article it is
 * is not a lookup, it is a small piece of grammar in each language:
 *
 *   Italian  the definite article agrees with gender and number and then
 *            bends around the sound the word begins with. il cane, but lo
 *            studio, lo zio, lo gnocco, lo iato, and l'amico; i cani, but
 *            gli studi and gli amici. Feminine is simpler: la casa, l'ora,
 *            le case.
 *
 *   Spanish  el/la, los/las, with one wrinkle worth having: a feminine noun
 *            that begins with a stressed a- takes el in the singular (el
 *            agua, el hacha) and las in the plural. Whether that first a is
 *            stressed is already known, the dictionary build works out where
 *            the stress falls and stores it on the entry as `st`, so this
 *            asks that rather than guessing from the spelling.
 *
 * The gender itself comes from the dictionary: tools/wiktextract.mjs reads it
 * off the headword template and stores it on the entry as `g` ('m', 'f' or
 * 'mf'), with `pl` set on the nouns that only exist in the plural. Anything
 * with no `g` on it, every verb, adjective and adverb, every Japanese entry,
 * and every proper noun, gets nothing added: see forEntry.
 */

var TorvalArticle = (function () {
  'use strict';

  // A vowel to an article: h does not count, it is silent in both languages,
  // so l'hotel and el hacha behave exactly as though the h were not there.
  var VOWEL = /^h?[aeiouàáèéêìíîòóôùúû]/i;

  // Italian: an i or a y in front of another vowel is a consonant sound (lo
  // iato, lo yogurt), so it neither elides nor takes il.
  var SEMIVOWEL = /^h?[iy][aeiouàèéìíîòóù]/i;

  /*
   * The Italian masculine words that take lo rather than il: the ones that
   * begin with a consonant cluster the tongue cannot get to from "il".
   * s followed by another consonant (lo studio, lo sbaglio), the clusters
   * gn/pn/ps/pt/ct/mn, and the letters x, y, z and j.
   */
  var LO = /^(s[^aeiouàèéìíîòóùh]|gn|pn|ps|pt|ct|mn|[xyzj])/i;

  /** Italian's definite article for one word, given gender and number. */
  function italian(word, gender, plural) {
    if (gender === 'f') {
      if (plural) return 'le';
      return VOWEL.test(word) && !SEMIVOWEL.test(word) ? 'l’' : 'la';
    }
    var heavy = LO.test(word) || SEMIVOWEL.test(word);
    if (plural) return (heavy || VOWEL.test(word)) ? 'gli' : 'i';
    if (heavy) return 'lo';
    return VOWEL.test(word) ? 'l’' : 'il';
  }

  /**
   * Spanish's definite article.
   *
   * `stress` is the entry's own stressed-vowel index, or null when the
   * dictionary did not work one out. Without it a feminine a-word keeps la,
   * which is the ordinary answer and wrong only for the handful of words
   * where the a is stressed: guessing the other way round would put el in
   * front of every one of the far more numerous unstressed ones (la abeja,
   * la amiga).
   */
  function spanish(word, gender, plural, stress) {
    if (gender === 'f') {
      if (plural) return 'las';
      return stressedA(word, stress) ? 'el' : 'la';
    }
    return plural ? 'los' : 'el';
  }

  /** Does this word open on a stressed a, whether or not an h comes first? */
  function stressedA(word, stress) {
    var at = /^h/i.test(word) ? 1 : 0;
    if (!/^[aá]$/i.test(word.charAt(at))) return false;
    // An á is stressed by definition; anything else has to be told.
    if (/á/i.test(word.charAt(at))) return true;
    return stress === at;
  }

  /**
   * The article for one word, or '' when the language has none to give.
   *
   * A word of two genders, "il/la turista", is written as both, since that
   * is the fact about it, and the two collapse into one where they come out
   * the same anyway (l'insegnante).
   */
  function forWord(code, word, gender, plural, stress) {
    if (!word || !gender) return '';
    var article = code === 'it' ? italian : (code === 'es' ? spanish : null);
    if (!article) return '';
    if (gender !== 'mf') return article(word, gender, plural, stress);
    var masculine = article(word, 'm', plural, stress);
    var feminine = article(word, 'f', plural, stress);
    return masculine === feminine ? masculine : masculine + '/' + feminine;
  }

  /** The article for a dictionary entry, or '' if it is not an article's word. */
  function forEntry(entry, word) {
    if (!entry || !entry.g) return '';
    var profile = typeof TorvalLang !== 'undefined' ? TorvalLang.profile() : null;
    if (!profile) return '';
    var stress = typeof entry.st === 'number' ? entry.st : null;
    return forWord(profile.code, word || (entry.k && entry.k[0]), entry.g, !!entry.pl, stress);
  }

  /**
   * The word as it goes on the card: "il cane", "l’amico", "el agua".
   *
   * An elided article is written against the word with nothing between them,
   * which is how the language writes it; every other article takes a space.
   */
  function join(article, word) {
    if (!article) return word;
    return /[’']$/.test(article) ? article + word : article + ' ' + word;
  }

  function withArticle(word, entry) {
    return join(forEntry(entry, word), word);
  }

  return {
    forWord: forWord,
    forEntry: forEntry,
    join: join,
    withArticle: withArticle
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalArticle;
