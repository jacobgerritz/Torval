/*
 * LLL, background
 *
 * This is the part of the extension that owns the dictionary. It runs once for
 * the whole browser, not once per tab, which matters: 218,000 entries should be
 * loaded one time, not on every page you open.
 *
 * On first run it streams the JSON chunks built by tools/build-dict.mjs into
 * IndexedDB, the browser's own on-disk database. That takes a minute or so and
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
 * Every attempt at building this URL ourselves, from the page's own player
 * object, from a freshly re-requested one, from the transcript panel's own
 * endpoint, came back with a 200 and nothing in it. All of them shared one
 * thing: they used the `baseUrl` published in YouTube's own JSON data. The
 * one thing none of them tried was the actual address YouTube's own player
 * uses when it makes a genuine request for the track, which is not
 * guaranteed to be the same string, and evidently is not one.
 *
 * That real address only exists at the moment the player asks for it, so
 * rather than build it, this waits for it: `onBeforeRequest` sees every
 * request the page itself makes, YouTube's own included, and a real one for
 * captions turns up the moment the video actually has a caption track
 * active, which is exactly the state LLL already asks for. Once one is
 * seen, it is handed to that tab's content script to fetch, plainly, with
 * nothing done to it, no special headers, no routing trick. If the address
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
 * Catching the real address was not, on its own, enough, refetching it from
 * the content script still came back with a 200 and nothing in it, the exact
 * same "blocked by OpaqueResponseBlocking" symptom seen from the very first
 * attempt in this whole saga. That means it was never about which address was
 * being asked for: even a provably genuine one, the one YouTube's own player
 * had just used successfully, was still refused when read from here.
 *
 * So both fixes are needed together, not one instead of the other. This adds
 * the CORS permission the response never carries, before the browser decides
 * whether the read is allowed, the same technique CORS-unblocking extensions
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

/**
 * Tell a page how far through reading it we are.
 *
 * Reading a long page is several seconds of work, and several seconds of
 * "Reading this page…" with nothing moving looks exactly like nothing
 * happening. Sent at most five times a second: the point is to show that
 * something is going on, not to be exact about it.
 */
function reporting(sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  if (typeof tabId !== 'number') return undefined;
  let said = 0;
  return (done, total) => {
    const now = Date.now();
    if (now - said < 200 || !total) return;
    said = now;
    api.tabs.sendMessage(tabId, { type: 'reading', done, total }).catch(() => {});
  };
}

api.runtime.onMessage.addListener((message, sender) => {
  switch (message && message.type) {
    case 'lookup': return handleLookup(message.text, message.point);
    case 'status': return Promise.resolve({ status });
    case 'tags':   return loadTags();
    case 'ankiAdd':      return ankiAdd(message.note);
    case 'ankiDuplicate': return ankiDuplicate(message.word);
    case 'ankiBrowse':   return guard(() => ankiBrowse(message.word));
    case 'ankiDescribe': return guard(() => LLLAnki.describe(message.url));
    case 'ankiFields':   return guard(() => LLLAnki.fieldNames(message.url, message.model));
    case 'extractWords': return guard(() => extractWords(message.text));
    case 'comprehension': return guard(() => comprehension(message.text, reporting(sender)));
    case 'wordPlaces':   return guard(() => wordPlaces(message.text, message.before, message.after,
      // A subtitle line is thirty characters and answers instantly. Only a
      // page is worth saying anything about.
      message.text.length > 2000 ? reporting(sender) : undefined));
    case 'knownList':    return guard(() => wordList(KNOWN));
    case 'ignoredList':  return guard(() => wordList(IGNORED));
    case 'addKnownWords': return guard(() => addKnownWords(message.words));
    case 'setKnown':     return guard(() => setWordOn(KNOWN, message.word, message.known));
    case 'setIgnored':   return guard(() => setWordOn(IGNORED, message.word, message.ignored));
    case 'forgetWords':  return guard(() => forgetFrom(KNOWN, message.words));
    case 'forgetIgnored': return guard(() => forgetFrom(IGNORED, message.words));
    case 'exportWords':  return guard(() => exportWords());
    case 'importWords':  return guard(() => importWords(message.data));
    case 'openOptions':  return guard(async () => { api.runtime.openOptionsPage(); return true; });
    default:
      // Saying so out loud. A message with no case here simply never answers,
      // and the caller's `await` sits there for ever, which is exactly how a
      // whole feature can be wired up, look right in every preview, and do
      // nothing at all once installed.
      if (message && message.type) console.warn('LLL: no handler for message', message.type);
      return undefined;
  }
});

// The toolbar button is the way in to the settings.
// The toolbar button opens switch.html, so this only matters where a popup
// cannot be shown at all.
if (api.action && api.action.onClicked) {
  api.action.onClicked.addListener(() => api.runtime.openOptionsPage());
}

/** Run an Anki call and hand back its failure as text rather than throwing. */
async function guard(fn) {
  try { return { ok: true, result: await fn() }; }
  catch (err) { return { ok: false, error: err.message }; }
}

/**
 * A quick, up-front answer to "do I already have this word?", asked the
 * moment + is pressed, well before the slower work of capturing the sentence
 * audio even starts, so the answer is not stuck waiting behind it. This never
 * blocks the card being made; it is only a heads-up.
 */
/** Open Anki's card browser on a word. */
async function ankiBrowse(word) {
  const stored = await api.storage.local.get('ankiConfig');
  return LLLAnki.browse(stored.ankiConfig || {}, word);
}

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

/**
 * `point`, when given, is the index of the character actually pointed at
 * within `text`, not necessarily where the word itself begins. A hover or a
 * click lands wherever the cursor happens to be, which is the middle of a
 * word at least as often as the start of one, and reading forward only from
 * that exact character would find whatever shorter, unrelated thing merely
 * starts there rather than the word that is actually there. Every plausible
 * earlier starting point is tried instead, and `start` in the reply says
 * which one won, so the content script can correct the sentence context and
 * the hover mark to the word's real beginning rather than wherever the
 * cursor was.
 *
 * Left out entirely, `text` is searched exactly as given, from its own
 * start, what an explicit selection wants, since it was chosen on purpose.
 */
async function handleLookup(text, point) {
  if (status.state !== 'ready') return { status, groups: [] };
  try {
    await ready;
    // Which word the cursor is in, decided by reading the sentence rather
    // than by matching from wherever the pointer happens to sit. The length
    // travels with it so the popup leads with the same word the page is
    // marked with: 今日は暑い is 今日 and は, and a hover on it should not
    // answer with the greeting just because the greeting is longer.
    const found = typeof point === 'number'
      ? await LLLLookup.hover(text, point, hoverReader)
      : { start: 0, groups: await LLLLookup.search(text, hoverReader) };
    const start = found.start;
    const groups = found.groups;
    const known = await knownSet();
    const ignored = await ignoredSet();
    // The accent is one number per word and the table is already in memory, so
    // it costs nothing to answer it here along with the definitions.
    for (const group of groups) {
      for (const hit of group.hits) {
        hit.pitch = await LLLPitch.accentFor(hit.word, hit.reading);
        hit.band = LLLLookup.frequencyBand(hit.q);
        hit.shared = LLLLookup.sharedTags(hit.entry);
        hit.sharedPos = LLLLookup.sharedPos(hit.entry);
        hit.known = known.has(hit.word);
        hit.ignored = ignored.has(hit.word);
      }
    }
    return { status, groups, start };
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
 * a language is, は and する and こと turn up on nearly every line. Holding
 * on to the answers for the length of one passage turns almost all of that
 * into no work at all, and is the difference between reading a page in under
 * a second and reading it in a minute.
 */
// How many terms a reader holds before it starts again. A page read is over
// long before this matters; the one kept for hovering would otherwise grow
// for as long as the browser is open. Forgetting everything at once is
// cruder than forgetting the oldest, and costs one slow hover an hour.
const CACHE_LIMIT = 20000;

function cachingReader() {
  const cache = new Map();
  return {
    // Handed on to the reading, which uses it to drop a shape it was about to
    // ask about before it goes anywhere near a map or a message. See termsAt.
    mightKnow: mightKnow,
    async getEntries(terms) {
      const missing = terms.filter((term) => !cache.has(term));
      if (missing.length) {
        if (cache.size > CACHE_LIMIT) cache.clear();
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

// Hovering asks about the same words over and over: the same line as the
// cursor moves along it, and the same handful of particles on every line
// after that. One reader kept for all of them turns nearly every hover into
// no database work at all.
const hoverReader = cachingReader();

function requireDictionary() {
  if (status.state !== 'ready') {
    throw new Error('The dictionary is still loading, try again in a moment.');
  }
  return ready;
}

/** Every dictionary word in a passage of text, see LLLLookup.extractWords. */
async function extractWords(text) {
  await requireDictionary();
  return LLLLookup.extractWords(text, cachingReader());
}

/**
 * How much of this passage is made of words already known.
 *
 * `counts` is handed back along with the score so that marking one more word
 * known can move the number straight away, a word's count is exactly how much
 * the total shifts, rather than needing the whole page read again.
 */
async function comprehension(text, say) {
  await requireDictionary();
  const reader = cachingReader();
  const tokens = await LLLLookup.locateTokens(text, reader, say);
  const known = await effectiveKnown(text, tokens, reader, await knownSet());
  return LLLLookup.coverage(tokens, known, await ignoredSet());
}

/**
 * The stored known set, plus any expression that is not itself marked known
 * but decomposes entirely into pieces that are, see decomposeKnown in
 * lookup.js for why this is restricted to entries JMdict tags as an
 * expression, and never touches ordinary vocabulary.
 *
 * A passage rarely has many distinct expressions in it even when it has many
 * words, so each distinct one is only ever checked once no matter how many
 * times it is said.
 */
async function effectiveKnown(text, tokens, reader, known) {
  const checked = new Map();   // word -> already decided true/false this read
  let extra = null;
  for (const token of tokens) {
    if (!token.expression || known.has(token.word) || checked.has(token.word)) continue;
    const ok = await LLLLookup.decomposeKnown(text, token.start, token.length, reader, known);
    checked.set(token.word, ok);
    if (ok) { if (!extra) extra = new Set(known); extra.add(token.word); }
  }
  return extra || known;
}

/**
 * The same reading, plus exactly where on the page each word was, what
 * colouring the unknown words needs.
 *
 * Positions are grouped by word rather than listed one after another, because
 * every question asked of them afterwards is asked about a word: which places
 * to mark, and which places stop being marked the moment that word is ticked
 * as known. Each word's positions are a flat run of start, length, group,
 * repeated, a list of triples, without an object per one, because a dense
 * page has thousands of them and they are only ever read in order.
 *
 * `group` alternates 0 and 1 across the whole passage in reading order,
 * regardless of which word each occurrence belongs to, two words sitting
 * right against each other with nothing marking where one ends and the next
 * begins (関東 then 沿岸部, touching) would otherwise look like a single
 * unbroken word. Painted in two slightly different shades, the seam between
 * them is visible even with no space to put it in. It is fixed at read time
 * rather than recomputed when a word is later marked known, so ticking one
 * word does not shuffle the colour of every unrelated word after it.
 */
async function wordPlaces(text, before, after, say) {
  await requireDictionary();
  const reader = cachingReader();
  // Read with whatever came before and after, so that a line cut mid-word,
  // which automatic captions do constantly, is still read as the word it is.
  // Only the words starting inside this line are kept.
  const lead = String(before || '').slice(-CONTEXT);
  const trail = String(after || '').slice(0, CONTEXT);
  const whole = lead + text + trail;
  const found = await LLLLookup.locateTokens(whole, reader, say);
  const tokens = LLLLookup.within(found, lead.length, text.length);
  const known = await effectiveKnown(text, tokens, reader, await knownSet());
  const ignored = await ignoredSet();

  const places = {};
  // Words that get no mark on the page. Two quite different reasons to be on
  // this list, you know it, or you have said you never want to be told about
  // it, but the page only ever asks the one question, so they arrive as one
  // list rather than two the caller would have to merge itself.
  const unmarked = [];
  tokens.forEach((token, i) => {
    if (!places[token.word]) {
      places[token.word] = [];
      if (ignored.has(token.word) || LLLLookup.isKnown(token, known)) unmarked.push(token.word);
    }
    places[token.word].push(token.start, token.length, i % 2);
  });

  // The score comes back too. This is the same passage the bar is asking
  // about, and reading a page twice over to answer two questions about it
  // would be silly.
  const score = LLLLookup.coverage(tokens, known, ignored);
  return { total: score.total, known: score.known, counts: score.counts, places, unmarked };
}

// ---------------------------------------------------------------------------
// Known and ignored words
// ---------------------------------------------------------------------------

/*
 * Two lists of the same shape, word -> when it was put there. Objects rather
 * than lists because the question asked of them is nearly always "is this one
 * in there", and because the date is what makes them browsable in an order
 * more useful than alphabetical.
 *
 *   known    you understand it, so it counts toward comprehension
 *   ignored  you never want to be told about it, a name, a piece of English,
 *            something the dictionary read wrongly. It leaves the question
 *            entirely rather than counting either way, because counting it
 *            unknown would say a page is harder than it is and counting it
 *            known would say the opposite.
 *
 * A word is one or the other or neither, never both: putting it on one list
 * takes it off the other.
 */
// How much of the lines either side of a subtitle to read along with it.
// Enough to finish a word that was cut in half, not so much that the line
// takes noticeably longer to read.
const CONTEXT = 24;

const KNOWN = 'knownWords';
const IGNORED = 'ignoredWords';

/*
 * The word lists are the one thing in LLL that cannot be rebuilt, and every
 * change to them is a read, an edit and a write of the whole list. That shape
 * has two ways of losing everything, and both of them have to be closed.
 *
 * The first is a read that comes back empty when it should not have. Storage
 * answering with nothing looks exactly like an empty list, and writing the
 * edit then replaces months of reading with one word. So the number of words
 * in each list is kept alongside it, and a read that comes back empty while
 * that number says otherwise is treated as the failure it is: nothing is
 * written and the caller is told.
 *
 * The second is two changes at once. Marking a word while the settings page
 * removes another means both read the same list and the second write undoes
 * the first. Every change to a list now waits its turn.
 *
 * And a copy of each list is kept under its own name, so that a list going
 * missing on its own is something to recover from at the next start rather
 * than something to notice weeks later.
 */
const COUNTS = 'wordCounts';
const SAFE = { [KNOWN]: 'knownWordsCopy', [IGNORED]: 'ignoredWordsCopy' };

// Read once and held, because a lookup asks about them on every single hover.
// Any write clears the copy, including one made from the settings page, which
// storage.onChanged is what catches.
const caches = {};

// Changes to the lists happen one at a time, in the order they were asked for.
let turn = Promise.resolve();

function inTurn(work) {
  const mine = turn.then(work, work);
  turn = mine.then(() => {}, () => {});
  return mine;
}

async function wordSet(key) {
  if (!caches[key]) {
    const stored = await api.storage.local.get(key);
    caches[key] = new Set(Object.keys(stored[key] || {}));
  }
  return caches[key];
}

function knownSet() { return wordSet(KNOWN); }
function ignoredSet() { return wordSet(IGNORED); }

if (api.storage.onChanged) {
  api.storage.onChanged.addListener((changes) => {
    for (const key of Object.keys(changes)) delete caches[key];
    if (changes.off) netflixHelper(!changes.off.newValue);
  });
}

// ---------------------------------------------------------------------------
// Netflix
// ---------------------------------------------------------------------------

/**
 * Put netflix-page.js into Netflix's own page.
 *
 * It has to run there, as page code, rather than beside the page as every
 * other content script does; the file itself says why. Getting it there took
 * three failed goes. Declaring it in the manifest with `"world": "MAIN"` did
 * nothing at all, on a Firefox new enough to support that, most likely
 * because Firefox rejects the whole content_scripts entry over the property
 * rather than ignoring it. Adding a <script> tag from a content script did
 * nothing either, near certainly stopped by Netflix's content security
 * policy. Reaching into the page from a content script instead did run, and
 * broke the site.
 *
 * Registering it from here, through the scripting API, is the fourth way and
 * the one that other tools use. The same property the manifest would not
 * take is accepted here.
 *
 * It follows the switch on the toolbar button. Turning LLL off takes the
 * script off Netflix altogether, so if it ever misbehaves on Netflix's own
 * pages there is a way out that does not involve uninstalling anything.
 */
const NETFLIX_HELPER = {
  id: 'lll-netflix-page',
  js: ['netflix-page.js'],
  matches: ['*://*.netflix.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: true,
  persistAcrossSessions: true
};

async function netflixHelper(on) {
  if (!api.scripting || !api.scripting.registerContentScripts) {
    console.warn('LLL: this browser has no way to run LLL’s Netflix helper, ' +
      'so Netflix will read its subtitles off the screen.');
    return;
  }
  try {
    const already = await api.scripting.getRegisteredContentScripts({ ids: [NETFLIX_HELPER.id] });
    if (!on) {
      if (already.length) await api.scripting.unregisterContentScripts({ ids: [NETFLIX_HELPER.id] });
      return;
    }
    if (already.length) await api.scripting.updateContentScripts([NETFLIX_HELPER]);
    else await api.scripting.registerContentScripts([NETFLIX_HELPER]);
  } catch (err) {
    console.warn('LLL: could not put LLL’s Netflix helper on the page:', err && err.message);
  }
}

api.storage.local.get('off')
  .then((stored) => netflixHelper(!stored.off))
  .catch(() => netflixHelper(true));

/**
 * One list, as it is on disk.
 *
 * Throws rather than answering with an empty list when there should be words
 * in it. Everything above this reads a list, changes it and writes the whole
 * thing back, so an empty answer here is a wiped list one line later.
 */
async function wordMap(key) {
  const stored = await api.storage.local.get([key, COUNTS]);
  const map = stored[key];
  const expected = (stored[COUNTS] || {})[key] || 0;
  const have = map && typeof map === 'object' ? Object.keys(map).length : -1;

  if (have < 0 && expected > 0) {
    throw new Error('Your word list did not come back from storage, so nothing was changed. Try again in a moment.');
  }
  if (have === 0 && expected > 0) {
    throw new Error('Your word list came back empty when it should have ' + expected +
      ' words in it, so nothing was changed. Try again in a moment.');
  }
  return have > 0 ? map : {};
}

/**
 * Write one list, its size, and the copy kept in case the list itself goes
 * missing. One call, so the three cannot disagree.
 */
async function saveWords(key, map) {
  const counts = (await api.storage.local.get(COUNTS))[COUNTS] || {};
  counts[key] = Object.keys(map).length;
  await api.storage.local.set({ [key]: map, [COUNTS]: counts, [SAFE[key]]: map });
  caches[key] = new Set(Object.keys(map));
  return counts[key];
}

/**
 * A list that has gone missing, put back from its copy at the next start.
 *
 * Only a list that is missing or empty when it should not be. Emptying a list
 * on purpose leaves a count of nothing, which is left exactly as it is.
 */
async function rescueLists() {
  const stored = await api.storage.local.get([KNOWN, IGNORED, SAFE[KNOWN], SAFE[IGNORED], COUNTS]);
  const counts = stored[COUNTS] || {};
  for (const key of [KNOWN, IGNORED]) {
    const live = stored[key];
    const copy = stored[SAFE[key]];
    if (live && Object.keys(live).length) continue;
    if (!copy || !Object.keys(copy).length) continue;
    if (counts[key] === 0) continue;   // emptied on purpose
    await api.storage.local.set({ [key]: copy });
    delete caches[key];
    console.warn('LLL: the ' + key + ' list was missing and has been put back from its copy, ' +
      Object.keys(copy).length + ' words');
  }
}

/** One list, with the date each word joined it, newest first, for browsing. */
async function wordList(key) {
  const map = await wordMap(key);
  return Object.keys(map)
    .map((word) => ({ word, added: map[word] }))
    .sort((a, b) => b.added - a.added);
}

/** Add words to the known list. Ones already on it are left alone. */
async function addKnownWords(words) {
  return inTurn(async () => {
    const map = await wordMap(KNOWN);
    let added = 0;
    for (const word of words) {
      if (!map[word]) { map[word] = Date.now(); added++; }
    }
    return { added, total: await saveWords(KNOWN, map) };
  });
}

/**
 * Put one word on a list or take it off, what the popup's ✓ and ⊘ do, and
 * what 2 and 3 do from the keyboard. Going on one list comes off the other,
 * since "I know this" and "never mention this again" cannot both be true.
 */
async function setWordOn(key, word, on) {
  return inTurn(async () => {
    const map = await wordMap(key);
    if (on) { if (!map[word]) map[word] = Date.now(); }
    else delete map[word];
    const total = await saveWords(key, map);

    if (on) {
      const other = key === KNOWN ? IGNORED : KNOWN;
      const otherMap = await wordMap(other);
      if (otherMap[word]) { delete otherMap[word]; await saveWords(other, otherMap); }
    }
    return { word, on: !!on, total };
  });
}

/**
 * Both lists, with the dates, as one plain object to save somewhere safe.
 *
 * This is the part of LLL that cannot be rebuilt. The dictionary can be
 * downloaded again and the settings retyped in a minute, but a known list is
 * however many months of reading, and until now it existed in exactly one
 * place, this browser profile, belonging to an add-on that has to be loaded
 * again by hand every time Firefox restarts.
 */
async function exportWords() {
  return {
    format: 'lll-words',
    version: 1,
    saved: new Date().toISOString(),
    known: await wordMap(KNOWN),
    ignored: await wordMap(IGNORED)
  };
}

/**
 * Put a saved copy back, adding to what is already here rather than replacing
 * it. Merging is the safe direction: restoring an old copy onto a newer list
 * should never be able to lose the words learned since, and someone reading
 * on two machines can carry a file between them without either one winning.
 *
 * A word cannot be on both lists, so if a file somehow says otherwise, known
 * wins, it is the answer that costs less to be wrong about, since an ignored
 * word is one you have said you never want to see again.
 */
async function importWords(data) {
  if (!data || typeof data !== 'object') throw new Error('That file is not a saved word list.');
  if (data.format !== 'lll-words') throw new Error('That is not a file LLL saved.');

  return inTurn(async () => merged(data));
}

async function merged(data) {
  const known = await wordMap(KNOWN);
  const ignored = await wordMap(IGNORED);
  const added = { known: 0, ignored: 0 };

  const merge = (into, from, count) => {
    if (!from || typeof from !== 'object') return;
    for (const word of Object.keys(from)) {
      const when = Number(from[word]);
      if (!word || !Number.isFinite(when)) continue;
      if (!into[word]) { into[word] = when; added[count]++; }
      else into[word] = Math.min(into[word], when);   // keep the earlier date
    }
  };
  merge(known, data.known, 'known');
  merge(ignored, data.ignored, 'ignored');
  for (const word of Object.keys(known)) delete ignored[word];

  return {
    added,
    known: await saveWords(KNOWN, known),
    ignored: await saveWords(IGNORED, ignored)
  };
}

/*
 * A copy of the word lists, in the Downloads folder, once a day.
 *
 * Everything else LLL keeps lives inside the extension: the lists, the deck
 * settings, the dictionary. When that goes, it all goes at once, which is
 * what a browser restart can do to an add-on loaded from about:debugging.
 * The dictionary downloads again and the settings are a minute of typing,
 * but a known list is months of reading, so it is written out where nothing
 * about the extension can reach it.
 *
 * Once a day at most, and only when there is something to save. The file is
 * named for the day, so a week of them is a week of files rather than a
 * thousand, and the newest is always the one to load back.
 */
const LAST_COPY = 'wordsCopiedOn';

async function keepACopy() {
  if (!api.downloads || !api.downloads.download) return;
  const today = new Date().toISOString().slice(0, 10);
  const stored = await api.storage.local.get([LAST_COPY, COUNTS]);
  if (stored[LAST_COPY] === today) return;

  const counts = stored[COUNTS] || {};
  if (!counts[KNOWN] && !counts[IGNORED]) return;   // nothing worth keeping yet

  const words = await exportWords();
  const blob = new Blob([JSON.stringify(words)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    await api.downloads.download({
      url,
      filename: 'LLL/lll-words-' + today + '.json',
      conflictAction: 'overwrite',
      saveAs: false
    });
    await api.storage.local.set({ [LAST_COPY]: today });
    console.log('LLL: kept a copy of your words in Downloads/LLL');
  } catch (err) {
    console.warn('LLL: could not keep a copy of your words:', err && err.message);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

/** Take words back off a list. */
async function forgetFrom(key, words) {
  return inTurn(async () => {
    const map = await wordMap(key);
    let removed = 0;
    for (const word of words) {
      if (map[word]) { delete map[word]; removed++; }
    }
    return { removed, total: await saveWords(key, map) };
  });
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
/**
 * Look up a batch of terms: which entries each one names, then the entries.
 *
 * Both halves ride in one transaction. They have to happen in order, since
 * the entry numbers are not known until the index has answered, but a
 * transaction stays open as long as requests keep being made inside it, so
 * the second half can be started from the first half's results. Two
 * transactions would mean paying the setup twice for one question.
 */
/**
 * A fingerprint of every word the dictionary knows.
 *
 * Reading a page asks about far more than it finds. Every stretch of text
 * from every position is deinflected every way it could have been inflected,
 * which is some thirty questions per character and, on a page of thirty
 * thousand characters, the better part of a million. Almost none of them are
 * words: they are the shapes a word might have taken, and the dictionary has
 * never heard of nineteen in twenty of them.
 *
 * Each of those was a separate read of the database. This answers them
 * instead, in memory, before the database is troubled at all: a sorted list
 * of one number per word LLL knows, and a number not in the list is a word
 * that certainly is not there. Two million bytes, and it turns the great
 * majority of a page read into no database work whatsoever.
 *
 * It can only ever be wrong in the harmless direction. Two different words
 * can share a number, roughly one pair in this dictionary, and the cost of
 * that is one wasted read that finds nothing, which is what used to happen
 * every time anyway. It can never say no about a word that is there, because
 * the number comes from the word itself.
 */
let fingerprints = null;

/** FNV-1a, which is small, fast and spreads short strings about well. */
function fingerprint(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Could the dictionary have this word? No means no; yes means look. */
function mightKnow(term) {
  if (!fingerprints) return true;
  const wanted = fingerprint(term);
  let low = 0;
  let high = fingerprints.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const here = fingerprints[middle];
    if (here === wanted) return true;
    if (here < wanted) low = middle + 1; else high = middle - 1;
  }
  return false;
}

/**
 * Read every word the dictionary knows and remember its number.
 *
 * Once, after the database is open. It costs a moment and a couple of
 * megabytes; until it has finished, everything works as it did before,
 * because mightKnow says yes to everything while there is no list.
 */
async function learnWhatIsKnown() {
  try {
    const db = await ready;
    const keys = await new Promise((resolve, reject) => {
      const request = db.transaction(INDEX, 'readonly').objectStore(INDEX).getAllKeys();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    const marks = new Uint32Array(keys.length);
    for (let i = 0; i < keys.length; i++) marks[i] = fingerprint(String(keys[i]));
    marks.sort();
    fingerprints = marks;
    console.log('LLL:', keys.length, 'words fingerprinted, so most of reading a page ' +
      'now needs no database at all.');
  } catch (err) {
    // Not being able to do this costs speed and nothing else.
    console.warn('LLL: could not fingerprint the dictionary:', err && err.message);
  }
}

async function getEntries(terms) {
  const db = await ready;

  const idsByTerm = new Map();
  const byId = new Map();

  await new Promise((resolve, reject) => {
    const tx = db.transaction([INDEX, ENTRIES], 'readonly');
    const index = tx.objectStore(INDEX);
    const entries = tx.objectStore(ENTRIES);
    const asked = new Set();

    for (const term of terms) {
      // Almost all of them stop here, having cost one number and a search of
      // a sorted list rather than a read of the database. See fingerprints.
      if (!mightKnow(term)) continue;
      const req = index.get(term);
      req.onsuccess = () => {
        if (!req.result) return;
        idsByTerm.set(term, req.result);
        for (const id of req.result) {
          if (asked.has(id)) continue;
          asked.add(id);
          const entry = entries.get(id);
          entry.onsuccess = () => { if (entry.result) byId.set(id, entry.result); };
        }
      };
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
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
// Once the words are there, take their fingerprints. Nothing waits for this:
// until it has finished, every question goes to the database as it always did.
ready.then(learnWhatIsKnown, () => {});
ready.catch((err) => {
  console.error('LLL failed to start', err);
  status = { state: 'error', message: String(err) };
  setBadge('!');
});

async function start() {
  // Before anything else: a list that has gone missing since last time is
  // put back, and a copy of both is written somewhere the extension cannot
  // lose. Neither depends on the dictionary, and both matter most in exactly
  // the case where the dictionary is about to be rebuilt from nothing.
  await rescueLists().catch((err) => console.warn('LLL: could not check the word lists:', err && err.message));
  keepACopy().catch(() => {});

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
 * calling any browser API looks exactly like idling, so an import that had to
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
    console.log(`LLL: resuming, ${progress.entries}/${meta.entryChunks} entry chunks,` +
      ` ${progress.index}/${meta.indexChunks} index chunks already in`);
  }

  report(0);

  // Entry ids are positions in the build output, so the counter has to run
  // unbroken across chunks, which is why it is part of the saved progress.
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
  console.log(`LLL: dictionary ready, ${meta.entries} entries, ${meta.terms} forms`);

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
  if (!res.ok) throw new Error(`cannot read ${path} (${res.status}), run: node tools/build-dict.mjs`);
  return res.json();
}

function pad(n) { return String(n).padStart(3, '0'); }

function setBadge(text) {
  if (!api.action || !api.action.setBadgeText) return;
  api.action.setBadgeText({ text }).catch(() => {});
}
