/*
 * Torval, which language is active
 *
 * Torval supports more than one language, but only ever reads in one of them at
 * a time: one dictionary, one deinflector, one word-boundary rule. Everything
 * that used to reach for `TorvalJapanese`/`TorvalMaxScan` directly now reaches for
 * `TorvalLang.profile()` instead, which is whichever language is currently
 * selected.
 *
 * The active language lives in `storage.local` under `activeLanguage`, read
 * once at load and kept in sync after that exactly the way `off` already is
 * in content.js/background.js: a change on one tab reaches every open page
 * without anybody having to reload.
 *
 * Registration happens once each language's own file has defined its pieces
 * (the char-class regex, the scan window), at the bottom of this file, so
 * `lang.js` has to load after `japanese.js`/`scan.js`/`italian.js` and before
 * anything that calls `TorvalLang.profile()`. It does NOT need the deinflector,
 * the dictionary lookup module or the stress/pitch renderer to exist yet:
 * background.js, the only place that touches those, picks between them
 * itself with a plain check against `TorvalLang.active()`, so their scripts can
 * load in any order relative to this one.
 */

var TorvalLang = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;

  // code -> a profile; see the registrations at the bottom of this file for
  // what is in one.
  var registry = {};
  var order = [];
  var current = 'ja';  // the language every existing install already has, unasked
  var listeners = [];

  function register(profile) {
    registry[profile.code] = profile;
    order.push(profile.code);
  }

  /** The registered profile for a code, or the active one if the code is unknown. */
  function get(code) {
    return registry[code] || registry[current] || null;
  }

  /** Every registered language, in registration order, for the picker UI. */
  function list() {
    return order.map(function (code) { return { code: code, name: registry[code].name }; });
  }

  /** The active language's code. Synchronous: always answers from the cache. */
  function active() { return current; }

  /** The active language's profile. Synchronous, same reason. */
  function profile() { return get(current); }

  /** Called whenever the active language changes, with the new code. */
  function onChange(fn) { listeners.push(fn); }

  function applyStored(value) {
    var next = (value && registry[value]) ? value : current;
    if (next === current) return;
    current = next;
    listeners.forEach(function (fn) {
      try { fn(current); } catch (err) { /* one bad listener should not sink the rest */ }
    });
  }

  // Resolves once the real stored choice, if any, has been read, so a caller
  // that needs to know the right answer before doing anything (background.js
  // opening a dictionary, above all) can await it instead of racing the 'ja'
  // default against storage.
  var initDone;
  var initPromise = new Promise(function (resolve) { initDone = resolve; });

  if (api && api.storage && api.storage.local) {
    api.storage.local.get('activeLanguage').then(function (stored) {
      applyStored(stored.activeLanguage);
      initDone();
    }).catch(function () { initDone(); });

    if (api.storage.onChanged) {
      api.storage.onChanged.addListener(function (changes) {
        if (!changes.activeLanguage) return;
        applyStored(changes.activeLanguage.newValue);
      });
    }
  } else {
    initDone();
  }

  function ready() { return initPromise; }

  /** Switch language. Writes storage; every open tab picks it up via onChanged. */
  async function set(code) {
    if (!registry[code]) throw new Error('Unknown language: ' + code);
    await api.storage.local.set({ activeLanguage: code });
    applyStored(code);
  }

  /** Has anybody ever chosen a language, or is this a fresh install? */
  async function chosen() {
    var stored = await api.storage.local.get('activeLanguage');
    return !!stored.activeLanguage;
  }

  return {
    register: register,
    get: get,
    list: list,
    active: active,
    profile: profile,
    onChange: onChange,
    set: set,
    chosen: chosen,
    ready: ready,
    // Exposed so the tests can pick a language without waiting on storage.
    _setActive: function (code) { applyStored(code); }
  };
})();

if (typeof TorvalJapanese === 'undefined' && typeof require !== 'undefined') {
  var TorvalJapanese = require('./japanese.js');
}
if (typeof TorvalMaxScan === 'undefined' && typeof require !== 'undefined') {
  var TorvalMaxScan = require('./scan.js');
}
if (typeof TorvalItalian === 'undefined' && typeof require !== 'undefined') {
  var TorvalItalian = require('./italian.js');
}
if (typeof TorvalItalianMaxScan === 'undefined' && typeof require !== 'undefined') {
  var TorvalItalianMaxScan = require('./italian-scan.js');
}
if (typeof TorvalSpanish === 'undefined' && typeof require !== 'undefined') {
  var TorvalSpanish = require('./spanish.js');
}
if (typeof TorvalSpanishMaxScan === 'undefined' && typeof require !== 'undefined') {
  var TorvalSpanishMaxScan = require('./spanish-scan.js');
}

/*
 * A language's deinflector and lookup engine, fetched when they are wanted
 * rather than held on the profile.
 *
 * lang.js has to load before anything that asks which language is active,
 * which means before the deinflectors and the lookup engines exist; the
 * comment at the top of this file says so, and the load order in
 * manifest.json depends on it. A profile therefore cannot hold a reference
 * to TorvalDeinflectEs, there is no such thing yet when this file runs. It
 * holds a function that goes and finds it, called from the background
 * script, by which time everything is loaded.
 *
 * They are also genuinely absent in the content scripts, which load the
 * profiles but none of the lookup machinery, so asking for one there
 * answers null rather than throwing: nothing in a page ever asks.
 */
function lazy(name) {
  return function () {
    var scope = typeof globalThis !== 'undefined' ? globalThis : null;
    if (scope && scope[name]) return scope[name];
    if (typeof require !== 'undefined') {
      try { return require('./' + FILES[name]); } catch (err) { /* not here */ }
    }
    return null;
  };
}

// Only for the test suite and any other Node caller, where a global is not
// how a module arrives.
var FILES = {
  TorvalDeinflect: 'deinflect.js',
  TorvalDeinflectIt: 'deinflect-it.js',
  TorvalDeinflectEs: 'deinflect-es.js',
  TorvalLookup: 'lookup.js',
  TorvalLookupLatin: 'lookup-latin.js'
};

/*
 * Is this page actually written in the language being read?
 *
 * Japanese never has to ask: its alphabet is its own, so text either has
 * Japanese characters in it or it does not, and the character class settles
 * it before anything else looks. Italian and Spanish share the Latin
 * alphabet with the page around it, and an ordinary English page does have
 * Italian words on it, because "in", "a", "no", "e" and "ago" (a needle)
 * are all real entries in an Italian dictionary. Finding one word is
 * therefore no evidence at all, and the bar used to appear on every English
 * page in the browser.
 *
 * What separates the two is the proportion, not the presence. Running Italian
 * prose is very nearly all Italian words, eight or nine in ten even before
 * names and numbers are set aside; English prose scores a small fraction of
 * that, from the handful of short words the two languages happen to share.
 * So the question asked is how much of the passage was recognised, with a
 * floor under how long the passage has to be before the proportion means
 * anything: three words out of four is a sentence, not a language.
 */
var LATIN_WORD = /[A-Za-zÀ-ÖØ-öø-ÿ'\u2019]+/g;
var LATIN_ENOUGH = 0.55;
var LATIN_MINIMUM = 8;   // recognised words, below which the ratio is noise

function latinPlausible(text, matched) {
  if (!(matched >= LATIN_MINIMUM)) return false;
  var words = String(text || '').match(LATIN_WORD);
  if (!words || !words.length) return false;
  return matched / words.length >= LATIN_ENOUGH;
}

TorvalLang.register({
  code: 'ja',
  name: 'Japanese',
  charClass: TorvalJapanese,
  scanWindow: TorvalMaxScan,
  // Which lookup engine reads this language, and which deinflector it uses.
  // Both are fetched rather than held; see the note on global() above.
  lookup: lazy('TorvalLookup'),
  deinflector: lazy('TorvalDeinflect'),
  // Japanese is the one language here with lexical pitch, so it is the one
  // that shows a pitch diagram; the others mark the stressed vowel instead.
  // The Anki settings page offers whichever of the two this is.
  accent: 'pitch',
  // A card can carry a recording of the word. Japanese gets its from
  // JapanesePod101, which will answer about any Japanese word and has to be
  // caught out when it has nothing; the other two carry the answer on the
  // dictionary entry instead and so never ask in vain. See fetchAudio in
  // anki.js.
  audio: true,
  // Named in the error when the built data is missing.
  build: 'node tools/build-dict.mjs',
  dbSuffix: '',        // keeps the existing 'torval-dictionary' name and 'data/' path
  dataPath: 'data',
  storageSuffix: '',   // keeps the existing unsuffixed storage keys
  // Japanese runs two words together with nothing between them, so the
  // colouring alternates solid and dashed underlines to show the seam. See
  // the note in highlight.js.
  seams: true,
  // The subtitle tracks worth fetching on a video page, most preferred
  // first. Both spellings: YouTube labels the same track either way.
  subtitles: ['ja', 'ja-JP'],
  // Every Japanese character is evidence: a page with kanji on it is a page
  // worth reading, and a page without any never reaches the dictionary at
  // all, because the character class rejects it first. So there is nothing
  // further to decide here.
  plausible: function () { return true; },
  // What a word is written with, in that language's own script, for the
  // placeholders on the Words page.
  examples: {
    paste: '日本語のテキストをここに貼り付けてください…',
    known: '食べる', ignored: 'ネカフェ',
    ignoredKinds: 'Names, English, misreadings'
  }
});

TorvalLang.register({
  code: 'it',
  name: 'Italian',
  charClass: TorvalItalian,
  scanWindow: TorvalItalianMaxScan,
  lookup: lazy('TorvalLookupLatin'),
  deinflector: lazy('TorvalDeinflectIt'),
  accent: 'stress',
  audio: true,
  // Recordings come from Lingua Libre, by way of Wikimedia Commons: real
  // people reading their own language a word at a time, CC BY-SA. Which
  // words have one is settled at build time and stored on the entry; these
  // two constants are the rest of what a Commons filename is made of. See
  // tools/build-audio.mjs and voiceUrl in anki.js.
  voice: { qid: 'Q652', iso: 'ita' },
  build: 'node tools/build-dict-it.mjs',
  dbSuffix: '-it',
  dataPath: 'data-it',
  storageSuffix: '_it',
  // Italian puts a space between every pair of words, so there is never a
  // seam to show and the dashed underline would only be noise.
  seams: false,
  subtitles: ['it', 'it-IT'],
  plausible: latinPlausible,
  examples: {
    paste: 'Incolla qui un testo italiano…',
    known: 'parlare', ignored: 'Giuseppe',
    ignoredKinds: 'Names, foreign words, misreadings'
  }
});

/*
 * Is this page actually written in Spanish?
 *
 * The same problem Italian has, and the same answer, for the same reason:
 * Spanish shares the Latin alphabet with the page around it, and "no", "a",
 * "son", "van", "la" and "sin" are all real Spanish words that turn up in
 * ordinary English text. One word is no evidence; the proportion is. The
 * two languages use one function between them, since what it measures, how
 * much of the passage the dictionary recognised, is not specific to either.
 *
 * Spanish and Italian are also each other's worst case here: they share a
 * great deal of vocabulary, so an Italian page will score respectably
 * against a Spanish dictionary and the other way round. That is a real
 * limit and not one a ratio can fix. It costs nothing worse than the bar
 * appearing on a page in the wrong Romance language, which the reader can
 * see at a glance and Torval cannot.
 */
TorvalLang.register({
  code: 'es',
  name: 'Spanish',
  charClass: TorvalSpanish,
  scanWindow: TorvalSpanishMaxScan,
  lookup: lazy('TorvalLookupLatin'),
  deinflector: lazy('TorvalDeinflectEs'),
  accent: 'stress',
  audio: true,
  // Recordings come from Lingua Libre, by way of Wikimedia Commons: real
  // people reading their own language a word at a time, CC BY-SA. Which
  // words have one is settled at build time and stored on the entry; these
  // two constants are the rest of what a Commons filename is made of. See
  // tools/build-audio.mjs and voiceUrl in anki.js.
  voice: { qid: 'Q1321', iso: 'spa' },
  build: 'node tools/build-dict-es.mjs',
  dbSuffix: '-es',
  dataPath: 'data-es',
  storageSuffix: '_es',
  // Spanish puts a space between every pair of words, so there is never a
  // seam to show and the dashed underline would only be noise.
  seams: false,
  // Latin America and Spain label the same track differently, and a video
  // may offer either or both. es-419 is Wikipedia-style "Latin American
  // Spanish", which is what most streaming sites actually ship.
  subtitles: ['es', 'es-ES', 'es-419', 'es-MX', 'es-US'],
  plausible: latinPlausible,
  examples: {
    paste: 'Pega aquí un texto en español…',
    known: 'hablar', ignored: 'Guillermo',
    ignoredKinds: 'Names, foreign words, misreadings'
  }
});

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalLang;
