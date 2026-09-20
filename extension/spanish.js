/*
 * Torval, what counts as Spanish
 *
 * Latin letters, ñ, the accented vowels (á, é, í, ó, ú) and the ü of
 * vergüenza. The same range italian.js uses, for the same reason: it is
 * every accented Latin letter in one span rather than a list to keep in step
 * with, and a stray accent from a borrowed word is better read as part of
 * the word than as a break in it.
 *
 * Unlike italian.js there is no apostrophe here. Italian needs one because
 * elision glues two words together with it (l'amico); Spanish does not
 * elide, it contracts into whole words instead (de + el = del, a + el = al),
 * which are ordinary dictionary entries and need no splitting. An apostrophe
 * in Spanish text is a quotation mark, and letting it into a word would glue
 * a quoted word to its punctuation.
 *
 * ¿ and ¡ are deliberately out, the same as any other punctuation: they mark
 * where a question begins, not where a word does.
 *
 * No /g flag, for the same reason japanese.js has none: a global regex
 * remembers where it last matched, and two callers sharing one would answer
 * differently depending on who asked first.
 */

var TorvalSpanish = /[A-Za-zÀ-ÖØ-öø-ÿ]/;

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalSpanish;
