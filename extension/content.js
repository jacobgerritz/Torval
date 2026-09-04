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

  // Hiragana, katakana, kanji, the repeat mark and halfwidth katakana — written
  // down once, in japanese.js, because the hover, the reading of a whole passage
  // and the marking of a page all have to agree on what counts.
  const JAPANESE = LLLJapanese;
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
  let queryToken = 0;
  let scanScheduled = false;
  let tags = {};
  let ui = null;
  let context = null;   // the sentence the current lookup came from
  let chosenList = null;   // the <ol> currently holding a picked sense, if any

  // Plain hovering, with no Shift and no click — what is under the cursor
  // right now, kept up to date on every mouse movement so that a click or a
  // press of 3 has an answer ready rather than a fresh lookup to wait on.
  let hoverToken = 0;
  let hoverWord = null;   // the dictionary form of whatever is under the cursor
  let hoverState = 'unknown';   // and whether it is already known or ignored
  // The stretch of the page the current answer covers, so that moving the
  // mouse along a word does not ask about it again, while moving to the next
  // word does. Keyed by the block it was read from, since two blocks each
  // have their own idea of what character number 5 is.
  let hoverBlock = null;
  let hoverFrom = -1;
  let hoverTo = -1;

  api.runtime.sendMessage({ type: 'tags' }).then((t) => { if (t) tags = t; }).catch(() => {});

  // Recording ahead of the user costs something, so ask first whether any card
  // field is pointed at a video frame or the line's audio.
  // LLL draws its own subtitles, so it knows exactly when each line runs from
  // and to — which is what lets it record the line itself rather than an
  // approximation of it. They are meant to replace YouTube's, so they are drawn
  // whether or not anything is being mined. Recording only happens on demand.
  if (typeof LLLSubtitles !== 'undefined') LLLSubtitles.enable();

  // Only the page itself gets a bar. This script runs in every frame, and an
  // advert in an iframe reporting its own comprehension across the top of
  // somebody else's article is not a thing anyone asked for.
  if (window === window.top && typeof LLLBar !== 'undefined') watchComprehension();

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
    if (e.key === '3' && markHover(e, 'know')) return;
    if (e.key === '4' && markHover(e, 'ignore')) return;
    if (e.key !== 'Shift' || shiftDown || !isCurrent()) return;
    shiftDown = true;

    // A selection plus Shift looks up the selection; otherwise use the cursor.
    const selected = selectionText();
    if (selected) lookup(selected.text, selectionAnchor(), selected);
    else scheduleScan();
  }, true);

  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftDown = false; }, true);
  window.addEventListener('blur', () => { shiftDown = false; });

  /**
   * 3 says you know the word being pointed at; 4 says never to mention it
   * again. Neither needs the ✓ or the ⊘, or even an open popup: whatever
   * plain hovering has already resolved is what they act on, the same word a
   * click would open.
   *
   * Most of what you meet while reading is a word you already know, and
   * saying so is the one thing done often enough that it should not cost a
   * mouse movement. The numbers are 3 and 4 because that is where "known"
   * and "ignored" sit in the scheme every other tool of this kind uses, so
   * the fingers already know them, and 1 and 2 stay free should there ever
   * be more answers to the question than these.
   *
   * They set rather than toggle. Pressing one twice should not undo it: with
   * keys this easy to lean on, an accidental repeat must be harmless.
   * Undoing either is a deliberate click in the popup.
   *
   * Answers whether it did anything, because the key has to be taken away
   * from the page when it did — YouTube reads the number keys as "jump to
   * 30% of the video", and this must never also lose your place, whether or
   * not a popup happens to be open.
   */
  function markHover(e, kind) {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;

    const focused = document.activeElement;
    if (focused && (focused.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName))) return false;

    // A popup already open for exactly this word is driven through its own
    // button, so the button lights up too rather than only the page's
    // marking updating out from under it.
    if (ui && ui.host.style.display === 'block') {
      const button = ui.card.querySelector('.entry .' + kind);
      const wordEl = ui.card.querySelector('.entry .word');
      if (button && button.setState && wordEl && wordEl.textContent === hoverWord) {
        e.preventDefault();
        e.stopPropagation();
        button.setState(true);
        return true;
      }
    }

    if (!hoverWord) return false;
    e.preventDefault();
    e.stopPropagation();
    applyState(hoverWord, kind, true, hoverState);
    hoverState = kind === 'know' ? 'known' : 'ignored';
    return true;
  }

  /**
   * Record that a word is known, or ignored, and reflect it everywhere at
   * once: the number at the top of the page, and every place that word is
   * marked on it.
   *
   * Known and ignored both mean "stop marking this", so the page treats them
   * the same. The score does not: a known word counts towards understanding
   * the page, while an ignored one leaves the question altogether. The bar is
   * told where the word was and where it has gone rather than just what
   * changed, because moving straight from known to ignored has to take it out
   * of two counts at once, and only the two ends of the move say that.
   */
  function applyState(word, kind, on, before) {
    const message = kind === 'know'
      ? { type: 'setKnown', word, known: on }
      : { type: 'setIgnored', word, ignored: on };
    const after = !on ? 'unknown' : (kind === 'know' ? 'known' : 'ignored');

    return api.runtime.sendMessage(message).then((reply) => {
      if (!reply || !reply.ok) return false;
      if (typeof LLLBar !== 'undefined') LLLBar.restate(word, before, after);
      if (typeof LLLHighlight !== 'undefined') LLLHighlight.setMarked(word, after === 'unknown');
      return true;
    }).catch(() => false);
  }

  window.addEventListener('mousemove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    scheduleScan();
  }, true);

  /**
   * A click on a plain word looks it up exactly as Shift would, without
   * needing Shift held down first. Links, buttons, form fields and anything
   * already inside the popup are left alone — this only ever takes over a
   * click that would otherwise have done nothing.
   */
  window.addEventListener('click', (e) => {
    if (!isCurrent() || insidePopup(e)) return;
    if (String(window.getSelection())) return;   // ending a drag-select, not a click to look up
    if (isInteractive(e.target)) return;
    const found = textAtPoint(e.clientX, e.clientY);
    if (!found) return;
    lookup(found.text, { x: e.clientX, y: e.clientY }, found);
  }, true);

  function isInteractive(el) {
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA|LABEL)$/.test(node.tagName)) return true;
      if (node.isContentEditable) return true;
      node = node.parentElement;
    }
    return false;
  }

  // Anything that is not "reading the popup" closes it: clicking the page,
  // scrolling it, or taking the mouse out of the frame entirely. Scrolling and
  // clicking inside the popup itself are exempt, which is why these check the
  // event's path — the popup lives in a shadow root, so a plain target check
  // would not recognise its own contents.
  window.addEventListener('mousedown', (e) => { if (!insidePopup(e)) hide(); }, true);
  window.addEventListener('scroll', (e) => { if (!insidePopup(e)) hide(); }, true);
  document.addEventListener('mouseleave', () => { hide(); clearHover(); });

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

    if (shiftDown) {
      // While Shift is held the popup follows what you point at, so pointing
      // at something that is not a word closes it rather than leaving the
      // last result stranded behind the cursor. Let go of Shift and it stays
      // put, so you can move over to it and read.
      if (!found) { hide(); return; }
      // Same test as plain hovering: has the cursor actually left the word
      // being shown. Comparing the surrounding text instead, which is what
      // this used to do, meant panning along a line with Shift held never
      // looked like a change — reading outward from the cursor gives the
      // same stretch of text for every character of it — so the popup sat on
      // the first word of the line however far the mouse travelled.
      const settled = ui && ui.host.style.display === 'block';
      if (settled && inCurrentWord(found)) return;
      lookup(found.text, pointer, found);
      return;
    }

    hoverScan(found);
  }

  // -------------------------------------------------------------------------
  // Plain hovering: a light mark on whatever word the cursor sits over, with
  // no popup and no Shift needed. It exists so that a page reads as "here is
  // where LLL can help" at a glance, and so that clicking or pressing 3 has
  // something to act on immediately.
  // -------------------------------------------------------------------------

  /** Is the cursor still inside the word the current answer is about? */
  function inCurrentWord(found) {
    return found.block === hoverBlock && found.at >= hoverFrom && found.at < hoverTo;
  }

  async function hoverScan(found) {
    if (!found) { clearHover(); return; }

    // Ask again only when the cursor has actually left the word already
    // being shown. This used to compare the surrounding text instead, which
    // seemed reasonable and was quietly useless: reading outward from the
    // cursor in both directions gives the *same* stretch of text for every
    // character of 花は小さく, so panning along a line never looked like a
    // change and the mark stayed stuck on the first word. Comparing where
    // the cursor is against where the answer actually reaches is the thing
    // that was meant all along.
    if (inCurrentWord(found)) return;

    hoverBlock = null;
    hoverWord = null;
    hoverState = 'unknown';
    const token = ++hoverToken;

    let reply;
    try {
      reply = await api.runtime.sendMessage({ type: 'lookup', text: found.text, point: found.point });
    } catch (err) {
      return;   // background restarting; the next hover will retry
    }
    if (token !== hoverToken || !isCurrent()) return;
    if (!reply || !reply.groups || !reply.groups.length) { clearHover(); return; }

    const top = reply.groups[0];
    hoverWord = top.hits[0].word;
    hoverState = stateOf(top.hits[0]);

    // The word may genuinely have begun before the character the cursor
    // happened to land on — hovering anywhere inside ネカフェ still finds
    // and marks the whole word, not just whatever was directly underneath.
    const from = found.base + (typeof reply.start === 'number' ? reply.start : found.point);
    hoverBlock = found.block;
    hoverFrom = from;
    hoverTo = from + top.length;

    const start = locateInPieces(found.pieces, from);
    if (start) paintHover(start.node, start.offset, top.length);
  }

  function clearHover() {
    hoverBlock = null;
    hoverFrom = -1;
    hoverTo = -1;
    hoverWord = null;
    hoverState = 'unknown';
    hoverToken++;
    if (hoverSupported()) CSS.highlights.delete(HOVER_HIGHLIGHT);
  }

  function hoverSupported() {
    return typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
  }

  const HOVER_HIGHLIGHT = 'lll-hover';
  let hoverStyleAdded = false;

  /**
   * A quiet highlight under the word the cursor is on right now, using the
   * same technique the unknown-word colouring uses — a Range and the CSS
   * Custom Highlight API — rather than wrapping anything in a <span>, so
   * hovering never touches the page's own DOM.
   */
  function paintHover(node, offset, length) {
    if (!hoverSupported()) return;
    if (!hoverStyleAdded) {
      hoverStyleAdded = true;
      const style = document.createElement('style');
      style.textContent = '::highlight(' + HOVER_HIGHLIGHT + '){background-color:rgba(147,180,198,.3);}';
      (document.head || document.documentElement).appendChild(style);
    }
    const end = spanEnd(node, offset, length);
    if (!end) return;
    try {
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(end.node, end.offset);
      CSS.highlights.set(HOVER_HIGHLIGHT, new Highlight(range));
    } catch (err) {
      // the page moved the text out from under this while it was being worked
      // out — the next hover over it tries again.
    }
  }

  /**
   * Where a match of `length` characters starting at (node, offset) actually
   * ends, which is not always the same text node it started in — 図書館 is
   * routinely written as two adjacent <span>s, and the real dictionary match
   * can run past the end of the one the cursor happens to be over.
   */
  function spanEnd(node, offset, length) {
    const remaining = length - (node.data.length - offset);
    if (remaining <= 0) return { node, offset: offset + length };

    const block = blockAncestor(node);
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const parent = n.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    walker.currentNode = node;

    let left = remaining;
    let next;
    while ((next = walker.nextNode())) {
      if (blockAncestor(next) !== block) return null;
      if (next.data.length >= left) return { node: next, offset: left };
      left -= next.data.length;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Finding the text under the cursor
  // -------------------------------------------------------------------------

  /**
   * The word under the cursor — not just the character.
   *
   * Pointing at フェ inside ネカフェ has to still find ネカフェ, not read
   * forward from フェ and land on some shorter, unrelated match that merely
   * starts there. There is no way to know that from just one character
   * though, which is why this reads the whole surrounding block rather than
   * only forward from the point: `point` marks which character in the result
   * was actually pointed at, and the background script tries every plausible
   * starting point behind it to find whichever real word actually covers
   * that character. `pieces` and `base` come along so that once the real
   * answer is known, lookup() can place the sentence context at the word's
   * true start rather than wherever the cursor happened to land inside it.
   */
  function textAtPoint(x, y) {
    const caret = caretAt(x, y);
    if (!caret || caret.node.nodeType !== Node.TEXT_NODE) return null;
    if (SKIP_TAGS.has((caret.node.parentElement || {}).tagName)) return null;
    const offset = resolveCharacter(caret.node, caret.offset, x, y);
    if (offset === -1) return null;

    const block = blockPieces(caret.node);
    const at = locateOffset(block.pieces, caret.node, offset);
    if (at < 0 || !JAPANESE.test(block.text[at])) return null;

    let start = at;
    while (start > 0 && start > at - MAX_SCAN && JAPANESE.test(block.text[start - 1])) start--;
    let end = at + 1;
    while (end < block.text.length && end < at + MAX_SCAN && JAPANESE.test(block.text[end])) end++;

    const loc = locateInPieces(block.pieces, start);
    if (!loc) return null;
    return {
      text: block.text.slice(start, end), node: loc.node, offset: loc.offset,
      point: at - start, pieces: block.pieces, base: start,
      // Where the cursor is in the block's own terms, and which block that
      // is, so hovering can tell "still the same word" from "the next word
      // along" without asking the dictionary again.
      block: block.block, at
    };
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
   * Every text node in the block the given node sits in, laid end to end as
   * one string, with a record of which stretch of that string came from
   * which node. Sites break sentences across `<span>`s constantly — YouTube's
   * captions are one span per line, ruby furigana is several per word — so a
   * word has to be findable regardless of which element it happens to be
   * split across, in either direction from wherever the cursor lands in it.
   */
  function blockPieces(node) {
    const block = blockAncestor(node);
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const parent = n.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const pieces = [];
    let text = '';
    let n;
    while ((n = walker.nextNode())) {
      pieces.push({ node: n, start: text.length, end: text.length + n.data.length });
      text += n.data;
    }
    return { pieces, text, block };
  }

  /** Where a known (node, offset) sits within blockPieces' combined text. */
  function locateOffset(pieces, node, offset) {
    for (const piece of pieces) {
      if (piece.node === node) return piece.start + offset;
    }
    return -1;
  }

  /** The reverse: which (node, offset) a position in that combined text is. */
  function locateInPieces(pieces, at) {
    let low = 0;
    let high = pieces.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const piece = pieces[mid];
      if (at < piece.start) high = mid - 1;
      else if (at >= piece.end) low = mid + 1;
      else return { node: piece.node, offset: at - piece.start };
    }
    return null;
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
  // How much of this page you already know
  // -------------------------------------------------------------------------

  // Reading a page end to end is not free, so it is done once and then only
  // again when what is on the page has genuinely changed. On a video that is
  // the transcript arriving, which turns up seconds after the page does and is
  // worth waiting for; everywhere else the ⟳ on the bar is the way to ask
  // again, since a page whose text keeps changing under you is rare enough not
  // to be worth watching for constantly.
  let lastTranscript = '';
  let readingPage = false;

  async function watchComprehension() {
    if (typeof LLLHighlight !== 'undefined') await LLLHighlight.start();

    LLLBar.onRefresh(() => { lastTranscript = ''; readPage(); });
    await waitForDictionary();
    setTimeout(readPage, 1500);   // let the page finish putting itself together

    // Subtitles arrive well after the page does, and replace it as the thing
    // worth measuring the moment they do.
    if (typeof LLLSubtitles !== 'undefined') {
      let seen = -1;
      setInterval(() => {
        const now = LLLSubtitles.count();
        if (now === seen) return;
        seen = now;
        if (now) readPage();
      }, 2000);
    }
  }

  /**
   * Wait for the dictionary to be ready, saying so on the way.
   *
   * The first time LLL runs it copies 218,000 entries into the browser's own
   * database, which takes about a minute; every start after that still needs
   * a moment to open it. None of that used to show anywhere on the page, so
   * the only thing to conclude from hovering a word and getting nothing was
   * that the whole thing was broken. Now the handle in the corner says what
   * is happening, and how far along it is.
   */
  async function waitForDictionary() {
    for (;;) {
      let reply;
      try {
        reply = await api.runtime.sendMessage({ type: 'status' });
      } catch (err) {
        return;   // the background is restarting; reading will retry anyway
      }
      const state = reply && reply.status;
      if (!state || state.state === 'ready') return;
      if (state.state === 'error') {
        LLLBar.busy('LLL could not load its dictionary');
        return;
      }
      LLLBar.busy('Building the dictionary, one time only…', state.progress || 0);
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }

  /**
   * Read the page: what the bar says, and which words get marked.
   *
   * A video is measured against its transcript rather than against what is on
   * screen — the point of the score is to say what is coming, and the page
   * around the player is comments and menus, not the thing being watched. The
   * marking still goes on the page, because that is where the words are.
   *
   * These are two separate questions asked in the same breath, not one
   * question depending on the other. They used to share a single try block,
   * which meant a stumble in the colouring — the page not being fully settled
   * yet, a rectangle the browser refused to measure — aborted the score
   * calculation too, before the score had even been asked for. The bar would
   * sit on "…" until the next unrelated reason to read the page came along,
   * which is exactly the "showed nothing, then later showed 72%" pattern:
   * both numbers were being computed correctly, but only one of the two ever
   * got the chance.
   */
  async function readPage() {
    if (readingPage || !isCurrent()) return;
    readingPage = true;
    LLLBar.busy('Reading this page…');

    const transcript = typeof LLLSubtitles !== 'undefined' ? LLLSubtitles.allText() : '';
    let scored = false;

    if (transcript && transcript !== lastTranscript) {
      lastTranscript = transcript;
      try {
        const reply = await api.runtime.sendMessage({ type: 'comprehension', text: transcript });
        if (reply && reply.ok) { LLLBar.show(reply.result); scored = true; }
        else lastTranscript = '';
      } catch (err) {
        lastTranscript = '';   // the dictionary was still loading; the next try may do better
      }
    }

    if (typeof LLLHighlight !== 'undefined') {
      try {
        const score = await LLLHighlight.read();
        if (!transcript && score && !scored) LLLBar.show(score);
      } catch (err) {
        console.warn('LLL: could not colour this page —', err && err.message);
      }
    }

    readingPage = false;
  }

  // -------------------------------------------------------------------------
  // Asking the background script
  // -------------------------------------------------------------------------

  async function lookup(text, at, where) {
    // Captured now rather than when "+" is clicked: on a page whose text keeps
    // changing — subtitles, above all — the sentence may be gone by then. This
    // is only ever provisional when `where.point` is set: the real word may
    // turn out to start earlier than wherever the cursor actually landed
    // inside it, and the sentence context has to move with it or the bold
    // in an exported card would land in the wrong place.
    context = where ? sentenceAt(where.node, where.offset) : null;
    const token = ++queryToken;
    let reply;
    try {
      reply = await api.runtime.sendMessage({
        type: 'lookup', text,
        point: where && typeof where.point === 'number' ? where.point : undefined
      });
    } catch (err) {
      return;   // background restarting; the next hover will retry
    }
    if (token !== queryToken || !reply) return;

    if (where && where.pieces && typeof reply.start === 'number' && reply.start !== where.point) {
      const loc = locateInPieces(where.pieces, where.base + reply.start);
      if (loc) context = sentenceAt(loc.node, loc.offset);
    }

    // Whatever this turned out to be is now the word in play, whether it was
    // reached by hovering, by clicking or by holding Shift. Recording it here
    // rather than only in hoverScan is what lets Shift-panning tell "still
    // the same word" from "the next one along", and what lets 3 and 4 act on
    // a word the popup was opened on by a click.
    const top = reply.groups && reply.groups[0];
    if (where && where.pieces && top) {
      const from = where.base + (typeof reply.start === 'number' ? reply.start : where.point);
      hoverBlock = where.block;
      hoverFrom = from;
      hoverTo = from + top.length;
      hoverWord = top.hits[0].word;
      hoverState = stateOf(top.hits[0]);
    }

    if (reply.status.state === 'loading') {
      showMessage(`Building dictionary… ${Math.round(reply.status.progress * 100)}%`, at);
    } else if (reply.status.state === 'error') {
      showMessage('Dictionary failed to load — see the extension console.', at);
    } else if (reply.groups && reply.groups.length) {
      showResults(reply.groups, at);
    } else {
      // Nothing there. Leaving the last word on screen would be worse than
      // showing nothing: while Shift is held the popup is meant to follow the
      // cursor, and a stale answer sitting under a word it has nothing to do
      // with reads as an answer about that word.
      hide();
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
    chosenList = null;    // the popup being replaced takes any chosen sense with it

    card.appendChild(renderGroup(groups[0], true));

    if (groups.length > 1) {
      const rest = document.createElement('div');
      rest.className = 'shorter';
      rest.hidden = true;
      for (let i = 1; i < groups.length; i++) rest.appendChild(renderGroup(groups[i], false));

      const toggle = document.createElement('button');
      toggle.className = 'toggle';
      // Not always literally shorter: the particle-trap check in lookup.js can
      // put a longer reading down here too, when a much rarer entry is being
      // passed over in favour of a common word plus an ordinary particle.
      toggle.textContent = `${groups.length - 1} other ${groups.length === 2 ? 'match' : 'matches'}`;
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
      // Fired off first, before the slower work of capturing the sentence
      // (and any video audio) even starts: a duplicate is not an error and
      // never stops the card being made, but it is worth knowing right away
      // rather than only once the recording has already finished.
      warnIfDuplicate(el, hit.word);
      mine(add, el, {
        word: hit.word,
        reading: hit.reading || '',
        entry,
        surface,
        senses: chosenSenses(list)
      });
    });

    // Three different things you might want to do with a word you have just
    // looked up, none of them the same: ⊘ means "never mention this again",
    // ✓ means "I already have this", + means "teach me this". The first two
    // are what the comprehension percentage is built out of, so either one
    // moves the bar at the top of the page immediately.
    const buttons = document.createElement('span');
    buttons.className = 'buttons';
    buttons.append(stateButton(hit, 'ignore'), stateButton(hit, 'know'), add);
    head.appendChild(buttons);
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
    // Only the part of speech every sense actually has in common goes on the
    // meta line. 勉強 is a transitive suru-verb for one sense and intransitive
    // for another and plain "noun" for a third — showing the first sense's
    // combination as though it summed up the word would just be wrong for
    // the rest of them.
    const sharedPos = hit.sharedPos || [];
    if (sharedPos.length) meta.push([sharedPos.map(label).join(', '), '']);

    if (meta.length) el.appendChild(renderMeta(meta));

    if (hit.reasons.length) {
      const why = document.createElement('div');
      why.className = 'reasons';
      why.textContent = hit.reasons.join(' → ');
      el.appendChild(why);
    }

    entry.s.forEach((sense) => {
      const li = document.createElement('li');

      // Only what this sense adds beyond what already applies to the whole
      // word: the grammar it does not share with every other sense, and any
      // tag that belongs to it alone.
      const qualifiers = [];
      const extraPos = sense.p.filter((code) => sharedPos.indexOf(code) === -1);
      if (extraPos.length) qualifiers.push(...extraPos.map(label));
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

        // Senses picked in a different entry do not carry over — a card is
        // one word, and choosing a meaning of 語 must not leave a meaning of
        // 話 still marked chosen somewhere else in the popup, waiting to be
        // put on the same card by mistake.
        if (chosenList && chosenList !== list) {
          for (const other of chosenList.children) other.classList.remove('chosen');
          chosenList.classList.remove('choosing');
        }

        li.classList.toggle('chosen');
        const active = !!list.querySelector('.chosen');
        list.classList.toggle('choosing', active);
        chosenList = active ? list : null;
      });
      list.appendChild(li);
    });

    el.appendChild(list);
    return el;
  }

  const STATES = {
    know: {
      glyph: '✓',
      on: 'Known — click to unmark',
      off: 'Mark as already known (or press 3)'
    },
    ignore: {
      glyph: '⊘',
      on: 'Ignored — click to stop ignoring it',
      off: 'Never mention this word again (or press 4)'
    }
  };

  /**
   * The tick that says "I already know this word", and the ⊘ that says "never
   * mention this one again" — a name, a piece of English, something the
   * dictionary read wrongly. Both are the same button with a different
   * meaning, so they behave identically and there is one description of what
   * marking a word does.
   *
   * They toggle, because the commonest mistake to make with either is
   * pressing it on the wrong word, and a list you can only add to is one that
   * slowly fills with things that are not true. They are also mutually
   * exclusive: a word is known, or ignored, or neither, so turning one on
   * turns the other off, both here and in what gets stored.
   */
  function stateButton(hit, kind) {
    const labels = STATES[kind];
    const button = document.createElement('button');
    button.className = kind;
    button.textContent = labels.glyph;
    let on = kind === 'know' ? !!hit.known : !!hit.ignored;
    paint();

    // Clicking asks for the opposite of whatever it is now; 3 and 4 ask for
    // it outright. Both end up here.
    button.addEventListener('click', () => set(!on));
    button.setState = set;

    async function set(wanted) {
      if (wanted === on) return;
      button.disabled = true;
      const ok = await applyState(hit.word, kind, wanted, stateOf(hit));
      button.disabled = false;
      if (!ok) return;
      on = wanted;
      if (kind === 'know') hit.known = wanted; else hit.ignored = wanted;
      paint();
      // Turning one on turns the other off. The stored lists already sort
      // that out themselves, so this only has to repaint the other button —
      // sending a second message would tell the bar to count the same change
      // twice.
      if (wanted) {
        const other = button.parentElement &&
          button.parentElement.querySelector('.' + (kind === 'know' ? 'ignore' : 'know'));
        if (other && other.repaint) {
          if (kind === 'know') hit.ignored = false; else hit.known = false;
          other.repaint();
        }
      }
    }

    function paint() {
      button.classList.toggle('on', on);
      button.title = on ? labels.on : labels.off;
    }

    button.repaint = function () {
      on = kind === 'know' ? !!hit.known : !!hit.ignored;
      paint();
    };
    return button;
  }

  /** Which of the three a word is in right now: known, ignored, or neither. */
  function stateOf(hit) {
    if (hit.ignored) return 'ignored';
    if (hit.known) return 'known';
    return 'unknown';
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
   * A quick, non-blocking heads-up if this word is already in the collection.
   * Duplicates are allowed — one sentence can easily teach three words, and
   * mining the same word again later is not a mistake either — so this never
   * stops the card being made; it only says so, and as early as possible.
   */
  async function warnIfDuplicate(entryEl, word) {
    const old = entryEl.querySelector('.dup-note');
    if (old) old.remove();
    let reply;
    try {
      reply = await api.runtime.sendMessage({ type: 'ankiDuplicate', word });
    } catch (err) {
      return;
    }
    if (reply && reply.ok && reply.result) {
      const note = document.createElement('div');
      note.className = 'note dup-note';
      note.textContent = 'Already in your collection — adding it again too.';
      entryEl.appendChild(note);
    }
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

    // The line's exact timing comes from LLL's own subtitles; the video is sent
    // back over it to record it, so this takes as long as the line does.
    const sentence = context ? context.text : '';
    const cue = typeof LLLSubtitles !== 'undefined' ? LLLSubtitles.cueFor(sentence) : null;
    const media = typeof LLLVideo !== 'undefined'
      ? await LLLVideo.capture(sentence, cue)
      : {};

    const note = {
      media,
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
