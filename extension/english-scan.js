/*
 * Torval, how far an English word can run
 *
 * scan.js's counterpart for English, and the same reasoning as
 * italian-scan.js: English already puts spaces between words, so this only
 * has to be at least as long as the longest ordinary word plus whatever
 * can be stuck on the end of it.
 *
 * What runs longest in ordinary English is a built-up noun rather than a
 * verb: "responsibilities" is 16, "internationalisation" is 20. 24 leaves
 * room for those plus a contraction on the end without being so generous
 * that a run-on stretch of unspaced text gets read as one word.
 */

var TorvalEnglishMaxScan = 24;

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalEnglishMaxScan;
