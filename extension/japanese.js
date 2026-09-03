/*
 * LLL — what counts as Japanese
 *
 * Hiragana, katakana, kanji, the repeat mark 々 and halfwidth katakana.
 *
 * Four separate parts of LLL need to answer "is this character Japanese":
 * deciding where a word could start under the cursor, reading a passage end to
 * end, working out which text on a page is worth marking, and skipping over
 * everything else. They must all answer it the same way — a character one of
 * them counts and another does not is a word that can be looked up but never
 * marked, or measured but never found. So it is written down once, here, in a
 * file small enough to load everywhere it is needed.
 *
 * No /g flag on purpose: a global regex remembers where it last matched, and
 * one shared between callers would give different answers depending on who
 * asked last.
 */

var LLLJapanese = /[々〆぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾝ]/;

if (typeof module !== 'undefined' && module.exports) module.exports = LLLJapanese;
