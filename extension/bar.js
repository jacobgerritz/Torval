/*
 * LLL, the comprehension bar
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

var LLLBar = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;

  var host = null;
  var root = null;
  var els = {};
  var data = null;        // the last reading: { total, known, counts }
  var onRefresh = null;

  var expanded = false;
  var pinned = false;
  var retractTimer = null;

  var HANDLE_TITLE = 'How much of this page you understand';

  // What LLL is in the middle of, and the timer waiting to say so.
  var pending = null;
  var pendingTimer = null;

  // Read once, up front, so the very first paint already knows whether to
  // start down, by the time a reading is ready to show (at the earliest,
  // 1.5 seconds after the page itself loads), this has almost always already
  // resolved.
  api.storage.local.get('barPinned').then(function (stored) {
    pinned = !!stored.barPinned;
    if (host && pinned && !expanded) setExpanded(true);
  }).catch(function () {});

  /**
   * Show a fresh reading. `counts` is how many times each word was said, kept
   * so that marking one more word known can move the number immediately.
   */
  function show(reading) {
    data = reading;
    if (!reading || !reading.total) return;
    build();
    idle();
    render();
  }


  /**
   * Say what LLL is busy doing, before there is any number to show.
   *
   * Building the dictionary takes a minute the first time and reading a page
   * takes a moment every time, and until now both happened in complete
   * silence, nothing on the page said anything at all, so the only thing to
   * conclude was that nothing worked. The handle carries it, since that is
   * what is visible while the bar is tucked away: "LLL 42%" while the
   * dictionary is still being built, "LLL ·" while a page is being read.
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
      ? 'LLL ' + Math.round(pending.progress * 100) + '%'
      : 'LLL ·';
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
    els.handle.textContent = 'LLL';
    els.handle.classList.remove('busy');
    els.handle.title = HANDLE_TITLE;
    els.note.hidden = true;
    els.score.hidden = false;
    els.detail.hidden = false;
  }

  /**
   * There turned out to be nothing to say about this page. If a number has
   * been shown before, go back to it; if not, LLL has no business being on
   * this page at all, so it takes itself off it.
   */
  function quiet() {
    stopWaiting();
    if (!host) return;
    if (data && data.total) { idle(); return; }
    host.style.display = 'none';
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
    if (!data || !data.counts || before === after) return;
    var count = data.counts[word] || 0;
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
    // Green when a text is comfortable, amber when it is a stretch, plain when
    // it is out of reach, a colour read at a glance where a number needs
    // thinking about. The line at 90% is the usual one for reading without
    // stopping every sentence.
    els.score.className = 'score ' + (percent >= 90 ? 'easy' : percent >= 70 ? 'ok' : 'hard');
    host.style.display = document.fullscreenElement ? 'none' : 'block';
  }

  function build() {
    if (host) return;

    host = document.createElement('div');
    host.setAttribute('data-lll-bar', '');
    root = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = CSS;

    els.handle = document.createElement('button');
    els.handle.className = 'handle';
    els.handle.textContent = 'LLL';
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
    mark.textContent = 'LLL';

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
    var settings = button('⚙', 'LLL settings', function () {
      api.runtime.sendMessage({ type: 'openOptions' }).catch(function () {});
    });
    // Not an emoji: an emoji renders in its own colours whatever the CSS
    // says, so the pin had no way to look switched on. A plain character
    // takes the colour it is given.
    els.pin = button('◉', '', function () { setPinned(!pinned); });
    els.pin.className = 'pin';

    els.bar.append(mark, els.score, els.note, els.detail, spacer, refresh, settings, els.pin);
    root.append(style, els.handle, els.bar);
    (document.body || document.documentElement).appendChild(host);

    paintPin();
    setExpanded(pinned);

    // A video played full screen should be a video, not a video with a bar
    // across it. The page's own reading is unaffected, it comes straight back
    // on the way out.
    document.addEventListener('fullscreenchange', function () {
      if (data) host.style.display = document.fullscreenElement ? 'none' : 'block';
    });
  }

  function setExpanded(value) {
    expanded = value;
    if (els.bar) els.bar.classList.toggle('expanded', expanded);
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
    pinned = value;
    try { api.storage.local.set({ barPinned: pinned }); } catch (err) { /* not fatal */ }
    paintPin();
    if (pinned) setExpanded(true);
    else scheduleRetract();
  }

  function paintPin() {
    els.pin.classList.toggle('on', pinned);
    els.pin.title = pinned
      ? 'Pinned open, click to let it tuck away again'
      : 'Pin open, instead of tucking away when the mouse leaves';
  }

  function button(text, title, onClick) {
    var el = document.createElement('button');
    el.textContent = text;
    el.title = title;
    el.addEventListener('click', onClick);
    return el;
  }

  // Same palette as the popup and the subtitles: one dark card colour, one
  // border, one bright text colour, everything else muted. Sized to be read
  // at a glance rather than squinted at, the first version of this bar was
  // built to take up as little room as possible, which mostly meant it was
  // too small to actually see.
  var CSS = [
    ':host { all: initial; }',
    '.handle {',
    '  position: fixed; top: 0; right: 14px; z-index: 2147483645;',
    '  padding: 3px 10px; margin: 0; border: 1px solid #292b30; border-top: 0; border-radius: 0 0 7px 7px;',
    '  background: #16171a; font: 11px/1 -apple-system, "Segoe UI", sans-serif;',
    '  letter-spacing: 0.06em; color: #6b7079; cursor: pointer;',
    '}',
    '.handle:hover { color: #dfe1e5; }',
    // While something is being worked out, the handle is the only part
    // showing, so it is the part that has to say so.
    '.handle.busy { color: #c7ab72; border-color: #4a4034; }',
    '.note { color: #c7ab72; }',
    '.bar {',
    '  position: fixed; top: 0; left: 0; right: 0; z-index: 2147483646;',
    '  box-sizing: border-box; height: 40px; display: flex; align-items: center; gap: 14px;',
    '  padding: 0 14px;',
    '  background: #16171a; border-bottom: 1px solid #292b30;',
    '  font: 14px/1 -apple-system, "Segoe UI", sans-serif; color: #dfe1e5;',
    // Tucked above the top edge by default, the handle above is what stays
    // visible in that state, since it sits at the same coordinates but one
    // step behind the bar in the stacking order.
    '  transform: translateY(-100%); transition: transform .22s ease;',
    '}',
    '.bar.expanded { transform: translateY(0); }',
    '.mark { font-size: 12px; letter-spacing: 0.08em; color: #5a5f67; }',
    '.score { font-size: 17px; font-weight: 600; color: #f4f5f7; }',
    '.score.easy { color: #7fb488; }',
    '.score.ok { color: #c7ab72; }',
    '.score.hard { color: #b8868a; }',
    '.detail { color: #767b84; }',
    '.spacer { flex: 1; }',
    'button {',
    '  padding: 4px 8px; background: none; border: 0; border-radius: 4px;',
    '  font: inherit; font-size: 16px; line-height: 1; color: #6b7079; cursor: pointer;',
    '}',
    'button:hover { background: #24262b; color: #dfe1e5; }',
    '.pin { font-size: 12px; }',
    // Unmistakably switched on, not just a shade different: a pin you
    // cannot tell the state of is a pin you press twice.
    '.pin.on { color: #16171a; background: #dba35f; }',
    '.pin.on:hover { color: #16171a; background: #e6b578; }'
  ].join('\n');

  return {
    show: show,
    busy: busy,
    quiet: quiet,
    restate: restate,
    onRefresh: function (fn) { onRefresh = fn; }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LLLBar;
