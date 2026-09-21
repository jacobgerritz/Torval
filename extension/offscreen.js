/*
 * Torval, recording a tab's own sound
 *
 * For one case and no other: a video the browser is decrypting. Netflix and
 * the like hand their audio to the content protection layer, and asking the
 * <video> element for a stream of it gets an empty one. The tab's output,
 * on the other hand, is just sound coming out of a tab, and Chrome will hand
 * that over.
 *
 * Chrome only, and not by choice. Firefox has no tabCapture API at all, and
 * its getDisplayMedia ignores `audio` without so much as a warning, which is
 * bug 1541425, filed in 2019 and still open. There is no third way, so the
 * Firefox build ships without any of this and says the sound cannot be had.
 *
 * This runs in an offscreen document because a Manifest V3 service worker
 * has neither getUserMedia nor MediaRecorder. It is not a window anybody
 * sees; it exists so that these two calls have somewhere to happen.
 *
 * The one thing that must not be forgotten: capturing a tab takes its sound
 * away from the speakers. A recording made in silence is the wrong kind of
 * mining, the whole design here is that you hear the line as it is captured,
 * so the captured stream is played back out through an AudioContext at the
 * same time. Leave that out and the video goes mute mid-sentence, which
 * looks exactly like a crash.
 */

'use strict';

(function () {
  const api = globalThis.chrome;
  if (!api || !api.runtime) return;

  let recorder = null;
  let chunks = [];
  let stream = null;
  let context = null;

  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || message.to !== 'offscreen') return undefined;
    if (message.type === 'recordStart') {
      start(message.streamId, message.mimeType).then(respond, (err) => {
        respond({ ok: false, error: String((err && err.message) || err) });
      });
      return true;
    }
    if (message.type === 'recordStop') {
      stop().then(respond, (err) => {
        respond({ ok: false, error: String((err && err.message) || err) });
      });
      return true;
    }
    return undefined;
  });

  async function start(streamId, mimeType) {
    await release();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId }
      }
    });

    // Back out to the speakers, or the tab falls silent for as long as this
    // runs. See the note at the top: hearing the line is the point.
    context = new AudioContext();
    context.createMediaStreamSource(stream).connect(context.destination);

    chunks = [];
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start();
    return { ok: true };
  }

  async function stop() {
    if (!recorder) return { ok: false, error: 'Nothing was being recorded.' };
    const type = recorder.mimeType;
    const finished = new Promise((done) => { recorder.onstop = done; });
    try { recorder.stop(); } catch (err) { /* already stopped */ }
    await Promise.race([finished, wait(3000)]);

    const blob = chunks.length ? new Blob(chunks, { type }) : null;
    await release();
    if (!blob) return { ok: false, error: 'Nothing came out of the recorder.' };
    // Base64 rather than the blob itself: a blob does not survive the trip
    // between an offscreen document and a content script.
    return { ok: true, type, data: await toBase64(blob) };
  }

  /**
   * Everything let go of, in an order that cannot leave the tab muted.
   *
   * The AudioContext is the thing putting the sound back out; closing it
   * before the tracks stop means a fraction of a second of silence, and
   * failing to close it at all means the tab keeps being captured after the
   * card is made.
   */
  async function release() {
    recorder = null;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    if (context) {
      try { await context.close(); } catch (err) { /* already gone */ }
      context = null;
    }
  }

  function wait(ms) {
    return new Promise((done) => setTimeout(done, ms));
  }

  function toBase64(blob) {
    return new Promise((done, fail) => {
      const reader = new FileReader();
      reader.onloadend = () => done(String(reader.result).split(',')[1]);
      reader.onerror = () => fail(reader.error);
      reader.readAsDataURL(blob);
    });
  }
})();
