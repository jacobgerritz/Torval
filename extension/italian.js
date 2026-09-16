/*
 * LLL, what counts as Italian
 *
 * Latin letters, the accented vowels Italian actually uses (à, è, é, ì, ò, ù,
 * and the rarer î/ó/ú some spellings still carry), and the apostrophe that
 * marks elision: l'amico, dell'acqua, po'. Both the straight and the curly
 * apostrophe are included, since ordinary web text uses either.
 *
 * Unlike japanese.js, this is not trying to spot where a word could start in
 * an unbroken stream of script, Italian already puts spaces between words.
 * It only answers "is this character part of a word at all", so the same
 * span-gathering code in content.js that grows outward from the cursor for
 * Japanese also works here, and naturally stops at the next space or
 * punctuation mark rather than needing separate logic.
 *
 * No /g flag, for the same reason japanese.js has none: a global regex
 * remembers where it last matched, and two callers sharing one would answer
 * differently depending on who asked first.
 */

var LLLItalian = /[A-Za-zÀ-ÖØ-öø-ÿ'’]/;

if (typeof module !== 'undefined' && module.exports) module.exports = LLLItalian;
