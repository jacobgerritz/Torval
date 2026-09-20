/*
 * Torval, lookup
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
 *
 * Everything here that is not actually about segmenting unspaced Japanese
 * text, ranking entries, known/ignored bookkeeping, reading a whole passage
 * given a `segment` function, lives in lookup-common.js instead, shared with
 * lookup-latin.js. This file keeps its full original public API so nothing
 * downstream (background.js, tools/test.mjs) has to know that split exists.
 */

// In the extension these are loaded first and are already globals; under Node
// (the test suite) we pull them in ourselves.
if (typeof TorvalDeinflect === 'undefined' && typeof require !== 'undefined') {
  var TorvalDeinflect = require('./deinflect.js');
}
if (typeof TorvalJapanese === 'undefined' && typeof require !== 'undefined') {
  var TorvalJapanese = require('./japanese.js');
}
if (typeof TorvalMaxScan === 'undefined' && typeof require !== 'undefined') {
  var TorvalMaxScan = require('./scan.js');
}
if (typeof TorvalLookupCommon === 'undefined' && typeof require !== 'undefined') {
  var TorvalLookupCommon = require('./lookup-common.js');
}

var TorvalLookup = (function () {
  'use strict';

  var MAX_SCAN = TorvalMaxScan;    // longest span of text we will try to match

  /**
   * Characters that can never begin a word, because they belong to the one
   * before them: the small kana that turn ジ into ジャ, the long vowel mark ー,
   * and the marks that mean "same again" like 々.
   *
   * The sokuon っ is deliberately not among them, though it looks like it
   * belongs. って, the quotative particle, begins with one, and banning it
   * outright is what turned それって into それっ and て: with no boundary
   * allowed after それ, the only way through the sentence ran through a word
   * nobody has ever said. Inside a word it needs no ban anyway, since 行っ is
   * not a dictionary entry and never wins on its own.
   *
   * Without this, a word boundary is free to land in the middle of a single
   * sound. ユアジャパニーズ was being read as アジ ("horse mackerel"), パ and
   * ニーズ ("needs"), three real dictionary entries, assembled by cutting ジャ
   * in half, while a hover over the same text found ジャパニーズ perfectly
   * well. Anywhere a boundary is considered, it has to be a boundary a
   * Japanese reader would recognise.
   *
   * ヶ and ヵ are deliberately left out: 一ヶ月 really does have a word
   * starting at ヶ, so they are not purely attaching the way the rest are.
   */
  var ATTACHING = /[ぁぃぅぇぉゃゅょゎァィゥェォャュョヮーｰゝゞヽヾ々〻]/;

  var MAX_GROUPS = 6;     // distinct lengths shown (1 expanded + the rest collapsed)
  var MAX_PER_GROUP = 4;  // homographs shown for a single length

  /** Would a boundary here cut a character away from the one it belongs to? */
  function splitsCluster(text, at) {
    return at > 0 && at < text.length && ATTACHING.test(text.charAt(at));
  }

  /*
   * Finding what starts at one place in the text is two jobs, and they are
   * kept apart because the expensive one can be shared. Working out what to
   * ask the dictionary is deinflection and nothing else. Asking it is a trip
   * to a database, and a trip costs about the same whether it carries one
   * question or a thousand, so a whole sentence goes in one trip rather than
   * one trip per character.
   *
   * What comes back is the raw material for two very different things. The
   * popup wants it dressed up: sorted, deduplicated, cut to what fits on
   * screen. The segmenter wants it plain, all of it, because a length the
   * popup would throw away as uninteresting may be the piece that makes the
   * rest of the sentence come out right.
   */

  /**
   * Every dictionary form worth asking about for the text starting here,
   * remembering which lengths of the original text each one could have come
   * from. Deinflection only, no dictionary: this is the half of the work
   * that can be done for a whole sentence before anything is looked up.
   */
  function termsAt(text, knows) {
    var byTerm = new Map();
    var scan = Math.min(text.length, MAX_SCAN);
    for (var len = scan; len >= 1; len--) {
      var candidates = TorvalDeinflect.deinflect(text.slice(0, len));
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        // Thirty-odd shapes are proposed per character and one or two of
        // them are words. Where the dictionary can say up front that it has
        // never heard of one, it is dropped here rather than carried through
        // the whole reading: it would otherwise be held in a map, asked
        // about, and looked for again in the answer, three times over
        // nothing.
        if (knows && !knows(c.term)) continue;
        var list = byTerm.get(c.term);
        if (!list) { list = []; byTerm.set(c.term, list); }
        list.push({ length: len, types: c.types, reasons: c.reasons });
      }
    }
    return byTerm;
  }

  /**
   * What this database will say it has never heard of, if it can say.
   *
   * Optional, and everything works without it, which is what the tests and
   * the previews run on.
   */
  function knowerOf(db) {
    return db && typeof db.mightKnow === 'function'
      ? function (term) { return db.mightKnow(term); }
      : null;
  }

  /** What the dictionary answered, filed by how many characters it took. */
  function groupsFrom(byTerm, found) {
    // length -> (entry id -> hit)
    var groups = new Map();
    byTerm.forEach(function (infos, term) {
      var entries = found.get(term);
      if (!entries) return;
      for (var a = 0; a < entries.length; a++) {
        var entry = entries[a];
        for (var b = 0; b < infos.length; b++) {
          var info = infos[b];
          if (!TorvalLookupCommon.typesAllow(entry, info.types)) continue;

          var group = groups.get(info.length);
          if (!group) { group = new Map(); groups.set(info.length, group); }

          var existing = group.get(entry.id);
          // Prefer the explanation that needed the fewest steps, 食べた is
          // "past", not "past of the potential form of a verb that also exists".
          if (!existing || info.reasons.length < existing.reasons.length) {
            group.set(entry.id, Object.assign(
              { entry: entry, reasons: info.reasons, matched: term,
                q: TorvalLookupCommon.rankOf(entry, term) },
              displayForm(entry, term)));
          }
        }
      }
    });
    return groups;
  }

  /** Both halves, for one place in the text. */
  async function groupsAt(text, db) {
    var byTerm = termsAt(text, knowerOf(db));
    return groupsFrom(byTerm, await db.getEntries(Array.from(byTerm.keys())));
  }

  /**
   * What to show for the text under the cursor: the matches starting here,
   * longest first, dressed for the popup.
   *
   * `prefer`, when given, is the length the segmenter decided this word
   * actually is, and it goes to the top whatever its length. The two have to
   * agree: it would be a strange popup that answered a hover with a different
   * word from the one the page had just marked under the same characters.
   * Everything else stays on the list underneath, since the segmenter is
   * making a judgement and not every judgement is right.
   */
  async function search(text, db, prefer) {
    if (!text) return [];
    return present(await groupsAt(text, db), text, prefer);
  }

  /** The same, for matches that have already been found. */
  function present(groups, text, prefer) {
    if (!groups) return [];

    // Longest first, and each dictionary entry only once. Without that last
    // rule, hovering 勉強しています would list 勉強 four times over, once for
    // 勉強しています, 勉強してい, 勉強して and 勉強し, which is noise, not choice.
    // What the shorter matches are for is genuinely different words: 日本 sitting
    // under 日本語.
    var used = new Set();
    var out = [];
    var lengths = Array.from(groups.keys())
      .filter(function (len) { return !splitsCluster(text, len); })
      .sort(function (a, b) { return b - a; });
    if (prefer && lengths.indexOf(prefer) > 0) {
      lengths.splice(lengths.indexOf(prefer), 1);
      lengths.unshift(prefer);
    }

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

  // -------------------------------------------------------------------------
  // Reading a run of Japanese as a sequence of words
  // -------------------------------------------------------------------------

  /*
   * Japanese is written without spaces, so before anything can be counted,
   * looked up or coloured, somebody has to decide where one word stops and
   * the next begins. That decision is the whole game, and taking the longest
   * match at each position in turn, which is what this used to do, gets it
   * wrong in a way that is hard to see coming: every step is locally sensible
   * and the sentence still comes out as nonsense.
   *
   * 種がある ("there is a seed") went in and came out as 種, があ, る,
   * because があ happens to be a dictionary entry and taking it left る
   * stranded. すごいですね came out as ご, いです, ね. それって became
   * それっ, て. In every case a rare word was picked up early and the
   * wreckage pushed to the end of the sentence, where nothing was left to
   * complain.
   *
   * So the choice is not made one word at a time any more. The whole run of
   * Japanese between two pieces of punctuation is laid out as every way it
   * could possibly be cut up, each cut is priced, and the cheapest way
   * through the lot wins. Backing a word here that leaves rubbish three
   * characters later now costs what the rubbish costs, which is the point:
   * があ is only cheap until you notice what it does to the rest of the
   * sentence.
   *
   * Pricing a word, lower being better:
   *
   *   TOKEN_COST      paid once per word, so twelve words are not preferred
   *                   over four when both fit.
   *   rankCost(q)     how rare it is, on a log scale, because the difference
   *                   between the 10th and the 1000th commonest word matters
   *                   far more than the difference between the 40,000th and
   *                   the 41,000th. Words in neither frequency list are
   *                   priced as rarer than anything in them.
   * There is deliberately no bonus for being long. "Longest match wins" comes
   * out of this on its own and for the right reason: one word costs one
   * TOKEN_COST and two cost two, so 日本語 beats 日本 plus 語 without anyone
   * having to say that longer is better. Paying for length twice over is what
   * made stretches of unreadable text look cheap.
   *
   * A stretch that matches nothing at all is priced by the same three terms,
   * as though it were a single word of the worst rank there is, and becomes
   * no word. That falls out about right: anything the frequency lists have
   * heard of beats it, and anything they have not does not.
   */
  var TOKEN_COST = 3;
  var UNKNOWN_MAX = 8;          // longest stretch read as one unknown
  var UNKNOWN_RANK = 60000;     // priced as rarer than the frequency lists reach
  var UNKNOWN_PER = 4;          // and that much again for every extra character

  // How many distinct words to gather up before asking the dictionary about
  // them. Big enough that a page is a handful of questions rather than one
  // per sentence, small enough that the answer is not an enormous thing to
  // hold and hand back at once.
  var BATCH_TERMS = 4000;

  /**
   * What a word costs for being rare. Lower is commoner.
   *
   * A missing rank means the frequency lists have never heard of the word,
   * which is not the same as it being infinitely rare: JMdict knows plenty of
   * ordinary words the lists skip, and particles often have no rank at all.
   * Anything unranked is priced as if it sat just past the end of the lists.
   */
  function rankCost(q) {
    return Math.log(q > 0 && isFinite(q) ? q : UNKNOWN_RANK);
  }

  /**
   * What one word costs, given how common it is and how much text it covers.
   *
   * A word the corpora have never heard of costs exactly what giving up on
   * the same characters costs, and not a penny less. Priced any cheaper, a
   * dictionary entry nobody has ever written beats honest ignorance, and a
   * name gets quietly assembled out of whatever happens to overlap it:
   * 僕もちえこさんも was read as 僕, もち, えこ, さん, も because えこ, a
   * reading of 長子 that has surely never been used, was going for less than
   * three characters of nothing. Priced level, the shorter answer still wins
   * ties, so a real if unheard-of word like ネカフェ is still one word.
   */
  function wordCost(q, length) {
    if (!isFinite(q) || q <= 0) return unknownCost(length);
    return TOKEN_COST + rankCost(q);
  }

  /** What it costs to give up on `length` characters. */
  function unknownCost(length) {
    return TOKEN_COST + rankCost(UNKNOWN_RANK) + UNKNOWN_PER * (length - 1);
  }

  // How far either side of the cursor a single hover bothers to look. Reading
  // a whole page does each run in one go, but a hover happens on every mouse
  // movement and a run can be a paragraph. Sixty characters each way is far
  // more than any word is long, so the answer under the cursor is the same one
  // the full reading gives.
  var WINDOW = 60;

  var HIRAGANA = /[ぁ-ゟ]/;
  var KATAKANA = /[ァ-ヿｦ-ﾟ]/;

  /** Are these two characters the same kind of writing? */
  function sameScript(a, b) {
    if (HIRAGANA.test(a) !== HIRAGANA.test(b)) return false;
    if (KATAKANA.test(a) !== KATAKANA.test(b)) return false;
    return true;
  }

  /**
   * Where the run of Japanese containing `at` starts and stops. Punctuation,
   * spaces and Latin letters end it: no Japanese word is written across them,
   * so each run can be read on its own.
   */
  function runAround(text, at) {
    var from = at, to = at;
    while (from > 0 && TorvalJapanese.test(text.charAt(from - 1))) from--;
    while (to < text.length && TorvalJapanese.test(text.charAt(to))) to++;
    return { from: from, to: to };
  }

  /**
   * Everything the dictionary will be asked about one run, worked out
   * without asking it anything. Deinflection only, so several runs can be
   * prepared and then asked about together.
   */
  function prepareRun(text, from, to, asking, knows) {
    var n = to - from;
    var termsFor = new Array(n).fill(null);
    for (var t = 0; t < n; t++) {
      if (splitsCluster(text, from + t)) continue;
      var terms = termsAt(text.slice(from + t, from + t + MAX_SCAN + 1), knows);
      termsFor[t] = terms;
      terms.forEach(function (infos, term) { asking.add(term); });
    }
    return { from: from, to: to, n: n, termsFor: termsFor };
  }

  /** One run read, given a reply that may cover several of them. */
  function solveRun(text, run, answer) {
    var from = run.from;
    var n = run.n;
    if (n <= 0) return { words: [], groupsFor: [], from: from };

    var best = new Array(n + 1).fill(Infinity);
    var backLength = new Array(n + 1).fill(0);
    var backWord = new Array(n + 1).fill(false);
    var groupsFor = new Array(n).fill(null);
    var termsFor = run.termsFor;
    best[0] = 0;

    for (var i = 0; i < n; i++) {
      if (best[i] === Infinity) continue;
      var at = from + i;

      // No word begins on a character that belongs to the one before it.
      if (termsFor[i]) {
        var groups = groupsFrom(termsFor[i], answer);
        groupsFor[i] = groups;
        var here = i;
        groups.forEach(function (group, length) {
          if (here + length > n) return;                          // past the end
          if (splitsCluster(text, from + here + length)) return;  // ends mid-sound
          var cost = best[here] + wordCost(TorvalLookupCommon.bestQ(group), length);
          if (cost < best[here + length]) {
            best[here + length] = cost;
            backLength[here + length] = length;
            backWord[here + length] = true;
          }
        });
      }

      // The way through anything: a stretch the dictionary has never heard
      // of, priced as one word of the worst rank there is rather than per
      // character. A name is a name however long it is, and charging by the
      // character is what let 僕もちえこさんも be read as 僕, もち, えこ, さん,
      // も: three characters of nothing cost so much that any two entries
      // overlapping them looked like a bargain. Priced this way, nothing in
      // the frequency lists ever loses to it, and nothing outside them wins.
      for (var skip = 1; skip <= UNKNOWN_MAX && i + skip <= n; skip++) {
        // Only ever across one kind of writing. A stretch of nothing is
        // cheaper per character the longer it runs, which is right for a
        // name but lets a long one swallow the ordinary words on either
        // side: 僕もちえこさんも went from being read badly to not being
        // read at all, 僕 and も disappearing into the hole where ちえこ
        // was. A change from kanji to kana is the one boundary that is
        // visible without knowing any Japanese, so give up on the kana and
        // keep the kanji.
        if (skip > 1 && !sameScript(text.charAt(at + skip - 2), text.charAt(at + skip - 1))) break;
        if (splitsCluster(text, at + skip)) continue;
        var cost = best[i] + unknownCost(skip);
        if (cost < best[i + skip]) {
          best[i + skip] = cost;
          backLength[i + skip] = skip;
          backWord[i + skip] = false;
        }
      }
    }

    var out = [];
    for (var end = n; end > 0;) {
      var length = backLength[end];
      var start = end - length;
      if (backWord[end]) {
        var group = groupsFor[start].get(length);
        var hits = Array.from(group.values()).sort(byRelevance).slice(0, MAX_PER_GROUP);
        out.push({ start: from + start, length: length, hits: hits });
      }
      end = start;
    }
    out.reverse();
    // The matches themselves travel with the answer. A hover wants the ones
    // at the word it landed on, and asking the dictionary for them a second
    // time would be paying twice for the same question.
    return { words: out, groupsFor: groupsFor, from: from };
  }

  /** One run, prepared and answered on its own. What a hover does. */
  async function segmentRun(text, from, to, db) {
    if (to - from <= 0) return { words: [], groupsFor: [], from: from };
    var asking = new Set();
    var run = prepareRun(text, from, to, asking, knowerOf(db));
    return solveRun(text, run, await db.getEntries(Array.from(asking)));
  }

  /**
   * Every word in `text`, wherever it is, run by run.
   *
   * `say`, when given, is told how far through the text this has got each
   * time it stops to ask the dictionary something. Reading a long page is
   * seconds of work, and seconds of "reading this page" with nothing
   * moving is indistinguishable from nothing happening.
   */
  async function segment(text, db, say) {
    var out = [];
    var batch = [];
    var asking = new Set();
    var reached = 0;
    var knows = knowerOf(db);

    // A page is a great many sentences, and asking about each one on its own
    // meant a trip to the database per sentence: on a page of 1,400
    // characters, 130 of them, which at a couple of milliseconds each is most
    // of the time the page takes to read. Sentences are prepared until there
    // are enough questions to be worth asking, then asked about together.
    var flush = async function () {
      if (!batch.length) return;
      var answer = await db.getEntries(Array.from(asking));
      for (var b = 0; b < batch.length; b++) {
        var read = solveRun(text, batch[b], answer);
        for (var w = 0; w < read.words.length; w++) out.push(read.words[w]);
      }
      batch = [];
      asking = new Set();
      if (say) say(reached, text.length);
      // Standing aside here lets whatever else is waiting, a hover being
      // looked up above all, get a turn rather than wait for the whole page.
      await TorvalLookupCommon.pause();
    };

    var i = 0;
    while (i < text.length) {
      if (!TorvalJapanese.test(text.charAt(i))) { i++; continue; }
      var run = runAround(text, i);
      batch.push(prepareRun(text, run.from, run.to, asking, knows));
      i = run.to;
      reached = i;
      if (asking.size >= BATCH_TERMS) await flush();
    }
    await flush();
    return out;
  }

  /**
   * Which word covers one particular character, and where it begins.
   *
   * A cursor lands wherever it lands, usually in the middle of a word, so what
   * a hover asks is not "what starts here" but "what am I pointing at".
   * Pointing at フェ inside ネカフェ has no business finding フェ. The answer
   * comes from the same reading of the sentence the page is coloured from, cut
   * to a window around the cursor for speed, so a hover and the marking under
   * it can never disagree about what the word is.
   *
   * `length` is 0 when the character belongs to nothing the dictionary knows.
   */
  async function tokenAt(text, at, db) {
    if (!TorvalJapanese.test(text.charAt(at))) return { start: at, length: 0 };
    var run = runAround(text, at);
    var from = Math.max(run.from, at - WINDOW);
    var to = Math.min(run.to, at + WINDOW);

    // Moving the cursor one character along a sentence asks the same
    // question about the same sentence, and the answer cannot have changed:
    // where the words are does not depend on which one is being pointed at.
    // So the last sentence read is kept, and running an eye along a subtitle
    // line costs one reading rather than one per character. The key carries
    // one character past the end, because what follows a run decides whether
    // a word may end where the run does.
    var key = text.slice(from, to + 1);
    var read;
    if (lastRun.db === db && lastRun.from === from && lastRun.key === key) {
      read = lastRun.read;
    } else {
      read = await segmentRun(text, from, to, db);
      lastRun = { db: db, from: from, key: key, read: read };
    }

    var words = read.words;
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      if (word.start <= at && at < word.start + word.length) {
        return { start: word.start, length: word.length,
          groups: read.groupsFor[word.start - read.from] };
      }
    }
    // Nothing the dictionary knows covers this character, but something may
    // still start on it, and the popup is allowed to say so.
    return { start: at, length: 0, groups: read.groupsFor[at - read.from] };
  }

  // The last sentence read, kept for the next hover. One is enough: hovering
  // moves along a line, not between two of them.
  var lastRun = { db: null, from: -1, key: null, read: null };

  /**
   * Everything a hover needs: which word the cursor is in, and what to show
   * for it. One question rather than two, so the matches the reading already
   * found are the ones the popup is dressed from.
   */
  async function hover(text, at, db) {
    var found = await tokenAt(text, at, db);
    var whole = text.slice(found.start);
    var groups = found.groups
      ? present(found.groups, whole, found.length)
      : await search(whole, db, found.length);
    var later = await startingAt(text, at, found, db, groups);
    return {
      start: found.start,
      length: found.length,
      groups: groups.concat(later).slice(0, MAX_GROUPS)
    };
  }

  /**
   * The words that begin at the character actually pointed at.
   *
   * Everything else about a hover is read from where the *word* starts, so
   * every character of だからこそ answered with だからこそ, だから, だか and
   * だ. That is the right answer to "what is this word", and it also means
   * the second half of a long word can never be looked up: こそ is offered
   * from nowhere at all, including from itself.
   *
   * The obvious repair, every word beginning at every character, is a wall
   * of matches nobody asked for. But the cursor is already the input, and
   * using it costs nothing: point at こ and こそ is there, point at だ and
   * nothing is added, because だ is where the word starts anyway.
   *
   * Bounded by the word rather than by the rest of the sentence, since these
   * are other ways of reading this word and 頑張る is not one of them.
   */
  async function startingAt(text, at, found, db, already) {
    if (!found.length || at <= found.start) return [];
    var rest = text.slice(at, found.start + found.length);
    if (!rest) return [];
    return notAlready(await search(rest, db), already);
  }

  /** The same entry twice is noise, not choice. */
  function notAlready(groups, already) {
    var seen = new Set();
    already.forEach(function (group) {
      group.hits.forEach(function (hit) { seen.add(hit.entry.id); });
    });
    var out = [];
    groups.forEach(function (group) {
      var hits = group.hits.filter(function (hit) { return !seen.has(hit.entry.id); });
      if (!hits.length) return;
      hits.forEach(function (hit) { seen.add(hit.entry.id); });
      out.push({ length: group.length, surface: group.surface, hits: hits });
    });
    return out;
  }

  /** Where the word covering `at` begins. */
  async function wordAt(text, at, db) {
    return (await tokenAt(text, at, db)).start;
  }

  /**
   * How this entry should be named on screen: the spelling and the reading.
   *
   * Worked out here rather than in the popup so that everything downstream,
   * what you read, what the pitch accent is looked up under, what lands on the
   * card, agrees on what the word is.
   *
   * An entry lists all its spellings, and printing the first is misleading: 本
   * also reads もと, and that entry leads with 元, so pointing at 本 would put a
   * kanji on screen you were not looking at. Only the first `kv` spellings are
   * fit to show at all. JMdict files some purely so searches find them, like
   * ます under 〼, and where none is, the kana is the word.
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
    // happens to be listed first, コーヒー is "usually kana" over its own
    // kanji spelling 珈琲, so hovering コーヒー should not display 珈琲.
    var usuallyKana = entry.s.some(function (sense) {
      return sense.m && sense.m.indexOf('uk') !== -1;
    });
    if (usuallyKana || !showable.length) return { word: matched, reading: '' };
    return { word: showable[0], reading: matched };
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
      // 来た is, on paper, an interjection meaning "all right!", spelled
      // exactly like that, needing no deinflection at all. It is also how the
      // past tense of 来る is written, one of the commonest verbs in the
      // language, which does need a step. Preferring the fewest steps is
      // right almost every time and completely wrong here, so a word nobody
      // ever writes does not get to win on a technicality over one everybody
      // does: an enormous gap in how common two readings are outweighs a
      // tidier derivation.
      if ((plain.q || Infinity) > TRAP_RARE &&
          (inflected.q || Infinity) <= TRAP_COMMON) {
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
    var aq = a.q || Infinity, bq = b.q || Infinity;
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
   * Hovering は should find the topic particle first, not 葉 and 歯 and 羽, those
   * are merely *pronounced* は. JMdict's frequency markers do not save you here:
   * the commonest function words often carry no marker at all, so they sink
   * below every kanji word that happens to share their sound.
   *
   * The middle tier matters as much as the top one. 本 also reads もと, and the
   * もと entry is led by a different kanji (元), so both entries are spelled 本,
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
   *, so the commonest word in the language loses to a rare noun that merely
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
   * A phrase worth checking for decomposeKnown, below: JMdict tags it `exp`,
   * multiple words filed as one entry, and none of its senses are tagged
   * `id`, an idiom, JMdict's own word for "the meaning is not what the
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
   * A genuine idiom specifically, both `exp` and JMdict's own `id` tag on
   * the same sense, as opposed to merely "not decomposable", which is also
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
   * separately known. See lookup-common.js's own copy of this comment for
   * the full rationale; this just supplies Japanese's `search` and `isIdiom`.
   */
  function decomposeKnown(text, start, length, db, known) {
    return TorvalLookupCommon.decomposeKnown(text, start, length, db, known, search, isIdiom);
  }

  /** Every dictionary word in a passage, see lookup-common.js's extractTokens. */
  function extractTokens(text, db) {
    return TorvalLookupCommon.extractTokens(text, db, segment, isDecomposable);
  }

  /** The same, saying where in the text each word was found. */
  function locateTokens(text, db, say) {
    return TorvalLookupCommon.locateTokens(text, db, segment, isDecomposable, say);
  }

  /** Every dictionary word in a passage, once each, in the order first met. */
  function extractWords(text, db) {
    return TorvalLookupCommon.extractWords(text, db, segment, isDecomposable);
  }

  return {
    search: search,
    wordAt: wordAt,
    tokenAt: tokenAt,
    hover: hover,
    segment: segment,
    displayForm: displayForm,
    frequencyBand: TorvalLookupCommon.frequencyBand,
    sharedTags: TorvalLookupCommon.sharedTags,
    sharedPos: TorvalLookupCommon.sharedPos,
    extractWords: extractWords,
    extractTokens: extractTokens,
    locateTokens: locateTokens,
    decomposeKnown: decomposeKnown,
    coverage: TorvalLookupCommon.coverage,
    within: TorvalLookupCommon.within,
    isKnown: TorvalLookupCommon.isKnown,
    MAX_SCAN: MAX_SCAN
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalLookup;
