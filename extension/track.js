/*
 * Torval, whether it is keeping score
 *
 * Torval does two things, and only one of them is a dictionary.
 *
 * The other is the counting: marking a word known or ignored, colouring what
 * is left, and the percentage across the top saying how much of a page is
 * built from words you have. It is the part that makes Torval more than a
 * dictionary, and it is also the part that asks something of you first. A
 * word list starts empty, so the number is wrong until a few hundred words
 * have been marked, and somebody who only wanted to know what a word means
 * has been handed a chore they did not ask for and a percentage that lies to
 * them for a fortnight.
 *
 * So it is off until asked for. With it off, Torval is a pop-up dictionary
 * that makes Anki cards: hover, read, press +, nothing else. No bar on the
 * page, no colours, no ✓ and ⊘ in the popup, no daily copy of a list that
 * does not exist, and nothing at all to set up.
 *
 * Off by default, but never turned off under anybody. An install that
 * already has words in its list has already answered this question, and
 * background.js says so on the way past rather than take away what somebody
 * spent months building. See wakeTracking there.
 *
 * Read from storage rather than passed around, because the answer is wanted
 * in a content script, in the background and on the settings page at once,
 * and storage is the only thing all three share.
 */

'use strict';

var TorvalTrack = (function () {
  var api = (typeof browser !== 'undefined' && browser.storage) ? browser
    : (typeof chrome !== 'undefined' ? chrome : null);

  var KEY = 'trackWords';
  var on = false;
  var settled = null;
  var listeners = [];

  function isOn() { return on; }

  /**
   * Resolves once storage has answered, so a caller that must not guess can
   * wait. Everything else may read isOn() and be told again by onChange: a
   * page that drew itself a moment too early is put right rather than left
   * wrong, which is cheaper than making every reader wait.
   */
  function ready() {
    if (settled) return settled;
    settled = (async function () {
      if (!api || !api.storage) return on;
      try {
        var stored = await api.storage.local.get(KEY);
        apply(stored[KEY]);
      } catch (err) { /* no storage here; the default stands */ }
      return on;
    })();
    return settled;
  }

  function apply(value) {
    var next = !!value;
    if (next === on) return;
    on = next;
    listeners.forEach(function (fn) {
      try { fn(on); } catch (err) { /* one listener must not stop the rest */ }
    });
  }

  async function set(value) {
    apply(value);
    if (!api || !api.storage) return on;
    try {
      var write = {};
      write[KEY] = !!value;
      await api.storage.local.set(write);
    } catch (err) { /* nowhere to write it; it still holds for this page */ }
    return on;
  }

  function onChange(fn) {
    listeners.push(fn);
    return function () {
      var at = listeners.indexOf(fn);
      if (at !== -1) listeners.splice(at, 1);
    };
  }

  // A switch thrown on the settings page has to reach every page already
  // open, or somebody turns it on and wonders why the page they were
  // reading has not changed.
  if (api && api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[KEY]) return;
      apply(changes[KEY].newValue);
    });
  }

  ready();

  return { on: isOn, set: set, ready: ready, onChange: onChange, KEY: KEY };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalTrack;
