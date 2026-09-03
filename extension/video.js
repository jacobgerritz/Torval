/*
 * LLL — capturing from video
 *
 * Mining a line from a video needs two things a dictionary lookup does not: the
 * frame you were looking at, and the audio of the line being spoken.
 *
 * The frame is easy — draw the video onto a canvas at the moment you press "+".
 *
 * The audio is the awkward one, because by the time you have hovered a word and
 * decided to mine it, the line has already been said. You cannot record the past.
 * So LLL records ahead of you: whenever a subtitle appears it starts recording,
 * and when the subtitle changes it stops and keeps that clip in memory. Pressing
 * "+" hands over a recording that was made before you asked for it.
 *
 * Only the current line and the one before it are kept, and recording only runs
 * at all when a card field is actually pointed at the audio.
 *
 * DRM is a hard limit. Netflix, Prime Video and Disney+ hand the video to the
 * browser's content protection layer, and everything here — canvas and audio
 * alike — comes back empty. That is what the protection is for. Ordinary video
 * elements, YouTube included, are fine.
 */

var LLLVideo = (function () {
  'use strict';

  var MAX_WIDTH = 1280;         // frames are scaled down to this before saving
  var JPEG_QUALITY = 0.82;
  var MAX_CLIP_MS = 20000;      // a subtitle that never changes is not a line

  var enabled = false;
  var video = null;
  var stream = null;
  var recorder = null;
  var recording = null;         // { text, startedAt }
  var finished = [];            // the last couple of completed clips
  var observer = null;
  var lastCaption = '';

  function mimeType() {
    var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < types.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(types[i])) return types[i];
    }
    return '';
  }

  /** Begin watching this page. Safe to call on pages with no video at all. */
  function enable() {
    if (enabled) return;
    enabled = true;
    look();
    // Videos and their subtitles arrive long after the page does, and survive
    // navigation within a single-page site like YouTube, so keep looking.
    setInterval(look, 2000);
  }

  function look() {
    if (!enabled) return;
    var found = biggestVideo();
    if (found !== video) {
      teardown();
      video = found;
    }
    if (video && !observer) watchCaptions();
    pollCaption();
  }

  function biggestVideo() {
    var best = null;
    var bestArea = 0;
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      var v = videos[i];
      var area = v.clientWidth * v.clientHeight;
      if (v.readyState > 0 && area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Following the subtitles
  // -------------------------------------------------------------------------

  /**
   * Where the current subtitle line is. Sites that use a real <track> expose
   * their cues properly; YouTube draws its own captions into the page, so those
   * have to be read off the screen.
   */
  function captionText() {
    if (video && video.textTracks) {
      for (var i = 0; i < video.textTracks.length; i++) {
        var track = video.textTracks[i];
        if (track.mode === 'disabled' || !track.activeCues) continue;
        var parts = [];
        for (var c = 0; c < track.activeCues.length; c++) {
          parts.push(track.activeCues[c].text);
        }
        if (parts.length) return parts.join(' ').replace(/\s+/g, ' ').trim();
      }
    }
    var drawn = document.querySelector('.ytp-caption-window-container, .captions-text');
    return drawn ? drawn.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function watchCaptions() {
    var container = document.querySelector('.ytp-caption-window-container, .captions-text');
    if (!container) return;
    observer = new MutationObserver(pollCaption);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
  }

  function pollCaption() {
    if (!enabled || !video) return;
    var text = captionText();
    if (text === lastCaption) {
      // A line that has been up for an implausibly long time is a stuck caption,
      // not speech; cut it off rather than recording minutes of audio.
      if (recording && Date.now() - recording.startedAt > MAX_CLIP_MS) stopRecording();
      return;
    }
    lastCaption = text;
    stopRecording();
    if (text) startRecording(text);
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  function audioStream() {
    if (stream) return stream;
    if (!video) return null;
    try {
      var capture = video.captureStream ? video.captureStream() : video.mozCaptureStream();
      var tracks = capture.getAudioTracks();
      if (!tracks.length) return null;
      stream = new MediaStream(tracks);
      return stream;
    } catch (err) {
      // Content-protected video refuses to be captured. Nothing to be done.
      return null;
    }
  }

  function startRecording(text) {
    var type = mimeType();
    var source = audioStream();
    if (!type || !source) return;

    var rec;
    try {
      rec = new MediaRecorder(source, { mimeType: type });
    } catch (err) {
      return;
    }

    // Each recorder keeps its own chunks. Sharing them was a real bug: stopping
    // a recorder fires its onstop *later*, and by then the next line had already
    // started and cleared the list — so a finished clip was assembled out of the
    // next clip's fragments, with no file header, and came out unplayable.
    var collected = [];
    var info = { text: text, startedAt: Date.now() };

    rec.ondataavailable = function (e) { if (e.data && e.data.size) collected.push(e.data); };
    rec.onstop = function () {
      if (!collected.length) return;
      finished.unshift({ text: info.text, blob: new Blob(collected, { type: type }) });
      finished = finished.slice(0, 2);
    };

    recorder = rec;
    recording = info;
    // No timeslice: one blob delivered whole at the end, rather than a series of
    // fragments that only mean anything if every one of them survives.
    try { rec.start(); } catch (err) { recorder = null; recording = null; }
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (err) { /* already gone */ }
    }
    recorder = null;
    recording = null;
  }

  function teardown() {
    stopRecording();
    if (observer) { observer.disconnect(); observer = null; }
    stream = null;
    finished = [];
    lastCaption = '';
  }

  // -------------------------------------------------------------------------
  // Handing it over
  // -------------------------------------------------------------------------

  /**
   * The frame and the audio for `sentence`, as far as either can be had.
   * Returns {} when there is no video, or when the video refuses to be read.
   */
  async function capture(sentence) {
    if (!enabled || !video) return {};
    var out = {};

    var frame = grabFrame();
    if (frame) out.image = { filename: name(sentence, 'jpg'), data: frame };

    var clip = await grabAudio(sentence);
    if (clip) out.sentenceAudio = { filename: name(sentence, 'webm'), data: clip };

    return out;
  }

  function grabFrame() {
    if (!video.videoWidth) return null;
    var scale = Math.min(1, MAX_WIDTH / video.videoWidth);
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    try {
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1];
    } catch (err) {
      return null;   // content-protected: the canvas will not give it up
    }
  }

  /**
   * The clip for this line. Prefers one whose subtitle matches the sentence
   * being mined, so pausing, reading, and mining a moment later still gets the
   * right audio rather than whatever is on screen now.
   */
  async function grabAudio(sentence) {
    // Mining a line that is still on screen: stop recording it now, and wait for
    // the file to actually be finished rather than guessing at how long that
    // takes. MediaRecorder hands the blob over on its own schedule.
    if (recording && overlaps(recording.text, sentence)) {
      var wanted = recording.text;
      stopRecording();
      await until(function () {
        return finished.some(function (clip) { return clip.text === wanted; });
      });
    }
    var match = finished.find(function (clip) { return overlaps(clip.text, sentence); });
    var clip = match || finished[0];
    return clip ? blobToBase64(clip.blob) : null;
  }

  function until(done, limit) {
    var deadline = Date.now() + (limit || 800);
    return new Promise(function (resolve) {
      (function poll() {
        if (done() || Date.now() > deadline) return resolve();
        setTimeout(poll, 20);
      })();
    });
  }

  /** Subtitles and page text disagree about spacing and line breaks; ignore both. */
  function overlaps(caption, sentence) {
    if (!caption || !sentence) return false;
    var a = caption.replace(/\s+/g, '');
    var b = sentence.replace(/[\s​]+/g, '').replace(/<[^>]*>/g, '');
    return a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onloadend = function () { resolve(String(reader.result).split(',')[1] || null); };
      reader.onerror = function () { resolve(null); };
      reader.readAsDataURL(blob);
    });
  }

  /** A stable, filesystem-safe name, so re-mining a line reuses its media. */
  function name(sentence, extension) {
    var hash = 0;
    var text = String(sentence || Date.now());
    for (var i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return 'lll-' + (hash >>> 0).toString(36) + '.' + extension;
  }

  return { enable: enable, capture: capture, overlaps: overlaps, name: name };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LLLVideo;
