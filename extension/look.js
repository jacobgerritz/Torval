/*
 * Torval, how it looks
 *
 * Four settings, because four is what there is a real answer to. Everything
 * else about the popup and the subtitles is a decision already made in
 * popup.css and in ensureOverlay, and a settings page that offers to undo
 * every one of them is a settings page nobody finishes reading.
 *
 * What is here is the four where people genuinely differ and no default can
 * be right for everybody: how big a subtitle should be, whether it should
 * sit in a box at all, and how big and how wide the popup should be. The
 * first two are about the room you are in and the screen you are sitting
 * at; the second two are about your eyes.
 *
 * Stored the same way the shortcuts are, and for the same reasons: only
 * what has been changed is written down, so an empty setting means the
 * defaults and resetting is deleting rather than writing four values back.
 * Read synchronously from a copy kept in memory, because the popup is built
 * in the middle of a mousemove and cannot wait for storage; the defaults
 * are in place from the first line of script and whatever was saved arrives
 * a moment later and replaces them.
 */

var TorvalLook = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;
  var STORED = 'appearance';

  /*
   * Each setting, its choices, and which of them is the default.
   *
   * `value` is what the code downstream actually uses, and it is kept here
   * rather than worked out at the point of use so that the settings page
   * and the thing being styled cannot drift apart: the page renders this
   * table, and subtitles.js and content.js read this table.
   */
  var SETTINGS = [
    {
      name: 'subtitleSize',
      label: 'Subtitle size',
      where: 'Subtitles',
      fallback: 'normal',
      // A multiplier on the share of the player a line takes up. Not a
      // pixel size: a subtitle that stays the same size whatever it is
      // sitting in is small in fullscreen and large in a corner window.
      choices: [
        { value: 'small', label: 'Small', scale: 0.8 },
        { value: 'normal', label: 'Normal', scale: 1 },
        { value: 'large', label: 'Large', scale: 1.25 },
        { value: 'huge', label: 'Very large', scale: 1.5 }
      ]
    },
    {
      name: 'subtitleBackdrop',
      label: 'Subtitle background',
      where: 'Subtitles',
      fallback: 'none',
      // Straight onto the picture, with the text outlined, which is what
      // every other player in the world does and what looks best over a
      // film. The two backed options are there for anybody who would
      // rather have the line fenced off from the picture, and Torval's own
      // box additionally says where the line can be hovered.
      //
      // Listed with the default first, and named for what they look like
      // rather than for what they are made of: "None" described the
      // implementation, and nobody choosing between three pictures wants
      // the one labelled none.
      choices: [
        { value: 'none', label: 'Transparent' },
        { value: 'shaded', label: 'Shaded' },
        { value: 'box', label: 'Box' }
      ]
    },
    {
      name: 'popupSize',
      label: 'Pop-up text size',
      where: 'Pop-up dictionary',
      fallback: 'normal',
      // The unit every size in popup.css is written as a multiple of, so
      // one number moves all of them together and none of them compound.
      choices: [
        { value: 'small', label: 'Small', unit: 0.88 },
        { value: 'normal', label: 'Normal', unit: 1 },
        { value: 'large', label: 'Large', unit: 1.15 },
        { value: 'huge', label: 'Very large', unit: 1.3 }
      ]
    },
    {
      name: 'popupWidth',
      label: 'Pop-up width',
      where: 'Pop-up dictionary',
      fallback: 'normal',
      choices: [
        { value: 'narrow', label: 'Narrow', px: 320 },
        { value: 'normal', label: 'Normal', px: 400 },
        { value: 'wide', label: 'Wide', px: 520 }
      ]
    }
  ];

  var chosen = {};       // only what has been changed from the default
  var listeners = [];

  function settingNamed(name) {
    for (var i = 0; i < SETTINGS.length; i++) {
      if (SETTINGS[i].name === name) return SETTINGS[i];
    }
    return null;
  }

  /** Which choice is in force for one setting, as the whole choice object. */
  function get(name) {
    var setting = settingNamed(name);
    if (!setting) return null;
    var want = Object.prototype.hasOwnProperty.call(chosen, name)
      ? chosen[name] : setting.fallback;
    for (var i = 0; i < setting.choices.length; i++) {
      if (setting.choices[i].value === want) return setting.choices[i];
    }
    // Saved under a name this version no longer has: fall back rather than
    // hand back nothing, since every caller is about to read a number off it.
    for (var j = 0; j < setting.choices.length; j++) {
      if (setting.choices[j].value === setting.fallback) return setting.choices[j];
    }
    return setting.choices[0];
  }

  /** Every setting and where it stands, for the settings page. */
  function all() {
    return SETTINGS.map(function (setting) {
      var now = get(setting.name);
      return {
        name: setting.name, label: setting.label, where: setting.where,
        choices: setting.choices.map(function (c) {
          return { value: c.value, label: c.label };
        }),
        value: now.value, isDefault: now.value === setting.fallback
      };
    });
  }

  /** The headings the settings page groups them under, in order. */
  function groups() {
    var seen = [];
    for (var i = 0; i < SETTINGS.length; i++) {
      if (seen.indexOf(SETTINGS[i].where) === -1) seen.push(SETTINGS[i].where);
    }
    return seen;
  }

  async function set(name, value) {
    var setting = settingNamed(name);
    if (!setting) return false;
    var known = setting.choices.some(function (c) { return c.value === value; });
    if (!known) return false;
    var next = Object.assign({}, chosen);
    if (value === setting.fallback) delete next[name]; else next[name] = value;
    apply(next);
    await remember(next);
    return true;
  }

  async function reset() {
    apply({});
    if (!api || !api.storage) return;
    await api.storage.local.remove(STORED).catch(function () {});
  }

  /*
   * Writing it down, where there is somewhere to write it.
   *
   * Guarded rather than assumed: this module is read by the popup, by the
   * subtitles, by the settings page and by the tests, and the last of
   * those has no extension API behind it at all. A settings module that
   * throws when it cannot save is a settings module that takes the popup
   * down with it.
   */
  async function remember(next) {
    if (!api || !api.storage) return;
    await api.storage.local.set({ appearance: next }).catch(function () {});
  }

  function apply(next) {
    chosen = next || {};
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (err) { /* one listener is not the others */ }
    }
  }

  /**
   * Put the popup's two settings onto an element as custom properties.
   *
   * popup.css writes every size as a multiple of --torval-u rather than in
   * pixels, so one number here moves all of them at once and none of them
   * compound the way nested `em` would.
   */
  function dressPopup(el) {
    if (!el || !el.style) return;
    el.style.setProperty('--torval-u', get('popupSize').unit + 'px');
    el.style.setProperty('--torval-popup-width', get('popupWidth').px + 'px');
  }

  /**
   * How a subtitle line should be painted, as the three declarations that
   * differ between the choices. Returned rather than applied, because the
   * overlay builds its style as one cssText string and this is one part of
   * it.
   *
   * "Shaded" and "None" both drop the box; what keeps the words readable
   * over a bright picture is the outline, which is what every player falls
   * back on and what television captions have always done.
   */
  function subtitleSkin() {
    var how = get('subtitleBackdrop').value;
    if (how === 'box') {
      return {
        background: '#16171a',
        border: '1px solid #292b30',
        boxShadow: '0 8px 28px rgba(0,0,0,.5)',
        textShadow: 'none'
      };
    }
    return {
      background: how === 'shaded' ? 'rgba(10,11,13,.55)' : 'transparent',
      border: '1px solid transparent',
      boxShadow: 'none',
      // Four offsets rather than a blur: a blurred shadow under white text
      // goes grey and muddy at subtitle sizes, while a hard outline stays
      // an outline whatever it is sitting on.
      textShadow: '0 1px 2px rgba(0,0,0,.9), 0 -1px 2px rgba(0,0,0,.9), ' +
        '1px 0 2px rgba(0,0,0,.9), -1px 0 2px rgba(0,0,0,.9)'
    };
  }

  /** The multiplier on how much of the player one line of subtitle takes. */
  function subtitleScale() { return get('subtitleSize').scale; }

  var loaded = api && api.storage
    ? api.storage.local.get(STORED).then(function (stored) {
      if (stored && stored[STORED]) apply(stored[STORED]);
    }).catch(function () {})
    : Promise.resolve();

  // A change made in the settings reaches a page that is already open,
  // the same way the on/off switch and the shortcuts do. Nobody should
  // have to reload a video to see a subtitle get bigger.
  if (api && api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes[STORED]) return;
      apply(changes[STORED].newValue || {});
    });
  }

  return {
    SETTINGS: SETTINGS,
    get: get,
    all: all,
    groups: groups,
    set: set,
    reset: reset,
    dressPopup: dressPopup,
    subtitleSkin: subtitleSkin,
    subtitleScale: subtitleScale,
    onChange: function (fn) { listeners.push(fn); },
    ready: function () { return loaded; },
    // For the tests, which have no storage behind them.
    _setAll: function (map) { apply(map || {}); }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalLook;
