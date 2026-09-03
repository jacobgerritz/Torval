/*
 * LLL — capturing from video
 *
 * Two things come off the screen when you mine a line: the frame you were
 * looking at, and the line being spoken.
 *
 * The frame is taken the instant you press "+", before anything else moves.
 *
 * The audio is taken by replaying the line. Knowing exactly when the line runs
 * from and to — which is why LLL fetches the subtitles itself — the video is
 * sent back to the start of it, recorded to the end of it, and put back where it
 * was: same moment, same speed, same paused or playing.
 *
 * The line plays out loud while this happens — you hear it the same as the
 * recording captures it, rather than mining blind. It takes as long as the
 * line does, and what comes out is exactly the line, with no guessing about
 * where the speech began.
 *
 * The earlier design recorded continuously in case you might mine something.
 * This one records only what you asked for.
 *
 * DRM is a hard limit. Netflix, Prime Video and Disney+ hand the video to the
 * browser's content protection layer, and both the canvas and the audio come
 * back empty. That is what the protection is for. YouTube is fine.
 */

var LLLVideo = (function () {
  'use strict';

  var MAX_WIDTH = 1280;         // frames are scaled down to this before saving
  var JPEG_QUALITY = 0.82;
  var MAX_CLIP_SECONDS = 20;    // no subtitle line is longer than this
  // Seeking then playing does not start the sound instantly, and a recorder
  // started before it does captures the silence. So playback is resumed a
  // moment early and recording begins once the video has actually reached the
  // line — the run-up is played, not recorded.
  var PREROLL_SECONDS = 0.6;

  var stream = null;
  var streamFor = null;

  function mimeType() {
    var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < types.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(types[i])) return types[i];
    }
    return '';
  }

  function currentVideo() {
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

  /**
   * The video's audio as a stream. Kept between captures: asking an element for
   * its stream repeatedly is wasteful, and on some pages disruptive.
   */
  function audioStream(video) {
    if (stream && streamFor === video) return stream;
    try {
      var capture = video.captureStream ? video.captureStream() : video.mozCaptureStream();
      var tracks = capture.getAudioTracks();
      if (!tracks.length) return null;
      stream = new MediaStream(tracks);
      streamFor = video;
      return stream;
    } catch (err) {
      return null;   // content-protected video refuses to be captured
    }
  }

  // -------------------------------------------------------------------------

  /**
   * The frame and the audio for a line. `cue` carries its start and end in
   * seconds; without one there is no audio, only the frame.
   * Returns {} where there is no video, or where the video refuses to be read.
   */
  async function capture(sentence, cue) {
    var video = currentVideo();
    if (!video) return {};
    var out = {};

    // Before anything moves: the picture you were actually looking at.
    var frame = grabFrame(video);
    if (frame) out.image = { filename: name(sentence, 'jpg'), data: frame };

    if (cue && cue.end > cue.start) {
      var clip = await record(video, cue.start, cue.end);
      if (clip) out.sentenceAudio = { filename: name(sentence, 'webm'), data: await toBase64(clip) };
    }
    return out;
  }

  function grabFrame(video) {
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
   * Replay `start` to `end` and record it, then put the video back exactly as
   * it was — same moment, same speed, same paused or playing.
   *
   * Speed is forced to normal for the duration: a line captured at 1.5x is a
   * line spoken at 1.5x, which is not what you want on a card.
   */
  async function record(video, start, end) {
    var type = mimeType();
    var source = audioStream(video);
    if (!type || !source) return null;

    var wasPaused = video.paused;
    var wasTime = video.currentTime;
    var wasRate = video.playbackRate;
    var length = Math.min(end - start, MAX_CLIP_SECONDS);

    var recorder;
    try {
      recorder = new MediaRecorder(source, { mimeType: type });
    } catch (err) {
      return null;
    }

    var chunks = [];
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    var finished = new Promise(function (resolve) { recorder.onstop = resolve; });

    try {
      // The line plays out loud while this records — that is deliberate, so
      // you can hear what is being captured rather than mining blind.
      video.playbackRate = 1;
      video.currentTime = Math.max(0, start - PREROLL_SECONDS);
      await seeked(video);
      await video.play();

      // Watch the clock rather than trusting a timer: buffering, or a frame
      // dropped, would otherwise cut the line short at either end.
      await until(function () { return video.currentTime >= start; }, 5000);
      recorder.start();
      await until(function () { return video.currentTime >= start + length; },
        length * 1000 + 5000);
      recorder.stop();
      await finished;
    } catch (err) {
      try { recorder.stop(); } catch (ignored) { /* already stopped */ }
      return null;
    } finally {
      restore(video, wasTime, wasRate, wasPaused);
    }

    return chunks.length ? new Blob(chunks, { type: type }) : null;
  }

  function restore(video, time, rate, paused) {
    try {
      video.playbackRate = rate;
      video.currentTime = time;
      if (paused) video.pause(); else video.play();
    } catch (err) { /* the page took the video away mid-capture */ }
  }

  function seeked(video) {
    return new Promise(function (resolve) {
      var done = function () { video.removeEventListener('seeked', done); resolve(); };
      video.addEventListener('seeked', done);
      setTimeout(done, 3000);
    });
  }

  function until(done, limit) {
    var deadline = Date.now() + limit;
    return new Promise(function (resolve) {
      (function poll() {
        if (done() || Date.now() > deadline) return resolve();
        setTimeout(poll, 40);
      })();
    });
  }

  function toBase64(blob) {
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

  return { capture: capture, record: record, currentVideo: currentVideo, name: name };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LLLVideo;
