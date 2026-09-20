/*
 * Torval, how far a word can run
 *
 * The longest span of text worth trying as a single word: long enough to
 * cover an ordinary conjugated verb or compound, short enough to keep scanning
 * cheap. content.js uses this to decide how much text to gather around the
 * cursor before asking about it; lookup.js uses the very same number to decide
 * how far back to try deinflecting from a given starting point.
 *
 * The two have to agree. If content.js ever gathered less than lookup.js might
 * try to match, a long word could be cut short at the edge of what was sent,
 * and nothing would say so, it would just quietly answer with the wrong,
 * shorter word. Written down once, here, for the same reason japanese.js is
 * its own file: more than one part of Torval has to give the same answer.
 */

var TorvalMaxScan = 16;

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalMaxScan;
