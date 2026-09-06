/*
 * LLL, settings
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

// Opened with #known, what the bar's ⚙ could later point straight at, and what
// makes the word list linkable rather than only reachable by clicking.
showPanel(location.hash === '#known' ? 'known' : 'anki');

// -------------------------------------------------------------------------
// Anki
// -------------------------------------------------------------------------

const SOURCE_LABELS = [
  ['', ', '],
  ['word', 'Target word'],
  ['reading', 'Reading'],
  ['sentence', 'Sentence'],
  ['definition', 'Definition'],
  ['audio', 'Word audio'],
  ['pitch', 'Pitch accent'],
  ['image', 'Video frame'],
  ['sentenceAudio', 'Sentence audio']
];

const deckSelect = document.getElementById('deck');
const modelSelect = document.getElementById('model');
const tagsInput = document.getElementById('tags');
const leadInput = document.getElementById('lead');
const mappingBox = document.getElementById('mapping');
const mappingSection = document.getElementById('mapping-section');
const statusText = document.getElementById('status');

let config = {};

load();

async function load() {
  const stored = await api.storage.local.get('ankiConfig');
  config = stored.ankiConfig || { fields: {} };
  tagsInput.value = (config.tags || []).join(', ');
  leadInput.value = typeof config.lead === 'number' ? config.lead : '';

  const reply = await api.runtime.sendMessage({ type: 'ankiDescribe', url: config.url });
  if (!reply.ok) return fail(reply.error);

  fill(deckSelect, reply.result.decks, config.deck);
  fill(modelSelect, reply.result.models, config.model);
  await showFields();

  deckSelect.addEventListener('change', () => { config.deck = deckSelect.value; });
  modelSelect.addEventListener('change', () => { config.fields = {}; showFields(); });
  document.getElementById('save').addEventListener('click', save);
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
  const mapping = known ? existing : LLLAnki.guessMapping(names);

  mappingBox.textContent = '';
  for (const name of names) {
    const row = document.createElement('label');
    const label = document.createElement('span');
    label.textContent = name;

    const select = document.createElement('select');
    select.dataset.field = name;
    for (const [value, text] of SOURCE_LABELS) {
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
  await api.storage.local.set({ ankiConfig: config });
  statusText.textContent = 'Saved.';
  statusText.className = '';
  setTimeout(() => { statusText.textContent = ''; }, 2000);
}

function fail(message) {
  statusText.textContent = message;
  statusText.className = 'error';
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
