/*
 * LLL — the part that runs on the page
 *
 * Three jobs:
 *   1. Work out which text the mouse is actually pointing at.
 *   2. Ask the background script what it means.
 *   3. Draw the result.
 *
 * Job 1 is the reason this is a browser extension at all. The browser will tell
 * us exactly which character sits under a pixel (caretPositionFromPoint), which
 * is a problem no other kind of program gets solved for free.
 *
 * The popup lives in a "shadow root" — a small sealed-off document of its own.
 * Nothing the page does to its own styling can leak in and nothing we do leaks
 * out, so the popup looks identical on every site.
 */

'use strict';

(function () {
  const api = globalThis.browser || globalThis.chrome;
  if (!api || !api.runtime || !api.runtime.id) return;
  if (window.__lllLoaded) return;
  window.__lllLoaded = true;

  // Hiragana, katakana, kanji, the repeat mark 々 and halfwidth katakana.
  const JAPANESE = /[々〆぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾝ]/;
  const MAX_SCAN = 16;
  const SKIP_TAGS = new Set(['RT', 'RP', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'SELECT', 'TEXTAREA', 'OPTION']);
  const INLINE_DISPLAY = new Set(['inline', 'inline-block', 'inline-flex', 'contents', 'ruby', 'ruby-base', 'ruby-text']);

  // Part-of-speech codes are terse in JMdict; these are the ones worth spelling
  // out. Anything else falls back to the dictionary's own description.
  const POS_LABELS = {
    n: 'noun', pn: 'pronoun', adv: 'adverb', 'adj-i': 'i-adjective', 'adj-na': 'na-adjective',
    'adj-no': 'の-adjective', 'adj-pn': 'pre-noun adjectival', exp: 'expression', int: 'interjection',
    conj: 'conjunction', prt: 'particle', pref: 'prefix', suf: 'suffix', ctr: 'counter',
    v1: 'ichidan verb', 'v1-s': 'ichidan verb', vk: 'irregular verb', 'vs-i': 'irregular verb',
    'vs-s': 'irregular verb', vs: 'noun + する', vt: 'transitive', vi: 'intransitive'
  };

  let shiftDown = false;
  let pointer = { x: 0, y: 0 };
  let lastQuery = null;
  let queryToken = 0;
  let scanScheduled = false;
  let tags = {};
  let ui = null;

  api.runtime.sendMessage({ type: 'tags' }).then((t) => { if (t) tags = t; }).catch(() => {});

  // Fetched now rather than linked from the shadow root, because a <link> loads
  // asynchronously: the first popup would be measured and positioned while it
  // was still unstyled and full-page-width, and land in the wrong place.
  const stylesheet = fetch(api.runtime.getURL('popup.css')).then((r) => r.text()).catch(() => '');

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui && ui.host.style.display === 'block') {
      hide();
      return;
    }
    if (e.key !== 'Shift' || shiftDown) return;
    shiftDown = true;

    // A selection plus Shift looks up the selection; otherwise use the cursor.
    const selected = selectionText();
    if (selected) lookup(selected, selectionAnchor());
    else scheduleScan();
  }, true);

  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftDown = false; }, true);
  window.addEventListener('blur', () => { shiftDown = false; });

  window.addEventListener('mousemove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (shiftDown) scheduleScan();
  }, true);

  // A short delay rather than requestAnimationFrame: it settles rapid mouse
  // movement into one lookup, and unlike rAF it still runs in tabs the browser
  // has decided not to paint.
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => { scanScheduled = false; scan(); }, 30);
  }

  function scan() {
    const text = textAtPoint(pointer.x, pointer.y);
    // Nothing under the cursor is not a reason to close: the popup stays until
    // Escape, so you can read it without having to keep the mouse still.
    if (!text || text === lastQuery) return;
    lookup(text, pointer);
  }

  // -------------------------------------------------------------------------
  // Finding the text under the cursor
  // -------------------------------------------------------------------------

  function textAtPoint(x, y) {
    const caret = caretAt(x, y);
    if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return null;
    if (SKIP_TAGS.has((caret.node.parentElement || {}).tagName)) return null;
    const offset = resolveCharacter(caret.node, caret.offset, x, y);
    if (offset === -1) return null;
    return leadingJapanese(forwardText(caret.node, offset, MAX_SCAN));
  }

  /**
   * Turn a caret position into the character actually being pointed at.
   *
   * The browser gives us a caret position — a gap between two characters —
   * rather than a character, and it picks whichever gap is nearest. Point at
   * the right-hand half of 日 and you get the gap before 本, which would look up
   * the wrong word. So take the offset only if the pointer really sits inside
   * that character's box, and otherwise step back one.
   *
   * This doubles as the check that we are over text at all: the browser answers
   * caretPositionFromPoint even when the pixel is in a margin or past the end
   * of a line, and neither should open a popup.
   */
  function resolveCharacter(node, offset, x, y) {
    if (overCharacter(node, offset, x, y)) return offset;
    if (offset > 0 && overCharacter(node, offset - 1, x, y)) return offset - 1;
    return -1;
  }

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
    }
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      return range ? { node: range.startContainer, offset: range.startOffset } : null;
    }
    return null;
  }

  function overCharacter(node, offset, x, y) {
    if (offset >= node.data.length) return false;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    for (const r of range.getClientRects()) {
      if (x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1) return true;
    }
    return false;
  }

  /**
   * Read forward from a point in the text, following on into the next elements
   * if needed. Sites break sentences across <span>s constantly — YouTube's
   * captions are one span per line, ruby furigana is several per word — so
   * stopping at the end of one text node would cut most words in half.
   *
   * We stop at the first block-level boundary, otherwise the next paragraph
   * would get glued onto the end of this one.
   */
  function forwardText(node, offset, limit) {
    let text = node.data.slice(offset);
    if (text.length >= limit) return text.slice(0, limit);

    const block = blockAncestor(node);
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const parent = n.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    walker.currentNode = node;

    let next;
    while (text.length < limit && (next = walker.nextNode())) {
      if (blockAncestor(next) !== block) break;
      text += next.data;
    }
    return text.slice(0, limit);
  }

  function blockAncestor(node) {
    let el = node.parentElement;
    while (el && el.parentElement && INLINE_DISPLAY.has(getComputedStyle(el).display)) el = el.parentElement;
    return el || document.body || document.documentElement;
  }

  /** Keep the run of Japanese from the start; stop at the first thing that isn't. */
  function leadingJapanese(text) {
    if (!text || !JAPANESE.test(text[0])) return null;
    let i = 1;
    while (i < text.length && JAPANESE.test(text[i])) i++;
    return text.slice(0, i);
  }

  function selectionText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    return leadingJapanese(sel.toString().trim().slice(0, MAX_SCAN));
  }

  function selectionAnchor() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return pointer;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    return r.width || r.height ? { x: r.left, y: r.bottom } : pointer;
  }

  // -------------------------------------------------------------------------
  // Asking the background script
  // -------------------------------------------------------------------------

  async function lookup(text, at) {
    lastQuery = text;
    const token = ++queryToken;
    let reply;
    try {
      reply = await api.runtime.sendMessage({ type: 'lookup', text });
    } catch (err) {
      return;   // background restarting; the next hover will retry
    }
    if (token !== queryToken || !reply) return;

    if (reply.status.state === 'loading') {
      showMessage(`Building dictionary… ${Math.round(reply.status.progress * 100)}%`, at);
    } else if (reply.status.state === 'error') {
      showMessage('Dictionary failed to load — see the extension console.', at);
    } else if (reply.groups && reply.groups.length) {
      showResults(reply.groups, at);
    } else {
      lastQuery = null;   // allow a retry on the same text once data is ready
    }
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  async function build() {
    if (ui) return ui;
    const css = await stylesheet;
    if (ui) return ui;

    const host = document.createElement('div');
    host.style.display = 'none';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = css;

    const card = document.createElement('div');
    card.className = 'card';
    // Clicks inside must not reach the page — some sites treat any click as
    // "close the lightbox" and would yank the text out from under the popup.
    card.addEventListener('mousedown', (e) => e.stopPropagation());

    root.append(style, card);
    (document.body || document.documentElement).appendChild(host);
    ui = { host, card };
    return ui;
  }

  function hide() {
    if (ui) ui.host.style.display = 'none';
    lastQuery = null;
  }

  async function showMessage(text, at) {
    const { card } = await build();
    card.textContent = '';
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = text;
    card.appendChild(note);
    place(at);
  }

  async function showResults(groups, at) {
    const { card } = await build();
    card.textContent = '';

    card.appendChild(renderGroup(groups[0], true));

    if (groups.length > 1) {
      const rest = document.createElement('div');
      rest.className = 'shorter';
      rest.hidden = true;
      for (let i = 1; i < groups.length; i++) rest.appendChild(renderGroup(groups[i], false));

      const toggle = document.createElement('button');
      toggle.className = 'toggle';
      toggle.textContent = `${groups.length - 1} shorter ${groups.length === 2 ? 'match' : 'matches'}`;
      toggle.addEventListener('click', () => {
        rest.hidden = !rest.hidden;
        toggle.classList.toggle('open', !rest.hidden);
      });
      card.append(toggle, rest);
    }
    place(at);
  }

  function renderGroup(group, isTop) {
    const el = document.createElement('div');
    el.className = 'group';
    if (!isTop) {
      const label = document.createElement('div');
      label.className = 'surface';
      label.textContent = group.surface;
      el.appendChild(label);
    }
    for (const hit of group.hits) el.appendChild(renderEntry(hit));
    return el;
  }

  function renderEntry(hit) {
    const entry = hit.entry;
    const el = document.createElement('div');
    el.className = 'entry';

    const head = document.createElement('div');
    head.className = 'head';
    const word = document.createElement('span');
    word.className = 'word';
    word.textContent = entry.k[0] || entry.r[0];
    head.appendChild(word);
    if (entry.k.length && entry.r.length) {
      const reading = document.createElement('span');
      reading.className = 'reading';
      reading.textContent = entry.r[0];
      head.appendChild(reading);
    }
    el.appendChild(head);

    if (hit.reasons.length) {
      const why = document.createElement('div');
      why.className = 'reasons';
      why.textContent = hit.reasons.join(' → ');
      el.appendChild(why);
    }

    const list = document.createElement('ol');
    list.className = 'senses';
    let previousPos = null;
    entry.s.forEach((sense, i) => {
      const li = document.createElement('li');
      if (i >= 2) li.hidden = true;

      // Most entries carry the same grammar tags on every sense. Printing
      // "noun · noun + する · transitive" against all four definitions of 読む
      // buries the English, so only show them when they actually change.
      const pos = sense.p.join(',');
      const showPos = pos !== previousPos;
      previousPos = pos;

      for (const code of showPos ? sense.p : []) {
        const tag = document.createElement('span');
        tag.className = 'pos';
        tag.textContent = posLabel(code);
        tag.title = tags[code] || code;
        li.appendChild(tag);
      }
      for (const code of sense.m || []) {
        const tag = document.createElement('span');
        tag.className = 'misc';
        tag.textContent = code;
        tag.title = tags[code] || code;
        li.appendChild(tag);
      }
      li.appendChild(document.createTextNode(sense.g.join('; ')));
      list.appendChild(li);
    });
    el.appendChild(list);

    if (entry.s.length > 2) {
      const more = document.createElement('button');
      more.className = 'toggle';
      more.textContent = `${entry.s.length - 2} more`;
      more.addEventListener('click', () => {
        const hiddenNow = list.children[2].hidden;
        for (let i = 2; i < list.children.length; i++) list.children[i].hidden = !hiddenNow;
        more.textContent = hiddenNow ? 'fewer' : `${entry.s.length - 2} more`;
        more.classList.toggle('open', hiddenNow);
      });
      el.appendChild(more);
    }
    return el;
  }

  function posLabel(code) {
    if (POS_LABELS[code]) return POS_LABELS[code];
    if (code.startsWith('v5')) return 'godan verb';
    const described = tags[code];
    return described ? described.split('(')[0].trim() : code;
  }

  /** Put the popup near the cursor, nudged back on screen if it would overflow. */
  function place(at) {
    const { host, card } = ui;
    host.style.display = 'block';
    host.style.left = '0px';
    host.style.top = '0px';
    const box = card.getBoundingClientRect();
    const margin = 8;
    let left = at.x + 18;
    let top = at.y + 18;
    if (left + box.width > window.innerWidth - margin) left = Math.max(margin, at.x - box.width - 18);
    if (top + box.height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - box.height - margin);
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  }
})();
