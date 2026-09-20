/*
 * Torval, word stress
 *
 * Neither Italian nor Spanish has lexical pitch accent the way Japanese
 * does, just stress: one syllable in every word is said louder and a little
 * longer than the rest. It can be the only thing distinguishing two
 * otherwise identical words: Italian ancora ("still/yet", an-CO-ra) against
 * àncora ("anchor", AN-co-ra), Spanish hablo ("I speak") against habló ("he
 * spoke").
 *
 * Unlike pitch.js, this needs no diagram and no lookup file of its own: the
 * stressed vowel's position is worked out once, at dictionary build time,
 * and stored right on the entry as `st`, a character index into its
 * spelling. How it is worked out is each language's own business and each
 * language's build does it (tools/build-dict-it.mjs reads a pronunciation or
 * guesses, tools/stress-es.mjs applies a rule with no exceptions in it);
 * by the time anything reaches here the answer is already a number.
 *
 * This module's only job is turning that number into something to show: the
 * stressed vowel wrapped in <b>, both for the popup and for the Anki field.
 */

var TorvalStress = (function () {
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

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalStress;
