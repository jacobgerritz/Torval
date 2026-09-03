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
 * Getting the track is the fragile part. The addresses live in the page's own
 * player data, and they only answer to a request made from the page itself —
 * fetched from anywhere else they return an empty body. Firefox lets a content
 * script read page globals through `wrappedJSObject`, which is how this reaches
 * them without injecting anything into the page.
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
      removeOverlay();
      if (id) load(id);
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
        console.warn('LLL: no subtitle tracks found in this page’s player data.');
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
   * Fetch as the page would.
   *
   * This matters more than it looks. Under Manifest V3 a content script's own
   * fetch goes out as the extension, not as the page — and YouTube answers a
   * subtitle request that did not come from YouTube with an empty body. Firefox
   * keeps the page's own fetch reachable as `content.fetch`, which is exactly
   * what this needs; without it the request looks foreign and comes back blank.
   */
  async function request(url) {
    var fetcher = (typeof content !== 'undefined' && content && content.fetch)
      ? content.fetch
      : window.fetch;
    var res = await fetcher(url, { credentials: 'include' });
    if (!res.ok) {
      console.warn('LLL: subtitle request came back', res.status);
      return '';
    }
    return res.text();
  }

  /**
   * The list of subtitle tracks, out of the page's own player data.
   * `wrappedJSObject` is Firefox's way of letting a content script see the
   * page's variables; falling back to the HTML covers a first page load, where
   * the same data is still sitting in a script tag.
   */
  function captionTracks() {
    try {
      var page = window.wrappedJSObject && window.wrappedJSObject.ytInitialPlayerResponse;
      var list = page && page.captions &&
        page.captions.playerCaptionsTracklistRenderer &&
        page.captions.playerCaptionsTracklistRenderer.captionTracks;
      if (list && list.length) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
          out.push({ languageCode: String(list[i].languageCode), baseUrl: String(list[i].baseUrl) });
        }
        return out;
      }
    } catch (err) { /* fall through to the HTML */ }

    var match = document.documentElement.innerHTML.match(
      /"captionTracks":(\[.*?\])\s*,\s*"(?:audioTracks|translationLanguages|defaultAudioTrackIndex)"/);
    if (!match) return null;
    try {
      return JSON.parse(match[1].replace(/\\u0026/g, '&'));
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
