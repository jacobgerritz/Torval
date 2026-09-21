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

  /**
   * Narration, off unless it has been asked for. Guarded rather than
   * assumed, because the tests load this file without log.js.
   */
  function trace() {
    if (typeof TorvalLog !== 'undefined') TorvalLog.say.apply(null, arguments);
  }

  // Set when the browser has refused because the extension has not been
  // invoked on this tab. Clicking the toolbar button is the whole cure.
  var needsInvoking = false;

  // How much of the warm-up the last recording actually caught, in seconds,
  // measured off the video clock rather than assumed. Set by whichever of
  // the two recorders ran; only one runs per card.
  var headTrim = 0;

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
  // Left on the front when the warm-up is cut away. A recorder does not
  // begin the instant it is told to, so cutting exactly to the measurement
  // shaves the first syllable, and a trailing word is the smaller sin.
  var TRIM_SAFETY = 0.08;

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
    // Cleared here, not left standing. It says "click the toolbar button",
    // which is true of the attempt that set it and a lie on every card
    // after somebody has.
    needsInvoking = false;
    var sealed = contentProtected(video);
    trace('Torval: capturing from a video that is ' +
      (sealed ? 'decrypting, so the sound has to come off the tab' : 'not protected'));

    // Before anything moves: the picture you were actually looking at. This
    // is attempted on a protected video too, because whether it works there
    // is not up to the protection alone, see grabFrame.
    var frame = grabFrame(video);
    if (!frame && sealed) frame = await grabVisible(video);
    if (frame) out.image = { filename: name(sentence, 'jpg'), data: frame };

    // The sound comes off the element on an ordinary video and out of the
    // tab on a protected one, which is the only place it can be had: a
    // decrypting element hands over no audio track at all. The tab path is
    // Chrome's alone and has to be allowed first, so it may not be there.
    if (cue && cue.end > cue.start) {
      var key = clipKey(video, sentence, cue, lead);
      if (lastClip && lastClip.key === key) {
        out.sentenceAudio = lastClip.audio;
        return out;
      }
      headTrim = 0;
      var clip = sealed
        ? await recordTab(video, cue.start, cue.end, lead)
        : await record(video, cue.start, cue.end, lead);
      var sound = clip ? await asWav(clip, headTrim) : null;
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
    var lostAudio = !!(cue && cue.end > cue.start && !out.sentenceAudio);
    if (lostImage || lostAudio) {
      out.blocked = { image: lostImage, audio: lostAudio };
      if (needsInvoking) out.blocked.invoke = true;
    }
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

  async function asWav(clip, skip) {
    try {
      var bytes = await clip.arrayBuffer();
      // Decoding through a context set to the rate we want is also what
      // resamples it: an AudioContext hands back everything at its own rate.
      var context = new OfflineAudioContext(1, 1, WAV_RATE);
      var audio = await context.decodeAudioData(bytes);
      return wavFile(trimHead(toMono(audio), skip), WAV_RATE);
    } catch (err) {
      return null;
    }
  }

  /**
   * The warm-up off the front.
   *
   * Recording opens half a second before the line so the first syllable is
   * not lost while the recorder gets going, and what that half second holds
   * is the tail of the line before, which arrives on the card as a stray
   * word. It is cut off here rather than never recorded, because the whole
   * point of the warm-up is that a recorder cannot be trusted to start on
   * command.
   *
   * Never so far in that there is nothing left: a measurement that has gone
   * wrong should cost a stray word, not the line.
   */
  function trimHead(samples, seconds) {
    var at = Math.round((seconds || 0) * WAV_RATE);
    if (at <= 0) return samples;
    if (at > samples.length - Math.round(WAV_RATE * 0.2)) return samples;
    return samples.subarray(at);
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

  /**
   * The frame as the browser drew it, for the frame the canvas will not
   * give up.
   *
   * A decrypting video refuses page script its pixels whatever decoded
   * them, so a canvas gets one flat black rectangle and no amount of
   * fiddling with hardware acceleration reliably changes that. Asking the
   * browser for a photograph of the tab goes round the outside: it is the
   * same picture a person is looking at, taken after the protection has
   * already had its say.
   *
   * The cost is that it photographs the window, so whatever is drawn over
   * the video comes too. The site's own subtitles are the one thing that
   * must not: the answer printed on the front of a card is not a card. They
   * go away for the one frame and come straight back.
   *
   * Top window only. The coordinates are the top window's, so a video in a
   * frame would be cropped from the wrong part of the picture, and a framed
   * video is a YouTube embed, which is not protected and never gets here.
   */
  async function grabVisible(video) {
    var api = (typeof browser !== 'undefined' && browser.runtime) ? browser
      : (typeof chrome !== 'undefined' ? chrome : null);
    if (!api || !api.runtime) return null;
    if (window.top !== window) return null;

    var rect = video.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;

    var show = hideOverlays();
    var shot = null;
    try {
      await painted();
      shot = await ask(api, { type: 'grabVisible' });
    } catch (err) {
      var why = (err && err.message) || String(err);
      // One failure has a cure the person can apply, so it is remembered
      // and said on the card rather than left in a console nobody opens.
      if (/invoked|activeTab|access/i.test(why)) needsInvoking = true;
      console.warn('Torval: could not photograph the tab:', why);
      return null;
    } finally {
      show();
    }
    if (!shot || !shot.data) return null;
    return await cropTo(shot.data, rect);
  }

  /** Torval's own furniture, all of which sits over the page. */
  var OWN_OVERLAYS = '[data-torval-bar], [data-torval-subtitle], ' +
    '[data-torval-popup], [data-torval-say]';

  /**
   * Everything drawn over the video, out of the way for one frame.
   *
   * A photograph of the window is a photograph of what is in front of the
   * video as well: the site's subtitles, its control bar, Torval's own bar
   * and popup. Subtitles are the one that ruins the card outright, since
   * the answer would be printed on the front of it, but a screenshot with
   * a scrub bar across the bottom is nobody's idea of a picture either.
   *
   * visibility rather than display: nothing reflows, so nothing moves in
   * the frame being photographed and nothing has to settle afterwards.
   */
  function hideOverlays() {
    var found = [];
    var gather = function (selector) {
      if (!selector) return;
      var all;
      try { all = document.querySelectorAll(selector); } catch (err) { return; }
      for (var i = 0; i < all.length; i++) found.push(all[i]);
    };
    gather(OWN_OVERLAYS);
    if (typeof TorvalSubtitles !== 'undefined') {
      try {
        var box = TorvalSubtitles.captionBox && TorvalSubtitles.captionBox();
        if (box) found.push(box);
      } catch (err) { /* no captions to hide */ }
      try {
        if (TorvalSubtitles.overlays) gather(TorvalSubtitles.overlays());
      } catch (err) { /* this site has none named */ }
    }
    var was = found.map(function (el) { return el.style.visibility; });
    found.forEach(function (el) { el.style.visibility = 'hidden'; });
    return function () {
      found.forEach(function (el, at) { el.style.visibility = was[at]; });
    };
  }

  /**
   * Wait for a backward seek to actually take.
   *
   * The seeked event cannot be trusted here. Netflix is seeked through its
   * own player rather than by setting currentTime, so the event that
   * arrives may belong to a seek that finished a moment ago, and the clock
   * still reads where the person was watching. Everything after it then
   * passes at once: the recorder starts and is told the line is already
   * over, and what comes out is the half second before the line, which is
   * the tail of the line before it.
   *
   * So the clock is watched instead. It is going backwards past `open`
   * that proves the seek landed. Somebody who pressed + before the line had
   * started is already behind it, and there is nothing to wait for.
   */
  function landed(video, open) {
    if (video.currentTime < open) return Promise.resolve();
    return until(function () { return video.currentTime < open; }, 5000);
  }

  /** Two frames, so a style change has actually reached the screen. */
  function painted() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(); }); });
    });
  }

  /**
   * The video out of a photograph of the whole window.
   *
   * The photograph is in device pixels and the rectangle is in CSS pixels;
   * the ratio between them is read off the image rather than taken from
   * devicePixelRatio, which is wrong the moment the page is zoomed.
   */
  function cropTo(dataUrl, rect) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onerror = function () { resolve(null); };
      img.onload = function () {
        var wide = window.innerWidth || img.naturalWidth;
        var ratio = img.naturalWidth / wide;
        var w = Math.round(rect.width * ratio);
        var h = Math.round(rect.height * ratio);
        if (w < 1 || h < 1) { resolve(null); return; }
        var scale = Math.min(1, MAX_WIDTH / w);
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        try {
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, Math.round(rect.left * ratio), Math.round(rect.top * ratio),
            w, h, 0, 0, canvas.width, canvas.height);
          var pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
          if (allOneColour(pixels.data)) { resolve(null); return; }
          resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1]);
        } catch (err) {
          resolve(null);
        }
      };
      img.src = dataUrl;
    });
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
      await landed(video, open);
      await until(function () { return video.currentTime >= open; }, 5000);
      recorder.start();
      headTrim = Math.max(0, from - video.currentTime - TRIM_SAFETY);
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

  // -------------------------------------------------------------------------
  // The same line, off the tab instead of off the element
  // -------------------------------------------------------------------------

  /*
   * A copy-protected video hands over no audio track when its element is
   * asked for one, so there is nothing for recordNow to record. The tab's
   * own output is a different thing, just sound coming out of a tab, and
   * Chrome will hand it over through tabCapture. The recorder itself lives
   * in an offscreen document, because a Manifest V3 service worker has no
   * MediaRecorder; see offscreen.js.
   *
   * Firefox has no tabCapture and no getDisplayMedia audio either, so this
   * whole path is absent there and the card says the sound cannot be had.
   * Nothing is asked for until somebody turns it on under Settings → Anki,
   * and nothing here runs on an ordinary video: YouTube's sound comes off
   * the element, as it always has.
   *
   * Otherwise this is recordNow, with two differences that matter. The seek
   * goes through the site's own player rather than the element, because
   * setting currentTime on Netflix ends the session with error F7375. And
   * the recording is started and stopped by message rather than in hand,
   * which is why the clock is watched here and only the two edges cross.
   */
  function recordTab(video, start, end, lead) {
    return inTurn(function () { return recordTabNow(video, start, end, lead); });
  }

  async function recordTabNow(video, start, end, lead) {
    var api = (typeof browser !== 'undefined' && browser.runtime) ? browser
      : (typeof chrome !== 'undefined' ? chrome : null);
    if (!api || !api.runtime) return null;

    var ready = await ask(api, { type: 'tabAudioReady' }).catch(function () { return null; });
    if (!ready || !ready.can) return null;
    if (!ready.granted) {
      // Not an error. The card offers the switch; see offerTabAudio.
      return null;
    }

    var from = Math.max(0, start - (lead || 0));
    var open = Math.max(0, from - WARMUP_SECONDS);
    var length = Math.min(Math.max(end - from, MIN_CLIP_SECONDS), MAX_CLIP_SECONDS);

    var wasPaused = video.paused;
    var wasTime = video.currentTime;
    var wasRate = video.playbackRate;
    var started = false;

    try {
      video.playbackRate = 1;
      if (!seekTo(Math.max(0, open - PREROLL_SECONDS))) return null;
      await seeked(video);
      await video.play();
      await landed(video, open);
      await until(function () { return video.currentTime >= open; }, 5000);

      await ask(api, { type: 'tabAudioStart', mimeType: mimeType() });
      started = true;
      headTrim = Math.max(0, from - video.currentTime - TRIM_SAFETY);
      await until(function () { return video.currentTime >= from + length; },
        length * 1000 + 5000);
    } catch (err) {
      // Said out loud rather than swallowed. Everything between here and
      // the sound is somebody else's: a permission, an offscreen document,
      // a tab the browser may decline to hand over. A card that arrives
      // silent with no reason anywhere is a morning of guessing.
      var why = (err && err.message) || String(err);
      if (/invoked|activeTab|access/i.test(why)) needsInvoking = true;
      console.warn('Torval: could not record the tab:', why);
      if (started) { try { await ask(api, { type: 'tabAudioStop' }); } catch (ignored) { /* */ } }
      await restore(video, Math.max(wasTime, from + length), wasRate, wasPaused);
      return null;
    }

    var got = null;
    try {
      got = await ask(api, { type: 'tabAudioStop' });
    } catch (err) {
      console.warn('Torval: the tab recording came back empty:', (err && err.message) || err);
      got = null;
    }
    await restore(video, Math.max(wasTime, from + length), wasRate, wasPaused);
    if (!got || !got.data) return null;
    return fromBase64(got.data, got.type || 'audio/webm');
  }

  /** One message, with the wrapper the background puts round every answer. */
  async function ask(api, message) {
    var reply = await api.runtime.sendMessage(message);
    if (!reply || !reply.ok) {
      throw new Error((reply && reply.error) || 'Torval could not reach the recorder.');
    }
    return reply.result;
  }

  /**
   * Whichever way this site allows the video to be moved. Netflix insists on
   * its own player, and subtitles.js is where that already lives, since A
   * and D have had to go through it for as long as they have existed.
   */
  function seekTo(seconds) {
    if (typeof TorvalSubtitles !== 'undefined' && TorvalSubtitles.seekTo) {
      return TorvalSubtitles.seekTo(seconds);
    }
    return false;
  }

  /** A blob back out of what crossed between documents as text. */
  function fromBase64(data, type) {
    var binary = atob(data);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: type });
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
      // Through the site's own player where it has one. Putting the video
      // back by setting currentTime is the same move that ends a Netflix
      // session with error F7375, and doing it on the way out would be a
      // worse place to do it than on the way in: the card is already made
      // and the error page arrives looking like Torval broke the film.
      if (!seekTo(time)) video.currentTime = time;
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
    _allOneColour: allOneColour,
    _trimHead: trimHead
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalVideo;
