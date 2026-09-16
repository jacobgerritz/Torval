/*
 * LLL, Italian word stress
 *
 * Italian has no lexical pitch accent the way Japanese does, just stress:
 * one syllable in every word is said louder and a little longer than the
 * rest. Usually that falls on the next-to-last syllable, but not always, and
 * it can be the only thing distinguishing two otherwise identical words:
 * ancora ("still/yet", stressed an-CO-ra) against àncora ("anchor",
 * stressed AN-co-ra).
 *
 * Unlike pitch.js, this needs no diagram and no lookup file of its own: the
 * stressed vowel's position is worked out once, at dictionary build time
 * (tools/build-dict-it.mjs, from the entry's IPA transcription where
 * Wiktextract provides one, else a penultimate-syllable guess), and stored
 * right on the entry as `st`, a character index into its spelling. This
 * module's only job is turning that index into something to show: the
 * stressed vowel wrapped in <b>, both for the popup and for the Anki field.
 */

var LLLStressIt = (function () {
  'use strict';

  /** The stressed vowel's character index in the entry's spelling, or null. */
  function indexFor(entry) {
    return entry && typeof entry.st === 'number' ? entry.st : null;
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** `word` with the character at `index` wrapped in <b>, or plain `word`. */
  function mark(word, index) {
    if (index === null || index === undefined || index < 0 || index >= word.length) {
      return escapeHtml(word);
    }
    return escapeHtml(word.slice(0, index)) + '<b>' + escapeHtml(word.charAt(index)) + '</b>' +
      escapeHtml(word.slice(index + 1));
  }

  /** The marked-up word for one lookup hit, or '' when stress is unknown. */
  function markFor(hit) {
    if (!hit) return '';
    var index = indexFor(hit.entry);
    if (index === null) return '';
    return mark(hit.word, index);
  }

  /** The finished Anki field contents for a word and its entry. */
  function graphFor(word, entry) {
    var index = indexFor(entry);
    if (index === null) return '';
    return mark(word, index);
  }

  return { indexFor: indexFor, mark: mark, markFor: markFor, graphFor: graphFor };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LLLStressIt;
