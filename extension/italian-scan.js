/*
 * Torval, how far an Italian word can run
 *
 * scan.js's counterpart for Italian. Japanese needs a scan window because it
 * has to try every possible word boundary in an unbroken stream of script;
 * Italian already has spaces, so this only has to be at least as long as the
 * longest ordinary word plus its longest conjugated ending, not tuned for
 * cost the way MAX_SCAN is.
 *
 * responsabilizzazione is 20 characters; 28 leaves comfortable room for a
 * long adverb (gentilmente-style -mente formations run long) without being
 * so generous that a run-on stretch of unspaced text gets treated as one
 * "word" by mistake.
 */

var TorvalItalianMaxScan = 28;

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalItalianMaxScan;
