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

  var told = false;
  var stringify = JSON.stringify;
  JSON.stringify = function (value) {
    try {
      if (value && typeof value.url === 'string' && MANIFEST.test(value.url)) {
        ask(value);
        if (!told) { told = true; say('asking this title for its subtitles as a plain file'); }
      }
    } catch (err) {
      // Never let this break the request itself. A missing subtitle file is
      // a disappointment; a video that will not start is a broken website.
    }
    return stringify.apply(this, arguments);
  };

  /** Add WebVTT to every list of acceptable formats in this request. */
  function ask(payload) {
    offer(payload);
    for (var key in payload) offer(payload[key]);
  }

  function offer(part) {
    if (!part || !Array.isArray(part.profiles)) return;
    if (part.profiles.indexOf(WEBVTT) !== -1) return;
    part.profiles.unshift(WEBVTT);
  }

  // ---------------------------------------------------------------------
  // On the way back: read the track list out of the answer
  // ---------------------------------------------------------------------

  var parse = JSON.parse;
  JSON.parse = function () {
    var value = parse.apply(this, arguments);
    try {
      collect(value);
    } catch (err) {
      // Same reasoning as above, and more so: JSON.parse is used by every
      // part of this site for everything.
    }
    return value;
  };

  function collect(value) {
    var result = value && value.result;
    if (!result || !result.movieId || !result.timedtexttracks) return;
    var track = pick(result.timedtexttracks);
    if (track) return load(String(result.movieId), track);
    say('this title offers no Japanese subtitles as a file. It offers:',
      result.timedtexttracks.map(function (t) { return t.language; }).join(', '));
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

  var fetched = '';
  function load(movie, track) {
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
})();
