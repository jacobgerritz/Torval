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
  var SOURCES = ['word', 'reading', 'sentence', 'definition'];

  // Used to guess the mapping the first time, so a sensibly named note type
  // needs no setting up. First field to claim a source keeps it.
  var FIELD_GUESSES = [
    [/^(target ?word|word|expression|vocab(ulary)?|front)$/i, 'word'],
    [/^(reading|kana|furigana|pronunciation)$/i, 'reading'],
    [/^(sentence|example|context|sentence japanese)$/i, 'sentence'],
    [/^(definitions?|dictionary definitions?|meaning|gloss(es)?|back|english)$/i, 'definition']
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
   * Turn a lookup into a card. `note` carries the pieces (word, reading,
   * sentence, definition); `config` says which field each piece belongs in.
   */
  async function addNote(config, note) {
    if (!config || !config.deck || !config.model) {
      throw new Error('No deck chosen yet — open LLL’s options and pick one.');
    }

    var fields = {};
    var any = false;
    Object.keys(config.fields || {}).forEach(function (field) {
      var value = note[config.fields[field]];
      if (value) { fields[field] = value; any = true; }
    });
    if (!any) throw new Error('None of the note type’s fields are mapped yet — see LLL’s options.');

    return invoke(config.url, 'addNote', {
      note: {
        deckName: config.deck,
        modelName: config.model,
        fields: fields,
        tags: config.tags && config.tags.length ? config.tags : ['lll'],
        options: { allowDuplicate: false, duplicateScope: 'deck' }
      }
    });
  }

  return {
    DEFAULT_URL: DEFAULT_URL,
    SOURCES: SOURCES,
    invoke: invoke,
    describe: describe,
    fieldNames: fieldNames,
    guessMapping: guessMapping,
    addNote: addNote
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LLLAnki;
