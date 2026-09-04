/*
 * LLL, deinflection
 *
 * Japanese verbs and adjectives change shape depending on tense, politeness and
 * so on. A dictionary only ever lists the plain form ("食べる"), so before we can
 * look a word up we have to undo whatever was done to it:
 *
 *     食べなかった  ->  食べない  ->  食べる
 *
 * We do that with a table of small reversible rules. Each rule says
 * "if the word ends in X, it might really be a word ending in Y".
 *
 * Every rule also carries word-type tags (v1 = ichidan verb, v5k = godan verb
 * ending in く, adj-i = i-adjective ...). These are the same tags JMdict uses,
 * so once we have undone the conjugation we can check the answer really is the
 * kind of word that rule assumed. That is what stops nonsense matches: 「少ない」
 * would "deinflect" to 「少る」, but no such ichidan verb exists, so it is dropped.
 *
 * A few tags are internal bookkeeping rather than real JMdict tags:
 *   te , a て-form, e.g. 食べて
 *   ta , a た-form, e.g. 食べた
 *   masu, a ます-form, e.g. 食べます
 * They let multi-step chains work (食べていました -> ... -> 食べる).
 *
 * `tin` is the list of types a rule accepts as input. An empty list means the
 * rule only applies to the word exactly as the user hovered it, nothing can be
 * conjugated further on top of it (you cannot conjugate an imperative).
 */

var LLLDeinflect = (function () {
  'use strict';

  var rules = [];
  function rule(from, to, tin, tout, name) {
    rules.push({ from: from, to: to, tin: tin, tout: tout, name: name });
  }

  // ---------------------------------------------------------------------
  // Godan verbs. Each row is one of the nine consonant stems. `a`,`i`,`e`,`o`
  // are the kana the stem takes before different endings; `te`/`ta` are the
  // (irregular, historically sound-shifted) て and た forms.
  // ---------------------------------------------------------------------
  var GODAN = {
    'v5u':   { u: 'う', a: 'わ', i: 'い', e: 'え', o: 'お', te: 'って', ta: 'った' },
    'v5k':   { u: 'く', a: 'か', i: 'き', e: 'け', o: 'こ', te: 'いて', ta: 'いた' },
    'v5g':   { u: 'ぐ', a: 'が', i: 'ぎ', e: 'げ', o: 'ご', te: 'いで', ta: 'いだ' },
    'v5s':   { u: 'す', a: 'さ', i: 'し', e: 'せ', o: 'そ', te: 'して', ta: 'した' },
    'v5t':   { u: 'つ', a: 'た', i: 'ち', e: 'て', o: 'と', te: 'って', ta: 'った' },
    'v5n':   { u: 'ぬ', a: 'な', i: 'に', e: 'ね', o: 'の', te: 'んで', ta: 'んだ' },
    'v5b':   { u: 'ぶ', a: 'ば', i: 'び', e: 'べ', o: 'ぼ', te: 'んで', ta: 'んだ' },
    'v5m':   { u: 'む', a: 'ま', i: 'み', e: 'め', o: 'も', te: 'んで', ta: 'んだ' },
    'v5r':   { u: 'る', a: 'ら', i: 'り', e: 'れ', o: 'ろ', te: 'って', ta: 'った' },
    // ある, behaves like v5r for everything we care about here.
    'v5r-i': { u: 'る', a: 'ら', i: 'り', e: 'れ', o: 'ろ', te: 'って', ta: 'った' },
    // 行く, regular except its て/た forms are 行って / 行った, not 行いて.
    'v5k-s': { u: 'く', a: 'か', i: 'き', e: 'け', o: 'こ', te: 'って', ta: 'った' },
    // 問う, 請う, て/た forms keep the う.
    'v5u-s': { u: 'う', a: 'わ', i: 'い', e: 'え', o: 'お', te: 'うて', ta: 'うた' },
    // いらっしゃる, 下さる, the ます-stem is い, not り.
    'v5aru': { u: 'る', a: 'ら', i: 'い', e: 'れ', o: 'ろ', te: 'って', ta: 'った' }
  };

  Object.keys(GODAN).forEach(function (type) {
    var g = GODAN[type];
    var T = [type];

    rule(g.i + 'ます',   g.u, ['masu'],  T, 'polite');
    rule(g.a + 'ない',   g.u, ['adj-i'], T, 'negative');
    rule(g.a + 'ず',     g.u, [],        T, 'negative');
    rule(g.a + 'ずに',   g.u, [],        T, 'without doing');
    rule(g.te,           g.u, ['te'],    T, '-te');
    rule(g.ta,           g.u, ['ta'],    T, 'past');
    rule(g.e + 'る',     g.u, ['v1'],    T, 'potential');
    rule(g.a + 'れる',   g.u, ['v1'],    T, 'passive');
    rule(g.a + 'せる',   g.u, ['v1'],    T, 'causative');
    rule(g.a + 'す',     g.u, ['v5s'],   T, 'causative');
    rule(g.a + 'される', g.u, ['v1'],    T, 'causative passive');
    rule(g.e + 'ば',     g.u, [],        T, 'conditional');
    rule(g.o + 'う',     g.u, [],        T, 'volitional');
    rule(g.e,            g.u, [],        T, 'imperative');
    rule(g.i + 'たい',   g.u, ['adj-i'], T, 'want to');
    rule(g.i + 'たがる', g.u, ['v5r'],   T, 'want to');
    rule(g.i + 'ながら', g.u, [],        T, 'while');
    rule(g.i + 'すぎる', g.u, ['v1'],    T, 'too much');
    rule(g.i + 'そう',   g.u, [],        T, 'looks like');
    rule(g.i + 'やすい', g.u, ['adj-i'], T, 'easy to');
    rule(g.i + 'にくい', g.u, ['adj-i'], T, 'hard to');
    rule(g.i + 'かた',   g.u, ['n'],     T, 'way of doing');
    rule(g.i + 'なさい', g.u, [],        T, 'polite imperative');
    rule(g.i,            g.u, [],        T, 'masu stem');
  });

  // ---------------------------------------------------------------------
  // Ichidan (v1), the easy ones. Drop る, add the ending.
  // ---------------------------------------------------------------------
  ['v1', 'v1-s'].forEach(function (type) {
    var T = [type];
    rule('ます',       'る', ['masu'],  T, 'polite');
    rule('ない',       'る', ['adj-i'], T, 'negative');
    rule('ず',         'る', [],        T, 'negative');
    rule('ずに',       'る', [],        T, 'without doing');
    rule('て',         'る', ['te'],    T, '-te');
    rule('た',         'る', ['ta'],    T, 'past');
    rule('られる',     'る', ['v1'],    T, 'passive / potential');
    rule('れる',       'る', ['v1'],    T, 'potential');
    rule('させる',     'る', ['v1'],    T, 'causative');
    rule('させられる', 'る', ['v1'],    T, 'causative passive');
    rule('れば',       'る', [],        T, 'conditional');
    rule('よう',       'る', [],        T, 'volitional');
    rule('ろ',         'る', [],        T, 'imperative');
    rule('よ',         'る', [],        T, 'imperative');
    rule('たい',       'る', ['adj-i'], T, 'want to');
    rule('たがる',     'る', ['v5r'],   T, 'want to');
    rule('ながら',     'る', [],        T, 'while');
    rule('すぎる',     'る', ['v1'],    T, 'too much');
    rule('そう',       'る', [],        T, 'looks like');
    rule('やすい',     'る', ['adj-i'], T, 'easy to');
    rule('にくい',     'る', ['adj-i'], T, 'hard to');
    rule('かた',       'る', ['n'],     T, 'way of doing');
    rule('なさい',     'る', [],        T, 'polite imperative');
    rule('',           'る', [],        T, 'masu stem');
  });

  // ---------------------------------------------------------------------
  // する and 来る, the two genuinely irregular verbs.
  //
  // Note the last する rule strips it entirely: 勉強して -> 勉強する -> 勉強.
  // JMdict lists 勉強 as a noun tagged "vs" (can take する) rather than listing
  // 勉強する as its own entry, so we have to peel する off to find it.
  // ---------------------------------------------------------------------
  var SURU = ['vs-i', 'vs', 'vs-s'];
  rule('します',     'する', ['masu'],  SURU, 'polite');
  rule('しない',     'する', ['adj-i'], SURU, 'negative');
  rule('せず',       'する', [],        SURU, 'negative');
  rule('して',       'する', ['te'],    SURU, '-te');
  rule('した',       'する', ['ta'],    SURU, 'past');
  rule('される',     'する', ['v1'],    SURU, 'passive');
  rule('させる',     'する', ['v1'],    SURU, 'causative');
  rule('させられる', 'する', ['v1'],    SURU, 'causative passive');
  rule('できる',     'する', ['v1'],    SURU, 'potential');
  rule('すれば',     'する', [],        SURU, 'conditional');
  rule('しよう',     'する', [],        SURU, 'volitional');
  rule('しろ',       'する', [],        SURU, 'imperative');
  rule('せよ',       'する', [],        SURU, 'imperative');
  rule('したい',     'する', ['adj-i'], SURU, 'want to');
  rule('しながら',   'する', [],        SURU, 'while');
  rule('しすぎる',   'する', ['v1'],    SURU, 'too much');
  rule('しなさい',   'する', [],        SURU, 'polite imperative');
  rule('し',         'する', [],        SURU, 'masu stem');
  rule('する',       '',     SURU,      ['vs', 'vs-s', 'vs-i', 'n'], 'suru verb');

  // 来る is written either 来る or くる, and the stem vowel changes: き / こ / く.
  [['来', true], ['く', false]].forEach(function (pair) {
    var stem = pair[0];
    var kanji = pair[1];
    var i = kanji ? '来' : 'き';
    var o = kanji ? '来' : 'こ';
    var T = ['vk'];
    rule(i + 'ます',       stem + 'る', ['masu'],  T, 'polite');
    rule(o + 'ない',       stem + 'る', ['adj-i'], T, 'negative');
    rule(i + 'て',         stem + 'る', ['te'],    T, '-te');
    rule(i + 'た',         stem + 'る', ['ta'],    T, 'past');
    rule(o + 'られる',     stem + 'る', ['v1'],    T, 'passive / potential');
    rule(o + 'させる',     stem + 'る', ['v1'],    T, 'causative');
    rule(o + 'させられる', stem + 'る', ['v1'],    T, 'causative passive');
    rule(o + 'れば',       stem + 'る', [],        T, 'conditional');
    rule(o + 'よう',       stem + 'る', [],        T, 'volitional');
    rule(o + 'い',         stem + 'る', [],        T, 'imperative');
    rule(i + 'たい',       stem + 'る', ['adj-i'], T, 'want to');
    rule(i + 'ながら',     stem + 'る', [],        T, 'while');
    rule(i,                stem + 'る', [],        T, 'masu stem');
  });

  // ---------------------------------------------------------------------
  // Endings that stack on top of a て-form: 食べている, 読んでしまう ...
  // Each turns back into a plain て/で form, which the rules above then finish.
  // ---------------------------------------------------------------------
  [
    ['いる', 'v1', 'progressive'],
    ['る', 'v1', 'progressive'],
    ['おく', 'v5k', 'do in advance'],
    ['ある', 'v5r-i', 'resultant state'],
    ['いく', 'v5k-s', 'going on'],
    ['くる', 'vk', 'coming to be'],
    ['しまう', 'v5u', 'completely'],
    ['みる', 'v1', 'try doing'],
    ['ほしい', 'adj-i', 'want someone to']
  ].forEach(function (x) {
    rule('て' + x[0], 'て', [x[1]], ['te'], x[2]);
    rule('で' + x[0], 'で', [x[1]], ['te'], x[2]);
  });
  rule('ちゃう', 'て', ['v5u'], ['te'], 'completely');
  rule('じゃう', 'で', ['v5u'], ['te'], 'completely');
  rule('とく',   'て', ['v5k'], ['te'], 'do in advance');
  rule('どく',   'で', ['v5k'], ['te'], 'do in advance');
  rule('で',     'て', ['te'],  ['te'], '');   // normalise voiced て
  rule('だ',     'た', ['ta'],  ['ta'], '');   // normalise voiced た

  // ます / ません / ました ...
  rule('ません',       'ます', ['masu'], ['masu'], 'negative');
  rule('ました',       'ます', ['masu'], ['masu'], 'past');
  rule('ませんでした', 'ます', ['masu'], ['masu'], 'negative past');
  rule('ましょう',     'ます', ['masu'], ['masu'], 'volitional');
  rule('まして',       'ます', ['masu'], ['masu'], '-te');

  // ない conjugates exactly like an i-adjective.
  rule('なかった', 'ない', ['adj-i'], ['adj-i'], 'past');
  rule('なくて',   'ない', ['adj-i'], ['adj-i'], '-te');
  rule('なく',     'ない', ['adj-i'], ['adj-i'], 'adverbial');
  rule('なければ', 'ない', ['adj-i'], ['adj-i'], 'conditional');
  rule('なきゃ',   'ない', ['adj-i'], ['adj-i'], 'conditional');

  // た-form extras
  rule('たら',   'た', ['ta'], ['ta'], 'conditional');
  rule('だら',   'だ', ['ta'], ['ta'], 'conditional');
  rule('たり',   'た', ['ta'], ['ta'], 'listing actions');
  rule('だり',   'だ', ['ta'], ['ta'], 'listing actions');
  rule('たろう', 'た', ['ta'], ['ta'], 'presumptive');

  // ---------------------------------------------------------------------
  // I-adjectives
  // ---------------------------------------------------------------------
  rule('かった', 'い', ['adj-i'], ['adj-i'], 'past');
  rule('くない', 'い', ['adj-i'], ['adj-i'], 'negative');
  rule('くて',   'い', ['adj-i'], ['adj-i'], '-te');
  rule('く',     'い', [],        ['adj-i'], 'adverbial');
  rule('ければ', 'い', [],        ['adj-i'], 'conditional');
  rule('さ',     'い', ['n'],     ['adj-i'], 'noun form');
  rule('そう',   'い', [],        ['adj-i'], 'looks like');
  rule('すぎる', 'い', ['v1'],    ['adj-i'], 'too much');
  rule('げ',     'い', ['adj-na'], ['adj-i'], 'seeming');
  // いい / 良い is irregular: it conjugates as よい.
  rule('よかった', 'いい', ['adj-i'], ['adj-i'], 'past');
  rule('よくない', 'いい', ['adj-i'], ['adj-i'], 'negative');
  rule('よくて',   'いい', ['adj-i'], ['adj-i'], '-te');
  rule('良かった', '良い', ['adj-i'], ['adj-i'], 'past');
  rule('良くない', '良い', ['adj-i'], ['adj-i'], 'negative');

  // ---------------------------------------------------------------------
  // Na-adjectives and the copula
  // ---------------------------------------------------------------------
  // The copula does conjugate, as itself: でした is the past of です, だった
  // the past of だ. That is a copula becoming another copula, which is a very
  // different claim from a noun becoming one.
  var COP = ['cop'];
  rule('でした', 'です', COP, COP, 'past');
  rule('だった', 'だ',   COP, COP, 'past');

  // Nouns, though, are not here on purpose. です, だ, である and their negatives
  // are words in their own right, not endings a noun grows, and treating them
  // as endings meant every noun in the language could swallow whatever came
  // after it: 科である read as 科, さです as 差, とです as と. Two of those are
  // not even words anyone would say. Left alone, です is looked up as です,
  // which is what it is, and the noun before it stays a noun.

  // な (attributive) and に (adverbial) are different from the copula rules
  // above them: any noun at all takes です or だった (猫です, 猫だった), but
  // taking な or に as part of its own grammar is a na-adjective's trick
  // specifically, not a plain noun's, 元気 ("healthy") does it because it is
  // tagged both adj-na and n, but 猫 or ネカフェ, tagged only n, do not: 猫な
  // and 猫に are not standard Japanese, only 猫だ and 猫に(as the particle)
  // are. Restricted to plain 'n' as well as 'adj-na', this rule allowed any
  // noun immediately followed by に to be misread as that noun's own
  // adverbial form, so ネカフェに ("to the net cafe", noun + the ordinary
  // particle に) was being offered as one long match instead of the noun and
  // the particle after it.
  var ADJ_NA = ['adj-na'];
  rule('な', '', ADJ_NA, ADJ_NA, 'attributive');
  rule('に', '', ADJ_NA, ADJ_NA, 'adverbial');

  // Index the rules by their ending so lookups stay fast.
  var byEnding = new Map();
  var emptyFrom = [];
  rules.forEach(function (r) {
    if (r.from === '') { emptyFrom.push(r); return; }
    var list = byEnding.get(r.from);
    if (!list) { list = []; byEnding.set(r.from, list); }
    list.push(r);
  });
  var maxEndingLength = 0;
  byEnding.forEach(function (_, k) { if (k.length > maxEndingLength) maxEndingLength = k.length; });

  var MAX_DEPTH = 8;
  var MAX_RESULTS = 400;

  /**
   * Given a word as it appears in text, return every plausible dictionary form.
   * The first result is always the word itself, untouched.
   *
   * Each result is { term, types, reasons }:
   *   types , null means "could be anything"; otherwise the word must have
   *             one of these JMdict part-of-speech tags for the guess to count.
   *   reasons, how the dictionary form was built up into what the reader saw,
   *             innermost first: 食べなかった gives ["negative", "past"], i.e.
   *             食べる -> 食べない -> 食べなかった.
   */
  function deinflect(word) {
    var results = [{ term: word, types: null, reasons: [] }];
    var seen = new Set([word + ' *']);

    for (var i = 0; i < results.length && results.length < MAX_RESULTS; i++) {
      var cur = results[i];
      if (cur.reasons.length >= MAX_DEPTH) continue;

      var candidates = [];
      var limit = Math.min(maxEndingLength, cur.term.length);
      for (var len = 1; len <= limit; len++) {
        var list = byEnding.get(cur.term.slice(cur.term.length - len));
        if (list) candidates = candidates.concat(list);
      }
      if (cur.types === null) candidates = candidates.concat(emptyFrom);

      for (var j = 0; j < candidates.length; j++) {
        var r = candidates[j];
        if (cur.types !== null && !matches(r.tin, cur.types)) continue;

        var next = cur.term.slice(0, cur.term.length - r.from.length) + r.to;
        if (next.length === 0 || next.length > 40 || next === cur.term) continue;

        var key = next + ' ' + r.tout.join(',');
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

  function matches(tin, types) {
    for (var i = 0; i < tin.length; i++) {
      if (types.indexOf(tin[i]) !== -1) return true;
    }
    return false;
  }

  return { deinflect: deinflect, rules: rules, matches: matches };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LLLDeinflect;
