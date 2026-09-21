/*
 * Torval, capturing from video
 *
 * Two things come off the screen when you mine a line: the frame you were
 * looking at, and the line being spoken.
 *
 * The frame is taken the instant you press "+", before anything else moves.
 *
 * The audio is taken by replaying the line. Knowing exactly when the line runs
 * from and to, which is why Torval fetches the subtitles itself, the video is
 * sent back to the start of it, recorded to the end of it, and put back where it
 * was: same moment, same speed, same paused or playing.
 *
 * The line plays out loud while this happens, you hear it the same as the
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

var TorvalVideo = (function () {
  'use strict';

  var MAX_WIDTH = 1280;         // frames are scaled down to this before saving
  var JPEG_QUALITY = 0.82;
  var MAX_CLIP_SECONDS = 20;    // no subtitle line is longer than this
  // And none worth mining is shorter than this. A caption that revises
  // itself is filed as several cues in a row, and although subtitles.js now
  // hands over the whole line rather than one revision of it, a clip of half
  // a second is useless enough to be worth refusing to make twice.
  var MIN_CLIP_SECONDS = 1.2;
  // Seeking then playing does not start the sound instantly, and a recorder
  // started before it does captures the silence. So playback is resumed a
  // moment early and recording begins once the video has actually reached the
  // line, the run-up is played, not recorded.
  var PREROLL_SECONDS = 0.6;

  // How much to record from before the line starts, on top of whatever the
  // recorder swallows anyway. Subtitle timings are written to be read rather
  // than to be cut on, so a little is wanted, but the warm-up below already
  // supplies most of it and asking for much more only puts the end of the
  // previous line on the card. The settings page can change it.
  var LEAD_SECONDS = 0.1;
  var MAX_LEAD_SECONDS = 3;

  // A recorder does not start recording when it is told to. Measured against
  // the test video, whose pitch changes on every whole second: asked for the
  // two seconds from 4s to 6s, the clip that came back had only 0.6s of the
  // first tone in it, so the first 0.4s had gone. A lead-in of a quarter of a
  // second was swallowed whole and the line still opened clipped, which is
  // why padding alone never fixed this.
  //
  // So the recorder is started early and left to lose what it loses. What
  // survives begins about where it was asked to, give or take: how much a
  // recorder swallows varies from one clip to the next, so the lead-in is a
  // rough amount rather than an exact one. Erring towards a little extra sound
  // at the front is the right way to be wrong.
  var WARMUP_SECONDS = 0.5;

  var stream = null;
  var streamFor = null;

  /**
   * One recording at a time, and the second waits rather than being turned
   * away.
   *
   * Two of them share one video element and one captured stream, and the
   * first to finish puts the video back where it was, in the middle of the
   * second. Refusing the second is easy and gives you a card with no sound
   * on it; waiting costs a few seconds and gives you the card you asked for.
   */
  var turn = Promise.resolve();

  function inTurn(work) {
    var mine = turn.then(work, work);
    turn = mine.then(function () {}, function () {});
    return mine;
  }

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
  /*
   * The line recorded most recently, and what it was recorded from.
   *
   * Mining two words out of one subtitle is completely ordinary, and it
   * meant recording the same line twice: the video jumped back, played the
   * line again in real time, and produced a second copy of a file identical
   * to the one just made. The second word cost as long as the line does for
   * nothing.
   *
   * One line is remembered, not a collection of them. The case this is for
   * is two or three words out of the line in front of you, and a clip is a
   * few hundred kilobytes of WAV; keeping every line of a film in memory to
   * serve a case that does not arise is the wrong trade.
   */
  var lastClip = null;

  /**
   * What makes one recording the same as another: the same stretch of the
   * same video, asked for with the same lead-in. The video's own source is
   * in there so that two videos whose lines happen to coincide in text and
   * timing cannot be mistaken for one, and so that the memory is dropped
   * the moment a different video is playing.
   */
  function clipKey(video, sentence, cue, lead) {
    return [video.currentSrc || video.src || '', sentence, cue.start, cue.end, lead].join('\u0000');
  }

  /** Is the line already recorded, so that mining it again costs nothing? */
  function hasClip(sentence, cue, options) {
    var video = currentVideo();
    if (!video || !cue || !(cue.end > cue.start)) return false;
    return !!lastClip && lastClip.key === clipKey(video, sentence, cue, leadFrom(options));
  }

  function leadFrom(options) {
    return options && typeof options.lead === 'number' && isFinite(options.lead)
      ? Math.max(0, Math.min(MAX_LEAD_SECONDS, options.lead))
      : LEAD_SECONDS;
  }

  async function capture(sentence, cue, options) {
    var video = currentVideo();
    if (!video) return {};
    var out = {};
    var lead = leadFrom(options);
    var sealed = contentProtected(video);

    // Before anything moves: the picture you were actually looking at. This
    // is attempted on a protected video too, because whether it works there
    // is not up to the protection alone, see grabFrame.
    var frame = grabFrame(video);
    if (frame) out.image = { filename: name(sentence, 'jpg'), data: frame };

    // The sound is a different matter, and there are two reasons not to try
    // for it here rather than one. The stream a protected element hands over
    // is empty, and getting to the start of the line means setting
    // currentTime, which on Netflix ends the playback session outright with
    // its error F7375. So the line is not replayed at all: no seek, no
    // recording, and no announcement of a recording that cannot happen.
    if (!sealed && cue && cue.end > cue.start) {
      var key = clipKey(video, sentence, cue, lead);
      if (lastClip && lastClip.key === key) {
        out.sentenceAudio = lastClip.audio;
        return out;
      }
      var clip = await record(video, cue.start, cue.end, lead);
      var sound = clip ? await asWav(clip) : null;
      if (sound) {
        out.sentenceAudio = { filename: name(sentence, 'wav'), data: await toBase64(sound) };
      } else if (clip) {
        // The conversion did not work, which should not happen, but a card
        // with sound Anki may refuse is better than a card with none.
        out.sentenceAudio = { filename: name(sentence, 'webm'), data: await toBase64(clip) };
      }
      // Only a recording that actually came out is worth remembering. A line
      // too short to record, or one the recorder returned nothing for, has
      // to be allowed to be tried again.
      if (out.sentenceAudio) lastClip = { key: key, audio: out.sentenceAudio };
    }

    // What could not be had, and separately, because the two have different
    // answers: the sound cannot be had from a protected video at all, and
    // the picture usually can, once the browser stops decoding on the GPU.
    var lostImage = !!(video.videoWidth && !out.image);
    var lostAudio = !!(sealed && cue && cue.end > cue.start);
    if (lostImage || lostAudio) out.blocked = { image: lostImage, audio: lostAudio };
    return out;
  }

  // -------------------------------------------------------------------------
  // Turning the recording into something every Anki can play
  // -------------------------------------------------------------------------

  /**
   * What comes off a browser recorder is Opus in a WebM container, which is
   * an excellent format and the wrong one for a card. Anki on a computer
   * plays it, because that Anki hands the file to mpv, which plays anything.
   * Anki on a phone does not: AnkiMobile cannot read WebM at all, and
   * AnkiDroid depends on what the phone underneath it happens to support.
   * A card that plays at the desk and is silent on the train is worse than
   * useless, because it is only ever found out on the train.
   *
   * So the clip is decoded and written out again as a plain WAV: mono,
   * sixteen bits, and the sample rate below. Nothing invented, nothing
   * clever, just the samples one after another, which is the one audio
   * format that has never needed asking about.
   *
   * The cost is the file. A WAV of a spoken line runs to a few hundred
   * kilobytes where the Opus was twenty or thirty, and there is no honest
   * way around that without an encoder, which is a large piece of somebody
   * else's code. Speech does not need much though, so the rate is set low
   * enough to keep it in proportion and high enough that nothing is lost:
   * 24 kHz carries everything a voice does.
   */
  var WAV_RATE = 24000;

  async function asWav(clip) {
    try {
      var bytes = await clip.arrayBuffer();
      // Decoding through a context set to the rate we want is also what
      // resamples it: an AudioContext hands back everything at its own rate.
      var context = new OfflineAudioContext(1, 1, WAV_RATE);
      var audio = await context.decodeAudioData(bytes);
      return wavFile(toMono(audio), WAV_RATE);
    } catch (err) {
      return null;
    }
  }

  /** Both channels averaged into one. A subtitle line is speech, not music. */
  function toMono(audio) {
    var channels = audio.numberOfChannels;
    var out = new Float32Array(audio.length);
    for (var c = 0; c < channels; c++) {
      var data = audio.getChannelData(c);
      for (var i = 0; i < out.length; i++) out[i] += data[i];
    }
    if (channels > 1) for (var j = 0; j < out.length; j++) out[j] /= channels;
    return out;
  }

  /**
   * A WAV file: a 44-byte header saying what the samples are, then the
   * samples. Every field is written little-endian, which is what the `true`
   * on each line means.
   */
  function wavFile(samples, rate) {
    var body = samples.length * 2;
    var bytes = new ArrayBuffer(44 + body);
    var view = new DataView(bytes);
    var write = function (at, text) {
      for (var i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
    };
    write(0, 'RIFF');
    view.setUint32(4, 36 + body, true);   // everything after this field
    write(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);         // how long the description below is
    view.setUint16(20, 1, true);          // plain samples, nothing compressed
    view.setUint16(22, 1, true);          // one channel
    view.setUint32(24, rate, true);       // samples a second
    view.setUint32(28, rate * 2, true);   // bytes a second
    view.setUint16(32, 2, true);          // bytes per sample
    view.setUint16(34, 16, true);         // bits per sample
    write(36, 'data');
    view.setUint32(40, body, true);
    for (var s = 0; s < samples.length; s++) {
      // Anything past the ends of the scale is held at the ends of it,
      // rather than wrapping round into a crack of noise.
      var value = Math.max(-1, Math.min(1, samples[s]));
      view.setInt16(44 + s * 2, Math.round(value * 32767), true);
    }
    return new Blob([bytes], { type: 'audio/wav' });
  }

  /**
   * Is this video being handed to the browser's content protection layer?
   *
   * `mediaKeys` is set on the element by the page itself when it starts
   * decrypting, so the element answers for itself. A list of sites would
   * have been simpler to write and wrong the day a fourth service launched,
   * or the day one of these three played an unprotected trailer.
   */
  function contentProtected(video) {
    return !!(video && video.mediaKeys);
  }

  /**
   * Is there a picture in here, or a black rectangle?
   *
   * A frame decoded on the GPU behind content protection does not refuse to
   * be drawn: it draws as one flat colour, nothing throws, the canvas is not
   * tainted, and what lands on the card is a black JPEG. That is worse than
   * no picture, because a black picture looks like a card that worked.
   *
   * A real frame is never one single value across the whole of it, however
   * dark it is; sensor noise and compression see to that. A deliberate fade
   * to black is the exception, and being told a fade was copy-protected is
   * a cheap thing to be wrong about once in a while.
   */
  function allOneColour(data) {
    if (!data || data.length < 4) return true;
    // Every hundredth pixel is plenty: a frame that differs anywhere differs
    // in far more places than that, and this runs while somebody waits.
    var step = 4 * 97;
    for (var i = 4; i < data.length; i += step) {
      if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) {
        return false;
      }
    }
    return true;
  }

  function grabFrame(video) {
    if (!video.videoWidth) return null;
    var scale = Math.min(1, MAX_WIDTH / video.videoWidth);
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    try {
      var ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      var pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (allOneColour(pixels.data)) return null;
      return canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1];
    } catch (err) {
      return null;   // the canvas was tainted and will not be read at all
    }
  }

  /**
   * Replay `start` to `end` and record it, then put the video back exactly as
   * it was, same moment, same speed, same paused or playing.
   *
   * Speed is forced to normal for the duration: a line captured at 1.5x is a
   * line spoken at 1.5x, which is not what you want on a card.
   */
  function record(video, start, end, lead) {
    return inTurn(function () { return recordNow(video, start, end, lead); });
  }

  async function recordNow(video, start, end, lead) {
    var type = mimeType();
    var source = audioStream(video);
    if (!type || !source) return null;

    // Where the recording opens, as against where the line is written to
    // begin. Never before the video does.
    var from = Math.max(0, start - (lead || 0));
    // And where the recorder is told to start, which is earlier again.
    var open = Math.max(0, from - WARMUP_SECONDS);

    var wasPaused = video.paused;
    var wasTime = video.currentTime;
    var wasRate = video.playbackRate;
    var length = Math.min(Math.max(end - from, MIN_CLIP_SECONDS), MAX_CLIP_SECONDS);

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
      // The line plays out loud while this records, that is deliberate, so
      // you can hear what is being captured rather than mining blind.
      video.playbackRate = 1;
      video.currentTime = Math.max(0, open - PREROLL_SECONDS);
      await seeked(video);
      await video.play();

      // Watch the clock rather than trusting a timer: buffering, or a frame
      // dropped, would otherwise cut the line short at either end.
      await until(function () { return video.currentTime >= open; }, 5000);
      recorder.start();
      await until(function () { return video.currentTime >= from + length; },
        length * 1000 + 5000);
      recorder.stop();
      // A recorder that never says it stopped would otherwise hold the card
      // for ever. Whatever has been captured by then is what there is.
      await Promise.race([finished, wait(3000)]);
    } catch (err) {
      try { recorder.stop(); } catch (ignored) { /* already stopped */ }
      return null;
    } finally {
      // Left where the recording ended, rather than dragged back to where
      // the + was pressed. You have just heard the line played out; the
      // place to carry on from is the end of it. Never earlier than where
      // you were, though: pressing + after a line has finished should not
      // rewind you into it.
      await restore(video, Math.max(wasTime, from + length), wasRate, wasPaused);
    }

    return chunks.length ? new Blob(chunks, { type: type }) : null;
  }

  /**
   * Put the video back. Waits for the seek to actually land before resuming
   * play or pause, setting currentTime does not take effect instantly, and
   * calling play() before it does risks the browser starting playback from
   * wherever it still was, which would look like the recording had put you
   * back at the start of the clip rather than where you actually were.
   */
  async function restore(video, time, rate, paused) {
    try {
      video.playbackRate = rate;
      video.currentTime = time;
      await seeked(video);
      if (paused) video.pause(); else video.play();
    } catch (err) { /* the page took the video away mid-capture */ }
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
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
    return 'torval-' + (hash >>> 0).toString(36) + '.' + extension;
  }

  return {
    capture: capture, record: record, currentVideo: currentVideo, name: name,
    hasClip: hasClip, contentProtected: contentProtected,
    // Exposed for the tests: what counts as the same recording.
    _clipKey: clipKey, _forgetClip: function () { lastClip = null; },
    // Exposed for the tests: the file the card actually carries.
    _toMono: toMono, _wavFile: wavFile,
    // Exposed for the tests: telling a picture from a black rectangle.
    _allOneColour: allOneColour
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalVideo;
