/*
 * The other end of netflix-page.js.
 *
 * That file runs in the page's own world, where it can see Netflix's player;
 * this one runs in LLL's, where it can see the rest of LLL. The only thing
 * they can pass between them is a message through the window they share, so
 * this catches what comes back and holds it until subtitles.js asks, and
 * sends the one request that goes the other way, which is A and D asking the
 * player to move.
 *
 * It runs at document_start, before anything of Netflix's has begun, because
 * the subtitle file arrives whenever the player asks for it and that can
 * easily be before the rest of LLL has loaded.
 *
 * It also puts the page script there itself if the browser has not. A content
 * script declared with "world": "MAIN" is the clean way to run code in the
 * page, and it needs Firefox 128; where that did not happen, adding a <script>
 * tag pointing at the same file does the same job. Doing both would run it
 * twice, which is why the file itself refuses a second go.
 */
var LLLNetflix = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;
  var caught = null;
  var ready = false;

  window.addEventListener('message', function (e) {
    // Only this page, and only these messages. Anything can post to a window.
    if (e.source !== window) return;
    var data = e.data;
    if (!data) return;
    if (data.lll === 'lll-netflix-ready') { ready = true; return; }
    if (data.lll !== 'lll-netflix-subtitles') return;
    if (typeof data.vtt !== 'string' || !data.vtt) return;
    caught = { movie: String(data.movie || ''), vtt: data.vtt };
  });

  // If the page script announced itself, there is nothing to do. If it did
  // not, this browser did not honour "world": "MAIN" and it has to be put
  // there the older way. Two seconds is long enough to be sure and short
  // enough to still beat the player asking for its subtitles.
  setTimeout(function () {
    if (ready) return;
    try {
      var tag = document.createElement('script');
      tag.src = api.runtime.getURL('netflix-page.js');
      tag.onload = function () { tag.remove(); };
      (document.head || document.documentElement).appendChild(tag);
      console.log('LLL: this browser did not run LLL’s Netflix helper by itself, ' +
        'so it has been added to the page instead.');
    } catch (err) {
      console.warn('LLL: could not reach Netflix’s player:', err && err.message);
    }
  }, 2000);

  return {
    /** The subtitle file Netflix's player was last handed, if any. */
    track: function () { return caught; },

    /**
     * Ask Netflix's own player to move. Its video element cannot be moved by
     * hand: setting currentTime on it ends the session with error F7375.
     */
    seek: function (seconds) {
      window.postMessage({ lll: 'lll-netflix-seek', seconds: seconds }, '*');
    }
  };
})();

// Named on the window as well as declared. LLL's other content scripts and
// this one are separate entries in the manifest, and while the browser gives
// every content script of one extension the same world to live in, one line
// here is cheaper than depending on that.
if (typeof window !== 'undefined') window.LLLNetflix = LLLNetflix;

if (typeof module !== 'undefined' && module.exports) module.exports = LLLNetflix;
