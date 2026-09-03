/*
 * LLL — colouring the words you do not know
 *
 * The bar at the top says how much of a page you understand. This says which
 * parts you do not: every word not in your known list gets marked where it
 * stands.
 *
 * Nothing on the page is altered to do it. The obvious way to colour a word is
 * to wrap it in a <span>, and that is how this kind of thing has always been
 * done — but a page's own scripts own that DOM, and quietly inserting
 * thousands of elements into it breaks sites in ways that are miserable to
 * track down: React throws its hands up and re-renders, `:first-child` rules
 * start matching something else, and a click handler bound to a node that no
 * longer exists silently stops working.
 *
 * The browser has a way to paint text without owning it. A Range describes a
 * stretch of characters without being part of the document; a Highlight is a
 * set of them; and `::highlight()` styles the lot. The page's DOM is never
 * touched — only one <style> element is added — so there is nothing for a
 * site to trip over, and turning the colouring off is one line rather than an
 * unpicking job. Firefox has had this since version 140; where it is missing,
 * everything else in LLL carries on and only the colouring is skipped.
 */

var LLLHighlight = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;

  // Two registrations rather than one. The page is read once and stays put; a
  // video's subtitle line is replaced every few seconds, and re-reading the
  // whole of YouTube each time a line changes would be absurd when the line
  // itself is thirty characters.
  var PAGE = 'lll-unknown';
  var LINE = 'lll-unknown-line';

  var MAX_TEXT = 100000;    // characters read from one page
  var MAX_RANGES = 20000;   // marks painted at once, so a pathological page cannot hang

  // Ruby readings are furigana, not words; form controls and script tags are
  // not prose. The same places a hover refuses to look are the places not to
  // mark either.
  var SKIP_TAGS = { RT: 1, RP: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SELECT: 1, TEXTAREA: 1, OPTION: 1 };
  var INLINE = {
    inline: 1, 'inline-block': 1, 'inline-flex': 1, contents: 1,
    ruby: 1, 'ruby-base': 1, 'ruby-text': 1
  };

  var on = true;
  var started = false;
  var pageRanges = new Map();   // word -> Range[] on the page itself
  var lineRanges = new Map();   // word -> Range[] in the subtitle line showing now
  var unknown = new Set();      // every word seen so far that is not known
  var lastLine = null;

  function supported() {
    return typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
  }

  /**
   * Get ready to colour. Answers whether it can: an older Firefox has no way
   * to paint text without rewriting the page, and rewriting the page is not
   * something to fall back on quietly.
   */
  async function start() {
    if (started) return supported();
    started = true;
    if (!supported()) {
      console.log('LLL: this Firefox cannot colour words without rewriting the page ' +
        '(needs Firefox 140 or newer) — everything else still works.');
      return false;
    }
    ensureStyle();
    try {
      var stored = await api.storage.local.get('colourUnknown');
      on = stored.colourUnknown !== false;   // on unless turned off
    } catch (err) { /* keep the default */ }
    watchLine();
    return true;
  }

  function isOn() { return on; }

  async function toggle() {
    on = !on;
    try { await api.storage.local.set({ colourUnknown: on }); } catch (err) { /* not fatal */ }
    apply();
    return on;
  }

  /**
   * Read the page and work out what to mark. Answers with the score as well,
   * because this is the same passage the bar is asking about and there is no
   * sense reading a page twice to answer two questions about it.
   *
   * The reading happens whether or not colouring is switched on — the score
   * is wanted either way — and only the painting is conditional.
   */
  async function read() {
    if (!supported()) return null;
    var found = gather(document.body, true);
    if (!found.text) return null;

    var reply;
    try {
      reply = await api.runtime.sendMessage({ type: 'wordPlaces', text: found.text });
    } catch (err) {
      return null;
    }
    if (!reply || !reply.ok) return null;

    pageRanges = build(found, reply.result);
    apply();
    return { total: reply.result.total, known: reply.result.known, counts: reply.result.counts };
  }

  /**
   * A word was just ticked, or unticked, in the popup. Every place it appears
   * changes at once, and without reading anything again — which is the point
   * of having kept where each word was rather than only how many there were.
   */
  function mark(word, isKnown) {
    if (isKnown) unknown.delete(word); else unknown.add(word);
    apply();
  }

  // -------------------------------------------------------------------------
  // Reading the page
  // -------------------------------------------------------------------------

  /**
   * The Japanese on the page as one string, plus where each piece of it came
   * from, so that a position in that string can be turned back into a place on
   * the page.
   *
   * Text inside one block is joined with nothing between the pieces, because
   * sites split words across elements constantly — 図書館 is routinely
   * <span>図書</span><span>館</span>, and a word broken by a separator is a
   * word the dictionary will not find. Across a block boundary a newline goes
   * in instead, so the end of one paragraph cannot form a word with the start
   * of the next.
   */
  function gather(root, skipSubtitle) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent || SKIP_TAGS[parent.tagName]) return NodeFilter.FILTER_REJECT;
        // The cheapest test first: most nodes on most pages hold no Japanese
        // at all, and nothing further is worth asking about those.
        if (!LLLJapanese.test(node.data)) return NodeFilter.FILTER_REJECT;
        // LLL's own subtitle line is painted on its own, every time it
        // changes; leaving it in here as well would mark it twice.
        if (skipSubtitle && parent.closest('[data-lll-subtitle]')) return NodeFilter.FILTER_REJECT;
        if (parent.checkVisibility && !parent.checkVisibility()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    var text = '';
    var pieces = [];
    var block = null;
    var node;
    while ((node = walker.nextNode())) {
      var here = blockOf(node);
      if (pieces.length && here !== block) text += '\n';
      block = here;
      pieces.push({ node: node, start: text.length, end: text.length + node.data.length });
      text += node.data;
      if (text.length >= MAX_TEXT) break;
    }
    return { text: text, pieces: pieces };
  }

  function blockOf(node) {
    var el = node.parentElement;
    while (el && el.parentElement && INLINE[getComputedStyle(el).display]) el = el.parentElement;
    return el || document.body;
  }

  /** Turn the positions the dictionary reported back into places on the page. */
  function build(found, result) {
    var byWord = new Map();
    var total = 0;
    for (var word in result.places) {
      if (!Object.prototype.hasOwnProperty.call(result.places, word)) continue;
      if (result.knownHere.indexOf(word) === -1) unknown.add(word); else unknown.delete(word);

      var pairs = result.places[word];
      var ranges = [];
      for (var i = 0; i + 1 < pairs.length && total < MAX_RANGES; i += 2) {
        var range = rangeFor(found.pieces, pairs[i], pairs[i + 1]);
        if (range) { ranges.push(range); total++; }
      }
      if (ranges.length) byWord.set(word, ranges);
    }
    return byWord;
  }

  function rangeFor(pieces, start, length) {
    // Both ends are looked up as characters that really exist, rather than the
    // end being looked up one past the last one: an offset sitting exactly on
    // a boundary belongs to either of two pieces, and picking the wrong one
    // puts the mark in the wrong place.
    var from = locate(pieces, start);
    var to = locate(pieces, start + length - 1);
    if (!from || !to) return null;
    try {
      var range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset + 1);
      return range;
    } catch (err) {
      return null;   // the page moved the text while this was being worked out
    }
  }

  function locate(pieces, at) {
    var low = 0;
    var high = pieces.length - 1;
    while (low <= high) {
      var mid = (low + high) >> 1;
      var piece = pieces[mid];
      if (at < piece.start) high = mid - 1;
      else if (at >= piece.end) low = mid + 1;
      else return { node: piece.node, offset: at - piece.start };
    }
    return null;   // the position landed on a joint between two blocks
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  function apply() {
    if (!supported()) return;
    paint(PAGE, pageRanges);
    paint(LINE, lineRanges);
  }

  function paint(name, byWord) {
    try {
      if (!on) { CSS.highlights.delete(name); return; }
      var highlight = new Highlight();
      byWord.forEach(function (ranges, word) {
        if (!unknown.has(word)) return;
        for (var i = 0; i < ranges.length; i++) highlight.add(ranges[i]);
      });
      if (highlight.size) CSS.highlights.set(name, highlight);
      else CSS.highlights.delete(name);
    } catch (err) {
      console.warn('LLL: could not colour the words —', err && err.message);
    }
  }

  /**
   * Only a handful of properties may be used on a highlight — colour,
   * background, and the text decorations — which is enough. A soft underline
   * with the faintest wash behind it reads on a white page and a black one
   * alike, and stays legible when most of a paragraph is marked, which is what
   * a page above your level looks like.
   */
  function ensureStyle() {
    if (document.getElementById('lll-highlight-style')) return;
    var style = document.createElement('style');
    style.id = 'lll-highlight-style';
    style.textContent =
      '::highlight(' + PAGE + '),::highlight(' + LINE + '){' +
      'background-color:rgba(203,142,74,.16);' +
      'text-decoration:underline;' +
      'text-decoration-color:rgba(219,163,95,.85);' +
      'text-decoration-thickness:2px;' +
      'text-underline-offset:2px;}';
    (document.head || document.documentElement).appendChild(style);
  }

  // -------------------------------------------------------------------------
  // The line playing right now
  // -------------------------------------------------------------------------

  /**
   * A video's subtitle is the text you are actually reading, so it is the one
   * place the colouring matters most — and the one place it goes stale within
   * seconds. Watching for the line to change costs one lookup of one element;
   * re-reading it costs whatever thirty characters cost, which is nothing.
   */
  function watchLine() {
    setInterval(async function () {
      var overlay = document.querySelector('[data-lll-subtitle]');
      var text = overlay ? overlay.textContent : '';
      if (text === lastLine) return;
      lastLine = text;

      if (!text) { lineRanges = new Map(); apply(); return; }
      var found = gather(overlay, false);
      if (!found.text) { lineRanges = new Map(); apply(); return; }

      var reply;
      try {
        reply = await api.runtime.sendMessage({ type: 'wordPlaces', text: found.text });
      } catch (err) {
        return;
      }
      if (!reply || !reply.ok) return;
      if (overlay.textContent !== text) return;   // the line moved on while this was asked
      lineRanges = build(found, reply.result);
      apply();
    }, 400);
  }

  return {
    start: start,
    read: read,
    mark: mark,
    toggle: toggle,
    isOn: isOn,
    supported: supported,
    // Exposed for the tests: turning a position in the gathered text back into
    // a place on the page is the part with the arithmetic in it.
    _locate: locate
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LLLHighlight;
