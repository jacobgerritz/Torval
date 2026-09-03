/*
 * LLL — settings
 *
 * Deck and note type are read live from Anki rather than typed, so a name can
 * never be slightly wrong. The field mapping is offered pre-filled by guessing
 * from the field names; anything guessed wrongly is one dropdown away.
 */

'use strict';

const api = globalThis.browser || globalThis.chrome;

const SOURCE_LABELS = [
  ['', '—'],
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
const mappingBox = document.getElementById('mapping');
const mappingSection = document.getElementById('mapping-section');
const statusText = document.getElementById('status');

let config = {};

load();

async function load() {
  const stored = await api.storage.local.get('ankiConfig');
  config = stored.ankiConfig || { fields: {} };
  tagsInput.value = (config.tags || []).join(', ');

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
