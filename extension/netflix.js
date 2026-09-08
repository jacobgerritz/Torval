/*
 * Netflix's own seek, because its player will not be moved by hand.
 *
 * Setting `currentTime` on the video element, which is how A and D move on
 * every other site, does not work here: Netflix streams in pieces it chose in
 * advance, and moving the element under it ends the session with error F7375
 * and a Netflix error page. Its player has a seek of its own, reached through
 * `wrappedJSObject`, which is how a content script gets at the page's own
 * objects in Firefox, the same way subtitles.js reads YouTube's player.
 *
 * This only reads what the page already has. Nothing here changes anything the
 * page does, which is a line worth drawing after what happened when LLL tried
 * to go further, and is written up below.
 *
 * ---------------------------------------------------------------------------
 *
 * Getting Netflix's subtitle file up front, the way the transcript is got on
 * YouTube, is not solved, and three attempts are worth recording so the fourth
 * does not repeat them.
 *
 * The idea is sound and is what other tools do. Netflix will hand over its
 * subtitles as plain WebVTT, but only if asked: when the player starts a title
 * it posts a "manifest" request listing the formats it will accept, and the
 * answer only ever offers what was asked for. Add `webvtt-lssdh-ios8` to that
 * request on its way out, read the addresses out of the answer, and there is
 * the whole episode before a second of it has played.
 *
 * The request becomes text in `JSON.stringify` and the answer stops being text
 * in `JSON.parse`, so those are the two places to stand. Reaching them is the
 * problem:
 *
 *   1. A content script declared `"world": "MAIN"` never ran at all, on
 *      Firefox 155, where it should have.
 *   2. A <script> tag pointing at the same file never ran either, near
 *      certainly stopped by Netflix's content security policy.
 *   3. Reaching the page's own JSON from here, through wrappedJSObject and
 *      exportFunction, did run, and broke Netflix: the home page came up with
 *      its header and nothing else. `JSON.parse` is used by every part of that
 *      site for everything, and handing its answers back through a function of
 *      ours was evidently not free, whatever the wrapping did to them.
 *
 * The third is the one to learn from. A hook on `JSON.parse` is a hook on the
 * whole site, and the cost of getting it slightly wrong is the site. Whatever
 * comes next should touch something narrower: the one request that matters,
 * rather than the one method everything goes through.
 *
 * Until then Netflix reads its lines off the screen, which works, and means
 * the percentage describes what has been watched so far rather than the whole
 * episode, and D has nowhere to go because the next line has not been said.
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

  return {
    /**
     * Nothing yet. Kept so subtitles.js has one shape to talk to whether or
     * not a way of catching the file is ever found; see the note above.
     */
    track: function () { return null; },

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
