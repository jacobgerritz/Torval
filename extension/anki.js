/*
 * LLL — talking to Anki
 *
 * Anki itself has no way to accept a card from outside. AnkiConnect, the add-on,
 * opens a small web server on your own machine (port 8765) that does. So adding
 * a card is one HTTP request to 127.0.0.1 — nothing leaves your computer, and if
 * Anki is closed the request simply fails and we say so.
 *
 * Only the background script may do this: a page cannot reach your local Anki,
 * which is exactly as it should be.
 */

var LLLAnki = (function () {
  'use strict';

  var DEFAULT_URL = 'http://127.0.0.1:8765';

  // What LLL can put on a card. The options page lets you point each field of
  // your note type at one of these.
  var SOURCES = ['word', 'reading', 'sentence', 'definition', 'audio', 'pitch',
    'image', 'sentenceAudio'];

  // JapanesePod101's dictionary endpoint. It answers every request with an mp3
  // and a 200, whether or not it actually has the word: when it does not, you
  // get a fixed 52,288-byte recording saying the audio is unavailable. It is
  // always byte for byte identical, so the only way to tell is to hash what came
  // back. Anything matching is thrown away and the audio field left empty —
  // better than a collection full of identical "no audio" clips.
  var AUDIO_URL = 'https://assets.languagepod101.com/dictionary/japanese/audiomp3.php';
  var NO_AUDIO_SHA256 = 'ae6398b5a27bc8c0a771df6c907ade794be15518174773c58c7c7ddd17098906';
  // Only to catch empty or truncated replies. Real recordings get small — 犬 is
  // about 1.6 KB — so this has to stay well clear of them; the hash does the
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
    [/^(images?|screenshot|picture|photo)$/i, 'image'],
    [/^(sentence ?audio|expression ?audio|context ?audio)$/i, 'sentenceAudio']
  ];

  async function invoke(url, action, params) {
    var res;
    try {
      res = await fetch(url || DEFAULT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action, version: 6, params: params || {} })
      });
    } catch (err) {
      throw new Error('Anki is not answering. Is it running, with the AnkiConnect add-on installed?');
    }
    if (!res.ok) throw new Error('AnkiConnect replied with ' + res.status);
    var data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.result;
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
   * Fetch a word's pronunciation, or null if there isn't one.
   * Returns the mp3 as base64, which is what AnkiConnect wants.
   */
  async function fetchAudio(word, reading) {
    var url = AUDIO_URL + '?kanji=' + encodeURIComponent(word) +
      '&kana=' + encodeURIComponent(reading || word);
    var buffer;
    try {
      var res = await fetch(url);
      if (!res.ok) return null;
      buffer = await res.arrayBuffer();
    } catch (err) {
      return null;   // no audio is not a reason to lose the card
    }
    if (buffer.byteLength < MIN_AUDIO_BYTES) return null;
    if (await sha256(buffer) === NO_AUDIO_SHA256) return null;
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
    return 'lll-' + (word + '-' + (reading || '')).replace(/[^\p{L}\p{N}-]/gu, '') + '.mp3';
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
  async function addNote(config, note) {
    if (!config || !config.deck || !config.model) {
      throw new Error('No deck chosen yet — open LLL’s options and pick one.');
    }

    // Only go looking for audio if somewhere on the card wants it.
    if (wants(config, 'audio') && note.word) {
      var data = await fetchAudio(note.word, note.reading);
      if (data) {
        var filename = audioFilename(note.word, note.reading);
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
    if (!any) throw new Error('None of the note type’s fields are mapped yet — see LLL’s options.');

    // Duplicates are allowed on purpose: mining a second word from a sentence
    // you have already mined once is completely ordinary. Anki's own
    // duplicate rule compares first fields, which on a sentence-mining note
    // type is the sentence rather than the word, so it is turned off rather
    // than half-applied. Whether this word already exists is answered
    // separately, up front — see alreadyHave — as a heads-up, not a gate.
    return invoke(config.url, 'addNote', {
      note: {
        deckName: config.deck,
        modelName: config.model,
        fields: fields,
        tags: config.tags && config.tags.length ? config.tags : ['lll'],
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
   * second word out of one sentence looked like a duplicate and was refused —
   * which is wrong: one sentence can easily teach you three words.
   *
   * A card is a duplicate when it is the same *word*, so that is what gets
   * asked, and Anki's rule is turned off. If the question cannot be asked — no
   * word field mapped, or an Anki too old to answer — the card is simply made.
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
   * Anki's search syntax. Quotes and backslashes always need escaping; in a
   * field's value so do the wildcards and the colon, which would otherwise be
   * read as syntax. Deck names keep their colons — that is how nesting is
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
    alreadyHave: alreadyHave,
    fetchAudio: fetchAudio,
    audioFilename: audioFilename,
    addNote: addNote
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LLLAnki;
