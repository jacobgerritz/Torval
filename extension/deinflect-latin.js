/*
 * Torval, the deinflection engine the Latin-script languages share
 *
 * deinflect.js is Japanese all the way down: its rule table and the solver
 * that walks it grew up together. Italian and Spanish want the same solver
 * and nothing else of it, so the solver lives here on its own and each
 * language brings only its rules.
 *
 * What a rule is: an ending to take off, an ending to put on in its place,
 * the word types the result could be, and what to call the step in the
 * popup's "why". `from` is matched against the end of the word, so a rule is
 * indexed by that ending and only the handful of rules whose ending actually
 * matches are ever tried.
 *
 * What the solver does: breadth-first from the word as it was typed, one
 * rule at a time, keeping every intermediate result, because the dictionary,
 * not the rule table, is what finally decides which guess was right. A rule
 * that turns "parlavamo" into "parlare" has no idea whether parlare is a
 * word; it only has to be the sort of thing Italian does. This is the same
 * bargain deinflect.js strikes, and the reason both tables can propose rival
 * readings of the same ending without having to tell them apart in advance.
 *
 * `tin` is what the rule requires the word to be already, and an empty one
 * means "only the word exactly as it appeared in the text", never a second
 * step chained onto an already-typed intermediate result. Both Romance
 * tables use empty `tin` throughout: their core tenses are each one step
 * from the surface form, so nothing in them needs to chain. The machinery
 * for chaining is here anyway, because it costs four lines and the first
 * table that needs it should not have to grow a solver of its own.
 */

var TorvalDeinflectLatin = (function () {
  'use strict';

  var MAX_DEPTH = 4;
  var MAX_RESULTS = 200;
  var MAX_LENGTH = 40;   // no real word is reached by growing past this

  /**
   * A deinflector over one language's rules, with the same shape
   * deinflect.js exposes: { deinflect, rules, matches }.
   *
   * `add(from, to, tin, tout, name)` is handed to the table so a language
   * file reads as a list of rules rather than as a list of object literals.
   */
  function build(describe) {
    var rules = [];
    describe(function add(from, to, tin, tout, name) {
      rules.push({ from: from, to: to, tin: tin, tout: tout, name: name });
    });

    // Indexed by ending, so a word only ever tries the rules that could
    // apply to it.
    var byEnding = new Map();
    rules.forEach(function (r) {
      r.tkey = ' ' + r.tout.join(',');
      var list = byEnding.get(r.from);
      if (!list) { list = []; byEnding.set(r.from, list); }
      list.push(r);
    });
    var longest = 0;
    byEnding.forEach(function (_, ending) {
      if (ending.length > longest) longest = ending.length;
    });

    /**
     * Given a word as it appears in text, every plausible dictionary form.
     * The first result is always the word itself, untouched.
     */
    function deinflect(word) {
      var results = [{ term: word, types: null, reasons: [] }];
      var seen = new Set([word + ' *']);

      for (var i = 0; i < results.length && results.length < MAX_RESULTS; i++) {
        var cur = results[i];
        if (cur.reasons.length >= MAX_DEPTH) continue;

        var candidates = [];
        var limit = Math.min(longest, cur.term.length);
        for (var len = 1; len <= limit; len++) {
          var list = byEnding.get(cur.term.slice(cur.term.length - len));
          if (list) candidates = candidates.concat(list);
        }

        for (var j = 0; j < candidates.length; j++) {
          var r = candidates[j];
          if (cur.types !== null && !matches(r.tin, cur.types)) continue;

          var next = cur.term.slice(0, cur.term.length - r.from.length) + r.to;
          if (next.length === 0 || next.length > MAX_LENGTH || next === cur.term) continue;

          var key = next + r.tkey;
          if (seen.has(key)) continue;
          seen.add(key);

          results.push({
            term: next,
            types: r.tout,
            reasons: r.name ? [r.name].concat(cur.reasons) : cur.reasons.slice()
          });
        }
      }
      return results;
    }

    return { deinflect: deinflect, rules: rules, matches: matches };
  }

  function matches(tin, types) {
    for (var i = 0; i < tin.length; i++) {
      if (types.indexOf(tin[i]) !== -1) return true;
    }
    return false;
  }

  return { build: build, matches: matches };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalDeinflectLatin;
