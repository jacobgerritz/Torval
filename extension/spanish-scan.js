/*
 * Torval, how far a Spanish word can run
 *
 * scan.js's counterpart for Spanish, and the same reasoning as
 * italian-scan.js: Spanish already puts spaces between words, so this only
 * has to be at least as long as the longest ordinary word plus whatever can
 * be stuck on the end of it.
 *
 * What runs longest in ordinary Spanish is not a noun but a verb wearing its
 * pronouns: devolviéndoselo is 16, and an -mente adverb built on a long
 * adjective (desafortunadamente, 18) goes further. 28 leaves room for both
 * without being so generous that a run-on stretch of unspaced text gets
 * treated as one "word" by mistake.
 */

var TorvalSpanishMaxScan = 28;

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalSpanishMaxScan;
