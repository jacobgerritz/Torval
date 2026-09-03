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
            group.set(entry.id, { entry: entry, reasons: info.reasons, matched: term });
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

  function byRelevance(a, b) {
    // Uninflected readings first, then common words, then dictionary order.
    if (a.reasons.length !== b.reasons.length) return a.reasons.length - b.reasons.length;
    if (a.entry.f !== b.entry.f) return b.entry.f - a.entry.f;
    return a.entry.id - b.entry.id;
  }

  return { search: search, MAX_SCAN: MAX_SCAN };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LLLLookup;
