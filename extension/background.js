/*
 * Torval, background
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

/*
 * The running commentary, off unless somebody asks for it. Deliberately
 * not called `say`: that name is already taken all over this codebase
 * for the progress callback threaded through the lookup, and in
 * background.js it is a parameter of two functions this would sit
 * inside. Guarded rather than assumed, because the tests load these
 * files without log.js.
 */
function trace() {
  if (typeof TorvalLog !== 'undefined') TorvalLog.say.apply(null, arguments);
}

// One dictionary database per language, so switching does not touch what the
// other language already has imported. 'torval-dictionary' unsuffixed is the
// Japanese one, which is why TorvalLang's 'ja' profile keeps an empty
// dbSuffix.
function dbName() { return 'torval-dictionary' + TorvalLang.profile().dbSuffix; }

// What these databases were called when this was called LLL. A dictionary is
// pure cache, rebuilt from files that ship with the extension, so the rename
// costs one import and nothing else; what it must not cost is a few hundred
// megabytes sitting in the profile under a name nothing will ever open
// again. Dropped once the new database is up, so a failed build never
// deletes the only copy of anything, not that anything here is the only copy
// of anything: the word lists live in storage.local and were never in here.
const FORMER_NAMES = ['lll-dictionary', 'lll-dictionary-it', 'lll-dictionary-es'];

async function dropFormerDatabases() {
  if (!api.storage || !indexedDB || typeof indexedDB.deleteDatabase !== 'function') return;
  const done = await api.storage.local.get('droppedFormerDatabases');
  if (done.droppedFormerDatabases) return;
  for (const name of FORMER_NAMES) {
    try {
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = resolve;
        request.onerror = resolve;
        request.onblocked = resolve;   // another tab has it open; next start
      });
    } catch (err) { /* nothing there, which is the ordinary case */ }
  }
  await api.storage.local.set({ droppedFormerDatabases: true }).catch(() => {});
  trace('Torval: dropped the dictionary databases left behind by the old name.');
}
const DB_VERSION = 1;
const ENTRIES = 'entries';
const INDEX = 'index';
const STATE = 'state';
// Rows per write. Smaller batches mean shorter transactions and a percentage
// that actually moves, which matters: the import used to jump in whole-chunk
// steps and sat on one number long enough to look frozen.
const BATCH = 5000;

// `Lookup()` picks the right lookup engine for whichever language is active
// right now; every call site asks for it fresh rather than holding onto one,
// so a language switch is picked up by the very next lookup. Which engine
// that is belongs to the language, not to a list kept here: adding one used
// to mean editing this line, and forgetting to is a language that silently
// gets read with the wrong grammar.
function Lookup() { return TorvalLang.profile().lookup(); }

/** Storage key for one of the known/ignored/ankiConfig-shaped values, scoped
 * to whichever language is active: unsuffixed for Japanese (every existing
 * install's data, untouched), '_it' for Italian, '_es' for Spanish.
 */
function langKey(base) { return base + TorvalLang.profile().storageSuffix; }

/** Where a word list's safety copy is kept, see wordMap/saveWords below. */
function copyKey(key) { return key + 'Copy'; }

let ready = null;              // promise for the open, populated database
let tagsPromise = null;
// 'unchosen' until a language is picked; see loadIfPicked.
let status = { state: 'unchosen' };
let hoverReader = null;        // reassigned per language, see loadLanguage

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
 * active, which is exactly the state Torval already asks for. Once one is
 * seen, it is handed to that tab's content script to fetch, plainly, with
 * nothing done to it, no special headers, no routing trick. If the address
 * itself was always what was missing, nothing else needed to be.
 *
 * `&torval=1` marks Torval's own re-fetch of that address so it is not mistaken for
 * a second genuine request and forwarded right back again.
 */
if (api.webRequest && api.webRequest.onBeforeRequest) {
  const seenPerTab = new Map();   // tabId -> last captured URL, so as not to repeat one
  api.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;
      if (details.url.indexOf('torval=1') !== -1) return;          // Torval's own re-fetch
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
 * use generally, scoped only to the address Torval itself asks for again.
 *
 * Chrome has no such thing any more. A blocking webRequest listener is
 * refused outright under Manifest V3 there, so Chrome is handed the same
 * rewrite as a declarativeNetRequest rule instead, in rules.json: it says
 * the same thing, declared up front rather than decided per request, which
 * is the whole of what Chrome took blocking listeners away for. The two
 * never both apply, since only one of them is in any given browser's
 * manifest, and the registration below asks the manifest rather than the
 * browser. Chrome does not quietly refuse a blocking listener: it writes a
 * paragraph into the service worker console about ExtensionInstallForcelist,
 * every start, whatever the call is wrapped in. Asking first is the only way
 * to not be told, and it is the exact question, since package.mjs takes the
 * permission out of the Chrome manifest and leaves it in the Firefox one.
 */
const CAN_BLOCK = ((api.runtime.getManifest().permissions) || []).includes('webRequestBlocking');

if (CAN_BLOCK && api.webRequest && api.webRequest.onHeadersReceived) {
  try {
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
  } catch (err) {
    // Declared and still refused, which should not happen. Worth a line:
    // subtitles stop working and this is the only thing that would say why.
    console.warn('Torval: the caption header rewrite was refused:', err && err.message);
  }
} else {
  trace('Torval: no blocking listener here, so the caption rewrite comes ' +
    'from rules.json instead.');
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
    case 'ankiReady':    return ankiReady();
    case 'ankiDuplicate': return ankiDuplicate(message.word);
    case 'ankiBrowse':   return guard(() => ankiBrowse(message.word));
    case 'ankiDescribe': return guard(() => TorvalAnki.describe(message.url));
    case 'ankiFields':   return guard(() => TorvalAnki.fieldNames(message.url, message.model));
    case 'extractWords': return guard(() => extractWords(message.text));
    case 'comprehension': return guard(() => comprehension(message.text, reporting(sender)));
    case 'wordPlaces':   return guard(() => wordPlaces(message.text, message.before, message.after,
      // A subtitle line arrives already knowing it is in the right language:
      // the video's own transcript was read and scored before the first line
      // was drawn. Asking a ten-word line to prove it again is how a page
      // that is plainly Italian ends up with its subtitles uncoloured.
      message.line === true,
      // A subtitle line is thirty characters and answers instantly. Only a
      // page is worth saying anything about.
      message.text.length > 2000 ? reporting(sender) : undefined));
    case 'knownList':    return guard(() => wordList(KNOWN()));
    case 'ignoredList':  return guard(() => wordList(IGNORED()));
    case 'addKnownWords': return guard(() => addKnownWords(message.words));
    case 'setKnown':     return guard(() => setWordOn(KNOWN(), message.word, message.known));
    case 'setIgnored':   return guard(() => setWordOn(IGNORED(), message.word, message.ignored));
    case 'forgetWords':  return guard(() => forgetFrom(KNOWN(), message.words));
    case 'forgetIgnored': return guard(() => forgetFrom(IGNORED(), message.words));
    case 'clearWords':   return guard(() => clearList(message.list === 'ignored' ? IGNORED() : KNOWN()));
    case 'exportWords':  return guard(() => exportWords());
    case 'importWords':  return guard(() => importWords(message.data));
    case 'openOptions':  return guard(async () => {
      // `focus` names a switch the settings page should open on and point
      // at. Chrome will not let a permission be asked for from a page
      // script or from here, only from a click on one of the add-on's own
      // pages, so the closest thing to asking at the moment it matters is
      // taking somebody straight to the switch. Left in storage rather
      // than sent, because the page is not open yet to be told.
      if (message.focus) await api.storage.local.set({ [SHOW_ON_OPEN]: message.focus });
      api.runtime.openOptionsPage();
      return true;
    });
    case 'dictionaries': return guard(() => dictionaries());
    case 'keepDictionary': return guard(() => keepDictionary(message.code, message.keep));
    case 'grabVisible':  return guard(() => grabVisible(sender && sender.tab));
    case 'tabAudioReady': return guard(() => tabAudioReady());
    case 'tabAudioStart': return guard(() => tabAudioStart(sender && sender.tab && sender.tab.id,
      message.mimeType));
    case 'tabAudioStop':  return guard(() => tabAudioStop());
    default:
      // Not for this listener. The offscreen recorder is reached the only
      // way an extension can reach one of its own documents, which is the
      // same broadcast everything else here arrives on.
      if (message && message.to === 'offscreen') return undefined;
      // Saying so out loud. A message with no case here simply never answers,
      // and the caller's `await` sits there for ever, which is exactly how a
      // whole feature can be wired up, look right in every preview, and do
      // nothing at all once installed.
      if (message && message.type) console.warn('Torval: no handler for message', message.type);
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
  const stored = await api.storage.local.get(langKey('ankiConfig'));
  return TorvalAnki.browse(stored[langKey('ankiConfig')] || {}, word);
}

/**
 * Is there anything stopping a card being made? Asked before the line is
 * recorded rather than after, see checkReady in anki.js.
 */
async function ankiReady() {
  return guard(async () => {
    const stored = await api.storage.local.get(langKey('ankiConfig'));
    await TorvalAnki.checkReady(stored[langKey('ankiConfig')]);
    return true;
  });
}

async function ankiDuplicate(word) {
  return guard(async () => {
    const stored = await api.storage.local.get(langKey('ankiConfig'));
    return TorvalAnki.alreadyHave(stored[langKey('ankiConfig')], { word });
  });
}

async function ankiAdd(note) {
  return guard(async () => {
    const stored = await api.storage.local.get(langKey('ankiConfig'));
    const ankiConfig = stored[langKey('ankiConfig')];
    // The pitch diagram is drawn from dictionary data rather than fetched, so
    // it is filled in here; anki.js only has to place it in the right field.
    // Skipped entirely unless the card actually has somewhere to put it.
    // Italian's stress markup, by contrast, is already computed client-side
    // (content.js has the dictionary entry in hand there) and arrives on
    // `note.stress` needing nothing further from here.
    const fields = (ankiConfig && ankiConfig.fields) || {};
    if (Object.keys(fields).some((f) => fields[f] === 'pitch')) {
      note = { ...note, pitch: await TorvalPitch.graphFor(note.word, note.reading) };
    }
    return TorvalAnki.addNote(ankiConfig, note);
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
    const lookup = Lookup();
    const found = typeof point === 'number'
      ? await lookup.hover(text, point, hoverReader)
      : { start: 0, groups: await lookup.search(text, hoverReader) };
    const start = found.start;
    const groups = found.groups;
    const known = await knownSet();
    const ignored = await ignoredSet();
    const stress = TorvalLang.profile().accent === 'stress';
    // The pitch accent (Japanese) or the stress mark (the others) is one
    // value per word, and the table or the entry itself is already in
    // memory, so it costs nothing to answer it here along with the
    // definitions.
    for (const group of groups) {
      for (const hit of group.hits) {
        if (stress) hit.stress = TorvalStress.indexFor(hit.entry);
        else hit.pitch = await TorvalPitch.accentFor(hit.word, hit.reading);
        hit.band = lookup.frequencyBand(hit.q);
        hit.shared = lookup.sharedTags(hit.entry);
        hit.sharedPos = lookup.sharedPos(hit.entry);
        hit.known = known.has(hit.word);
        hit.ignored = ignored.has(hit.word);
      }
    }
    return { status, groups, start };
  } catch (err) {
    console.error('Torval lookup failed', err);
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
// no database work at all. Declared with the rest of the per-language state
// near the top of the file; (re)assigned in loadLanguage.

function requireDictionary() {
  if (status.state !== 'ready') {
    throw new Error('The dictionary is still loading, try again in a moment.');
  }
  return ready;
}

/** Every dictionary word in a passage of text, see TorvalLookup.extractWords. */
async function extractWords(text) {
  await requireDictionary();
  return Lookup().extractWords(text, cachingReader());
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
  const lookup = Lookup();
  const tokens = await lookup.locateTokens(text, reader, say);
  if (!TorvalLang.profile().plausible(text, tokens.length)) return NOT_THIS_LANGUAGE;
  const known = await effectiveKnown(text, tokens, reader, await knownSet());
  const ignored = await ignoredSet();
  const score = lookup.coverage(tokens, known, ignored);
  // What the bar needs to answer the same question again after one more word
  // is ticked, without the page being read a second time. See `model`.
  score.model = lookup.model(tokens, known, ignored);
  return score;
}

/*
 * What comes back about a passage that is not in the language being read at
 * all. `skipped` rather than a score of zero: zero means "you know none of
 * this", which is a real answer about a real page and keeps the bar up
 * saying 0%, and an English page is not a page you understand none of. The
 * caller takes it as nothing to say and puts the bar away.
 */
const NOT_THIS_LANGUAGE = {
  total: 0, known: 0, counts: {}, places: {}, unmarked: [], skipped: true
};

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
    const ok = await Lookup().decomposeKnown(text, token.start, token.length, reader, known);
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
async function wordPlaces(text, before, after, trusted, say) {
  await requireDictionary();
  const reader = cachingReader();
  const lookup = Lookup();
  // Read with whatever came before and after, so that a line cut mid-word,
  // which automatic captions do constantly, is still read as the word it is.
  // Only the words starting inside this line are kept.
  const lead = String(before || '').slice(-CONTEXT);
  const trail = String(after || '').slice(0, CONTEXT);
  const whole = lead + text + trail;
  const found = await lookup.locateTokens(whole, reader, say);
  const tokens = lookup.within(found, lead.length, text.length);
  if (!trusted && !TorvalLang.profile().plausible(text, tokens.length)) return NOT_THIS_LANGUAGE;
  const known = await effectiveKnown(text, tokens, reader, await knownSet());
  const ignored = await ignoredSet();

  // Solid against dashed, alternating, is how two words with nothing between
  // them are told apart; a language that always spaces its words has no such
  // pair to tell apart, and the dashed underline there is a second mark
  // making a distinction nobody asked about.
  const seams = TorvalLang.profile().seams;

  // No prototype. The keys here are words, and "constructor" is an ordinary
  // Spanish word: on a plain object `places['constructor']` is already
  // Object's own constructor, so the guard below saw it as a word it had
  // met, skipped making an array, and called .push on a function. The whole
  // read threw, the line came back as a failure, and every word in the
  // sentence went unmarked while hovering any of them still answered. One
  // word on a page was enough to do it, which is why it looked random.
  const places = Object.create(null);
  // Words that get no mark on the page. Two quite different reasons to be on
  // this list, you know it, or you have said you never want to be told about
  // it, but the page only ever asks the one question, so they arrive as one
  // list rather than two the caller would have to merge itself.
  const unmarked = [];
  tokens.forEach((token, i) => {
    if (!places[token.word]) {
      places[token.word] = [];
      if (ignored.has(token.word) || lookup.isKnown(token, known)) unmarked.push(token.word);
    }
    places[token.word].push(token.start, token.length, seams ? i % 2 : 0);
  });

  // The score comes back too. This is the same passage the bar is asking
  // about, and reading a page twice over to answer two questions about it
  // would be silly.
  const score = lookup.coverage(tokens, known, ignored);
  return {
    total: score.total, known: score.known, counts: score.counts,
    model: lookup.model(tokens, known, ignored), places, unmarked
  };
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

// Suffixed to the active language, see langKey above: an existing install's
// data stays exactly where it always was, under the unsuffixed 'ja' names.
function KNOWN() { return langKey('knownWords'); }
function IGNORED() { return langKey('ignoredWords'); }

/*
 * The word lists are the one thing in Torval that cannot be rebuilt, and every
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

// Read once and held, because a lookup asks about them on every single hover.
// The settings page never touches storage directly, it only ever asks this
// script to change a list by message, so saveWords below is the one place a
// write happens, and it keeps this cache in step itself. Nothing here needs
// to invalidate it a second time.
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

function knownSet() { return wordSet(KNOWN()); }
function ignoredSet() { return wordSet(IGNORED()); }

// The only outside change left to watch for is the toolbar switch, which
// really is set from elsewhere (switch.js, its own script on its own page).
if (api.storage.onChanged) {
  api.storage.onChanged.addListener((changes) => {
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
 * It follows the switch on the toolbar button. Turning Torval off takes the
 * script off Netflix altogether, so if it ever misbehaves on Netflix's own
 * pages there is a way out that does not involve uninstalling anything.
 */
const NETFLIX_HELPER = {
  id: 'torval-netflix-page',
  js: ['netflix-page.js'],
  matches: ['*://*.netflix.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: true,
  persistAcrossSessions: true
};

async function netflixHelper(on) {
  if (!api.scripting || !api.scripting.registerContentScripts) {
    console.warn('Torval: this browser has no way to run Torval’s Netflix helper, ' +
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
    console.warn('Torval: could not put Torval’s Netflix helper on the page:', err && err.message);
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
  // Without a prototype, for the same reason as `places` in wordPlaces: a
  // word list is keyed by words, and `map['constructor']` on a plain object
  // is truthy before anything has been added, so marking that word known
  // silently did nothing and importing it counted it as already there.
  return Object.assign(Object.create(null), have > 0 ? map : {});
}

/**
 * Write one list, its size, and the copy kept in case the list itself goes
 * missing. One call, so the three cannot disagree.
 */
async function saveWords(key, map) {
  const counts = (await api.storage.local.get(COUNTS))[COUNTS] || {};
  counts[key] = Object.keys(map).length;
  await api.storage.local.set({ [key]: map, [COUNTS]: counts, [copyKey(key)]: map });
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
  const known = KNOWN(), ignored = IGNORED();
  const stored = await api.storage.local.get([known, ignored, copyKey(known), copyKey(ignored), COUNTS]);
  const counts = stored[COUNTS] || {};
  for (const key of [known, ignored]) {
    const live = stored[key];
    const copy = stored[copyKey(key)];
    if (live && Object.keys(live).length) continue;
    if (!copy || !Object.keys(copy).length) continue;
    if (counts[key] === 0) continue;   // emptied on purpose
    await api.storage.local.set({ [key]: copy });
    delete caches[key];
    console.warn('Torval: the ' + key + ' list was missing and has been put back from its copy, ' +
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
    const map = await wordMap(KNOWN());
    let added = 0;
    for (const word of words) {
      if (!map[word]) { map[word] = Date.now(); added++; }
    }
    return { added, total: await saveWords(KNOWN(), map) };
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
      const other = key === KNOWN() ? IGNORED() : KNOWN();
      const otherMap = await wordMap(other);
      if (otherMap[word]) { delete otherMap[word]; await saveWords(other, otherMap); }
    }
    return { word, on: !!on, total };
  });
}

/**
 * Both lists, with the dates, as one plain object to save somewhere safe.
 *
 * This is the part of Torval that cannot be rebuilt. The dictionary can be
 * downloaded again and the settings retyped in a minute, but a known list is
 * however many months of reading, and until now it existed in exactly one
 * place, this browser profile, belonging to an add-on that has to be loaded
 * again by hand every time Firefox restarts.
 */
async function exportWords() {
  return {
    format: 'torval-words',
    version: 1,
    saved: new Date().toISOString(),
    known: await wordMap(KNOWN()),
    ignored: await wordMap(IGNORED())
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
 *
 * Files saved before this was called Torval say 'lll-words' inside, and are
 * read too. A word list is the one thing here that cannot be rebuilt, and
 * refusing to read last month's copy of it because the program has since
 * been given a different name would be the worst possible reason to lose
 * one.
 */
const WORD_FILE = ['torval-words', 'lll-words'];

async function importWords(data) {
  if (!data || typeof data !== 'object') throw new Error('That file is not a saved word list.');
  if (!WORD_FILE.includes(data.format)) throw new Error('That is not a file Torval saved.');

  return inTurn(async () => merged(data));
}

/**
 * Read what arrived as a text, and keep the words this language has.
 *
 * A file Torval wrote holds dictionary forms already, and reading those back
 * gives the same forms again. A file from somewhere else holds whatever was
 * in the field it was told to read: the Anki add-on is pointed at a note's
 * front, and on a sentence deck that front is a whole sentence. Stored as
 * one "word", a sentence can never match anything on a page, so it would sit
 * in the list forever doing nothing.
 *
 * So a file is read exactly the way a page, a subtitle line or the "add from
 * a text" box is read: segmented, deinflected, looked up, and reduced to the
 * dictionary forms found inside it. A sentence becomes its words, and an
 * inflected "hablaba" becomes hablar, the word a hover on it would have
 * shown.
 *
 * What the dictionary does not recognise does not go on the list. A known
 * list is what a page is measured against, so a word that cannot be met
 * again while reading cannot do anything there but inflate the count: a
 * card's speaker name, a line of English on the back of a note, or a whole
 * deck in a language other than the one being read. Those are counted and
 * reported rather than kept quiet about.
 */
async function asWords(from, reader) {
  const out = Object.create(null);
  let dropped = 0;
  if (!from || typeof from !== 'object') return { words: out, dropped };

  for (const key of Object.keys(from)) {
    const when = Number(from[key]);
    if (!key || !Number.isFinite(when)) continue;

    const found = await Lookup().extractWords(key, reader);
    if (!found.length) { dropped++; continue; }
    for (const word of found) {
      if (out[word] === undefined || when < out[word]) out[word] = when;
    }
  }
  return { words: out, dropped };
}

/**
 * The same, for the ignored list, which is the one place the rule above
 * would do harm.
 *
 * Ignored words are the ones the dictionary has nothing for: names, pieces
 * of English, things it read wrongly. Asking it to confirm them would throw
 * away precisely the list, and would make saving and loading Torval's own
 * file lossy. So these are taken as they come.
 */
function asGiven(from) {
  const out = Object.create(null);
  if (!from || typeof from !== 'object') return out;
  for (const key of Object.keys(from)) {
    const when = Number(from[key]);
    if (!key || !Number.isFinite(when)) continue;
    out[key] = when;
  }
  return out;
}

async function merged(data) {
  await requireDictionary();
  const reader = cachingReader();

  const known = await wordMap(KNOWN());
  const ignored = await wordMap(IGNORED());
  const added = { known: 0, ignored: 0 };

  const merge = (into, from, count) => {
    for (const word of Object.keys(from)) {
      const when = from[word];
      if (!into[word]) { into[word] = when; added[count]++; }
      else into[word] = Math.min(into[word], when);   // keep the earlier date
    }
  };
  const read = await asWords(data.known, reader);
  merge(known, read.words, 'known');
  merge(ignored, asGiven(data.ignored), 'ignored');
  for (const word of Object.keys(known)) delete ignored[word];

  return {
    added,
    dropped: read.dropped,
    known: await saveWords(KNOWN(), known),
    ignored: await saveWords(IGNORED(), ignored)
  };
}

// ---------------------------------------------------------------------------
// Recording a copy-protected video's sound
// ---------------------------------------------------------------------------

/*
 * Chrome only, and not for want of trying.
 *
 * A video the browser is decrypting hands over no audio track when its
 * element is asked for a stream, so the ordinary path in video.js gets
 * nothing. The tab's own output is a different thing entirely, just sound
 * coming out of a tab, and Chrome will hand that over through tabCapture.
 *
 * Firefox has no tabCapture API, and its getDisplayMedia ignores `audio`
 * without an error (bug 1541425, filed in 2019, still open). There is no
 * third way and nothing to fall back on, so the Firefox build ships without
 * any of this and the card says the sound cannot be had. package.mjs takes
 * the two keys out of that manifest rather than leaving Firefox to warn
 * about an ability the build does not have.
 *
 * Permission is asked for only when somebody turns this on, under Settings
 * → Anki, and never otherwise: YouTube's audio comes off the element and
 * wants none of this, which is the common case and stays untouched.
 */
/** Where openOptions leaves the name of a switch for the settings page. */
const SHOW_ON_OPEN = 'showOnOpen';

const OFFSCREEN = 'offscreen.html';
let offscreenOpen = null;

/**
 * Can this browser do it, and has it been allowed to?
 *
 * Deliberately not asking whether api.tabCapture exists. An optional
 * permission's namespace is undefined until it is granted, so that test
 * says no until it is turned on and the switch is disabled until the test
 * says yes: a box that cannot be ticked because it has not been ticked.
 * api.offscreen is the honest question. It is an ordinary permission, so
 * Chrome always has it and Firefox never does, which is exactly the line
 * being drawn.
 */
async function tabAudioReady() {
  const can = !!(api.offscreen && api.permissions);
  if (!can) return { can: false, granted: false };
  let granted = false;
  try {
    granted = await api.permissions.contains({ permissions: ['tabCapture'] });
  } catch (err) { granted = false; }
  return { can: true, granted: !!granted };
}

/**
 * The offscreen document, made once and left open.
 *
 * Chrome allows exactly one per extension and throws on a second, which two
 * quick presses of + will otherwise cause; that particular failure means it
 * already exists, which is what was wanted anyway.
 */
async function ensureOffscreen() {
  if (offscreenOpen) return offscreenOpen;
  offscreenOpen = (async () => {
    if (api.runtime.getContexts) {
      const open = await api.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [api.runtime.getURL(OFFSCREEN)]
      });
      if (open.length) return true;
    }
    try {
      await api.offscreen.createDocument({
        url: OFFSCREEN,
        reasons: ['USER_MEDIA'],
        justification: "Recording a copy-protected video's sound for an Anki card."
      });
    } catch (err) {
      if (!/single offscreen|already/i.test(String(err && err.message))) throw err;
    }
    return true;
  })();
  try {
    return await offscreenOpen;
  } catch (err) {
    offscreenOpen = null;   // so the next press may try again
    throw err;
  }
}

/**
 * A photograph of the tab, for the frame a canvas will not give up.
 *
 * Drawing a decrypting video into a canvas is not a decode that happens to
 * fail. The element is not allowed to hand its pixels to page script at
 * all, which is why turning hardware acceleration off rescues it on one
 * machine and does nothing on the next. This is not page script asking: it
 * is the browser photographing what is already on screen, and by then the
 * protection has had its say.
 *
 * Needs the extension to have been invoked on the tab, so the error is
 * passed along rather than flattened; video.js knows what to say about it.
 */
/**
 * Every dictionary Torval ships, and what this browser has done with it.
 *
 * Two facts about each, from two places. What is in the package comes from
 * that language's meta.json, which is there whether or not anybody has ever
 * chosen the language. What is in this browser comes from its own database,
 * which only exists once the language has been read in. The settings page
 * wants both: one says what is on offer, the other says what it is costing.
 *
 * The databases are listed rather than opened, because opening one that is
 * not there creates it, and asking a question should not be how a 30 MB
 * import gets started.
 */
// How far through reading in a dictionary that is not the one in use. Null
// the rest of the time, which is almost always.
let building = null;

async function dictionaries() {
  const present = new Set();
  try {
    if (indexedDB.databases) {
      for (const each of await indexedDB.databases()) if (each.name) present.add(each.name);
    }
  } catch (err) {
    // A browser that will not list them. Every dictionary then reports as
    // not installed, which is wrong but harmless: the page offers to remove
    // nothing, and choosing a language still works.
  }

  const out = [];
  for (const { code } of TorvalLang.list()) {
    const profile = TorvalLang.get(code);
    const store = 'torval-dictionary' + profile.dbSuffix;

    let shipped = null;
    try {
      const res = await fetch(api.runtime.getURL(profile.dataPath + '/meta.json'));
      if (res.ok) shipped = await res.json();
    } catch (err) { /* not built into this package */ }

    let installed = null;
    if (present.has(store)) {
      try {
        const db = await openDatabase(store);
        installed = await get(db, STATE, 'meta');
        db.close();
      } catch (err) { /* there, but it will not say what is in it */ }
    }

    out.push({
      code,
      name: profile.name,
      here: present.has(store),
      building: building && building.code === code ? building.progress : null,
      ready: !!installed,
      stale: !!(installed && shipped && installed.version !== shipped.version),
      active: code === TorvalLang.active(),
      built: shipped ? shipped.built : null,
      entries: shipped ? shipped.entries : null,
      terms: shipped ? shipped.terms : null,
      source: shipped ? shipped.source : null
    });
  }
  return out;
}

/**
 * Throw away one language's database.
 *
 * Nothing is lost that cannot be had again: the dictionary is in the
 * package, and choosing that language reads it back in. What it buys is
 * the tens of megabytes it was taking up, for somebody learning one
 * language who has looked at the other two once.
 *
 * Not the language being read. Deleting the database out from under the
 * lookups running against it would take the page down for no reason, and
 * the cure is one click on another language first.
 */
/**
 * Keep this dictionary in this browser, or do not.
 *
 * Turning it on reads the dictionary in there and then, rather than leaving
 * it until the language is next chosen: a switch that does nothing you can
 * see until later is a switch nobody believes. Turning it off throws the
 * database away.
 *
 * One at a time. Two imports into two databases would both run, both be
 * slow, and neither would be what anybody asked for first.
 */
async function keepDictionary(code, keep) {
  const profile = TorvalLang.get(code);
  if (!profile || code !== profile.code) throw new Error('There is no such dictionary.');
  if (!keep) return forgetDictionary(code);
  if (code === TorvalLang.active()) return { code };
  if (building) throw new Error('One at a time: another dictionary is being read in.');

  const db = await openDatabase('torval-dictionary' + profile.dbSuffix);
  try {
    const meta = await fetchJson('data/meta.json', profile.dataPath);
    const installed = await get(db, STATE, 'meta');
    if (installed && installed.version === meta.version) return { code };

    building = { code, progress: 0 };
    const awake = keepAwake();
    try {
      await importDictionary(db, meta, profile.dataPath, (fraction) => {
        building = { code, progress: fraction };
      });
    } finally {
      awake();
    }
  } finally {
    db.close();
    building = null;
  }
  trace('Torval: read the ' + profile.name + ' dictionary into this browser');
  return { code };
}

async function forgetDictionary(code) {
  const profile = TorvalLang.get(code);
  if (!profile || code !== profile.code) throw new Error('There is no such dictionary.');
  if (code === TorvalLang.active()) {
    throw new Error('That is the language you are reading. Choose another one first.');
  }
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('torval-dictionary' + profile.dbSuffix);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    // Something still has it open. It will go when that lets go, and saying
    // so now is closer to the truth than an error the reader cannot act on.
    req.onblocked = () => resolve();
  });
  trace('Torval: removed the ' + profile.name + ' dictionary from this browser');
  return { code };
}

async function grabVisible(tab) {
  if (!api.tabs || !api.tabs.captureVisibleTab) {
    throw new Error('this browser will not photograph a tab');
  }
  const where = tab && typeof tab.windowId === 'number' ? tab.windowId : undefined;
  const shot = where === undefined
    ? await api.tabs.captureVisibleTab({ format: 'jpeg', quality: 92 })
    : await api.tabs.captureVisibleTab(where, { format: 'jpeg', quality: 92 });
  if (!shot) throw new Error('the tab came back blank');
  return { data: shot };
}

async function tabAudioStart(tabId, mimeType) {
  trace('Torval: asked to record tab', tabId);
  const state = await tabAudioReady();
  if (!state.can) throw new Error('This browser cannot record a tab\u2019s sound.');
  if (!state.granted) {
    throw new Error('Torval has not been allowed to record this tab. ' +
      'Settings \u2192 Anki \u2192 Recording from video.');
  }
  if (typeof tabId !== 'number') throw new Error('No tab to record.');
  // Granted a moment ago, so the namespace should be here now; if the
  // browser has not caught up, saying so beats a bare undefined.
  if (!api.tabCapture) throw new Error('Tab recording is not available yet. Try again.');

  await ensureOffscreen();
  const streamId = await api.tabCapture.getMediaStreamId({ targetTabId: tabId });
  trace('Torval: the browser handed over a stream for the tab');
  const reply = await api.runtime.sendMessage({
    to: 'offscreen', type: 'recordStart', streamId, mimeType
  });
  if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'The recorder did not start.');
  return true;
}

async function tabAudioStop() {
  const reply = await api.runtime.sendMessage({ to: 'offscreen', type: 'recordStop' });
  if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'Nothing was recorded.');
  return { type: reply.type, data: reply.data };
}

/*
 * A copy of the word lists, in the Downloads folder, once a day.
 *
 * Everything else Torval keeps lives inside the extension: the lists, the deck
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
  // Nothing to keep a copy of, and nothing to explain either: a file
  // appearing in Downloads once a day is hard to account for on an install
  // that was never asked to remember a single word.
  if (!TorvalTrack.on()) return;
  const today = new Date().toISOString().slice(0, 10);
  const stored = await api.storage.local.get([LAST_COPY, COUNTS]);
  if (stored[LAST_COPY] === today) return;

  const counts = stored[COUNTS] || {};
  if (!counts[KNOWN()] && !counts[IGNORED()]) return;   // nothing worth keeping yet

  const words = await exportWords();
  const blob = new Blob([JSON.stringify(words)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    await api.downloads.download({
      url,
      filename: 'Torval/torval-words-' + today + '.json',
      conflictAction: 'overwrite',
      saveAs: false
    });
    await api.storage.local.set({ [LAST_COPY]: today });
    trace('Torval: kept a copy of your words in Downloads/Torval');
  } catch (err) {
    console.warn('Torval: could not keep a copy of your words:', err && err.message);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

/**
 * Empty one list completely, which is the only way back to nothing once a
 * list has the wrong language's words in it, or somebody else's.
 *
 * Nothing is asked here: the settings page asks twice before sending this,
 * which is where a question belongs. The copy in Downloads/Torval is not
 * touched, so today's file is still the list as it was this morning.
 */
async function clearList(key) {
  return inTurn(async () => {
    const had = Object.keys(await wordMap(key)).length;
    return { removed: had, total: await saveWords(key, {}) };
  });
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
 * of one number per word Torval knows, and a number not in the list is a word
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
// `generation` guards against a language switch arriving while this is still
// running: `db` here is the one this generation's start() opened, but by the
// time the read finishes a newer loadLanguage() may already have moved
// `fingerprints` on to a different language entirely, and this must not then
// overwrite it with a stale answer about the language that just left.
async function learnWhatIsKnown(db, generation) {
  try {
    const keys = await new Promise((resolve, reject) => {
      const request = db.transaction(INDEX, 'readonly').objectStore(INDEX).getAllKeys();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    if (generation !== loadGeneration) return;
    const marks = new Uint32Array(keys.length);
    for (let i = 0; i < keys.length; i++) marks[i] = fingerprint(String(keys[i]));
    marks.sort();
    fingerprints = marks;
    trace('Torval:', keys.length, 'words fingerprinted, so most of reading a page ' +
      'now needs no database at all.');
  } catch (err) {
    // Not being able to do this costs speed and nothing else.
    console.warn('Torval: could not fingerprint the dictionary:', err && err.message);
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

// One dictionary loaded at a time, whichever language is active. Switching
// languages (TorvalLang.onChange, below) re-runs this exactly as a fresh start
// would, against that language's own database and data files; nothing about
// the language just left behind, including its own already-imported
// dictionary, is touched.
let loadGeneration = 0;

function loadLanguage() {
  const generation = ++loadGeneration;
  status = { state: 'starting', progress: 0 };
  fingerprints = null;
  tagsPromise = null;
  hoverReader = cachingReader();

  ready = start();
  // Once the words are there, take their fingerprints. Nothing waits for this:
  // until it has finished, every question goes to the database as it always did.
  ready.then((db) => { if (generation === loadGeneration) learnWhatIsKnown(db, generation); }, () => {});
  ready.catch((err) => {
    if (generation !== loadGeneration) return;
    console.error('Torval failed to start', err);
    status = { state: 'error', message: String(err) };
    setBadge('!');
  });
}

/*
 * Nothing is loaded until somebody has said what to load.
 *
 * Waiting for the stored choice was already here, so that a fresh
 * background start never races the Japanese default against whatever was
 * last picked. What was missing is that on a fresh install there is no
 * stored choice at all, and the default won by walking over: Torval
 * downloaded and built the whole Japanese dictionary, several minutes and
 * a couple of hundred megabytes of it, for somebody who had not yet been
 * asked which language they were here for.
 *
 * So an unanswered question is a state of its own, and the content script
 * knows what to do with it, which is nothing.
 */
function loadIfPicked() {
  if (!TorvalLang.picked()) {
    status = { state: 'unchosen' };
    setBadge('');
    return;
  }
  loadLanguage();
}

TorvalLang.ready().then(loadIfPicked);
TorvalLang.onChange(loadIfPicked);

// A fresh install opens the settings, because the one thing Torval needs
// before it can do anything is the one thing it cannot guess.
if (api.runtime.onInstalled) {
  api.runtime.onInstalled.addListener(function (details) {
    if (details.reason !== 'install') return;
    TorvalLang.ready().then(function () {
      if (!TorvalLang.picked()) api.runtime.openOptionsPage();
    });
  });
}

/**
 * An install that already keeps score goes on keeping score.
 *
 * Marking words is off until asked for, which is right for somebody
 * installing Torval today and would be theft from somebody who has been
 * using it for a year: the switch did not exist when they started, so
 * nobody has answered the question, and defaulting their answer to no would
 * take the bar, the colours and the point of their word list away in an
 * update. A list with anything in it is the answer.
 *
 * Written down rather than worked out each time, so that every page, the
 * settings and the background all read one stored value and cannot disagree
 * about it. Once only: after this the switch on the settings page is the
 * only thing that moves it, including back off again.
 */
async function wakeTracking() {
  const stored = await api.storage.local.get([TorvalTrack.KEY, COUNTS]);
  if (typeof stored[TorvalTrack.KEY] === 'boolean') return;

  const counts = stored[COUNTS] || {};
  const anyWords = Object.keys(counts).some((key) => counts[key] > 0);
  await TorvalTrack.set(anyWords);
  if (anyWords) trace('Torval: word lists found, so marking words stays on');
}

async function start() {
  // Before anything else: a list that has gone missing since last time is
  // put back, and a copy of both is written somewhere the extension cannot
  // lose. Neither depends on the dictionary, and both matter most in exactly
  // the case where the dictionary is about to be rebuilt from nothing.
  await wakeTracking().catch(() => {});
  await rescueLists().catch((err) => console.warn('Torval: could not check the word lists:', err && err.message));
  keepACopy().catch(() => {});

  const db = await openDatabase();
  const meta = await fetchJson('data/meta.json');
  const installed = await get(db, STATE, 'meta');

  if (installed && installed.version === meta.version) {
    status = { state: 'ready', progress: 1 };
    setBadge('');
    dropFormerDatabases().catch(() => {});
    return db;
  }

  const awake = keepAwake();
  try {
    await importDictionary(db, meta);
  } finally {
    awake();
  }
  dropFormerDatabases().catch(() => {});
  return db;
}

/**
 * Keep the background script alive for the length of the import.
 *
 * Chrome runs this file as a service worker and shuts it down after thirty
 * seconds with nothing to do. Importing a dictionary is about a minute, and
 * almost all of it is waiting on IndexedDB, which is not something Chrome
 * counts as having something to do: the worker would be stopped halfway
 * through, every time, for ever.
 *
 * Calling an extension API resets that timer, so one trivial call every
 * twenty seconds holds it open. It is nothing but a heartbeat: nothing is
 * asked of the answer.
 *
 * Firefox does not stop an event page mid-await and so never needs this,
 * but it costs one call every twenty seconds while a dictionary is being
 * built and nothing at all afterwards, which is not worth branching on.
 *
 * This is deliberately a belt to importDictionary's braces, not a
 * replacement for them: the import writes down where it got to after every
 * chunk and picks up from there, so a worker stopped anyway, by a browser
 * restart, a crash, a heartbeat that did not land, loses one chunk rather
 * than the whole minute.
 *
 * Returns the function that stops it.
 */
function keepAwake() {
  if (!(api.runtime && api.runtime.getPlatformInfo)) return function () {};
  const beat = setInterval(() => {
    try { api.runtime.getPlatformInfo(); } catch (err) { /* nothing to do about it */ }
  }, 20000);
  return function () { clearInterval(beat); };
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
async function importDictionary(db, meta, dataPath, onProgress) {
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
    trace('Torval: building the dictionary');
  } else {
    trace(`Torval: resuming, ${progress.entries}/${meta.entryChunks} entry chunks,` +
      ` ${progress.index}/${meta.indexChunks} index chunks already in`);
  }

  report(0);

  // Entry ids are positions in the build output, so the counter has to run
  // unbroken across chunks, which is why it is part of the saved progress.
  for (let i = progress.entries; i < meta.entryChunks; i++) {
    const rows = await fetchJson(`data/entries-${pad(i)}.json`, dataPath);
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
    const rows = await fetchJson(`data/index-${pad(i)}.json`, dataPath);   // [term, ids][]
    await putAll(db, INDEX, rows, (fraction) => report(fraction));
    progress = { ...progress, index: i + 1 };
    await save();
  }

  await run(db, STATE, 'readwrite', (store) => store.put(meta, 'meta'));
  await run(db, STATE, 'readwrite', (store) => store.delete('import'));
  if (onProgress) onProgress(1);
  else { status = { state: 'ready', progress: 1 }; setBadge(''); }
  trace(`Torval: dictionary ready, ${meta.entries} entries, ${meta.terms} forms`);

  function save() {
    return run(db, STATE, 'readwrite', (store) => store.put(progress, 'import'));
  }

  /** `within` is how far through the chunk currently being written we are. */
  // A dictionary being read in because somebody ticked a box on the settings
  // page is not the one being read from, so it must not touch the badge or
  // the status the popup reads. It reports to whoever asked for it instead.
  function report(within) {
    const done = progress.entries + progress.index + within;
    if (onProgress) { onProgress(done / total); return; }
    status = { state: 'loading', progress: done / total };
    setBadge(Math.round((done / total) * 100) + '%');
  }
}

// ---------------------------------------------------------------------------
// IndexedDB helpers. Its callback style is old; these wrap it in promises.
// ---------------------------------------------------------------------------

function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name || dbName(), DB_VERSION);
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

// Every caller passes a path starting 'data/...', the Japanese layout every
// existing install already has; swapped here for whichever language is
// active, 'data-it/...' for Italian and 'data-es/...' for Spanish, rather
// than touching every call site.
async function fetchJson(path, dataPath) {
  const scoped = path.replace(/^data\//, (dataPath || TorvalLang.profile().dataPath) + '/');
  const res = await fetch(api.runtime.getURL(scoped));
  if (!res.ok) {
    throw new Error(`cannot read ${scoped} (${res.status}), ` +
      `run: ${TorvalLang.profile().build}`);
  }
  return res.json();
}

function pad(n) { return String(n).padStart(3, '0'); }

function setBadge(text) {
  if (!api.action || !api.action.setBadgeText) return;
  api.action.setBadgeText({ text }).catch(() => {});
}
