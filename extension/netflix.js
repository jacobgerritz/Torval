/*
 * The Netflix end of things, on Torval's side of the page.
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

var TorvalNetflix = (function () {
  'use strict';

  function say() {
    var parts = ['Torval (Netflix):'];
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
    // Only this page, and only these messages. Anything can post to a window.
    if (e.source !== window) return;
    var data = e.data;
    if (!data) return;
    if (data.torval === 'torval-netflix-subtitles') {
      var text = typeof data.text === 'string' && data.text ? data.text : data.vtt;
      if (typeof text !== 'string' || !text) return;
      caught = {
        movie: String(data.movie || ''),
        format: data.format === 'ttml' ? 'ttml' : 'vtt',
        text: text,
        // The old name, for anything still reading it.
        vtt: text
      };
      return;
    }
    if (data.torval === 'torval-netflix-tracks' && Array.isArray(data.tracks)) {
      askFor(data.tracks);
    }
  });

  /**
   * Tell the page which language is being read.
   *
   * Page code has no way of knowing: it cannot see the extension's settings,
   * and this side cannot reach the player's own track list without the
   * trouble that reaching across for anything but a read always causes. So
   * each half says what it knows. This is also said again whenever the
   * language changes, since the track to turn on changes with it.
   *
   * Said more than once at the start because the two scripts begin at
   * different moments: this one runs before the page has finished loading,
   * and the language it reads is only settled once storage has answered.
   */
  function announce() {
    var wanted = wantedLanguages();
    if (!wanted) return;
    window.postMessage({ torval: 'torval-netflix-want', languages: wanted }, '*');
  }

  /**
   * The subtitle languages to ask Netflix for, or null when there is no
   * answer to give: TorvalLang has not loaded into this scope yet, or
   * nobody has chosen a language.
   *
   * Null rather than a guess. askFor used to fall back to ['ja'] here,
   * which meant that in the window before the rest of Torval had loaded,
   * Netflix was asked for a Japanese subtitle file for a Spanish show.
   * The same mistake was in the YouTube path and was taken out of it; this
   * is the copy that was missed.
   */
  function wantedLanguages() {
    if (typeof TorvalLang === 'undefined') return null;
    if (TorvalLang.picked && !TorvalLang.picked()) return null;
    var profile = TorvalLang.profile();
    return (profile && profile.subtitles) || null;
  }

  /*
   * This file runs at document_start, and everything else Torval puts on
   * the page runs at document_idle, so at the moment these lines are read
   * TorvalLang does not exist yet. Content scripts of one extension share
   * a scope, so it appears a moment later, which the delayed announces
   * above were already relying on.
   *
   * What it was not relying on, and should have been, is that the same is
   * true of the listener: `TorvalLang.onChange(announce)` was written
   * straight into this file's top level, where the guard around it was
   * always false and the listener was therefore never registered at all.
   * Picking a language, or changing it, never reached Netflix. So the
   * registration waits for TorvalLang to turn up.
   */
  announce();
  setTimeout(announce, 2000);
  setTimeout(announce, 6000);
  listenForLanguage();

  function listenForLanguage() {
    if (typeof TorvalLang === 'undefined' || !TorvalLang.onChange) {
      // Not yet. The rest of Torval is a few hundred milliseconds behind
      // this file at most, and this stops after a minute either way.
      if (Date.now() - started < 60000) setTimeout(listenForLanguage, 250);
      return;
    }
    TorvalLang.onChange(announce);
    TorvalLang.ready().then(announce);
  }

  var started = Date.now();

  /**
   * Which of the tracks Netflix offered to ask for.
   *
   * netflix-page.js is page code and knows nothing about which language Torval
   * is set to read, so it offers all of them and this chooses. The language
   * comes from the active profile, the same list the YouTube side filters
   * its tracks with, and a plain subtitle track beats a closed-caption one:
   * closed captions write out speaker names and sounds as well as speech.
   */
  function askFor(tracks) {
    var wanted = wantedLanguages();
    if (!wanted) {
      say('not asking for a subtitle file yet: no language has been chosen.');
      return;
    }
    var best = null;
    for (var i = 0; i < tracks.length; i++) {
      var track = tracks[i];
      var code = String(track.language || '');
      var matches = wanted.some(function (want) {
        return code === want || code.slice(0, 2) === String(want).slice(0, 2);
      });
      if (!matches) continue;
      if (best && !(best.captions && !track.captions)) continue;
      best = track;
    }
    if (!best) {
      say('this title has no', wanted[0], 'subtitle file. It offers:',
        tracks.map(function (t) { return t.language; }).join(', ') || '(nothing)');
      return;
    }
    say('asking for the', best.language, 'subtitle file');
    window.postMessage({ torval: 'torval-netflix-fetch', url: best.url }, '*');
  }

  /**
   * What the player itself is holding, said out loud.
   *
   * Written while working out where the subtitle file could be. It answered
   * its question, which was no: twenty tracks, each with a name, a language
   * and a type, and nothing to fetch and no cues. Kept because it is the
   * first thing to run again if Netflix changes, and because it costs
   * nothing sitting here. Nothing calls it; type TorvalNetflix.describe() in
   * the console on a playing episode.
   *
   * This only reads and reports. It changes nothing.
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

// Named on the window as well as declared. Torval's other content scripts and
// this one are separate entries in the manifest, and while the browser gives
// every content script of one extension the same world to live in, one line
// here is cheaper than depending on that.
if (typeof window !== 'undefined') window.TorvalNetflix = TorvalNetflix;

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalNetflix;
