/*
 * The other end of netflix-page.js.
 *
 * That file runs in the page's own world, where it can see Netflix's player;
 * this one runs in LLL's, where it can see the rest of LLL. The only thing
 * they can pass between them is a message through the window they share, so
 * this catches it and holds onto it until subtitles.js comes looking.
 *
 * It runs at document_start, before anything of Netflix's has begun, because
 * the file arrives whenever the player asks for it and that can easily be
 * before the rest of LLL has loaded. Holding the answer is the whole job.
 */
var LLLNetflix = (function () {
  'use strict';

  var caught = null;

  window.addEventListener('message', function (e) {
    // Only this page, and only this message. Anything can post to a window.
    if (e.source !== window) return;
    var data = e.data;
    if (!data || data.lll !== 'lll-netflix-subtitles') return;
    if (typeof data.vtt !== 'string' || !data.vtt) return;
    caught = { movie: String(data.movie || ''), vtt: data.vtt };
  });

  return {
    /** The subtitle file Netflix's player was last handed, if any. */
    track: function () { return caught; }
  };
})();

// Named on the window as well as declared. LLL's other content scripts and
// this one are separate entries in the manifest, and while the browser gives
// every content script of one extension the same world to live in, one line
// here is cheaper than depending on that.
if (typeof window !== 'undefined') window.LLLNetflix = LLLNetflix;

if (typeof module !== 'undefined' && module.exports) module.exports = LLLNetflix;
