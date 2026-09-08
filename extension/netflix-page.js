/*
 * Netflix's whole subtitle file, before the episode has played a second of it.
 *
 * Netflix does publish its subtitles as plain WebVTT, but only if you ask.
 * When the player starts a title it posts a "manifest" request listing the
 * formats it is prepared to accept, and the answer only ever offers what was
 * asked for. The player never asks for WebVTT, so the answer never offers it,
 * and there is nothing to find afterwards however hard you look. Add the
 * format to the request on its way out and the very same answer comes back
 * with a plain, unencrypted address for every subtitle track in it.
 *
 * Two hooks:
 *
 *   1. `JSON.stringify` is where the request payload becomes text, so that is
 *      where the format is added, at the last moment before it is sent.
 *   2. `JSON.parse` is where the answer stops being text, so that is where
 *      the track list is read out of it.
 *
 * Neither changes what Netflix's own player sees. The extra format is one more
 * entry in a list the player ignores, and the parsed answer is handed straight
 * back, the very same object that came out of the real `JSON.parse`.
 *
 * That last point is the whole reason this file exists rather than living in
 * netflix.js with the rest. An earlier attempt put these two hooks in the
 * content script and reached the page's `JSON` through `wrappedJSObject`,
 * which ran, and broke Netflix: its home page came up with a header and
 * nothing else. Every part of that site parses JSON for everything, and
 * passing all of it across the wall between an extension's world and the
 * page's was not free. Here there is no wall. This file *is* page code, so
 * `JSON.parse` hands back exactly what it always did.
 *
 * Getting it here took three goes. A `"world": "MAIN"` entry in the manifest's
 * content_scripts never ran at all, on a Firefox new enough to support it,
 * which is most likely Firefox rejecting the whole entry over that property.
 * A <script> tag never ran either, near certainly stopped by Netflix's content
 * security policy. What works, and what Migaku does, is registering it from
 * the background script through the scripting API, which is done in
 * background.js and explained there.
 */
(function () {
  'use strict';

  if (window.__lllNetflix) return;   // registered twice; once is enough
  window.__lllNetflix = true;

  var WEBVTT = 'webvtt-lssdh-ios8';   // the one format Netflix hands over plainly
  var MANIFEST = /manifest/i;

  function say() {
    var parts = ['LLL (Netflix):'];
    for (var i = 0; i < arguments.length; i++) parts.push(arguments[i]);
    console.log.apply(console, parts);
  }

  // ---------------------------------------------------------------------
  // On the way out: ask for a format that can be read
  // ---------------------------------------------------------------------

  var asked = 0;
  var stringify = JSON.stringify;
  JSON.stringify = function (value) {
    try {
      if (value && typeof value.url === 'string' && MANIFEST.test(value.url)) {
        var added = ask(value, 0);
        // Said once, with the count, because "asked" and "found somewhere to
        // ask" are different things and only the second one is any use. A
        // request that goes out with nothing added is the whole explanation
        // for an answer that comes back with nothing in it.
        // Three times rather than once: the first manifest of a session is
        // usually a trailer previewing itself on the home page, and the one
        // that matters is the episode you then chose.
        if (asked++ < 3) {
          say(added
            ? 'asking this title for its subtitles as a plain file (' + added +
              ' format lists)'
            : 'this title’s request has no format list to add to. Its parts are: ' +
              Object.keys(value).join(', '));
        }
      }
    } catch (err) {
      // Never let this break the request itself. A missing subtitle file is
      // a disappointment; a video that will not start is a broken website.
    }
    return stringify.apply(this, arguments);
  };

  /**
   * Add WebVTT to every list of acceptable formats in this request.
   *
   * Wherever it is. The list used to be looked for in the payload itself and
   * one level under it, which is where it was when this was written against
   * one recording of one request, and there is no reason for Netflix to keep
   * it there. Answers with how many lists it actually found.
   */
  function ask(node, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return 0;
    var added = 0;
    if (Array.isArray(node.profiles) && node.profiles.indexOf(WEBVTT) === -1) {
      node.profiles.unshift(WEBVTT);
      added++;
    }
    for (var key in node) {
      if (key === 'profiles') continue;
      var value = node[key];
      if (value && typeof value === 'object') added += ask(value, depth + 1);
    }
    return added;
  }

  // ---------------------------------------------------------------------
  // On the way back: read the track list out of the answer
  // ---------------------------------------------------------------------

  var parse = JSON.parse;
  JSON.parse = function (text) {
    var value = parse.apply(this, arguments);
    try {
      // Two looks, cheap one first, because this runs for every piece of
      // JSON the site parses and that is a great many. The cheap one is where
      // the track list has always been. The deep one costs a string search
      // that nearly always fails, and only then a walk.
      if (value && typeof value === 'object' &&
        (value.timedtexttracks || (value.result && value.result.timedtexttracks))) {
        collect(value);
      } else if (typeof text === 'string' && text.indexOf('timedtexttracks') !== -1) {
        collect(value);
      }
    } catch (err) {
      // Same reasoning as above, and more so: JSON.parse is used by every
      // part of this site for everything.
    }
    return value;
  };

  /**
   * The track list out of an answer that has one, wherever it sits in it.
   *
   * Looked for by name rather than by route, for the same reason the YouTube
   * side does it: the route is undocumented and has moved before now.
   */
  function collect(value) {
    var tracks = findKey(value, 'timedtexttracks', 0);
    if (!tracks || !tracks.length) return;
    var movie = findKey(value, 'movieId', 0);
    var track = pick(tracks);
    if (track) return load(String(movie || ''), track);
    var offered = [];
    for (var i = 0; i < tracks.length; i++) offered.push(String(tracks[i].language));
    say('this title offers no Japanese subtitles as a file. It offers:',
      offered.join(', ') || '(nothing)');
  }

  /**
   * The other two ways a reply becomes an object without JSON.parse ever
   * being called.
   *
   * `JSON.parse` was the only place watched, and nothing carrying a track
   * list ever went through it. It does not follow that the answer is out of
   * reach: `response.json()` does not call `JSON.parse`, the browser parses
   * the body itself, and neither does reading `responseText` and handing it
   * to something else. Both are watched here, and both only for a reply to
   * the manifest request, so nothing else on the site is touched.
   *
   * Neither changes the reply. The promise handed back is the very one the
   * real `json()` returned; this only listens to it.
   */
  var seenReply = false;

  if (typeof Response !== 'undefined' && Response.prototype.json) {
    var realJson = Response.prototype.json;
    Response.prototype.json = function () {
      var answer = realJson.apply(this, arguments);
      try {
        if (MANIFEST.test(this.url || '')) {
          // A derived promise, so a failure here can never become an
          // unhandled rejection on the one the player is waiting for.
          answer.then(function (value) { fromReply(value); }, function () {});
        }
      } catch (err) { /* leave the reply alone */ }
      return answer;
    };
  }

  if (typeof XMLHttpRequest !== 'undefined') {
    var realOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__lllUrl = String(url || ''); } catch (err) { /* no matter */ }
      return realOpen.apply(this, arguments);
    };

    var realSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      try {
        if (MANIFEST.test(this.__lllUrl || '')) {
          this.addEventListener('load', function () {
            try {
              if (this.responseType && this.responseType !== 'text') {
                if (this.responseType === 'json') fromReply(this.response);
                return;
              }
              var text = this.responseText;
              if (text && text.indexOf('timedtexttracks') !== -1) {
                fromReply(parse(text));
              }
            } catch (err) { /* not ours to read */ }
          });
        }
      } catch (err) { /* leave the request alone */ }
      return realSend.apply(this, arguments);
    };
  }

  /** A reply to the manifest request, however it was read. */
  function fromReply(value) {
    try {
      if (!seenReply) {
        seenReply = true;
        say('the reply to that request came back. It holds:',
          (value && typeof value === 'object' ? Object.keys(value) : [typeof value]).join(', '));
      }
      collect(value);
    } catch (err) { /* said what there was to say */ }
  }

  /** The first value under `wanted`, anywhere in here. */
  function findKey(node, wanted, depth) {
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (node[wanted]) return node[wanted];
    for (var key in node) {
      var value = node[key];
      if (!value || typeof value !== 'object') continue;
      var found = findKey(value, wanted, depth + 1);
      if (found) return found;
    }
    return null;
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
      best = { url: urls[0].url, captions: captions };
    }
    return best;
  }

  var got = false;
  var fetched = '';
  function load(movie, track) {
    got = true;
    if (track.url === fetched) return;    // the same track, asked for twice
    fetched = track.url;
    // Fetched from here rather than from the extension's side, because here
    // the request is Netflix's own page asking its own delivery network for a
    // file, which is a request it is set up to answer.
    fetch(track.url).then(function (res) {
      if (!res.ok) throw new Error('the file came back ' + res.status);
      return res.text();
    }).then(function (vtt) {
      if (!vtt) { say('the subtitle file came back empty'); return; }
      say('got the subtitle file,', vtt.length, 'characters');
      window.postMessage({ lll: 'lll-netflix-subtitles', movie: movie, vtt: vtt }, '*');
    }).catch(function (err) {
      fetched = '';                       // let a later attempt try again
      say('could not fetch the subtitle file:', err && err.message);
    });
  }

  say('watching for this title’s subtitle file');

  /**
   * Say so if the request went out and nothing ever came back through here.
   *
   * Silence is the hardest thing to act on. If the format was added to a
   * real request and no answer carrying a track list was ever parsed on this
   * page, then the answer is being read somewhere this cannot see, a worker
   * most likely, and the next thing to try is a different place to stand
   * rather than a different thing to look for.
   */
  setTimeout(function () {
    if (got || !asked) return;
    say(seenReply
      ? 'the reply came back but had no track list in it, so the format was ' +
        'added in the wrong place or under the wrong name.'
      : 'the request went out and its reply was never read on this page. ' +
        'Whatever reads it is somewhere this cannot see, a worker most likely.');
  }, 25000);
})();
