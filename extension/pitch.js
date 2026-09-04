/*
 * LLL, pitch accent
 *
 * Japanese words carry a pitch pattern, and the whole pattern follows from one
 * number: where the pitch drops. 0 means it never does.
 *
 *   食べる  たべる  2   →  た low, べ high, る low       (drops after the 2nd mora)
 *   日本語  にほんご 0   →  に low, ほんご high, stays up  (never drops)
 *   箸     はし    1   →  は high, し low               (drops after the 1st)
 *   橋     はし    2   →  は low, し high, then drops on whatever follows
 *
 * Note the last two: 箸 and 橋 are both はし and differ only in pitch. That is
 * also why a reading alone is not enough to look one up.
 *
 * This draws the standard diagram, a dot per mora, high or low, joined by a
 * line, as an SVG that goes straight onto the card. The trailing hollow dot is
 * the following particle, which is what distinguishes 橋 (drops after) from
 * 日本語 (stays up).
 */

var LLLPitch = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;
  var data = null;

  // Small kana attach to the mora before them: き + ょ is one mora, not two.
  // ー, っ and ん stand alone, which this gets right by leaving them out.
  var SMALL = 'ゃゅょぁぃぅぇぉャュョァィゥェォ';

  function load() {
    if (!data) {
      data = fetch(api.runtime.getURL('data/pitch.json'))
        .then(function (r) { return r.json(); })
        .catch(function () { return { byWord: {}, byReading: {} }; });
    }
    return data;
  }

  /** Where the pitch drops, or null if we do not know for this word. */
  async function accentFor(word, reading) {
    var table = await load();
    var found = (reading && table.byWord[word + '\t' + reading]) ||
      table.byWord[word + '\t' + word] ||
      (reading && table.byReading[reading]) ||
      table.byReading[word];
    return found && found.length ? found[0] : null;
  }

  function moras(kana) {
    var out = [];
    for (var i = 0; i < kana.length; i++) {
      var ch = kana.charAt(i);
      if (out.length && SMALL.indexOf(ch) !== -1) out[out.length - 1] += ch;
      else out.push(ch);
    }
    return out;
  }

  /**
   * Which moras are high. Index 0 is the first mora; the extra slot at the end
   * is the particle that would follow the word.
   */
  function heights(count, accent) {
    var high = [];
    for (var i = 0; i <= count; i++) {
      if (accent === 0) high.push(i > 0);            // low, then up and stays up
      else if (accent === 1) high.push(i === 0);     // high, then down at once
      else high.push(i > 0 && i < accent);           // up, down after the accent
    }
    return high;
  }

  /**
   * The diagram, as SVG. Uses currentColor throughout so it follows whatever
   * the card's styling is, night mode included.
   */
  function svg(reading, accent) {
    var m = moras(reading);
    if (!m.length || accent === null || accent === undefined) return '';

    var step = 22, high = 12, low = 30, pad = 11, height = 52;
    var high_ = heights(m.length, accent);
    var x = function (i) { return pad + i * step; };
    var y = function (i) { return high_[i] ? high : low; };

    var points = [];
    for (var i = 0; i < m.length; i++) points.push(x(i) + ',' + y(i));

    // Stop the line at the edge of the final dot rather than at its centre.
    // That dot is drawn hollow, so a line running to the middle of it shows
    // through and spoils the ring.
    var last = m.length;
    var dx = x(last) - x(last - 1);
    var dy = y(last) - y(last - 1);
    var span = Math.sqrt(dx * dx + dy * dy) || 1;
    var trim = 4.75;                       // the dot's radius plus its stroke
    points.push(round(x(last) - dx / span * trim) + ',' + round(y(last) - dy / span * trim));

    var dots = '';
    for (var j = 0; j <= m.length; j++) {
      // The last dot is the following particle, drawn hollow: it is not part of
      // the word, it just shows whether the pitch survives past the end of it.
      var hollow = j === m.length;
      dots += '<circle cx="' + x(j) + '" cy="' + y(j) + '" r="4"' +
        (hollow ? ' fill="none" stroke="currentColor" stroke-width="1.5"' : ' fill="currentColor"') +
        '/>';
    }

    var labels = '';
    for (var k = 0; k < m.length; k++) {
      labels += '<text x="' + x(k) + '" y="' + (height - 4) +
        '" text-anchor="middle" font-size="13" fill="currentColor">' + escapeXml(m[k]) + '</text>';
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + (x(m.length) + pad) +
      '" height="' + height + '" viewBox="0 0 ' + (x(m.length) + pad) + ' ' + height + '">' +
      '<polyline points="' + points.join(' ') +
      '" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
      dots + labels + '</svg>';
  }

  /** The finished field contents for a word, or '' when the accent is unknown. */
  async function graphFor(word, reading) {
    var accent = await accentFor(word, reading);
    if (accent === null) return '';
    return svg(reading || word, accent);
  }

  function round(n) { return Math.round(n * 100) / 100; }

  function escapeXml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return {
    accentFor: accentFor,
    graphFor: graphFor,
    moras: moras,
    heights: heights,
    svg: svg,
    _setData: function (d) { data = Promise.resolve(d); }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LLLPitch;
