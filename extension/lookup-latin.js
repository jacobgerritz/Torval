/*
 * Torval, lookup for the languages written with spaces in them
 *
 * lookup.js's counterpart for Italian and Spanish, and much simpler than it,
 * because both already put spaces between words. There is no run of unspaced
 * script to segment with a Viterbi solver: text is split on whitespace and
 * punctuation, each token is deinflected and looked up, and that is the
 * whole of it.
 *
 * One file for both, because nothing below is about either language in
 * particular. What a language brings is three things, and it brings them
 * through its profile in lang.js rather than being named here: which
 * characters are part of a word, how long a word can run, and its
 * deinflector. Everything else, the batching, the phrase search, the
 * ranking, the elision split, is the same work whichever of them is being
 * read, and was the same work before Spanish existed.
 *
 * The one wrinkle spaces do not solve is elision: Italian's l'amico is two
 * words, l' and amico, glued together with no space between them, so a
 * plain whitespace split would hand the dictionary "l'amico" and never find
 * either word in it. Elided tokens are split on the apostrophe before
 * anything else happens. Spanish never elides, and its character class has
 * no apostrophe in it, so the split simply never fires there.
 *
 * Same `db` contract as lookup.js: anything with an async
 * getEntries(terms) returning Map<term, entry[]>, and the same entry shape
 * ({ k, r, s, f, q, qm }), which is what lets lookup-common.js's ranking and
 * known/ignored bookkeeping work unchanged for every language.
 */

if (typeof TorvalLang === 'undefined' && typeof require !== 'undefined') {
  var TorvalLang = require('./lang.js');
}
if (typeof TorvalLookupCommon === 'undefined' && typeof require !== 'undefined') {
  var TorvalLookupCommon = require('./lookup-common.js');
}

var TorvalLookupLatin = (function () {
  'use strict';

  var MAX_GROUPS = 6;
  var MAX_PER_GROUP = 4;

  /*
   * The active language's three pieces, asked for fresh every time rather
   * than read once into a constant.
   *
   * A language switch has to be picked up by the very next lookup, the same
   * way background.js asks which engine to use on every call instead of
   * holding onto one. Read once at load, these would be whichever language
   * happened to be active when the background script started, and switching
   * from Italian to Spanish would go on deinflecting in Italian until the
   * extension was reloaded.
   */
  function letters() { return TorvalLang.profile().charClass; }
  function maxScan() { return TorvalLang.profile().scanWindow; }
  function deinflector() { return TorvalLang.profile().deinflector(); }

  // A word never starts on an apostrophe: it always closes off whatever came
  // before it (l', dell', un', po'). Splitting a run of word-characters here
  // is what turns "l'amico" into the two tokens "l'" and "amico".
  var ELISION = /^(.*?['’])(.+)$/;

  /** This run of word-characters, split at an elision mark if it has one. */
  function splitElision(span) {
    var m = ELISION.exec(span);
    if (!m || !m[2]) return [span];
    return [m[1], m[2]];
  }

  /*
   * Phrases: the entries with a space in them.
   *
   * Nine thousand of the dictionary's terms are more than one word long,
   * "rendere conto", "a meno che", "Rio de Janeiro", and splitting the text
   * on spaces and looking each piece up alone could never find any of them.
   * A phrase is tried the way Japanese tries a long word: from where the
   * reader is, outward, longest first, and the longest one that is really in
   * the dictionary wins. The difference is only that the pieces here are
   * words rather than characters, so the run stops at the first thing that
   * is not a single space, punctuation, a line break, an elision.
   *
   * Phrases are looked up exactly as written, with no deinflection: the
   * dictionary lists them in the form they are said in, and deinflecting
   * every word of every candidate would multiply the terms asked for by the
   * size of the rule table for the sake of a handful of extra matches.
   */
  var PHRASE_WORDS = 4;      // words in the longest phrase tried
  var PHRASE_LENGTH = 48;    // characters, past which nothing is a phrase

  /** The runs of word-characters in `text`, in order, as {start, length}. */
  function wordRuns(text, limit) {
    var runs = [];
    var i = 0;
    while (i < text.length && runs.length < limit) {
      if (!letters().test(text.charAt(i))) { i++; continue; }
      var start = i;
      while (i < text.length && letters().test(text.charAt(i))) i++;
      runs.push({ start: start, length: i - start });
    }
    return runs;
  }

  /**
   * Every phrase that could start at `from` in `text`, shortest first: two
   * words, then three, for as long as one single space keeps joining them.
   */
  function phrasesAt(text, from, spans, index) {
    var out = [];
    var first = spans ? spans[index] : null;
    var runs;
    if (spans) {
      runs = spans.slice(index, index + PHRASE_WORDS);
    } else {
      runs = wordRuns(text.slice(from), PHRASE_WORDS).map(function (r) {
        return { start: from + r.start, length: r.length };
      });
      first = runs[0];
    }
    if (!first || runs.length < 2) return out;

    var end = first.start + first.length;
    for (var n = 1; n < runs.length; n++) {
      var next = runs[n];
      if (text.slice(end, next.start) !== ' ') break;
      end = next.start + next.length;
      var length = end - first.start;
      if (length > PHRASE_LENGTH) break;
      out.push({ words: n + 1, length: length, surface: text.slice(first.start, end) });
    }
    return out;
  }

  /** A phrase is asked for as written, and as lowercase, and nothing else. */
  function phraseTerms(surface) {
    var byTerm = new Map();
    var untouched = [{ types: null, reasons: [] }];
    byTerm.set(surface, untouched);
    var lower = surface.toLowerCase();
    if (lower !== surface) byTerm.set(lower, untouched);
    return byTerm;
  }

  /**
   * Every dictionary form worth asking about for one token.
   *
   * The dictionary is written in lowercase throughout, the way Wiktionary
   * itself is, but ordinary text is not: every sentence starts with
   * a capital letter. Deinflecting only the word exactly as capitalized
   * would leave the untouched, zero-step candidate ("Ieri" itself) never
   * matching anything, and fall through to whatever multi-step guess the
   * suffix rules happen to produce instead ("Iero", stripping a plural "i"),
   * which is a real but far rarer word than the sentence-initial "Ieri" it
   * replaced. So the lowercase form is deinflected too, and its untouched
   * candidate counts as zero steps exactly like the original casing's does,
   * rather than being treated as an inflection of it.
   */
  function termsFor(word) {
    var byTerm = new Map();
    addCandidates(byTerm, deinflector().deinflect(word));
    var lower = word.toLowerCase();
    if (lower !== word) addCandidates(byTerm, deinflector().deinflect(lower));
    return byTerm;
  }

  function addCandidates(byTerm, candidates) {
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var list = byTerm.get(c.term);
      if (!list) { list = []; byTerm.set(c.term, list); }
      // The same term can be reached both ways; keep whichever needed fewer
      // steps, the same rule groupsFrom uses in lookup.js.
      if (!list.length || c.reasons.length < list[0].reasons.length) {
        list.unshift({ types: c.types, reasons: c.reasons });
      } else {
        list.push({ types: c.types, reasons: c.reasons });
      }
    }
  }

  /** What the dictionary answered for one token, dressed for the popup. */
  function hitsFrom(byTerm, found) {
    var byId = new Map();
    byTerm.forEach(function (infos, term) {
      var entries = found.get(term);
      if (!entries) return;
      for (var a = 0; a < entries.length; a++) {
        var entry = entries[a];
        for (var b = 0; b < infos.length; b++) {
          var info = infos[b];
          if (!TorvalLookupCommon.typesAllow(entry, info.types)) continue;

          var existing = byId.get(entry.id);
          if (!existing || info.reasons.length < existing.reasons.length) {
            byId.set(entry.id, {
              entry: entry, reasons: info.reasons, matched: term,
              q: TorvalLookupCommon.rankOf(entry, term),
              word: displayForm(entry), reading: '',
              expression: false
            });
          }
        }
      }
    });
    return Array.from(byId.values()).sort(byRelevance).slice(0, MAX_PER_GROUP);
  }

  /** A Wiktextract entry carries exactly one spelling; that is the display form. */
  function displayForm(entry) {
    return entry.k[0];
  }

  function byRelevance(a, b) {
    if (a.reasons.length !== b.reasons.length) return a.reasons.length - b.reasons.length;
    var aq = a.q || Infinity, bq = b.q || Infinity;
    if (aq !== bq) return aq - bq;
    if (a.entry.f !== b.entry.f) return b.entry.f - a.entry.f;
    return a.entry.id - b.entry.id;
  }

  /**
   * What to show for the token starting at `text`'s beginning: the longest
   * phrase that really is a phrase, then the word on its own.
   *
   * Both are offered rather than only the winner, the way the Japanese side
   * keeps its shorter readings under "other matches": "rendere conto" is
   * almost always the phrase, but a reader who wanted "rendere" should not
   * have to go and look it up somewhere else.
   */
  async function search(text, db) {
    var span = leadingSpan(text);
    if (!span) return [];
    var pieces = splitElision(span);
    var word = pieces[0];

    var byTerm = termsFor(word);
    var terms = new Set(byTerm.keys());

    // A phrase never starts on the l' of l'amico: that fragment is a word of
    // its own, and the phrase, if there is one, starts at the word after it.
    var candidates = pieces.length > 1 ? [] : phrasesAt(text, 0, null, 0);
    for (var c = 0; c < candidates.length; c++) {
      candidates[c].byTerm = phraseTerms(candidates[c].surface);
      candidates[c].byTerm.forEach(function (_, term) { terms.add(term); });
    }

    var found = await db.getEntries(Array.from(terms));

    var groups = [];
    for (var d = candidates.length - 1; d >= 0; d--) {   // longest first
      var phraseHits = hitsFrom(candidates[d].byTerm, found);
      if (phraseHits.length) {
        groups.push({
          length: candidates[d].length, surface: candidates[d].surface, hits: phraseHits
        });
      }
    }

    var hits = hitsFrom(byTerm, found);
    if (hits.length) groups.push({ length: word.length, surface: word, hits: hits });
    return groups;
  }

  /** The run of word-characters starting at the beginning of `text`. */
  function leadingSpan(text) {
    if (!text || !letters().test(text.charAt(0))) return '';
    var i = 1;
    var limit = maxScan();
    while (i < text.length && i < limit && letters().test(text.charAt(i))) i++;
    return text.slice(0, i);
  }

  /**
   * Every word in `text`, wherever it is: split on whitespace/punctuation,
   * elision handled per token, each token looked up on its own. `say`, given
   * the same meaning as lookup.js's, is told how far through the text this
   * has got each time it stops to ask the dictionary something.
   */
  async function segment(text, db, say) {
    var spans = [];    // { start, length, word }[]
    var i = 0;
    while (i < text.length) {
      if (!letters().test(text.charAt(i))) { i++; continue; }
      var start = i;
      while (i < text.length && letters().test(text.charAt(i))) i++;
      var pieces = splitElision(text.slice(start, i));
      var at = start;
      for (var p = 0; p < pieces.length; p++) {
        spans.push({ start: at, length: pieces[p].length, word: pieces[p] });
        at += pieces[p].length;
      }
    }

    var results = new Array(spans.length);
    var phrases = new Array(spans.length);   // the longest phrase starting at each span
    var perSpan = new Array(spans.length);
    var perPhrase = new Array(spans.length);
    var pending = [];   // indexes into spans whose terms are in `asking`, not yet answered
    var asking = new Set();
    var BATCH = 2000;
    var reached = 0;

    var flush = async function () {
      if (!pending.length) return;
      var answer = await db.getEntries(Array.from(asking));
      for (var k = 0; k < pending.length; k++) {
        var s = pending[k];
        var hits = hitsFrom(perSpan[s], answer);
        if (hits.length) results[s] = { start: spans[s].start, length: spans[s].length, hits: hits };

        var candidates = perPhrase[s] || [];
        for (var c = candidates.length - 1; c >= 0; c--) {   // longest first
          var phraseHits = hitsFrom(candidates[c].byTerm, answer);
          if (!phraseHits.length) continue;
          phrases[s] = {
            start: spans[s].start, length: candidates[c].length,
            words: candidates[c].words, hits: phraseHits
          };
          break;
        }
      }
      pending = [];
      asking = new Set();
      if (say) say(reached, text.length);
      await TorvalLookupCommon.pause();
    };

    var add = function (term) { asking.add(term); };
    for (var s2 = 0; s2 < spans.length; s2++) {
      var byTerm = termsFor(spans[s2].word);
      perSpan[s2] = byTerm;
      byTerm.forEach(function (infos, term) { asking.add(term); });

      var candidates = phrasesAt(text, spans[s2].start, spans, s2);
      for (var c2 = 0; c2 < candidates.length; c2++) {
        candidates[c2].byTerm = phraseTerms(candidates[c2].surface);
        candidates[c2].byTerm.forEach(function (infos, term) { add(term); });
      }
      perPhrase[s2] = candidates;

      pending.push(s2);
      reached = spans[s2].start + spans[s2].length;
      if (asking.size >= BATCH) await flush();
    }
    await flush();

    // A phrase swallows the words it is made of: "rendere conto" is one
    // thing said, not two things that happen to be next to each other, and
    // counting both it and its halves would count the same stretch of the
    // page twice and colour a seam through the middle of it. Longest wins,
    // left to right, which is the same rule the Japanese side settles an
    // overlap with.
    var out = [];
    for (var r = 0; r < results.length; ) {
      if (phrases[r]) {
        out.push({ start: phrases[r].start, length: phrases[r].length, hits: phrases[r].hits });
        r += phrases[r].words;
        continue;
      }
      if (results[r]) out.push(results[r]);
      r++;
    }
    return out;
  }

  /** Which word covers one particular character, and where it begins. */
  async function tokenAt(text, at, db) {
    if (!letters().test(text.charAt(at))) return { start: at, length: 0 };
    var start = at;
    while (start > 0 && letters().test(text.charAt(start - 1))) start--;
    var end = at;
    while (end < text.length && letters().test(text.charAt(end))) end++;

    var pieces = splitElision(text.slice(start, end));
    var cursor = start;
    for (var p = 0; p < pieces.length; p++) {
      var pieceEnd = cursor + pieces[p].length;
      if (at < pieceEnd) {
        var groups = await search(text.slice(cursor), db);
        return { start: cursor, length: pieces[p].length, groups: groups };
      }
      cursor = pieceEnd;
    }
    return { start: at, length: 0 };
  }

  /** Everything a hover needs. */
  async function hover(text, at, db) {
    var found = await tokenAt(text, at, db);
    var groups = found.groups || [];
    return { start: found.start, length: found.length, groups: groups.slice(0, MAX_GROUPS) };
  }

  /** Where the word covering `at` begins. */
  async function wordAt(text, at, db) {
    return (await tokenAt(text, at, db)).start;
  }

  // Wiktextract entries carry no exp/id-style tag, so nothing is ever
  // treated as a decomposable expression: decomposeKnown simply never has
  // anything to do for these languages, which is the correct behaviour, not
  // a workaround, until their multi-word entries get a reason to need it.
  function isDecomposable() { return false; }
  function isIdiom() { return false; }

  function decomposeKnown(text, start, length, db, known) {
    return TorvalLookupCommon.decomposeKnown(text, start, length, db, known, search, isIdiom);
  }

  function extractTokens(text, db) {
    return TorvalLookupCommon.extractTokens(text, db, segment, isDecomposable);
  }

  function locateTokens(text, db, say) {
    return TorvalLookupCommon.locateTokens(text, db, segment, isDecomposable, say);
  }

  function extractWords(text, db) {
    return TorvalLookupCommon.extractWords(text, db, segment, isDecomposable);
  }

  return {
    search: search,
    wordAt: wordAt,
    tokenAt: tokenAt,
    hover: hover,
    segment: segment,
    displayForm: function (entry) { return { word: displayForm(entry), reading: '' }; },
    frequencyBand: TorvalLookupCommon.frequencyBand,
    sharedTags: TorvalLookupCommon.sharedTags,
    sharedPos: TorvalLookupCommon.sharedPos,
    extractWords: extractWords,
    extractTokens: extractTokens,
    locateTokens: locateTokens,
    decomposeKnown: decomposeKnown,
    coverage: TorvalLookupCommon.coverage,
    model: TorvalLookupCommon.model,
    within: TorvalLookupCommon.within,
    isKnown: TorvalLookupCommon.isKnown,
    // A property rather than a number, since it is a different number in
    // each language and callers hold onto this object across a switch.
    get MAX_SCAN() { return maxScan(); }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalLookupLatin;
