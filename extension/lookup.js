/*
 * LLL, lookup
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
  function termsAt(text) {
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
    return byTerm;
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
          if (!typesAllow(entry, info.types)) continue;

          var group = groups.get(info.length);
          if (!group) { group = new Map(); groups.set(info.length, group); }

          var existing = group.get(entry.id);
          // Prefer the explanation that needed the fewest steps, 食べた is
          // "past", not "past of the potential form of a verb that also exists".
          if (!existing || info.reasons.length < existing.reasons.length) {
            group.set(entry.id, Object.assign(
              { entry: entry, reasons: info.reasons, matched: term,
                q: rankOf(entry, term) },
              displayForm(entry, term)));
          }
        }
      }
    });
    return groups;
  }

  /** Both halves, for one place in the text. */
  async function groupsAt(text, db) {
    var byTerm = termsAt(text);
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

  var HIRAGANA = /[\u3041-\u309f]/;
  var KATAKANA = /[\u30a1-\u30ff\uff66-\uff9f]/;

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
    while (from > 0 && LLLJapanese.test(text.charAt(from - 1))) from--;
    while (to < text.length && LLLJapanese.test(text.charAt(to))) to++;
    return { from: from, to: to };
  }

  /**
   * Read `text` from `from` to `to`, which has to be one unbroken run of
   * Japanese, and hand back the words in it.
   *
   * Every position is priced once, cheapest way through by the usual dynamic
   * programme, and the winning path is walked back from the end. Text that
   * matched nothing produces no word at all rather than a bad one.
   */
  /**
   * Everything the dictionary will be asked about one run, worked out
   * without asking it anything. Deinflection only, so several runs can be
   * prepared and then asked about together.
   */
  function prepareRun(text, from, to, asking) {
    var n = to - from;
    var termsFor = new Array(n).fill(null);
    for (var t = 0; t < n; t++) {
      if (splitsCluster(text, from + t)) continue;
      var terms = termsAt(text.slice(from + t, from + t + MAX_SCAN + 1));
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
          var cost = best[here] + wordCost(bestQ(group), length);
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
    var run = prepareRun(text, from, to, asking);
    return solveRun(text, run, await db.getEntries(Array.from(asking)));
  }

  /** Every word in `text`, wherever it is, run by run. */
  async function segment(text, db) {
    var out = [];
    var batch = [];
    var asking = new Set();

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
      // Standing aside here lets whatever else is waiting, a hover being
      // looked up above all, get a turn rather than wait for the whole page.
      await pause();
    };

    var i = 0;
    while (i < text.length) {
      if (!LLLJapanese.test(text.charAt(i))) { i++; continue; }
      var run = runAround(text, i);
      batch.push(prepareRun(text, run.from, run.to, asking));
      i = run.to;
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
    if (!LLLJapanese.test(text.charAt(at))) return { start: at, length: 0 };
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
    var groups = found.groups
      ? present(found.groups, text.slice(found.start), found.length)
      : await search(text.slice(found.start), db, found.length);
    return { start: found.start, length: found.length, groups: groups };
  }

  /** Where the word covering `at` begins. */
  async function wordAt(text, at, db) {
    return (await tokenAt(text, at, db)).start;
  }

  /**
   * How common this entry is when it is written the way the page writes it.
   *
   * An entry that can be written more than one way carries a rank for each
   * spelling, because they are not equally likely to be what is meant: 今日は
   * is こんにちは, one of the commonest words in the language, but those three
   * characters on a page are far more often 今日 followed by は. Whichever
   * spelling matched is the one whose rank counts, and a spelling the corpora
   * have never seen counts as unranked however common its neighbours are.
   */
  function rankOf(entry, matched) {
    // Only the spellings that disagree with the entry are written down, so an
    // absent one agrees. A spelling listed as 0 is one the corpora have never
    // seen, which is a different thing from not being listed at all.
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
   * third, printing the first sense's combination as though it summed up the
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
  // does not have, the gap between #100 and #400 is real, the gap between
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
   * Read a passage from end to end and hand back the dictionary form of every
   * word in it, in order, the same word repeated as often as it is said.
   *
   * This is not a separate piece of machinery, it is `search` itself, run
   * forward across a whole passage instead of stopping at the first word. At
   * each position it takes the longest match, deinflects it the same way a
   * hover would, and moves past however many characters that consumed, so
   * 走っていました is recorded as 走る, the same dictionary form a hover on it
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
    var words = await segment(text, db);
    return words.map(function (found) {
      var hit = found.hits[0];
      return {
        word: hit.word, start: found.start, length: found.length,
        // Every reading these same characters could be, not only the best
        // one. 来た is written identically whether it is the rare
        // interjection or the past tense of 来る; 読み is both a noun in its
        // own right and the stem of 読む. Someone who knows any one of the
        // readings of what is actually written on the page is not missing
        // anything, so all of them travel together and whoever counts them
        // can ask about the whole set.
        words: found.hits.map(function (h) { return h.word; }),
        // Whether JMdict itself tags this as an "expression" rather than a
        // single word, the one fact that decides whether it is worth asking
        // if a reader could piece it together from parts they already know.
        // See decomposeKnown, below.
        expression: isDecomposable(hit.entry)
      };
    });
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
   * separately known.
   *
   * JMdict lists a great many ordinary grammatical patterns as their own
   * "expression" entries purely so they can be searched for, お元気ですか
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
   *, this only ever runs where that says the whole entry is transparent,
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
    // こと, が and ある, all thoroughly ordinary words, but greedily, the
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
      // ordinary word that simply happens to reach exactly to the end, です
      // often is the last piece of a breakdown, is not this; only a real
      // idiom is.
      if (i === 0 && groups[0].length === remaining && isIdiom(groups[0].hits[0].entry)) return false;

      for (var g = 0; g < groups.length; g++) {
        var group = groups[g];
        // At the very first step, a match swallowing the whole span again is
        // not a breakdown, it is the same answer restated, and would make
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
   * reflected immediately, its count is exactly how much the total moves, 
   * without reading the whole passage a second time.
   *
   * Ignored words leave the question entirely rather than counting against
   * it: a name, a piece of English, something the dictionary read wrongly.
   * Counting those as unknown would say a page is harder than it is, and
   * counting them as known would say the opposite; neither is true, so they
   * come out of the total altogether.
   */
  /**
   * The words of a longer text as they fall across one stretch of it, counted
   * from the start of that stretch.
   *
   * Reading a subtitle line on its own gets its ends wrong whenever the line
   * was cut mid-word, which automatic captions do constantly: a line ending
   * 見に行っ and the next beginning たので are two fragments, and neither is a
   * word. Read together the word is whole again.
   *
   * A word lying across the join is kept on both lines, cut to the part of it
   * that is actually on each. It is the same word either way, and what is on
   * screen is what gets marked: leaving it off whichever line it did not
   * start on would put an unmarked hole in the middle of a sentence.
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

  function coverage(tokens, known, ignored) {
    var counts = {};
    var hits = 0;
    var total = 0;
    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      // Counted even when ignored, and only then left out of the score. An
      // ignored word still has to say how often it was said, because that is
      // exactly the number to give back if it stops being ignored: dropping
      // it here left the bar unable to restore a word once the page had been
      // read again, since by then nothing remembered there had been eleven of
      // them.
      counts[token.word] = (counts[token.word] || 0) + 1;
      if (ignored && ignored.has(token.word)) continue;
      total++;
      if (isKnown(token, known)) hits++;
    }
    return { total: total, known: hits, counts: counts };
  }

  /**
   * Whether a reader knows what a token says, which is not quite the same as
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
    tokenAt: tokenAt,
    hover: hover,
    segment: segment,
    displayForm: displayForm,
    frequencyBand: frequencyBand,
    sharedTags: sharedTags,
    sharedPos: sharedPos,
    extractWords: extractWords,
    extractTokens: extractTokens,
    locateTokens: locateTokens,
    decomposeKnown: decomposeKnown,
    coverage: coverage,
    within: within,
    isKnown: isKnown,
    MAX_SCAN: MAX_SCAN
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LLLLookup;
