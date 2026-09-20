/*
 * Torval, dictionary-lookup logic shared across languages
 *
 * Segmenting text into words is different for every language Torval supports:
 * Japanese has no spaces and needs the Viterbi-style run solver in
 * lookup.js, Italian just needs to split on whitespace and punctuation (see
 * lookup-latin.js). But once a word has been found, working out how it ranks,
 * whether it counts as "known", and how much of a passage is understood is
 * exactly the same problem either way: these functions all operate on
 * whatever shape `db.getEntries` hands back (`{ k, r, s, f, q, qm }`, the
 * same fields JMdict-derived and Wiktextract-derived entries both carry) and
 * on the `{ word, start, length, words, expression }` token shape `segment`
 * produces, never on any language-specific script or grammar.
 *
 * Where a function needs a piece of language-specific behaviour, that piece
 * is passed in rather than hardcoded, `search` for decomposeKnown and
 * `segment` for locateTokens/extractTokens/extractWords, so this file has no
 * dependency on either lookup.js or lookup-latin.js and can be required by
 * both.
 */

var TorvalLookupCommon = (function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Ranking entries
  // -------------------------------------------------------------------------

  /**
   * How common this entry is when it is written the way the page writes it.
   * See lookup.js's own copy of this comment for the full rationale (the qm
   * override for entries with more than one spelling); this is that same
   * logic, and applies unchanged to any entry shaped like one.
   */
  function rankOf(entry, matched) {
    if (entry.qm && Object.prototype.hasOwnProperty.call(entry.qm, matched)) {
      return entry.qm[matched];
    }
    return entry.q || 0;
  }

  /** The frequency rank of the commonest entry in a group of matches. */
  function bestQ(group) {
    var best = Infinity;
    group.forEach(function (hit) {
      var q = hit.q || Infinity;
      if (q < best) best = q;
    });
    return best;
  }

  /**
   * The deinflector guesses what kind of word something must be; this checks
   * the dictionary agrees. Without it, an ungrammatical guess would match
   * half the language whenever a rule's stripped ending happened to spell a
   * real word.
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
   * Tags carried by every sense of an entry, for some field on a sense (`m`
   * for misc tags, `p` for part of speech). Printed once, beside the word,
   * rather than repeated against every sense that happens to share it.
   */
  function commonAcrossSenses(entry, field) {
    if (!entry.s.length) return [];
    var first = entry.s[0][field] || [];
    return first.filter(function (code) {
      return entry.s.every(function (sense) {
        return (sense[field] || []).indexOf(code) !== -1;
      });
    });
  }

  function sharedTags(entry) { return commonAcrossSenses(entry, 'm'); }
  function sharedPos(entry) { return commonAcrossSenses(entry, 'p'); }

  // How common a word is, rounded to the precision the number deserves. A
  // bare rank asks you to know the scale already; a round band says "this is
  // ordinary" or "this is rare" without needing a legend to read it.
  //
  // The tail is split because "rare" was covering far too much ground. In
  // the Italian list the top 50k is 97.8% of everything said, so everything
  // past it shares the last 2.2%: rank 60,000 and rank 600,000 were both
  // "rare", though the first is a word like sbadigliare, which everyone
  // knows and nobody writes down, and the second is genuinely obscure. A
  // learner reading "rare" against an ordinary word learns to distrust the
  // label. Past 100k the word really is rare, about thirty uses in a corpus
  // of 247 million, so that is where the word is kept.
  var BANDS = [
    [1000, 'top 1k'], [2000, 'top 2k'], [5000, 'top 5k'],
    [10000, 'top 10k'], [20000, 'top 20k'], [50000, 'top 50k'],
    [100000, 'top 100k']
  ];

  function frequencyBand(rank) {
    if (!rank) return '';
    for (var i = 0; i < BANDS.length; i++) {
      if (rank <= BANDS[i][0]) return BANDS[i][1];
    }
    return 'rare';
  }

  // -------------------------------------------------------------------------
  // Known/ignored bookkeeping
  // -------------------------------------------------------------------------

  /**
   * Whether a reader knows what a token says. The same characters can be
   * more than one word (来た / 読み in Japanese; less common but not unheard
   * of in Italian too, "porto" as "I carry" or "port"), so knowing any one
   * reading of what is actually there counts as knowing it.
   */
  function isKnown(token, known) {
    if (known.has(token.word)) return true;
    var words = token.words || [];
    for (var i = 0; i < words.length; i++) {
      if (known.has(words[i])) return true;
    }
    return false;
  }

  /**
   * How much of a passage is made of words already known. Counted per word
   * said, not per distinct word. `counts` comes back too, so marking one
   * word known afterwards can be reflected immediately rather than reading
   * the whole passage again.
   */
  function coverage(tokens, known, ignored) {
    var counts = {};
    var hits = 0;
    var total = 0;
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      counts[token.word] = (counts[token.word] || 0) + 1;
      if (ignored && ignored.has(token.word)) continue;
      total++;
      if (isKnown(token, known)) hits++;
    }
    return { total: total, known: hits, counts: counts };
  }

  /**
   * The same reading, in a shape small enough to hand to the bar and complete
   * enough for it to work the number out again by itself.
   *
   * The bar used to be told only how many times each word was said, and it
   * moved the score by that number whenever a word was ticked. That is wrong
   * whenever a word is already understood under another name: "ha" is counted
   * under "ha", but a reader who knows "avere" already had every one of those
   * occurrences credited to them, so ticking "ha" paid for them a second
   * time. Words like that are common enough, "e", "il", "le", "ha", that a
   * session of marking words walked the score up past the total, where it was
   * clamped, and the bar sat on 1,623 of 1,623 on a page full of words the
   * reader had never seen.
   *
   * There is no arithmetic that fixes this from counts alone, because whether
   * one more tick changes an occurrence depends on every other word that
   * occurrence could be. So the occurrences themselves go across: a table of
   * the distinct words, each occurrence as the list of words it might be, and
   * which of those words are known and ignored right now. Ticking a word then
   * means putting it in a set and counting again, which is the same answer
   * this file would have given had the whole page been read afresh.
   *
   * Indices rather than strings because a transcript is thousands of
   * occurrences of a few hundred words, and the strings would be most of the
   * message.
   */
  function model(tokens, known, ignored) {
    var place = Object.create(null);
    var words = [];
    function number(word) {
      if (place[word] === undefined) {
        place[word] = words.length;
        words.push(word);
      }
      return place[word];
    }

    var rows = tokens.map(function (token) {
      // The word the reading settled on comes first: that is the one the
      // ignored list is asked about, exactly as in `coverage`.
      var row = [number(token.word)];
      var also = token.words || [];
      for (var i = 0; i < also.length; i++) {
        var n = number(also[i]);
        if (row.indexOf(n) === -1) row.push(n);
      }
      return row;
    });

    var knownNow = [];
    var ignoredNow = [];
    for (var i = 0; i < words.length; i++) {
      if (known && known.has(words[i])) knownNow.push(i);
      if (ignored && ignored.has(words[i])) ignoredNow.push(i);
    }
    return { words: words, tokens: rows, known: knownNow, ignored: ignoredNow };
  }

  /** The other end of `model`: tokens and sets `coverage` can be given. */
  function expand(packed) {
    var words = packed.words;
    return {
      tokens: packed.tokens.map(function (row) {
        return {
          word: words[row[0]],
          words: row.map(function (n) { return words[n]; })
        };
      }),
      known: new Set(packed.known.map(function (n) { return words[n]; })),
      ignored: new Set(packed.ignored.map(function (n) { return words[n]; }))
    };
  }

  /**
   * The words of a longer text as they fall across one stretch of it,
   * counted from the start of that stretch. A word lying across the join is
   * kept on both sides, cut to the part actually on each, so a subtitle line
   * cut mid-word still gets it marked on both fragments.
   */
  function within(tokens, from, length) {
    var out = [];
    var end = from + length;
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      var start = Math.max(token.start, from);
      var stop = Math.min(token.start + token.length, end);
      if (stop <= start) continue;
      var moved = {};
      for (var key in token) moved[key] = token[key];
      moved.start = start - from;
      moved.length = stop - start;
      out.push(moved);
    }
    return out;
  }

  function pause() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  // -------------------------------------------------------------------------
  // Reading a whole passage, given a language's own `segment`
  // -------------------------------------------------------------------------

  /**
   * The same reading a language's `segment` produces, but as a flat list:
   * the dictionary form of every word in the text, in order, repeats kept
   * (this is what "how much of this will I understand" needs; a single word
   * used forty times has to count forty times).
   */
  async function extractTokens(text, db, segment, isDecomposable) {
    var located = await locateTokens(text, db, segment, isDecomposable);
    return located.map(function (token) { return token.word; });
  }

  /**
   * The same reading, saying where in the text each word was found.
   * `isDecomposable` is language-specific (it is a JMdict concept: an entry
   * tagged `exp` with none of its senses tagged `id`); a language with no
   * equivalent notion can pass a function that always returns false.
   */
  async function locateTokens(text, db, segment, isDecomposable, say) {
    var words = await segment(text, db, say);
    return words.map(function (found) {
      var hit = found.hits[0];
      return {
        word: hit.word, start: found.start, length: found.length,
        words: found.hits.map(function (h) { return h.word; }),
        expression: isDecomposable(hit.entry)
      };
    });
  }

  /** Every dictionary word in a passage, once each, in the order first met. */
  async function extractWords(text, db, segment, isDecomposable) {
    var seen = new Set();
    var words = [];
    var tokens = await extractTokens(text, db, segment, isDecomposable);
    for (var i = 0; i < tokens.length; i++) {
      if (seen.has(tokens[i])) continue;
      seen.add(tokens[i]);
      words.push(tokens[i]);
    }
    return words;
  }

  function knownAmong(hits, known) {
    for (var i = 0; i < hits.length; i++) {
      if (known.has(hits[i].word)) return true;
    }
    return false;
  }

  /**
   * Whether a span some search already treated as one word can be understood
   * anyway, because every smaller piece it is actually built from is
   * separately known. `search` and `isIdiom` are language-specific (an
   * "idiom" is a JMdict concept; a language with no equivalent tag can pass
   * a function that always returns false), passed in rather than assumed.
   */
  async function decomposeKnown(text, start, length, db, known, search, isIdiom) {
    var reached = new Set([0]);
    var queue = [0];

    while (queue.length) {
      var i = queue.shift();
      var remaining = length - i;
      var groups = await search(text.slice(start + i, start + length), db);
      if (!groups.length || !groups[0].hits.length) continue;

      if (i === 0 && groups[0].length === remaining && isIdiom && isIdiom(groups[0].hits[0].entry)) {
        return false;
      }

      for (var g = 0; g < groups.length; g++) {
        var group = groups[g];
        if (i === 0 && group.length === remaining) continue;
        if (!knownAmong(group.hits, known)) continue;

        var next = i + group.length;
        if (next > length || reached.has(next)) continue;
        if (next === length) return true;
        reached.add(next);
        queue.push(next);
      }
    }
    return false;
  }

  return {
    rankOf: rankOf,
    bestQ: bestQ,
    typesAllow: typesAllow,
    commonAcrossSenses: commonAcrossSenses,
    sharedTags: sharedTags,
    sharedPos: sharedPos,
    frequencyBand: frequencyBand,
    isKnown: isKnown,
    coverage: coverage,
    model: model,
    expand: expand,
    within: within,
    pause: pause,
    extractTokens: extractTokens,
    extractWords: extractWords,
    locateTokens: locateTokens,
    knownAmong: knownAmong,
    decomposeKnown: decomposeKnown
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalLookupCommon;
