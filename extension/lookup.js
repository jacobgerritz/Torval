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

// In the extension these are loaded first and are already globals; under Node
// (the test suite) we pull them in ourselves.
if (typeof LLLDeinflect === 'undefined' && typeof require !== 'undefined') {
  var LLLDeinflect = require('./deinflect.js');
}
if (typeof LLLJapanese === 'undefined' && typeof require !== 'undefined') {
  var LLLJapanese = require('./japanese.js');
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
    await demoteParticleTrap(text, groups, lengths, db);

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
   * Where the word covering one particular character in `text` actually
   * begins — not necessarily `at` itself.
   *
   * `search` only ever tries matches starting exactly where it is told to
   * start, which is exactly right for a cursor that landed on the first
   * character of a word and exactly wrong the rest of the time: pointing at
   * フェ inside ネカフェ has no business finding フェ, but that is what
   * happens if nothing is done. Every character from `at` back to where a
   * word could plausibly have started is tried in turn, and whichever
   * resulting match both reaches `at` and is longest overall wins — the same
   * "longest wins" every other search in this file goes by. Ties keep the
   * earliest start, which the loop order already gives for free.
   */
  async function wordAt(text, at, db) {
    var bestStart = at;
    var bestLength = 0;
    var from = Math.max(0, at - MAX_SCAN + 1);
    for (var start = from; start <= at; start++) {
      var groups = await search(text.slice(start, start + MAX_SCAN), db);
      if (!groups.length) continue;
      var top = groups[0];
      if (start + top.length <= at) continue;   // does not actually reach the pointed character
      if (top.length > bestLength) { bestLength = top.length; bestStart = start; }
    }
    return bestStart;
  }

  /**
   * "Longest match wins" has one real trap: a common word plus a single
   * trailing particle sometimes happens to also spell a genuine, much rarer
   * dictionary entry. 今日は (2 characters, "today") plus は (the topic
   * particle) spells the same three characters as 今日は the word, a dated
   * way to write こんにちは ("hello") — real, in the dictionary, and almost
   * never what someone actually meant by typing 今日 followed by は.
   *
   * This does not change what is found, only which length is offered first —
   * the longer reading is still right there under "other matches" (the popup
   * calls that list "other" rather than "shorter" for exactly this reason:
   * what ends up there is not always shorter). It fires
   * only when the character being trimmed off is, on its own, a particle
   * (checked with one small dictionary lookup rather than a hardcoded list of
   * them, since the dictionary already knows), and only when doing so jumps
   * to a dramatically more common word — a coincidence has to be a big one
   * before it is worth overriding "longer is usually right".
   */
  async function demoteParticleTrap(text, groups, lengths, db) {
    if (lengths.length < 2) return;
    var longestLen = lengths[0];
    var shorterLen = longestLen - 1;
    if (lengths.indexOf(shorterLen) === -1) return;

    // The groups built so far all start at position 0 of `text`, so the exact
    // trailing character (at `shorterLen`, one past where the shorter match
    // ends) has never been looked up on its own — it takes a fresh, tiny query.
    var trailing = text[shorterLen];
    if (!trailing) return;
    var found = await db.getEntries([trailing]);
    var candidates = found.get(trailing) || [];
    var trailingIsParticle = candidates.some(function (entry) {
      return entry.s.some(function (sense) { return sense.p.indexOf('prt') !== -1; });
    });
    if (!trailingIsParticle) return;

    var longestQ = bestQ(groups.get(longestLen));
    var shorterQ = bestQ(groups.get(shorterLen));
    // The shorter reading has to be a genuinely common word on its own, and the
    // longer one has to be dramatically rarer than it — not merely rarer,
    // which is true of most longer words next to their own prefix.
    if (shorterQ && shorterQ <= 5000 && longestQ > shorterQ * 15) {
      lengths.splice(lengths.indexOf(shorterLen), 1);
      lengths.unshift(shorterLen);
    }
  }

  function bestQ(group) {
    var best = Infinity;
    group.forEach(function (hit) {
      var q = hit.entry.q || Infinity;
      if (q < best) best = q;
    });
    return best;
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
    if (isKanji) return { word: matched, reading: entry.r[0] };

    // Matched via a reading, not a kanji spelling. A word tagged "usually
    // kana" should stay in kana rather than surface whichever kanji spelling
    // happens to be listed first — コーヒー is "usually kana" over its own
    // kanji spelling 珈琲, so hovering コーヒー should not display 珈琲.
    var usuallyKana = entry.s.some(function (sense) {
      return sense.m && sense.m.indexOf('uk') !== -1;
    });
    if (usuallyKana || !showable.length) return { word: matched, reading: '' };
    return { word: showable[0], reading: matched };
  }

  /**
   * Tags carried by every sense of an entry, for some field on a sense (`m` for
   * misc tags, `p` for part of speech).
   *
   * JMdict files both per sense, but some of what they carry cannot vary
   * between definitions: "uk" says the word is usually written in kana, which
   * is a fact about the word, not about any one meaning of it. Printed against
   * every sense it is just noise repeated that many times. So whatever is
   * common to every sense is lifted out and shown once, beside the word;
   * whatever is not stays where it actually belongs.
   *
   * Part of speech needs this every bit as much as misc tags do. 勉強 is
   * "n,vs,vt" for one sense and "n,vs,vi" for another and plain "n" for a
   * third — printing the first sense's combination as though it summed up the
   * whole word would simply be wrong for the other two.
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

  // How common a word is, rounded to the precision the number deserves.
  //
  // A bare rank asks you to know the scale already: #7,261 means nothing unless
  // you have a feel for what #3,000 is like. And it claims a precision the data
  // does not have — the gap between #100 and #400 is real, the gap between
  // #7,261 and #7,800 is noise. A round band says both things at once, and needs
  // no legend to read.
  var BANDS = [
    [1000, 'top 1k'], [2000, 'top 2k'], [5000, 'top 5k'],
    [10000, 'top 10k'], [20000, 'top 20k'], [50000, 'top 50k']
  ];

  function frequencyBand(rank) {
    if (!rank) return '';
    for (var i = 0; i < BANDS.length; i++) {
      if (rank <= BANDS[i][0]) return BANDS[i][1];
    }
    return 'rare';
  }

  // How rare a word written exactly as it appears has to be, and how common
  // the conjugated reading competing with it has to be, before "fewest steps
  // wins" is overruled. Both have to hold: a merely-rarer word does not
  // qualify, or every ordinary homograph would start losing to a verb.
  var TRAP_RARE = 20000;
  var TRAP_COMMON = 5000;

  function byRelevance(a, b) {
    // Uninflected first, then words actually spelled the way the page spells
    // them, then common words, then dictionary order.
    if (a.reasons.length !== b.reasons.length) {
      var plain = a.reasons.length < b.reasons.length ? a : b;
      var inflected = plain === a ? b : a;
      // 来た is, on paper, an interjection meaning "all right!" — spelled
      // exactly like that, needing no deinflection at all. It is also how the
      // past tense of 来る is written, one of the commonest verbs in the
      // language, which does need a step. Preferring the fewest steps is
      // right almost every time and completely wrong here, so a word nobody
      // ever writes does not get to win on a technicality over one everybody
      // does. Same shape of judgement as demoteParticleTrap above: an
      // enormous gap in how common two readings are outweighs a tidier
      // derivation.
      if ((plain.entry.q || Infinity) > TRAP_RARE &&
          (inflected.entry.q || Infinity) <= TRAP_COMMON) {
        return plain === a ? 1 : -1;
      }
      return a.reasons.length - b.reasons.length;
    }
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

  /**
   * Read a passage from end to end and hand back the dictionary form of every
   * word in it, in order, the same word repeated as often as it is said.
   *
   * This is not a separate piece of machinery — it is `search` itself, run
   * forward across a whole passage instead of stopping at the first word. At
   * each position it takes the longest match, deinflects it the same way a
   * hover would, and moves past however many characters that consumed, so
   * 走っていました is recorded as 走る — the same dictionary form a hover on it
   * would have shown. Reading a passage once therefore teaches the word
   * regardless of which sentence it turned up conjugated in.
   *
   * Repeats are kept rather than folded away, because the two questions built
   * on this want different things. "Which words does this teach me" wants each
   * word once; "how much of this will I understand" has to count every time a
   * word is said, or a page that says 私 forty times and one word you have
   * never seen would score the same as one that says forty words you have
   * never seen.
   */
  async function extractTokens(text, db) {
    var located = await locateTokens(text, db);
    return located.map(function (token) { return token.word; });
  }

  /**
   * The same reading, but saying where in the text each word was found.
   *
   * Colouring the words on a page needs to know not just which words are
   * there but exactly which characters each one covers, so that the mark can
   * be put back on the page in the right place. The positions are into the
   * text as given, so whoever assembled that text can map them back to
   * wherever it came from.
   */
  async function locateTokens(text, db) {
    var tokens = [];
    var i = 0;
    var steps = 0;
    while (i < text.length) {
      if (!LLLJapanese.test(text[i])) { i++; continue; }
      var groups = await search(text.slice(i, i + MAX_SCAN), db);
      if (groups.length && groups[0].hits.length) {
        var hit = groups[0].hits[0];
        tokens.push({
          word: hit.word, start: i, length: groups[0].length,
          // Every reading these same characters could be, not only the best
          // one. 来た is written identically whether it is the rare
          // interjection or the past tense of 来る; 読み is both a noun in
          // its own right and the stem of 読む. Someone who knows any one of
          // the readings of what is actually written on the page is not
          // missing anything, so all of them travel together and whoever
          // counts them can ask about the whole set.
          words: groups[0].hits.map(function (h) { return h.word; }),
          // Whether JMdict itself tags this as an "expression" rather than a
          // single word — the one fact that decides whether it is worth
          // asking if a reader could piece it together from parts they
          // already know. See decomposeKnown, below.
          expression: isDecomposable(hit.entry)
        });
        i += groups[0].length;
      } else {
        i++;
      }
      // A whole page is thousands of searches in a row. Standing aside every so
      // often lets whatever else is waiting — a hover being looked up, above
      // all — get a turn, rather than being stuck behind the whole passage.
      if ((++steps % 256) === 0) await pause();
    }
    return tokens;
  }

  /**
   * A phrase worth checking for decomposeKnown, below: JMdict tags it `exp`,
   * multiple words filed as one entry, and none of its senses are tagged
   * `id` — an idiom, JMdict's own word for "the meaning is not what the
   * parts say". 「exp」 alone is not enough on its own to tell them apart:
   * 猫の手も借りたい ("desperately busy", literally "would even borrow a
   * cat's paws") is filed as `exp,adj-i` exactly like an ordinary transparent
   * expression is, and only the `id` tag actually says it is not one.
   */
  function isDecomposable(entry) {
    var isExp = false;
    for (var i = 0; i < entry.s.length; i++) {
      var sense = entry.s[i];
      if (sense.m && sense.m.indexOf('id') !== -1) return false;
      if (sense.p.indexOf('exp') !== -1) isExp = true;
    }
    return isExp;
  }

  /**
   * A genuine idiom specifically — both `exp` and JMdict's own `id` tag on
   * the same sense — as opposed to merely "not decomposable", which is also
   * true of every ordinary single word that was never a candidate for this in
   * the first place. decomposeKnown needs the narrower question: a step
   * partway through a breakdown that happens to consume everything left is
   * completely ordinary (です often is exactly the last piece), and must not
   * be refused just for not being an expression at all.
   */
  function isIdiom(entry) {
    for (var i = 0; i < entry.s.length; i++) {
      var sense = entry.s[i];
      if (sense.p.indexOf('exp') !== -1 && sense.m && sense.m.indexOf('id') !== -1) return true;
    }
    return false;
  }

  /**
   * Whether a span some search already treated as one word can be understood
   * anyway, because every smaller piece it is actually built from is
   * separately known.
   *
   * JMdict lists a great many ordinary grammatical patterns as their own
   * "expression" entries purely so they can be searched for — お元気ですか
   * ("how are you") is filed as one entry, but it is nothing more than the
   * polite prefix お, the word 元気, the copula です and the particle か, each
   * an entirely ordinary word someone may already know on its own. Marking
   * only the whole four-word entry "known" and never crediting the reader for
   * already knowing all four pieces would be wrong in the other direction
   * from the 今日は problem above: there, a rare reading was beating a common
   * one; here, a rare *combination* would be allowed to hide four words
   * someone plainly already has.
   *
   * A genuine idiom is not like this. Knowing every word in 猫の手も借りたい
   * word for word ("even a cat's paws would help") does not hand you its
   * actual meaning ("desperately busy") the way it does for a plain
   * grammatical pattern, which is exactly what isDecomposable, above, is for
   * — this only ever runs where that says the whole entry is transparent,
   * and even then only ever replaces "known" with "known", never with
   * "understood"; a reader who knows all four pieces of お元気ですか still
   * sees the real phrase in the popup exactly as before.
   */
  async function decomposeKnown(text, start, length, db, known) {
    // Every position reachable from the beginning of the span using nothing
    // but known words, worked outward until either the far end is reached or
    // the possibilities run out.
    //
    // Walking greedily and taking the longest match at each step, which is
    // how this first worked, is not good enough. ことがある breaks apart into
    // こと, が and ある, all thoroughly ordinary words — but greedily, the
    // step after こと takes があ, a rare entry that happens to be two
    // characters long and so beats plain が, and from there the rest is
    // nonsense (り, ます) that could never all be known. Asking "is there any
    // way through" instead of "does one particular way through work" costs
    // nothing at this length and gets the answer right.
    var reached = new Set([0]);
    var queue = [0];

    while (queue.length) {
      var i = queue.shift();
      var remaining = length - i;
      var groups = await search(text.slice(start + i, start + length), db);
      if (!groups.length || !groups[0].hits.length) continue;

      // Checked here, not left to whoever calls this, so nothing can ever
      // mistakenly credit a genuine idiom by skipping the check upstream. An
      // ordinary word that simply happens to reach exactly to the end — です
      // often is the last piece of a breakdown — is not this; only a real
      // idiom is.
      if (i === 0 && groups[0].length === remaining && isIdiom(groups[0].hits[0].entry)) return false;

      for (var g = 0; g < groups.length; g++) {
        var group = groups[g];
        // At the very first step, a match swallowing the whole span again is
        // not a breakdown — it is the same answer restated, and would make
        // this succeed immediately every time.
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

  function knownAmong(hits, known) {
    for (var i = 0; i < hits.length; i++) {
      if (known.has(hits[i].word)) return true;
    }
    return false;
  }

  function pause() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  /** Every dictionary word in a passage, once each, in the order first met. */
  async function extractWords(text, db) {
    var seen = new Set();
    var words = [];
    var tokens = await extractTokens(text, db);
    for (var i = 0; i < tokens.length; i++) {
      if (seen.has(tokens[i])) continue;
      seen.add(tokens[i]);
      words.push(tokens[i]);
    }
    return words;
  }

  /**
   * How much of a passage is made of words already known.
   *
   * Counted per word said, not per distinct word: what "I understand 80% of
   * this" means is that four times in five, the next word is one you know.
   * `counts` comes back too, so that marking one word known afterwards can be
   * reflected immediately — its count is exactly how much the total moves —
   * without reading the whole passage a second time.
   *
   * Ignored words leave the question entirely rather than counting against
   * it: a name, a piece of English, something the dictionary read wrongly.
   * Counting those as unknown would say a page is harder than it is, and
   * counting them as known would say the opposite; neither is true, so they
   * come out of the total altogether.
   */
  function coverage(tokens, known, ignored) {
    var counts = {};
    var hits = 0;
    var total = 0;
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      if (ignored && ignored.has(token.word)) continue;
      total++;
      counts[token.word] = (counts[token.word] || 0) + 1;
      if (isKnown(token, known)) hits++;
    }
    return { total: total, known: hits, counts: counts };
  }

  /**
   * Whether a reader knows what a token says — which is not quite the same as
   * whether they have marked its best reading known.
   *
   * The same characters can be more than one word. 来た is the past tense of
   * 来る and also, on paper, a rare interjection; 読み is the stem of 読む and
   * also a noun meaning "reading". Knowing any one of the readings of what is
   * actually written means nothing is missing, so any of them counts. The
   * looseness this allows is real but small: it takes a homograph you know of
   * a word you do not, in a place where the one you know does not fit, and by
   * then the page has bigger problems than the count.
   */
  function isKnown(token, known) {
    if (known.has(token.word)) return true;
    var words = token.words || [];
    for (var i = 0; i < words.length; i++) {
      if (known.has(words[i])) return true;
    }
    return false;
  }

  return {
    search: search,
    wordAt: wordAt,
    displayForm: displayForm,
    frequencyBand: frequencyBand,
    sharedTags: sharedTags,
    sharedPos: sharedPos,
    extractWords: extractWords,
    extractTokens: extractTokens,
    locateTokens: locateTokens,
    decomposeKnown: decomposeKnown,
    coverage: coverage,
    isKnown: isKnown,
    MAX_SCAN: MAX_SCAN
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LLLLookup;
