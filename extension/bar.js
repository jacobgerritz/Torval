/*
 * LLL — the comprehension bar
 *
 * One number, across the top of the page: how much of what is in front of you
 * is made of words you already know. On a video that is the whole transcript,
 * not the part already watched — which is the point of it. Knowing that a
 * video is 92% words you know before starting it is what decides whether it is
 * worth watching at all, and no amount of reading it afterwards answers that.
 *
 * It lives in a shadow root, the same as the popup does, so nothing the page
 * styles can reach it and nothing here leaks out onto the page. It draws over
 * the top of the page rather than pushing it down: shifting a page's layout
 * from outside breaks fixed headers on a great many sites, and a bar you can
 * dismiss is a smaller intrusion than a page that no longer lines up.
 */

var LLLBar = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;

  var host = null;
  var root = null;
  var els = {};
  var data = null;        // the last reading: { total, known, counts }
  var dismissed = false;
  var onRefresh = null;

  /**
   * Show a fresh reading. `counts` is how many times each word was said, kept
   * so that marking one more word known can move the number immediately.
   */
  function show(reading) {
    data = reading;
    if (dismissed || !reading || !reading.total) return;
    build();
    render();
  }

  /** A reading is being taken — say so rather than sitting on a stale number. */
  function working() {
    if (dismissed || !data) return;
    build();
    els.score.textContent = '…';
  }

  /**
   * One word was just marked known, or unmarked, from the popup. Its count is
   * exactly how much the total moves, so the bar answers at once instead of
   * reading the whole page again for a change of one word.
   */
  function adjust(word, isKnown) {
    if (!data || !data.counts) return;
    var count = data.counts[word] || 0;
    if (!count) return;
    data.known = Math.max(0, Math.min(data.total, data.known + (isKnown ? count : -count)));
    if (host) render();
  }

  function render() {
    var percent = data.total ? Math.round((data.known / data.total) * 100) : 0;
    els.score.textContent = percent + '%';
    els.detail.textContent = data.known.toLocaleString('en-US') + ' of ' +
      data.total.toLocaleString('en-US') + ' words known';
    // Green when a text is comfortable, amber when it is a stretch, plain when
    // it is out of reach — a colour read at a glance where a number needs
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

    var bar = document.createElement('div');
    bar.className = 'bar';

    var mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = 'LLL';

    els.score = document.createElement('span');
    els.score.className = 'score';

    els.detail = document.createElement('span');
    els.detail.className = 'detail';

    var spacer = document.createElement('span');
    spacer.className = 'spacer';

    var refresh = button('⟳', 'Read this page again', function () {
      if (onRefresh) onRefresh();
    });
    var settings = button('⚙', 'LLL settings', function () {
      api.runtime.sendMessage({ type: 'openOptions' }).catch(function () {});
    });
    var close = button('×', 'Hide until this page is reloaded', function () {
      dismissed = true;
      host.style.display = 'none';
    });

    bar.append(mark, els.score, els.detail, spacer, refresh, settings, close);
    root.append(style, bar);
    (document.body || document.documentElement).appendChild(host);

    // A video played full screen should be a video, not a video with a bar
    // across it. The page's own reading is unaffected — it comes straight back
    // on the way out.
    document.addEventListener('fullscreenchange', function () {
      if (!dismissed && data) host.style.display = document.fullscreenElement ? 'none' : 'block';
    });
  }

  function button(text, title, onClick) {
    var el = document.createElement('button');
    el.textContent = text;
    el.title = title;
    el.addEventListener('click', onClick);
    return el;
  }

  // Same palette as the popup and the subtitles: one dark card colour, one
  // border, one bright text colour, everything else muted.
  var CSS = [
    ':host { all: initial; }',
    '.bar {',
    '  position: fixed; top: 0; left: 0; right: 0; z-index: 2147483646;',
    '  box-sizing: border-box; height: 28px; display: flex; align-items: center; gap: 10px;',
    '  padding: 0 10px;',
    '  background: #16171a; border-bottom: 1px solid #292b30;',
    '  font: 12px/1 -apple-system, "Segoe UI", sans-serif; color: #dfe1e5;',
    '}',
    '.mark { font-size: 10px; letter-spacing: 0.08em; color: #5a5f67; }',
    '.score { font-size: 13px; font-weight: 600; color: #f4f5f7; }',
    '.score.easy { color: #7fb488; }',
    '.score.ok { color: #c7ab72; }',
    '.score.hard { color: #b8868a; }',
    '.detail { color: #767b84; }',
    '.spacer { flex: 1; }',
    'button {',
    '  padding: 2px 5px; background: none; border: 0; border-radius: 3px;',
    '  font: inherit; font-size: 13px; line-height: 1; color: #6b7079; cursor: pointer;',
    '}',
    'button:hover { background: #24262b; color: #dfe1e5; }'
  ].join('\n');

  return {
    show: show,
    working: working,
    adjust: adjust,
    onRefresh: function (fn) { onRefresh = fn; }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LLLBar;
