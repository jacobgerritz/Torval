/*
 * Torval, the language the reader already has
 *
 * Separate from the language being studied, and deliberately so: which
 * language somebody reads a settings page in does not follow from which
 * one they are learning.
 *
 * English is the only one on offer today. A full Spanish interface, and
 * the English to Spanish dictionary that went with it, are written and
 * working on the `english-for-spanish` branch; they are not shipped
 * because they were not good enough yet. The machinery stays here so that
 * turning them back on is a table and a line in lang.js rather than a
 * rewrite: pages mark their text with data-t="key" and call paint() once
 * the stored choice has loaded, and strings built in script ask for
 * t('key') instead. With one language every one of those falls back to
 * what the page already says, which is the English.
 */
var TorvalUI = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;

  var LANGUAGES = [
    { code: 'en', name: 'English' }
  ];

  // English is the language the pages are written in, so it needs no
  // table: t() falls back to what the markup already says. Spanish had one
  // of some ninety lines, kept on the `english-for-spanish` branch.
  var STRINGS = { en: {} };

  var current = 'en';

  /**
   * The stored choice, or English. Pages await this before painting.
   *
   * Written to survive anything storage does, because this is called at
   * the top level of the content script: a throw here takes the whole of
   * Torval off the page, bar and popup and all, on every site. It threw
   * once, when `get` answered through a callback rather than with a
   * promise and there was nothing to call `.then` on.
   */
  function load() {
    return new Promise(function (done) {
      if (!api || !api.storage || !api.storage.local) return done(current);
      var answer;
      try {
        answer = api.storage.local.get('uiLanguage', function (stored) {
          done(keep(stored));
        });
      } catch (err) {
        return done(current);
      }
      // Firefox, and Chrome when no callback is taken: the same call hands
      // back a promise instead of answering the callback.
      if (answer && typeof answer.then === 'function') {
        answer.then(function (stored) { done(keep(stored)); },
          function () { done(current); });
      }
    });
  }

  function keep(stored) {
    var next = stored && stored.uiLanguage;
    if (next && STRINGS[next]) current = next;
    return current;
  }

  function code() { return current; }

  // A background page lives for hours and would otherwise answer with
  // whatever was stored when it woke. The settings page writes this key
  // and the popup reads it back a moment later.
  try {
    if (api && api.storage && api.storage.onChanged) {
      api.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes.uiLanguage) return;
        var next = changes.uiLanguage.newValue;
        if (STRINGS[next]) current = next;
      });
    }
  } catch (err) { /* no listener; the stored value is read at load anyway */ }

  function set(next) {
    current = STRINGS[next] ? next : 'en';
    try {
      if (api && api.storage && api.storage.local) {
        api.storage.local.set({ uiLanguage: current });
      }
    } catch (err) { /* the choice still holds for this page */ }
    return current;
  }

  /**
   * One string. Untranslated keys fall back to whatever the page already
   * says, which for English is the right answer and for a missing Spanish
   * line is better than a blank.
   */
  function t(key, fallback, fill) {
    var table = STRINGS[current];
    var text = (table && table[key]) || fallback || '';
    if (fill) {
      Object.keys(fill).forEach(function (name) {
        text = text.split('{' + name + '}').join(fill[name]);
      });
    }
    return text;
  }

  /**
   * Fill every marked element. data-t sets the text, data-t-title the
   * tooltip, data-t-placeholder the placeholder, so one attribute per thing
   * that can be worded rather than a parallel markup scheme.
   */
  function paint(root) {
    var where = root || document;
    if (current === 'en') return;   // the page is already written in it
    where.querySelectorAll('[data-t]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-t'), el.textContent);
    });
    where.querySelectorAll('[data-t-title]').forEach(function (el) {
      el.title = t(el.getAttribute('data-t-title'), el.title);
    });
    where.querySelectorAll('[data-t-placeholder]').forEach(function (el) {
      el.placeholder = t(el.getAttribute('data-t-placeholder'), el.placeholder);
    });
  }

  return {
    languages: LANGUAGES,
    load: load,
    code: code,
    set: set,
    t: t,
    paint: paint,
    _strings: STRINGS
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalUI;
