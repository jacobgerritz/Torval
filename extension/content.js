/*
 * LLL, the part that runs on the page
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
 * The popup lives in a "shadow root", a small sealed-off document of its own.
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

  /**
   * Is LLL supposed to be doing anything here?
   *
   * Two questions in one, because they have the same answer everywhere it
   * is asked: is this frame still the one that owns the page, and is LLL
   * switched on at all. The switch lives on the toolbar button, and every
   * page watches it, so turning it off quietens pages that are already open
   * rather than only the next one.
   */
  function isCurrent() {
    if (off) return false;
    if (document.documentElement.getAttribute(OWNER) === instance) return true;
    if (ui) { ui.host.remove(); ui = null; }
    return false;
  }

  // Hiragana, katakana, kanji, the repeat mark and halfwidth katakana, written
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

  // Plain hovering, with no Shift and no click, what is under the cursor
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
  let hoverSpan = null;   // the text those positions were measured against

  // The toolbar switch. Read once at the start and watched after that, so a
  // page open in another tab goes quiet the moment it is turned off.
  let off = false;
  api.storage.local.get('off').then((stored) => {
    if (!stored.off) return;
    off = true;
    putAway();
  }).catch(() => {});

  if (api.storage.onChanged) {
    api.storage.onChanged.addListener((changes) => {
      if (!changes.off) return;
      off = !!changes.off.newValue;
      if (off) putAway(); else bringBack();
    });
  }

  /** Everything LLL had put on this page, taken off it again. */
  function putAway() {
    hide();
    clearHover();
    if (typeof LLLHighlight !== 'undefined') LLLHighlight.clear();
    if (typeof LLLBar !== 'undefined') LLLBar.visible(false);
    if (typeof LLLSubtitles !== 'undefined') LLLSubtitles.suspend(true);
  }

  /** And put back, without making anybody reload the page. */
  function bringBack() {
    if (typeof LLLBar !== 'undefined') LLLBar.visible(true);
    if (typeof LLLSubtitles !== 'undefined') LLLSubtitles.suspend(false);
    lastTranscript = '';
    readPage();
  }

  api.runtime.sendMessage({ type: 'tags' }).then((t) => { if (t) tags = t; }).catch(() => {});

  // Recording ahead of the user costs something, so ask first whether any card
  // field is pointed at a video frame or the line's audio.
  // LLL draws its own subtitles, so it knows exactly when each line runs from
  // and to, which is what lets it record the line itself rather than an
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
    if (e.key === '1' && markHover(e, 'unknown')) return;
    if (e.key === '2' && markHover(e, 'known')) return;
    if (e.key === '3' && markHover(e, 'ignored')) return;
    if ((e.key === 'b' || e.key === 'B') && browseInAnki(e)) return;
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
   * 1, 2 and 3 answer the only question there is about a word: 1 says you do
   * not know it, 2 says you do, 3 says never to mention it again. Neither
   * needs the ✓ or the ⊘, or even an open popup: whatever plain hovering has
   * already resolved is what they act on, the same word a click would open.
   *
   * Most of what you meet while reading is a word you already know, and
   * saying so is the one thing done often enough that it should not cost a
   * mouse movement. They run 1, 2, 3 in the order the answers themselves run,
   * from knowing nothing to wanting nothing, which is easier to keep hold of
   * than remembering which numbers a different tool happened to use.
   *
   * They set rather than toggle, so leaning on one is harmless, and every one
   * of the three states can be reached from every other: pressing 1 on a word
   * marked known puts it back to unknown, which used to take a trip to the
   * popup.
   *
   * Answers whether it did anything, because the key has to be taken away
   * from the page when it did. YouTube reads the number keys as "jump to 30%
   * of the video", and this must never also lose your place, whether or not a
   * popup happens to be open.
   */
  function markHover(e, wanted) {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;

    const focused = document.activeElement;
    if (focused && (focused.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName))) return false;

    // Taken from the page whether or not there is a word to mark. YouTube
    // reads the number keys as "jump to 30% of the video", and a key that
    // sometimes marks a word and sometimes throws away your place in a
    // video is worse than either on its own.
    e.preventDefault();
    e.stopPropagation();
    if (!hoverWord) return true;

    // Already there. The key is still taken from the page, since the reason
    // for taking it has nothing to do with whether anything changed.
    const before = hoverState || 'unknown';
    if (before === wanted) return true;

    // Every move is one of two switches being thrown, and which one depends
    // on where the word is coming from as much as where it is going: known to
    // ignored turns known off by turning ignored on, but known to unknown has
    // to turn known off itself.
    // applyState, through syncState, is what records the new state, including
    // for the cursor, so a second press of the same key does nothing rather
    // than counting the same word twice.
    if (wanted === 'unknown') applyState(hoverWord, before === 'known' ? 'know' : 'ignore', false, before);
    else applyState(hoverWord, wanted === 'known' ? 'know' : 'ignore', true, before);
    return true;
  }

  /**
   * B opens Anki's card browser on whatever is under the cursor, or on what
   * you have selected if you have selected something.
   *
   * The same search the popup uses to say a word is already in your
   * collection, so what Anki shows is what LLL meant by that. Unlike 1, 2
   * and 3 it only takes the key when there is something to look up, since a
   * letter is a letter and plenty of sites have their own use for it.
   */
  function browseInAnki(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;

    const focused = document.activeElement;
    if (focused && (focused.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName))) return false;

    // What you picked out yourself beats what the cursor happens to be over.
    const chosen = String(window.getSelection() || '').trim();
    const word = chosen || hoverWord;
    if (!word) return false;

    e.preventDefault();
    e.stopPropagation();
    api.runtime.sendMessage({ type: 'ankiBrowse', word }).then((reply) => {
      if (reply && reply.ok) return;
      // Anki not being open is worth saying, and the popup is the only place
      // there is to say it. With no popup open there is nowhere, and a word
      // that simply is not there is not an error worth interrupting for.
      const entry = ui && ui.host.style.display === 'block' && ui.card.querySelector('.entry');
      if (!entry) return;
      const failed = saying(entry, (reply && reply.error) || 'Anki did not answer.');
      failed.className = 'error';
    }).catch(() => {});
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
      if (typeof LLLHighlight !== 'undefined') {
        LLLHighlight.setMarked(word, after === 'unknown');
        // The subtitle showing now is drawn from ranges of its own, made
        // when the line arrived. Asking for them again is one short message
        // and it cannot be wrong, whereas repainting the ranges already
        // held is only right while the player has left them alone.
        LLLHighlight.refreshLine();
      }
      syncState(word, after);
      return true;
    }).catch(() => false);
  }

  /**
   * Bring everything that shows this word's state into line with what it has
   * just become.
   *
   * Two places can be out of date at once, and both of them cost real
   * accuracy rather than just looking wrong. What the cursor is hovering
   * remembers the state it had when it was hovered, so marking a word known
   * through the popup and then pressing 3 on the same word counted it twice.
   * And the popup can list the same word more than once, since two separate
   * dictionary entries can share a spelling, こと is both a particle and a
   * noun, each with its own tick, each believing the word is still unknown.
   *
   * Telling the bar about a change it has already counted is the bug in
   * both cases, so every button holding this word is corrected here, in the
   * one place a change actually goes through, rather than each of them
   * trying to keep up on its own.
   */
  function syncState(word, state) {
    if (word === hoverWord) hoverState = state;
    if (!ui) return;
    for (const button of ui.card.querySelectorAll('.know, .ignore')) {
      if (button.word !== word || !button.hit || !button.repaint) continue;
      button.hit.known = state === 'known';
      button.hit.ignored = state === 'ignored';
      button.repaint();
    }
  }

  window.addEventListener('mousemove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    scheduleScan();
  }, true);

  /**
   * A click on a plain word looks it up exactly as Shift would, without
   * needing Shift held down first. Links, buttons, form fields and anything
   * already inside the popup are left alone, this only ever takes over a
   * click that would otherwise have done nothing.
   */
  window.addEventListener('click', (e) => {
    if (!isCurrent() || insidePopup(e)) return;
    if (String(window.getSelection())) return;   // ending a drag-select, not a click to look up
    if (isInteractive(e.target)) return;
    const found = textAtPoint(e.clientX, e.clientY);
    if (!found) return;
    // A second click on the word already being shown is a click to be done
    // with it. mousedown has closed it; leaving it closed is the whole job.
    // It has to be that word, not merely some word: clicking a new one while
    // a popup is open should open the new one, and comparing against
    // whatever the cursor happens to be over got that wrong.
    const same = dismissed && found.block === dismissed.block &&
      found.at >= dismissed.from && found.at < dismissed.to;
    dismissed = null;
    if (same) return;
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
  // event's path, the popup lives in a shadow root, so a plain target check
  // would not recognise its own contents.
  // A click always closes the popup on the way down, so by the time the
  // click itself arrives there is nothing left to say what it was showing.
  // That is remembered here, and it is what makes clicking the same word
  // twice close the popup rather than close and immediately reopen it.
  let dismissed = null;
  window.addEventListener('mousedown', (e) => {
    if (insidePopup(e)) return;
    dismissed = ui && ui.host.style.display === 'block' ? shown : null;
    hide();
  }, true);
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
      // looked like a change, reading outward from the cursor gives the
      // same stretch of text for every character of it, so the popup sat on
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

  /**
   * Is the cursor still inside the word the current answer is about?
   *
   * The surrounding text has to match as well as the position, because a
   * subtitle line is replaced under a barely-moving cursor every few
   * seconds. Character seven of the old line and character seven of the new
   * one are the same number and almost never the same word, and without this
   * the answer for the line that just left would sit there looking current.
   */
  function inCurrentWord(found) {
    return found.block === hoverBlock && found.text === hoverSpan &&
      found.at >= hoverFrom && found.at < hoverTo;
  }

  /**
   * What to send to be looked up, and where the answer will be measured from.
   *
   * Ordinarily that is the sixteen characters around the cursor, counted from
   * where they start in the block. On a subtitle it is the whole line with
   * the lines either side of it, because a caption ends where the speaker
   * drew breath and not where a word does: hovering ない at the start of a
   * line has to be able to see the わけじゃ that ended the line before it, or
   * the popup answers with ない, which is not the word on the screen.
   */
  function askFor(found) {
    const plain = { text: found.text, point: found.point, origin: found.base };
    if (typeof found.at !== 'number' || !found.whole) return plain;
    if (typeof LLLSubtitles === 'undefined' || !LLLSubtitles.around) return plain;
    const block = found.block;
    if (!block || !block.closest || !block.closest('[data-lll-subtitle]')) return plain;

    const beside = LLLSubtitles.around(found.whole);
    const before = beside.before || '';
    const after = beside.after || '';
    if (!before && !after) return plain;
    return {
      text: before + found.whole + after,
      point: before.length + found.at,
      origin: -before.length
    };
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
    hoverSpan = null;
    hoverWord = null;
    hoverState = 'unknown';
    const token = ++hoverToken;

    const asked = askFor(found);
    let reply;
    try {
      reply = await api.runtime.sendMessage({ type: 'lookup', text: asked.text, point: asked.point });
    } catch (err) {
      return;   // background restarting; the next hover will retry
    }
    if (token !== hoverToken || !isCurrent()) return;
    if (!reply || !reply.groups || !reply.groups.length) { clearHover(); return; }

    const top = reply.groups[0];
    hoverWord = top.hits[0].word;
    hoverState = stateOf(top.hits[0]);

    // The word may genuinely have begun before the character the cursor
    // happened to land on, hovering anywhere inside ネカフェ still finds
    // and marks the whole word, not just whatever was directly underneath.
    const answered = asked.origin + (typeof reply.start === 'number' ? reply.start : asked.point);
    // A word that began on the line before this one starts, for marking
    // purposes, at the beginning of this one, and stops where this one does.
    const from = Math.max(0, answered);
    const length = Math.min(top.length - (from - answered), found.whole.length - from);
    hoverBlock = found.block;
    hoverSpan = found.text;
    hoverFrom = from;
    hoverTo = from + length;

    const start = length > 0 ? locateInPieces(found.pieces, from) : null;
    if (start) paintHover(start.node, start.offset, length);
  }

  function clearHover() {
    hoverBlock = null;
    hoverSpan = null;
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
   * same technique the unknown-word colouring uses, a Range and the CSS
   * Custom Highlight API, rather than wrapping anything in a <span>, so
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
      // out, the next hover over it tries again.
    }
  }

  /**
   * Where a match of `length` characters starting at (node, offset) actually
   * ends, which is not always the same text node it started in, 図書館 is
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
   * The word under the cursor, not just the character.
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
      // The whole of what this block says, for the times when sixteen
      // characters either side of the cursor is not enough to know what a
      // word is.
      whole: block.text,
      // Where the cursor is in the block's own terms, and which block that
      // is, so hovering can tell "still the same word" from "the next word
      // along" without asking the dictionary again.
      block: block.block, at
    };
  }

  /**
   * Turn a caret position into the character actually being pointed at.
   *
   * The browser gives us a caret position, a gap between two characters, 
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
   * which node. Sites break sentences across `<span>`s constantly. YouTube's
   * captions are one span per line, ruby furigana is several per word, so a
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
   * back to the nearest full stop on either side. A subtitle line is kept
   * whole instead, full stops and all.
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
    if (block.closest && block.closest('[data-lll-subtitle]')) {
      // A subtitle is one thing said, and the whole of it is the context
      // worth keeping. Cutting it at the nearest full stop is right for an
      // article, where the paragraph around a sentence is somebody else's
      // argument, and wrong here: the line is already short, it was written
      // as a unit, and half of it on a card is half of what was said.
      start = 0;
      end = text.length;
    } else {
      while (start > 0 && !SENTENCE_END.test(text[start - 1])) start--;
      while (end < text.length && !SENTENCE_END.test(text[end])) end++;
      if (end < text.length) end++;        // keep the full stop itself
    }

    const slice = text.slice(start, end);
    const lead = slice.length - slice.trimStart().length;
    return {
      text: slice.trim().slice(0, 300), index: index - start - lead,
      before: sentenceBefore(block, text, start),
      after: sentenceAfter(block, text, end)
    };
  }

  /**
   * What was said just before this, and just after it.
   *
   * Optional on a card, and off unless a field asks for it. One line of a
   * conversation on its own can be genuinely ambiguous, これはちょっと…
   * means nothing without the question it answers, and a card you cannot
   * read is a card you will fail for the wrong reason.
   *
   * A subtitle has no sentences either side of it inside its own block,
   * the block is the line, so the lines either side come from the
   * transcript. Anywhere else they are the sentences either side within
   * the same paragraph, and not the paragraph before: the sentence before
   * a paragraph is somebody changing the subject.
   */
  function sentenceBefore(block, text, start) {
    if (isSubtitle(block)) return besideLine(block, text).before;
    if (start <= 0) return '';
    let from = start - 1;
    while (from > 0 && !SENTENCE_END.test(text[from - 1])) from--;
    return tidy(text.slice(from, start));
  }

  function sentenceAfter(block, text, end) {
    if (isSubtitle(block)) return besideLine(block, text).after;
    if (end >= text.length) return '';
    let to = end;
    while (to < text.length && !SENTENCE_END.test(text[to])) to++;
    if (to < text.length) to++;
    return tidy(text.slice(end, to));
  }

  function isSubtitle(block) {
    return !!(block && block.closest && block.closest('[data-lll-subtitle]'));
  }

  function besideLine(block, text) {
    if (typeof LLLSubtitles === 'undefined' || !LLLSubtitles.around) {
      return { before: '', after: '' };
    }
    const beside = LLLSubtitles.around(text) || { before: '', after: '' };
    return { before: tidy(beside.before || ''), after: tidy(beside.after || '') };
  }

  function tidy(text) {
    return String(text).trim().slice(0, 300);
  }

  /** The sentence with the looked-up word wrapped in bold, ready for a card. */
  /**
   * The sentence with whichever neighbours were asked for folded into it.
   *
   * Joined with nothing between them, which is how Japanese is written and
   * also what a caption cut in half actually needs: the line before ends
   * mid-word about as often as not.
   */
  function widen(sentence, wanted) {
    const lead = wanted.before ? (sentence.before || '') : '';
    const trail = wanted.after ? (sentence.after || '') : '';
    if (!lead && !trail) return sentence;
    return {
      text: lead + sentence.text + trail,
      index: sentence.index + lead.length
    };
  }

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

    // A page that replaces its own text can say so, and the reader does
    // every time it turns to a new chapter. Watching every page for changes
    // instead would mean an observer on the whole document of every site
    // open in the browser, to catch a case that almost none of them have.
    document.addEventListener('lll-reread', () => { lastTranscript = ''; readPage(); });
    await waitForDictionary();
    setTimeout(readPage, 1500);   // let the page finish putting itself together
    watchAddress();

    // Subtitles arrive well after the page does, and replace it as the thing
    // worth measuring the moment they do.
    if (typeof LLLSubtitles !== 'undefined') {
      let seen = -1;
      let last = 0;
      setInterval(() => {
        const now = LLLSubtitles.count();
        if (!now || now === seen) return;
        // Lines arrive one at a time, and a whole transcript takes real
        // work to read. Doing it again for every line kept the background
        // busy enough that hovering a subtitle waited half a second for an
        // answer, and moved the number by a fraction of a percent.
        if (Date.now() - last < 20000) return;
        seen = now;
        last = Date.now();
        readPage({ scoreOnly: true });
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
   * screen, the point of the score is to say what is coming, and the page
   * around the player is comments and menus, not the thing being watched. The
   * marking still goes on the page, because that is where the words are.
   *
   * These are two separate questions asked in the same breath, not one
   * question depending on the other. They used to share a single try block,
   * which meant a stumble in the colouring, the page not being fully settled
   * yet, a rectangle the browser refused to measure, aborted the score
   * calculation too, before the score had even been asked for. The bar would
   * sit on "…" until the next unrelated reason to read the page came along,
   * which is exactly the "showed nothing, then later showed 72%" pattern:
   * both numbers were being computed correctly, but only one of the two ever
   * got the chance.
   */
  async function readPage(options) {
    if (readingPage || !isCurrent()) return;
    readingPage = true;
    let scored = false;
    reading = true;

    // Wrapped so that anything unexpected still lets go of the flag. Left
    // stuck true, this page would never read itself again for as long as it
    // stayed open, and nothing would say why.
    try {
      LLLBar.busy('Reading this page…');
      const transcript = typeof LLLSubtitles !== 'undefined' ? LLLSubtitles.allText() : '';

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

      // More of a video's transcript arriving changes the number and
      // nothing else. The page around the player is the page it already was.
      if (typeof LLLHighlight !== 'undefined' && !(options && options.scoreOnly)) {
        try {
          const score = await LLLHighlight.read({ nearby: !!transcript });
          if (!transcript && score && !scored) { LLLBar.show(score); scored = true; }
        } catch (err) {
          console.warn('LLL: could not colour this page:', err && err.message);
        }
      }
    } finally {
      // Nothing to say about this page: no Japanese on it, or none that could
      // be read. Saying so is what stops an English page keeping a handle in
      // the corner that reads "still working on it" for ever.
      if (!scored) LLLBar.quiet();
      readingPage = false;
      reading = false;
    }
  }

  /**
   * Read the page again when it becomes a different page.
   *
   * A site that never reloads still changes what it says. Netflix is one
   * page from the moment you open it: its home page fills itself in some
   * seconds after loading, and going from there to an episode and from one
   * episode to the next never loads anything. LLL read once, a second and a
   * half in, found an empty shell, said there was no Japanese here and never
   * looked again, which is why the handle was missing on a page plainly full
   * of it. YouTube is the same shape.
   *
   * The address is the signal, plus one later look on the way in for a page
   * that fills itself in without changing address.
   */
  function watchAddress() {
    let seen = location.href;
    setTimeout(() => { lastTranscript = ''; readPage(); }, 5000);
    setInterval(() => {
      if (location.href === seen) return;
      seen = location.href;
      lastTranscript = '';
      // A moment for the new page to put something on the screen. Reading
      // the instant the address changes reads the page being left.
      setTimeout(readPage, 1200);
    }, 1000);
  }

  // How far through the page the background script has got. It says so as
  // it goes; without this the handle reads "Reading this page…" for several
  // seconds together and there is no telling it from a page that has hung.
  let reading = false;
  if (api.runtime.onMessage) {
    api.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== 'reading' || !reading) return;
      LLLBar.busy('Reading this page…', message.done / message.total);
    });
  }

  // -------------------------------------------------------------------------
  // Asking the background script
  // -------------------------------------------------------------------------

  async function lookup(text, at, where) {
    // Captured now rather than when "+" is clicked: on a page whose text keeps
    // changing, subtitles, above all, the sentence may be gone by then. This
    // is only ever provisional when `where.point` is set: the real word may
    // turn out to start earlier than wherever the cursor actually landed
    // inside it, and the sentence context has to move with it or the bold
    // in an exported card would land in the wrong place.
    context = where ? sentenceAt(where.node, where.offset) : null;
    // The popup asks with the lines either side of a subtitle, exactly as
    // plain hovering does. This was the one place still reading a caption
    // line on its own, which is why hovering わけじゃない opened a popup
    // about ない: the わけじゃ was at the end of the line before.
    const asked = where && where.text === text
      ? askFor(where)
      : { text: text, point: where && typeof where.point === 'number' ? where.point : undefined,
          origin: where ? where.base : 0 };
    const token = ++queryToken;
    let reply;
    try {
      reply = await api.runtime.sendMessage({
        type: 'lookup', text: asked.text, point: asked.point
      });
    } catch (err) {
      return;   // background restarting; the next hover will retry
    }
    if (token !== queryToken || !reply) return;

    // Put the sentence context on the word itself. The node above is only
    // where the sixteen characters sent to be looked up begin, which is up to
    // sixteen characters before the word and was never the right place: a card
    // mined from 友達と図書館で本を読んでいました came back with 友達と図書館で
    // in bold instead of 読んでいました. This used to run only when the word
    // began somewhere other than the pointer, which is a different question
    // and true far less often.
    if (where && where.pieces && typeof reply.start === 'number') {
      const loc = locateInPieces(where.pieces, Math.max(0, asked.origin + reply.start));
      if (loc) context = sentenceAt(loc.node, loc.offset);
    }

    // Whatever this turned out to be is now the word in play, whether it was
    // reached by hovering, by clicking or by holding Shift. Recording it here
    // rather than only in hoverScan is what lets Shift-panning tell "still
    // the same word" from "the next one along", and what lets 3 and 4 act on
    // a word the popup was opened on by a click.
    const top = reply.groups && reply.groups[0];
    if (where && where.pieces && top) {
      // A word that began on the line before this one is marked from the
      // start of this one, and stops where this one does.
      const answered = asked.origin +
        (typeof reply.start === 'number' ? reply.start : asked.point);
      const from = Math.max(0, answered);
      const reach = where.whole
        ? Math.min(top.length - (from - answered), where.whole.length - from)
        : top.length;
      hoverBlock = where.block;
      hoverSpan = where.text;
      hoverFrom = from;
      hoverTo = from + reach;
      hoverWord = top.hits[0].word;
      hoverState = stateOf(top.hits[0]);
      // Which word the popup is about to be showing, which is not the same
      // question as which word the cursor is over: the mouse moves on and
      // the popup stays put.
      shown = { block: where.block, from: from, to: from + reach };
    }

    if (reply.status.state === 'loading') {
      showMessage(`Building dictionary… ${Math.round(reply.status.progress * 100)}%`, at);
    } else if (reply.status.state === 'error') {
      showMessage('Dictionary failed to load, see the extension console.', at);
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
    // Clicks inside must not reach the page, some sites treat any click as
    // "close the lightbox" and would yank the text out from under the popup.
    card.addEventListener('mousedown', (e) => e.stopPropagation());

    root.append(style, card);
    (document.body || document.documentElement).appendChild(host);
    ui = { host, card };
    watchSize(card);
    return ui;
  }

  function hide() {
    if (ui) ui.host.style.display = 'none';
    shown = null;
  }

  // The word the popup is showing, while it is showing one.
  let shown = null;

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
        reflow();
      });
      card.append(toggle, rest);
    }

    const beside = contextRow();
    if (beside) card.appendChild(beside);
    place(at);
  }

  /**
   * What was said either side, offered for this card and no other.
   *
   * Usually a line on its own is the right amount to put on a card, and
   * more is noise you have to read every time it comes up. Sometimes it is
   * not: これはちょっと… means nothing without the question it answers, and
   * a card you cannot read is a card you fail for the wrong reason. Which
   * of the two it is can only be told by looking at the line, so the two
   * neighbours are shown, and clicking one folds it into the sentence for
   * this card only. Nothing is remembered; the next word starts clean.
   *
   * The same idea as picking a single sense, and the same behaviour: what
   * you clicked is what you get, and clicking nothing is the ordinary case.
   */
  function contextRow() {
    if (!context) return null;
    const before = context.before || '';
    const after = context.after || '';
    if (!before && !after) return null;

    const row = document.createElement('div');
    row.className = 'context';

    const label = document.createElement('span');
    label.className = 'context-label';
    label.textContent = 'also on the card:';
    row.appendChild(label);

    if (before) row.appendChild(chip('before', '…' + tail(before)));
    if (after) row.appendChild(chip('after', head(after) + '…'));
    return row;
  }

  function chip(which, shown) {
    const el = document.createElement('button');
    el.className = 'context-line';
    el.dataset.side = which;
    el.textContent = shown;
    el.title = which === 'before' ? context.before : context.after;
    el.addEventListener('click', () => {
      el.classList.toggle('chosen');
      reflow();
    });
    return el;
  }

  const CHIP_CHARACTERS = 18;
  function tail(text) { return text.slice(-CHIP_CHARACTERS); }
  function head(text) { return text.slice(0, CHIP_CHARACTERS); }

  /** Which neighbours are wanted, for the card about to be made. */
  function chosenContext() {
    const wanted = { before: false, after: false };
    if (!ui) return wanted;
    for (const el of ui.card.querySelectorAll('.context-line.chosen')) {
        wanted[el.dataset.side] = true;
    }
    return wanted;
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
   * The word gets a line to itself. Everything secondary, how common it is,
   * its pitch, what kind of word it is, goes on one muted line beneath, rather
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
      }).catch((err) => {
        // Whatever went wrong in there, the one thing that must not happen
        // is the button sitting on a dot with nothing said.
        add.textContent = '+';
        add.disabled = false;
        const failed = saying(el, (err && err.message) || 'Something went wrong making the card.');
        failed.className = 'error';
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
      meta.push([hit.band, 'ranked #' + hit.q.toLocaleString('en-US') +
        ' in a corpus of Japanese media']);
    }
    if (typeof hit.pitch === 'number') {
      meta.push(['[' + hit.pitch + ']', hit.pitch === 0
        ? 'flat, the pitch never drops'
        : 'the pitch drops after mora ' + hit.pitch]);
    }
    for (const code of hit.shared || []) meta.push([label(code), tags[code] || code]);
    // Only the part of speech every sense actually has in common goes on the
    // meta line. 勉強 is a transitive suru-verb for one sense and intransitive
    // for another and plain "noun" for a third, showing the first sense's
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

        // Senses picked in a different entry do not carry over, a card is
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
      on: 'Known. Click to unmark, or press 1',
      off: 'Mark as already known (or press 2)'
    },
    ignore: {
      glyph: '⊘',
      on: 'Ignored. Click to stop ignoring it, or press 1',
      off: 'Never mention this word again (or press 3)'
    }
  };

  /**
   * The tick that says "I already know this word", and the ⊘ that says "never
   * mention this one again", a name, a piece of English, something the
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
      // Both buttons for this word, here and anywhere else in the popup, are
      // put right by syncState once the change has gone through.
    }

    function paint() {
      button.classList.toggle('on', on);
      button.title = on ? labels.on : labels.off;
    }

    button.word = hit.word;
    button.hit = hit;
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
   * Duplicates are allowed, one sentence can easily teach three words, and
   * mining the same word again later is not a mistake either, so this never
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
      note.textContent = 'Already in your collection, adding it again too.';
      entryEl.appendChild(note);
      reflow();
    }
  }

  /**
   * Turn one entry into a card. The four pieces go off to the background
   * script, which is the only part that may reach your local Anki; which field
   * each piece lands in is set once in LLL's options.
   */
  /**
   * A line of plain text under an entry, while something is going on.
   *
   * Not called `note`, though that is what it is, because the card being
   * built inside mine() is called that: a `const note` further down the same
   * function put this name out of reach above it, and calling it threw before
   * anything else could happen. The + then sat on a dot for ever, since
   * nobody was listening for the failure.
   */
  function saying(entryEl, text) {
    const said = document.createElement('div');
    said.className = 'note doing';
    said.textContent = text;
    entryEl.appendChild(said);
    reflow();
    // Taking it away changes the size back, so that has to be said too.
    const drop = said.remove.bind(said);
    said.remove = function () { drop(); reflow(); };
    return said;
  }

  async function mine(button, entryEl, { word, reading, entry, surface, senses }) {
    button.disabled = true;
    button.textContent = '·';
    const old = entryEl.querySelector('.error');
    if (old) old.remove();

    // The line's exact timing comes from LLL's own subtitles; the video is sent
    // back over it to record it, so this takes as long as the line does. That
    // wait is the one part of mining that looks like nothing happening, so it
    // says what it is doing: anything that goes wrong afterwards is then
    // plainly afterwards, rather than looking like a card that failed before
    // it was ever recorded.
    const sentence = context ? context.text : '';
    const cue = typeof LLLSubtitles !== 'undefined' ? LLLSubtitles.cueFor(sentence) : null;
    const settings = await api.storage.local.get('ankiConfig').catch(() => ({}));
    let media = {};
    if (typeof LLLVideo !== 'undefined') {
      const doing = cue ? saying(entryEl, 'Recording the line…') : null;
      try {
        media = await LLLVideo.capture(sentence, cue, { lead: (settings.ankiConfig || {}).lead });
      } finally {
        if (doing) doing.remove();
      }
    }

    // Whatever was clicked in the popup is folded in before the word is
    // marked, so the bold still lands on the word rather than a count of
    // characters into a longer line.
    const written = context ? markSentence(widen(context, chosenContext()), surface.length) : '';

    const note = {
      media,
      word,
      reading,
      // The bold marks the word exactly as the page wrote it, inflection and
      // all, while the Target Word field carries the dictionary form.
      sentence: written,
      // Kept so a mapping saved before the two were merged still fills in.
      sentenceMarked: written,
      // Only ever used if a field on your note type asks for them.
      sentenceBefore: context ? escapeHtml(context.before || '') : '',
      sentenceAfter: context ? escapeHtml(context.after || '') : '',
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
      // The tick alone is easy to miss, and a card quietly not being made
      // looks exactly the same as one that was. So it says so, and then
      // takes itself away again rather than leaving the popup taller.
      const said = saying(entryEl, 'Added to Anki.');
      said.className = 'note added';
      setTimeout(function () { said.remove(); }, 2500);
      return;
    }
    button.textContent = '+';
    button.disabled = false;
    const message = document.createElement('div');
    message.className = 'error';
    message.textContent = (reply && reply.error) || 'Could not add the card.';
    entryEl.appendChild(message);
    reflow();
  }

  /**
   * A JMdict tag in words. The codes are compact but opaque, "uk" tells you
   * nothing until someone explains it, and this popup has room to say it.
   */
  function label(code) {
    if (LABELS[code]) return LABELS[code];
    if (code.startsWith('v5')) return 'godan verb';
    const described = tags[code];
    return described ? described.split('(')[0].trim().toLowerCase() : code;
  }

  // Where the popup was last put, and how tall it was when it was put there.
  let placed = null;

  /**
   * Put the popup by the cursor, in whichever direction it fits.
   *
   * Under the cursor if there is room, above it if there is more room there,
   * and never taller than the room it takes: a word in a subtitle sits at the
   * very bottom of the screen, and a popup that hangs off the edge from there
   * cannot be scrolled to, because scrolling the page is what closes it.
   */
  function place(at) {
    const { host, card } = ui;
    host.style.display = 'block';
    host.style.left = '0px';
    host.style.top = '0px';
    card.style.maxHeight = '';           // measured with room to breathe
    const box = card.getBoundingClientRect();
    const margin = 8;
    const gap = 18;

    let left = at.x + gap;
    if (left + box.width > window.innerWidth - margin) {
      left = Math.max(margin, at.x - box.width - gap);
    }

    const below = window.innerHeight - (at.y + gap) - margin;
    const above = at.y - gap - margin;
    let top;
    if (box.height <= below) {
      top = at.y + gap;
    } else if (box.height <= above) {
      top = at.y - gap - box.height;
    } else if (above > below) {
      // Neither side fits, so take the roomier one and let the popup scroll.
      top = margin;
      card.style.maxHeight = above + 'px';
    } else {
      top = at.y + gap;
      card.style.maxHeight = Math.max(80, below) + 'px';
    }

    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    placed = { at: at, height: card.getBoundingClientRect().height };
  }

  /** Put the popup where it fits again, after it has changed size. */
  function reflow() {
    if (!ui || !placed || ui.host.style.display !== 'block') return;
    place(placed.at);
  }

  /**
   * A popup that grows after it has been placed has to be placed again.
   *
   * It grows for several reasons: the note saying a word is already in the
   * collection arrives a moment later, so does the one about recording a
   * line, and opening "other matches" can double its height. Any of those
   * could push the bottom of it off the screen, where it could not be read
   * and could not be scrolled to.
   */
  // Held onto, because an observer nobody keeps a reference to can be
  // collected while it is still watching, and then it simply stops firing.
  let sizeWatch = null;

  function watchSize(card) {
    if (typeof ResizeObserver !== 'function') return;
    sizeWatch = new ResizeObserver(function () {
      if (!ui || ui.host.style.display !== 'block' || !placed) return;
      var now = ui.card.getBoundingClientRect().height;
      if (Math.abs(now - placed.height) < 1) return;
      place(placed.at);
    });
    sizeWatch.observe(card);
  }
})();
