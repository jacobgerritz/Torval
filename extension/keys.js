/*
 * Torval, the keys
 *
 * Seven keys, and until now all seven were written into the code that
 * listens for them. That is fine until one of them is a key the page
 * underneath wants: B is a bold shortcut in every editor there is, A and D
 * move you around in more than one player, and Shift is used for all sorts
 * of things. A shortcut you cannot change is a shortcut that eventually
 * makes a page unusable.
 *
 * So the seven live here instead, in one table, and the settings page
 * renders that table rather than repeating it. Adding an eighth means
 * adding a row here and nothing else.
 *
 * What is stored is only what has been changed: an empty setting means the
 * defaults, and resetting is deleting rather than writing seven values back.
 *
 * Reading this is deliberately synchronous. A keydown handler cannot wait
 * for storage, so the defaults are in place from the first line of script
 * and whatever was saved arrives a moment later and replaces them. The
 * worst case is the first keypress in the first few milliseconds of a page
 * using a default, which nobody has ever managed to do on purpose.
 */

var TorvalKeys = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;
  var STORED = 'shortcuts';

  /*
   * Every key Torval listens for, in the order the settings page shows them.
   *
   * `hold` marks the one that is held rather than pressed, which is the only
   * one that has to be a modifier and the only one offered as a choice
   * between three rather than as any key you like.
   */
  var ACTIONS = [
    { name: 'lookup', label: 'Hold to look a word up', fallback: 'Shift',
      hold: true, choices: ['Shift', 'Alt', 'Control'] },
    { name: 'unknown', label: 'Mark as not known', fallback: '1' },
    { name: 'known', label: 'Mark as known', fallback: '2' },
    { name: 'ignored', label: 'Ignore the word', fallback: '3' },
    { name: 'browse', label: 'Find it in Anki', fallback: 'b' },
    { name: 'back', label: 'Previous subtitle line', fallback: 'a' },
    { name: 'forward', label: 'Next subtitle line', fallback: 'd' }
  ];

  var chosen = {};       // only what has been changed from the default

  function fallbackFor(name) {
    for (var i = 0; i < ACTIONS.length; i++) {
      if (ACTIONS[i].name === name) return ACTIONS[i].fallback;
    }
    return '';
  }

  /** The key for one action, whatever it is set to now. */
  function get(name) {
    return Object.prototype.hasOwnProperty.call(chosen, name)
      ? chosen[name] : fallbackFor(name);
  }

  /** Every action and its key, for the settings page. */
  function all() {
    return ACTIONS.map(function (action) {
      return {
        name: action.name, label: action.label,
        hold: !!action.hold, choices: action.choices || null,
        key: get(action.name), isDefault: get(action.name) === action.fallback
      };
    });
  }

  /**
   * Does this keydown mean this action?
   *
   * A letter is compared without regard to case, because the shift key is
   * held down for plenty of reasons and B with it down is still B. A named
   * key (Shift, Alt, Enter) is compared exactly, since those are spelled
   * one way.
   */
  function matches(name, e) {
    var want = get(name);
    if (!want) return false;
    var got = (e && e.key) || '';
    return got.length === 1 ? got.toLowerCase() === want.toLowerCase() : got === want;
  }

  /** Whoever else already answers to this key, or null. */
  function clash(name, key) {
    for (var i = 0; i < ACTIONS.length; i++) {
      var other = ACTIONS[i];
      if (other.name === name) continue;
      if (same(get(other.name), key)) return other.label;
    }
    return null;
  }

  function same(a, b) {
    if (!a || !b) return false;
    return a.length === 1 && b.length === 1
      ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  /** As it should be written on a button. */
  function label(key) {
    if (!key) return '';
    return key.length === 1 ? key.toUpperCase() : key;
  }

  /**
   * Is this a key somebody could mean? Anything printable, or one of the
   * three held keys. Not Escape, which closes the popup everywhere and is
   * not Torval's to hand out, and not a bare Tab or Enter, which would take
   * the settings page's own keyboard away from it.
   */
  var RESERVED = ['Escape', 'Tab', 'Enter', ' '];

  function usable(key, action) {
    if (!key) return false;
    if (action && action.hold) return (action.choices || []).indexOf(key) !== -1;
    if (RESERVED.indexOf(key) !== -1) return false;
    return key.length === 1;
  }

  function actionNamed(name) {
    for (var i = 0; i < ACTIONS.length; i++) if (ACTIONS[i].name === name) return ACTIONS[i];
    return null;
  }

  async function set(name, key) {
    var action = actionNamed(name);
    if (!action || !usable(key, action)) return false;
    var next = Object.assign({}, chosen);
    if (key === action.fallback) delete next[name]; else next[name] = key;
    chosen = next;
    await api.storage.local.set({ shortcuts: next }).catch(function () {});
    return true;
  }

  async function reset() {
    chosen = {};
    await api.storage.local.remove(STORED).catch(function () {});
  }

  // Filled in as soon as storage answers, and kept up to date afterwards so
  // that a page already open follows a change made in the settings without
  // being reloaded, the same way the on/off switch does.
  var loaded = api && api.storage
    ? api.storage.local.get(STORED).then(function (stored) {
      if (stored && stored[STORED]) chosen = stored[STORED];
    }).catch(function () {})
    : Promise.resolve();

  if (api && api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[STORED]) return;
      chosen = changes[STORED].newValue || {};
    });
  }

  return {
    ACTIONS: ACTIONS,
    get: get,
    all: all,
    set: set,
    reset: reset,
    matches: matches,
    clash: clash,
    label: label,
    usable: usable,
    ready: function () { return loaded; },
    // For the tests, which have no storage behind them.
    _setAll: function (map) { chosen = map || {}; }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalKeys;
