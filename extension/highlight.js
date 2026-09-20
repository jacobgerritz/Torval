/*
 * Torval, colouring the words you do not know
 *
 * The bar at the top says how much of a page you understand. This says which
 * parts you do not: every word not in your known list gets marked where it
 * stands.
 *
 * Nothing on the page is altered to do it. The obvious way to colour a word is
 * to wrap it in a <span>, and that is how this kind of thing has always been
 * done, but a page's own scripts own that DOM, and quietly inserting
 * thousands of elements into it breaks sites in ways that are miserable to
 * track down: React throws its hands up and re-renders, `:first-child` rules
 * start matching something else, and a click handler bound to a node that no
 * longer exists silently stops working.
 *
 * The browser has a way to paint text without owning it. A Range describes a
 * stretch of characters without being part of the document; a Highlight is a
 * set of them; and `::highlight()` styles the lot. The page's DOM is never
 * touched, only one <style> element is added, so there is nothing for a
 * site to trip over, and turning the colouring off is one line rather than an
 * unpicking job. Firefox has had this since version 140; where it is missing,
 * everything else in Torval carries on and only the colouring is skipped.
 */

var TorvalHighlight = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;

  // Two registrations for the page, two for the line, rather than one of
  // each. The page is read once and stays put; a video's subtitle line is
  // replaced every few seconds, and re-reading the whole of YouTube each
  // time a line changes would be absurd when the line itself is thirty
  // characters. Each pair (A/B) shares the exact same colour, colour
  // already means something else here, known against unknown, and giving two
  // unknown words two different colours would look like a second, unrelated
  // distinction. What alternates instead is the underline itself, solid
  // against dashed, so that two unknown words sitting right against each
  // other, no space, no punctuation, nothing marking where one ends and the
  // next begins, which is ordinary in Japanese, still show a visible seam,
  // without ever suggesting one of them is a different kind of thing.
  var PAGE_A = 'torval-unknown';
  var PAGE_B = 'torval-unknown-alt';
  var LINE_A = 'torval-unknown-line';
  var LINE_B = 'torval-unknown-line-alt';

  var MAX_TEXT = 100000;    // characters read from one page
  var MAX_RANGES = 20000;   // marks painted at once, so a pathological page cannot hang
  var SETTLE = 350;         // how long after scrolling stops before reading again

  // Ruby readings are furigana, not words; form controls and script tags are
  // not prose. The same places a hover refuses to look are the places not to
  // mark either.
  var SKIP_TAGS = { RT: 1, RP: 1, SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SELECT: 1, TEXTAREA: 1, OPTION: 1 };
  var INLINE = {
    inline: 1, 'inline-block': 1, 'inline-flex': 1, contents: 1,
    ruby: 1, 'ruby-base': 1, 'ruby-text': 1
  };

  var started = false;
  var pageRanges = new Map();   // word -> {group, range}[] on the page itself
  var lineRanges = new Map();   // word -> {group, range}[] in the subtitle line showing now
  var unknown = new Set();      // every word seen so far that is not known
  var lastLine = null;
  var lineOverlay = null;   // the subtitle box, once it exists
  var nearby = false;       // was the last read only of what was on screen
  var lastRead = '';        // and what it said, so as not to read it again
  var rereading = null;

  function supported() {
    return typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
  }

  /**
   * Get ready to colour. Answers whether it can: an older Firefox has no way
   * to paint text without rewriting the page, and rewriting the page is not
   * something to fall back on quietly. Where it can, it always does, this
   * used to be optional, but a mark you can switch off is a mark you end up
   * never seeing at the moment you most needed it.
   */
  async function start() {
    if (started) return supported();
    started = true;
    if (!supported()) {
      console.log('Torval: this Firefox cannot colour words without rewriting the page ' +
        '(needs Firefox 140 or newer), everything else still works.');
      return false;
    }
    ensureStyle();
    watchLine();
    watchScrolling();
    return true;
  }

  /**
   * Colour what you scrolled to, on a page being read a screen at a time.
   *
   * Only ever after scrolling has stopped, and only when what is on screen
   * has actually changed: a page of comments moves a long way under a
   * flick of the wheel, and reading at every step of it would be the very
   * thing this was written to avoid.
   */
  function watchScrolling() {
    window.addEventListener('scroll', function () {
      if (!nearby) return;
      clearTimeout(rereading);
      rereading = setTimeout(function () {
        if (!nearby) return;
        if (gather(document.body, true, true).text === lastRead) return;
        read({ nearby: true });
      }, SETTLE);
    }, { passive: true, capture: true });
  }

  /**
   * Read the page and colour it.
   *
   * `options.nearby` reads only what is on screen, and a screen either
   * side of it. That is for a page whose score comes from somewhere else,
   * a video measured against its transcript, where the text around the
   * player is comments and menus rather than the thing being watched. On
   * a video the difference is not small: a YouTube page with its comments
   * open runs to tens of thousands of characters of Japanese, all of it
   * read, none of it visible, and reading it took long enough to notice.
   * Nothing is lost by leaving it, because the only reason to read a page
   * whose score is already known is to mark the words on it, and a mark
   * you cannot see is not doing anything. Scrolling reads what you
   * scrolled to.
   */
  async function read(options) {
    if (!supported()) return null;
    nearby = !!(options && options.nearby);
    var found = gather(document.body, true, nearby);
    if (!found.text) return null;
    lastRead = found.text;

    var reply;
    try {
      var beside = typeof TorvalSubtitles !== 'undefined' && TorvalSubtitles.around
        ? TorvalSubtitles.around(found.text)
        : { before: '', after: '' };
      reply = await api.runtime.sendMessage({
        type: 'wordPlaces', text: found.text, before: beside.before, after: beside.after
      });
    } catch (err) {
      return null;
    }
    if (!reply || !reply.ok) return null;
    // Not a page in the language being read: an English article, with a
    // handful of words that happen to spell Italian ones. Nothing is marked
    // and nothing is scored, and whatever was marked before comes off, since
    // a single-page app can navigate from a page in the language to one that
    // is not without ever reloading.
    if (reply.result.skipped) {
      pageRanges = new Map();
      apply();
      return null;
    }

    pageRanges = build(found, reply.result);
    apply();
    return {
      total: reply.result.total, known: reply.result.known,
      counts: reply.result.counts, model: reply.result.model
    };
  }

  /**
   * A word was just ticked, unticked or set aside in the popup. Every place
   * it appears changes at once, and without reading anything again, which is
   * the point of having kept where each word was rather than only how many
   * there were.
   *
   * Only one question is asked here: should this word be marked. Knowing it
   * and never wanting to hear about it are different states elsewhere, but on
   * the page they look the same, which is no mark at all.
   */
  /** Take every mark off the page, for when Torval is switched off. */
  function clear() {
    if (!supported()) return;
    for (var name of [PAGE_A, PAGE_B, LINE_A, LINE_B]) CSS.highlights.delete(name);
  }

  function setMarked(word, shouldMark) {
    if (shouldMark) unknown.add(word); else unknown.delete(word);
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
   * sites split words across elements constantly, 図書館 is routinely
   * <span>図書</span><span>館</span>, and a word broken by a separator is a
   * word the dictionary will not find. Across a block boundary a newline goes
   * in instead, so the end of one paragraph cannot form a word with the start
   * of the next.
   */
  function gather(root, skipSubtitle, nearOnly) {
    var reach = nearOnly ? (window.innerHeight || 800) : 0;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent || SKIP_TAGS[parent.tagName]) return NodeFilter.FILTER_REJECT;
        // The cheapest test first: most nodes on most pages hold none of the
        // active language's word characters at all, and nothing further is
        // worth asking about those. Read fresh each call, not cached, so a
        // language switch takes effect on the very next gather().
        if (!TorvalLang.profile().charClass.test(node.data)) return NodeFilter.FILTER_REJECT;
        // Torval's own subtitle line is painted on its own, every time it
        // changes; leaving it in here as well would mark it twice.
        if (skipSubtitle && parent.closest('[data-torval-subtitle]')) return NodeFilter.FILTER_REJECT;
        if (parent.checkVisibility && !parent.checkVisibility()) return NodeFilter.FILTER_REJECT;
        if (nearOnly && !nearScreen(parent, reach)) return NodeFilter.FILTER_REJECT;
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

  /** Is this near enough to the screen to be worth colouring? */
  function nearScreen(el, reach) {
    var box = el.getBoundingClientRect();
    if (!box.width && !box.height) return false;
    return box.bottom > -reach && box.top < (window.innerHeight || 0) + reach;
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
      if (result.unmarked.indexOf(word) === -1) unknown.add(word); else unknown.delete(word);

      // start, length, group, see the comment on wordPlaces in background.js
      // for why the alternating group travels with the position rather than
      // being decided here.
      var triples = result.places[word];
      var marks = [];
      for (var i = 0; i + 2 < triples.length && total < MAX_RANGES; i += 3) {
        var range = rangeFor(found.pieces, triples[i], triples[i + 1]);
        if (range) { marks.push({ group: triples[i + 2], range: range }); total++; }
      }
      if (marks.length) byWord.set(word, marks);
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
    paint(PAGE_A, PAGE_B, pageRanges);
    paint(LINE_A, LINE_B, lineRanges);
  }

  function paint(nameA, nameB, byWord) {
    try {
      var a = new Highlight();
      var b = new Highlight();
      byWord.forEach(function (marks, word) {
        if (!unknown.has(word)) return;
        for (var i = 0; i < marks.length; i++) (marks[i].group ? b : a).add(marks[i].range);
      });
      if (a.size) CSS.highlights.set(nameA, a); else CSS.highlights.delete(nameA);
      if (b.size) CSS.highlights.set(nameB, b); else CSS.highlights.delete(nameB);
    } catch (err) {
      console.warn('Torval: could not colour the words:', err && err.message);
    }
  }

  /**
   * Only a handful of properties may be used on a highlight, colour,
   * background, and the text decorations, which is enough. A soft underline
   * with the faintest wash behind it reads on a white page and a black one
   * alike, and stays legible when most of a paragraph is marked, which is what
   * a page above your level looks like.
   *
   * A and B are the exact same colour. What tells two touching unknown words
   * apart is the line itself, solid against dashed, the way a page break is
   * shown without needing a second ink. Colour already carries a meaning
   * here, known against unknown, and spending it twice, once for that and
   * once for "which word is this", would read as two different questions
   * being asked when there is only one.
   */
  function ensureStyle() {
    if (document.getElementById('torval-highlight-style')) return;
    var style = document.createElement('style');
    style.id = 'torval-highlight-style';
    style.textContent =
      '::highlight(' + PAGE_A + '),::highlight(' + LINE_A + '){' +
      'background-color:rgba(203,142,74,.16);' +
      'text-decoration:underline;' +
      'text-decoration-style:solid;' +
      'text-decoration-color:rgba(219,163,95,.85);' +
      'text-decoration-thickness:2px;' +
      'text-underline-offset:2px;}' +
      '::highlight(' + PAGE_B + '),::highlight(' + LINE_B + '){' +
      'background-color:rgba(203,142,74,.16);' +
      'text-decoration:underline;' +
      'text-decoration-style:dashed;' +
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
   * place the colouring matters most, and the one place it goes stale within
   * seconds. Watching for the line to change costs one lookup of one element;
   * re-reading it costs whatever thirty characters cost, which is nothing.
   */
  /**
   * React the moment a line changes, rather than finding out up to a whole
   * polling interval later. A poll every few hundred milliseconds sounds
   * fast until it is sitting between a video and the marking of what is
   * being said right now, a colour that lands visibly after the line has
   * already been read is not doing its job. A MutationObserver fires on the
   * same tick the subtitle's own text is written, so the only real delay
   * left is the one round trip to look the line up.
   */
  function watchLine() {
    var observer = null;

    // The overlay is created once, lazily, the first time a line is drawn, 
    // this waits for it to exist and then never has to look again.
    var attach = setInterval(function () {
      var overlay = document.querySelector('[data-torval-subtitle]');
      if (!overlay) return;
      clearInterval(attach);
      lineOverlay = overlay;
      // Going fullscreen moves the player about, and the marks on the line
      // are ranges into text that is no longer where they were made. There
      // is no mutation to notice, so the change of screen is the signal.
      document.addEventListener('fullscreenchange', function () {
        setTimeout(refreshLine, 60);
        setTimeout(refreshLine, 500);
      });
      observer = new MutationObserver(function () { checkLine(overlay); });
      observer.observe(overlay, { characterData: true, childList: true, subtree: true });
      checkLine(overlay);
    }, 500);
  }

  /**
   * Work the subtitle line out again from scratch.
   *
   * Marking a word known or unknown changes what should be coloured, and the
   * line has its own ranges, made when it arrived and only good while the
   * player leaves them alone. Rebuilding them is one short message about one
   * short line, and it is right every time.
   */
  function refreshLine() {
    if (!lineOverlay) return;
    lastLine = null;
    checkLine(lineOverlay);
  }

  /**
   * Are the ranges held for the line still attached to the page?
   *
   * A player that redraws its caption box puts the same words back in a new
   * text node, and ranges into the old one point at nothing: the line looks
   * unmarked and stays that way, since the text has not changed and there
   * was nothing to notice. Marking a word and unmarking it again fixed it,
   * which is how this was found.
   */
  function stillOnThePage() {
    var whole = true;
    lineRanges.forEach(function (marks) {
      for (var i = 0; i < marks.length; i++) {
        // A range whose text was taken out from under it does not become
        // detached, which is the obvious thing to look for and the wrong one:
        // both of its ends slide onto the parent and it collapses to nothing.
        // A mark that covers no characters is a mark that paints none.
        if (marks[i].range.collapsed) whole = false;
      }
    });
    return whole;
  }

  var askingAgain = null;

  /**
   * Ask about this line again in a moment.
   *
   * The first line of a video usually arrives before the dictionary has
   * finished opening, and the answer comes back as a failure. Forgetting
   * that the line was seen is the part that matters: without that, the same
   * text is never asked about again, and the line stays unmarked until the
   * next one replaces it. That is why the first line only ever coloured
   * after pressing A or D, which is what put a different line on screen.
   */
  function askAgain(overlay) {
    lastLine = null;
    if (askingAgain) return;
    askingAgain = setTimeout(function () {
      askingAgain = null;
      checkLine(overlay);
    }, 800);
  }

  async function checkLine(overlay) {
    var text = overlay.textContent;
    if (text === lastLine && stillOnThePage()) return;
    lastLine = text;

    if (!text) { lineRanges = new Map(); apply(); return; }
    var found = gather(overlay, false);
    if (!found.text) { lineRanges = new Map(); apply(); return; }

    // The lines either side, for the same reason the popup asks with them:
    // a caption ends where the speaker drew breath and not where a word does.
    // Without them a line ending 嬉しかっ was read as 嬉し and かっ, and the
    // かっ was marked as a word of its own, while clicking the very same
    // characters answered 嬉しかった. Only the marks that begin inside this
    // line are kept, so a word running over the join is marked as far as the
    // line goes and no further.
    var beside = { before: "", after: "" };
    if (typeof TorvalSubtitles !== 'undefined' && TorvalSubtitles.around) {
      beside = TorvalSubtitles.around(text) || beside;
    }

    var reply;
    try {
      reply = await api.runtime.sendMessage({
        type: 'wordPlaces', text: found.text,
        before: beside.before, after: beside.after,
        line: true
      });
    } catch (err) {
      return askAgain(overlay);
    }
    if (!reply || !reply.ok) return askAgain(overlay);
    // The line moved on while this was being asked, so this answer is about
    // the wrong words. Forgetting the line rather than just dropping the
    // answer, since nothing else will come along to ask about the new one.
    if (overlay.textContent !== text) return askAgain(overlay);
    lineRanges = build(found, reply.result);
    apply();
  }

  return {
    start: start,
    read: read,
    setMarked: setMarked,
    clear: clear,
    refreshLine: refreshLine,
    supported: supported,
    // Exposed for the tests: turning a position in the gathered text back into
    // a place on the page is the part with the arithmetic in it.
    _locate: locate
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalHighlight;
