/*
 * The Netflix end of things, on LLL's side of the page.
 *
 * Two jobs, both about the player rather than about the words.
 *
 * It holds the subtitle file. netflix-page.js catches that, running as page
 * code because it has to; all it can do with what it caught is post it
 * through the window the two of them share, and this is what listens.
 *
 * And it seeks. Setting `currentTime` on the video element, which is how A
 * and D move on every other site, does not work here: Netflix streams in
 * pieces it chose in advance, and moving the element under it ends the
 * session with error F7375 and a Netflix error page. Its player has a seek of
 * its own, reached through `wrappedJSObject`, which is how a content script
 * gets at the page's own objects in Firefox, the same way subtitles.js reads
 * YouTube's player.
 *
 * Reaching across like that is fine for reading something the page already
 * has. It is not fine for changing what the page does: an attempt to hook
 * Netflix's `JSON` this way broke the site outright, which is the whole
 * reason netflix-page.js is a separate file living in a different world.
 */

var LLLNetflix = (function () {
  'use strict';

  function say() {
    var parts = ['LLL (Netflix):'];
    for (var i = 0; i < arguments.length; i++) parts.push(arguments[i]);
    console.log.apply(console, parts);
  }

  /** The page's own window, as against the extension's view of it. */
  function pageWindow() {
    try {
      return window.wrappedJSObject || null;
    } catch (err) {
      return null;
    }
  }

  /**
   * The player object for whatever is playing. Netflix keeps one per session
   * and a page can have several, a trailer preview alongside the episode; the
   * one whose id begins "watch-" is the one you are watching.
   */
  function player() {
    var page = pageWindow();
    var app = page && page.netflix && page.netflix.appContext;
    var api = app && app.state && app.state.playerApp && app.state.playerApp.getAPI();
    if (!api || !api.videoPlayer) return null;
    var ids = api.videoPlayer.getAllPlayerSessionIds();
    if (!ids || !ids.length) return null;
    var id = ids[0];
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i]).indexOf('watch-') === 0) { id = ids[i]; break; }
    }
    return api.videoPlayer.getVideoPlayerBySessionId(id) || null;
  }

  var caught = null;
  window.addEventListener('message', function (e) {
    // Only this page, and only this message. Anything can post to a window.
    if (e.source !== window) return;
    var data = e.data;
    if (!data || data.lll !== 'lll-netflix-subtitles') return;
    if (typeof data.vtt !== 'string' || !data.vtt) return;
    caught = { movie: String(data.movie || ''), vtt: data.vtt };
  });

  /**
   * What the player itself is holding, said out loud, when nothing else
   * worked.
   *
   * The subtitle file is asked for and its reply is never seen: the format
   * goes into the request, the request goes out, and nothing carrying a track
   * list is ever read on this page by any of the three ways a reply becomes
   * an object. Which leaves two possibilities, that the reply is read
   * somewhere out of reach, or that what LLL wants is sitting on the player
   * object all along and there was never any need to catch a reply at all.
   * Netflix is rendering those subtitles from something.
   *
   * This only reads and reports. It changes nothing, and it runs once.
   */
  function describePlayer() {
    var playing = null;
    try {
      playing = player();
    } catch (err) { /* said below */ }
    if (!playing) { say('there is no player object to look at.'); return; }

    var names = [];
    var level = playing;
    try {
      while (level) {
        var own = Object.getOwnPropertyNames(level);
        for (var i = 0; i < own.length; i++) {
          if (names.indexOf(own[i]) === -1) names.push(own[i]);
        }
        level = Object.getPrototypeOf(level);
      }
    } catch (err) { /* whatever was reached is enough */ }

    var about = names.filter(function (name) {
      return /text|track|cue|subtitle|caption|download/i.test(name);
    });
    say('the player offers:', about.join(', ') || '(nothing about text or tracks)');

    try {
      var list = playing.getTimedTextTrackList && playing.getTimedTextTrackList();
      if (!list || !list.length) { say('and no timed text track list.'); return; }
      var keys = [];
      for (var key in list[0]) keys.push(key);
      say('a track in it looks like:', keys.join(', '));
      say('and there are', list.length, 'of them.');
    } catch (err) {
      say('could not read the track list:', err && err.message);
    }
  }

  return {
    /** The subtitle file netflix-page.js caught, if one has arrived. */
    track: function () { return caught; },

    /** See describePlayer. Called by subtitles.js when nothing was caught. */
    describe: describePlayer,

    /** Ask Netflix's own player to move. Its video element must not be. */
    seek: function (seconds) {
      try {
        var moving = player();
        if (moving) moving.seek(Math.max(0, Math.round(seconds * 1000)));
        else say('the player would not say where it is, so A and D cannot move it');
      } catch (err) {
        say('seeking failed:', err && err.message);
      }
    }
  };
})();

// Named on the window as well as declared. LLL's other content scripts and
// this one are separate entries in the manifest, and while the browser gives
// every content script of one extension the same world to live in, one line
// here is cheaper than depending on that.
if (typeof window !== 'undefined') window.LLLNetflix = LLLNetflix;

if (typeof module !== 'undefined' && module.exports) module.exports = LLLNetflix;
