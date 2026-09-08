/*
 * Netflix's whole subtitle file, before the episode has played a second of it.
 * And Netflix's own seek, because its player will not be moved by hand.
 *
 * Netflix does publish its subtitles as plain WebVTT, but only if you ask.
 * When the player starts a title it posts a "manifest" request listing the
 * formats it is prepared to accept, and the answer only ever offers what was
 * asked for. The player never asks for WebVTT, so the answer never offers it,
 * and there is nothing to find afterwards however hard you look. Add the
 * format to the request on its way out and the very same answer comes back
 * with a plain, unencrypted address for every subtitle track in it.
 *
 * So this adds it, in two places:
 *
 *   1. `JSON.stringify` is where the request payload becomes text, so that is
 *      where the format goes in, at the last moment before it is sent.
 *   2. `JSON.parse` is where the answer stops being text, so that is where
 *      the track list is read out of it.
 *
 * Neither changes what Netflix's own player sees. The extra format is one more
 * entry in a list the player ignores, and the parsed answer is handed back
 * untouched; the track list is only read, never altered.
 *
 * This has to reach the page's own `JSON`, not the extension's copy of it, and
 * `wrappedJSObject` is how a content script does that in Firefox, the same way
 * subtitles.js reaches YouTube's player object. Two earlier attempts went the
 * other way, putting a file into the page to run there: a content script
 * declared `"world": "MAIN"`, which never ran, and then a <script> tag, which
 * never ran either, most likely stopped by Netflix's content security policy.
 * Neither could say why, since neither got far enough to say anything. This
 * way there is nothing to inject and no policy to satisfy: the page's objects
 * are simply reached and used, from here.
 *
 * The seeking is the same story. Setting `currentTime` on the video element,
 * which is how A and D move on every other site, does not work here: Netflix
 * streams in pieces it chose in advance, and moving the element under it ends
 * the session with error F7375 and a Netflix error page. Its player has a seek
 * of its own, reached the same way, and that is the one to use.
 */
var LLLNetflix = (function () {
  'use strict';

  var WEBVTT = 'webvtt-lssdh-ios8';   // the one format Netflix hands over plainly
  var MANIFEST = /manifest/i;

  var caught = null;      // the subtitle file, once one has been fetched
  var fetched = '';       // and the address it came from, so as not to repeat

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

  function start() {
    var page = pageWindow();
    if (!page || typeof exportFunction !== 'function') {
      console.warn('LLL: cannot reach Netflix’s player from here, so subtitles ' +
        'will have to be read off the screen.');
      return;
    }
    try {
      hookJson(page);
      say('watching for this title’s subtitle file');
    } catch (err) {
      console.warn('LLL: could not watch for Netflix’s subtitle file:', err && err.message);
    }
  }

  // ---------------------------------------------------------------------
  // The two hooks
  // ---------------------------------------------------------------------

  function hookJson(page) {
    var json = page.JSON;
    var stringify = json.stringify;
    var parse = json.parse;
    var told = false;

    json.stringify = exportFunction(function (value) {
      try {
        if (value && typeof value.url === 'string' && MANIFEST.test(value.url)) {
          ask(value);
          if (!told) { told = true; say('asking this title for its subtitles as a plain file'); }
        }
      } catch (err) {
        // Never let this break the request. A missing subtitle file is a
        // disappointment; a video that will not start is a broken website.
      }
      return stringify.apply(this, arguments);
    }, page);

    json.parse = exportFunction(function () {
      var value = parse.apply(this, arguments);
      try {
        collect(value);
      } catch (err) {
        // Same reasoning. JSON.parse is used by everything on the page.
      }
      return value;
    }, page);
  }

  /** Add WebVTT to every list of acceptable formats in this request. */
  function ask(payload) {
    offer(payload);
    for (var key in payload) offer(payload[key]);
  }

  function offer(part) {
    if (!part || !part.profiles || typeof part.profiles.unshift !== 'function') return;
    if (indexOf(part.profiles, WEBVTT) !== -1) return;
    part.profiles.unshift(WEBVTT);
  }

  /** indexOf across the wall between the page's arrays and ours. */
  function indexOf(list, wanted) {
    for (var i = 0; i < list.length; i++) if (list[i] === wanted) return i;
    return -1;
  }

  function collect(value) {
    var result = value && value.result;
    if (!result || !result.movieId || !result.timedtexttracks) return;
    var track = pick(result.timedtexttracks);
    if (track) return load(String(result.movieId), track);
    var offered = [];
    for (var i = 0; i < result.timedtexttracks.length; i++) {
      offered.push(String(result.timedtexttracks[i].language));
    }
    say('this title offers no Japanese subtitles as a file. It offers:', offered.join(', '));
  }

  /**
   * The Japanese track, preferring subtitles to closed captions.
   *
   * A closed-caption track writes out speaker names and sounds as well as
   * speech, which is not what you are trying to read, so the plain subtitle
   * track wins wherever a title offers both.
   */
  function pick(tracks) {
    var best = null;
    for (var i = 0; i < tracks.length; i++) {
      var track = tracks[i];
      if (track.isForcedNarrative || track.isNoneTrack) continue;
      if (String(track.language || '').slice(0, 2) !== 'ja') continue;
      var file = track.ttDownloadables && track.ttDownloadables[WEBVTT];
      var urls = file && file.urls;
      if (!urls || !urls.length || !urls[0] || !urls[0].url) continue;
      var captions = track.rawTrackType === 'closedcaptions';
      if (best && !(best.captions && !captions)) continue;
      best = { url: String(urls[0].url), captions: captions };
    }
    return best;
  }

  function load(movie, track) {
    if (track.url === fetched) return;
    fetched = track.url;
    fetch(track.url).then(function (res) {
      if (!res.ok) throw new Error('the file came back ' + res.status);
      return res.text();
    }).then(function (vtt) {
      if (!vtt) { say('the subtitle file came back empty'); return; }
      caught = { movie: movie, vtt: vtt };
      say('got the subtitle file,', vtt.length, 'characters');
    }).catch(function (err) {
      fetched = '';   // let a later attempt try again
      say('could not fetch the subtitle file:', err && err.message);
    });
  }

  // ---------------------------------------------------------------------
  // Seeking, Netflix's way
  // ---------------------------------------------------------------------

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

  start();

  return {
    /** The subtitle file Netflix's player was handed, if one has arrived. */
    track: function () { return caught; },

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
