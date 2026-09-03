/*
 * LLL — background
 *
 * This is the part of the extension that owns the dictionary. It runs once for
 * the whole browser, not once per tab, which matters: 218,000 entries should be
 * loaded one time, not on every page you open.
 *
 * On first run it streams the JSON chunks built by tools/build-dict.mjs into
 * IndexedDB — the browser's own on-disk database. That takes a minute or so and
 * only ever happens once. After that every lookup is a couple of disk reads.
 *
 * Pages talk to it by message: content.js sends the text under the cursor and
 * gets back the matches.
 */

'use strict';

const api = globalThis.browser || globalThis.chrome;

const DB_NAME = 'lll-dictionary';
const DB_VERSION = 1;
const ENTRIES = 'entries';
const INDEX = 'index';
const STATE = 'state';
const BATCH = 20000;   // rows per write; keeps memory flat during the import

let ready = null;              // promise for the open, populated database
let tagsPromise = null;
let status = { state: 'starting', progress: 0 };

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

api.runtime.onMessage.addListener((message) => {
  switch (message && message.type) {
    case 'lookup': return handleLookup(message.text);
    case 'status': return Promise.resolve({ status });
    case 'tags':   return loadTags();
    case 'ankiAdd':      return ankiAdd(message.note);
    case 'ankiDescribe': return guard(() => LLLAnki.describe(message.url));
    case 'ankiFields':   return guard(() => LLLAnki.fieldNames(message.url, message.model));
    default:       return undefined;
  }
});

// The toolbar button is the way in to the settings.
if (api.action && api.action.onClicked) {
  api.action.onClicked.addListener(() => api.runtime.openOptionsPage());
}

/** Run an Anki call and hand back its failure as text rather than throwing. */
async function guard(fn) {
  try { return { ok: true, result: await fn() }; }
  catch (err) { return { ok: false, error: err.message }; }
}

async function ankiAdd(note) {
  return guard(async () => {
    const { ankiConfig } = await api.storage.local.get('ankiConfig');
    return LLLAnki.addNote(ankiConfig, note);
  });
}

async function handleLookup(text) {
  if (status.state !== 'ready') return { status, groups: [] };
  try {
    await ready;
    const groups = await LLLLookup.search(text, { getEntries });
    return { status, groups };
  } catch (err) {
    console.error('LLL lookup failed', err);
    return { status: { state: 'error', message: String(err) }, groups: [] };
  }
}

function loadTags() {
  if (!tagsPromise) tagsPromise = fetchJson('data/tags.json');
  return tagsPromise;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Look up many terms at once. Returns Map<term, entry[]>.
 *
 * Two steps, because the data is stored the same way a book index is: the
 * `index` store maps a written form to entry numbers, and the `entries` store
 * holds the entries themselves. Storing it this way means a word with three
 * spellings is kept once, not three times.
 */
async function getEntries(terms) {
  const db = await ready;

  const idsByTerm = new Map();
  await run(db, INDEX, 'readonly', (store) => {
    for (const term of terms) {
      const req = store.get(term);
      req.onsuccess = () => { if (req.result) idsByTerm.set(term, req.result); };
    }
  });

  const wanted = new Set();
  idsByTerm.forEach((ids) => ids.forEach((id) => wanted.add(id)));

  const byId = new Map();
  await run(db, ENTRIES, 'readonly', (store) => {
    wanted.forEach((id) => {
      const req = store.get(id);
      req.onsuccess = () => { if (req.result) byId.set(id, req.result); };
    });
  });

  const out = new Map();
  idsByTerm.forEach((ids, term) => {
    const entries = ids.map((id) => byId.get(id)).filter(Boolean);
    if (entries.length) out.set(term, entries);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

ready = start();
ready.catch((err) => {
  console.error('LLL failed to start', err);
  status = { state: 'error', message: String(err) };
  setBadge('!');
});

async function start() {
  const db = await openDatabase();
  const meta = await fetchJson('data/meta.json');
  const installed = await get(db, STATE, 'meta');

  if (installed && installed.version === meta.version) {
    status = { state: 'ready', progress: 1 };
    setBadge('');
    return db;
  }

  await importDictionary(db, meta);
  return db;
}

async function importDictionary(db, meta) {
  status = { state: 'loading', progress: 0 };
  setBadge('0%');

  // Clear the marker first. If the import is interrupted half way, the next
  // start sees no marker and simply does it again rather than serving a
  // half-built dictionary.
  await run(db, STATE, 'readwrite', (store) => store.delete('meta'));
  await run(db, ENTRIES, 'readwrite', (store) => store.clear());
  await run(db, INDEX, 'readwrite', (store) => store.clear());

  const total = meta.entryChunks + meta.indexChunks;
  let done = 0;
  const advance = () => {
    done++;
    status = { state: 'loading', progress: done / total };
    setBadge(Math.round((done / total) * 100) + '%');
  };

  // Entry ids are simply positions in the build output, so the counter has to
  // run unbroken across the chunks and they have to be read in order.
  let nextId = 0;
  for (let i = 0; i < meta.entryChunks; i++) {
    const rows = await fetchJson(`data/entries-${pad(i)}.json`);
    const pairs = rows.map((entry) => {
      entry.id = nextId;
      return [nextId++, entry];
    });
    await putAll(db, ENTRIES, pairs);
    advance();
  }

  for (let i = 0; i < meta.indexChunks; i++) {
    const rows = await fetchJson(`data/index-${pad(i)}.json`);   // [term, ids][]
    await putAll(db, INDEX, rows);
    advance();
  }

  await run(db, STATE, 'readwrite', (store) => store.put(meta, 'meta'));
  status = { state: 'ready', progress: 1 };
  setBadge('');
  console.log(`LLL: dictionary ready — ${meta.entries} entries, ${meta.terms} forms`);
}

// ---------------------------------------------------------------------------
// IndexedDB helpers. Its callback style is old; these wrap it in promises.
// ---------------------------------------------------------------------------

function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [ENTRIES, INDEX, STATE]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run `work` inside a transaction and resolve when the transaction commits. */
function run(db, storeName, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    work(tx.objectStore(storeName));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function get(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putAll(db, storeName, pairs) {
  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    await run(db, storeName, 'readwrite', (store) => {
      for (const [key, value] of batch) store.put(value, key);
    });
  }
}

// ---------------------------------------------------------------------------

async function fetchJson(path) {
  const res = await fetch(api.runtime.getURL(path));
  if (!res.ok) throw new Error(`cannot read ${path} (${res.status}) — run: node tools/build-dict.mjs`);
  return res.json();
}

function pad(n) { return String(n).padStart(3, '0'); }

function setBadge(text) {
  if (!api.action || !api.action.setBadgeText) return;
  api.action.setBadgeText({ text }).catch(() => {});
}
