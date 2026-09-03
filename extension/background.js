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
// Rows per write. Smaller batches mean shorter transactions and a percentage
// that actually moves, which matters: the import used to jump in whole-chunk
// steps and sat on one number long enough to look frozen.
const BATCH = 5000;

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
    // The pitch diagram is drawn from dictionary data rather than fetched, so
    // it is filled in here; anki.js only has to place it in the right field.
    // Skipped entirely unless the card actually has somewhere to put it.
    const fields = (ankiConfig && ankiConfig.fields) || {};
    if (Object.keys(fields).some((f) => fields[f] === 'pitch')) {
      note = { ...note, pitch: await LLLPitch.graphFor(note.word, note.reading) };
    }
    return LLLAnki.addNote(ankiConfig, note);
  });
}

async function handleLookup(text) {
  if (status.state !== 'ready') return { status, groups: [] };
  try {
    await ready;
    const groups = await LLLLookup.search(text, { getEntries });
    // The accent is one number per word and the table is already in memory, so
    // it costs nothing to answer it here along with the definitions.
    for (const group of groups) {
      for (const hit of group.hits) {
        hit.pitch = await LLLPitch.accentFor(hit.word, hit.reading);
      }
    }
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

/**
 * Copy the dictionary into IndexedDB.
 *
 * This has to survive being killed half way. Firefox shuts a background script
 * down when it looks idle, and grinding through a six megabyte chunk without
 * calling any browser API looks exactly like idling — so an import that had to
 * run start to finish in one go could simply stop, with nothing to show for the
 * work already done.
 *
 * So progress is written down as it happens: after every chunk, a record says
 * how far we got. Being killed then costs one chunk, not the whole import, and
 * the next start picks up where this one left off. Each batch also nudges the
 * badge, which is a browser API call, which is what tells Firefox we are alive.
 */
async function importDictionary(db, meta) {
  const total = meta.entryChunks + meta.indexChunks;
  let progress = await get(db, STATE, 'import');

  if (!progress || progress.version !== meta.version) {
    // Nothing usable to resume: clear out and start again. The 'meta' marker
    // goes first, so an interrupted import is never mistaken for a finished one.
    await run(db, STATE, 'readwrite', (store) => store.delete('meta'));
    await run(db, ENTRIES, 'readwrite', (store) => store.clear());
    await run(db, INDEX, 'readwrite', (store) => store.clear());
    progress = { version: meta.version, entries: 0, index: 0, nextId: 0 };
    await save();
    console.log('LLL: building the dictionary');
  } else {
    console.log(`LLL: resuming — ${progress.entries}/${meta.entryChunks} entry chunks,` +
      ` ${progress.index}/${meta.indexChunks} index chunks already in`);
  }

  report(0);

  // Entry ids are positions in the build output, so the counter has to run
  // unbroken across chunks — which is why it is part of the saved progress.
  for (let i = progress.entries; i < meta.entryChunks; i++) {
    const rows = await fetchJson(`data/entries-${pad(i)}.json`);
    let nextId = progress.nextId;
    const pairs = rows.map((entry) => {
      entry.id = nextId;
      return [nextId++, entry];
    });
    await putAll(db, ENTRIES, pairs, (fraction) => report(fraction));
    progress = { ...progress, entries: i + 1, nextId };
    await save();
  }

  for (let i = progress.index; i < meta.indexChunks; i++) {
    const rows = await fetchJson(`data/index-${pad(i)}.json`);   // [term, ids][]
    await putAll(db, INDEX, rows, (fraction) => report(fraction));
    progress = { ...progress, index: i + 1 };
    await save();
  }

  await run(db, STATE, 'readwrite', (store) => store.put(meta, 'meta'));
  await run(db, STATE, 'readwrite', (store) => store.delete('import'));
  status = { state: 'ready', progress: 1 };
  setBadge('');
  console.log(`LLL: dictionary ready — ${meta.entries} entries, ${meta.terms} forms`);

  function save() {
    return run(db, STATE, 'readwrite', (store) => store.put(progress, 'import'));
  }

  /** `within` is how far through the chunk currently being written we are. */
  function report(within) {
    const done = progress.entries + progress.index + within;
    status = { state: 'loading', progress: done / total };
    setBadge(Math.round((done / total) * 100) + '%');
  }
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

async function putAll(db, storeName, pairs, onProgress) {
  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    await run(db, storeName, 'readwrite', (store) => {
      for (const [key, value] of batch) store.put(value, key);
    });
    if (onProgress) onProgress(Math.min(1, (i + BATCH) / pairs.length));
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
