/*
 * Torval, what counts as English
 *
 * Latin letters and the two apostrophes, straight and curly. The
 * apostrophe is in because English writes "don't" and "the dog's" as one
 * word each: leaving it out would cut them in half and hand the dictionary
 * "don" and "dog", which are both real words and both the wrong answer.
 * deinflect-en.js takes the tail off afterwards.
 *
 * Accented letters are in as well, for the borrowed words English never
 * quite naturalised: café, naïve, résumé. A reader hovering one of those
 * wants the whole word, not the part before the accent.
 *
 * No /g flag, for the same reason japanese.js has none: a global regex
 * remembers where it last matched, and two callers sharing one would
 * answer differently depending on who asked first.
 */

var TorvalEnglish = /[A-Za-zÀ-ÖØ-öø-ÿ'’]/;

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalEnglish;
