/*
 * LLL — timing YouTube's subtitles
 *
 * The point of this file is not to show subtitles — YouTube already does that —
 * it is to know exactly when each line starts and ends, which YouTube's own
 * captions never tell anyone. That timing is what lets a line be replayed and
 * recorded precisely, and what lets A and D jump between lines.
 *
 * Three ways of getting it, tried in order — each is a fallback for the one
 * before it, not an alternative to pick between:
 *
 *   1. Ask for the transcript the way YouTube's own "Show transcript" button
 *      does. Not the closed-caption file — a separate panel with its own
 *      endpoint, reached through a one-time token buried in the page's own
 *      data. This is what real people click, so YouTube has more reason to
 *      keep it answering reliably than a download link almost nobody uses by
 *      hand — and it is the only one of the three that has the whole video's
 *      lines ready before a single second has played, which matters for
 *      anything that needs to know the whole video up front, like comparing
 *      it against known words.
 *
 *   2. Ask YouTube for the closed-caption file directly. When this works it
 *      is immediate and exact. It does not always work: YouTube can answer
 *      with a 200 and an empty body, apparently at its own discretion, per
 *      video, and there is no code fix for a server choosing not to answer.
 *
 *   3. Fall back to reading YouTube's own captions as they play, timing each
 *      line by watching it appear and disappear. This is what the simplest
 *      "read a video's subtitles" tools do, and it always works, because it
 *      is just reading what is already on screen. The real cost: a line is
 *      only known once it has actually been shown, so nothing about the video
 *      is known ahead of watching it — D cannot jump to an unseen line, and
 *      nothing here can tell you the whole video's vocabulary in advance.
 *
 * Either way, keep YouTube's own captions turned on — LLL needs a source of
 * text to read, whichever method supplies the timing. What is actually shown
 * on screen is drawn by LLL itself, in its own look, so a line always reads as
 * LLL's rather than being mistaken for YouTube's plain caption box.
 */

var LLLSubtitles = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;
  var LANGUAGES = ['ja', 'ja-JP'];
  var MAX_LOOKUP_ATTEMPTS = 12;    // ~12s of retrying before giving up on the player existing
  var MIN_OBSERVED_SECONDS = 0.15; // shorter than this is a DOM flicker, not a line

  var enabled = false;
  var videoId = null;
  var cues = [];
  var index = 0;
  var video = null;
  var state = 'idle';        // idle | loading | ready | watching | unavailable
  var attempts = 0;

  function enable() {
    if (enabled) return;
    if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;
    enabled = true;
    window.addEventListener('keydown', keys, true);
    setInterval(watch, 1000);
    setInterval(renderCue, 200);
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
    var target = step(video.currentTime, direction, openCue);
    if (target) video.currentTime = target.start;
  }

  /**
   * The line A or D should take you to from here, or null if there is none.
   *
   * In the on-screen fallback, the line currently being spoken is not in
   * `cues` yet — it only gets recorded once it ends. Without also checking the
   * one still in progress, D would work only until you pressed A once: from
   * the line before, there would be nothing later in `cues` to step forward
   * to, since the very next line is the one still open. This is the ordinary
   * case, not a rare one — it happens every single time you rewind and then
   * want to come back.
   */
  function step(now, direction, current) {
    if (direction < 0) {
      // A little grace, so that pressing A part-way through a line takes you to
      // the start of it — and pressing it again takes you to the line before.
      for (var i = cues.length - 1; i >= 0; i--) {
        if (cues[i].start < now - 0.4) return cues[i];
      }
      return null;
    }
    var best = null;
    for (var j = 0; j < cues.length; j++) {
      if (cues[j].start > now + 0.05) { best = cues[j]; break; }
    }
    if (current && current.start > now + 0.05 && (!best || current.start < best.start)) {
      return current;
    }
    return best;
  }

  function watch() {
    if (!enabled) return;

    var id = new URLSearchParams(location.search).get('v');
    if (id !== videoId) {
      videoId = id;
      cues = [];
      index = 0;
      openCue = null;
      state = 'idle';
      attempts = 0;
      console.log('LLL: video is now', id || '(none — not a watch page)');
    }

    // Keep trying for a while. This script starts before YouTube's player
    // exists, so the first look almost always finds nothing; giving up on that
    // would mean never loading subtitles at all. Once a definite answer comes
    // back — ready, watching, or genuinely unavailable — this stops retrying.
    if (id && state === 'idle' && attempts < MAX_LOOKUP_ATTEMPTS) {
      attempts++;
      load(id);
    }

    video = document.querySelector('video');
  }

  // -------------------------------------------------------------------------
  // Plan 1: ask YouTube for the file
  // -------------------------------------------------------------------------

  async function load(id) {
    state = 'loading';

    var panel = null;
    try {
      panel = await fetchViaTranscriptPanel(id);
    } catch (err) {
      console.warn('LLL: could not read the transcript panel —', err && err.message);
    }
    if (videoId !== id) return;         // navigated away while fetching
    if (panel && panel.length) {
      cues = panel;
      state = 'ready';
      console.log('LLL:', cues.length, 'subtitle lines ready, via the transcript panel');
      return;
    }

    var tracks = null;
    try {
      tracks = await captionTracks(id);
    } catch (err) {
      console.warn('LLL: could not read the track list —', err && err.message);
    }

    if (!tracks || !tracks.length) {
      // Likely just early — the player has not finished setting itself up yet.
      // Only worth waiting for on the very first pass, before the transcript
      // panel has had a real chance — if that already answered with nothing,
      // retrying this on its own would just repeat the same silence.
      if (!panel && attempts < MAX_LOOKUP_ATTEMPTS) { state = 'idle'; return; }
      console.warn('LLL: gave up looking for subtitle tracks in this page’s player data.');
      return fallBackToWatching();
    }

    var track = tracks.find(function (t) { return LANGUAGES.indexOf(t.languageCode) !== -1; });
    if (!track) {
      console.warn('LLL: this video has no Japanese subtitle track. Tracks offered:',
        tracks.map(function (t) { return t.languageCode; }).join(', '));
      return fallBackToWatching();
    }

    try {
      console.log('LLL: fetching the', track.languageCode, 'subtitle track');
      var loaded = await fetchTrack(track);
      if (videoId !== id) return;         // navigated away while fetching
      if (loaded && loaded.length) {
        cues = loaded;
        state = 'ready';
        console.log('LLL:', cues.length, 'subtitle lines ready, direct from YouTube');
        return;
      }
      console.warn('LLL: YouTube would not hand over subtitle data for this video, ' +
        'in any format this tried.');
    } catch (err) {
      console.warn('LLL: could not load subtitles —', err && err.message);
    }
    fallBackToWatching();
  }

  /**
   * The whole transcript, gotten the way YouTube's own "Show transcript"
   * button does: not the closed-caption file, but the panel behind it.
   *
   * Two requests. The first — the same one that loads the page below the
   * player — carries a one-time "params" token buried somewhere in it, under
   * a key called getTranscriptEndpoint; the second spends that token at a
   * dedicated endpoint and gets the actual lines back. Both fields are found
   * by searching the response for their key rather than assuming one exact
   * path to them, because that path is undocumented and has been seen to move
   * before now — a name search survives that better than a fixed route in.
   *
   * This is worth trying ahead of the caption file, not just alongside it:
   * it is what real people actually click, so YouTube has more reason to keep
   * it answering reliably than an old download link almost nobody uses by
   * hand.
   */
  async function fetchViaTranscriptPanel(id) {
    var cfg = ytConfig();
    if (!cfg) return null;
    var context = cfg.context || { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } };

    var page = await ytPost('next', cfg.key, context, { videoId: id });
    if (!page) return null;

    var params = findKey(page, 'getTranscriptEndpoint');
    params = params && params.params;
    if (!params) {
      console.log('LLL: this video offers no transcript panel.');
      return null;
    }

    var data = await ytPost('get_transcript', cfg.key, context, { params: params });
    if (!data) return null;

    var segments = findAllKey(data, 'transcriptSegmentRenderer');
    if (!segments.length) {
      console.warn('LLL: the transcript panel answered with no lines in it.');
      return null;
    }

    var out = [];
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var text = segmentText(seg);
      if (!text) continue;
      out.push({ start: Number(seg.startMs) / 1000, end: Number(seg.endMs) / 1000, text: text });
    }
    return out;
  }

  async function ytPost(endpoint, key, context, body) {
    var res = await backgroundFetch('https://www.youtube.com/youtubei/v1/' + endpoint +
      '?key=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ context: context }, body))
    });
    if (!res) return null;
    if (!res.ok) {
      console.warn('LLL:', endpoint, 'request came back', res.status);
      return null;
    }
    try {
      return JSON.parse(res.text);
    } catch (err) {
      console.warn('LLL:', endpoint, 'response was not valid JSON —', err && err.message);
      return null;
    }
  }

  /**
   * Make the request through the background script rather than from here.
   *
   * A content script's fetch looks like it runs as the page, but for network
   * purposes Firefox does not treat it that way: the request is attributed to
   * the extension, which YouTube's internal endpoints do not grant CORS to, so
   * the browser itself withholds the response body — seen directly as "blocked
   * by OpaqueResponseBlocking" in the console. Every earlier attempt at this
   * failed identically regardless of which endpoint or format was asked for,
   * which fits this explanation far better than YouTube choosing to refuse
   * each one individually.
   *
   * The background script does not have this problem: it already reaches an
   * external site successfully for word audio, because a background script
   * with a host permission for that origin gets a real cross-origin fetch,
   * which is what this needs too. `host_permissions` already lists YouTube.
   */
  async function backgroundFetch(url, init) {
    var reply;
    try {
      reply = await api.runtime.sendMessage({
        type: 'ytFetch',
        url: url,
        init: Object.assign({ credentials: 'include' }, init || {})
      });
    } catch (err) {
      console.warn('LLL: could not reach the background script —', err && err.message);
      return null;
    }
    if (!reply || !reply.ok) {
      console.warn('LLL: the background fetch failed —', reply && reply.error);
      return null;
    }
    return reply.result;   // { ok, status, redirected, url, text }
  }

  /** The first value found anywhere under this key, searching depth-first. */
  function findKey(obj, key) {
    if (!obj || typeof obj !== 'object') return null;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var found = findKey(obj[k], key);
      if (found !== null && found !== undefined) return found;
    }
    return null;
  }

  /** Every value found anywhere under this key. */
  function findAllKey(obj, key, out) {
    out = out || [];
    if (!obj || typeof obj !== 'object') return out;
    if (Object.prototype.hasOwnProperty.call(obj, key)) out.push(obj[key]);
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      findAllKey(obj[k], key, out);
    }
    return out;
  }

  /** A transcript segment's text: plain, or built from styled runs. */
  function segmentText(seg) {
    var snippet = seg && seg.snippet;
    if (!snippet) return '';
    if (snippet.simpleText) return String(snippet.simpleText).replace(/\s+/g, ' ').trim();
    if (snippet.runs) {
      return snippet.runs.map(function (r) { return r.text || ''; }).join('')
        .replace(/\s+/g, ' ').trim();
    }
    return '';
  }

  /**
   * Try more than one response format for the same track.
   *
   * json3 is the usual choice and what most subtitle tools ask for. YouTube's
   * own default format (plain timedtext XML) is tried next on the chance that
   * only json3 is being withheld — seen happen once, though in the case that
   * prompted this both came back empty.
   */
  async function fetchTrack(track) {
    var formats = [
      { label: 'json3', url: track.baseUrl + '&fmt=json3', parse: function (t) { return parse(JSON.parse(t)); } },
      { label: 'default XML', url: track.baseUrl, parse: parseXml }
    ];
    for (var i = 0; i < formats.length; i++) {
      var a = formats[i];
      console.log('LLL: trying the', a.label, 'format');
      var text = await request(a.url);
      if (!text) continue;
      try {
        var cues = a.parse(text);
        if (cues.length) {
          console.log('LLL: the', a.label, 'format answered —', cues.length, 'lines');
          return cues;
        }
        console.warn('LLL: the', a.label, 'format answered but had no lines in it.');
      } catch (err) {
        console.warn('LLL: could not read the', a.label, 'response —', err && err.message);
      }
    }
    return null;
  }

  /** YouTube's default timedtext format: <text start="1.2" dur="2.3">line</text>. */
  function parseXml(text) {
    var doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) return [];
    var nodes = doc.getElementsByTagName('text');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var start = parseFloat(node.getAttribute('start') || '0');
      var dur = parseFloat(node.getAttribute('dur') || '0');
      // DOMParser has already turned &amp; and friends back into real
      // characters, which is why this needs no decoding of its own.
      var line = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!line) continue;
      var end = start + dur;
      if (out.length && out[out.length - 1].end > start) out[out.length - 1].end = start;
      out.push({ start: start, end: end, text: line });
    }
    return out;
  }

  /**
   * Fetch the subtitle file, through the background script — see
   * backgroundFetch for why a content script cannot do this reliably itself.
   * An empty body with a 200 status is still a real possibility even from
   * there: whether that is a blocker rewriting the response or YouTube itself
   * withholding it is told apart by whether the response's own URL still
   * matches what was asked for.
   */
  async function request(url) {
    var res = await backgroundFetch(url, {});
    if (!res) return '';
    if (!res.ok) {
      console.warn('LLL: subtitle request came back', res.status);
      return '';
    }
    if (!res.text) {
      if (res.redirected || res.url !== url) {
        console.warn('LLL: the request was redirected to', res.url,
          '— something on this machine is very likely intercepting it, not YouTube.');
      } else {
        console.warn('LLL: subtitle request succeeded but the body was empty',
          '(no redirect — this is YouTube itself, not a blocker).');
      }
    }
    return res.text;
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

  /**
   * The list of subtitle tracks, tried in order of how likely each is to
   * actually work.
   *
   * The fresh request goes first on purpose. Every reliable transcript tool
   * checked while chasing down why YouTube would answer with a 200 and nothing
   * in it — including the source of a long-established, actively maintained
   * library for exactly this — asks YouTube for the player data again, right
   * before fetching a caption file, rather than reusing whatever the page
   * already had sitting in it. The page's own copy was produced whenever the
   * player first loaded; if a caption URL is only valid for the request that
   * generated it, reusing an old one would look exactly like what happened
   * here: a clean 200, and nothing behind it.
   */
  async function captionTracks(id) {
    var fresh = await freshCaptionTracks(id);
    if (fresh) return fresh;

    var found = playerResponse();
    if (found) {
      var tracks = tracksFrom(found.data, found.from);
      if (tracks) return tracks;
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

  /**
   * Ask YouTube for this video's player data right now, the same call the page
   * itself makes on load, rather than reading a copy that could be minutes
   * old. `ytcfg` is the page's own configuration object — the API key and
   * client context every request on the page already uses — read the same way
   * the player object is: through `wrappedJSObject`.
   */
  async function freshCaptionTracks(id) {
    var cfg = ytConfig();
    if (!cfg) return null;
    var context = cfg.context || { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } };
    var data = await ytPost('player', cfg.key, context, { videoId: id });
    return data ? tracksFrom(data, 'a fresh request') : null;
  }

  /**
   * The API key every request on this page already uses.
   *
   * A silent failure here previously meant the fresh request was never really
   * tried, and nothing said so — the code just quietly fell back to the stale
   * copy, which looked identical in the console to the fresh path having been
   * attempted and lost. Every path here now says what happened.
   */
  function ytConfig() {
    try {
      var cfg = window.wrappedJSObject && window.wrappedJSObject.ytcfg;
      if (cfg && typeof cfg.get === 'function') {
        var key = cfg.get('INNERTUBE_API_KEY');
        if (key) return { key: key, context: cfg.get('INNERTUBE_CONTEXT') };
      }
    } catch (err) {
      console.warn('LLL: could not read ytcfg —', err && err.message);
    }

    // ytcfg was not reachable as a live object, or did not have a key on it.
    // The same key sits in the page's own source as plain text — the same
    // fallback captionTracks already uses when the live objects come up empty.
    var match = document.documentElement.innerHTML.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    if (match) return { key: match[1], context: null };

    console.warn('LLL: could not find an API key anywhere on this page — cannot make a fresh request.');
    return null;
  }

  function tracksFrom(data, from) {
    try {
      var list = data && data.captions &&
        data.captions.playerCaptionsTracklistRenderer &&
        data.captions.playerCaptionsTracklistRenderer.captionTracks;
      if (!list || !list.length) return null;
      var out = [];
      for (var i = 0; i < list.length; i++) {
        out.push({ languageCode: String(list[i].languageCode), baseUrl: String(list[i].baseUrl) });
      }
      console.log('LLL: found', out.length, 'subtitle tracks via', from);
      return out;
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
  // Plan 2: read the screen
  // -------------------------------------------------------------------------

  var observing = false;
  var observedContainer = null;
  var captionObserver = null;
  var openCue = null;    // { start, text } — a line currently being timed

  function fallBackToWatching() {
    state = 'watching';
    console.log('LLL: reading captions off the screen instead of asking for the file — ' +
      'make sure Japanese is the caption language turned on in the player.');
    startObserving();
  }

  function startObserving() {
    if (observing) return;
    observing = true;
    setInterval(attachObserver, 1000);   // YouTube periodically replaces this element
    setInterval(checkCaption, 250);      // a plain safety net alongside the observer
    attachObserver();
  }

  function attachObserver() {
    var container = document.querySelector('.ytp-caption-window-container, .captions-text');
    if (container === observedContainer) return;
    if (captionObserver) captionObserver.disconnect();
    observedContainer = container;
    if (!container) return;
    captionObserver = new MutationObserver(checkCaption);
    captionObserver.observe(container, { childList: true, subtree: true, characterData: true });
    checkCaption();
  }

  function captionText() {
    var el = document.querySelector('.ytp-caption-window-container, .captions-text');
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  /**
   * Text changed on screen: close whatever line was open, open whatever is new
   * — unless the new text is plainly the same line still being revealed.
   *
   * Auto-generated captions are very often drawn incrementally, word by word,
   * as speech recognition catches up rather than appearing all at once. Toward
   * the end of a sentence, this looked like several unrelated short "lines" in
   * a row, and only the last fragment reached the one-second floor to be kept
   * — so the recorded cue started wherever that last fragment began, not at
   * the true start of the sentence. Recording 今回の動画では… came out starting
   * at 動画 for exactly this reason.
   */
  function checkCaption() {
    if (!enabled || !video) return;
    var text = captionText();
    var current = openCue ? openCue.text : '';
    if (text === current) return;

    if (openCue && text && isContinuation(current, text)) {
      openCue.text = text;
      return;
    }

    var now = video.currentTime;
    if (openCue && now - openCue.start >= MIN_OBSERVED_SECONDS) {
      upsertCue({ start: openCue.start, end: now, text: openCue.text });
    }
    openCue = text ? { start: now, text: text } : null;
  }

  /** Is `next` plausibly the same line as `prev`, just further revealed? */
  function isContinuation(prev, next) {
    if (!prev) return false;
    if (next.indexOf(prev) === 0 || prev.indexOf(next) === 0) return true;
    // Auto-generated captions occasionally revise earlier words as recognition
    // improves, not only add to the end, so a large shared prefix counts too.
    var shared = commonPrefixLength(prev, next);
    return shared >= 3 && shared >= Math.min(prev.length, next.length) * 0.6;
  }

  function commonPrefixLength(a, b) {
    var i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }

  function upsertCue(cue) {
    insertObserved(cues, cue);
    index = 0;   // cueAt's forward-scan position no longer means anything reliable
  }

  /**
   * Add a freshly timed line into the ones seen so far.
   *
   * Rewatching a scene shows the same line again; without this it would appear
   * a second time in `cues`, and A/D would stutter — stepping to what looks
   * like a new line that says exactly what the one before it said. A line
   * recurring within a second of where it was seen last is treated as the same
   * one and its timing is simply refreshed. Kept sorted by start time, since
   * rewinding to rewatch means lines are not always seen in order.
   */
  function insertObserved(list, cue) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].text === cue.text && Math.abs(list[i].start - cue.start) < 1) {
        list[i] = cue;
        return list;
      }
    }
    var at = 0;
    while (at < list.length && list[at].start < cue.start) at++;
    list.splice(at, 0, cue);
    return list;
  }

  // -------------------------------------------------------------------------
  // Drawing them, in LLL's own look
  // -------------------------------------------------------------------------

  // Same palette as the popup: a dark card, one bright text colour, one border
  // colour, the same font stack. Whatever supplied the timing — the fetched
  // file or the screen itself — the line you actually see is always drawn by
  // LLL, so it never gets mistaken for YouTube's own plain caption box.
  var overlay = null;
  var overlayLine = null;
  var hideNative = null;

  function ensureOverlay() {
    if (overlay) return;

    // YouTube's own caption box is hidden rather than touched any other way:
    // in the on-screen fallback its text is still being read as the source of
    // the timing, so it has to go on updating — it just should not also be
    // visible sitting underneath LLL's version of the same line.
    hideNative = document.createElement('style');
    hideNative.textContent =
      '.ytp-caption-window-container,.captions-text{opacity:0!important;pointer-events:none!important;}';
    document.head.appendChild(hideNative);

    var player = document.querySelector('.html5-video-player') || document.body;
    overlay = document.createElement('div');
    overlay.setAttribute('data-lll-subtitle', '');
    overlay.style.cssText = [
      'position:absolute', 'left:0', 'right:0', 'bottom:4%', 'display:none',
      'z-index:60', 'justify-content:center', 'pointer-events:none', 'padding:0 6%'
    ].join(';');

    overlayLine = document.createElement('span');
    // The text itself must stay hoverable — that is the whole point of timing
    // subtitles at all — even though the box around it should not swallow
    // clicks meant for the player underneath.
    overlayLine.style.cssText = [
      'pointer-events:auto', 'user-select:text', 'cursor:default', 'max-width:88%',
      'background:#16171a', 'border:1px solid #292b30', 'border-radius:6px',
      'box-shadow:0 8px 28px rgba(0,0,0,.5)', 'color:#f4f5f7',
      'padding:9px 22px',
      'font:500 34px/1.5 -apple-system,"Segoe UI","Hiragino Kaku Gothic ProN",' +
        '"Yu Gothic UI",Meiryo,sans-serif',
      'text-align:center', 'white-space:pre-wrap'
    ].join(';');
    overlay.appendChild(overlayLine);
    player.appendChild(overlay);
  }

  /**
   * Whatever line is playing right now, drawn in LLL's own style.
   *
   * In the on-screen fallback, a line only enters `cues` once it has ended —
   * its end time is not known until the next one begins. Without checking
   * `openCue` too, the overlay would always be exactly one line behind: it
   * would show nothing for whichever line is currently in progress.
   */
  function renderCue() {
    if (!enabled || !video || (!cues.length && !openCue)) {
      if (overlay) overlay.style.display = 'none';
      return;
    }
    var cue = cueAt(video.currentTime);
    var text = cue ? cue.text
      : (openCue && video.currentTime >= openCue.start ? openCue.text : null);
    if (!text) {
      if (overlay) overlay.style.display = 'none';
      return;
    }
    ensureOverlay();
    overlay.style.display = 'flex';
    if (overlayLine.textContent !== text) overlayLine.textContent = text;
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
    parseXml: parseXml,
    findKey: findKey,
    findAllKey: findAllKey,
    segmentText: segmentText,
    step: step,
    insertObserved: insertObserved,
    isContinuation: isContinuation,
    status: function () { return state; },
    _setCues: function (list) { cues = list; state = 'ready'; }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LLLSubtitles;
