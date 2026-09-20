/*
 * Torval, settings
 *
 * Two things live here and they have nothing to do with each other: where
 * cards go, and which words you already know. They are tabs rather than one
 * long page because scrolling past the whole of Anki's field mapping to reach
 * your word list is not a way to find anything.
 *
 * Deck and note type are read live from Anki rather than typed, so a name can
 * never be slightly wrong. The field mapping is offered pre-filled by guessing
 * from the field names; anything guessed wrongly is one dropdown away.
 *
 * The known words tab is known.js; only the switching between them is here.
 */

'use strict';

const api = globalThis.browser || globalThis.chrome;

// -------------------------------------------------------------------------
// Tabs
// -------------------------------------------------------------------------

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showPanel(tab.dataset.panel));
}

function showPanel(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('current', tab.dataset.panel === name);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.hidden = panel.id !== 'panel-' + name;
  }
}

// A name after the # opens that page, which is what makes the word list
// linkable rather than only reachable by clicking. #known still works, since
// that is what the page was called when anything started linking to it.
const asked = (location.hash || '').slice(1);
showPanel(asked === 'known' ? 'words'
  : document.getElementById('panel-' + asked) ? asked : 'words');

// -------------------------------------------------------------------------
// Anki
// -------------------------------------------------------------------------

// 'pitch' and 'stress' are the same idea answered differently (a diagram
// for Japanese, an inline mark for Italian and Spanish), so only whichever
// matches the active language is ever offered; a note type has no use for
// the other one. Which one a language wants is on its profile, so a new
// language says so once, in lang.js, rather than here as well.
const SOURCE_LABELS_BASE = [
  ['', ', '],
  ['word', 'Target word'],
  ['reading', 'Reading'],
  ['sentence', 'Sentence'],
  ['definition', 'Definition'],
  ['audio', 'Word audio'],
  ['image', 'Video frame'],
  ['sentenceAudio', 'Sentence audio'],
  ['sentenceBefore', 'Sentence before'],
  ['sentenceAfter', 'Sentence after']
];

function sourceLabels() {
  const extra = TorvalLang.profile().accent === 'stress'
    ? [['stress', 'Word stress']]
    : [['pitch', 'Pitch accent']];
  return SOURCE_LABELS_BASE.concat(extra);
}

// -------------------------------------------------------------------------
// Language
// -------------------------------------------------------------------------

const languageSelect = document.getElementById('language');

function fillLanguages() {
  languageSelect.textContent = '';
  for (const { code, name } of TorvalLang.list()) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = name;
    if (code === TorvalLang.active()) option.selected = true;
    languageSelect.appendChild(option);
  }
}

/*
 * The placeholders on this page are words, and a word is in one language.
 * 日本語のテキストをここに貼り付けてください is not a prompt to somebody
 * reading Spanish, it is a line of a script they may well not read at all.
 * Each language brings its own, from its profile in lang.js, for the same
 * reason the Anki source list brings its own pitch/stress row.
 */
function fillExamples() {
  const example = TorvalLang.profile().examples;
  if (!example) return;
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.placeholder = value;
  };
  set('text', example.paste);
  set('search', example.known);
  set('search-ignored', example.ignored);
  const kinds = document.getElementById('ignored-kinds');
  if (kinds) kinds.textContent = example.ignoredKinds;
}

fillExamples();

if (languageSelect) {
  fillLanguages();
  languageSelect.addEventListener('change', () => { TorvalLang.set(languageSelect.value); });
  // Fires for this select's own change too (TorvalLang.set applies synchronously
  // before its storage write settles), as well as a switch made from the
  // toolbar popup or this same page in another tab, so there is exactly one
  // place that reloads the Anki panel rather than two racing each other.
  TorvalLang.onChange(() => { fillLanguages(); fillExamples(); load(); });
}

// The chosen file’s name, said in the page’s own type. The browser will not
// show it once its own control is out of the way, and a file picker that says
// nothing after you have picked something is a file picker you press twice.
for (const input of document.querySelectorAll('input[type="file"]')) {
  const beside = input.parentElement.querySelector('.picked');
  if (!beside) continue;
  const idle = beside.textContent;
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    beside.textContent = file ? file.name : idle;
    beside.classList.toggle('chosen', !!file);
  });
}

const deckSelect = document.getElementById('deck');
const modelSelect = document.getElementById('model');
const tagsInput = document.getElementById('tags');
const leadInput = document.getElementById('lead');

const mappingBox = document.getElementById('mapping');
const mappingSection = document.getElementById('mapping-section');
const statusText = document.getElementById('status');

let config = {};

// The deck/note-type/field-mapping listeners only ever need setting up once;
// load() itself is re-entrant now, called again on every language switch, so
// setting these up inside it would pile up a duplicate set per switch.
deckSelect.addEventListener('change', () => { config.deck = deckSelect.value; });
modelSelect.addEventListener('change', () => { config.fields = {}; showFields(); });
document.getElementById('save').addEventListener('click', save);

load();

/** The Anki config for whichever language is active right now. */
function ankiConfigKey() { return 'ankiConfig' + TorvalLang.profile().storageSuffix; }

async function load() {
  const stored = await api.storage.local.get(ankiConfigKey());
  config = stored[ankiConfigKey()] || { fields: {} };
  tagsInput.value = (config.tags || []).join(', ');
  leadInput.value = typeof config.lead === 'number' ? config.lead : '';

  const reply = await api.runtime.sendMessage({ type: 'ankiDescribe', url: config.url });
  if (!reply.ok) return fail(reply.error);

  fill(deckSelect, reply.result.decks, config.deck);
  fill(modelSelect, reply.result.models, config.model);
  await showFields();
}

function fill(select, values, chosen) {
  select.textContent = '';
  for (const value of values) {
    const option = document.createElement('option');
    option.value = option.textContent = value;
    if (value === chosen) option.selected = true;
    select.appendChild(option);
  }
}

async function showFields() {
  const model = modelSelect.value;
  if (!model) return;

  const reply = await api.runtime.sendMessage({ type: 'ankiFields', url: config.url, model });
  if (!reply.ok) return fail(reply.error);

  const names = reply.result;
  // Keep whatever was already chosen for this note type; guess the rest.
  const existing = config.fields || {};
  const known = names.some((n) => existing[n] !== undefined);
  const mapping = known ? existing : TorvalAnki.guessMapping(names);

  mappingBox.textContent = '';
  for (const name of names) {
    const row = document.createElement('label');
    const label = document.createElement('span');
    label.textContent = name;

    const select = document.createElement('select');
    select.dataset.field = name;
    for (const [value, text] of sourceLabels()) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      if (value === (mapping[name] || '')) option.selected = true;
      select.appendChild(option);
    }

    row.append(label, select);
    mappingBox.appendChild(row);
  }
  mappingSection.hidden = false;
}

async function save() {
  const fields = {};
  for (const select of mappingBox.querySelectorAll('select')) {
    fields[select.dataset.field] = select.value;
  }
  config = {
    url: config.url,
    deck: deckSelect.value,
    model: modelSelect.value,
    tags: tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean),
    // Left out entirely when the box is empty, so that "no answer" stays
    // the recorder's own default rather than becoming zero.
    lead: leadInput.value === '' ? undefined : Math.max(0, Math.min(3, Number(leadInput.value) || 0)),
    fields
  };
  await api.storage.local.set({ [ankiConfigKey()]: config });
  statusText.textContent = 'Saved.';
  statusText.className = '';
  setTimeout(() => { statusText.textContent = ''; }, 2000);
}

function fail(message) {
  statusText.textContent = message;
  statusText.className = 'error';
}

// The version on the About page comes from the manifest rather than being
// typed here as well, so there is one place it can be wrong.
const versionEl = document.getElementById('version');
if (versionEl && api.runtime.getManifest) {
  versionEl.textContent = api.runtime.getManifest().version;
}

// The reader is a page rather than a panel, since it is a place to be
// rather than a setting to change.
const reader = document.getElementById('open-reader');
if (reader) {
  reader.addEventListener('click', () => {
    const url = api.runtime.getURL('reader.html');
    if (api.tabs && api.tabs.create) api.tabs.create({ url });
    else window.open(url, '_blank');
  });
}
