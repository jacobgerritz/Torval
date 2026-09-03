/*
 * LLL — subtitles of our own
 *
 * YouTube draws its captions as a pile of styled spans that change shape without
 * warning, and tells you nothing about when a line starts or ends. So LLL fetches
 * the subtitle track itself and draws it: text we control, hoverable like any
 * other text on the page, and — the part that matters — with exact timings.
 *
 * Those timings are what makes clean audio possible. Knowing a line runs from
 * 91.2s to 94.8s means the recording can be exactly that line, rather than
 * whatever happened to be playing while you read.
 *
 * Turn YouTube's own captions off; these replace them.
 *
 * Getting the track is the fragile part, in two ways. The address for it lives
 * in the player's own data, which is read through `wrappedJSObject` — Firefox's
 * way of letting a content script reach the page's variables — rather than
 * anything injected into the page. And fetching that address can come back
 * with a 200 and an empty body if YouTube is not satisfied with the request's
 * session state, which a plain fetch cannot always arrange. Both failure modes
 * are logged to the console rather than swallowed, because guessing which one
 * happened from the outside wastes a round trip each time.
 */

var LLLSubtitles = (function () {
  'use strict';

  var LANGUAGES = ['ja', 'ja-JP'];

  var enabled = false;
  var videoId = null;
  var cues = [];
  var index = 0;
  var video = null;
  var overlay = null;
  var state = 'idle';        // idle | loading | ready | unavailable
  var attempts = 0;

  function enable() {
    if (enabled) return;
    if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;
    enabled = true;
    window.addEventListener('keydown', keys, true);
    setInterval(watch, 1000);
    watch();
    console.log('LLL: watching for subtitles');
  }

  /**
   * A steps back a line, D steps forward. Rewatching a line you did not catch
   * is the commonest thing you do while mining, and dragging the scrub bar to
   * roughly the right place is a poor way to do it.
   */
  function keys(e) {
    if (!enabled || !cues.length || !video) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    var focused = document.activeElement;
    if (focused && (focused.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName))) return;

    var key = (e.key || '').toLowerCase();
    if (key !== 'a' && key !== 'd') return;

    e.preventDefault();
    e.stopPropagation();
    jump(key === 'a' ? -1 : 1);
  }

  function jump(direction) {
    var target = step(video.currentTime, direction);
    if (target) video.currentTime = target.start;
  }

  /** The line A or D should take you to from here, or null if there is none. */
  function step(now, direction) {
    if (direction < 0) {
      // A little grace, so that pressing A part-way through a line takes you to
      // the start of it — and pressing it again takes you to the line before.
      for (var i = cues.length - 1; i >= 0; i--) {
        if (cues[i].start < now - 0.4) return cues[i];
      }
      return null;
    }
    for (var j = 0; j < cues.length; j++) {
      if (cues[j].start > now + 0.05) return cues[j];
    }
    return null;
  }

  function watch() {
    if (!enabled) return;

    var id = new URLSearchParams(location.search).get('v');
    if (id !== videoId) {
      videoId = id;
      cues = [];
      index = 0;
      state = 'idle';
      attempts = 0;
      removeOverlay();
      console.log('LLL: video is now', id || '(none — not a watch page)');
    }

    // Keep trying for a while. This script starts before YouTube's player
    // exists, so the first look almost always finds nothing; giving up on that
    // would mean never loading subtitles at all.
    if (id && state !== 'loading' && state !== 'ready' && attempts < 12) {
      attempts++;
      load(id);
    }

    video = document.querySelector('video');
    if (video && cues.length) show();
  }

  // -------------------------------------------------------------------------
  // Getting the track
  // -------------------------------------------------------------------------

  async function load(id) {
    state = 'loading';
    try {
      var tracks = captionTracks();
      if (!tracks || !tracks.length) {
        if (attempts >= 12) {
          console.warn('LLL: gave up looking for subtitle tracks in this page’s player data.');
        }
        state = 'unavailable';
        return;
      }

      var track = tracks.find(function (t) { return LANGUAGES.indexOf(t.languageCode) !== -1; });
      if (!track) {
        console.warn('LLL: this video has no Japanese subtitles. Tracks offered:',
          tracks.map(function (t) { return t.languageCode; }).join(', '));
        state = 'unavailable';
        return;
      }

      console.log('LLL: fetching the', track.languageCode, 'subtitle track');
      var text = await request(track.baseUrl + '&fmt=json3');
      if (!text) {
        // An empty body means the address was refused. Nothing here can fix
        // that, so say so rather than failing quietly.
        console.warn('LLL: YouTube returned no subtitle data for this video.');
        state = 'unavailable';
        return;
      }

      var loaded = parse(JSON.parse(text));
      if (videoId !== id) return;         // navigated away while fetching
      cues = loaded;
      state = cues.length ? 'ready' : 'unavailable';
      console.log('LLL:', cues.length, 'subtitle lines ready — turn YouTube’s captions off');
    } catch (err) {
      console.warn('LLL: could not load subtitles —', err && err.message);
      state = 'unavailable';
    }
  }

  /**
   * Fetch the subtitle file.
   *
   * A content script's fetch runs in the page's own context in Firefox, so
   * this is already "as the page" — no special handling needed. An earlier
   * version routed this through a borrowed `content.fetch` on a theory that it
   * was not, and broke on the much more basic mistake of calling a method
   * after separating it from the object it belongs to: fetch (like most
   * WebIDL methods) refuses to run unless it is still attached to its Window
   * when called, which `var f = x.fetch; f()` does not preserve.
   *
   * An empty body with a 200 status is a real possibility here regardless —
   * YouTube gates some caption requests on session state a plain fetch may not
   * have — so that case is still reported rather than treated as success.
   */
  async function request(url) {
    var res;
    try {
      res = await fetch(url, { credentials: 'include' });
    } catch (err) {
      console.warn('LLL: subtitle request failed —', err && err.message);
      return '';
    }
    if (!res.ok) {
      console.warn('LLL: subtitle request came back', res.status);
      return '';
    }
    var text = await res.text();
    if (!text) console.warn('LLL: subtitle request succeeded but the body was empty.');
    return text;
  }

  /**
   * YouTube's player data for this video, wherever it can be found.
   *
   * Three places, in order of how much they can be trusted. The player element
   * will hand it over on request and keeps working when YouTube swaps videos
   * without reloading the page. The page global is set on a fresh load but goes
   * stale afterwards. The HTML is the last resort, and only holds on a first
   * load.
   *
   * `wrappedJSObject` is Firefox's way of letting a content script reach the
   * page's own variables and functions, which is what all of this needs.
   */
  function playerResponse() {
    try {
      var el = document.getElementById('movie_player');
      var api = el && el.wrappedJSObject;
      if (api && typeof api.getPlayerResponse === 'function') {
        var live = api.getPlayerResponse();
        if (live) return { from: 'the player', data: live };
      }
    } catch (err) { /* try the next place */ }

    try {
      var global = window.wrappedJSObject && window.wrappedJSObject.ytInitialPlayerResponse;
      if (global) return { from: 'the page', data: global };
    } catch (err) { /* try the next place */ }

    return null;
  }

  function captionTracks() {
    var found = playerResponse();
    if (found) {
      try {
        var list = found.data.captions &&
          found.data.captions.playerCaptionsTracklistRenderer &&
          found.data.captions.playerCaptionsTracklistRenderer.captionTracks;
        if (list && list.length) {
          var out = [];
          for (var i = 0; i < list.length; i++) {
            out.push({
              languageCode: String(list[i].languageCode),
              baseUrl: String(list[i].baseUrl)
            });
          }
          console.log('LLL: found', out.length, 'subtitle tracks via', found.from);
          return out;
        }
      } catch (err) {
        console.warn('LLL: could not read the track list —', err && err.message);
      }
    }

    var match = document.documentElement.innerHTML.match(
      /"captionTracks":(\[.*?\])\s*,\s*"(?:audioTracks|translationLanguages|defaultAudioTrackIndex)"/);
    if (!match) return null;
    try {
      var fromHtml = JSON.parse(match[1]);   // JSON.parse handles the escapes itself
      console.log('LLL: found', fromHtml.length, 'subtitle tracks in the page source');
      return fromHtml;
    } catch (err) {
      return null;
    }
  }

  /** YouTube's json3: a list of events, each with its start, length and text. */
  function parse(json) {
    var out = [];
    var events = json.events || [];
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!e.segs) continue;
      var text = e.segs.map(function (s) { return s.utf8 || ''; }).join('')
        .replace(/\s+/g, ' ').trim();
      if (!text) continue;
      var start = (e.tStartMs || 0) / 1000;
      var end = start + (e.dDurationMs || 0) / 1000;
      // Consecutive events sometimes overlap; a line should end where the next
      // begins, or the recording of it runs into the following line.
      if (out.length && out[out.length - 1].end > start) out[out.length - 1].end = start;
      out.push({ start: start, end: end, text: text });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Drawing them
  // -------------------------------------------------------------------------

  function show() {
    var cue = cueAt(video.currentTime);
    if (!cue) { removeOverlay(); return; }
    if (!overlay) createOverlay();
    if (overlay.firstChild.textContent !== cue.text) overlay.firstChild.textContent = cue.text;
  }

  function createOverlay() {
    var player = document.querySelector('.html5-video-player') || document.body;
    overlay = document.createElement('div');
    overlay.setAttribute('data-lll-subtitle', '');
    overlay.style.cssText = [
      'position:absolute', 'left:0', 'right:0', 'bottom:8%',
      'z-index:60', 'display:flex', 'justify-content:center',
      'pointer-events:none', 'padding:0 6%'
    ].join(';');

    var line = document.createElement('span');
    // The text itself must be hoverable — that is the whole point — even though
    // the box around it should not swallow clicks meant for the player.
    line.style.cssText = [
      'pointer-events:auto', 'user-select:text', 'cursor:default',
      'background:rgba(8,8,10,0.78)', 'color:#f2f3f5',
      'padding:4px 12px', 'border-radius:4px',
      'font:500 26px/1.45 "Hiragino Kaku Gothic ProN","Yu Gothic UI",Meiryo,sans-serif',
      'text-align:center', 'white-space:pre-wrap'
    ].join(';');
    overlay.appendChild(line);
    player.appendChild(overlay);
  }

  function removeOverlay() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  // -------------------------------------------------------------------------

  /** The line playing at this moment, if any. */
  function cueAt(time) {
    if (!cues.length) return null;
    // Playback usually moves forward, so start from where we were last.
    if (index >= cues.length || cues[index].start > time) index = 0;
    while (index < cues.length - 1 && cues[index].end <= time) index++;
    var cue = cues[index];
    return cue && time >= cue.start && time < cue.end ? cue : null;
  }

  /**
   * The line this sentence came from. Matched by text rather than by the clock,
   * so pausing to read and mining a moment later still finds the right line.
   */
  function cueFor(sentence) {
    if (!sentence || !cues.length) return null;
    var wanted = strip(sentence);
    if (!wanted) return null;
    for (var i = 0; i < cues.length; i++) {
      var text = strip(cues[i].text);
      if (text && (text.indexOf(wanted) !== -1 || wanted.indexOf(text) !== -1)) return cues[i];
    }
    return video ? cueAt(video.currentTime) : null;
  }

  function strip(s) {
    return String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, '');
  }

  return {
    enable: enable,
    cueAt: cueAt,
    cueFor: cueFor,
    parse: parse,
    step: step,
    status: function () { return state; },
    _setCues: function (list) { cues = list; state = 'ready'; }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LLLSubtitles;
