/*
 * LLL, which language is active
 *
 * LLL supports more than one language, but only ever reads in one of them at
 * a time: one dictionary, one deinflector, one word-boundary rule. Everything
 * that used to reach for `LLLJapanese`/`LLLMaxScan` directly now reaches for
 * `LLLLang.profile()` instead, which is whichever language is currently
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
 * anything that calls `LLLLang.profile()`. It does NOT need the deinflector,
 * the dictionary lookup module or the stress/pitch renderer to exist yet:
 * background.js, the only place that touches those, picks between them
 * itself with a plain check against `LLLLang.active()`, so their scripts can
 * load in any order relative to this one.
 */

var LLLLang = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;

  var registry = {};   // code -> { code, name, charClass, scanWindow, dbSuffix, dataPath }
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

if (typeof LLLJapanese === 'undefined' && typeof require !== 'undefined') {
  var LLLJapanese = require('./japanese.js');
}
if (typeof LLLMaxScan === 'undefined' && typeof require !== 'undefined') {
  var LLLMaxScan = require('./scan.js');
}
if (typeof LLLItalian === 'undefined' && typeof require !== 'undefined') {
  var LLLItalian = require('./italian.js');
}
if (typeof LLLItalianMaxScan === 'undefined' && typeof require !== 'undefined') {
  var LLLItalianMaxScan = require('./italian-scan.js');
}

/*
 * Is this page actually written in the language being read?
 *
 * Japanese never has to ask: its alphabet is its own, so text either has
 * Japanese characters in it or it does not, and the character class settles
 * it before anything else looks. Italian shares the Latin alphabet with the
 * page around it, and an ordinary English page does have Italian words on
 * it, because "in", "a", "no", "e" and "ago" (a needle) are all real entries
 * in an Italian dictionary. Finding one word is therefore no evidence at
 * all, and the bar used to appear on every English page in the browser.
 *
 * What separates the two is the proportion, not the presence. Running Italian
 * prose is very nearly all Italian words, eight or nine in ten even before
 * names and numbers are set aside; English prose scores a small fraction of
 * that, from the handful of short words the two languages happen to share.
 * So the question asked is how much of the passage was recognised, with a
 * floor under how long the passage has to be before the proportion means
 * anything: three words out of four is a sentence, not a language.
 */
var ITALIAN_WORD = /[A-Za-zÀ-ÖØ-öø-ÿ'\u2019]+/g;
var ITALIAN_ENOUGH = 0.55;
var ITALIAN_MINIMUM = 8;   // recognised words, below which the ratio is noise

function italianPlausible(text, matched) {
  if (!(matched >= ITALIAN_MINIMUM)) return false;
  var words = String(text || '').match(ITALIAN_WORD);
  if (!words || !words.length) return false;
  return matched / words.length >= ITALIAN_ENOUGH;
}

LLLLang.register({
  code: 'ja',
  name: 'Japanese',
  charClass: LLLJapanese,
  scanWindow: LLLMaxScan,
  dbSuffix: '',        // keeps the existing 'lll-dictionary' name and 'data/' path
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
  // examples on the Words page.
  examples: {
    inflected: 'たべました', lemma: '食べる',
    paste: '日本語のテキストをここに貼り付けてください…',
    known: '食べる', ignored: 'ネカフェ',
    ignoredKinds: 'Names, English, misreadings'
  }
});

LLLLang.register({
  code: 'it',
  name: 'Italian',
  charClass: LLLItalian,
  scanWindow: LLLItalianMaxScan,
  dbSuffix: '-it',
  dataPath: 'data-it',
  storageSuffix: '_it',
  // Italian puts a space between every pair of words, so there is never a
  // seam to show and the dashed underline would only be noise.
  seams: false,
  subtitles: ['it', 'it-IT'],
  plausible: italianPlausible,
  examples: {
    inflected: 'parlavamo', lemma: 'parlare',
    paste: 'Incolla qui un testo italiano…',
    known: 'parlare', ignored: 'Giuseppe',
    ignoredKinds: 'Names, foreign words, misreadings'
  }
});

if (typeof module !== 'undefined' && module.exports) module.exports = LLLLang;
