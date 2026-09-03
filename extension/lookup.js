/*
 * LLL — lookup
 *
 * Japanese does not put spaces between words, so we never actually know where
 * the word under the cursor ends. Instead we take the text starting at the
 * cursor and try every length, longest first:
 *
 *     "日本語を勉強する"  ->  日本語を勉強す, 日本語を勉強, ... 日本語, 日本, 日
 *
 * Each of those is run through the deinflector and looked up. Whatever survives
 * is grouped by how many characters it consumed. The longest surviving match is
 * almost always the word the reader meant, which is why it goes at the top.
 *
 * `db` is anything with an async getEntries(terms) returning Map<term, entry[]>.
 * The extension backs it with IndexedDB; the test suite backs it with a plain
 * Map, so both exercise exactly this code.
 */

// In the extension deinflect.js is loaded first and this is already a global;
// under Node (the test suite) we pull it in ourselves.
if (typeof LLLDeinflect === 'undefined' && typeof require !== 'undefined') {
  var LLLDeinflect = require('./deinflect.js');
}

var LLLLookup = (function () {
  'use strict';

  var MAX_SCAN = 16;      // longest span of text we will try to match
  var MAX_GROUPS = 6;     // distinct lengths shown (1 expanded + the rest collapsed)
  var MAX_PER_GROUP = 4;  // homographs shown for a single length

  async function search(text, db) {
    if (!text) return [];

    // Collect every dictionary form worth asking about, remembering which
    // lengths of the original text each one could have come from.
    var byTerm = new Map();
    var scan = Math.min(text.length, MAX_SCAN);
    for (var len = scan; len >= 1; len--) {
      var candidates = LLLDeinflect.deinflect(text.slice(0, len));
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        var list = byTerm.get(c.term);
        if (!list) { list = []; byTerm.set(c.term, list); }
        list.push({ length: len, types: c.types, reasons: c.reasons });
      }
    }

    // One database round trip for all of them.
    var found = await db.getEntries(Array.from(byTerm.keys()));

    // length -> (entry id -> hit)
    var groups = new Map();
    found.forEach(function (entries, term) {
      var infos = byTerm.get(term);
      for (var a = 0; a < entries.length; a++) {
        var entry = entries[a];
        for (var b = 0; b < infos.length; b++) {
          var info = infos[b];
          if (!typesAllow(entry, info.types)) continue;

          var group = groups.get(info.length);
          if (!group) { group = new Map(); groups.set(info.length, group); }

          var existing = group.get(entry.id);
          // Prefer the explanation that needed the fewest steps — 食べた is
          // "past", not "past of the potential form of a verb that also exists".
          if (!existing || info.reasons.length < existing.reasons.length) {
            group.set(entry.id, Object.assign(
              { entry: entry, reasons: info.reasons, matched: term },
              displayForm(entry, term)));
          }
        }
      }
    });

    // Longest first, and each dictionary entry only once. Without that last
    // rule, hovering 勉強しています would list 勉強 four times over — once for
    // 勉強しています, 勉強してい, 勉強して and 勉強し — which is noise, not choice.
    // What the shorter matches are for is genuinely different words: 日本 sitting
    // under 日本語.
    var used = new Set();
    var out = [];
    var lengths = Array.from(groups.keys()).sort(function (a, b) { return b - a; });

    for (var g = 0; g < lengths.length && out.length < MAX_GROUPS; g++) {
      var hits = Array.from(groups.get(lengths[g]).values())
        .filter(function (hit) { return !used.has(hit.entry.id); })
        .sort(byRelevance)
        .slice(0, MAX_PER_GROUP);
      if (!hits.length) continue;
      hits.forEach(function (hit) { used.add(hit.entry.id); });
      out.push({ length: lengths[g], surface: text.slice(0, lengths[g]), hits: hits });
    }
    return out;
  }

  /**
   * The deinflector guesses what kind of word something must be; this checks the
   * dictionary agrees. Without it, 「少ない」 would happily "deinflect" to the
   * non-existent ichidan verb 「少る」 and 「見る」 would match half the language.
   */
  function typesAllow(entry, types) {
    if (types === null) return true;
    for (var i = 0; i < entry.s.length; i++) {
      var pos = entry.s[i].p;
      for (var j = 0; j < pos.length; j++) {
        if (types.indexOf(pos[j]) !== -1) return true;
      }
    }
    return false;
  }

  /**
   * How this entry should be named on screen: the spelling and the reading.
   *
   * Worked out here rather than in the popup so that everything downstream —
   * what you read, what the pitch accent is looked up under, what lands on the
   * card — agrees on what the word is.
   *
   * An entry lists all its spellings, and printing the first is misleading: 本
   * also reads もと, and that entry leads with 元, so pointing at 本 would put a
   * kanji on screen you were not looking at. Only the first `kv` spellings are
   * fit to show at all — JMdict files some purely so searches find them, like
   * ます under 〼 — and where none is, the kana is the word.
   */
  function displayForm(entry, matched) {
    // kv absent means data built before the field existed; showing every
    // spelling is what it used to do, and is far better than the alternative
    // reading of "kv is 0, so this word has no spelling and no reading".
    var limit = typeof entry.kv === 'number' ? entry.kv : entry.k.length;
    var showable = entry.k.slice(0, limit);
    var isKanji = showable.indexOf(matched) !== -1;
    return {
      word: isKanji ? matched : (showable[0] || matched),
      reading: isKanji ? entry.r[0] : (showable.length ? matched : '')
    };
  }

  function byRelevance(a, b) {
    // Uninflected first, then words actually spelled the way the page spells
    // them, then common words, then dictionary order.
    if (a.reasons.length !== b.reasons.length) return a.reasons.length - b.reasons.length;
    var aw = spellingRank(a), bw = spellingRank(b);
    if (aw !== bw) return aw - bw;
    var af = isFunctionWord(a), bf = isFunctionWord(b);
    if (af !== bf) return af ? -1 : 1;
    // A real frequency rank beats JMdict's own priority markers, which are
    // coarse bands covering only the commonest 24,000 words. Entries the
    // frequency list has never heard of sort last, which is about right.
    var aq = a.entry.q || Infinity, bq = b.entry.q || Infinity;
    if (aq !== bq) return aq - bq;
    if (a.entry.f !== b.entry.f) return b.entry.f - a.entry.f;
    return a.entry.id - b.entry.id;
  }

  /**
   * How well does this entry account for the text as it is actually written?
   * Lower is better.
   *
   *   0  it is written exactly this way, or is never written any other way
   *   1  this is one of its spellings, or it is normally written in kana
   *   2  we only reached it through its reading
   *
   * Hovering は should find the topic particle first, not 葉 and 歯 and 羽 — those
   * are merely *pronounced* は. JMdict's frequency markers do not save you here:
   * the commonest function words often carry no marker at all, so they sink
   * below every kanji word that happens to share their sound.
   *
   * The middle tier matters as much as the top one. 本 also reads もと, and the
   * もと entry is led by a different kanji (元) — so both entries are spelled 本,
   * but only one of them is *chiefly* spelled 本, and that is the one you meant.
   */
  function spellingRank(hit) {
    var entry = hit.entry;
    // entry.kv counts the spellings fit to display; a word whose only kanji is
    // a search-only form (ます, written 〼) is a kana word for our purposes.
    if (!entry.kv || entry.k[0] === hit.matched) return 0;
    if (entry.k.indexOf(hit.matched) !== -1) return 1;
    // Words normally written in kana anyway (JMdict tags them "uk") are not
    // being misread when they turn up spelled in kana.
    for (var i = 0; i < entry.s.length; i++) {
      if (entry.s[i].m && entry.s[i].m.indexOf('uk') !== -1) return 1;
    }
    return 2;
  }

  var KANA = /^[ぁ-ゟァ-ヿー]+$/;
  var FUNCTION_POS = ['prt', 'conj', 'aux', 'aux-v', 'aux-adj', 'cop'];

  /**
   * Is this a particle or other piece of grammar, matched as bare kana?
   *
   * Frequency alone gets の wrong. The possessive particle is listed under the
   * kanji 乃, which nobody writes, and JMdict scores it well below 野 ("field")
   * — so the commonest word in the language loses to a rare noun that merely
   * sounds the same. But particles are *always* written in kana, and a content
   * word almost never is, so kana plus a grammatical part of speech is a strong
   * enough signal to rank on. Point at the kanji 野 itself and this does not
   * apply, so 野 still wins there.
   */
  function isFunctionWord(hit) {
    if (!KANA.test(hit.matched)) return false;
    for (var i = 0; i < hit.entry.s.length; i++) {
      var pos = hit.entry.s[i].p;
      for (var j = 0; j < pos.length; j++) {
        if (FUNCTION_POS.indexOf(pos[j]) !== -1) return true;
      }
    }
    return false;
  }

  return { search: search, displayForm: displayForm, MAX_SCAN: MAX_SCAN };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LLLLookup;
