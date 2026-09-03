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

  // Reloading the extension while pages are open leaves the previous copy of
  // this script running in them. Both copies then answer the same Shift-hover,
  // each with a popup of its own, which is why windows piled up. A flag on
  // `window` cannot settle it: Firefox gives every injected copy its own view
  // of the page's globals, so neither copy can see the other's.
  //
  // The page's own DOM is the one thing they genuinely share, so ownership is
  // claimed there. Whoever loaded last wins; the older copies notice they no
  // longer hold the claim, clear up after themselves and fall silent.
  const OWNER = 'data-lll-owner';
  const instance = String(Date.now()) + Math.random();
  for (const orphan of document.querySelectorAll('[data-lll-popup]')) orphan.remove();
  document.documentElement.setAttribute(OWNER, instance);

  function isCurrent() {
    if (document.documentElement.getAttribute(OWNER) === instance) return true;
    if (ui) { ui.host.remove(); ui = null; }
    return false;
  }

  // Hiragana, katakana, kanji, the repeat mark 々 and halfwidth katakana.
  const JAPANESE = /[々〆぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾝ]/;
  const MAX_SCAN = 16;
  const SENTENCE_END = /[。．.！!？?…\n\r\t]/;
  const SKIP_TAGS = new Set(['RT', 'RP', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'SELECT', 'TEXTAREA', 'OPTION']);
  const INLINE_DISPLAY = new Set(['inline', 'inline-block', 'inline-flex', 'contents', 'ruby', 'ruby-base', 'ruby-text']);

  // JMdict's tags in plain words. The codes are compact but opaque, and there is
  // room here to say what they mean. Anything not listed falls back to the
  // dictionary's own description of it.
  const LABELS = {
    // parts of speech
    n: 'noun', pn: 'pronoun', adv: 'adverb', 'adj-i': 'i-adjective', 'adj-na': 'na-adjective',
    'adj-no': 'の-adjective', 'adj-pn': 'pre-noun adjectival', exp: 'expression',
    int: 'interjection', conj: 'conjunction', prt: 'particle', pref: 'prefix', suf: 'suffix',
    ctr: 'counter', num: 'numeric', aux: 'auxiliary', 'aux-v': 'auxiliary verb',
    'aux-adj': 'auxiliary adjective', cop: 'copula', 'n-suf': 'noun suffix',
    'n-pref': 'noun prefix', 'adv-to': 'adverb taking と',
    v1: 'ichidan verb', 'v1-s': 'ichidan verb', vk: 'irregular verb', 'vs-i': 'irregular verb',
    'vs-s': 'irregular verb', vs: 'noun + する', vz: 'ずる verb', vt: 'transitive',
    vi: 'intransitive', 'vr': 'irregular り verb',
    // usage
    uk: 'usually kana', abbr: 'abbreviation', col: 'colloquial', sl: 'slang',
    arch: 'archaic', obs: 'obsolete', rare: 'rare', dated: 'dated', hist: 'historical',
    hon: 'honorific', hum: 'humble', pol: 'polite', fam: 'familiar', vulg: 'vulgar',
    derog: 'derogatory', joc: 'humorous', poet: 'poetic', chn: "children's language",
    fem: 'female term', male: 'male term', 'on-mim': 'onomatopoeic', id: 'idiom',
    proverb: 'proverb', quote: 'quotation', yoji: 'four-character idiom', form: 'literary'
  };

  let shiftDown = false;
  let pointer = { x: 0, y: 0 };
  let lastQuery = null;
  let queryToken = 0;
  let scanScheduled = false;
  let tags = {};
  let ui = null;
  let context = null;   // the sentence the current lookup came from

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
    if (e.key !== 'Shift' || shiftDown || !isCurrent()) return;
    shiftDown = true;

    // A selection plus Shift looks up the selection; otherwise use the cursor.
    const selected = selectionText();
    if (selected) lookup(selected.text, selectionAnchor(), selected);
    else scheduleScan();
  }, true);

  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftDown = false; }, true);
  window.addEventListener('blur', () => { shiftDown = false; });

  window.addEventListener('mousemove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (shiftDown) scheduleScan();
  }, true);

  // Anything that is not "reading the popup" closes it: clicking the page,
  // scrolling it, or taking the mouse out of the frame entirely. Scrolling and
  // clicking inside the popup itself are exempt, which is why these check the
  // event's path — the popup lives in a shadow root, so a plain target check
  // would not recognise its own contents.
  window.addEventListener('mousedown', (e) => { if (!insidePopup(e)) hide(); }, true);
  window.addEventListener('scroll', (e) => { if (!insidePopup(e)) hide(); }, true);
  document.addEventListener('mouseleave', () => hide());

  function insidePopup(e) {
    return !!ui && e.composedPath().indexOf(ui.host) !== -1;
  }

  // A short delay rather than requestAnimationFrame: it settles rapid mouse
  // movement into one lookup, and unlike rAF it still runs in tabs the browser
  // has decided not to paint.
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => { scanScheduled = false; scan(); }, 30);
  }

  function scan() {
    if (!isCurrent()) return;
    const found = textAtPoint(pointer.x, pointer.y);
    // While Shift is held the popup follows what you point at, so pointing at
    // something that is not a word closes it rather than leaving the last
    // result stranded behind the cursor. Let go of Shift and it stays put, so
    // you can move over to it and read.
    if (!found) { hide(); return; }
    if (found.text === lastQuery) return;
    lookup(found.text, pointer, found);
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
    const text = leadingJapanese(forwardText(caret.node, offset, MAX_SCAN));
    return text ? { text, node: caret.node, offset } : null;
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
    const text = leadingJapanese(sel.toString().trim().slice(0, MAX_SCAN));
    if (!text) return null;
    const range = sel.getRangeAt(0);
    return { text, node: range.startContainer, offset: range.startOffset };
  }

  function selectionAnchor() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return pointer;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    return r.width || r.height ? { x: r.left, y: r.bottom } : pointer;
  }

  /**
   * The sentence the word sits in, plus where in it the word starts.
   *
   * Same walk as forwardText, but in both directions and without the sixteen
   * character limit: gather the block's text, find where we are in it, and cut
   * back to the nearest full stop on either side.
   */
  function sentenceAt(node, offset) {
    const block = blockAncestor(node);
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const parent = n.parentElement;
        return !parent || SKIP_TAGS.has(parent.tagName)
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });

    let text = '';
    let index = -1;
    let n;
    while ((n = walker.nextNode())) {
      if (n === node) index = text.length + offset;
      text += n.data;
    }
    if (index < 0) return null;

    let start = index;
    let end = index;
    while (start > 0 && !SENTENCE_END.test(text[start - 1])) start--;
    while (end < text.length && !SENTENCE_END.test(text[end])) end++;
    if (end < text.length) end++;          // keep the full stop itself

    const slice = text.slice(start, end);
    const lead = slice.length - slice.trimStart().length;
    return { text: slice.trim().slice(0, 300), index: index - start - lead };
  }

  /** The sentence with the looked-up word wrapped in bold, ready for a card. */
  function markSentence(sentence, length) {
    const { text, index } = sentence;
    if (index < 0 || index >= text.length) return escapeHtml(text);
    return escapeHtml(text.slice(0, index)) +
      '<b>' + escapeHtml(text.slice(index, index + length)) + '</b>' +
      escapeHtml(text.slice(index + length));
  }

  function definitionHtml(entry, senses) {
    const chosen = senses.map((i) => entry.s[i]);
    const numbered = chosen.length > 1;
    return chosen
      .map((sense, i) => (numbered ? (i + 1) + '. ' : '') + escapeHtml(sense.g.join('; ')))
      .join('<br>');
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // -------------------------------------------------------------------------
  // Asking the background script
  // -------------------------------------------------------------------------

  async function lookup(text, at, where) {
    lastQuery = text;
    // Captured now rather than when "+" is clicked: on a page whose text keeps
    // changing — subtitles, above all — the sentence may be gone by then.
    context = where ? sentenceAt(where.node, where.offset) : null;
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
    host.setAttribute('data-lll-popup', '');
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
    card.scrollTop = 0;
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = text;
    card.appendChild(note);
    place(at);
  }

  async function showResults(groups, at) {
    const { card } = await build();
    card.textContent = '';
    card.scrollTop = 0;   // a new word is a new thing to read, from the top

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
    for (const hit of group.hits) el.appendChild(renderEntry(hit, group.surface));
    return el;
  }

  /**
   * One dictionary entry.
   *
   *     親切  しんせつ                                    +
   *     top 5k · [1] · usually kana · na-adjective, noun
   *       1  kind; gentle; friendly
   *
   * The word gets a line to itself. Everything secondary — how common it is,
   * its pitch, what kind of word it is — goes on one muted line beneath, rather
   * than trailing after the headword where it competes with it. The definitions
   * then all start at the same place, which is what makes them scannable: with
   * the grammar labels inline, every line began somewhere different.
   */
  function renderEntry(hit, surface) {
    const entry = hit.entry;
    const el = document.createElement('div');
    el.className = 'entry';

    // Which spelling and reading to show is decided in lookup.js, so the popup,
    // the pitch accent and the card all name the word the same way.
    const head = document.createElement('div');
    head.className = 'head';

    const word = document.createElement('span');
    word.className = 'word';
    word.textContent = hit.word;
    head.appendChild(word);

    if (hit.reading) {
      const reading = document.createElement('span');
      reading.className = 'reading';
      reading.textContent = hit.reading;
      head.appendChild(reading);
    }

    const list = document.createElement('ol');
    list.className = 'senses';

    const add = document.createElement('button');
    add.className = 'add';
    add.textContent = '+';
    add.title = 'Add to Anki';
    add.addEventListener('click', () => {
      mine(add, el, {
        word: hit.word,
        reading: hit.reading || '',
        entry,
        surface,
        senses: chosenSenses(list)
      });
    });
    head.appendChild(add);
    el.appendChild(head);

    const meta = [];
    if (hit.band) {
      meta.push([hit.band, 'ranked #' + entry.q.toLocaleString('en-US') +
        ' in a corpus of Japanese media']);
    }
    if (typeof hit.pitch === 'number') {
      meta.push(['[' + hit.pitch + ']', hit.pitch === 0
        ? 'flat — the pitch never drops'
        : 'the pitch drops after mora ' + hit.pitch]);
    }
    for (const code of hit.shared || []) meta.push([label(code), tags[code] || code]);
    if (entry.s[0].p.length) meta.push([entry.s[0].p.map(label).join(', '), '']);

    if (meta.length) el.appendChild(renderMeta(meta));

    if (hit.reasons.length) {
      const why = document.createElement('div');
      why.className = 'reasons';
      why.textContent = hit.reasons.join(' → ');
      el.appendChild(why);
    }

    let previous = entry.s[0].p.join(',');   // already said on the meta line

    entry.s.forEach((sense, i) => {
      const li = document.createElement('li');

      // Only what this sense adds: the grammar it does not share with the line
      // above, and any tag that applies to it alone.
      const qualifiers = [];
      const pos = sense.p.join(',');
      if (i > 0 && pos !== previous) qualifiers.push(...sense.p.map(label));
      previous = pos;
      for (const code of sense.m || []) {
        if ((hit.shared || []).indexOf(code) === -1) qualifiers.push(label(code));
      }

      if (qualifiers.length) {
        const note = document.createElement('span');
        note.className = 'qualifier';
        note.textContent = qualifiers.join(', ');
        li.appendChild(note);
      }
      li.appendChild(document.createTextNode(sense.g.join('; ')));

      // Click a sense to put only that one on the card. 語 is "word; term" and
      // "language"; usually you met just one of them. Choosing nothing means
      // the whole entry, so the common case still needs no clicks at all.
      li.title = 'click to put only this on the card';
      li.addEventListener('click', () => {
        // Ignore the click that ends a drag over the text, or selecting a
        // definition to copy would silently change what gets mined.
        if (String(window.getSelection())) return;
        li.classList.toggle('chosen');
        list.classList.toggle('choosing', !!list.querySelector('.chosen'));
      });
      list.appendChild(li);
    });

    el.appendChild(list);
    return el;
  }

  /** Which senses were picked, or all of them when none were. */
  function chosenSenses(list) {
    const items = [...list.children];
    const picked = items.filter((li) => li.classList.contains('chosen'));
    return (picked.length ? picked : items).map((li) => items.indexOf(li));
  }

  function renderMeta(parts) {
    const line = document.createElement('div');
    line.className = 'meta';
    parts.forEach(([text, hint], i) => {
      if (i) {
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '·';
        line.appendChild(sep);
      }
      const span = document.createElement('span');
      span.textContent = text;
      if (hint) span.title = hint;
      line.appendChild(span);
    });
    return line;
  }

  /**
   * Turn one entry into a card. The four pieces go off to the background
   * script, which is the only part that may reach your local Anki; which field
   * each piece lands in is set once in LLL's options.
   */
  async function mine(button, entryEl, { word, reading, entry, surface, senses }) {
    button.disabled = true;
    button.textContent = '·';
    const old = entryEl.querySelector('.error');
    if (old) old.remove();

    const note = {
      word,
      reading,
      // The bold marks the word exactly as the page wrote it, inflection and
      // all, while the Target Word field carries the dictionary form.
      sentence: context ? markSentence(context, surface.length) : '',
      // Kept so a mapping saved before the two were merged still fills in.
      sentenceMarked: context ? markSentence(context, surface.length) : '',
      definition: definitionHtml(entry, senses)
    };

    let reply;
    try {
      reply = await api.runtime.sendMessage({ type: 'ankiAdd', note });
    } catch (err) {
      reply = { ok: false, error: String(err) };
    }

    if (reply && reply.ok) {
      button.textContent = '✓';
      button.classList.add('done');
      return;
    }
    button.textContent = '+';
    button.disabled = false;
    const message = document.createElement('div');
    message.className = 'error';
    message.textContent = (reply && reply.error) || 'Could not add the card.';
    entryEl.appendChild(message);
  }

  /**
   * A JMdict tag in words. The codes are compact but opaque — "uk" tells you
   * nothing until someone explains it — and this popup has room to say it.
   */
  function label(code) {
    if (LABELS[code]) return LABELS[code];
    if (code.startsWith('v5')) return 'godan verb';
    const described = tags[code];
    return described ? described.split('(')[0].trim().toLowerCase() : code;
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
