/*
 * Torval, what it says out loud
 *
 * Getting subtitles out of YouTube is not one request, it is a chain of
 * four or five, each tried in turn until one answers, and every link in it
 * used to narrate itself. On a video where the first three failed and the
 * fourth worked, which is an ordinary video, that was a dozen lines in the
 * console before anything appeared on screen. It was written that way on
 * purpose and it earned its keep: nearly every fix to that chain started
 * with reading it.
 *
 * It is the wrong default for somebody who just installed a dictionary,
 * though. The console belongs to the page, and filling it is both rude to
 * whoever is debugging that page and a good way to look broken while
 * working perfectly, since most of those lines are a step failing on the
 * way to a step succeeding.
 *
 * So the running commentary is off unless it is asked for, and what is
 * left is what somebody could act on: Torval could not load its
 * dictionary, this video has no Italian subtitles, the word lists could
 * not be saved.
 *
 * The rest is a checkbox on the About page, which is the first thing to
 * ask for when somebody reports that a video's subtitles never arrived.
 * It is a setting rather than a console command because a content script
 * runs in a world of its own, and telling somebody to find that world in
 * their devtools is telling them not to bother. It is remembered, so a
 * page reloaded to reproduce something still says everything, and it is
 * one setting shared by every context at once.
 */

var TorvalLog = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;
  var STORED = 'verboseLog';
  var loud = false;

  if (api && api.storage && api.storage.local) {
    api.storage.local.get(STORED).then(function (stored) {
      loud = !!(stored && stored[STORED]);
    }).catch(function () {});
    if (api.storage.onChanged) {
      api.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes[STORED]) return;
        loud = !!changes[STORED].newValue;
      });
    }
  }

  /** The running commentary. Silent unless somebody asked for it. */
  function say() {
    if (!loud) return;
    console.log.apply(console, arguments);
  }

  /** Something went wrong that whoever is reading can do something about. */
  function warn() {
    console.warn.apply(console, arguments);
  }

  /** Something went wrong that nobody can do anything about. */
  function fail() {
    console.error.apply(console, arguments);
  }

  return {
    say: say,
    warn: warn,
    fail: fail,
    verbose: function (on) {
      loud = !!on;
      if (api && api.storage && api.storage.local) {
        var write = {};
        write[STORED] = loud;
        api.storage.local.set(write).catch(function () {});
      }
      return loud;
    },
    isVerbose: function () { return loud; }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalLog;
