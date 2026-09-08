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
 * That is all this file does, in two halves:
 *
 *   1. `JSON.stringify` is where the request payload becomes text, so that is
 *      where the format is added, right at the last moment before it is sent.
 *   2. `JSON.parse` is where the answer stops being text, so that is where
 *      the track list is read out of it.
 *
 * Neither changes what Netflix's own player sees. The extra format is one more
 * entry in a list the player ignores, and the parsed answer is handed back
 * untouched; the track list is only read, never altered.
 *
 * This has to run in the page's own world rather than beside it, because
 * `JSON` in an extension's world is a different object from `JSON` in the
 * page's, and the player uses the page's. That is what `"world": "MAIN"` in
 * the manifest asks for. Nothing else in LLL runs there, and this file talks
 * to the rest of it the only way the two worlds can, by posting a message
 * through the window they share.
 */
(function () {
  'use strict';

  // The one subtitle format Netflix will hand over as an ordinary file.
  var WEBVTT = 'webvtt-lssdh-ios8';
  var MANIFEST = /manifest/i;
  var SAY = 'lll-netflix-subtitles';

  // ---------------------------------------------------------------------
  // On the way out: ask for a format that can be read
  // ---------------------------------------------------------------------

  var stringify = JSON.stringify;
  JSON.stringify = function (value) {
    try {
      if (value && typeof value.url === 'string' && MANIFEST.test(value.url)) ask(value);
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
      // Same reasoning as above. JSON.parse is used by everything on the
      // page, so a mistake in here would take the whole site down with it.
    }
    return value;
  };

  function collect(value) {
    var result = value && value.result;
    if (!result || !result.movieId || !result.timedtexttracks) return;
    var track = pick(result.timedtexttracks);
    if (track) load(String(result.movieId), track);
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
      if (!urls || !urls.length || !urls[0].url) continue;
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
    fetch(track.url).then(function (res) {
      return res.ok ? res.text() : '';
    }).then(function (vtt) {
      if (!vtt) return;
      window.postMessage({ lll: SAY, movie: movie, vtt: vtt }, '*');
    }).catch(function () {
      fetched = '';                       // let a later attempt try again
    });
  }
})();
