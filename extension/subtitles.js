/*
 * Torval, timing YouTube's subtitles
 *
 * The point of this file is not to show subtitles. YouTube already does that, 
 * it is to know exactly when each line starts and ends, which YouTube's own
 * captions never tell anyone. That timing is what lets a line be replayed and
 * recorded precisely, and what lets A and D jump between lines.
 *
 * Three ways of getting it, tried in order, each is a fallback for the one
 * before it, not an alternative to pick between:
 *
 *   1. Ask for the transcript the way YouTube's own "Show transcript" button
 *      does. Not the closed-caption file, a separate panel with its own
 *      endpoint, reached through a one-time token buried in the page's own
 *      data. This is what real people click, so YouTube has more reason to
 *      keep it answering reliably than a download link almost nobody uses by
 *      hand, and it is the only one of the three that has the whole video's
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
 *      is known ahead of watching it. D cannot jump to an unseen line, and
 *      nothing here can tell you the whole video's vocabulary in advance.
 *
 * Nothing here asks the viewer to set anything up. Which track to fetch is
 * decided from the language being read, against the list of tracks the video
 * actually has, not from whatever the player happens to be showing; a
 * transcript in the wrong language is refused rather than used. The caption
 * language picked in the player is therefore beside the point, except in the
 * last case below.
 *
 * Torval leaves the CC button alone. It is YouTube's, it means what it says, and
 * Torval draws its own line from the track it fetched itself: either can be on
 * without the other, and both at once is a choice rather than an accident.
 * The single exception is the third way above, which works by reading what is
 * on screen and so cannot work with nothing on screen: there, and only once
 * everything else has failed, Torval turns the player's own captions on, in the
 * language being read, and never off again.
 */

// Loaded first in the extension and already a global; under Node (the test
// suite) it is pulled in here.
if (typeof TorvalJapanese === 'undefined' && typeof require !== 'undefined') {
  var TorvalJapanese = require('./japanese.js');
}
if (typeof TorvalKeys === 'undefined' && typeof require !== 'undefined') {
  var TorvalKeys = require('./keys.js');
}

var TorvalSubtitles = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;
  // Which tracks to fetch, from the language being read rather than fixed
  // here: this used to be a Japanese-only list, so an Italian video was
  // reported as having no subtitle track no matter how many Italian tracks
  // it offered, and fell all the way back to reading the captions off the
  // screen.
  //
  // And an empty list rather than a Japanese one when there is no profile
  // to ask. A default here is a guess about what somebody is watching, and
  // a wrong guess is not a smaller version of the right one: it fetches a
  // Japanese track and draws it over an Italian film. Wanting nothing is
  // the honest answer, and the only thing that happens is that no track is
  // chosen.
  function languages() {
    var profile = typeof TorvalLang !== 'undefined' ? TorvalLang.profile() : null;
    return (profile && profile.subtitles) || [];
  }
  var MAX_LOOKUP_ATTEMPTS = 12;    // ~12s of retrying before giving up on the player existing
  var MIN_OBSERVED_SECONDS = 0.15; // shorter than this is a DOM flicker, not a line

  var enabled = false;
  var suspended = false;   // the toolbar switch is off


  // How far up the video the line sits, as a percentage of its height, and
  // where it started. Kept in storage so a video watched tomorrow puts them
  // back where you left them.
  // How far a rolling caption is allowed to grow before it counts as a new
  // line: about as long as a subtitle gets, and about as long as one stays
  // on screen.
  // How many passes of watch(), which is one a second, to wait for a site to
  // hand over its own subtitle file before reading the screen instead.
  var WAIT_TO_BE_HANDED = 5;

  var ROLL_CHARACTERS = 60;
  var ROLL_SECONDS = 10;

  /*
   * Skipping the quiet parts.
   *
   * A documentary is half establishing shots and a drama is half faces
   * looking at each other, and none of it is language practice. With the
   * whole transcript already timed, the stretches with nobody speaking are
   * known exactly, so they can be played faster and the speech left alone.
   *
   * The padding matters more than it sounds. A line's timing is written to
   * be comfortable to read, not to be cut on, so speech regularly begins a
   * fraction before its cue and runs a fraction past it; dropping back to
   * normal speed exactly on the timestamp clips the first syllable. A
   * quarter of a second either side costs nothing and fixes it.
   *
   * On top of that, the check runs on a tick, so the lead has to cover a
   * whole tick's worth of playback at whatever speed the video is going,
   * or the slow-down lands after the speech has already started. That is
   * what SKIP_PAD + TICK_SECONDS * rate is: never late, at any speed.
   */
  var TICK_SECONDS = 0.2;
  var SKIP_PAD = 0.25;
  var SKIP_SPEED = 2;
  var MAX_SKIP_SPEED = 8;

  var skipping = false;    // the mode is on
  var fast = false;        // and right now we are in a quiet stretch
  var skipSpeed = SKIP_SPEED;
  var normalRate = 1;      // the speed the video was going before we touched it

  if (api && api.storage) {
    api.storage.local.get('skipSpeed').then(function (stored) {
      if (typeof stored.skipSpeed === 'number') skipSpeed = stored.skipSpeed;
    }).catch(function () {});
    if (api.storage.onChanged) {
      api.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes.skipSpeed) return;
        skipSpeed = changes.skipSpeed.newValue || SKIP_SPEED;
        if (fast && video) video.playbackRate = skipSpeed;
      });
    }
  }

  var BOTTOM_DEFAULT = 4;
  var bottom = BOTTOM_DEFAULT;
  if (api && api.storage) {
    api.storage.local.get('subtitleBottom').then(function (stored) {
      if (typeof stored.subtitleBottom !== 'number') return;
      bottom = stored.subtitleBottom;
      if (overlay) overlay.style.bottom = bottom + '%';
    }).catch(function () {});
  }
  /**
   * The handful of things that are not the same on every video site.
   *
   * Everything else, the timing, the overlay, hovering, mining, A and D, is
   * the same work wherever the video is playing. Only four questions have a
   * different answer per site: is this one of them, which video is playing,
   * where the player draws its own caption text, and where Torval should hang
   * its own line.
   *
   * There are two ways of getting a transcript, and a site uses one or the
   * other. YouTube is asked for one. Netflix is not asked at all: its
   * player is handed a subtitle file of its own, and Torval takes a copy as
   * it goes past, which is what `catches` means. Either way, a site that
   * comes up empty reads the lines off the screen instead.
   */
  var SITES = {
    youtube: {
      host: /(^|[.])youtube[.]com$/,
      fetches: true,
      catches: false,
      id: function () { return new URLSearchParams(location.search).get('v'); },
      captions: '.ytp-caption-window-container, .captions-text',
      // Where the words are inside that box, best first: see captionText for
      // why the box itself is not read.
      //
      // One selector, and deliberately only one. This list used to have
      // .captions-text and .caption-visual-line after it as fallbacks, and
      // both of them are containers rather than lines: the caption window
      // keeps the name of the track and the way into its settings in there
      // beside the words, and whenever the fallback was reached the line
      // came out as "Italian Click for settings È come rinascere…" and was
      // recorded that way, so that one cue said it for the rest of the
      // video. Every word YouTube shows is in a segment. If there are no
      // segments there is nothing being said, and saying nothing is the
      // right answer rather than a missed one.
      lines: ['.ytp-caption-segment'],
      // Anything in the caption box that is a control rather than words,
      // left out of a line even when it sits inside one. See wordsIn.
      furniture: 'button, a, [role="button"], [role="menu"], [role="menuitem"], ' +
        '.ytp-button, .ytp-caption-menu, [class*="caption-window-title"]',
      player: '.html5-video-player',
      seek: null,           // moving the video element is enough here
      // Only ever called once every way of getting the file has failed and
      // the screen is the last thing left to read. See ytCaptionsOn.
      captionsOn: ytCaptionsOn
    },
    netflix: {
      host: /(^|[.])netflix[.]com$/,
      fetches: false,
      id: function () {
        var match = /[/]watch[/]([0-9]+)/.exec(location.pathname);
        return match ? match[1] : null;
      },
      captions: '.player-timedtext',
      lines: ['.player-timedtext-text-container span', '.player-timedtext-text-container'],
      furniture: 'button, a, [role="button"]',
      player: '.watch-video--player-view, .watch-video, .VideoContainer',
      catches: true,
      // Netflix streams in pieces it chose in advance, and moving the
      // video element under it ends the session with error F7375 and an
      // error page. Its player has a seek of its own; that is the one.
      seek: function (seconds) {
        var reader = typeof TorvalNetflix !== 'undefined' ? TorvalNetflix
          : (typeof window !== 'undefined' ? window.TorvalNetflix : null);
        if (reader) reader.seek(seconds);
      },
      captionsOn: null      // Netflix's player has no such handle to pull
    }
  };
  var site = null;

  /** Which of the sites above this address belongs to, if any. */
  function siteFor(hostname) {
    for (var name in SITES) if (SITES[name].host.test(hostname)) return name;
    return null;
  }

  var videoId = null;
  var cues = [];
  var index = 0;
  var video = null;
  var state = 'idle';        // idle | loading | ready | watching | unavailable
  var attempts = 0;

  /**
   * Put the subtitles away, or bring them back, for the switch on the
   * toolbar button. YouTube's own captions were hidden rather than turned
   * off, so handing the screen back is a matter of not hiding them.
   */
  /**
   * Let the line be dragged up and down, for when it sits over something
   * worth seeing.
   *
   * The words in it still have to be hoverable, clickable and selectable, so
   * this cannot simply swallow the pointer. Two things share one gesture and
   * have to be told apart: dragging the line, and dragging across the words
   * to select them for copying.
   *
   * The direction tells them apart, because they never really point the same
   * way. A line of text is wide and one line tall: selecting it means going
   * along it, and moving it out of the way means going up or down the
   * picture. So the first few pixels of a press decide which gesture it is,
   * and it stays that gesture until the button comes back up: clearly
   * downward or upward and the line moves, anything else and the press is
   * left entirely alone, to select as it would on any other text. Moving is
   * still one press and a pull, with nothing to aim at first; it just has to
   * be a pull in the direction moving actually means.
   *
   * A press that goes nowhere is left alone too, and opens the dictionary as
   * usual.
   */
  var DRAG_SLOP = 5;        // pixels before a press is any gesture at all
  var DRAG_STEEPNESS = 1.6; // how much more vertical than horizontal it must be

  function dragging(line) {
    var from = null;
    var moved = false;
    var selecting = false;   // this press was judged to be a selection

    line.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      from = { x: e.clientX, y: e.clientY, bottom: bottom };
      moved = false;
      selecting = false;
    });

    window.addEventListener('pointermove', function (e) {
      if (!from || !overlay || selecting) return;
      var shift = from.y - e.clientY;
      var sideways = Math.abs(e.clientX - from.x);
      if (!moved) {
        // Still deciding. Nothing happens until the pointer has gone far
        // enough to mean anything, and then the steeper of the two wins.
        if (Math.max(Math.abs(shift), sideways) < DRAG_SLOP) return;
        if (Math.abs(shift) < sideways * DRAG_STEEPNESS) { selecting = true; return; }
        moved = true;
      }
      // Dragging up moves it up the picture, so the gap below it grows.
      var height = overlay.parentElement ? overlay.parentElement.clientHeight : 0;
      if (!height) return;
      bottom = Math.max(0, Math.min(88, from.bottom + (shift / height) * 100));
      overlay.style.bottom = bottom + '%';
      // Dragging the box around should not also select the words in it. The
      // browser extends the selection from the mouse event underneath this
      // one and preventDefault here does not reach that, including the few
      // pixels selected while which gesture this was had not been decided,
      // so what it did select is simply dropped again, every frame.
      e.preventDefault();
      try {
        var selection = window.getSelection();
        if (selection && !selection.isCollapsed) selection.removeAllRanges();
      } catch (err) { /* nothing to clear */ }
    });

    window.addEventListener('pointerup', function () {
      if (!from) return;
      var dragged = moved;
      from = null;
      moved = false;
      selecting = false;
      if (!dragged) return;
      // The click that ends a drag is not a click on a word.
      window.addEventListener('click', function (e) {
        e.stopPropagation();
        e.preventDefault();
      }, { capture: true, once: true });
      api.storage.local.set({ subtitleBottom: bottom }).catch(function () {});
    });
  }

  function suspend(state) {
    suspended = !!state;
    if (overlay && suspended) overlay.style.display = 'none';
  }

  /**
   * Start watching, once it is known what to watch for.
   *
   * The wait is the whole point. TorvalLang answers synchronously from a
   * cache, and until storage comes back that cache says Japanese, because
   * that is what every install had before there was anything to choose.
   * This used to start the moment the content script ran, which on a
   * reload is comfortably inside that window, so the first pass went
   * looking for a Japanese track and, on a video that had one, found it
   * and drew it. The reader was on Italian throughout; nothing was wrong
   * with the setting, only with when it was read.
   *
   * lang.js has had `ready()` for exactly this since background.js needed
   * it to open the right dictionary. This is the other caller that needed
   * it and did not know.
   */
  function enable() {
    if (enabled || starting) return;
    starting = true;
    var settled = (typeof TorvalLang !== 'undefined' && TorvalLang.ready)
      ? TorvalLang.ready() : Promise.resolve();
    settled.then(start, start);
  }

  var starting = false;

  function start() {
    if (enabled) return;
    site = null;
    for (var name in SITES) {
      if (SITES[name].host.test(location.hostname)) { site = SITES[name]; break; }
    }
    if (!site) return;
    enabled = true;
    window.addEventListener('keydown', keys, true);
    // Going fullscreen changes how big the line should be, and waiting for
    // the next pass to notice leaves it the old size for a fifth of a
    // second while the picture is already the new one.
    document.addEventListener('fullscreenchange', fitLine);
    window.addEventListener('resize', fitLine);
    // A subtitle that got bigger in the settings gets bigger on the video
    // that is already playing, rather than on the next one.
    if (typeof TorvalLook !== 'undefined') {
      TorvalLook.onChange(function () { paintSkin(); fitLine(); });
    }
    setInterval(watch, 1000);
    setInterval(renderCue, TICK_SECONDS * 1000);
    if (api.runtime.onMessage) api.runtime.onMessage.addListener(onBackgroundMessage);
    watch();
    console.log('Torval: watching for subtitles');
  }

  /**
   * The address YouTube's own player just genuinely requested, caught by the
   * background script and handed over rather than built here. See the
   * comment beside where it is caught, in background.js, for why this is the
   * one address worth trying that everything else so far was not.
   *
   * This can arrive at any time and supersede whatever tier is currently in
   * charge, including replacing the on-screen fallback outright, since a
   * genuine transcript beats one assembled a line at a time regardless of how
   * it was found.
   */
  function onBackgroundMessage(message) {
    if (!message || message.type !== 'timedtextSeen') return;
    if (!videoId || message.url.indexOf('v=' + videoId) === -1) return;   // an ad, or a different tab's video
    // The player asks for whatever track is switched on in the player, which
    // is very often not the language being read: on a video watched with
    // English captions this used to arrive and quietly overwrite a correct
    // Italian transcript with the English one. The address says which
    // language it is for, so it can simply be read.
    if (!wantedTimedtext(message.url)) return;
    loadSeenTrack(message.url);
  }

  /**
   * Is this caption address for the language being read?
   *
   * `lang` is the track's own language; `tlang` is YouTube translating that
   * track into something else on the fly, so when it is present it, and not
   * `lang`, is the language of the text that comes back. An address with
   * neither is not one this can vouch for, and is left alone.
   */
  function wantedTimedtext(url) {
    var params;
    try {
      params = new URL(url).searchParams;
    } catch (err) {
      return false;
    }
    var lang = params.get('tlang') || params.get('lang');
    if (!lang) return false;
    return languages().indexOf(lang) !== -1;
  }

  async function loadSeenTrack(url) {
    var id = videoId;
    console.log('Torval: caught YouTube’s own subtitle request, trying it directly');
    // Tagged so the background script's own listener recognises this as Torval's
    // re-fetch of the address rather than a second genuine request, and does
    // not forward it straight back here again.
    var loaded = await fetchTrack({ baseUrl: url + '&torval=1', languageCode: 'seen' });
    if (videoId !== id) return;   // moved to a different video while fetching
    if (loaded && loaded.length) {
      cues = loaded;
      state = 'ready';
      console.log('Torval:', cues.length, 'subtitle lines ready. YouTube’s own request, reused directly');
    } else {
      console.warn('Torval: YouTube’s own subtitle address did not answer either, something deeper is blocking it.');
    }
  }

  /**
   * A steps back a line, D steps forward. Rewatching a line you did not catch
   * is the commonest thing you do while mining, and dragging the scrub bar to
   * roughly the right place is a poor way to do it.
   */
  function keys(e) {
    // The line currently playing lives in `openCue`, not `cues`, until it
    // ends, so this cannot require `cues` to be non-empty, or the very first
    // line of a video (still open, nothing committed yet) would silently
    // block A and D before step() ever got a chance to look at openCue too.
    if (!enabled || (!cues.length && !openCue) || !video) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    var focused = document.activeElement;
    if (focused && (focused.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName))) return;

    if (TorvalKeys.matches('skip', e)) {
      e.preventDefault();
      e.stopPropagation();
      setSkipping(!skipping);
      return;
    }

    var back = TorvalKeys.matches('back', e);
    if (!back && !TorvalKeys.matches('forward', e)) return;

    e.preventDefault();
    e.stopPropagation();
    jump(back ? -1 : 1);
  }

  function jump(direction) {
    var target = step(video.currentTime, direction, openCue);
    if (!target) return;
    if (site.seek) site.seek(target.start);
    else video.currentTime = target.start;
  }

  /**
   * The line A or D should take you to from here, or null if there is none.
   *
   * In the on-screen fallback, the line currently being spoken is not in
   * `cues` yet, it only gets recorded once it ends. Without also checking the
   * one still in progress, D would work only until you pressed A once: from
   * the line before, there would be nothing later in `cues` to step forward
   * to, since the very next line is the one still open. This is the ordinary
   * case, not a rare one, it happens every single time you rewind and then
   * want to come back.
   */
  function step(now, direction, current) {
    if (direction < 0) {
      // A goes to the line before the one playing, not to the start of the
      // one playing. Hearing something and wanting it again is far and away
      // the commoner reason to reach for it; the start of the line you are
      // already in is A and then D, which costs one more key on the rarer
      // of the two.
      //
      // Which line is playing has to be worked out rather than assumed. The
      // one still in progress is not in `cues` yet, so both are looked at,
      // and only the later of the two counts. Reaching for the end of `cues`
      // instead is what sent A to the end of the video: with the whole
      // transcript known up front, the last line in the list is the last
      // line of the film.
      var at = -1;
      for (var i = 0; i < cues.length; i++) {
        if (cues[i].start <= now + 0.05) at = i; else break;
      }
      var playing = current && current.start <= now + 0.05 &&
        (at < 0 || current.start > cues[at].start) ? current : null;

      // The line in progress is playing, so the one before it is the last
      // one that finished.
      if (playing) return at >= 0 ? cues[at] : null;
      if (at > 0) {
        // A copy of the line being left is not the line before it. Nothing
        // should be filing the same line twice any more, but stepping onto a
        // duplicate is indistinguishable from A doing nothing at all, so it is
        // worth being sure.
        var back = at - 1;
        while (back > 0 && cues[back].text === cues[at].text) back--;
        return cues[back];
      }
      // Inside the first line: its own start is as far back as there is to go.
      if (at === 0) return cues[0];
      // And before the first line there is nowhere to go at all. A must never
      // move the video forwards.
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

  /**
   * Forget this video's subtitles and go and get them again.
   *
   * For a change of language, which makes everything already fetched the
   * wrong language. Without this, switching from Japanese to Italian left
   * the Japanese lines on screen until the video was changed, since that
   * was the only thing that ever cleared them.
   */
  function restart() {
    if (!enabled) return;
    videoId = null;      // watch() clears the rest when it sees the id change
    if (overlay) overlay.style.display = 'none';
    watch();
  }

  function watch() {
    if (!enabled) return;

    var id = site.id();
    if (id !== videoId) {
      videoId = id;
      cues = [];
      index = 0;
      openCue = null;
      state = 'idle';
      attempts = 0;
      caughtFile = '';
      caughtWrong = '';
      console.log('Torval: video is now', id || '(none, not a watch page)');
    }

    // A site that hands its subtitles over does so whenever it pleases, so
    // this looks on every pass rather than only while nothing has arrived: a
    // real transcript replaces lines read off the screen at whatever moment
    // it turns up, including after a whole episode of reading the screen.
    if (id && site.catches) takeCaughtFile(id);

    // Keep trying for a while. This script starts before the site's player
    // exists, so the first look almost always finds nothing; giving up on that
    // would mean never loading subtitles at all. Once a definite answer comes
    // back, ready, watching, or genuinely unavailable, this stops retrying.
    if (id && state === 'idle') {
      attempts++;
      // A site that is asked for its transcript is asked again. A site that
      // waits to be handed one waits a few seconds before settling for the
      // screen, since the file usually arrives about as fast as the video.
      if (site.fetches) { if (attempts <= MAX_LOOKUP_ATTEMPTS) load(id); }
      else if (attempts > WAIT_TO_BE_HANDED) fallBackToWatching();
    }

    video = document.querySelector('video');
  }

  // -------------------------------------------------------------------------
  // Plan 1, on Netflix: take a copy of the player's own subtitle file
  // -------------------------------------------------------------------------

  var caughtFile = "";
  var caughtWrong = "";

  /**
   * The subtitle file Netflix's own player was handed, if one has come in.
   *
   * The catching happens in netflix.js, which explains itself there. All
   * that is left here is to read what it caught,
   * and to be sure it belongs to the episode actually playing: Netflix is one
   * page from beginning to end, so the file for the last episode is still
   * sitting there when the next one starts.
   */
  function takeCaughtFile(id) {
    var reader = typeof TorvalNetflix !== 'undefined' ? TorvalNetflix
      : (typeof window !== 'undefined' ? window.TorvalNetflix : null);
    var caught = reader ? reader.track() : null;
    if (!caught || (caught.text || caught.vtt) === caughtFile) return;
    if (caught.movie && String(caught.movie) !== String(id)) {
      // Said once about a given file, not once a second for the rest of the
      // episode.
      if (caughtWrong !== (caught.text || caught.vtt)) {
        caughtWrong = caught.text || caught.vtt;
        console.log('Torval: Netflix handed over subtitles for', caught.movie,
          'but', id, 'is playing, so they are being left alone.');
      }
      return;
    }
    var file = caught.text || caught.vtt;
    var loaded = caught.format === 'ttml' ? parseTtml(file) : parseVtt(file);
    if (!loaded.length) return;
    caughtFile = file;
    cues = loaded;
    index = 0;
    openCue = null;
    state = 'ready';
    console.log('Torval:', cues.length, 'subtitle lines ready, from the file Netflix',
      'gave its own player');
  }

  /**
   * WebVTT: a stamp line, then the words, then a blank line.
   *
   * Netflix writes furigana into its Japanese subtitles as ruby, a reading
   * in <rt> tags after the word it belongs to. Left in, that reading would
   * be read as more words, so it goes; the kanji it was helping with stays.
   */
  function parseVtt(text) {
    var lines = String(text).replace(/\r/g, '').split('\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var stamp = /^\s*([0-9:.,]+)\s+-->\s+([0-9:.,]+)/.exec(lines[i]);
      if (!stamp) continue;
      var start = clock(stamp[1]);
      var end = clock(stamp[2]);
      var said = [];
      for (i++; i < lines.length && lines[i].trim() !== ''; i++) said.push(lines[i]);
      var line = squash(said.join(' ')
        .replace(/<rt[^>]*>[\s\S]*?<\/rt>/g, '')
        .replace(/<[^>]*>/g, '')
        .replace(/&(amp|lt|gt|quot|#39|nbsp|lrm|rlm);/g, ' '));
      if (!line) continue;
      if (out.length && out[out.length - 1].end > start) out[out.length - 1].end = start;
      out.push({ start: start, end: end, text: line });
    }
    return out;
  }

  /** 00:01:02.500, or 01:02.500, in seconds. */
  function clock(stamp) {
    var parts = String(stamp).replace(',', '.').split(':');
    var total = 0;
    for (var i = 0; i < parts.length; i++) total = total * 60 + (parseFloat(parts[i]) || 0);
    return total;
  }

  /**
   * TTML, which is what Netflix actually serves.
   *
   * The WebVTT above only ever arrives when the manifest was talked into
   * offering it. Left to itself the player downloads timed text as TTML, an
   * XML document of <p> elements with a begin and an end, and that is the file
   * that comes past on the way to the player whatever else happens. Japanese
   * is delivered as IMSC 1.1 rather than plain TTML1, which changes none of
   * what is read here.
   *
   * Three things about it need care. Times come in more than one shape, and
   * Netflix uses the tick one: "108108000t", against a tick rate declared on
   * the root element. A line's words are spread across nested elements with
   * line breaks between them rather than sitting in one string. And furigana
   * is written as ruby, exactly as it is in the WebVTT, so the reading has to
   * come out or it would be read as more words: in TTML that is an attribute
   * on a span rather than an <rt> tag.
   */
  function parseTtml(text) {
    var doc;
    try {
      doc = new DOMParser().parseFromString(String(text), 'text/xml');
    } catch (err) {
      return [];
    }
    if (!doc || doc.getElementsByTagName('parsererror').length) return [];

    var root = doc.documentElement;
    if (!root) return [];
    var rate = Number(attribute(root, 'tickRate')) || 0;
    var frames = Number(attribute(root, 'frameRate')) || 0;

    var out = [];
    var paragraphs = doc.getElementsByTagNameNS('*', 'p');
    for (var i = 0; i < paragraphs.length; i++) {
      var p = paragraphs[i];
      var start = ttmlTime(attribute(p, 'begin'), rate, frames);
      if (start === null) continue;
      var end = ttmlTime(attribute(p, 'end'), rate, frames);
      if (end === null) {
        var dur = ttmlTime(attribute(p, 'dur'), rate, frames);
        end = dur === null ? start + 4 : start + dur;
      }
      var line = squash(spoken(p));
      if (!line) continue;
      // Netflix overlaps two lines by a frame or two here and there. A line
      // that has not ended when the next one starts would leave A and D one
      // line behind for as long as the overlap lasts.
      if (out.length && out[out.length - 1].end > start) out[out.length - 1].end = start;
      out.push({ start: start, end: end, text: line });
    }
    return out;
  }

  /**
   * An attribute by its local name, whatever namespace it was written in.
   * `ttp:tickRate` on one file is `tickRate` on the next, and the prefix is
   * whatever that document happened to bind.
   */
  function attribute(el, name) {
    if (!el || !el.attributes) return '';
    var direct = el.getAttribute(name);
    if (direct !== null && direct !== undefined && direct !== '') return direct;
    for (var i = 0; i < el.attributes.length; i++) {
      var at = el.attributes[i];
      var local = at.localName || String(at.name).split(':').pop();
      if (local === name) return at.value;
    }
    return '';
  }

  /** The words of one paragraph, with the ruby readings left out. */
  function spoken(node) {
    var said = '';
    for (var child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) { said += child.nodeValue; continue; }
      if (child.nodeType !== 1) continue;
      var name = (child.localName || child.nodeName || '').toLowerCase();
      if (name === 'br') { said += ' '; continue; }
      // A ruby annotation is the reading printed above the word, which is
      // help with the word and not more of the sentence. The word it was
      // helping with is in the base span beside it and stays.
      var ruby = attribute(child, 'ruby');
      if (ruby === 'text' || ruby === 'textContainer') continue;
      said += spoken(child);
    }
    return said;
  }

  /**
   * One TTML time, in seconds, or null if there is nothing there.
   *
   * Either a clock, 00:01:02.500, with a fourth part for frames where a frame
   * rate was declared; or an offset, a number and a unit: 12s, 400ms, 3.5m,
   * 108108000t. Ticks are what Netflix writes, and a tick is only a duration
   * at all because the root element says how many of them make a second.
   */
  function ttmlTime(value, rate, frames) {
    var text = String(value || '').trim();
    if (!text) return null;

    var offset = /^([0-9]+(?:[.][0-9]+)?)(h|m|s|ms|f|t)$/.exec(text);
    if (offset) {
      var amount = parseFloat(offset[1]);
      switch (offset[2]) {
        case 'h': return amount * 3600;
        case 'm': return amount * 60;
        case 's': return amount;
        case 'ms': return amount / 1000;
        case 'f': return frames ? amount / frames : null;
        case 't': return rate ? amount / rate : null;
      }
      return null;
    }

    var parts = text.split(':');
    if (parts.length === 4) {
      // The last part counts frames, not hundredths, and only a declared
      // frame rate says how long one of those is.
      var whole = clock(parts.slice(0, 3).join(':'));
      return whole + (frames ? (parseFloat(parts[3]) || 0) / frames : 0);
    }
    if (parts.length >= 2) return clock(text);
    var plain = parseFloat(text);
    return isNaN(plain) ? null : plain;
  }

  // -------------------------------------------------------------------------
  // Plan 1, on YouTube: ask for the file
  // -------------------------------------------------------------------------

  /**
   * The track list comes first, and not only for the addresses in it.
   *
   * It is the one place on the page that says, as data, which languages this
   * video actually has and what YouTube calls each of them. The transcript
   * panel below has no such field: it answers in whichever language the panel
   * happens to open on, which is the caption track the viewer last switched
   * on. Asked blind, it therefore returned the English transcript of an
   * Italian video for anyone who had not first picked Italian in the player
   * by hand, and Torval, having asked for a transcript and been given one, was
   * perfectly happy with it. That is what made choosing the language by hand
   * feel compulsory. With the track list read first, the panel can be asked
   * for a named language and its answer checked against the name, and every
   * path from here on either gets the language being read or gets nothing.
   */
  async function load(id) {
    state = 'loading';

    var tracks = null;
    try {
      tracks = await captionTracks(id);
    } catch (err) {
      console.warn('Torval: could not read the track list:', err && err.message);
    }
    if (videoId !== id) return;         // navigated away while fetching

    var track = null;
    if (!tracks || !tracks.length) {
      // Likely just early, the player has not finished setting itself up yet.
      // Worth waiting out: this script starts before the player exists.
      if (attempts < MAX_LOOKUP_ATTEMPTS) { state = 'idle'; return; }
      console.warn('Torval: gave up looking for subtitle tracks in this page’s player data. ' +
        'Trying the transcript panel blind, in whatever language it opens on.');
    } else {
      track = pickTrack(tracks);
      if (!track) {
        console.warn('Torval: this video has no ' + TorvalLang.profile().name +
          ' subtitle track. Tracks offered:',
          tracks.map(function (t) { return t.languageCode; }).join(', '));
        return fallBackToWatching();
      }
    }

    var panel = null;
    try {
      panel = await fetchViaTranscriptPanel(id, track, tracks);
    } catch (err) {
      console.warn('Torval: could not read the transcript panel:', err && err.message);
    }
    if (videoId !== id) return;         // navigated away while fetching
    if (panel && panel.length) {
      cues = panel;
      state = 'ready';
      console.log('Torval:', cues.length, 'subtitle lines ready, via the transcript panel');
      return;
    }
    if (!track) return fallBackToWatching();

    try {
      console.log('Torval: fetching the', track.languageCode, 'subtitle track');
      var loaded = await fetchTrack(track);
      if (videoId !== id) return;         // navigated away while fetching
      if (loaded && loaded.length) {
        cues = loaded;
        state = 'ready';
        console.log('Torval:', cues.length, 'subtitle lines ready, direct from YouTube');
        return;
      }
      console.warn('Torval: YouTube would not hand over subtitle data for this video, ' +
        'in any format this tried.');
    } catch (err) {
      console.warn('Torval: could not load subtitles:', err && err.message);
    }
    fallBackToWatching();
  }

  /**
   * The whole transcript, gotten the way YouTube's own "Show transcript"
   * button does: not the closed-caption file, but the panel behind it.
   *
   * Two requests. The first, the same one that loads the page below the
   * player, carries a one-time "params" token buried somewhere in it, under
   * a key called getTranscriptEndpoint; the second spends that token at a
   * dedicated endpoint and gets the actual lines back. Both fields are found
   * by searching the response for their key rather than assuming one exact
   * path to them, because that path is undocumented and has been seen to move
   * before now, a name search survives that better than a fixed route in.
   *
   * This is worth trying ahead of the caption file, not just alongside it:
   * it is what real people actually click, so YouTube has more reason to keep
   * it answering reliably than an old download link almost nobody uses by
   * hand.
   */
  async function fetchViaTranscriptPanel(id, track, tracks) {
    var cfg = ytConfig();
    if (!cfg) return null;
    var context = cfg.context || { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } };

    var page = await ytPost('next', cfg.key, context, { videoId: id });
    if (!page) return null;

    var params = findKey(page, 'getTranscriptEndpoint');
    params = params && params.params;
    if (!params) {
      console.log('Torval: this video offers no transcript panel.');
      return null;
    }

    var data = await ytPost('get_transcript', cfg.key, context, { params: params });
    if (!data) return null;

    // Which language this came back in, and how to ask for another.
    var wanted = wantedLanguage(data, track, tracks);
    if (wanted === REJECT) return null;      // let the caption file settle it
    if (wanted) {
      var again = await ytPost('get_transcript', cfg.key, context, { params: wanted.params });
      if (!again) return null;
      console.log('Torval: asked the transcript panel for', wanted.title, 'instead');
      data = again;
    }

    var segments = findAllKey(data, 'transcriptSegmentRenderer');
    if (!segments.length) {
      console.warn('Torval: the transcript panel answered with no lines in it.');
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

  /*
   * Picking the transcript's language.
   *
   * The panel carries its own language menu, the dropdown at the bottom of
   * it, and every item in that menu is a fresh token for the same endpoint.
   * So the language is not read off the answer, it is asked for again: find
   * the item whose name is the name of the track wanted, spend its token,
   * and what comes back is that language.
   *
   * The names are YouTube's own ("Italian", "Italian (auto-generated)"),
   * localised to the viewer's interface language; the track list and the menu
   * are two views of the same thing in the same response language, so
   * matching one against the other is matching like with like, and nothing
   * here has to know what Italian is called in any particular interface.
   *
   * Three answers:
   *   null    the panel is already showing what was asked for, use it as is
   *   an item ask again with this item's token
   *   REJECT  this cannot be shown to be the right language, so do not use
   *           it at all. The caption file is fetched next and that one names
   *           its language outright, so refusing here costs one request and
   *           never costs correctness.
   */
  var REJECT = { reject: true };

  function wantedLanguage(data, track, tracks) {
    if (!track) return null;              // no track list to check against
    var items = languageMenu(data);
    if (!items.length) {
      // No menu at all means the panel offers exactly one language. When the
      // video only has one track, that is necessarily the one already
      // matched; otherwise there is no telling which it is.
      if (tracks && tracks.length === 1) return null;
      console.warn('Torval: the transcript panel has no language menu on it, ' +
        'so there is no telling which language it answered in.');
      return REJECT;
    }

    var match = matchItem(items, track);
    if (!match) {
      console.warn('Torval: the transcript panel does not offer ' +
        (track.name || track.languageCode) + '. Offered:',
        items.map(function (i) { return i.title; }).join(', '));
      return REJECT;
    }
    if (match.selected) return null;      // already the one showing
    if (!match.params) return REJECT;     // named it, but gave no way to ask for it
    return match;
  }

  /** The menu item for this track, by the name YouTube gives both of them. */
  function matchItem(items, track) {
    var name = squash(track.name || '').toLowerCase();
    if (!name) return null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].title.toLowerCase() === name) return items[i];
    }
    // A near miss, for the one case where the two spellings differ: YouTube
    // sometimes appends the "(auto-generated)" note on one side only.
    for (var j = 0; j < items.length; j++) {
      var title = items[j].title.toLowerCase();
      if (title.indexOf(name) === 0 || name.indexOf(title) === 0) return items[j];
    }
    return null;
  }

  /** The transcript panel's language dropdown, flattened to {title, params, selected}. */
  function languageMenu(data) {
    var menus = findAllKey(data, 'sortFilterSubMenuRenderer');
    var out = [];
    for (var i = 0; i < menus.length; i++) {
      var items = menus[i] && menus[i].subMenuItems;
      if (!items || !items.length) continue;
      for (var j = 0; j < items.length; j++) {
        var title = squash(readText(items[j].title));
        if (!title) continue;
        out.push({ title: title, params: itemParams(items[j]), selected: !!items[j].selected });
      }
      if (out.length) return out;   // the first real menu is the language one
    }
    return out;
  }

  /**
   * The token that asks for this menu item's language. Two shapes have been
   * seen, an endpoint carrying params and a reload continuation; the endpoint
   * takes either in the same field.
   */
  function itemParams(item) {
    var endpoint = item && (item.serviceEndpoint || item.continuation);
    if (!endpoint) return null;
    var transcript = findKey(endpoint, 'getTranscriptEndpoint');
    if (transcript && transcript.params) return String(transcript.params);
    var reload = findKey(endpoint, 'reloadContinuationData');
    if (reload && reload.continuation) return String(reload.continuation);
    var plain = findKey(endpoint, 'continuation');
    return typeof plain === 'string' ? plain : null;
  }

  /** A YouTube text field, which is a plain string, a simpleText, or runs. */
  function readText(value) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    if (value.simpleText) return String(value.simpleText);
    if (value.runs) {
      return value.runs.map(function (r) { return r.text || ''; }).join('');
    }
    return '';
  }

  async function ytPost(endpoint, key, context, body) {
    var res;
    try {
      res = await fetch('https://www.youtube.com/youtubei/v1/' + endpoint +
        '?key=' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ context: context }, body))
      });
    } catch (err) {
      console.warn('Torval:', endpoint, 'request failed:', err && err.message);
      return null;
    }
    if (!res.ok) {
      console.warn('Torval:', endpoint, 'request came back', res.status);
      return null;
    }
    try {
      return await res.json();
    } catch (err) {
      console.warn('Torval:', endpoint, 'response was not valid JSON:', err && err.message);
      return null;
    }
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
    if (snippet.simpleText) return squash(snippet.simpleText);
    if (snippet.runs) {
      return squash(snippet.runs.map(function (r) { return r.text || ''; }).join(''));
    }
    return '';
  }

  /**
   * Try more than one response format for the same track.
   *
   * json3 is the usual choice and what most subtitle tools ask for. YouTube's
   * own default format (plain timedtext XML) is tried next on the chance that
   * only json3 is being withheld, seen happen once, though in the case that
   * prompted this both came back empty.
   */
  async function fetchTrack(track) {
    var formats = [
      { label: 'json3', url: track.baseUrl + '&fmt=json3', parse: function (t) { return parse(JSON.parse(t)); } },
      { label: 'default XML', url: track.baseUrl, parse: parseXml }
    ];
    for (var i = 0; i < formats.length; i++) {
      var a = formats[i];
      console.log('Torval: trying the', a.label, 'format');
      var text = await request(a.url);
      if (!text) continue;
      try {
        var cues = a.parse(text);
        if (cues.length) {
          console.log('Torval: the', a.label, 'format answered:', cues.length, 'lines');
          return cues;
        }
        console.warn('Torval: the', a.label, 'format answered but had no lines in it.');
      } catch (err) {
        console.warn('Torval: could not read the', a.label, 'response:', err && err.message);
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
      var line = squash(node.textContent || '');
      if (!line) continue;
      var end = start + dur;
      if (out.length && out[out.length - 1].end > start) out[out.length - 1].end = start;
      out.push({ start: start, end: end, text: line });
    }
    return out;
  }

  /**
   * Fetch the subtitle file directly. The response-side fix lives in
   * background.js's onHeadersReceived, which grants this the CORS permission
   * YouTube's own response never carries, see the comment there for why
   * that is the correct layer to fix this at, rather than the request side.
   */
  async function request(url) {
    var res;
    try {
      res = await fetch(url);
    } catch (err) {
      console.warn('Torval: subtitle request failed:', err && err.message);
      return '';
    }
    if (!res.ok) {
      console.warn('Torval: subtitle request came back', res.status);
      return '';
    }
    var text = await res.text();
    if (!text) {
      if (res.redirected || res.url !== url) {
        console.warn('Torval: the request was redirected to', res.url,
          ',  something on this machine is very likely intercepting it, not YouTube.');
      } else {
        console.warn('Torval: subtitle request succeeded but the body was empty',
          '(no redirect, this is YouTube itself, not a blocker).');
      }
    }
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

  /**
   * The list of subtitle tracks, tried in order of how likely each is to
   * actually work.
   *
   * The fresh request goes first on purpose. Every reliable transcript tool
   * checked while chasing down why YouTube would answer with a 200 and nothing
   * in it, including the source of a long-established, actively maintained
   * library for exactly this, asks YouTube for the player data again, right
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
      var raw = JSON.parse(match[1]);   // JSON.parse handles the escapes itself
      var fromHtml = raw.map(function (t) {
        return {
          languageCode: String(t.languageCode),
          baseUrl: String(t.baseUrl),
          name: readText(t.name),
          auto: t.kind === 'asr'
        };
      });
      console.log('Torval: found', fromHtml.length, 'subtitle tracks in the page source');
      return fromHtml;
    } catch (err) {
      return null;
    }
  }

  /**
   * Ask YouTube for this video's player data right now, the same call the page
   * itself makes on load, rather than reading a copy that could be minutes
   * old. `ytcfg` is the page's own configuration object, the API key and
   * client context every request on the page already uses, read the same way
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
   * tried, and nothing said so, the code just quietly fell back to the stale
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
      console.warn('Torval: could not read ytcfg:', err && err.message);
    }

    // ytcfg was not reachable as a live object, or did not have a key on it.
    // The same key sits in the page's own source as plain text, the same
    // fallback captionTracks already uses when the live objects come up empty.
    var match = document.documentElement.innerHTML.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    if (match) return { key: match[1], context: null };

    console.warn('Torval: could not find an API key anywhere on this page, cannot make a fresh request.');
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
        out.push({
          languageCode: String(list[i].languageCode),
          baseUrl: String(list[i].baseUrl),
          // What YouTube calls this track in the viewer's own interface
          // language, which is the name the transcript panel's language menu
          // uses too. See wantedLanguage.
          name: readText(list[i].name),
          auto: list[i].kind === 'asr'
        });
      }
      console.log('Torval: found', out.length, 'subtitle tracks via', from);
      return out;
    } catch (err) {
      return null;
    }
  }

  /**
   * The Japanese track to use, preferring one an actual person wrote.
   *
   * A video can carry more than one Japanese track: a manually authored one
   * and an auto-generated (kind "asr") one, and nothing about their order in
   * the list says which is which. Auto captions are also where the
   * word-by-word reveal that isContinuation() exists for comes from, so a
   * human-made track is the better choice whenever there is one to choose.
   */
  function pickTrack(tracks) {
    var wanted = languages();
    var candidates = tracks.filter(function (t) { return wanted.indexOf(t.languageCode) !== -1; });
    if (!candidates.length) return null;
    var manual = candidates.find(function (t) { return !t.auto; });
    return manual || candidates[0];
  }

  /** YouTube's json3: a list of events, each with its start, length and text. */
  function parse(json) {
    var out = [];
    var events = json.events || [];
    // Everything the caption rolling now has said, and where in it the line
    // being built began. A rolling caption is one long stream of words sent
    // over and over, so where the lines fall is for this to decide.
    var rolled = '';
    var lineFrom = 0;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!e.segs) continue;
      var text = squash(e.segs.map(function (s) { return s.utf8 || ''; }).join(''));
      if (!text) continue;
      var start = (e.tStartMs || 0) / 1000;
      var end = start + (e.dDurationMs || 0) / 1000;
      // Automatic captions roll: the line is sent again and again, a word
      // longer each time, so taking every event at face value gives a dozen
      // half-lines each repeating the last. Where an event carries on the
      // line before it, that line grows rather than a new one starting, so
      // nothing is lost and nothing is said twice.
      var previous = out.length ? out[out.length - 1] : null;
      var carriesOn = previous && start <= previous.end + 0.05 &&
        rolled.length > 1 && text.indexOf(rolled) === 0;

      if (carriesOn) {
        var before = rolled;
        rolled = text;
        var line = rolled.slice(lineFrom).trim();
        // Still a line: the one being built grows rather than a new one
        // starting, which is what stops a rolling caption arriving as a
        // dozen half-lines that each repeat the last.
        if (line.length <= ROLL_CHARACTERS && end - previous.start <= ROLL_SECONDS) {
          previous.text = line;
          previous.end = Math.max(previous.end, end);
          continue;
        }
        // As long as a line gets, so the words that arrived with this event
        // begin the next one. Without a limit the roll would grow into a
        // single line covering half the video, and A would take you to the
        // start of that rather than back a line.
        lineFrom = before.length;
        text = rolled.slice(lineFrom).trim();
        if (!text) continue;
      } else {
        rolled = text;
        lineFrom = 0;
      }

      // Consecutive events sometimes overlap; a line should end where the next
      // begins, or the recording of it runs into the following line.
      if (previous && previous.end > start) previous.end = start;
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
  var openCue = null;    // { start, text }, a line currently being timed

  function fallBackToWatching() {
    state = 'watching';
    console.log('Torval: reading captions off the screen instead of asking for the file.');
    startObserving();
  }

  function startObserving() {
    if (observing) return;
    observing = true;
    setInterval(attachObserver, 1000);   // YouTube periodically replaces this element
    setInterval(checkCaption, 250);      // a plain safety net alongside the observer
    attachObserver();
    askForCaptions();
  }

  /*
   * Turning the site's own captions on, when reading them is the only way
   * left.
   *
   * Everywhere else Torval leaves the CC button alone, and the note further
   * down about why still stands: the button is the viewer's, and an
   * extension quietly overruling it makes a page feel haunted. This is the
   * one case where leaving it alone is not neutrality but failure. Reading
   * the screen IS reading the site's captions; with them off there is
   * nothing on the screen to read, and Torval sat there showing nothing while
   * the real instruction, "go and switch the captions on yourself, in the
   * right language", lived only in a console message nobody sees.
   *
   * So: only after every way of fetching the file has failed, only on to
   * never off, and only ever to the language being read. A viewer who had
   * the right captions on already is untouched.
   */
  var captionsAsked = 0;
  var CAPTION_ATTEMPTS = 15;

  function askForCaptions() {
    if (!site || typeof site.captionsOn !== 'function') return;
    if (site.captionsOn(languages())) return;
    if (++captionsAsked >= CAPTION_ATTEMPTS) return;
    // The player builds its caption module a moment after the video starts,
    // so the first ask is usually too early. A handful of retries, then it
    // is left alone: this video plainly has nothing to turn on.
    setTimeout(askForCaptions, 1000);
  }

  /**
   * YouTube's player object takes the same instructions its own settings
   * menu does: `tracklist` is every caption track it knows about and
   * `setOption('captions', 'track', …)` is what the menu itself calls when
   * a language is picked. `wrappedJSObject` is how a Firefox content script
   * reaches it, the same way playerResponse() already does; the track
   * objects handed back are the page's own, so handing one straight back in
   * needs no cloning across the boundary.
   *
   * Answers true once the right captions are showing, false while there is
   * still reason to try again.
   */
  function ytCaptionsOn(wanted) {
    var el = document.getElementById('movie_player');
    var player = el && el.wrappedJSObject;
    if (!player || typeof player.getOption !== 'function') return false;
    try {
      if (typeof player.loadModule === 'function') player.loadModule('captions');
      var list = player.getOption('captions', 'tracklist');
      if (!list || !list.length) return false;

      var pick = null;
      for (var i = 0; i < list.length && !pick; i++) {
        if (wanted.indexOf(String(list[i].languageCode)) !== -1) pick = list[i];
      }
      if (!pick) {
        console.log('Torval: the player offers no ' + TorvalLang.profile().name +
          ' captions to turn on either, so there is nothing on screen to read.');
        return true;   // nothing to wait for; asking again would say the same
      }

      var now = player.getOption('captions', 'track');
      if (now && String(now.languageCode) === String(pick.languageCode)) return true;
      player.setOption('captions', 'track', pick);
      console.log('Torval: turned the player\u2019s own', pick.languageCode,
        'captions on, since reading them off the screen is the only way left ' +
        'to time this video.');
      return true;
    } catch (err) {
      console.warn('Torval: could not turn the player\u2019s captions on:', err && err.message);
      return false;
    }
  }

  function attachObserver() {
    var container = document.querySelector(site.captions);
    if (container === observedContainer) return;
    if (captionObserver) captionObserver.disconnect();
    observedContainer = container;
    if (!container) return;
    captionObserver = new MutationObserver(checkCaption);
    captionObserver.observe(container, { childList: true, subtree: true, characterData: true });
    checkCaption();
  }

  /**
   * The line the player is showing at this moment.
   *
   * Read out of the caption lines themselves rather than out of the box they
   * sit in. The box belongs to the player, and the player keeps its own
   * furniture in there: on YouTube the caption window carries the name of the
   * language and a way into the caption settings, which came through as part
   * of the line and went onto Torval's own subtitle, "ItalianClick for
   * settings Poi dagli studi…". Taking the segments leaves the words.
   *
   * A line that repeats the one before it is dropped as well. A caption
   * changing over is two windows on screen for a moment, and a player that
   * draws its text twice, once offset underneath for the shadow, is two
   * copies of every line; either way the sentence arrived doubled.
   */
  function captionText() {
    var box = document.querySelector(site.captions);
    if (!box) return '';

    var parts = null;
    for (var pick = 0; pick < site.lines.length && !parts; pick++) {
      var found = box.querySelectorAll(site.lines[pick]);
      if (found.length) parts = found;
    }
    // Nothing matched. A box with no elements in it is its own text and can
    // be read as it is; one full of elements Torval does not recognise is
    // furniture it cannot tell from words, and saying nothing is better than
    // reading the furniture out loud.
    if (!parts) return box.firstElementChild ? '' : squash(box.textContent);

    var lines = [];
    for (var i = 0; i < parts.length; i++) {
      var line = squash(wordsIn(parts[i]));
      if (line && line !== lines[lines.length - 1]) lines.push(line);
    }
    return withoutFurniture(lines.join(' '));
  }

  /*
   * The caption window's own words, taken off the front of a line.
   *
   * This is a net, not the fix. The fix is reading segments and nothing
   * else, above. The net is here because that reasoning has now been wrong
   * once: the furniture was supposed to be unreachable after .captions-text
   * was dropped, and it came back through the next container in the list.
   *
   * YouTube puts the name of the track and then "Click for settings" in
   * front of the words, so everything up to and including that phrase is
   * not the subtitle, whatever the track happens to be called. One
   * indexOf, and it holds for a caption window labelled Italian, Japanese
   * or anything else. It is English-only, because that is the English
   * string; another interface language falls back to the structural fix,
   * which is the one supposed to be doing the work.
   */
  var SETTINGS_LABEL = 'Click for settings';

  function withoutFurniture(text) {
    var at = text.indexOf(SETTINGS_LABEL);
    if (at === -1) return text;
    console.log('Torval: left the caption window\u2019s own furniture out of the line.');
    return text.slice(at + SETTINGS_LABEL.length).trim();
  }

  /**
   * The words inside one element, leaving the player's own controls out.
   *
   * A caption segment is words and nothing else, so on the usual path this
   * is textContent and no more. It matters on the fallback path, where what
   * matched is a container rather than a segment and the player keeps its
   * furniture in there beside the words: YouTube's caption window carries
   * the name of the track and a way into the caption settings, and reading
   * the container whole put "ItalianClick for settings" on the front of the
   * line and then recorded it, so that one cue said it for the rest of the
   * video however many times it was seen.
   *
   * Written as "which text nodes count" rather than "strip these strings",
   * so it holds in any interface language and against whatever the player
   * renames its classes to next.
   */
  function wordsIn(el) {
    if (!site.furniture || !el.querySelector(site.furniture)) return el.textContent;
    var out = '';
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var parent = node.parentElement;
      if (parent && parent.closest(site.furniture)) continue;
      out += node.nodeValue;
    }
    return out;
  }

  /**
   * Text changed on screen: close whatever line was open, open whatever is new
   *, unless the new text is plainly the same line still being revealed.
   *
   * Auto-generated captions are very often drawn incrementally, word by word,
   * as speech recognition catches up rather than appearing all at once. Toward
   * the end of a sentence, this looked like several unrelated short "lines" in
   * a row, and only the last fragment reached the one-second floor to be kept
   *, so the recorded cue started wherever that last fragment began, not at
   * the true start of the sentence. Recording 今回の動画では… came out starting
   * at 動画 for exactly this reason.
   */
  function checkCaption() {
    if (!enabled || !video) return;
    // Reading the screen is the fallback for when the transcript could not be
    // fetched. With the transcript in hand it is worse than useless: the same
    // line goes in twice, once as it was written and once as it was seen, a
    // second or two apart and so not recognised as the same. A then stepped
    // back onto a copy of the line already playing, which looked exactly like
    // A going to the start of the current line instead of back one.
    if (state === 'ready') return;
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
   * a second time in `cues`, and A/D would stutter, stepping to what looks
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
  // Drawing them, in Torval's own look
  // -------------------------------------------------------------------------

  // Same palette as the popup: a dark card, one bright text colour, one border
  // colour, the same font stack. Whatever supplied the timing, the fetched
  // file or the screen itself, the line you actually see is always drawn by
  // Torval, so it never gets mistaken for YouTube's own plain caption box.
  var overlay = null;
  var overlayLine = null;

  /*
   * Torval does not hide YouTube's own captions, and never has anything to say
   * about them. It used to hide them, so that the same line was not showing
   * twice, and that was a mistake in kind rather than degree: the CC button
   * is YouTube's, it means what it says, and an extension quietly overruling
   * it is exactly the sort of thing that makes a page feel haunted. The one
   * thing Torval will do to them is turn them on when reading them off the
   * screen is the only way left to time a video, which is not overruling the
   * button so much as the only way to answer at all; see askForCaptions.
   * Torval draws
   * its own line from the Japanese track it fetched itself, and the two have
   * nothing to do with each other. Both on at once is a choice, made with the
   * CC button and Torval's own switch.
   */

  function ensureOverlay() {
    if (overlay) return;

    var player = document.querySelector(site.player) || document.body;
    overlay = document.createElement('div');
    overlay.setAttribute('data-torval-subtitle', '');
    overlay.style.cssText = [
      'position:absolute', 'left:0', 'right:0', 'bottom:4%', 'display:none',
      'z-index:60', 'justify-content:center', 'pointer-events:none', 'padding:0 6%'
    ].join(';');

    overlayLine = document.createElement('span');
    // The text itself must stay hoverable, that is the whole point of timing
    // subtitles at all, even though the box around it should not swallow
    // clicks meant for the player underneath.
    overlayLine.style.cssText = [
      'pointer-events:auto', 'user-select:text', 'cursor:default', 'max-width:88%',
      'border-radius:6px', 'color:#f4f5f7',
      'padding:9px 22px',
      'font:500 34px/1.5 -apple-system,"Segoe UI","Hiragino Kaku Gothic ProN",' +
        '"Noto Sans JP","Yu Gothic",Meiryo,sans-serif',
      'text-align:center', 'white-space:pre-wrap',
      // A hint that the box itself can be moved, without taking the text
      // cursor away from the words inside it.
      'touch-action:none'
    ].join(';');
    // Box, shaded or nothing but an outline on the words, from the
    // appearance settings. Kept out of the cssText above because it is the
    // one part of this that changes while the page is open.
    paintSkin();
    overlay.appendChild(overlayLine);
    player.appendChild(overlay);
    dragging(overlayLine);
    overlay.style.bottom = bottom + '%';
    fitLine();
  }

  /** The background the line sits on, whichever of the three is chosen. */
  function paintSkin() {
    if (!overlayLine) return;
    var skin = typeof TorvalLook !== 'undefined' ? TorvalLook.subtitleSkin() : null;
    if (!skin) return;
    overlayLine.style.background = skin.background;
    overlayLine.style.border = skin.border;
    overlayLine.style.boxShadow = skin.boxShadow;
    overlayLine.style.textShadow = skin.textShadow;
  }

  // How large the line is, as a fraction of the player it sits in, and the
  // sizes it will not go past. A subtitle that stays 34 pixels tall whatever
  // it is sitting in is small in fullscreen and large in a corner window,
  // which is backwards: every player in the world grows its subtitles with
  // itself, because how big the picture is, is how far away you are sitting.
  var LINE_OF_PLAYER = 0.045;
  var LINE_SMALLEST = 20;
  var LINE_LARGEST = 48;

  /*
   * The line is resized, not animated into its new size.
   *
   * It used to ease font-size over .15s, which looked fine on a window
   * resize and terrible going fullscreen. Going fullscreen is not one
   * change of size: the player grows through a dozen intermediate heights
   * while the browser expands it, fitLine is called on each of them from
   * the 200ms pass below, and every call restarts a .15s ease from
   * wherever the last one had got to. What you saw was the line stuttering
   * up to its new size in several visible steps and often overshooting.
   *
   * No player in the world animates its subtitles between sizes. They are
   * simply the right size for the picture, and the picture is what the eye
   * is following. So the transition is gone, and the change is taken on
   * the fullscreen event as well as on the next pass, so it lands with the
   * picture rather than up to a fifth of a second after it.
   */
  function fitLine() {
    if (!overlay || !overlayLine) return;
    var box = overlay.parentElement;
    var height = box ? box.clientHeight : 0;
    if (!height) return;
    // The appearance setting multiplies the share of the player a line
    // takes, and the floor and ceiling move with it: a reader who asked
    // for very large subtitles did not mean "up to 48 pixels".
    var scale = typeof TorvalLook !== 'undefined' ? TorvalLook.subtitleScale() : 1;
    var size = Math.round(Math.max(LINE_SMALLEST * scale,
      Math.min(LINE_LARGEST * scale, height * LINE_OF_PLAYER * scale)));
    if (overlayLine.style.fontSize !== size + 'px') {
      overlayLine.style.fontSize = size + 'px';
    }
  }

  /**
   * Whatever line is playing right now, drawn in Torval's own style.
   *
   * In the on-screen fallback, a line only enters `cues` once it has ended, 
   * its end time is not known until the next one begins. Without checking
   * `openCue` too, the overlay would always be exactly one line behind: it
   * would show nothing for whichever line is currently in progress.
   */
  function renderCue() {
    // First, and outside the guard below: switching Torval off, or losing
    // the transcript, has to hand the video back at its own speed rather
    // than leaving it running at double for the rest of the film.
    pace();
    if (!enabled || suspended || !video || (!cues.length && !openCue)) {
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
    fitLine();
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
   * Is anybody speaking at this moment, allowing for the padding?
   *
   * Pure, and separate from everything that has to know about a video, so
   * that what counts as a quiet stretch can be tested without one.
   * `lead` is how far ahead to look, `pad` how long to keep going at
   * normal speed after a line has ended.
   */
  function talkingAt(list, time, lead, pad) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].end + pad <= time) continue;      // already past
      return list[i].start - lead <= time;          // the next one: near enough?
    }
    return false;
  }

  /**
   * Speed up, or drop back, as the quiet parts come and go.
   *
   * Only with the whole transcript in hand. Read off the screen, a line is
   * not known until it has been shown, so there is no such thing as
   * knowing a quiet stretch is coming, and speeding up would run through
   * speech that had not been seen yet.
   */
  function pace() {
    if (!video) return;
    if (!skipping || !enabled || suspended || state !== 'ready' ||
        !cues.length || video.paused) {
      return slowDown();
    }
    var lead = SKIP_PAD + TICK_SECONDS * skipSpeed;
    if (talkingAt(cues, video.currentTime, lead, SKIP_PAD)) slowDown();
    else speedUp();
  }

  function speedUp() {
    if (fast) return;
    normalRate = video.playbackRate;
    fast = true;
    video.playbackRate = skipSpeed;
  }

  function slowDown() {
    if (!fast) return;
    fast = false;
    if (video) video.playbackRate = normalRate;
  }

  /*
   * A line of text over the video for a second and a half.
   *
   * Skipping is toggled by a key and its effect is not always immediately
   * visible: press it during a line of dialogue and nothing happens until
   * the dialogue stops. A key that silently may or may not have worked is
   * worse than no key, so it says which it did.
   */
  var toast = null;
  var toastTimer = null;

  function say(words) {
    var player = document.querySelector(site.player);
    if (!player) return;
    if (!toast) {
      toast = document.createElement('div');
      toast.setAttribute('data-torval-say', '');
      toast.style.cssText = [
        'position:absolute', 'top:12%', 'left:0', 'right:0', 'z-index:61',
        'display:flex', 'justify-content:center', 'pointer-events:none'
      ].join(';');
      var pill = document.createElement('span');
      pill.style.cssText = [
        'background:#16171a', 'border:1px solid #292b30', 'border-radius:6px',
        'box-shadow:0 8px 28px rgba(0,0,0,.5)', 'color:#f4f5f7',
        'padding:7px 16px',
        'font:500 15px/1.4 -apple-system,"Segoe UI",sans-serif'
      ].join(';');
      toast.appendChild(pill);
      player.appendChild(toast);
    }
    toast.firstChild.textContent = words;
    toast.style.display = 'flex';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (toast) toast.style.display = 'none';
    }, 1500);
  }

  /** The key, and the toolbar, turning the mode on and off. */
  function setSkipping(on) {
    skipping = !!on;
    if (!skipping) slowDown();
    else if (video) normalRate = video.playbackRate;
    say(skipping
      ? 'Skipping the quiet parts at ' + skipSpeed + '×'
      : 'Playing everything again');
    paintSkip();
    return skipping;
  }

  /**
   * Tell the bar what the switch is doing. Called whenever it changes, so
   * pressing the key lights the button up at once rather than at whatever
   * moment something else happens to look.
   */
  function paintSkip() {
    if (typeof TorvalBar === 'undefined' || !TorvalBar.skipButton) return;
    TorvalBar.skipButton(canSkip(), skipping, skipSpeed);
  }

  /**
   * Is there anything to skip: a video, and the whole of its transcript?
   *
   * The transcript is the part people notice. Torval gets one for most
   * videos, but when YouTube has no track in the language being read, or
   * hands back nothing for the one it has, it falls back to reading the
   * captions off the screen, and then a line is not known until it has
   * been shown. Skipping ahead through what has not been read yet would
   * race through speech, so the switch is not offered at all.
   *
   * That is the answer to "why is the button missing on this one", and it
   * is said once per video in the console, since a control that is simply
   * absent explains nothing by itself.
   */
  var saidWhyNot = '';

  function canSkip() {
    var able = !!(enabled && !suspended && video && state === 'ready' && cues.length);
    if (!able && videoId && state === 'watching' && saidWhyNot !== videoId) {
      saidWhyNot = videoId;
      console.log('Torval: no skipping on this video. Its subtitles are being read ' +
        'off the screen, so what has not been played yet is not known.');
    }
    return able;
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
      if (text && (text.indexOf(wanted) !== -1 || wanted.indexOf(text) !== -1)) {
        return wholeLine(i);
      }
    }
    if (!video) return null;
    var here = cueAt(video.currentTime);
    return here ? wholeLine(cues.indexOf(here)) : null;
  }

  /**
   * The whole of the line that this cue is part of, in time.
   *
   * An automatic caption revises itself as the recogniser hears more, and
   * every revision is filed as a cue of its own. What you read as one line
   * is several cues in a row, each a rewrite of the one before, and any
   * single one of them can be under a second long. Mining picked one of
   * those and recorded it, which is where "it only records the first half
   * second" came from: the clip was the whole of a cue, and the cue was a
   * fraction of the sentence.
   *
   * A line runs from the first of those cues to the last. On a clean
   * subtitle track, where each line is filed once, this changes nothing.
   */
  function wholeLine(i) {
    if (i < 0 || i >= cues.length) return null;
    var first = i;
    var last = i;
    while (first > 0 && stillSaying(cues[first - 1], cues[first])) first--;
    while (last + 1 < cues.length && stillSaying(cues[last], cues[last + 1])) last++;
    return { start: cues[first].start, end: cues[last].end, text: cues[last].text };
  }

  /**
   * Is the second cue the first one being said again, further along?
   *
   * Not the same question as isContinuation just above, which asks whether
   * one caption plausibly follows another and is deliberately generous. This
   * one decides how much video to record, so being generous costs you a clip
   * with the next sentence on the end of it. Two lines that merely begin the
   * same way, そうですね、私は… and そうですね、でも…, are two lines.
   *
   * A revision is the same words with more added, give or take the last sound
   * or two, which is the part the recogniser goes back and changes.
   */
  function stillSaying(a, b) {
    if (!a || !b) return false;
    if (b.start - a.end > 0.4) return false;    // a gap: a different line
    var was = strip(a.text);
    var now = strip(b.text);
    if (!was || !now || now.length < was.length) return false;
    var shared = commonPrefixLength(was, now);
    return shared >= 2 && shared >= was.length - 2;
  }

  // A space between two Japanese characters is not a word boundary; Japanese
  // does not put spaces between words. It is where the caption renderer wrapped
  // the line, and it arrives in the text as an ordinary space. Left in, it cuts
  // the sentence in two for reading: 繋がるわけじゃ ないのかも came out as じゃ
  // and ない, two words that are one, and 皆 さん as two more.
  var WRAPPED = new RegExp('(' + TorvalJapanese.source + ')\\s+(?=' + TorvalJapanese.source + ')', 'g');

  // Characters that take up no room and mean nothing, which subtitle tracks
  // are full of: zero-width spaces and joiners, the word joiner, the byte
  // order mark, the soft hyphen. YouTube sends runs of them around a line and
  // between its halves, and they survive every ordinary tidying-up because
  // JavaScript's \s does not count them as whitespace: a line arrives as
  // "nessuno<ZWSP> <ZWSP><ZWSP> <ZWSP>aveva", which reads on screen as the
  // double and triple spaces it looks like. Worse than the look, one landing
  // inside a word would split it in two for the dictionary, since it is not a
  // letter in any language's alphabet either. So they go first, before
  // anything else is decided about the line.
  var INVISIBLE = /[\u00AD\u200B-\u200F\u2028\u2029\u2060\uFEFF]/g;

  /** One line of caption text, as a line rather than as it was laid out. */
  function squash(text) {
    return String(text || '')
      .replace(INVISIBLE, '')
      .replace(/\s+/g, ' ')
      .replace(WRAPPED, '$1')
      .trim();
  }

  function strip(s) {
    return String(s).replace(/<[^>]*>/g, '').replace(INVISIBLE, '').replace(/\s+/g, '');
  }

  /**
   * Every line of the video as one passage, for working out how much of it you
   * would understand. This is what the whole fight to get the transcript up
   * front was for: with the on-screen fallback, only the lines already watched
   * are in here, and the answer can only ever describe what has been seen so
   * far rather than what is coming.
   */
  /**
   * The whole video as one continuous text, the way a book is one text.
   *
   * No breaks between the lines at all. Where a line ends is where the
   * caption renderer ran out of room or the speaker drew breath, and neither
   * has anything to do with where a word ends. Sentences still break the
   * reading, because 。 and 、 are not Japanese characters and stop a run on
   * their own; a caption with no punctuation in it, which is most automatic
   * ones, is simply read straight through.
   */
  /** Whether this language puts a space between one word and the next. */
  function spaced() {
    var profile = typeof TorvalLang !== 'undefined' ? TorvalLang.profile() : null;
    return !!profile && !profile.seams;
  }

  function allText() {
    // Joined the way the language joins words. Run together, "il tempo" at
    // the end of one line and "Poi" at the start of the next became
    // "tempoPoi", a word nothing in the dictionary matches, and every line
    // break in a transcript cost the score a word. Japanese writes without
    // spaces and a space between the lines would be the invention, so it is
    // the one language that still joins them straight on.
    return cues.map(function (cue) { return cue.text; })
      .join(spaced() ? ' ' : '');
  }

  /** Does this line carry straight on from the one before it? */
  function continues(previous, next) {
    if (!previous || !next) return false;
    if (next.start - previous.end > 0.4) return false;
    return !/[。．.!?！？」』、]\s*$/.test(previous.text);
  }

  /**
   * The lines either side of the one showing, so it can be read without its
   * ends being cut off mid-word.
   */
  function around(text) {
    var wanted = strip(text || '');
    if (!wanted) return { before: '', after: '' };

    // The line on screen is very often not in `cues` at all. Reading captions
    // off the screen, which is what happens whenever the transcript cannot be
    // fetched, only files a line once it has ended: the one being read now is
    // the open one, and the line after it has not been said yet. Looking only
    // through the finished lines found nothing and gave the line no context,
    // which is exactly the case this was written for.
    if (openCue && sameLine(openCue.text, wanted)) {
      var last = cues.length ? cues[cues.length - 1] : null;
      return { before: last ? last.text : '', after: '' };
    }

    for (var i = 0; i < cues.length; i++) {
      if (!sameLine(cues[i].text, wanted)) continue;
      return {
        before: i > 0 ? cues[i - 1].text : '',
        after: i + 1 < cues.length ? cues[i + 1].text : ''
      };
    }
    return { before: '', after: '' };
  }

  /** Is this cue the line that is being asked about? */
  function sameLine(text, wanted) {
    var here = strip(text);
    return !!here && (here.indexOf(wanted) !== -1 || wanted.indexOf(here) !== -1);
  }

  /** Enough to tell whether the transcript has changed since last asked. */
  function count() {
    return cues.length;
  }

  /**
   * Is a transcript still on its way?
   *
   * Asked by the bar, which has a number to show and needs to know whether
   * it is the final one. The video id is read fresh rather than trusting
   * `videoId`: on a site that never reloads, the address changes a second
   * or so before watch() next runs, and in that gap `state` is still
   * 'ready' about the video that was playing a moment ago. A different id
   * means nothing is known about what is playing now, whatever the last
   * one's state was.
   */
  function waiting() {
    if (!enabled || !site) return false;
    var id;
    try { id = site.id(); } catch (err) { return false; }
    if (!id) return false;                                // not a watch page
    if (id !== videoId) return true;                      // a video not looked at yet
    // 'ready' is the whole transcript, in hand. 'unavailable' is a definite
    // no, and a bar that went on saying "reading the subtitles" after it
    // would be waiting for something that is never coming. Everything else
    // is still on its way, right down to reading them off the screen, where
    // the lines do arrive, just one at a time.
    if (state === 'ready' || state === 'unavailable') return false;
    return !cues.length;
  }

  return {
    allText: allText,
    count: count,
    waiting: waiting,
    enable: enable,
    restart: restart,
    cueAt: cueAt,
    cueFor: cueFor,
    around: around,
    suspend: suspend,
    parse: parse,
    parseXml: parseXml,
    findKey: findKey,
    findAllKey: findAllKey,
    segmentText: segmentText,
    step: step,
    pickTrack: pickTrack,
    wantedLanguage: wantedLanguage,
    languageMenu: languageMenu,
    wantedTimedtext: wantedTimedtext,
    REJECT: REJECT,
    insertObserved: insertObserved,
    talkingAt: talkingAt,
    skipping: function () { return skipping; },
    canSkip: canSkip,
    paintSkip: paintSkip,
    setSkipping: setSkipping,
    isContinuation: isContinuation,
    wholeLine: wholeLine,
    siteFor: siteFor,
    parseVtt: parseVtt,
    parseTtml: parseTtml,
    status: function () { return state; },
    _setCues: function (list) { cues = list; state = 'ready'; },
    // The line in progress, which is where a line lives while it is on
    // screen when captions are being read off the screen.
    _setOpen: function (cue) { openCue = cue; }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalSubtitles;
