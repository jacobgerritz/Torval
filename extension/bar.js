/*
 * Torval, the comprehension bar
 *
 * One number, across the top of the page: how much of what is in front of you
 * is made of words you already know. On a video that is the whole transcript,
 * not the part already watched, which is the point of it. Knowing that a
 * video is 92% words you know before starting it is what decides whether it is
 * worth watching at all, and no amount of reading it afterwards answers that.
 *
 * It lives in a shadow root, the same as the popup does, so nothing the page
 * styles can reach it and nothing here leaks out onto the page. It draws over
 * the top of the page rather than pushing it down: shifting a page's layout
 * from outside breaks fixed headers on a great many sites, and a bar you can
 * dismiss is a smaller intrusion than a page that no longer lines up.
 *
 * By default it stays out of the way: tucked above the top edge of the page,
 * with only a small handle showing, and slides down when that handle is
 * clicked. Pin it and it stays down instead, the way it always used to.
 */

var TorvalBar = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;

  var host = null;
  var root = null;
  var els = {};
  var data = null;        // the last reading: { total, known, counts, model }
  // Whether Torval has ever had anything to say in this tab. Not reset by
  // forget(): the question is not "does this page have a score" but "is
  // this somebody who is using Torval here", and the answer to that does
  // not stop being yes when they open the next video. See quiet().
  var everShown = false;
  var read = null;        // that reading's occurrences, for recounting
  var onRefresh = null;

  var BAR_HEIGHT = 54;   // the bar itself, and the room the page gives it
  var expanded = false;
  var pinned = false;
  var always = false;   // this page keeps the bar down, whatever the setting
  var retractTimer = null;

  var HANDLE_TITLE = 'How much of this page you understand';

  // Told to the bar by whoever knows: see skipButton.
  var onSkip = null;
  var skipSaid = '';

  // What Torval is in the middle of, and the timer waiting to say so.
  var pending = null;
  var pendingTimer = null;

  // Read once, up front, so the very first paint already knows whether to
  // start down, by the time a reading is ready to show (at the earliest,
  // 1.5 seconds after the page itself loads), this has almost always already
  // resolved.
  api.storage.local.get('barPinned').then(function (stored) {
    if (always) return;
    pinned = !!stored.barPinned;
    if (host && pinned && !expanded) setExpanded(true);
  }).catch(function () {});

  /**
   * Keep the bar down on this page whatever the setting says, and take away
   * the pin, since there is nothing to unpin it from. The reader asks for
   * this: a page that exists only to be read in has room for a bar, and
   * hiding the one number the reader is there for would be strange.
   */
  function alwaysDown() {
    always = true;
    pinned = true;
    // A page that keeps the bar down has to start below it, and the reader
    // is such a page. It used to hold the number in its own stylesheet,
    // which was right until the bar grew and then silently was not: the
    // bar says how tall it is instead, and reader.css reads that.
    var root = document.documentElement;
    if (root && root.style) root.style.setProperty('--torval-bar', BAR_HEIGHT + 'px');
    // Built at once rather than waiting for something to measure. The reader
    // asks for this, and its shelf has no Japanese on it at all: without the
    // bar there from the start, the room the page leaves for it would just be
    // an empty strip along the top.
    build();
    setExpanded(true);
    els.pin.hidden = true;
  }

  /**
   * Show a fresh reading. `counts` is how many times each word was said, kept
   * so that marking one more word known can move the number immediately.
   */
  function show(reading) {
    data = reading;
    if (!data || !data.total) return;
    // The occurrences behind the number, so that ticking one more word can be
    // answered exactly rather than estimated. Kept apart from `data`, which
    // is the reading as it arrived.
    read = (data.model && typeof TorvalLookupCommon !== 'undefined')
      ? TorvalLookupCommon.expand(data.model) : null;
    everShown = true;
    build();
    idle();
    render();
  }


  /**
   * Throw away the reading: this is a different page now.
   *
   * A site that never reloads keeps the bar it already had, and the number
   * on it belonged to the last video. Opening a new one then showed that
   * old number, confidently, for as long as the new transcript took to
   * arrive, and `quiet` would put it straight back afterwards if the new
   * page turned out to have nothing to say. Both are worse than saying
   * nothing: a wrong percentage looks exactly like a right one.
   *
   * So the numbers go, and the bar says what it is doing instead until
   * there is a real one to show.
   */
  function forget(what) {
    data = null;
    read = null;
    // Only ever about a bar that is already up. With nothing on the page
    // there is nothing stale to take down, and saying "reading this page"
    // would put a handle in the corner of every page navigated to, which is
    // the one thing busy() waits 400ms specifically to avoid doing.
    if (!host) return;
    els.score.textContent = '';
    els.detail.textContent = '';
    busy(what || 'Reading this page…');
  }

  /**
   * Say what Torval is busy doing, before there is any number to show.
   *
   * Building the dictionary takes a minute the first time and reading a page
   * takes a moment every time, and until now both happened in complete
   * silence, nothing on the page said anything at all, so the only thing to
   * conclude was that nothing worked. The handle carries it, since that is
   * what is visible while the bar is tucked away: "Torval 42%" while the
   * dictionary is still being built, "Torval ·" while a page is being read.
   */
  function busy(what, progress) {
    pending = { what: what, progress: progress };
    if (host) return paintBusy();

    // Nothing has been put on the page yet, so wait a moment before doing so.
    // Most pages answer faster than this, and a page with no Japanese on it
    // should never get a handle in the corner that appears and then vanishes
    // again, it should never get one at all.
    if (!pendingTimer) {
      pendingTimer = setTimeout(function () {
        pendingTimer = null;
        if (!pending) return;
        build();
        paintBusy();
      }, 400);
    }
  }

  function paintBusy() {
    els.handle.textContent = typeof pending.progress === 'number'
      ? 'Torval ' + Math.round(pending.progress * 100) + '%'
      : 'Torval ·';
    els.handle.classList.add('busy');
    els.handle.title = pending.what;
    els.note.textContent = pending.what;
    els.note.hidden = false;
    els.score.hidden = true;
    els.detail.hidden = true;
  }

  function stopWaiting() {
    pending = null;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  }

  /** Done being busy: back to whatever number there is, if there is one. */
  function idle() {
    stopWaiting();
    if (!host) return;
    els.handle.textContent = 'Torval';
    els.handle.classList.remove('busy');
    els.handle.title = HANDLE_TITLE;
    els.note.hidden = true;
    els.score.hidden = false;
    els.detail.hidden = false;
  }

  /**
   * There turned out to be nothing to say about this page.
   *
   * If a number has been shown before, go back to it. Otherwise the bar has
   * nothing to show, and what it used to do about that was set the host to
   * display:none, which was wrong in three separate ways at once and all
   * three were visible at the same time.
   *
   * It took the handle with it, so there was no longer anything to click to
   * get the bar back. It did it to a pinned bar as readily as to an
   * unpinned one, which is the opposite of what pinning is for. And it
   * never gave back the 54 pixels the page was leaving for it, so the page
   * stayed pushed down with an empty strip along the top and nothing in it.
   *
   * So now the bar tucks itself away, which is a state it already has: the
   * handle stays, the room goes back, and pinning means what it says.
   *
   * Tucking away rather than disappearing is right wherever Torval is
   * being used, and wrong everywhere else. readPage() says "Reading this
   * page…" on every page it touches, which builds the bar, so on an
   * English news site the bar would appear, find nothing, and leave a
   * handle sitting in the corner for ever. That is precisely what busy()
   * waits 400ms to avoid. So the handle is kept only once there has been
   * something to keep it for: on a tab where Torval has shown a number at
   * least once, it has earned its corner, and on a tab where it never has,
   * it takes itself off the page exactly as before.
   */
  function quiet(why) {
    stopWaiting();
    if (!host) return;
    if (data && data.total) { idle(); return; }
    idle();
    els.score.textContent = '';
    // A reason is worth staying on the page for. "Nothing to read here" is
    // not, and is the ordinary case on the ordinary web page; but "this
    // video has no Spanish subtitles" is the answer to the question
    // somebody is in the middle of asking, and vanishing rather than
    // saying it is how Torval came to look broken on Netflix.
    if (why) {
      els.detail.textContent = why;
      setExpanded(pinned || always);
      return;
    }
    // A bar that was asked to stay, stays, and says why it is empty rather
    // than leaving somebody to wonder. `always` is the reader, whose shelf
    // has no Japanese on it; `pinned` is a deliberate answer to this exact
    // question.
    if (always || pinned) {
      els.detail.textContent = 'nothing to read here yet';
      return;
    }
    els.detail.textContent = '';
    setExpanded(false);
    // Never asked for here, so not wanted here. The room goes back either
    // way, which is the part that was actually broken.
    if (!everShown) host.style.display = 'none';
  }

  /**
   * One word just moved between known, ignored and neither. Its count is
   * exactly how much the numbers move, so the bar answers at once instead of
   * reading the whole page again for a change of one word.
   *
   * Both ends of the move are needed rather than just the new state: going
   * straight from known to ignored takes the word out of two counts at once,
   * and only knowing where it came from says so.
   */
  function restate(word, before, after) {
    if (!data || before === after) return;

    if (read) {
      // Move the word between the two sets and count the page again. Cheap:
      // a few thousand occurrences of a few hundred words, and it is the one
      // answer that stays right however many words are marked in a row.
      read.known[after === 'known' ? 'add' : 'delete'](word);
      read.ignored[after === 'ignored' ? 'add' : 'delete'](word);
      var score = TorvalLookupCommon.coverage(read.tokens, read.known, read.ignored);
      data.total = score.total;
      data.known = score.known;
      if (host) render();
      return;
    }

    // No occurrences to count, an old reading, or a page read by something
    // that does not send them. Shift the number by how many times the word
    // was said, which is right as far as it goes.
    var count = (data.counts && data.counts[word]) || 0;
    if (!count) return;

    // An ignored word is not part of the question at all, so it leaves the
    // total; anything else is, so it rejoins it.
    if (after === 'ignored') data.total -= count;
    if (before === 'ignored') data.total += count;
    if (after === 'known') data.known += count;
    if (before === 'known') data.known -= count;

    data.total = Math.max(0, data.total);
    data.known = Math.max(0, Math.min(data.total, data.known));
    if (host) render();
  }

  function render() {
    var percent = data.total ? Math.round((data.known / data.total) * 100) : 0;
    els.score.textContent = percent + '%';
    els.detail.textContent = data.known.toLocaleString('en-US') + ' of ' +
      data.total.toLocaleString('en-US') + ' words known';
    // A colour is read at a glance where a number has to be thought about.
    els.score.style.color = colourFor(percent);
    // Back on the page if quiet() had taken it off, which it does on a tab
    // that had never shown anything until this moment.
    host.style.display = document.fullscreenElement ? 'none' : 'block';
  }

  /**
   * What a comprehension percentage looks like: red where a text is out of
   * reach, amber where it is a stretch, green where it can be read without
   * stopping every sentence.
   *
   * Sliding rather than stepping, because the difference between 91% and 98%
   * is the difference between hard work and comfortable, and fixed bands
   * paint both of those the same.
   *
   * The scale is deliberately hard to please. Reading without stopping every
   * sentence takes somewhere around 98% of the running words, and even 90%
   * is one word in ten looked up, which is study rather than reading. So
   * green begins where it is genuinely comfortable and everything below 70%
   * is red, rather than a cheerful yellow-green at 75% telling you a text is
   * within reach when it is not.
   */
  function colourFor(percent) {
    var hue = Math.max(0, Math.min(120, (percent - 70) * 4));
    return 'hsl(' + Math.round(hue) + ' 48% 62%)';
  }

  function build() {
    if (host) return;

    host = document.createElement('div');
    host.setAttribute('data-torval-bar', '');
    root = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = CSS;

    els.handle = document.createElement('button');
    els.handle.className = 'handle';
    els.handle.textContent = 'Torval';
    els.handle.title = HANDLE_TITLE;
    els.handle.addEventListener('click', function () { setExpanded(!expanded); });

    els.bar = document.createElement('div');
    els.bar.className = 'bar';
    // Unpinned, the bar is a hover panel: it stays down while the mouse is
    // anywhere on it, and only starts counting down to retract once the
    // mouse actually leaves, so reading the detail text or reaching for a
    // button never gets cut short partway through.
    els.bar.addEventListener('mouseenter', cancelRetract);
    els.bar.addEventListener('mouseleave', scheduleRetract);

    var mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = 'Torval';

    els.score = document.createElement('span');
    els.score.className = 'score';

    els.detail = document.createElement('span');
    els.detail.className = 'detail';

    // Stands in for the score while there is not one yet.
    els.note = document.createElement('span');
    els.note.className = 'note';
    els.note.hidden = true;

    var spacer = document.createElement('span');
    spacer.className = 'spacer';

    var refresh = button('⟳', 'Read this page again', function () {
      if (onRefresh) onRefresh();
    });
    // Only on a video, and only once the whole transcript is in hand, since
    // that is the only case where the quiet parts are known in advance. On
    // every other page it is not a button that does nothing, it is not
    // there at all.
    els.skip = button('»', '', function () { if (onSkip) onSkip(); });
    els.skip.classList.add('skip');
    els.skip.hidden = true;

    var settings = button('⚙', 'Torval settings', function () {
      api.runtime.sendMessage({ type: 'openOptions' }).catch(function () {});
    });
    // Not an emoji: an emoji renders in its own colours whatever the CSS
    // says, so the pin had no way to look switched on. A plain character
    // takes the colour it is given.
    els.pin = button('◉', '', function () { setPinned(!pinned); });
    els.pin.classList.add('pin');

    els.bar.append(mark, els.score, els.note, els.detail, spacer,
      els.skip, refresh, settings, els.pin);
    root.append(style, els.handle, els.bar);
    (document.body || document.documentElement).appendChild(host);

    paintPin();
    setExpanded(pinned);
    if (always) els.pin.hidden = true;

    // A video played full screen should be a video, not a video with a bar
    // across it. The page's own reading is unaffected, it comes straight back
    // on the way out.
    document.addEventListener('fullscreenchange', function () {
      var full = !!document.fullscreenElement;
      host.style.display = full ? 'none' : (data && data.total ? 'block' : host.style.display);
      // And the room the page was leaving for it goes back: full screen means
      // the video fills the screen, and a page still pushed down by forty
      // pixels is a video pushed down by forty pixels.
      makeRoom(!full && expanded && pinned);
    });
  }

  /**
   * Push the page down by the height of the bar, so the bar covers nothing.
   *
   * Only for a bar that is staying: one that slides away when the pointer
   * leaves would drag the whole page up and down with it, which is worse
   * than covering a strip of it. A margin on the root element rather than on
   * the body, since plenty of pages give the body a margin of their own and
   * this way nothing of theirs is overwritten.
   */
  function makeRoom(yes) {
    var root = document.documentElement;
    if (!root || !root.style) return;
    pushApp(false);
    if (yes) {
      var works = rootMarginMoves();
      // Slide rather than jump, in step with the bar coming down.
      root.style.setProperty('transition', 'margin-top .22s ease');
      root.style.setProperty('margin-top', BAR_HEIGHT + 'px', 'important');
      if (!works) pushApp(true);
    } else {
      root.style.removeProperty('margin-top');
    }
    moveHeaders(yes);
  }

  /**
   * Does a margin on the root element move this page at all?
   *
   * On an ordinary page it does, and that is the polite way to ask for room.
   * An application that lays itself out in a container pinned over the
   * viewport can ignore it completely, and then the bar goes on covering the
   * top of the page exactly as before. So it is tried rather than assumed:
   * set it, measure, put it back, all without giving the browser a chance to
   * paint anything in between.
   */
  function rootMarginMoves() {
    var app = biggestThing();
    if (!app) return true;
    var root = document.documentElement;
    var hadTransition = root.style.transition;
    var hadMargin = root.style.marginTop;
    root.style.setProperty('transition', 'none');
    var before = app.getBoundingClientRect().top;
    root.style.setProperty('margin-top', BAR_HEIGHT + 'px', 'important');
    var after = app.getBoundingClientRect().top;
    root.style.marginTop = hadMargin;
    root.style.transition = hadTransition;
    return after - before >= BAR_HEIGHT - 2;
  }

  var pushed = null;   // the app container moved, and what it looked like

  /**
   * The biggest thing on the page, which on an application like YouTube is
   * the whole application. Only ever asked about as a last resort.
   */
  function biggestThing() {
    var best = null;
    var area = 0;
    var kids = document.body ? document.body.children : [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el === host || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' ||
          el.tagName === 'LINK') continue;
      var box = el.getBoundingClientRect();
      var size = box.width * box.height;
      if (size > area) { area = size; best = el; }
    }
    return best;
  }

  function pushApp(yes) {
    if (pushed) {
      pushed.el.style.paddingTop = pushed.was;
      pushed.el.style.transition = pushed.wasTransition;
      pushed = null;
    }
    if (!yes) return;
    var app = biggestThing();
    if (!app) return;
    // Added to whatever padding the page already had, not put in place of
    // it: a site with room of its own at the top would otherwise lose it and
    // end up higher than it started.
    var already = parseFloat(getComputedStyle(app).paddingTop) || 0;
    pushed = { el: app, was: app.style.paddingTop, wasTransition: app.style.transition };
    app.style.setProperty('transition', 'padding-top .22s ease');
    app.style.setProperty('padding-top', (already + BAR_HEIGHT) + 'px', 'important');
  }


  // Whatever was moved out of the way, and what it looked like before.
  var moved = [];

  /**
   * A margin on the root element moves everything in the flow of the page and
   * nothing that was taken out of it, which on a site with a header pinned to
   * the top means the header stays exactly where the bar now is. YouTube is
   * the obvious one, and it is the one this was reported on.
   *
   * This used to move only things shaped like a header: at the very top,
   * most of the way across, no taller than a header gets. That moved
   * YouTube's masthead and stopped there, which turned out to be half a
   * fix. YouTube's sidebar, the one with Subscriptions on it, is fixed too
   * and sits at the top of whatever the masthead is not covering, so it is
   * already a little below the bar before anything moves. The old "already
   * below the bar, so it needs no help" test therefore left it exactly
   * where it was, and the masthead came down 54 pixels and parked on top
   * of it.
   *
   * So the question is not "is this a header" but "is this anchored near
   * the top of the window", which a sidebar hanging from under a header
   * is. Anything full-screen is left alone, because that is a modal or a
   * backdrop rather than furniture, and so is anything inside something
   * already moved, which would otherwise come down twice.
   */
  function moveHeaders(yes) {
    for (var i = 0; i < moved.length; i++) {
      moved[i].el.style.translate = moved[i].was;
      moved[i].el.style.transition = moved[i].wasTransition;
    }
    moved = [];
    if (!yes) return;

    // How far down still counts as anchored to the top. A header is at 0; a
    // sidebar under one starts at the header's own height, and there is no
    // way to ask which header it belongs to, so the answer is "about one
    // header further down than the bar is tall".
    var NEAR_TOP = BAR_HEIGHT * 2;

    var all = document.body ? document.body.querySelectorAll('*') : [];
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      if (el === host) continue;
      var style = getComputedStyle(el);
      if (style.position !== 'fixed') continue;
      var box = el.getBoundingClientRect();
      if (box.height === 0 || box.width === 0) continue;
      if (box.top > NEAR_TOP) continue;
      // A modal, a backdrop or a full-screen overlay, which is not page
      // furniture and has no business being pushed anywhere.
      if (box.width >= window.innerWidth * 0.95 &&
          box.height >= window.innerHeight * 0.95) continue;
      if (inside(el, moved)) continue;

      // `translate` rather than `transform`: plenty of these are animated by
      // the page itself, and appending to its transform meant putting a
      // stale copy of that transform back afterwards. This is a separate
      // property that composes with whatever the page is doing and can be
      // handed back without touching it.
      moved.push({ el: el, was: el.style.translate, wasTransition: el.style.transition });
      el.style.transition = 'translate .22s ease';
      el.style.translate = '0 ' + BAR_HEIGHT + 'px';
    }
  }

  /** Is this inside something that has already been moved down? */
  function inside(el, list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].el !== el && list[i].el.contains(el)) return true;
    }
    return false;
  }

  function setExpanded(value) {
    expanded = value;
    if (els.bar) els.bar.classList.toggle('expanded', expanded);
    makeRoom(expanded && pinned);
    cancelRetract();
  }

  function scheduleRetract() {
    if (pinned) return;
    cancelRetract();
    // A short grace period, not an instant retract, moving the mouse across
    // the bar on the way to a button is not the same thing as leaving it.
    retractTimer = setTimeout(function () { setExpanded(false); }, 500);
  }

  function cancelRetract() {
    if (retractTimer) { clearTimeout(retractTimer); retractTimer = null; }
  }

  function setPinned(value) {
    if (always) return;
    pinned = value;
    try { api.storage.local.set({ barPinned: pinned }); } catch (err) { /* not fatal */ }
    paintPin();
    if (pinned) setExpanded(true);
    else scheduleRetract();
  }

  /**
   * The one control here that is not about this page but about the video on
   * it: play the stretches with nobody speaking faster.
   *
   * It lives on the bar rather than only in the settings because it is a
   * thing you decide while watching, four seconds into a shot of a
   * landscape, and a setting you have to leave the video to reach is a
   * setting nobody uses twice. What speed is set is still a setting, in
   * the ordinary place; this is only the switch.
   */
  function skipButton(visible, on, speed) {
    if (!host || !els.skip) return;
    els.skip.hidden = !visible;
    if (!visible) return;
    els.skip.classList.toggle('on', !!on);
    var said = on
      ? 'Playing the quiet parts at ' + speed + '×, click to stop'
      : 'Play the quiet parts faster';
    if (said !== skipSaid) { els.skip.title = said; skipSaid = said; }
  }

  function paintPin() {
    els.pin.classList.toggle('on', pinned);
    els.pin.title = pinned
      ? 'Pinned open, click to let it tuck away again'
      : 'Pin open, instead of tucking away when the mouse leaves';
  }

  function button(text, title, onClick) {
    var el = document.createElement('button');
    // Marked as one of the icons, because the handle is a button too and
    // the square icon box is emphatically not what it wants.
    el.className = 'icon';
    el.textContent = text;
    el.title = title;
    el.addEventListener('click', onClick);
    return el;
  }

  // Same palette as the popup and the subtitles: one dark card colour, one
  // border, one bright text colour, everything else muted.
  //
  // Sized to be read at a glance rather than squinted at. This is the third
  // time it has grown and the reason is the same each time: the bar was
  // first built to take up as little room as possible, which is the wrong
  // thing to optimise for something whose entire job is to be read in
  // passing, from across a desk, while you are looking at something else.
  // The percentage is the one number anybody comes here for, so it is the
  // size of a heading rather than of body text, and the three controls are
  // finger-sized rather than pointer-sized.
  var CSS = [
    ':host { all: initial; }',
    // Sized by its own text and never by anything else. This is a button,
    // and when the icon rule below was written as `button` rather than as
    // a class it caught this one too and squeezed "Torval" into a 38 pixel
    // square. Its width is whatever the word needs; nothing wraps it, and
    // nothing clips it.
    '.handle {',
    '  position: fixed; top: 0; right: 14px; z-index: 2147483645;',
    '  box-sizing: content-box; width: auto; height: auto;',
    '  padding: 5px 14px; margin: 0; border: 1px solid #292b30; border-top: 0; border-radius: 0 0 8px 8px;',
    '  background: #16171a; font: 13px/1 -apple-system, "Segoe UI", sans-serif;',
    '  letter-spacing: 0.06em; color: #6b7079; cursor: pointer;',
    '  white-space: nowrap; overflow: visible; text-overflow: clip;',
    '}',
    '.handle:hover { color: #dfe1e5; }',
    // While something is being worked out, the handle is the only part
    // showing, so it is the part that has to say so.
    '.handle.busy { color: #c7ab72; border-color: #4a4034; }',
    '.note { color: #c7ab72; }',
    '.bar {',
    '  position: fixed; top: 0; left: 0; right: 0; z-index: 2147483646;',
    '  box-sizing: border-box; height: ' + BAR_HEIGHT + 'px; display: flex; align-items: center; gap: 18px;',
    '  padding: 0 18px;',
    '  background: #16171a; border-bottom: 1px solid #292b30;',
    '  font: 16px/1 -apple-system, "Segoe UI", sans-serif; color: #dfe1e5;',
    // Tucked above the top edge by default, the handle above is what stays
    // visible in that state, since it sits at the same coordinates but one
    // step behind the bar in the stacking order.
    '  transform: translateY(-100%); transition: transform .22s ease;',
    '}',
    '.bar.expanded { transform: translateY(0); }',
    // Three pieces of text and a row of buttons in a fixed strip, which is
    // a layout with one failure mode: a narrow window, a large system font
    // or a page zoomed in, and the text pushes the buttons off the end.
    // So the text may shrink and be cut with an ellipsis, the buttons may
    // not shrink at all, and below a certain width the two pieces that are
    // decoration rather than information go away entirely. The percentage
    // is what the bar is for and is the last thing to go.
    '.mark { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;',
    '  white-space: nowrap; font-size: 14px; letter-spacing: 0.08em; color: #5a5f67; }',
    '.score { flex: 0 0 auto; font-size: 24px; font-weight: 600; color: #f4f5f7;',
    '  font-variant-numeric: tabular-nums; }',
    '.detail, .note {',
    '  flex: 0 1 auto; min-width: 0; overflow: hidden;',
    '  text-overflow: ellipsis; white-space: nowrap;',
    '}',
    '.detail { color: #767b84; }',
    '.spacer { flex: 1 1 auto; min-width: 0; }',
    '@media (max-width: 560px) {',
    '  .mark, .detail { display: none; }',
    '  .bar { gap: 8px; padding: 0 8px; }',
    '}',
    // A button is a square box with its glyph centred in it, rather than a
    // line of text with padding round it. ⟳, ⚙, ◉ and » come from whatever
    // font the browser has them in, and those fonts disagree about where in
    // the line box the ink sits; with line-height:1 and symmetric padding
    // that disagreement showed up as every icon riding low. Centring the
    // line box itself, in a box of a known size, is the thing that actually
    // holds still.
    '.icon {',
    '  flex: 0 0 auto;',
    '  display: inline-flex; align-items: center; justify-content: center;',
    '  box-sizing: border-box; width: 38px; height: 38px; padding: 0;',
    '  background: none; border: 0; border-radius: 6px;',
    '  font: inherit; font-size: 22px; line-height: 1; color: #6b7079; cursor: pointer;',
    '}',
    '.icon:hover { background: #24262b; color: #dfe1e5; }',
    '.pin { font-size: 16px; }',
    // Unmistakably switched on, not just a shade different: a pin you
    // cannot tell the state of is a pin you press twice.
    '.pin.on { color: #16171a; background: #dba35f; }',
    '.pin.on:hover { color: #16171a; background: #e6b578; }',
    // The same "switched on" treatment as the pin, for the same reason: a
    // control you cannot tell the state of is a control you press twice.
    '.skip { font-weight: 700; letter-spacing: -0.04em; }',
    '.skip.on { color: #16171a; background: #dba35f; }',
    '.skip.on:hover { color: #16171a; background: #e6b578; }'
  ].join('\n');

  return {
    show: show,
    busy: busy,
    forget: forget,
    quiet: quiet,
    restate: restate,
    onRefresh: function (fn) { onRefresh = fn; },
    onSkip: function (fn) { onSkip = fn; },
    skipButton: skipButton,
    // Off and on again, for the switch on the toolbar button. Switching it
    // off gives the page its room back too: a page pushed down by a bar
    // that is no longer there is the same complaint as in quiet() above.
    visible: function (show) {
      if (!host) return;
      host.style.display = show ? 'block' : 'none';
      makeRoom(!!show && expanded && pinned);
    },
    alwaysDown: alwaysDown,
    colourFor: colourFor
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalBar;
