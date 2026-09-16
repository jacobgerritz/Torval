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
 * That was the whole of this file, and on its own it was not enough: the
 * request goes out from this page and its answer is read somewhere none of
 * the hooks above can see, not on the page, not in a worker, not down a
 * channel. Every place a reply can become an object was watched and every one
 * of them stayed empty.
 *
 * So there is a second way in here now, and it is the one that actually pays.
 * The manifest is not the only plain thing Netflix fetches: the subtitle file
 * itself is fetched, unencrypted, from oca.nflxvideo.net, as an opaque `?o=`
 * address with no file extension and TTML inside it. Subtitles are not part of
 * what the DRM protects, so the player downloads them the way any page
 * downloads any file. Whatever track the viewer has turned on in Netflix's own
 * player comes past this window as plain text, in full, with every timing in
 * it, and taking a copy of it needs no manifest, no injected format and no
 * guess about where the answer is read.
 *
 * That is what asbplayer does now too. It used to carry Netflix-specific code
 * and no longer has a single file with Netflix in its name: it watches
 * responses for anything shaped like subtitles instead. A site that changes
 * its internals every few months cannot be followed by knowing its internals.
 *
 * Both ways are kept. The manifest one, when it works, hands over every track
 * before a second has played, which is strictly better; the file one needs the
 * viewer to turn the subtitles on, and then always works.
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

  // Where Netflix keeps the files themselves. The address carries no file
  // extension and no content type worth trusting, so the host is the only
  // thing about a request that says "this could be the subtitles" before its
  // body has been looked at.
  var FILES = /[.]nflxvideo[.]net$/i;
  var BIGGEST = 8 * 1024 * 1024;   // a subtitle file is tens of KB; this is slack

  /** The episode playing, as the address says. */
  function movieId() {
    var match = /[/]watch[/]([0-9]+)/.exec(location.pathname);
    return match ? match[1] : '';
  }

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
        if (!asked++) {
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
    var offered = usable(tracks);
    if (!offered.length) {
      var names = [];
      for (var i = 0; i < tracks.length; i++) names.push(String(tracks[i].language));
      say('this title offers no subtitle track as a plain file. It offers:',
        names.join(', ') || '(nothing)');
      return;
    }
    // Which language is being read is LLL's question, not this file's: this
    // is page code and knows nothing about the extension's settings. So every
    // usable track goes over the wall and the content script, which does know,
    // asks for the one it wants back.
    offering = {};
    for (var t = 0; t < offered.length; t++) offering[offered[t].url] = String(movie || '');
    say('this title offers', offered.length, 'subtitle tracks as plain files:',
      offered.map(function (o) { return o.language; }).join(', '));
    window.postMessage({
      lll: 'lll-netflix-tracks', movie: String(movie || ''), tracks: offered
    }, '*');
  }

  /*
   * Which track the content script is allowed to ask for, by address. A page
   * has many scripts on it and any of them can post a message to this window;
   * fetching whatever address one of them names would be handing out a fetch.
   * Only the addresses that came out of Netflix's own track list are here.
   */
  var offering = {};

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var data = e.data;
    if (!data || data.lll !== 'lll-netflix-fetch' || typeof data.url !== 'string') return;
    if (!Object.prototype.hasOwnProperty.call(offering, data.url)) return;
    load(offering[data.url], { url: data.url });
  });

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
      var where = this.url;
      try {
        // Every reply, not only those whose address says "manifest". That
        // filter is what hid this: the address in the payload is Netflix's
        // own name for the request and has nothing to do with where the
        // request is actually sent, which is why no fetch matching it was
        // ever seen leaving this frame either. What each reply costs now is
        // one property lookup, which is nothing.
        //
        // A derived promise, so a failure here can never become an
        // unhandled rejection on the one the player is waiting for.
        answer.then(function (value) { fromReply(value, where); }, function () {});
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
        noteRequest(this.__lllUrl);
        this.addEventListener('load', function () {
          try {
            // The subtitle file, if this was it. Read whichever way the
            // player asked for the body: it takes some of them as text and
            // some as bytes, and a subtitle file is small either way.
            if (couldBeFile(this.__lllUrl)) {
              var body = '';
              if (!this.responseType || this.responseType === 'text') body = this.responseText;
              else if (this.responseType === 'arraybuffer' && this.response &&
                this.response.byteLength < BIGGEST) {
                body = new TextDecoder('utf-8').decode(new Uint8Array(this.response));
              }
              if (body && caught(body, this.__lllUrl)) return;
            }
            if (this.responseType && this.responseType !== 'text') {
              if (this.responseType === 'json') fromReply(this.response, this.__lllUrl);
              return;
            }
            // A string search that nearly always fails, which is cheaper
            // than parsing a reply that was already parsed once.
            var text = this.responseText;
            if (text && text.indexOf('timedtexttracks') !== -1) {
              fromReply(parse(text), this.__lllUrl);
            }
          } catch (err) { /* not ours to read */ }
        });
      } catch (err) { /* leave the request alone */ }
      return realSend.apply(this, arguments);
    };
  }

  /**
   * Listen to what the workers say.
   *
   * The reply is not read on this page by any of the three ways a reply
   * becomes an object, and the player holds no file and no cues. What is left
   * is that Netflix hands the request to a worker, which does the encryption,
   * sends it, decrypts what comes back, reads it there and posts the result
   * home as an object. Nothing of that passes through anything on this page,
   * except the last step: the object arriving.
   *
   * So that is where to stand. Every worker the page makes gets a listener
   * added to it, which is all this does; it reads what the worker sent and
   * changes nothing. A Proxy rather than a replacement class, so that Worker
   * is still Worker in every other respect.
   *
   * Most of what a worker sends here is media, arriving as raw bytes, and
   * those are dropped in one test before anything is looked at.
   */
  var workers = 0;

  if (typeof Worker !== 'undefined' && typeof Proxy !== 'undefined') {
    try {
      Worker = new Proxy(Worker, {
        construct: function (Real, args) {
          var worker = Reflect.construct(Real, args);
          try {
            if (!workers++) say('the player is using workers, starting with', String(args[0]));
            worker.addEventListener('message', function (e) { fromWorker(e.data); });
          } catch (err) { /* a worker that cannot be listened to still works */ }
          return worker;
        }
      });
    } catch (err) {
      say('could not listen to the workers:', err && err.message);
    }
  }

  function fromWorker(data) {
    try {
      if (typeof data === 'string') {
        if (data.indexOf('timedtexttracks') !== -1) fromReply(parse(data));
        return;
      }
      if (!data || typeof data !== 'object') return;
      // Media, and there is a great deal of it.
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return;
      if (holdsTracks(data, 0)) fromReply(data);
    } catch (err) { /* not ours to read */ }
  }

  /**
   * Is the track list somewhere in here? Bounded hard, in depth and in how
   * much it will look at, because this runs on every message every worker
   * sends and some of them are busy.
   */
  function holdsTracks(node, depth) {
    if (!node || typeof node !== 'object' || depth > 4) return false;
    if (node.timedtexttracks) return true;
    var looked = 0;
    for (var key in node) {
      if (++looked > 40) return false;
      var value = node[key];
      if (!value || typeof value !== 'object') continue;
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) continue;
      if (holdsTracks(value, depth + 1)) return true;
    }
    return false;
  }

  /** A reply, however it was read. Only the ones with tracks say anything. */
  function fromReply(value, where) {
    try {
      if (!value || typeof value !== 'object') return;
      var tracks = value.timedtexttracks ||
        (value.result && value.result.timedtexttracks);
      if (!tracks) return;
      if (!seenReply) {
        seenReply = true;
        say('found the track list, in the reply from', String(where || 'somewhere').slice(0, 110));
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
   * Every track that is really there to be read, said plainly.
   *
   * Forced narrative is the track that translates a sign on a wall in an
   * otherwise undubbed scene, a handful of lines for a whole film, and the
   * "none" track is the absence of one. Neither is a subtitle track in the
   * sense of something to read along with.
   *
   * Closed captions are kept but marked: they write out speaker names and
   * sounds as well as speech, so the plain subtitle track is the better read
   * wherever a title has both, and the choosing happens on the other side.
   */
  function usable(tracks) {
    var out = [];
    for (var i = 0; i < tracks.length; i++) {
      var track = tracks[i];
      if (track.isForcedNarrative || track.isNoneTrack) continue;
      var file = track.ttDownloadables && track.ttDownloadables[WEBVTT];
      var urls = file && file.urls;
      if (!urls || !urls.length || !urls[0] || !urls[0].url) continue;
      out.push({
        language: String(track.language || ''),
        captions: track.rawTrackType === 'closedcaptions',
        url: String(urls[0].url)
      });
    }
    return out;
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
      window.postMessage({
        lll: 'lll-netflix-subtitles', movie: movie, format: 'vtt', text: vtt, vtt: vtt
      }, '*');
    }).catch(function (err) {
      fetched = '';                       // let a later attempt try again
      say('could not fetch the subtitle file:', err && err.message);
    });
  }

  // ---------------------------------------------------------------------
  // The file itself, on its way to the player
  // ---------------------------------------------------------------------

  /*
   * A subtitle file, recognised by what is in it rather than by where it came
   * from. Netflix's addresses say nothing: no extension, no useful content
   * type, one opaque query parameter. What the body is, though, is either
   * plainly WebVTT or plainly TTML, and both announce themselves in their
   * first few characters.
   */
  var caughtText = '';

  function looksLikeSubtitles(text) {
    if (!text || typeof text !== 'string' || text.length > BIGGEST) return '';
    var head = text.slice(0, 400);
    if (/^\uFEFF?WEBVTT/.test(head)) return 'vtt';
    // TTML, which is what Netflix actually serves unless the manifest was
    // asked for something else: an XML document whose root element is <tt>.
    if (/<tt[\s>]/.test(head) && /ttml|ttaf/i.test(head)) return 'ttml';
    return '';
  }

  /** Hand a caught file over to the content script, once each. */
  function caught(text, where) {
    var format = looksLikeSubtitles(text);
    if (!format) return false;
    if (text === caughtText) return true;      // the same file, fetched twice
    caughtText = text;
    caughtFor = movieId();
    got = true;
    say('caught the subtitle file the player is using,', text.length,
      'characters of ' + format.toUpperCase() + ', from',
      String(where || 'somewhere').slice(0, 90));
    window.postMessage({
      lll: 'lll-netflix-subtitles', movie: movieId(), format: format, text: text,
      // Kept under its old name as well, so nothing that was reading `vtt`
      // has to know that a file can now arrive in two formats.
      vtt: format === 'vtt' ? text : ''
    }, '*');
    return true;
  }

  /**
   * Worth reading the body of? Only a handful of requests are, and a subtitle
   * file is one of them, so everything else is dropped on the address alone
   * rather than on its contents: the player fetches a great deal of video and
   * reading any of it into a string would be absurd.
   */
  function couldBeFile(where) {
    if (!where) return false;
    try {
      return FILES.test(new URL(where, location.href).hostname);
    } catch (err) {
      return false;
    }
  }

  /** A reply that says outright what it is. Cheaper than reading it to see. */
  function saysSubtitles(res) {
    try {
      var type = res.headers && res.headers.get && res.headers.get('content-type');
      return !!type && /vtt|ttml|dfxp|xml[+]|text[/]xml/i.test(String(type));
    } catch (err) {
      return false;
    }
  }

  function sniffResponse(res) {
    try {
      if (!res) return;
      // Either the address is one of Netflix's own file addresses, or the
      // reply says what it is. Netflix's own say nothing useful, which is why
      // the address is checked at all; another host that serves a subtitle
      // file properly labelled is worth catching too.
      if (!couldBeFile(res.url) && !saysSubtitles(res)) return;
      // A clone, so the player still gets its own body unread. Reading the
      // real one would empty it.
      res.clone().text().then(function (text) { caught(text, res.url); },
        function () { /* not text, so not subtitles */ });
    } catch (err) { /* leave the response alone */ }
  }

  // ---------------------------------------------------------------------
  // Turning the track on, so there is a file to catch
  // ---------------------------------------------------------------------

  /*
   * The file is only downloaded when the player is going to show something,
   * which meant the viewer had to go into Netflix's own menu and turn on the
   * language LLL reads, and then watch two sets of subtitles at once.
   *
   * The player will do it when asked. It keeps a list of its timed text
   * tracks and a method to choose one, the same pair its own menu is built
   * on, so LLL selects the track it wants, waits for the file that selecting
   * it causes to be fetched, and puts the viewer's own choice straight back.
   * What is left behind is the player exactly as it was and the whole
   * subtitle file in hand.
   *
   * A moment of Netflix's own subtitles may flash up in between. That is the
   * whole cost, and it happens once per episode.
   *
   * If the viewer has already turned that language on themselves, nothing is
   * touched: there is a file coming anyway, and putting a choice "back"
   * that they made on purpose would be taking it away.
   */
  var WAIT_PASSES = 40;      // half-seconds to wait for the file before giving up
  var want = null;           // language codes the extension asked for
  var arrangedFor = '';      // the episode already seen to
  var caughtFor = '';        // the episode whose file is in hand

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var data = e.data;
    if (!data || data.lll !== 'lll-netflix-want' || !Array.isArray(data.languages)) return;
    want = data.languages.map(String);
    arrangedFor = '';        // a language change is a reason to look again
    arrange();
  });

  /** The player for whatever is playing, which is page code's to reach. */
  function playing() {
    try {
      var app = window.netflix && window.netflix.appContext;
      var api = app && app.state && app.state.playerApp && app.state.playerApp.getAPI();
      if (!api || !api.videoPlayer) return null;
      var ids = api.videoPlayer.getAllPlayerSessionIds();
      if (!ids || !ids.length) return null;
      var id = ids[0];
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i]).indexOf('watch-') === 0) { id = ids[i]; break; }
      }
      return api.videoPlayer.getVideoPlayerBySessionId(id) || null;
    } catch (err) {
      return null;
    }
  }

  /** What language a track is in, under whichever name this player uses. */
  function trackLanguage(track) {
    if (!track) return '';
    return String(track.bcp47 || track.language || track.locale || '');
  }

  function wantsLanguage(track) {
    var code = trackLanguage(track);
    if (!code) return false;
    for (var i = 0; i < want.length; i++) {
      if (code === want[i] || code.slice(0, 2) === String(want[i]).slice(0, 2)) return true;
    }
    return false;
  }

  /** The track to turn on: the language asked for, speech rather than sounds. */
  function choose(list) {
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var track = list[i];
      if (!track || track.isForcedNarrative || track.isNoneTrack) continue;
      if (!wantsLanguage(track)) continue;
      var captions = /closedcaptions|assistive/i.test(
        String(track.rawTrackType || track.trackType || ''));
      if (best && !(best.captions && !captions)) continue;
      best = { track: track, captions: captions };
    }
    return best && best.track;
  }

  function arrange() {
    if (!want || !want.length) return;
    var id = movieId();
    if (!id || id === arrangedFor || id === caughtFor) return;

    var player = playing();
    if (!player || !player.getTimedTextTrackList || !player.setTimedTextTrack) return;

    var list;
    try { list = player.getTimedTextTrackList(); } catch (err) { return; }
    if (!list || !list.length) return;      // too early; the next pass will do

    arrangedFor = id;
    var track = choose(list);
    if (!track) {
      var offered = [];
      for (var i = 0; i < list.length; i++) offered.push(trackLanguage(list[i]) || '?');
      say('this title has no', want[0], 'subtitle track. It offers:', offered.join(', '));
      return;
    }

    var before = null;
    try { before = player.getTimedTextTrack && player.getTimedTextTrack(); } catch (err) { /* none */ }
    if (before && !before.isNoneTrack && trackLanguage(before) === trackLanguage(track)) {
      say('the', trackLanguage(track), 'subtitles are already on, so its file is on its way');
      return;
    }

    say('turning the', trackLanguage(track),
      'track on for a moment, to make the player fetch its file');
    try {
      player.setTimedTextTrack(track);
    } catch (err) {
      say('the player would not change track:', err && err.message);
      return;
    }

    // Back to whatever the viewer had, the moment the file is in hand, or
    // after twenty seconds if it never comes: leaving somebody else's
    // subtitles turned on is worse than not having tried.
    var passes = 0;
    var putBack = setInterval(function () {
      if (!caughtText && ++passes < WAIT_PASSES) return;
      clearInterval(putBack);
      if (caughtText) caughtFor = id;
      try {
        if (before) player.setTimedTextTrack(before);
      } catch (err) { /* the viewer can set it back themselves */ }
      say(caughtText
        ? 'got the file; the player is back as it was'
        : 'no file came, and the player is back as it was');
    }, 500);
  }

  // A page that never reloads: the next episode starts, and its own file has
  // to be arranged for all over again.
  setInterval(arrange, 2000);

  /**
   * Is the request even sent from here?
   *
   * Everything so far has assumed it is: the payload is built here, so the
   * request must go out from here and its answer must come back here. The
   * first half of that is proved, the second half is only an assumption, and
   * every place the answer could arrive has now been watched and found empty.
   * So the assumption is what to test. If nothing carrying "manifest" is ever
   * fetched from this frame, the payload is going somewhere else to be sent,
   * and where it goes is the whole answer.
   */
  var sent = 0;
  if (typeof fetch === 'function') {
    var realFetch = fetch;
    fetch = function (input, init) {
      var where = '';
      try {
        where = typeof input === 'string' ? input : (input && input.url) || '';
        noteRequest(where);
      } catch (err) { /* leave the request alone */ }
      var answer = realFetch.apply(this || window, arguments);
      try {
        // A derived promise: a failure in here can never become an unhandled
        // rejection on the one the player is waiting for. What it costs for
        // every other request on the site is one header lookup.
        answer.then(function (res) { sniffResponse(res); }, function () {});
      } catch (err) { /* leave the request alone */ }
      return answer;
    };
  }

  /** How many requests went out after a title was asked about. */
  function noteRequest(where) {
    if (asked && where) sent++;
  }

  /**
   * Messages from a service worker, and messages down a channel.
   *
   * There were no Workers at all, which rules out the obvious answer and
   * leaves the two quieter ones. A service worker is not a Worker and would
   * not have been counted; neither is a MessageChannel, which is how a page
   * and a service worker usually talk once they have been introduced.
   *
   * The port is watched by wrapping the setter for its `onmessage`, rather
   * than by adding a listener of our own. A listener would need the port
   * started, and starting a port before the page is ready for it would
   * deliver its messages to nobody. Wrapping the handler the page installs
   * changes no timing at all: the page still gets every message, in order,
   * and this sees a copy on the way past.
   */
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    try {
      navigator.serviceWorker.addEventListener('message', function (e) {
        fromWorker(e.data);
      });
    } catch (err) { /* nothing to listen to */ }
  }

  var ports = 0;

  if (typeof MessagePort !== 'undefined') {
    try {
      var onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
      if (onmessage && onmessage.set) {
        Object.defineProperty(MessagePort.prototype, 'onmessage', {
          configurable: true,
          enumerable: onmessage.enumerable,
          get: onmessage.get,
          set: function (handler) {
            var wrapped = typeof handler === 'function' ? function (e) {
              try { ports++; fromWorker(e.data); } catch (err) { /* not ours */ }
              return handler.apply(this, arguments);
            } : handler;
            return onmessage.set.call(this, wrapped);
          }
        });
      }
    } catch (err) {
      say('could not listen to the channels:', err && err.message);
    }
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
    if (seenReply) {
      say('the reply came back with no track list in it.');
      return;
    }
    // Where this got to, in one line, for whoever picks it up next. The
    // request goes out and its reply is read somewhere none of this can
    // see: not on the page, not in a worker, not down a channel. See the
    // README for the four ways of getting in here that were tried.
    say('no subtitle file. The request was built here and sent elsewhere (' +
      sent + ' requests, ' + workers + ' workers, ' + ports + ' channel messages).');
  }, 25000);
})();
