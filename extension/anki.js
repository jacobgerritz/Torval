/*
 * Torval, talking to Anki
 *
 * Anki itself has no way to accept a card from outside. AnkiConnect, the add-on,
 * opens a small web server on your own machine (port 8765) that does. So adding
 * a card is one HTTP request to 127.0.0.1, nothing leaves your computer, and if
 * Anki is closed the request simply fails and we say so.
 *
 * Only the background script may do this: a page cannot reach your local Anki,
 * which is exactly as it should be.
 */

var TorvalAnki = (function () {
  'use strict';

  var DEFAULT_URL = 'http://127.0.0.1:8765';

  // What Torval can put on a card. The options page lets you point each field of
  // your note type at one of these. 'pitch' and 'stress' both mean "how the
  // word sounds", Japanese's pitch-accent diagram and Italian's stressed-
  // vowel mark, and only ever one is offered at a time: options.js shows
  // whichever matches the active language.
  var SOURCES = ['word', 'reading', 'sentence', 'definition', 'audio', 'pitch', 'stress',
    'image', 'sentenceAudio', 'sentenceBefore', 'sentenceAfter'];

  // JapanesePod101's dictionary endpoint. It answers every request with an mp3
  // and a 200, whether or not it actually has the word: when it does not, you
  // get a fixed 52,288-byte recording saying the audio is unavailable. It is
  // always byte for byte identical, so the only way to tell is to hash what came
  // back. Anything matching is thrown away and the audio field left empty, 
  // better than a collection full of identical "no audio" clips.
  var AUDIO_URL = 'https://assets.languagepod101.com/dictionary/japanese/audiomp3.php';

  // Italian and Spanish have no such endpoint, so their recordings are
  // found at build time instead and the entry carries the answer: see
  // build-audio.mjs. What it carries is the two hex characters of the
  // Commons shard and whoever did the recording, because the rest of the
  // address is the word itself and two constants off the language profile,
  // and 27,000 entries do not need to each store the same 200-character
  // URL with one word changed.
  var COMMONS = 'https://upload.wikimedia.org/wikipedia/commons/transcoded/';
  var NO_AUDIO_SHA256 = 'ae6398b5a27bc8c0a771df6c907ade794be15518174773c58c7c7ddd17098906';
  // Only to catch empty or truncated replies. Real recordings get small, 犬 is
  // about 1.6 KB, so this has to stay well clear of them; the hash does the
  // actual work.
  var MIN_AUDIO_BYTES = 256;

  // Used to guess the mapping the first time, so a sensibly named note type
  // needs no setting up. First field to claim a source keeps it.
  var FIELD_GUESSES = [
    [/^(target ?word|word|expression|vocab(ulary)?|front)$/i, 'word'],
    [/^(reading|kana|furigana|pronunciation)$/i, 'reading'],
    [/^(sentence|example|context|sentence japanese)$/i, 'sentence'],
    [/^(definitions?|dictionary definitions?|meaning|gloss(es)?|back|english)$/i, 'definition'],
    [/^(word ?audio|audio|term ?audio)$/i, 'audio'],
    [/^(pitch|pitch ?accent|accent)$/i, 'pitch'],
    [/^(stress|word ?stress)$/i, 'stress'],
    [/^(images?|screenshot|picture|photo)$/i, 'image'],
    [/^(sentence ?audio|expression ?audio|context ?audio)$/i, 'sentenceAudio'],
    [/^(sentence ?before|previous ?(sentence|line)|line ?before|before)$/i, 'sentenceBefore'],
    [/^(sentence ?after|next ?(sentence|line)|line ?after|after)$/i, 'sentenceAfter']
  ];

  // Every request gets a deadline. Without one, a call that simply never
  // answers leaves the + on a card showing a dot for ever, with nothing said
  // and nothing to be done about it. Anki waiting on a dialog of its own is
  // enough to cause that, and so is a network that accepts a connection and
  // then goes quiet.
  var ANKI_SECONDS = 10;
  var AUDIO_SECONDS = 8;

  function deadline(seconds) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, seconds * 1000);
    return { signal: controller.signal, done: function () { clearTimeout(timer); } };
  }

  async function invoke(url, action, params) {
    var limit = deadline(ANKI_SECONDS);
    var res;
    try {
      res = await fetch(url || DEFAULT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action, version: 6, params: params || {} }),
        signal: limit.signal
      });
    } catch (err) {
      limit.done();
      throw new Error(err && err.name === 'AbortError'
        ? 'Anki did not answer within ' + ANKI_SECONDS + ' seconds. Is it waiting on a dialog?'
        : 'Anki is not answering. Is it running, with the AnkiConnect add-on installed?');
    }
    try {
      if (!res.ok) throw new Error('AnkiConnect replied with ' + res.status);
      var data = await res.json();
      if (data.error) throw new Error(data.error);
      return data.result;
    } finally {
      limit.done();
    }
  }

  /** Everything the options page needs to draw itself. */
  async function describe(url) {
    var decks = await invoke(url, 'deckNames');
    var models = await invoke(url, 'modelNames');
    return { decks: decks.sort(), models: models.sort() };
  }

  function fieldNames(url, model) {
    return invoke(url, 'modelFieldNames', { modelName: model });
  }

  function guessMapping(names) {
    var mapping = {};
    var taken = {};
    names.forEach(function (name) {
      for (var i = 0; i < FIELD_GUESSES.length; i++) {
        var source = FIELD_GUESSES[i][1];
        if (!taken[source] && FIELD_GUESSES[i][0].test(name)) {
          mapping[name] = source;
          taken[source] = true;
          return;
        }
      }
      mapping[name] = '';
    });
    return mapping;
  }

  /**
   * The address of a Lingua Libre recording, rebuilt from the little the
   * entry stores. Commons files the word under the MD5 of its own name, and
   * the mp3 is a transcode sitting beside the original wav, at a quarter of
   * its size. Null when this language has no such recordings or this word
   * has none.
   */
  function voiceUrl(word, said) {
    if (!word || !said) return null;
    var profile = typeof TorvalLang !== 'undefined' ? TorvalLang.profile() : null;
    var voice = profile && profile.voice;
    if (!voice) return null;
    var cut = said.indexOf('|');
    if (cut === -1) return null;
    var shard = said.slice(0, cut);
    var speaker = said.slice(cut + 1);
    var name = 'LL-' + voice.qid + ' (' + voice.iso + ')-' + speaker + '-' + word + '.wav';
    var file = encodeURIComponent(name.replace(/ /g, '_'));
    return COMMONS + shard.charAt(0) + '/' + shard + '/' + file + '/' + file + '.mp3';
  }

  /**
   * Fetch a word's pronunciation, or null if there isn't one.
   * Returns the mp3 as base64, which is what AnkiConnect wants.
   *
   * Two sources, and which one is used is the language's business rather
   * than this function's. Japanese asks JapanesePod101, which answers for
   * any word and has to be caught out when it is bluffing. Italian and
   * Spanish already know the answer, because `said` came off the dictionary
   * entry, so a word with no recording never makes a request at all.
   */
  async function fetchAudio(word, reading, said) {
    var voice = voiceUrl(word, said);
    if (typeof TorvalLang !== 'undefined') {
      var profile = TorvalLang.profile();
      // A language with recordings of its own never falls through to
      // JapanesePod101, which would answer in Japanese about an Italian word.
      if (profile && profile.voice && !voice) return null;
    }
    var url = voice || (AUDIO_URL + '?kanji=' + encodeURIComponent(word) +
      '&kana=' + encodeURIComponent(reading || word));
    var buffer;
    var limit = deadline(AUDIO_SECONDS);
    try {
      var res = await fetch(url, { signal: limit.signal });
      if (!res.ok) return null;
      buffer = await res.arrayBuffer();
    } catch (err) {
      // No audio is not a reason to lose the card, and a pronunciation
      // service that has stopped answering is certainly not a reason to
      // leave somebody watching a dot.
      return null;
    } finally {
      limit.done();
    }
    if (buffer.byteLength < MIN_AUDIO_BYTES) return null;
    // Only JapanesePod101 needs catching out; Commons either has the file
    // or answers 404, which the !res.ok above has already turned into null.
    if (!voice && await sha256(buffer) === NO_AUDIO_SHA256) return null;
    return toBase64(buffer);
  }

  async function sha256(buffer) {
    var digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');
  }

  function toBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  /** Anki media filenames have to survive every filesystem. */
  function audioFilename(word, reading) {
    return 'torval-' + (word + '-' + (reading || '')).replace(/[^\p{L}\p{N}-]/gu, '') + '.mp3';
  }

  /** Is there a pronunciation to be had in the language being read? */
  function hasAudio() {
    if (typeof TorvalLang === 'undefined') return true;
    var profile = TorvalLang.profile();
    return !profile || !!profile.audio;
  }

  /** Does the card have a field pointed at this? */
  function wants(config, source) {
    var fields = (config && config.fields) || {};
    return Object.keys(fields).some(function (f) { return fields[f] === source; });
  }

  /**
   * Turn a lookup into a card. `note` carries the pieces (word, reading,
   * sentence, definition); `config` says which field each piece belongs in.
   */
  /**
   * What is wrong before a card is attempted, or null if nothing is.
   *
   * Two of these used to be discovered by addNote, at the end: on a video
   * that is after the line has been recorded, which takes as long as the
   * line does. Waiting through ten seconds of recording to be told that
   * Anki is not running, or that no deck has been picked, is the wrong way
   * round, because both were knowable before any of it started.
   *
   * So the same questions are asked up front. addNote still asks them
   * too, since it can be reached without coming through here and a check
   * that can be skipped is not a check.
   */
  function whatIsMissing(config) {
    if (!config || !config.deck || !config.model) {
      return 'No deck chosen yet, open Torval’s options and pick one.';
    }
    var fields = config.fields || {};
    if (!Object.keys(fields).some(function (f) { return fields[f]; })) {
      return 'None of the note type’s fields are mapped yet, see Torval’s options.';
    }
    return null;
  }

  /**
   * Everything that can be known to be wrong before a card is made,
   * including whether Anki is answering at all. Throws what to say.
   */
  async function checkReady(config) {
    var missing = whatIsMissing(config);
    if (missing) throw new Error(missing);
    // The cheapest thing AnkiConnect will answer. It is not the answer that
    // matters, it is that there was one: invoke throws its own sentence
    // about Anki not running or sitting on a dialog, and that sentence is
    // exactly what wants saying here.
    await invoke(config.url, 'version');
  }

  async function addNote(config, note) {
    var missing = whatIsMissing(config);
    if (missing) throw new Error(missing);

    // Only go looking for audio if somewhere on the card wants it.
    // Not offered outside Japanese, but a mapping saved before that was true
    // would still ask, and the answer would be one more copy of the
    // "unavailable" clip. See the note on `audio` in lang.js.
    // `voice` rather than `word`, because by here `word` may have gathered
    // an article ("il cane"), and nobody recorded that. It is the bare
    // dictionary form that was matched against Commons at build time.
    if (wants(config, 'audio') && note.word && hasAudio()) {
      var spoken = (note.voice && note.voice.word) || note.word;
      var data = await fetchAudio(spoken, note.reading, note.voice && note.voice.at);
      if (data) {
        var filename = audioFilename(spoken, note.reading);
        await invoke(config.url, 'storeMediaFile', { filename: filename, data: data });
        note = Object.assign({}, note, { audio: '[sound:' + filename + ']' });
      }
    }

    // Anything captured from a video arrives as a file rather than as text, so
    // it goes into Anki's media folder first and the field gets a reference.
    for (var key in note.media || {}) {
      if (!wants(config, key)) continue;
      var file = note.media[key];
      if (!file || !file.data) continue;
      await invoke(config.url, 'storeMediaFile', { filename: file.filename, data: file.data });
      note[key] = key === 'image'
        ? '<img src="' + file.filename + '">'
        : '[sound:' + file.filename + ']';
    }

    var fields = {};
    var any = false;
    Object.keys(config.fields || {}).forEach(function (field) {
      var value = note[config.fields[field]];
      if (value) { fields[field] = value; any = true; }
    });
    // Different from the check up front: the fields are mapped, but this
    // particular word filled none of them.
    if (!any) throw new Error('Nothing to put on the card. Check the field mapping in Torval’s options.');

    // Duplicates are allowed on purpose: mining a second word from a sentence
    // you have already mined once is completely ordinary. Anki's own
    // duplicate rule compares first fields, which on a sentence-mining note
    // type is the sentence rather than the word, so it is turned off rather
    // than half-applied. Whether this word already exists is answered
    // separately, up front, see alreadyHave, as a heads-up, not a gate.
    return invoke(config.url, 'addNote', {
      note: {
        deckName: config.deck,
        modelName: config.model,
        fields: fields,
        tags: config.tags && config.tags.length ? config.tags : ['torval'],
        options: { allowDuplicate: true }
      }
    });
  }

  /** The field a given piece of the card goes into, if any. */
  function fieldFor(config, source) {
    var fields = (config && config.fields) || {};
    var names = Object.keys(fields);
    for (var i = 0; i < names.length; i++) {
      if (fields[names[i]] === source) return names[i];
    }
    return null;
  }

  /**
   * Do we already have a card for this word?
   *
   * Anki decides two notes are duplicates by comparing their first fields, and
   * on a sentence-mining note type the first field is the sentence. So mining a
   * second word out of one sentence looked like a duplicate and was refused, 
   * which is wrong: one sentence can easily teach you three words.
   *
   * A card is a duplicate when it is the same *word*, so that is what gets
   * asked, and Anki's rule is turned off. If the question cannot be asked, no
   * word field mapped, or an Anki too old to answer, the card is simply made.
   */
  async function alreadyHave(config, note) {
    var field = fieldFor(config, 'word');
    if (!field || !note.word) return false;
    try {
      var query = '"deck:' + escapeSearch(config.deck) + '" "' +
        escapeSearch(field) + ':' + escapeSearch(note.word, true) + '"';
      var found = await invoke(config.url, 'findNotes', { query: query });
      return !!(found && found.length);
    } catch (err) {
      return false;
    }
  }

  /**
   * Open Anki's card browser on a word, and bring Anki to the front.
   *
   * The word and nothing else: every deck, every field, whatever is in the
   * collection. Searching the deck and field Torval mines into would answer a
   * narrower question than the one being asked, which is simply "what do I
   * have with this word in it".
   *
   * Quoted and escaped so that a word is a word: a colon in it would
   * otherwise be read as Anki's field:value syntax, and an underscore or an
   * asterisk as a wildcard.
   */
  async function browse(config, word) {
    if (!word) throw new Error('No word to look up.');
    var query = '"' + escapeSearch(word, true) + '"';
    await invoke(config && config.url, 'guiBrowse', { query: query });
    return query;
  }

  /**
   * Anki's search syntax. Quotes and backslashes always need escaping; in a
   * field's value so do the wildcards and the colon, which would otherwise be
   * read as syntax. Deck names keep their colons, that is how nesting is
   * written.
   */
  function escapeSearch(text, isValue) {
    var out = String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return isValue ? out.replace(/[:*_]/g, '\\$&') : out;
  }

  return {
    DEFAULT_URL: DEFAULT_URL,
    SOURCES: SOURCES,
    invoke: invoke,
    describe: describe,
    fieldNames: fieldNames,
    guessMapping: guessMapping,
    escapeSearch: escapeSearch,
    fieldFor: fieldFor,
    whatIsMissing: whatIsMissing,
    checkReady: checkReady,
    alreadyHave: alreadyHave,
    fetchAudio: fetchAudio,
    voiceUrl: voiceUrl,
    browse: browse,
    // Exposed so the tests can watch a deadline pass without waiting for one.
    _deadlines: function (anki, audio) { ANKI_SECONDS = anki; AUDIO_SECONDS = audio; },
    audioFilename: audioFilename,
    addNote: addNote
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = TorvalAnki;
