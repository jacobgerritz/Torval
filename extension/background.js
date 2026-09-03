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
// Catching the caption request YouTube's own player already makes
// ---------------------------------------------------------------------------

/**
 * Every attempt at building this URL ourselves — from the page's own player
 * object, from a freshly re-requested one, from the transcript panel's own
 * endpoint — came back with a 200 and nothing in it. All of them shared one
 * thing: they used the `baseUrl` published in YouTube's own JSON data. The
 * one thing none of them tried was the actual address YouTube's own player
 * uses when it makes a genuine request for the track — which is not
 * guaranteed to be the same string, and evidently is not one.
 *
 * That real address only exists at the moment the player asks for it, so
 * rather than build it, this waits for it: `onBeforeRequest` sees every
 * request the page itself makes, YouTube's own included, and a real one for
 * captions turns up the moment the video actually has a caption track
 * active — which is exactly the state LLL already asks for. Once one is
 * seen, it is handed to that tab's content script to fetch, plainly, with
 * nothing done to it — no special headers, no routing trick. If the address
 * itself was always what was missing, nothing else needed to be.
 *
 * `&lll=1` marks LLL's own re-fetch of that address so it is not mistaken for
 * a second genuine request and forwarded right back again.
 */
if (api.webRequest && api.webRequest.onBeforeRequest) {
  const seenPerTab = new Map();   // tabId -> last captured URL, so as not to repeat one
  api.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;
      if (details.url.indexOf('lll=1') !== -1) return;          // LLL's own re-fetch
      if (details.url.indexOf('signature') === -1) return;       // not a genuine signed track
      if (seenPerTab.get(details.tabId) === details.url) return; // already forwarded this one
      seenPerTab.set(details.tabId, details.url);
      api.tabs.sendMessage(details.tabId, { type: 'timedtextSeen', url: details.url }).catch(() => {});
    },
    { urls: ['https://www.youtube.com/api/timedtext*'] }
  );
}

/**
 * Catching the real address was not, on its own, enough — refetching it from
 * the content script still came back with a 200 and nothing in it, the exact
 * same "blocked by OpaqueResponseBlocking" symptom seen from the very first
 * attempt in this whole saga. That means it was never about which address was
 * being asked for: even a provably genuine one, the one YouTube's own player
 * had just used successfully, was still refused when read from here.
 *
 * So both fixes are needed together, not one instead of the other. This adds
 * the CORS permission the response never carries, before the browser decides
 * whether the read is allowed — the same technique CORS-unblocking extensions
 * use generally, scoped only to the address LLL itself asks for again.
 */
if (api.webRequest && api.webRequest.onHeadersReceived) {
  api.webRequest.onHeadersReceived.addListener(
    (details) => {
      const headers = (details.responseHeaders || [])
        .filter((h) => h.name.toLowerCase() !== 'access-control-allow-origin');
      headers.push({ name: 'Access-Control-Allow-Origin', value: '*' });
      return { responseHeaders: headers };
    },
    { urls: ['https://www.youtube.com/api/timedtext*'] },
    ['blocking', 'responseHeaders']
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

api.runtime.onMessage.addListener((message) => {
  switch (message && message.type) {
    case 'lookup': return handleLookup(message.text);
    case 'status': return Promise.resolve({ status });
    case 'tags':   return loadTags();
    case 'ankiAdd':      return ankiAdd(message.note);
    case 'ankiDuplicate': return ankiDuplicate(message.word);
    case 'ankiDescribe': return guard(() => LLLAnki.describe(message.url));
    case 'ankiFields':   return guard(() => LLLAnki.fieldNames(message.url, message.model));
    case 'extractWords': return guard(() => extractWords(message.text));
    case 'comprehension': return guard(() => comprehension(message.text));
    case 'knownWords':   return guard(() => knownWords());
    case 'knownList':    return guard(() => knownList());
    case 'addKnownWords': return guard(() => addKnownWords(message.words));
    case 'setKnown':     return guard(() => setKnown(message.word, message.known));
    case 'forgetWords':  return guard(() => forgetWords(message.words));
    case 'openOptions':  return guard(async () => { api.runtime.openOptionsPage(); return true; });
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

/**
 * A quick, up-front answer to "do I already have this word?" — asked the
 * moment + is pressed, well before the slower work of capturing the sentence
 * audio even starts, so the answer is not stuck waiting behind it. This never
 * blocks the card being made; it is only a heads-up.
 */
async function ankiDuplicate(word) {
  return guard(async () => {
    const { ankiConfig } = await api.storage.local.get('ankiConfig');
    return LLLAnki.alreadyHave(ankiConfig, { word });
  });
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
    const known = await knownSet();
    // The accent is one number per word and the table is already in memory, so
    // it costs nothing to answer it here along with the definitions.
    for (const group of groups) {
      for (const hit of group.hits) {
        hit.pitch = await LLLPitch.accentFor(hit.word, hit.reading);
        hit.band = LLLLookup.frequencyBand(hit.entry.q);
        hit.shared = LLLLookup.sharedTags(hit.entry);
        hit.sharedPos = LLLLookup.sharedPos(hit.entry);
        hit.known = known.has(hit.word);
      }
    }
    return { status, groups };
  } catch (err) {
    console.error('LLL lookup failed', err);
    return { status: { state: 'error', message: String(err) }, groups: [] };
  }
}

/**
 * A reader that only ever asks the database for a word once.
 *
 * Reading a single hover asks about a few dozen terms; reading a whole page
 * asks about the same few thousand terms over and over, because that is what
 * a language is — は and する and こと turn up on nearly every line. Holding
 * on to the answers for the length of one passage turns almost all of that
 * into no work at all, and is the difference between reading a page in under
 * a second and reading it in a minute.
 */
function cachingReader() {
  const cache = new Map();
  return {
    async getEntries(terms) {
      const missing = terms.filter((term) => !cache.has(term));
      if (missing.length) {
        const found = await getEntries(missing);
        for (const term of missing) cache.set(term, found.get(term) || null);
      }
      const out = new Map();
      for (const term of terms) {
        const entries = cache.get(term);
        if (entries) out.set(term, entries);
      }
      return out;
    }
  };
}

function requireDictionary() {
  if (status.state !== 'ready') {
    throw new Error('The dictionary is still loading — try again in a moment.');
  }
  return ready;
}

/** Every dictionary word in a passage of text — see LLLLookup.extractWords. */
async function extractWords(text) {
  await requireDictionary();
  return LLLLookup.extractWords(text, cachingReader());
}

/**
 * How much of this passage is made of words already known.
 *
 * `counts` is handed back along with the score so that marking one more word
 * known can move the number straight away — a word's count is exactly how much
 * the total shifts — rather than needing the whole page read again.
 */
async function comprehension(text) {
  await requireDictionary();
  const tokens = await LLLLookup.extractTokens(text, cachingReader());
  return LLLLookup.coverage(tokens, await knownSet());
}

// ---------------------------------------------------------------------------
// Known words
// ---------------------------------------------------------------------------

// Stored as word -> when it was first marked known. Kept as an object rather
// than a list because the question asked of it is almost always "is this one
// in there", and because the date is what makes the list browsable in any
// order more useful than alphabetical.
let knownCache = null;   // Set of words, or null when it needs reading again

// Read once and held, because a lookup asks about it on every single hover.
// Any write clears it — including one made from the settings page, which
// storage.onChanged is what catches.
async function knownSet() {
  if (!knownCache) {
    const stored = await api.storage.local.get('knownWords');
    knownCache = new Set(Object.keys(stored.knownWords || {}));
  }
  return knownCache;
}

if (api.storage.onChanged) {
  api.storage.onChanged.addListener((changes) => {
    if (changes.knownWords) knownCache = null;
  });
}

async function knownMap() {
  const stored = await api.storage.local.get('knownWords');
  return stored.knownWords || {};
}

async function saveKnown(map) {
  await api.storage.local.set({ knownWords: map });
  knownCache = new Set(Object.keys(map));
  return Object.keys(map).length;
}

/** Every known word, and how many there are. */
async function knownWords() {
  const words = Array.from(await knownSet());
  return { words, count: words.length };
}

/** The same list with the date each was learned, newest first, for browsing. */
async function knownList() {
  const map = await knownMap();
  return Object.keys(map)
    .map((word) => ({ word, added: map[word] }))
    .sort((a, b) => b.added - a.added);
}

/** Add words to the known set. Already-known ones are left alone. */
async function addKnownWords(words) {
  const map = await knownMap();
  let added = 0;
  for (const word of words) {
    if (!map[word]) { map[word] = Date.now(); added++; }
  }
  return { added, total: await saveKnown(map) };
}

/** Mark one word known, or unmark it — what the popup's tick does. */
async function setKnown(word, isKnown) {
  const map = await knownMap();
  if (isKnown) { if (!map[word]) map[word] = Date.now(); }
  else delete map[word];
  return { word, known: !!isKnown, total: await saveKnown(map) };
}

/** Take words back out of the known set. */
async function forgetWords(words) {
  const map = await knownMap();
  let removed = 0;
  for (const word of words) {
    if (map[word]) { delete map[word]; removed++; }
  }
  return { removed, total: await saveKnown(map) };
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
