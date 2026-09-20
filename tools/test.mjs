/*
 * Torval, test suite
 *
 *   node --max-old-space-size=4096 tools/test.mjs
 *
 * Loads the built dictionary into memory and runs the extension's real lookup
 * code against it. The only thing stubbed is the storage layer: the extension
 * reads from IndexedDB, this reads from a Map. Everything above that, the
 * deinflection rules, the scan-every-length search, the ranking, is the same
 * code that ships.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'extension', 'data');
const require = createRequire(import.meta.url);
const Lookup = require(join(ROOT, 'extension', 'lookup.js'));
const Deinflect = require(join(ROOT, 'extension', 'deinflect.js'));
const Anki = require(join(ROOT, 'extension', 'anki.js'));
const Pitch = require(join(ROOT, 'extension', 'pitch.js'));
const Video = require(join(ROOT, 'extension', 'video.js'));
const Subs = require(join(ROOT, 'extension', 'subtitles.js'));
const Highlight = require(join(ROOT, 'extension', 'highlight.js'));
const Lang = require(join(ROOT, 'extension', 'lang.js'));
const DeinflectEs = require(join(ROOT, 'extension', 'deinflect-es.js'));
const DeinflectIt = require(join(ROOT, 'extension', 'deinflect-it.js'));
const LookupLatin = require(join(ROOT, 'extension', 'lookup-latin.js'));
const Common = require(join(ROOT, 'extension', 'lookup-common.js'));
const Article = require(join(ROOT, 'extension', 'article.js'));
const { stressIndex: stressEs } = await import('./stress-es.mjs');
const { genderOf } = await import('./wiktextract.mjs');
Pitch._setData(JSON.parse(readFileSync(join(DATA, 'pitch.json'), 'utf8')));

if (!existsSync(join(DATA, 'meta.json'))) {
  console.error('No dictionary built yet. Run: node tools/build-dict.mjs');
  process.exit(1);
}

const meta = JSON.parse(readFileSync(join(DATA, 'meta.json'), 'utf8'));
const entries = [];
for (let i = 0; i < meta.entryChunks; i++) {
  for (const e of JSON.parse(readFileSync(join(DATA, `entries-${String(i).padStart(3, '0')}.json`), 'utf8'))) {
    e.id = entries.length;
    entries.push(e);
  }
}
const index = new Map();
for (let i = 0; i < meta.indexChunks; i++) {
  for (const [term, ids] of JSON.parse(readFileSync(join(DATA, `index-${String(i).padStart(3, '0')}.json`), 'utf8'))) {
    index.set(term, ids);
  }
}

const db = {
  async getEntries(terms) {
    const out = new Map();
    for (const term of terms) {
      const ids = index.get(term);
      if (ids) out.set(term, ids.map((id) => entries[id]));
    }
    return out;
  }
};

/** The same, for a second built dictionary read out of its own directory. */
function loadDictionary(dir) {
  const own = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const rows = [];
  for (let i = 0; i < own.entryChunks; i++) {
    const name = `entries-${String(i).padStart(3, '0')}.json`;
    for (const e of JSON.parse(readFileSync(join(dir, name), 'utf8'))) {
      e.id = rows.length;
      rows.push(e);
    }
  }
  const terms = new Map();
  for (let i = 0; i < own.indexChunks; i++) {
    const name = `index-${String(i).padStart(3, '0')}.json`;
    for (const [term, ids] of JSON.parse(readFileSync(join(dir, name), 'utf8'))) {
      terms.set(term, ids);
    }
  }
  return {
    async getEntries(asked) {
      const out = new Map();
      for (const term of asked) {
        const ids = terms.get(term);
        if (ids) out.set(term, ids.map((id) => rows[id]));
      }
      return out;
    }
  };
}

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(`${name}${detail ? '\n      ' + detail : ''}`);
}

/** The top match for `text` should be `expected` characters of surface text. */
async function topMatch(text, expectedSurface, expectedHeadword, expectedReasons) {
  // What a hover on the first character actually does: read the sentence,
  // then ask for the word the reading landed on. Asking search on its own
  // would be asking a different question, one no part of the extension asks.
  const at = await Lookup.tokenAt(text, 0, db);
  const groups = await Lookup.search(text.slice(at.start), db, at.length);
  if (!groups.length) return check(text, false, 'no match at all');
  const top = groups[0];
  const hit = top.hits[0];
  const headword = hit.entry.k[0] || hit.entry.r[0];
  const reasons = hit.reasons.join(' < ');

  const okSurface = top.surface === expectedSurface;
  const okHead = expectedHeadword === undefined || headword === expectedHeadword;
  const okReasons = expectedReasons === undefined || reasons === expectedReasons;

  check(
    `${text}`,
    okSurface && okHead && okReasons,
    `got surface "${top.surface}" headword "${headword}" reasons "${reasons}"; ` +
    `wanted surface "${expectedSurface}"` +
    (expectedHeadword ? ` headword "${expectedHeadword}"` : '') +
    (expectedReasons !== undefined ? ` reasons "${expectedReasons}"` : '')
  );
}

/** `text` should produce a match whose headword is `headword` somewhere in the results. */
async function contains(text, headword) {
  const groups = await Lookup.search(text, db);
  const found = groups.some((g) => g.hits.some((h) => h.entry.k[0] === headword || h.entry.r[0] === headword));
  check(`${text} contains ${headword}`, found,
    'got ' + JSON.stringify(groups.map((g) => g.hits.map((h) => h.entry.k[0] || h.entry.r[0]))));
}

/** `text` must NOT produce `headword`, guards against the deinflector inventing words. */
async function excludes(text, headword) {
  const groups = await Lookup.search(text, db);
  const found = groups.some((g) => g.hits.some((h) => h.entry.k[0] === headword || h.entry.r[0] === headword));
  check(`${text} excludes ${headword}`, !found, 'but it matched');
}

const run = async () => {
  console.log(`dictionary: ${meta.entries} entries, ${meta.terms} forms (built ${meta.built})\n`);

  // --- longest-match segmentation --------------------------------------
  // The cursor sits at the start of a sentence; we must not stop at 日 or 日本.
  await topMatch('日本語を勉強しています', '日本語', '日本語');
  await topMatch('図書館で本を読む', '図書館', '図書館');
  await topMatch('新しい車を買った', '新しい', '新しい');

  // --- verb conjugation -------------------------------------------------
  await topMatch('食べる', '食べる', '食べる', '');
  await topMatch('食べます', '食べます', '食べる', 'polite');
  await topMatch('食べました', '食べました', '食べる', 'polite < past');
  await topMatch('食べません', '食べません', '食べる', 'polite < negative');
  await topMatch('食べませんでした', '食べませんでした', '食べる', 'polite < negative past');
  await topMatch('食べなかった', '食べなかった', '食べる', 'negative < past');
  // JMdict lists 食べられる ("edible") as a word of its own, so that wins the top
  // slot; the passive of 食べる has to still be offered alongside it.
  await contains('食べられる', '食べられる');
  await contains('食べられる', '食べる');
  await topMatch('食べさせられた', '食べさせられた', '食べる', 'causative passive < past');
  await topMatch('食べたくなかった', '食べたくなかった', '食べる', 'want to < negative < past');
  await topMatch('食べている', '食べている', '食べる', 'て form < progressive');
  await topMatch('食べてしまった', '食べてしまった', '食べる', 'て form < completely < past');
  await topMatch('食べちゃった', '食べちゃった', '食べる', 'て form < completely < past');

  // Godan across all nine rows, in their trickiest (て/た) forms.
  await topMatch('買って', '買って', '買う', 'て form');
  await topMatch('書いた', '書いた', '書く', 'past');
  await topMatch('泳いで', '泳いで', '泳ぐ', 'て form');
  await topMatch('話して', '話して', '話す', 'て form');
  await contains('待った', '待つ');   // 待った is also a noun in its own right
  await topMatch('死んで', '死んで', '死ぬ', 'て form');
  await topMatch('遊んだ', '遊んだ', '遊ぶ', 'past');
  await topMatch('読んで', '読んで', '読む', 'て form');
  await topMatch('取って', '取って', '取る', 'て form');
  // 行く is the classic irregular て-form, 行いて would be wrong.
  await contains('行って', '行く');

  // Irregulars.
  await contains('来ました', '来る');
  await contains('こなかった', '来る');
  await contains('しています', 'する');
  // JMdict has no 勉強する entry, so する has to be peeled off to reach 勉強.
  await contains('勉強しました', '勉強');
  await contains('運動できない', '運動');

  // --- adjectives -------------------------------------------------------
  await topMatch('高くない', '高くない', '高い', 'negative');
  await topMatch('高かった', '高かった', '高い', 'past');
  await topMatch('高くなかった', '高くなかった', '高い', 'negative < past');
  await topMatch('美しくて', '美しくて', '美しい', 'て form');
  await contains('よかった', '良い');
  await contains('静かじゃない', '静か');
  await contains('元気でした', '元気');

  // --- kana-only and readings ------------------------------------------
  await contains('わかりました', '分かる');
  await contains('ありがとう', 'ありがとう');
  await contains('コーヒーを', 'コーヒー');

  // --- a common word plus a trailing particle beating a rarer real word ---
  // 今日 ("today") plus は (the topic particle) spells the same three
  // characters as a genuine, much rarer JMdict entry: 今日は, a dated way to
  // write こんにちは ("hello"). Longest-match-wins would pick the greeting
  // every time, which is backwards for what someone actually typed.
  await topMatch('今日は早く起きた', '今日', '今日');
  // The rare reading is still there, just not first, "shorter matches" is
  // exactly where it belongs, for the rare case someone did mean "hello".
  await contains('今日は早く起きた', '今日は');
  // A real compound should never be second-guessed just for ending in a
  // particle-shaped kana, 図書館 is not rare next to 図書, so it stays first.
  await topMatch('図書館で本を読む', '図書館', '図書館');
  // 友達 (friend) is, if anything, commoner than 友 alone, nothing to demote.
  await topMatch('友達と話した', '友達', '友達');

  // --- guarding against invented words ---------------------------------
  // 少ない is an adjective; the ichidan rule would make it the verb 少る.
  await excludes('少ない', '少る');
  // きれい must lead with 綺麗, not with 切れる reached via the masu-stem of きれ.
  const kirei = await Lookup.search('きれい', db);
  check('きれい leads with 綺麗', kirei[0].surface === 'きれい', 'got ' + kirei[0].surface);
  // A run of kana that is not a word should not produce a long bogus match.
  const junk = await Lookup.search('ぁぃぅぇぉ', db);
  check('nonsense input stays empty-ish', junk.every((g) => g.length <= 2),
    'got ' + JSON.stringify(junk.map((g) => g.surface)));

  // --- ranking by how the text is actually written ---------------------
  // Bare kana in running text is a particle far more often than it is a rare
  // noun that happens to share the sound.
  for (const [kana, gloss] of [['は', 'topic'], ['が', 'subject'], ['の', 'possessive'], ['を', 'direct object']]) {
    const top = (await Lookup.search(kana, db))[0].hits[0];
    check(`${kana} leads with the particle`,
      top.entry.s.some((sn) => sn.p.includes('prt')) && JSON.stringify(top.entry.s[0].g).includes(gloss),
      'got ' + JSON.stringify(top.entry.s[0].g));
  }
  // 本 also reads もと, and that entry is led by a different kanji (元).
  const hon = (await Lookup.search('本語を', db))[0].hits[0];
  check('本 leads with ほん, not the もと entry', hon.entry.r[0] === 'ほん', 'got ' + hon.entry.r[0]);
  check('the matched spelling is reported so the popup can show it',
    hon.matched === '本', 'got ' + hon.matched);

  // --- shorter matches are kept and ordered ----------------------------
  const groups = await Lookup.search('日本語', db);
  check('shorter matches are offered below the longest',
    groups.length >= 2 && groups[0].surface === '日本語' && groups.some((g) => g.surface === '日本'),
    'got ' + JSON.stringify(groups.map((g) => g.surface)));

  // The same entry must not be repeated at several lengths: 勉強しています would
  // otherwise list 勉強 four times, once per trailing fragment.
  const benkyouGroups = await Lookup.search('勉強しています', db);
  const seen = benkyouGroups.flatMap((g) => g.hits.map((h) => h.entry.id));
  check('each entry appears at only one length', seen.length === new Set(seen).size,
    'got ' + JSON.stringify(benkyouGroups.map((g) => g.surface + ':' + g.hits.length)));

  // --- common words outrank obscure homographs -------------------------
  const hito = await Lookup.search('人', db);
  check('人 leads with the common entry', hito[0].hits[0].entry.f > 0,
    'got f=' + hito[0].hits[0].entry.f);

  // --- part-of-speech data survived the XML parse ----------------------
  const taberu = (await db.getEntries(['食べる'])).get('食べる')[0];
  check('食べる is tagged v1', taberu.s[0].p.includes('v1'), JSON.stringify(taberu.s[0].p));
  const benkyou = (await db.getEntries(['勉強'])).get('勉強')[0];
  check('勉強 carries the vs tag on an inherited sense',
    benkyou.s.some((s) => s.p.includes('vs')), JSON.stringify(benkyou.s.map((s) => s.p)));

  // --- speed ------------------------------------------------------------
  const sentences = ['日本語を勉強しています', '食べさせられた', '新しい車を買った', '図書館で本を読んでいました'];
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) await Lookup.search(sentences[i % sentences.length], db);
  const ms = (performance.now() - t0) / 100;
  check(`lookup is fast enough (${ms.toFixed(1)}ms per hover)`, ms < 25, `${ms.toFixed(1)}ms`);

  // --- Anki ------------------------------------------------------------
  // The real field list from a sentence-mining note type should need no setup.
  const guessed = Anki.guessMapping(
    ['Sentence', 'Target Word', 'Definitions', 'Dictionary Definitions', 'Reading',
     'Sentence Audio', 'Word Audio', 'Images', 'Source', 'Pitch', 'Sentence English']);
  check('field mapping is guessed from the field names',
    guessed['Target Word'] === 'word' && guessed['Reading'] === 'reading' &&
    guessed['Sentence'] === 'sentence' && guessed['Definitions'] === 'definition',
    JSON.stringify(guessed));
  check('audio, pitch, frame and sentence audio are recognised too',
    guessed['Word Audio'] === 'audio' && guessed['Pitch'] === 'pitch' &&
    guessed['Images'] === 'image' && guessed['Sentence Audio'] === 'sentenceAudio',
    JSON.stringify(guessed));
  check('fields it cannot place are left blank rather than guessed at',
    guessed['Source'] === '' && guessed['Sentence English'] === '',
    JSON.stringify(guessed));

  // Captured media is stored in Anki and referenced, not pasted into the field.
  let mediaCalls = [];
  globalThis.fetch = async (url, init) => {
    mediaCalls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ result: 1, error: null }) };
  };
  await Anki.addNote(
    { deck: 'D', model: 'M', fields: { Images: 'image', 'Sentence Audio': 'sentenceAudio' } },
    { word: '食べる', media: {
      image: { filename: 'torval-abc.jpg', data: 'AAAA' },
      sentenceAudio: { filename: 'torval-abc.webm', data: 'BBBB' } } });
  const added = mediaCalls.find((c) => c.action === 'addNote').params.note.fields;
  check('a frame is stored and referenced as an image',
    mediaCalls.filter((c) => c.action === 'storeMediaFile').length === 2 &&
    added['Images'] === '<img src="torval-abc.jpg">',
    JSON.stringify(added));
  check('the line’s audio is stored and referenced as a sound',
    added['Sentence Audio'] === '[sound:torval-abc.webm]', JSON.stringify(added));

  // What was said just before and just after. Optional: they go on the card
  // only where a field on the note type asks for them, so nobody who has not
  // asked for them gets them.
  mediaCalls = [];
  await Anki.addNote(
    { deck: 'D', model: 'M', fields: {
      Sentence: 'sentence', Before: 'sentenceBefore', After: 'sentenceAfter' } },
    { sentence: '\u5b09\u3057\u304b\u3063\u305f\u3067\u3059\u3002',
      sentenceBefore: '\u306a\u3063\u3066\u308b\u306e\u3067',
      sentenceAfter: '\u3042\u308a\u304c\u3068\u3046' });
  const around = mediaCalls.find((c) => c.action === 'addNote').params.note.fields;
  check('the lines either side go on the card when a field asks for them',
    around['Before'] === '\u306a\u3063\u3066\u308b\u306e\u3067' &&
    around['After'] === '\u3042\u308a\u304c\u3068\u3046', JSON.stringify(around));

  mediaCalls = [];
  await Anki.addNote(
    { deck: 'D', model: 'M', fields: { Sentence: 'sentence' } },
    { sentence: '\u5b09\u3057\u304b\u3063\u305f\u3067\u3059\u3002',
      sentenceBefore: '\u306a\u3063\u3066\u308b\u306e\u3067' });
  const only = mediaCalls.find((c) => c.action === 'addNote').params.note.fields;
  check('and nowhere at all when no field does',
    Object.keys(only).join(',') === 'Sentence', JSON.stringify(only));

  // A page with no video, or one that refuses to be captured, still makes cards.
  mediaCalls = [];
  await Anki.addNote(
    { deck: 'D', model: 'M', fields: { 'Target Word': 'word', Images: 'image' } },
    { word: '食べる', media: {} });
  const noFrame = mediaCalls.find((c) => c.action === 'addNote');
  check('no video still makes the card, with the frame left off',
    noFrame && !('Images' in noFrame.params.note.fields) &&
    !mediaCalls.some((c) => c.action === 'storeMediaFile'),
    JSON.stringify(mediaCalls.map((c) => c.action)));

  // One sentence can teach three words, so a repeated sentence must not be
  // treated as a duplicate. Anki's own rule compares first fields, which on a
  // sentence-mining note type is the sentence, so that rule is left off, and
  // whether a word is already known is answered separately, up front, as
  // information rather than as a gate. See the duplicate tests just below.
  const mining = { deck: 'Japanese::Sentence Mining', model: 'M',
    fields: { Sentence: 'sentence', 'Target Word': 'word' } };

  // Duplicates are allowed: addNote must succeed even when the word is
  // already in the collection, and must not itself refuse or even ask.
  let dupCalls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    dupCalls.push(body.action);
    return { ok: true, json: async () => ({
      result: body.action === 'findNotes' ? [999] : 1, error: null }) };
  };
  let dupErr = null;
  await Anki.addNote(mining, { word: '食べる', sentence: 'C' }).catch((e) => { dupErr = e.message; });
  check('adding an already-known word succeeds rather than being refused',
    !dupErr, dupErr);
  check('addNote does not itself query for duplicates, that is a separate, up-front check',
    !dupCalls.includes('findNotes'), JSON.stringify(dupCalls));

  // The separate, explicit check still correctly reports a duplicate when asked.
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    return { ok: true, json: async () => ({
      result: body.action === 'findNotes' ? [999] : [], error: null }) };
  };
  check('alreadyHave reports a duplicate when asked directly',
    await Anki.alreadyHave(mining, { word: '食べる' }));
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ result: [], error: null }) });
  check('alreadyHave reports no duplicate for a genuinely new word',
    !(await Anki.alreadyHave(mining, { word: '新語' })));

  // What can be known to be wrong before a line is recorded. The point of
  // asking these early is that on a video the recording takes as long as
  // the line does, so an answer that arrives afterwards arrives too late.
  check('no deck picked is caught before anything is recorded',
    /No deck chosen/.test(Anki.whatIsMissing({ model: 'Mining' }) || ''),
    String(Anki.whatIsMissing({ model: 'Mining' })));
  check('no note type picked is caught too',
    /No deck chosen/.test(Anki.whatIsMissing({ deck: 'Japanese' }) || ''));
  check('a mapping with every field left blank is caught',
    /fields are mapped/.test(
      Anki.whatIsMissing({ deck: 'A', model: 'B', fields: { Front: '', Back: '' } }) || ''));
  check('a usable configuration is not complained about',
    Anki.whatIsMissing(mining) === null, String(Anki.whatIsMissing(mining)));

  globalThis.fetch = async () => { throw new Error('connection refused'); };
  let notRunning = '';
  await Anki.checkReady(mining).catch((e) => { notRunning = e.message; });
  check('Anki not running is reported before a card is attempted',
    /not answering|not running/i.test(notRunning), notRunning);

  // A call that never answers must end in something being said, rather than in
  // the + on a card showing a dot for ever, which is what it did.
  Anki._deadlines(0.05, 0.05);
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    // No deadline set means the old behaviour: this would hang for ever, so
    // it fails quickly instead, and with a different message.
    if (!init || !init.signal) { setTimeout(() => reject(new Error('no deadline')), 20); return; }
    init.signal.addEventListener('abort', () => {
      const stop = new Error('aborted');
      stop.name = 'AbortError';
      reject(stop);
    });
  });
  let said = null;
  await Anki.addNote(mining, { word: '待つ', sentence: 'D' }).catch((e) => { said = e.message; });
  check('a request that never answers ends in a message, not in silence',
    /did not answer/.test(said || ''), String(said));
  Anki._deadlines(10, 8);

  // B opens Anki's browser on a word, with the same search the duplicate
  // check uses, so what Anki shows is what Torval meant by "already in your
  // collection".
  let sentToAnki = null;
  globalThis.fetch = async (url, init) => {
    sentToAnki = JSON.parse(init.body);
    return { ok: true, json: async () => ({ result: null, error: null }) };
  };
  await Anki.browse(mining, '食べる');
  check('B asks Anki to open its browser', sentToAnki.action === 'guiBrowse', JSON.stringify(sentToAnki));
  check('and searches for the word alone, in every deck and every field',
    sentToAnki.params.query === '"食べる"', sentToAnki.params.query);

  // A word with a colon in it must not turn into search syntax.
  await Anki.browse(mining, 'a:b');
  check('a colon in the word is escaped, not read as a search field',
    sentToAnki.params.query.indexOf('a\\:b') !== -1, sentToAnki.params.query);


  // Deck names nest with colons, which must survive; a word's own colon must not.
  check('deck names keep their colons, field values do not',
    Anki.escapeSearch('A::B') === 'A::B' && Anki.escapeSearch('a:b', true) === 'a\\:b',
    Anki.escapeSearch('A::B') + ' | ' + Anki.escapeSearch('a:b', true));

  // Back to a collection that has nothing in it yet.
  mediaCalls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    mediaCalls.push(body);
    return { ok: true, json: async () => ({
      result: body.action === 'findNotes' ? [] : 1, error: null }) };
  };

  // Nothing is captured for a card that has nowhere to put it.
  mediaCalls = [];
  await Anki.addNote(
    { deck: 'D', model: 'M', fields: { 'Target Word': 'word' } },
    { word: '食べる', media: { image: { filename: 'x.jpg', data: 'AAAA' } } });
  check('media is not stored when no field is pointed at it',
    mediaCalls.filter((c) => c.action === 'storeMediaFile').length === 0,
    JSON.stringify(mediaCalls.map((c) => c.action)));
  check('a source is claimed by one field only',
    guessed['Dictionary Definitions'] === '', JSON.stringify(guessed));

  // Build a note without touching the network.
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ result: 1, error: null }) };
  };
  await Anki.addNote(
    { deck: 'D', model: 'M', fields: guessed, tags: ['torval'] },
    { word: '食べる', reading: 'たべる', sentence: '<b>食べなかった</b>。',
      definition: '1. to eat' });
  check('the card carries the word, reading, sentence and definition',
    sent.params.note.fields['Target Word'] === '食べる' &&
    sent.params.note.fields['Reading'] === 'たべる' &&
    sent.params.note.fields['Sentence'] === '<b>食べなかった</b>。' &&
    sent.params.note.fields['Definitions'] === '1. to eat',
    JSON.stringify(sent && sent.params.note.fields));
  check('unmapped fields are left off the card entirely',
    !('Pitch' in sent.params.note.fields), JSON.stringify(Object.keys(sent.params.note.fields)));
  // Anki would compare first fields, which on a sentence-mining note type is
  // the sentence; Torval asks about the word instead. See the duplicate tests below.
  check('Anki’s first-field duplicate rule is left off',
    sent.params.note.options.allowDuplicate === true);

  let refused = null;
  await Anki.addNote({ deck: 'D', model: 'M', fields: {} }, { word: 'x' }).catch((e) => { refused = e.message; });
  check('an unmapped note type is refused with an explanation', !!refused && /options/.test(refused), refused);
  await Anki.addNote(null, { word: 'x' }).catch((e) => { refused = e.message; });
  check('no deck chosen yet is refused with an explanation', /deck/.test(refused), refused);

  // --- audio ------------------------------------------------------------
  // JapanesePod101 hands back a fixed "no audio available" recording rather
  // than a 404, so the only way to tell is to look at the bytes.
  const realAudio = new Uint8Array(4096).fill(7);

  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => realAudio.buffer });
  check('real audio comes back as base64', typeof (await Anki.fetchAudio('食べる', 'たべる')) === 'string');

  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array(60).buffer });
  check('a truncated or empty reply is not treated as audio',
    (await Anki.fetchAudio('食べる', 'たべる')) === null);

  globalThis.fetch = async () => { throw new Error('offline'); };
  check('an unreachable audio host does not throw', (await Anki.fetchAudio('食べる')) === null);

  check('media filenames survive any filesystem',
    /^torval-[\p{L}\p{N}-]+\.mp3$/u.test(Anki.audioFilename('食べる', 'たべる')),
    Anki.audioFilename('食べる', 'たべる'));

  // A card must still be made when there is no audio to be had.
  let calls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('languagepod101')) return { ok: true, arrayBuffer: async () => new Uint8Array(10).buffer };
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ result: 1, error: null }) };
  };
  await Anki.addNote(
    { deck: 'D', model: 'M', fields: { 'Target Word': 'word', 'Word Audio': 'audio' } },
    { word: '食べる', reading: 'たべる' });
  const withoutAudio = calls.find((c) => c.action === 'addNote');
  check('no audio still makes the card, with the audio field left off',
    withoutAudio && !('Word Audio' in withoutAudio.params.note.fields) &&
    !calls.some((c) => c.action === 'storeMediaFile'),
    JSON.stringify(calls.map((c) => c.action)));

  // And when there is audio, it is stored and referenced.
  calls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('languagepod101')) return { ok: true, arrayBuffer: async () => realAudio.buffer };
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ result: 1, error: null }) };
  };
  await Anki.addNote(
    { deck: 'D', model: 'M', fields: { 'Target Word': 'word', 'Word Audio': 'audio' } },
    { word: '食べる', reading: 'たべる' });
  const withAudio = calls.find((c) => c.action === 'addNote');
  check('audio is stored in Anki and referenced by a sound tag',
    calls.some((c) => c.action === 'storeMediaFile') && withAudio &&
    /^\[sound:torval-.+\.mp3\]$/.test(withAudio.params.note.fields['Word Audio']),
    JSON.stringify(calls.map((c) => c.action)) + ' ' +
    JSON.stringify(withAudio && withAudio.params.note.fields));

  check('Word Audio is guessed from the field name',
    Anki.guessMapping(['Word Audio'])['Word Audio'] === 'audio');
  delete globalThis.fetch;

  // --- search-only spellings -------------------------------------------
  // ます is filed under the kanji 〼, which JMdict tags "sK", findable, but
  // never to be shown. The entry must report no showable spelling at all.
  const masu = (await Lookup.search('ます', db))[0].hits
    .find((h) => h.entry.s.some((sn) => sn.p.includes('aux-v')));
  check('the ます entry is found', !!masu);
  if (masu) {
    check('ます has no spelling fit to display, so the kana is the word',
      masu.entry.kv === 0 && masu.entry.k.includes('〼'),
      'kv=' + masu.entry.kv + ' k=' + JSON.stringify(masu.entry.k));
    check('ます is still ranked as a kana word',
      (await Lookup.search('ます', db))[0].hits[0].entry.s.some((sn) => sn.p.includes('aux-v')));
  }

  // --- how a word is named ---------------------------------------------
  // One place decides this, so the popup, the pitch lookup and the card agree.
  const masuEntry = (await db.getEntries(['ます'])).get('ます')
    .find((e) => e.s.some((sn) => sn.p.includes('aux-v')));
  const masuShown = Lookup.displayForm(masuEntry, 'ます');
  check('a word with only a search-only spelling is named by its kana',
    masuShown.word === 'ます' && masuShown.reading === '',
    JSON.stringify(masuShown));

  const honEntry = (await db.getEntries(['本'])).get('本')
    .find((e) => e.r[0] === 'ほん' && e.k[0] === '本');
  check('a word is named by the spelling that was matched',
    JSON.stringify(Lookup.displayForm(honEntry, '本')) === '{"word":"本","reading":"ほん"}',
    JSON.stringify(Lookup.displayForm(honEntry, '本')));

  const haEntry = (await db.getEntries(['は'])).get('は').find((e) => e.k[0] === '葉');
  check('a word matched by its reading is still named by its kanji',
    JSON.stringify(Lookup.displayForm(haEntry, 'は')) === '{"word":"葉","reading":"は"}',
    JSON.stringify(Lookup.displayForm(haEntry, 'は')));

  check('data built before kv existed shows its spellings rather than none',
    Lookup.displayForm({ k: ['本'], r: ['ほん'], s: [] }, '本').reading === 'ほん');

  // A word usually written in kana still has a kanji spelling filed in the
  // dictionary, and matching it by that kanji spelling should show it, but
  // matching it by its kana should never surface the kanji instead. コーヒー
  // is "usually kana" over its own listed spelling 珈琲.
  const coffeeEntry = (await db.getEntries(['コーヒー'])).get('コーヒー')[0];
  check('a usually-kana word matched by its kana stays in kana',
    JSON.stringify(Lookup.displayForm(coffeeEntry, 'コーヒー')) === '{"word":"コーヒー","reading":""}',
    JSON.stringify(Lookup.displayForm(coffeeEntry, 'コーヒー')));
  check('the same word matched by its own kanji still shows that kanji',
    JSON.stringify(Lookup.displayForm(coffeeEntry, '珈琲')) === '{"word":"珈琲","reading":"コーヒー"}',
    JSON.stringify(Lookup.displayForm(coffeeEntry, '珈琲')));

  check('every hit is named, ready for the popup and the card',
    (await Lookup.search('日本語', db))[0].hits.every((h) => h.word && h.reading));

  // --- frequency --------------------------------------------------------
  const rankOf = async (text) => (await Lookup.search(text, db))[0].hits[0].entry.q;
  for (const [word, ceiling] of [['人', 200], ['食べる', 500], ['本', 500], ['日本語', 8000]]) {
    const q = await rankOf(word);
    check(`${word} is ranked, and ranked common (#${q})`, q > 0 && q < ceiling, 'got ' + q);
  }
  check('a common word outranks an obscure one',
    (await rankOf('食べる')) < (await rankOf('図書館')),
    (await rankOf('食べる')) + ' vs ' + (await rankOf('図書館')));

  // The rank has to belong to the word, not to whether anyone writes it in kana:
  // 日本語 is a common word that is almost never spelled にほんご.
  check('the rank is the word’s, not its kana spelling’s',
    (await rankOf('日本語')) < 20000, 'got ' + (await rankOf('日本語')));

  check('words the corpus never saw simply have no rank',
    (await Lookup.search('齟齬', db))[0].hits[0].entry.q === undefined ||
    (await Lookup.search('齟齬', db))[0].hits[0].entry.q > 0);

  // A rank is rounded to a band, because the gap between #100 and #400 is real
  // and the gap between #7,261 and #7,800 is not.
  for (const [rank, band] of [[1, 'top 1k'], [1000, 'top 1k'], [1001, 'top 2k'],
    [4705, 'top 5k'], [7261, 'top 10k'], [20000, 'top 20k'], [50001, 'rare'], [140824, 'rare']]) {
    check(`#${rank} reads as "${band}"`, Lookup.frequencyBand(rank) === band,
      'got ' + Lookup.frequencyBand(rank));
  }
  check('a word with no rank gets no band rather than "rare"',
    Lookup.frequencyBand(undefined) === '' && Lookup.frequencyBand(0) === '');

  // --- frequency blended from two corpora ---------------------------------
  // Every rank the extension ever sees already comes out of the build step
  // blended from JPDB (anime, manga, visual novels) and BCCWJ (newspapers,
  // books, the web), this only checks that ordinary, everyday words still
  // land solidly in the top bands once both have had a say, not any specific
  // number, since the exact rank moves whenever either source is refreshed.
  for (const [word, band] of [['本', 'top 1k'], ['車', 'top 1k'], ['食べる', 'top 1k'], ['人', 'top 1k']]) {
    const hit = (await Lookup.search(word, db))[0].hits[0];
    check(`${word} still reads as common once two corpora are blended`,
      Lookup.frequencyBand(hit.entry.q) === band, 'got ' + Lookup.frequencyBand(hit.entry.q));
  }

  // --- tags that belong to the word, not to one meaning ------------------
  // 事 is tagged "usually written in kana" on all ten of its senses. That is a
  // fact about the word, and printing it ten times says nothing ten times.
  const kotoEntry = (await db.getEntries(['事'])).get('事')
    .find((e) => e.s.length > 5);
  check('a tag on every sense is recognised as the word’s',
    Lookup.sharedTags(kotoEntry).includes('uk'),
    JSON.stringify(kotoEntry.s.map((sn) => sn.m || [])));

  // 綺麗 is the opposite case, and the reason not to simply hoist every "uk":
  // JMdict marks its "clean" and "completely" senses as usually-kana but not its
  // "pretty" sense, and that distinction is worth keeping.
  const kireiEntry = (await db.getEntries(['綺麗'])).get('綺麗')[0];
  check('a tag on only some senses is left where it belongs',
    !Lookup.sharedTags(kireiEntry).includes('uk'),
    JSON.stringify(kireiEntry.s.map((sn) => sn.m || [])));

  // A tag on only some senses genuinely describes those senses.
  const partly = { s: [{ m: ['uk', 'col'] }, { m: ['uk'] }, { m: ['uk', 'arch'] }] };
  check('a tag on only some senses stays with them',
    JSON.stringify(Lookup.sharedTags(partly)) === '["uk"]',
    JSON.stringify(Lookup.sharedTags(partly)));
  check('an entry with no tags at all is handled',
    JSON.stringify(Lookup.sharedTags({ s: [{ g: ['x'] }, { g: ['y'] }] })) === '[]');

  // --- part of speech shared across senses -------------------------------
  // 勉強 has four senses with genuinely different grammar: n,vs,vt / n,vs,vi /
  // plain n / n,vs,vt,vi. Only "n" is common to all four.
  const benkyouAll = (await db.getEntries(['勉強'])).get('勉強');
  const benkyouEntry = benkyouAll.find((e) => e.s.length === 4);
  check('the shared part of speech is only what every sense actually has',
    JSON.stringify(Lookup.sharedPos(benkyouEntry)) === '["n"]',
    JSON.stringify(Lookup.sharedPos(benkyouEntry)));

  // 読む is v5m,vt on every one of its senses, the whole combination is shared.
  const yomuEntry = (await db.getEntries(['読む'])).get('読む')[0];
  check('a part of speech identical on every sense is shared in full',
    JSON.stringify(Lookup.sharedPos(yomuEntry).sort()) === '["v5m","vt"]',
    JSON.stringify(Lookup.sharedPos(yomuEntry)));

  // --- extracting known words from a passage of text ----------------------
  // This is what "known words" is built on: the same search a hover uses,
  // run forward across a whole passage rather than stopping at one word.
  const passage = '今日は早く起きて、コーヒーを飲みました。それから本を読んでいました。';
  const extracted = await Lookup.extractWords(passage, db);
  check('conjugated words are recorded by their dictionary form',
    extracted.includes('起きる') && extracted.includes('飲む') && extracted.includes('読む'),
    JSON.stringify(extracted));
  check('a kana-only word is still picked up', extracted.includes('コーヒー'), JSON.stringify(extracted));
  check('punctuation and particles do not themselves become entries',
    !extracted.includes('。') && !extracted.includes('、'), JSON.stringify(extracted));

  check('the same word said twice in a passage is only recorded once',
    (await Lookup.extractWords('食べました。食べました。', db))
      .filter((w) => w === '食べる').length === 1);

  check('non-Japanese text yields nothing, not an error',
    JSON.stringify(await Lookup.extractWords('Hello, world! 123', db)) === '[]');

  check('an empty passage yields an empty list',
    JSON.stringify(await Lookup.extractWords('', db)) === '[]');

  // A word split by punctuation should still be found on the far side of it.
  check('extraction continues past punctuation to the next word',
    (await Lookup.extractWords('本、車、人', db)).length === 3,
    JSON.stringify(await Lookup.extractWords('本、車、人', db)));

  // --- reading a sentence as a whole -------------------------------------
  // The hard part of Japanese is that nobody writes spaces, so every one of
  // these is a sentence that came out as nonsense when each word was chosen
  // on its own without looking at what it left behind. They are kept as
  // written rather than reduced to the two words that broke, because what is
  // being tested is the shape of the whole sentence.
  const reads = async (text, expected) => {
    const words = await Lookup.segment(text, db);
    const got = words.map((w) => text.slice(w.start, w.start + w.length));
    check('reads ' + text, got.join(' ') === expected.join(' '), got.join(' '));
  };

  // があ is a real entry, and taking it strands る with nothing to be.
  await reads('種がある。', ['種', 'が', 'ある']);
  await reads('全世界で約70属3700種がある。',
    ['全世界', 'で', '約', '属', '種', 'が', 'ある']);

  // Nothing may begin on a small vowel, so ジャ cannot be cut in half into
  // アジ and パ. っ is not in that company: って begins with one.
  await reads('でもそれって', ['でも', 'それ', 'って']);
  await reads('すごいですね。', ['すごい', 'です', 'ね']);

  // --- たり and たら, which hand a word on as a た-form ----------------------
  // Every past rule has to accept a た-form as well as the kind of word it
  // belongs to, because たり and たら have already turned one into the other
  // by the time it is reached. The copula and the adjectives did not, so the
  // chain stopped one step short and the り or the ら was left over as a word
  // of its own: 元気だったり came out as 元気, だった, り.
  {
    const reads = async (line) => {
      const tokens = await Lookup.locateTokens(line, db);
      return tokens.map((t) => line.slice(t.start, t.start + t.length)).join('/');
    };
    check('the copula listed with たり is one word',
      await reads('\u5143\u6c17\u3060\u3063\u305f\u308a') === '\u5143\u6c17/\u3060\u3063\u305f\u308a',
      await reads('\u5143\u6c17\u3060\u3063\u305f\u308a'));
    check('and so is an adjective',
      await reads('\u5fd9\u3057\u304b\u3063\u305f\u308a') === '\u5fd9\u3057\u304b\u3063\u305f\u308a',
      await reads('\u5fd9\u3057\u304b\u3063\u305f\u308a'));
    check('たら reaches the copula too',
      await reads('\u5b66\u751f\u3060\u3063\u305f\u3089') === '\u5b66\u751f/\u3060\u3063\u305f\u3089',
      await reads('\u5b66\u751f\u3060\u3063\u305f\u3089'));
    check('and an adjective',
      await reads('\u9ad8\u304b\u3063\u305f\u3089') === '\u9ad8\u304b\u3063\u305f\u3089',
      await reads('\u9ad8\u304b\u3063\u305f\u3089'));

    // Verbs never had the gap. They are here so that fixing the others
    // cannot quietly break them.
    check('verbs listed with たり still read as they did',
      await reads('\u98df\u3079\u305f\u308a\u98f2\u3093\u3060\u308a') ===
        '\u98df\u3079\u305f\u308a/\u98f2\u3093\u3060\u308a',
      await reads('\u98df\u3079\u305f\u308a\u98f2\u3093\u3060\u308a'));
    check('and an ordinary past is still an ordinary past',
      await reads('\u5148\u751f\u3060\u3063\u305f') === '\u5148\u751f/\u3060\u3063\u305f',
      await reads('\u5148\u751f\u3060\u3063\u305f'));
  }

  // The copula is a word, not an ending a noun grows.
  await reads('単子葉植物の一つの科である。',
    ['単子葉植物', 'の', '一つ', 'の', '科', 'である']);
  await reads('よしとです。', ['よし', 'と', 'です']);
  await reads('猫です。', ['猫', 'です']);
  await reads('静かである。', ['静か', 'である']);
  await reads('学生じゃないです。', ['学生', 'じゃない', 'です']);
  // It does conjugate as itself, though: でした is the past of です.
  const past = await Lookup.locateTokens('元気でした。', db);
  check('でした is read as the past of です',
    past.length === 2 && past[1].word === 'です', JSON.stringify(past));

  // A greeting spelled a way nobody spells it must not beat two ordinary
  // words, and a verb must not lose to an interjection nobody says.
  await reads('今日は暑いですね。', ['今日', 'は', '暑い', 'です', 'ね']);
  await reads('みなさんは日本に旅行に来たとき',
    ['みなさん', 'は', '日本', 'に', '旅行', 'に', '来た', 'とき']);

  // A name the dictionary has never heard of is left unread rather than
  // assembled out of whatever happens to overlap it. 僕 survives on one side
  // of it, which it did not when a stretch of nothing could run across the
  // change from kanji to kana.
  const name = await Lookup.segment('僕もちえこさんも', db);
  const nameSurfaces = name.map((w) => '僕もちえこさんも'.slice(w.start, w.start + w.length));
  check('a name nobody has heard of is left unread, not invented',
    nameSurfaces.indexOf('もち') === -1 && nameSurfaces.indexOf('えこ') === -1 &&
    nameSurfaces.indexOf('僕') !== -1, nameSurfaces.join(' '));

  // A hover and the marking under it come from the same reading, so they
  // cannot disagree about where a word begins or how long it is.
  const line = '今日は暑いですね。';
  for (const token of await Lookup.segment(line, db)) {
    for (let at = token.start; at < token.start + token.length; at++) {
      const found = await Lookup.tokenAt(line, at, db);
      check('hovering character ' + at + ' of ' + line + ' finds the word it is in',
        found.start === token.start && found.length === token.length,
        JSON.stringify(found) + ' wanted ' + JSON.stringify({ start: token.start, length: token.length }));
    }
  }

  // --- one question per hover, and the last sentence remembered ----------
  // A hover reads the sentence to find the word, and the popup is dressed
  // from what that reading already found rather than asking again. Moving
  // along a line asks the same question of the same sentence, so the reading
  // is kept; the danger in keeping it is answering about the wrong sentence.
  {
    const line = '今日は暑いですね。';
    for (const at of [0, 2, 3, 6]) {
      const found = await Lookup.tokenAt(line, at, db);
      const asked = await Lookup.search(line.slice(found.start), db, found.length);
      const hovered = await Lookup.hover(line, at, db);
      const front = hovered.groups.slice(0, asked.length).map((g) => g.surface);
      check('hovering character ' + at + ' says what asking twice would',
        hovered.start === found.start && hovered.length === found.length &&
        JSON.stringify(front) ===
          JSON.stringify(asked.slice(0, front.length).map((g) => g.surface)),
        JSON.stringify(hovered.groups.map((g) => g.surface)));

      // Anything past that begins at the character pointed at, and stays
      // inside the word: they are other ways of reading this word, and the
      // next word along is not one of them.
      const extra = hovered.groups.slice(asked.length);
      check('and anything more begins where the cursor is',
        extra.every((g) => line.slice(at, at + g.length) === g.surface &&
          at + g.length <= found.start + found.length),
        JSON.stringify(extra.map((g) => g.surface)));
    }

    // A different sentence, straight after, must not be answered from the
    // one before it.
    const other = await Lookup.hover('本を読みました。', 3, db);
    check('the next sentence is read afresh',
      other.groups.length > 0 && other.groups[0].hits[0].word === '読む',
      JSON.stringify(other.groups[0] && other.groups[0].hits[0].word));

    // And back again, which is the case a remembered sentence gets wrong if
    // it is keyed on anything less than the text itself.
    const back = await Lookup.hover(line, 0, db);
    check('and the first one still reads the same on return',
      back.start === 0 && back.groups[0].surface === '今日',
      JSON.stringify(back.groups[0] && back.groups[0].surface));
  }

  // The same sentence, with and without the space the player left in it.
  {
    const whole = '私の場合は繋がるわけじゃないのかも';
    const broken = '私の場合は繋がるわけじゃ ないのかも';
    const read = async (text) => (await Lookup.locateTokens(text, db)).map((t) => t.word);
    check('a wrapped line reads as words that are not there',
      (await read(broken)).indexOf('別') !== -1, (await read(broken)).join(' '));
    check('and without the space it is one expression again',
      (await read(whole)).indexOf('わけじゃない') !== -1, (await read(whole)).join(' '));
  }

  // --- hovering a word that the caption cut in half ----------------------
  // Three consecutive subtitles from a real video, cut mid-word at both
  // joins. Hovering the first character of a line has to see the line before
  // it, or the popup answers with a fragment: ない rather than わけじゃない,
  // さん rather than 皆さん. This is the path a hover takes, tokenAt to find
  // which word the cursor is in and then search for what to show.
  {
    const one = '私の場合は繋がるわけじゃ';
    const two = 'ないのかもっていうことなんですよね。皆';
    const three = 'さんがこう日常とか仕事の中で何を軸に';

    const hover = async (before, line, after, at) => {
      const text = before + line + after;
      const found = await Lookup.tokenAt(text, before.length + at, db);
      const groups = await Lookup.search(text.slice(found.start), db, found.length);
      return groups.length ? groups[0].hits[0].word : null;
    };

    check('a line read on its own answers a hover with a fragment',
      await hover('', two, '', 0) === 'ない', await hover('', two, '', 0));
    check('with the line before it, the word is whole',
      await hover(one, two, three, 0) === 'わけじゃない', await hover(one, two, three, 0));
    check('and the word cut off the end of a line is whole too',
      await hover(one, two, three, two.length - 1) === '皆さん',
      await hover(one, two, three, two.length - 1));
    check('as it is from the other side of the join',
      await hover(two, three, '', 0) === '皆さん', await hover(two, three, '', 0));
  }

  // --- a line cut in half mid-word ---------------------------------------
  // Automatic captions break wherever the speaker draws breath, which is
  // regularly in the middle of a verb. Read on its own, the end of such a
  // line is a handful of fragments that are not words; read with the line
  // that follows it, the word is whole.
  {
    const line = '昨日は友達と映画を見に行っ';
    const next = 'たので、とても楽しかった';

    const alone = (await Lookup.locateTokens(line, db)).map((t) => t.word);
    check('a line cut mid-verb reads as fragments on its own',
      alone.indexOf('見に行く') === -1, alone.join(' '));

    const whole = await Lookup.locateTokens(line + next, db);
    const together = Lookup.within(whole, 0, line.length);
    check('read with the line after it, the verb is whole again',
      together.some((t) => t.word === '見に行く'), together.map((t) => t.word).join(' '));
    check('and the fragments it was read as are gone',
      !together.some((t) => t.word === '行'), together.map((t) => t.word).join(' '));

    // The part of that verb on each line is marked on that line, so neither
    // is left with an unmarked hole in it.
    check('the first line marks the part of the word that is on it',
      together.some((t) => t.word === '見に行く' &&
        line.slice(t.start, t.start + t.length) === '見に行っ'),
      JSON.stringify(together.map((t) => [t.word, line.slice(t.start, t.start + t.length)])));

    const second = Lookup.within(whole, line.length, next.length);
    check('and the second line marks the rest of it',
      second.some((t) => t.word === '見に行く' && t.start === 0 && t.length === 1),
      JSON.stringify(second.map((t) => [t.word, t.start, t.length])));

    // Nothing is asked for, nothing changes: a line read with no neighbours
    // comes back exactly as it was.
    const plain = await Lookup.locateTokens(line, db);
    check('with nothing either side, the words are left as they are',
      JSON.stringify(Lookup.within(plain, 0, line.length)) === JSON.stringify(plain));
  }

  // --- crediting a transparent phrase for parts already known -------------
  // お元気ですか ("how are you") is filed in JMdict as one "exp" entry, but it
  // is nothing more than the honorific お, 元気, the copula です and the
  // particle か, someone who knows all four has no real gap here.
  const ogenki = await Lookup.locateTokens('お元気ですか', db);
  check('お元気ですか is read as one expression, tagged decomposable',
    ogenki.length === 1 && ogenki[0].word === 'お元気ですか' && ogenki[0].expression === true,
    JSON.stringify(ogenki));
  check('knowing every piece makes the whole phrase decomposable',
    await Lookup.decomposeKnown('お元気ですか', 0, 'お元気ですか'.length, db,
      new Set(['お', '元気', 'です', 'か'])));
  check('missing even one piece leaves it undecomposable',
    !(await Lookup.decomposeKnown('お元気ですか', 0, 'お元気ですか'.length, db,
      new Set(['お', '元気', 'です']))));
  check('an untouched span with nothing known does not decompose',
    !(await Lookup.decomposeKnown('お元気ですか', 0, 'お元気ですか'.length, db, new Set())));

  // A genuine idiom must never get this credit. Knowing 猫, の, 手, も and
  // 借りる word for word does not hand you "desperately busy". JMdict marks
  // it with the misc tag "id" for exactly this reason, and that is what has
  // to keep it out, since "exp" alone would not (猫の手も借りたい carries
  // both "exp" and "adj-i", the same shape an ordinary expression has).
  const idiom = await Lookup.locateTokens('猫の手も借りたい', db);
  check('a genuine idiom is never marked decomposable, even though it is "exp" too',
    idiom.length === 1 && idiom[0].expression === false, JSON.stringify(idiom));
  check('a genuine idiom does not decompose even when every word in it is known',
    !(await Lookup.decomposeKnown('猫の手も借りたい', 0, '猫の手も借りたい'.length, db,
      new Set(['猫', 'の', '手', 'も', '借りる']))));

  // Ordinary vocabulary, not an expression at all, is never sent through
  // this at all; locateTokens should say so plainly.
  const plain = await Lookup.locateTokens('食べる', db);
  check('an ordinary word is not flagged as an expression',
    plain.length === 1 && plain[0].expression === false, JSON.stringify(plain));

  // --- a boundary must never cut a sound in half --------------------------
  // ジャ is one sound written with two characters, and a word can no more
  // begin at ャ than an English one can begin mid-letter. Left free to break
  // there, the reader found three real dictionary entries by cutting ジャ
  // apart: アジ ("horse mackerel"), パ and ニーズ ("needs").
  const katakana = 'ユアジャパニーズ仲間みさです。';
  const kTokens = await Lookup.locateTokens(katakana, db);
  const kSurfaces = kTokens.map((t) => katakana.slice(t.start, t.start + t.length));
  check('ジャパニーズ is read whole rather than split at the small kana',
    kSurfaces.includes('ジャパニーズ'), JSON.stringify(kSurfaces));
  check('no token is assembled by cutting ジャ in half',
    !kSurfaces.includes('アジ') && !kSurfaces.includes('ニーズ'), JSON.stringify(kSurfaces));
  check('the rest of the sentence still reads normally',
    kSurfaces.includes('仲間'), JSON.stringify(kSurfaces));

  // The same rule has to hold for what a hover finds, or the mark on the page
  // and the popup would disagree about where the word even is.
  for (let at = 2; at <= 7; at++) {
    const start = await Lookup.wordAt(katakana, at, db);
    const found = (await Lookup.search(katakana.slice(start), db))[0];
    check(`pointing at character ${at} of ${katakana} finds ジャパニーズ`,
      found && found.surface === 'ジャパニーズ', 'got ' + JSON.stringify(found && found.surface));
  }

  // Reading a passage and hovering it have to agree, word for word, they are
  // what the marking on the page and the popup are each built from.
  for (const token of kTokens) {
    const start = await Lookup.wordAt(katakana, token.start, db);
    check(`hovering the start of ${katakana.slice(token.start, token.start + token.length)} agrees with reading it`,
      start === token.start, 'reading said ' + token.start + ', hovering said ' + start);
  }

  // A long vowel mark belongs to the character before it just as firmly.
  const coffee = await Lookup.locateTokens('コーヒーを飲む', db);
  check('コーヒー survives its long vowel marks',
    coffee.some((t) => 'コーヒーを飲む'.slice(t.start, t.start + t.length) === 'コーヒー'),
    JSON.stringify(coffee.map((t) => 'コーヒーを飲む'.slice(t.start, t.start + t.length))));

  // And a small tsu: 学校 and 行った must not be broken at っ.
  await topMatch('行った', '行った', '行く', 'past');

  // --- finding the word a pointed-at character actually belongs to --------
  // Pointing at フェ inside ネカフェ has to still find the whole word, not
  // read forward from フェ and land on something shorter and unrelated.
  for (let at = 0; at < 4; at++) {
    const start = await Lookup.wordAt('ネカフェ', at, db);
    const found = (await Lookup.search('ネカフェ'.slice(start), db))[0];
    check(`pointing at character ${at} of ネカフェ finds the whole word`,
      found && found.surface === 'ネカフェ', 'got ' + JSON.stringify(found));
  }

  // The same, inside a full sentence, must not overreach into a neighbouring
  // word on either side.
  const sentence = '昨日ネカフェに行った';
  for (const [at, expectSurface] of [[0, '昨日'], [1, '昨日'], [2, 'ネカフェ'],
    [4, 'ネカフェ'], [5, 'ネカフェ'], [7, '行った'], [9, '行った']]) {
    const start = await Lookup.wordAt(sentence, at, db);
    const found = (await Lookup.search(sentence.slice(start), db))[0];
    check(`character ${at} of "${sentence}" resolves to ${expectSurface}`,
      found && found.surface === expectSurface, 'got ' + JSON.stringify(found && found.surface));
  }

  // A noun immediately followed by に is the noun plus the ordinary particle,
  // not the noun's own adverbial form, only a real na-adjective has one of
  // those. This used to swallow に into the match for any noun at all.
  await topMatch('ネカフェに行った', 'ネカフェ', 'ネカフェ');
  // A genuine na-adjective's adverbial and attributive forms must still work.
  await contains('元気に', '元気');
  await contains('静かな', '静か');

  // --- comprehension ------------------------------------------------------
  // The percentage counts every word said, not every distinct word: a page
  // that says one unknown word forty times is not as hard as one with forty
  // different unknown words in it, and the score has to be able to tell them
  // apart.
  const twice = await Lookup.extractTokens('食べました。食べました。', db);
  check('a word said twice is counted twice',
    twice.filter((w) => w === '食べる').length === 2, JSON.stringify(twice));
  check('the unique list is the token list with the repeats folded away',
    (await Lookup.extractWords('食べました。食べました。', db)).filter((w) => w === '食べる').length === 1);

  // coverage works on the tokens themselves, since a token carries every
  // reading its characters could be, not only the best one.
  const asTokens = (words) => words.map((word) => ({ word, words: [word] }));

  const cover = Lookup.coverage(asTokens(['本', '本', '車', '人']), new Set(['本']));
  check('coverage counts repeats, not distinct words',
    cover.total === 4 && cover.known === 2, JSON.stringify(cover));
  check('coverage reports how often each word was said, so one more known word moves it',
    cover.counts['本'] === 2 && cover.counts['車'] === 1, JSON.stringify(cover.counts));
  check('knowing nothing scores nothing, and is not an error',
    Lookup.coverage(asTokens(['本']), new Set()).known === 0);
  check('an empty passage has nothing to score',
    Lookup.coverage([], new Set(['本'])).total === 0);
  check('knowing every word scores all of them',
    Lookup.coverage(asTokens(['本', '車']), new Set(['本', '車'])).known === 2);

  // --- ignored words leave the question rather than answering it wrongly ---
  const withIgnored = Lookup.coverage(
    asTokens(['本', 'ネカフェ', '車']), new Set(['本']), new Set(['ネカフェ']));
  check('an ignored word is taken out of the total, not counted either way',
    withIgnored.total === 2 && withIgnored.known === 1, JSON.stringify(withIgnored));
  // Counted, but not scored. The count is what the bar needs in order to give
  // the word back if it ever stops being ignored, and after a page has been
  // read again that is the only record left that there were any of them.
  check('an ignored word still records how often it was said',
    withIgnored.counts['ネカフェ'] === 1, JSON.stringify(withIgnored.counts));
  check('ignoring every word leaves nothing to score, rather than scoring zero',
    Lookup.coverage(asTokens(['本']), new Set(), new Set(['本'])).total === 0);
  check('no ignored list at all is the same as an empty one',
    Lookup.coverage(asTokens(['本', '車']), new Set(['本'])).total === 2);

  // --- any reading of what is written counts ------------------------------
  // 来た is the past tense of 来る and also, on paper, a rare interjection;
  // 読み is the stem of 読む and also a noun. Knowing either reading of what
  // is actually on the page means nothing is missing.
  check('a token counts as known through any of its readings',
    Lookup.isKnown({ word: '来た', words: ['来た', '来る'] }, new Set(['来る'])));
  check('a token with none of its readings known stays unknown',
    !Lookup.isKnown({ word: '来た', words: ['来た', '来る'] }, new Set(['行く'])));
  check('the best reading being known is enough on its own',
    Lookup.isKnown({ word: '本', words: ['本'] }, new Set(['本'])));

  // --- where each word was, for colouring it -------------------------------
  // The positions have to land on exactly the characters the word covers, or
  // the mark on the page sits beside the word instead of on it.
  const located = await Lookup.locateTokens('本を読む', db);
  check('every located word points at the characters it was read from',
    located.every((t) => {
      const surface = '本を読む'.slice(t.start, t.start + t.length);
      return surface.length === t.length && surface.length > 0;
    }), JSON.stringify(located));
  check('the words come back in the order they were written',
    located.map((t) => t.start).join() === [...located].sort((a, b) => a.start - b.start)
      .map((t) => t.start).join(), JSON.stringify(located.map((t) => t.start)));
  check('a word is located at the position it actually occupies',
    located.some((t) => t.word === '読む' && '本を読む'.slice(t.start, t.start + t.length) === '読む'),
    JSON.stringify(located));

  // Positions are into the text as handed over, so leading text has to shift
  // them, this is what lets a page offset be mapped back to a text node.
  const offset = await Lookup.locateTokens('Hello 本', db);
  check('positions count from the start of the whole passage, not the Japanese',
    offset.length === 1 && offset[0].start === 6, JSON.stringify(offset));

  check('locating and listing agree on what is there',
    (await Lookup.locateTokens(passage, db)).map((t) => t.word).join() ===
    (await Lookup.extractTokens(passage, db)).join());

  // The count a word carries is exactly how far the bar moves when it is
  // marked known, which is what lets the popup's ✓ answer immediately instead
  // of reading the whole page again.
  const passageTokens = await Lookup.locateTokens(passage, db);
  const before = Lookup.coverage(passageTokens, new Set());
  const after = Lookup.coverage(passageTokens, new Set(['本']));
  check('marking one word known moves the score by exactly that word’s count',
    after.known - before.known === before.counts['本'],
    `${after.known - before.known} vs ${before.counts['本']}`);

  // --- the bar counting again for itself ---------------------------------
  // A count on its own is not enough once a word can be understood under
  // another name. "ha" is filed under "ha", but a reader who knows "avere"
  // was already credited with every one of those occurrences, and the bar
  // adding the count a second time is what walked the score up to its own
  // total and sat there at 100%.
  const aliased = [
    { word: 'ha', words: ['ha', 'avere'] },
    { word: 'ha', words: ['ha', 'avere'] },
    { word: 'cane', words: ['cane'] }
  ];
  const knowsAvere = new Set(['avere']);
  const packed = Common.model(aliased, knowsAvere, new Set());
  check('the packed reading is the words once each, and the occurrences by number',
    packed.words.join() === 'ha,avere,cane' &&
    JSON.stringify(packed.tokens) === '[[0,1],[0,1],[2]]' &&
    JSON.stringify(packed.known) === '[1]',
    JSON.stringify(packed));

  const unpacked = Common.expand(packed);
  check('unpacked, it scores exactly as the reading it came from',
    JSON.stringify(Common.coverage(unpacked.tokens, unpacked.known, unpacked.ignored)) ===
    JSON.stringify(Common.coverage(aliased, knowsAvere, new Set())));

  const started = Common.coverage(aliased, knowsAvere, new Set());
  unpacked.known.add('ha');
  const ticked = Common.coverage(unpacked.tokens, unpacked.known, unpacked.ignored);
  check('ticking a word already understood under another name moves nothing',
    started.counts['ha'] === 2 && started.known === 2 && ticked.known === 2,
    `counted ${started.counts['ha']}, ${started.known} -> ${ticked.known}`);

  unpacked.known.add('cane');
  const both = Common.coverage(unpacked.tokens, unpacked.known, unpacked.ignored);
  check('and a word that really was new does move it', both.known === 3 && both.total === 3,
    JSON.stringify(both));

  unpacked.ignored.add('cane');
  const setAside = Common.coverage(unpacked.tokens, unpacked.known, unpacked.ignored);
  check('setting one aside takes it out of the question rather than out of the score',
    setAside.total === 2 && setAside.known === 2, JSON.stringify(setAside));

  // --- pitch accent -----------------------------------------------------
  // Small kana join the mora before them; ー, っ and ん stand alone.
  check('きょ is one mora, っ and ん are their own',
    Pitch.moras('べんきょう').join('|') === 'べ|ん|きょ|う' &&
    Pitch.moras('がっこう').join('|') === 'が|っ|こ|う',
    Pitch.moras('べんきょう').join('|'));

  // The pattern follows entirely from where the pitch drops. The extra value on
  // the end is the particle that would follow the word.
  check('flat words stay up, and stay up past the end',
    JSON.stringify(Pitch.heights(4, 0)) === '[false,true,true,true,true]');
  check('a drop after the first mora takes everything down with it',
    JSON.stringify(Pitch.heights(3, 1)) === '[true,false,false,false]');
  check('a drop in the middle comes back down before the end',
    JSON.stringify(Pitch.heights(3, 2)) === '[false,true,false,false]');

  // 箸 and 橋 are both はし and differ only in pitch, the case that proves a
  // reading alone cannot decide the accent.
  check('箸 is 1 and 橋 is 2, told apart by their kanji',
    (await Pitch.accentFor('箸', 'はし')) === 1 && (await Pitch.accentFor('橋', 'はし')) === 2,
    (await Pitch.accentFor('箸', 'はし')) + '/' + (await Pitch.accentFor('橋', 'はし')));
  check('an ambiguous bare reading is refused rather than guessed',
    (await Pitch.accentFor('はし', '')) === null);

  for (const [word, reading, accent] of
    [['食べる', 'たべる', 2], ['日本語', 'にほんご', 0], ['先生', 'せんせい', 3], ['綺麗', 'きれい', 1]]) {
    check(`${word} drops at ${accent}`, (await Pitch.accentFor(word, reading)) === accent,
      'got ' + (await Pitch.accentFor(word, reading)));
  }

  const P0 = Pitch;
  const graph = await Pitch.graphFor('食べる', 'たべる');
  check('the graph is an svg with a dot per mora plus the particle',
    graph.startsWith('<svg') && (graph.match(/<circle/g) || []).length === 4,
    (graph.match(/<circle/g) || []).length + ' circles');
  check('the graph follows the card colour rather than fixing its own',
    graph.includes('currentColor') && !/#[0-9a-f]{3,6}/i.test(graph));
  // The line has to stop at the edge of the final dot, not its centre: that dot
  // is hollow, and a line reaching the middle shows through the ring.
  const flat = P0.svg('にほんご', 0);
  const lastPoint = flat.match(/points="([^"]+)"/)[1].split(' ').pop();
  const lastCircle = [...flat.matchAll(/<circle cx="([\d.]+)"/g)].pop()[1];
  check('the line stops short of the hollow dot',
    Math.abs(Number(lastPoint.split(',')[0]) - Number(lastCircle)) > 4,
    'line ends at ' + lastPoint + ', dot at ' + lastCircle);

  check('an unknown word gets no graph at all, not an empty one',
    (await Pitch.graphFor('ぬわあああ', 'ぬわあああ')) === '');
  check('Pitch is guessed from the field name',
    Anki.guessMapping(['Pitch'])['Pitch'] === 'pitch');

  // --- subtitles ---------------------------------------------------------
  // YouTube's json3: events with a start, a length and the text in pieces.
  const parsed = Subs.parse({ events: [
    { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: '日本語を' }, { utf8: '勉強しています。' }] },
    { tStartMs: 3000, dDurationMs: 2500, segs: [{ utf8: '図書館で' }, { utf8: '本を読んでいました。' }] },
    { tStartMs: 9000, dDurationMs: 1000, segs: [{ utf8: '  ' }] },              // blank
    { tStartMs: 12000, dDurationMs: 2000, segs: [{ utf8: '食べなかった' }] },
    { tStartMs: 20000 }                                                         // no text at all
  ] });
  check('subtitle pieces are joined into whole lines',
    parsed.length === 3 && parsed[0].text === '日本語を勉強しています。',
    JSON.stringify(parsed.map((c) => c.text)));
  check('blank and empty events are dropped',
    !parsed.some((c) => !c.text.trim()), JSON.stringify(parsed.map((c) => c.text)));
  check('times are seconds, not milliseconds',
    parsed[0].start === 1 && parsed[0].end === 3, JSON.stringify(parsed[0]));

  // Overlapping events would make a recording run into the following line.
  const overlapping = Subs.parse({ events: [
    { tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'まず' }] },
    { tStartMs: 3000, dDurationMs: 2000, segs: [{ utf8: 'つぎ' }] }
  ] });
  check('a line ends where the next begins',
    overlapping[0].end === 3, JSON.stringify(overlapping));

  // Automatic captions roll: the line is sent again and again, a word longer
  // each time. Taken at face value that is four half-lines that each repeat
  // the last, which is what made auto-subtitled videos look so strange.
  const rolling = Subs.parse({ events: [
    { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: 'きょうは' }] },
    { tStartMs: 1500, dDurationMs: 500, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 1500, dDurationMs: 600, segs: [{ utf8: 'きょうは とても' }] },
    { tStartMs: 2100, dDurationMs: 900, segs: [{ utf8: 'きょうは とても あついです' }] },
    { tStartMs: 4000, dDurationMs: 1000, segs: [{ utf8: 'そうですね' }] }
  ] });
  check('a rolling caption grows into one line rather than four',
    rolling.length === 2, JSON.stringify(rolling.map((c) => c.text)));
  check('and the line kept is the whole of it, not the first word',
    rolling[0].text === 'きょうはとてもあついです', JSON.stringify(rolling[0]));
  check('the rolled line runs from the first word to the end of the last',
    rolling[0].start === 1 && rolling[0].end === 3, JSON.stringify(rolling[0]));
  check('a line that is not a continuation still starts a new one',
    rolling[1].text === 'そうですね', JSON.stringify(rolling[1]));

  // A caption that wraps arrives with a space where it broke, and a space is
  // not a word boundary in Japanese: it is where the renderer ran out of room.
  // Left in, it cut 繋がるわけじゃないのかも into 繋がる, 別, じゃ and ない.
  const wrapped = Subs.parse({ events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: '私の場合は繋がるわけじゃ\nないのかも' }] }
  ] });
  check('a line the player wrapped is read as one line',
    wrapped[0].text === '私の場合は繋がるわけじゃないのかも', JSON.stringify(wrapped[0].text));

  const latin = Subs.parse({ events: [
    { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'hello   world' }] }
  ] });
  check('a space between words that need one is left alone',
    latin[0].text === 'hello world', JSON.stringify(latin[0].text));

  // Lines that run straight into each other are joined with nothing between
  // them, because that is where an automatic caption cuts a word in half.
  // A finished sentence, or a gap in the timing, keeps its break: joining
  // those would invent words across them.
  Subs._setCues([
    { start: 0, end: 2, text: '昨日は友達と映画を見に行っ' },
    { start: 2, end: 4, text: 'たので楽しかった' },
    { start: 9, end: 11, text: '今日は雨です。' },
    { start: 11, end: 13, text: '明日は晴れます' }
  ]);
  // The whole video is one continuous text, the way a book is. Where a line
  // ends is where the renderer ran out of room or the speaker drew breath,
  // and neither has anything to do with where a word ends, so no break is put
  // in at all. Sentences still stop the reading on their own, because 。 is
  // not a Japanese character and ends a run wherever it appears.
  check('a word split across two lines is joined back up for reading',
    Subs.allText().indexOf('見に行ったので') !== -1, JSON.stringify(Subs.allText()));
  check('no breaks are put between the lines at all',
    Subs.allText().indexOf('\n') === -1, JSON.stringify(Subs.allText()));

  // A language that spaces its words is the other way round. Run straight
  // on, "al tempo" ending one line and "Poi" starting the next came out as
  // "tempoPoi", which is not a word, so every line break in a transcript
  // quietly cost the score a word.
  globalThis.TorvalLang = Lang;
  Lang._setActive('it');
  Subs._setCues([
    { start: 0, end: 2, text: 'per sfuggire al tempo' },
    { start: 2, end: 4, text: 'Poi dagli studi' }
  ]);
  check('lines of a spaced language are joined with the space they need',
    Subs.allText() === 'per sfuggire al tempo Poi dagli studi',
    JSON.stringify(Subs.allText()));
  Lang._setActive('ja');
  Subs._setCues([
    { start: 0, end: 2, text: '昨日は友達と映画を見に行っ' },
    { start: 2, end: 4, text: 'たので楽しかった' }
  ]);
  check('and Japanese, which spaces nothing, still runs straight on',
    Subs.allText() === '昨日は友達と映画を見に行ったので楽しかった',
    JSON.stringify(Subs.allText()));
  delete globalThis.TorvalLang;

  Subs._setCues([
    { start: 0, end: 2, text: '昨日は友達と映画を見に行っ' },
    { start: 2, end: 4, text: 'たので楽しかった' },
    { start: 9, end: 11, text: '今日は雨です。' },
    { start: 11, end: 13, text: '明日は晴れます' }
  ]);
  check('a line is told what came before it',
    Subs.around('たので楽しかった').before === '昨日は友達と映画を見に行っ',
    JSON.stringify(Subs.around('たので楽しかった')));
  check('and what comes after it',
    Subs.around('今日は雨です。').after === '明日は晴れます',
    JSON.stringify(Subs.around('今日は雨です。')));
  // Reading captions off the screen, which is what happens whenever the
  // transcript cannot be fetched, files a line only once it has ended. The
  // line being read is the open one and the line after it has not been said,
  // so looking only through the finished lines found nothing at all and left
  // every line without the context this was built to give it.
  Subs._setCues([{ start: 0, end: 2, text: '私の場合は繋がるわけじゃ' }]);
  Subs._setOpen({ start: 2, text: 'ないのかもっていうことなんですよね。皆' });
  check('the line on screen is told what came before it, even before it ends',
    Subs.around('ないのかもっていうことなんですよね。皆').before === '私の場合は繋がるわけじゃ',
    JSON.stringify(Subs.around('ないのかもっていうことなんですよね。皆')));

  Subs._setCues([
    { start: 0, end: 2, text: '私の場合は繋がるわけじゃ' },
    { start: 2, end: 4, text: 'ないのかもっていうことなんですよね。皆' }
  ]);
  Subs._setOpen({ start: 4, text: 'さんがこう日常とか仕事の中で何を軸に' });
  check('and so is the one after that, when it arrives',
    Subs.around('さんがこう日常とか仕事の中で何を軸に').before ===
      'ないのかもっていうことなんですよね。皆',
    JSON.stringify(Subs.around('さんがこう日常とか仕事の中で何を軸に')));

  Subs._setOpen(null);
  // A video site is recognised by its address, and nothing else on the web
  // is: an extension that started drawing subtitles over some unrelated
  // page would be worse than one that missed a site.
  // Reading a long page is seconds of work, and seconds of "Reading this
  // page…" with nothing moving looks exactly like nothing happening. So the
  // segmenter says how far through the text it has got, every time it stops
  // to ask the dictionary something.
  {
    // Varied text, not one sentence over and over: the reading stops to ask
    // the dictionary once it has enough new questions, and the same sentence
    // repeated has nothing new to ask after the first time.
    const glue = ['\u306f', '\u3092', '\u306b', '\u304c', '\u3067', '\u3057\u305f', '\u3067\u3059\u3002'];
    const headwords = [...index.keys()].filter((t) => t.length >= 2 && t.length <= 4);
    let long = '';
    for (let i = 0; long.length < 20000; i++) {
      long += headwords[(i * 7919) % headwords.length] + glue[i % glue.length];
    }
    const steps = [];
    await Lookup.locateTokens(long, db, (done, total) => steps.push([done, total]));
    check('reading a page says how far through it is', steps.length > 1, steps.length);
    check('it never says it is further than the end',
      steps.every(([done, total]) => done >= 0 && done <= total && total === long.length),
      JSON.stringify(steps.slice(0, 3)));
    check('and it only ever moves forwards',
      steps.every(([done], i) => i === 0 || done >= steps[i - 1][0]),
      JSON.stringify(steps.map((s) => s[0])));
  }

  // --- dropping shapes the dictionary cannot have ---------------------------
  // Thirty-odd shapes are proposed per character and one or two are words.
  // A database that can say up front what it has never heard of lets the rest
  // be dropped before they are held in a map, asked about, and looked for
  // again in the answer. It has to change nothing at all about the reading,
  // so the same passage is read both ways and the two must agree exactly.
  {
    const knowing = {
      mightKnow: (term) => index.has(term),
      getEntries: db.getEntries
    };
    const glue = ['\u306f', '\u3092', '\u306b', '\u304c', '\u3067', '\u3057\u305f', '\u3067\u3059\u3002'];
    const headwords = [...index.keys()].filter((t) => t.length >= 2 && t.length <= 4);
    let passage = '';
    for (let i = 0; i < 400; i++) {
      passage += headwords[(i * 7919) % headwords.length] + glue[i % glue.length];
    }

    const plain = await Lookup.locateTokens(passage, db);
    const filtered = await Lookup.locateTokens(passage, knowing);
    const shape = (list) => list.map((t) => t.word + t.start + t.length).join('|');
    check('a reading that drops impossible shapes reads exactly the same',
      shape(plain) === shape(filtered),
      plain.length + ' words against ' + filtered.length);

    // And a hover, which goes through the same generation by a different door.
    const line = '\u4eca\u65e5\u306f\u6691\u3044\u3067\u3059\u306d\u3002';
    for (const spot of [0, 2, 3, 6]) {
      const one = await Lookup.hover(line, spot, db);
      const two = await Lookup.hover(line, spot, knowing);
      check('and so does a hover at character ' + spot,
        JSON.stringify(one.groups.map((g) => g.surface + g.hits[0].word)) ===
        JSON.stringify(two.groups.map((g) => g.surface + g.hits[0].word)),
        JSON.stringify(two.groups.map((g) => g.surface)));
    }
  }

  check('YouTube is a video site', Subs.siteFor('www.youtube.com') === 'youtube');
  check('so is Netflix', Subs.siteFor('www.netflix.com') === 'netflix');
  check('and so is Netflix in another country', Subs.siteFor('netflix.com') === 'netflix');
  check('a site that merely mentions one is not', Subs.siteFor('notnetflix.com') === null);

  // --- Netflix's own subtitle file -----------------------------------------
  // WebVTT as Netflix writes it: a stamp, the words, a blank line. The
  // furigana it puts in as ruby has to come out, or every kanji would be
  // followed by its own reading spelled out as more words to read.
  {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:03.500 line:10%',
      '\u79c1\u306e\u5834\u5408\u306f\u7e4b\u304c\u308b\u308f\u3051\u3058\u3083',
      '',
      '00:00:03.500 --> 00:00:06.000',
      '<i>\u306a\u3044\u306e\u304b\u3082\u3063\u3066</i>\u3044\u3046\u3053\u3068',
      '',
      '01:00:00.250 --> 01:00:02.000',
      '<ruby>\u7686<rt>\u307f\u306a</rt></ruby>\u3055\u3093'
    ].join(String.fromCharCode(10));
    const cues = Subs.parseVtt(vtt);
    check('every line of the file is read', cues.length === 3, cues.length);
    check('with the words, and no markup',
      cues[1].text === '\u306a\u3044\u306e\u304b\u3082\u3063\u3066\u3044\u3046\u3053\u3068', cues[1].text);
    check('the furigana comes out and the kanji stays',
      cues[2].text === '\u7686\u3055\u3093', cues[2].text);
    check('a stamp is read as a time', cues[0].start === 1 && cues[0].end === 3.5,
      cues[0].start + JSON.stringify(cues[0]));
    check('and an hour counts as an hour', cues[2].start === 3600.25, cues[2].start);
    check('a file with nothing in it is no lines rather than a crash',
      Subs.parseVtt('WEBVTT').length === 0);
  }

  // --- Netflix's own subtitle file, as it really arrives ---------------------
  // WebVTT is what Netflix sends when the manifest has been talked into
  // offering it. Left alone it sends TTML, and that is the file that goes past
  // on the way to the player whether or not anything was injected, so it is
  // the one that has to be read.
  //
  // parseTtml uses DOMParser, which the browser has and Node does not. What
  // stands in for it here is the smallest XML reader that answers the handful
  // of questions parseTtml asks: elements, their attributes by local name,
  // their children in order, and their text. It is a stand-in for the
  // browser's parser, not a test of one.
  {
    globalThis.DOMParser = class {
      parseFromString(text) {
        const decode = (raw) => String(raw)
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
        const node = (name, attrs) => ({
          nodeType: 1, localName: name.split(':').pop(), nodeName: name,
          attributes: attrs, childNodes: [], firstChild: null, nextSibling: null,
          getAttribute(wanted) {
            const found = this.attributes.find((a) => a.name === wanted);
            return found ? found.value : null;
          }
        });
        const finish = (el) => {
          el.childNodes.forEach((child, i) => {
            child.nextSibling = el.childNodes[i + 1] || null;
            if (child.nodeType === 1) finish(child);
          });
          el.firstChild = el.childNodes[0] || null;
        };
        const source = String(text).replace(/<[?!][^>]*>/g, '');
        const stack = [node('#document', [])];
        const tag = /<(\/?)([\w:.-]+)((?:\s[^<>]*?)?)(\/?)>/g;
        let at = 0;
        let match;
        while ((match = tag.exec(source))) {
          const between = source.slice(at, match.index);
          if (between.trim() || /[^\s]/.test(between)) {
            stack[stack.length - 1].childNodes.push(
              { nodeType: 3, nodeValue: decode(between) });
          }
          at = tag.lastIndex;
          const [, closing, name, rawAttrs, empty] = match;
          if (closing) { stack.pop(); continue; }
          const attrs = [];
          const attr = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
          let one;
          while ((one = attr.exec(rawAttrs || ''))) {
            attrs.push({ name: one[1], value: decode(one[2]),
              localName: one[1].split(':').pop() });
          }
          const made = node(name, attrs);
          stack[stack.length - 1].childNodes.push(made);
          if (!empty) stack.push(made);
        }
        const doc = stack[0];
        finish(doc);
        const every = [];
        const walk = (el) => el.childNodes.forEach((child) => {
          if (child.nodeType !== 1) return;
          every.push(child);
          walk(child);
        });
        walk(doc);
        doc.documentElement = doc.childNodes.find((c) => c.nodeType === 1) || null;
        doc.getElementsByTagNameNS = (ns, name) =>
          every.filter((el) => el.localName === name);
        doc.getElementsByTagName = (name) =>
          every.filter((el) => el.localName === name);
        return doc;
      }
    };

    // Netflix writes its times as ticks against a rate declared on the root,
    // which is the one shape a reader written for WebVTT would get wrong
    // without noticing: "108108000t" parses as a perfectly good number.
    const ttml = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<tt xmlns="http://www.w3.org/ns/ttml" ttp:tickRate="10000000"',
      '    ttp:frameRate="24" xml:lang="it">',
      '<body><div>',
      '<p begin="10000000t" end="35000000t">Mi chiamo Giuseppe<br/>e ho una missione</p>',
      '<p begin="00:00:04.000" end="00:00:06.500">Perch\u00e9 nel posto</p>',
      '<p begin="00:00:08.000" dur="00:00:02.000">in cui nessuno &amp; nulla</p>',
      '<p begin="120000000t" end="130000000t">',
      '<span ruby="container"><span ruby="base">\u7686</span>',
      '<span ruby="text">\u307f\u306a</span></span>\u3055\u3093</p>',
      '</div></body></tt>'
    ].join('\n');
    const cues = Subs.parseTtml(ttml);
    check('every paragraph of a TTML file is read', cues.length === 4, cues.length);
    check('ticks are read against the rate the file declares',
      cues[0].start === 1 && cues[0].end === 3.5, JSON.stringify(cues[0]));
    check('a line broken in two is still one line',
      cues[0].text === 'Mi chiamo Giuseppe e ho una missione', cues[0].text);
    check('a clock time is read as a clock time',
      cues[1].start === 4 && cues[1].end === 6.5, JSON.stringify(cues[1]));
    check('a length is as good as an end', cues[2].end === 10, cues[2].end);
    check('and what the file says is what is read',
      cues[2].text === 'in cui nessuno & nulla', cues[2].text);
    check('ruby is a reading, not more of the sentence',
      cues[3].text === '\u7686\u3055\u3093', cues[3].text);
    check('a file that is not a file at all is no lines rather than a crash',
      Subs.parseTtml('not xml at all').length === 0);
  }

  // --- asking Netflix for a format that can be read -------------------------
  // netflix-page.js runs as page code, so its whole world is the page: two
  // hooks on JSON and a fetch. A sandbox with a JSON of its own is therefore
  // the entire test rig it needs, and what runs here is what runs there.
  {
    let posted = null;
    let asked = null;
    const heard = [];
    const listeners = [];
    const bodies = {};
    const sandbox = {
      console: { log() {}, warn() {}, error() {} },
      // A file comes back for whatever is asked for: the WebVTT a chosen
      // track answers with, unless this test has put something else at that
      // address. `clone`, because a response read on its way past has to be
      // read from a copy, or the player would be handed an empty body.
      fetch: async (url) => {
        asked = url;
        const body = Object.prototype.hasOwnProperty.call(bodies, url) ? bodies[url] : 'WEBVTT';
        return { ok: true, url, text: async () => body, clone() { return this; } };
      },
      // The page and the content script talk by posting messages to the one
      // window they share, so both halves of that are needed here: what the
      // page says, and what it is told back.
      window: {
        postMessage(message) { posted = message; heard.push(message); },
        addEventListener(kind, fn) { if (kind === 'message') listeners.push(fn); }
      },
      // A reply becomes an object by one of three routes, and only one of
      // them is JSON.parse. These are the other two.
      Response: function Response() {},
      location: { href: 'https://www.netflix.com/watch/81234567',
        pathname: '/watch/81234567' },
      navigator: {},
      // Both of these are a browser's, and the page script uses them to tell
      // a subtitle file from the rest of what the player downloads.
      URL,
      TextDecoder,
      XMLHttpRequest: function XMLHttpRequest() {},
      // The page script sets a timer to say so if nothing ever comes back,
      // and another to watch for the next episode starting. Let go of both,
      // or the tests would sit and wait them out before the process could end.
      setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
      clearTimeout,
      setInterval: (fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); return t; },
      clearInterval
    };
    sandbox.globalThis = sandbox;
    let jsonCalls = 0;
    sandbox.Response.prototype.json = function () {
      jsonCalls++;
      return Promise.resolve(JSON.parse(this.body));
    };
    for (const name of ['open', 'send']) sandbox.XMLHttpRequest.prototype[name] = function () {};
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(join(ROOT, 'extension', 'netflix-page.js'), 'utf8'),
      sandbox, { filename: 'netflix-page.js' });

    const stringify = (value) => vm.runInContext('JSON.stringify(value)',
      Object.assign(sandbox, { value }));

    /** The content script answering, which is a message from the same window. */
    const fromContentScript = (message) =>
      listeners.forEach((fn) => fn({ source: sandbox.window, data: message }));

    const request = { url: '/nq/msl_v1/cadmium/pbo_manifests',
      manifest: { profiles: ['playready-h264'] } };
    check('the request for a title asks for a subtitle format Torval can read',
      JSON.parse(stringify(request)).manifest.profiles[0] === 'webvtt-lssdh-ios8',
      stringify(request));
    check('and asking twice does not ask for it twice',
      (stringify(request), JSON.parse(stringify(request)).manifest.profiles.length) === 2,
      stringify(request));
    check('every other request is left exactly as it was',
      stringify({ url: '/nq/msl_v1/cadmium/pbo_licenses',
        profiles: ['playready-h264'] }).indexOf('webvtt') === -1);

    // The answer to that request, cut down to the parts this reads. Two
    // Japanese tracks, because a title very often has both, and the one that
    // writes out sounds and speaker names is not the one to read.
    const answer = JSON.stringify({ result: {
      movieId: 81234567,
      timedtexttracks: [
        { language: 'en',
          ttDownloadables: { 'webvtt-lssdh-ios8': { urls: [{ url: 'https://x/en.vtt' }] } } },
        { language: 'ja', rawTrackType: 'closedcaptions',
          ttDownloadables: { 'webvtt-lssdh-ios8': { urls: [{ url: 'https://x/ja-cc.vtt' }] } } },
        { language: 'ja', rawTrackType: 'subtitles',
          ttDownloadables: { 'webvtt-lssdh-ios8': { urls: [{ url: 'https://x/ja.vtt' }] } } },
        { language: 'ja', isForcedNarrative: true,
          ttDownloadables: { 'webvtt-lssdh-ios8': { urls: [{ url: 'https://x/ja-forced.vtt' }] } } }
      ]
    } });
    // Handed back as the very same object, not a copy of one. Netflix parses
    // JSON for everything it does, and an answer that is merely equal to what
    // it asked for is how the site came up blank once already.
    const before = vm.runInContext('JSON.parse(answer)',
      Object.assign(sandbox, { answer }));
    check('the answer is handed back untouched, whatever was read out of it',
      before.result.movieId === 81234567 && before.result.timedtexttracks.length === 4);
    check('and handed back as one of the page’s own objects',
      vm.runInContext('JSON.parse(answer) instanceof Object', sandbox) === true);
    await new Promise((r) => setTimeout(r, 10));
    // Which language to read is the extension's question and not this file's:
    // page code knows nothing about Torval's settings, so it offers what the
    // title has and is told which of them to fetch.
    check('every track that can be read is offered, the forced one is not',
      posted && posted.torval === 'torval-netflix-tracks' && posted.tracks.length === 3,
      JSON.stringify(posted));
    check('and each is offered with the language it is in',
      posted.tracks.map((t) => t.language).join(',') === 'en,ja,ja', JSON.stringify(posted));
    check('a closed-caption track says that it is one',
      posted.tracks[1].captions === true && posted.tracks[2].captions === false,
      JSON.stringify(posted.tracks));
    check('nothing is fetched until it is asked for', asked === null, asked);

    fromContentScript({ torval: 'torval-netflix-fetch', url: 'https://x/ja.vtt' });
    await new Promise((r) => setTimeout(r, 10));
    check('the track asked for is the track fetched', asked === 'https://x/ja.vtt', asked);
    check('the file reaches the rest of Torval, with the episode it belongs to',
      posted && posted.torval === 'torval-netflix-subtitles' && posted.movie === '81234567' &&
      posted.text === 'WEBVTT' && posted.format === 'vtt', JSON.stringify(posted));

    // A page has many scripts on it and any of them can post to its window.
    // Only the addresses that came out of Netflix's own track list are ever
    // fetched, or this would be handing out a fetch to whoever asks.
    asked = null;
    fromContentScript({ torval: 'torval-netflix-fetch', url: 'https://somewhere.else/private' });
    await new Promise((r) => setTimeout(r, 10));
    check('an address Torval never offered is not fetched for whoever asked',
      asked === null, asked);

    // The same answer, arriving the way fetch delivers one. response.json()
    // never calls JSON.parse, the browser parses the body itself, so a site
    // that reads its replies this way goes straight past the hook above.
    //
    // The address is deliberately nothing to do with "manifest". Filtering
    // replies by their address is what hid this on the real site: the word
    // manifest is Netflix's own name for the request, inside the payload,
    // and says nothing about where the request is sent.
    posted = null;
    asked = null;
    const reply = new sandbox.Response();
    reply.url = 'https://www.netflix.com/nq/nogo/msl_v1/cadmium/pbo';
    // A different episode, or the same track would be recognised as one
    // already fetched and quite rightly left alone.
    reply.body = answer.split('/ja.vtt').join('/ja2.vtt');
    const handed = reply.json();
    check('a reply read with response.json() is still the caller’s own promise',
      handed instanceof Promise && jsonCalls === 1, jsonCalls);
    const value = await handed;
    check('and it hands back the answer itself, unchanged',
      value.result.movieId === 81234567 && value.result.timedtexttracks.length === 4);
    await new Promise((r) => setTimeout(r, 10));
    check('the subtitles are found in it all the same',
      posted && posted.torval === 'torval-netflix-tracks' &&
      posted.tracks.some((t) => t.url === 'https://x/ja2.vtt'), JSON.stringify(posted));

    // What a reply is judged on is what is in it, and only that. Every other
    // reply on the site passes through the same hook and is dropped after one
    // property lookup.
    posted = null;
    asked = null;
    const other = new sandbox.Response();
    other.url = 'https://www.netflix.com/api/shakti/whatever';
    other.body = JSON.stringify({ result: { movieId: 5, episodes: ['a', 'b'] } });
    await other.json();
    await new Promise((r) => setTimeout(r, 10));
    check('a reply with no track list in it is left alone', posted === null, posted);

    // --- and the way that needs no manifest at all -------------------------
    // The subtitle file itself is fetched in the clear, from Netflix's own
    // delivery network, whatever the manifest was or was not talked into
    // offering. Whatever the viewer has turned on comes past this window.
    posted = null;
    const ttmlFile = '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" ' +
      'ttp:tickRate="10000000"><body><div><p begin="10000000t" end="20000000t">' +
      'Mi chiamo Giuseppe</p></div></body></tt>';
    bodies['https://oca.nflxvideo.net/?o=1&v=2'] = ttmlFile;
    bodies['https://oca.nflxvideo.net/?o=1&v=3'] = ttmlFile;
    bodies['https://oca.nflxvideo.net/range/0-100'] = 'not subtitles at all';
    await vm.runInContext('fetch("https://oca.nflxvideo.net/?o=1&v=2")', sandbox);
    await new Promise((r) => setTimeout(r, 10));
    check('the subtitle file is caught on its way to the player',
      posted && posted.torval === 'torval-netflix-subtitles' && posted.format === 'ttml' &&
      posted.text === ttmlFile, JSON.stringify(posted && posted.format));

    posted = null;
    await vm.runInContext('fetch("https://oca.nflxvideo.net/?o=1&v=3")', sandbox);
    await new Promise((r) => setTimeout(r, 10));
    check('and the same file arriving twice is caught once', posted === null, posted);

    posted = null;
    await vm.runInContext('fetch("https://oca.nflxvideo.net/range/0-100")', sandbox);
    await new Promise((r) => setTimeout(r, 10));
    check('what is not a subtitle file is not taken for one', posted === null, posted);
  }
  // --- turning the track on, so there is a file to catch ---------------------
  // The file is only fetched when the player is about to show something. The
  // player will do that when asked, so Torval asks, takes the file that causes,
  // and puts the viewer's own choice back.
  {
    let posted = null;
    const listeners = [];
    const bodies = {};
    const timers = [];
    const none = { isNoneTrack: true, bcp47: '' };
    const chosen = [];
    const tracks = [
      { bcp47: 'ja', trackType: 'PRIMARY' },
      { bcp47: 'it', trackType: 'ASSISTIVE', rawTrackType: 'closedcaptions' },
      { bcp47: 'it', trackType: 'PRIMARY' },
      { bcp47: 'it', isForcedNarrative: true },
      none
    ];
    const player = {
      getTimedTextTrackList: () => tracks,
      getTimedTextTrack: () => none,
      setTimedTextTrack: (track) => chosen.push(track)
    };
    const sandbox = {
      console: { log() {}, warn() {}, error() {} },
      fetch: async (url) => {
        const body = Object.prototype.hasOwnProperty.call(bodies, url) ? bodies[url] : '';
        return { ok: true, url, text: async () => body, clone() { return this; } };
      },
      window: {
        postMessage(message) { posted = message; },
        addEventListener(kind, fn) { if (kind === 'message') listeners.push(fn); },
        netflix: { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
          getAllPlayerSessionIds: () => ['preview-1', 'watch-9'],
          getVideoPlayerBySessionId: (id) => (id === 'watch-9' ? player : null)
        } }) } } } },
        location: { href: 'https://www.netflix.com/watch/70123456',
          pathname: '/watch/70123456' }
      },
      location: { href: 'https://www.netflix.com/watch/70123456',
        pathname: '/watch/70123456' },
      navigator: {},
      URL,
      TextDecoder,
      Response: function Response() {},
      XMLHttpRequest: function XMLHttpRequest() {},
      setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
      clearTimeout,
      setInterval: (fn, ms) => {
        const t = setInterval(fn, ms);
        if (t.unref) t.unref();
        timers.push(t);
        return t;
      },
      clearInterval
    };
    sandbox.netflix = sandbox.window.netflix;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(join(ROOT, 'extension', 'netflix-page.js'), 'utf8'),
      sandbox, { filename: 'netflix-page.js' });
    const arrives = (message) =>
      listeners.forEach((fn) => fn({ source: sandbox.window, data: message }));

    check('nothing is touched before the extension says what it reads',
      chosen.length === 0, chosen.length);

    arrives({ torval: 'torval-netflix-want', languages: ['it', 'it-IT'] });
    check('the track for the language being read is turned on',
      chosen.length === 1 && chosen[0] === tracks[2], chosen.length);
    check('and speech is preferred to the track that writes out sounds',
      chosen[0].rawTrackType === undefined, JSON.stringify(chosen[0]));

    // The file the player fetches because of that, caught on its way past.
    const ttml = '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" ' +
      'ttp:tickRate="10000000"><body><div><p begin="10000000t" end="20000000t">' +
      'Mi chiamo Giuseppe</p></div></body></tt>';
    bodies['https://oca.nflxvideo.net/?o=9'] = ttml;
    await vm.runInContext('fetch("https://oca.nflxvideo.net/?o=9")', sandbox);
    await new Promise((r) => setTimeout(r, 900));
    check('the file is caught, and the player put back as the viewer had it',
      chosen.length === 2 && chosen[1] === none, JSON.stringify(chosen.length));
    check('and it is the file that reaches the rest of Torval',
      posted && posted.torval === 'torval-netflix-subtitles' && posted.format === 'ttml',
      JSON.stringify(posted && posted.torval));

    timers.forEach(clearInterval);
  }

  // --- choosing which of Netflix's tracks to read ---------------------------
  // The page script offers every track the title has, because page code knows
  // nothing about Torval's settings. netflix.js is the half that does know, and
  // the whole of its job here is to name one of them.
  {
    let posted = null;
    const listeners = [];
    const sandbox = {
      console: { log() {}, warn() {}, error() {} },
      window: {
        postMessage(message) { posted = message; },
        addEventListener(kind, fn) { if (kind === 'message') listeners.push(fn); }
      },
      TorvalLang: { profile: () => ({ subtitles: ['it', 'it-IT'], name: 'Italian' }) },
      // It says which language it reads more than once at the start, since
      // the two scripts begin at different moments.
      setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
      clearTimeout
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(join(ROOT, 'extension', 'netflix.js'), 'utf8'),
      sandbox, { filename: 'netflix.js' });
    const arrives = (message) =>
      listeners.forEach((fn) => fn({ source: sandbox.window, data: message }));

    arrives({ torval: 'torval-netflix-tracks', movie: '81234567', tracks: [
      { language: 'ja', captions: false, url: 'https://x/ja.vtt' },
      { language: 'en', captions: false, url: 'https://x/en.vtt' },
      { language: 'it-IT', captions: true, url: 'https://x/it-cc.vtt' },
      { language: 'it', captions: false, url: 'https://x/it.vtt' }
    ] });
    check('the track asked for is the one in the language being read',
      posted && posted.torval === 'torval-netflix-fetch' && posted.url === 'https://x/it.vtt',
      JSON.stringify(posted));

    posted = null;
    arrives({ torval: 'torval-netflix-tracks', tracks: [
      { language: 'it-IT', captions: true, url: 'https://x/it-cc.vtt' }
    ] });
    check('closed captions will do when they are all there is',
      posted && posted.url === 'https://x/it-cc.vtt', JSON.stringify(posted));

    posted = null;
    arrives({ torval: 'torval-netflix-tracks', tracks: [
      { language: 'ja', captions: false, url: 'https://x/ja.vtt' }
    ] });
    check('and a title with nothing to read in it is not asked for anything',
      posted === null, JSON.stringify(posted));

    arrives({ torval: 'torval-netflix-subtitles', movie: '81234567', format: 'ttml',
      text: '<tt/>', vtt: '' });
    const held = vm.runInContext('TorvalNetflix.track()', sandbox);
    check('a file that arrives is held with the format it is in',
      held && held.format === 'ttml' && held.text === '<tt/>' && held.movie === '81234567',
      JSON.stringify(held));
  }

  check('and nor is anywhere else', Subs.siteFor('example.com') === null);

  Subs._setCues(parsed);

  // A roll that never stops must not grow into one cue covering half the
  // video: A would then take you to the start of that rather than back a line.
  const forever = [];
  let saying = '';
  for (let i = 0; i < 40; i++) {
    saying += (i ? ' ' : '') + 'ことば' + i;
    forever.push({ tStartMs: i * 400, dDurationMs: 400, segs: [{ utf8: saying }] });
  }
  const bounded = Subs.parse({ events: forever });
  check('a roll that never stops is still cut into lines',
    bounded.length > 1, bounded.length + ' lines');
  check('and no line is longer than a line',
    bounded.every((c) => c.text.length <= 80), JSON.stringify(bounded.map((c) => c.text.length)));
  check('and none of them runs for half the video',
    bounded.every((c) => c.end - c.start <= 11), JSON.stringify(bounded.map((c) => Math.round(c.end - c.start))));

  // Reading captions off the screen: rewatching a scene must not duplicate a
  // line, or A/D would stutter on two entries that say the same thing.
  let observed = [];
  Subs.insertObserved(observed, { start: 5, end: 7, text: '食べない' });
  Subs.insertObserved(observed, { start: 12, end: 14, text: '食べた' });
  check('lines are collected as they are seen',
    observed.length === 2, JSON.stringify(observed));

  Subs.insertObserved(observed, { start: 5.3, end: 7.3, text: '食べない' });
  check('the same line seen again near the same spot refreshes it rather than duplicating',
    observed.length === 2 && observed[0].start === 5.3, JSON.stringify(observed));

  Subs.insertObserved(observed, { start: 40, end: 42, text: '食べない' });
  check('the same line recurring much later (a different scene) is kept separately',
    observed.length === 3, JSON.stringify(observed));

  observed = [];
  Subs.insertObserved(observed, { start: 10, end: 12, text: 'B' });
  Subs.insertObserved(observed, { start: 3, end: 5, text: 'A' });
  check('lines are kept in time order even when seen out of order (rewinding to rewatch)',
    observed.map((c) => c.text).join('') === 'AB', JSON.stringify(observed));

  Subs._setCues(parsed);
  check('the line playing at a given moment is found',
    Subs.cueAt(1.5).text === '日本語を勉強しています。' && Subs.cueAt(4).text.startsWith('図書館'),
    JSON.stringify([Subs.cueAt(1.5), Subs.cueAt(4)]));
  check('a gap between lines is a gap', Subs.cueAt(7) === null);
  check('scanning backwards works as well as forwards',
    Subs.cueAt(13).text === '食べなかった' && Subs.cueAt(1.5).text.startsWith('日本語'));

  // Mining happens after pausing to read, so the line is found by its text.
  check('a sentence is matched back to its line',
    Subs.cueFor('図書館で本を読んでいました。').start === 3,
    JSON.stringify(Subs.cueFor('図書館で本を読んでいました。')));
  check('a sentence cut short by a block boundary still matches',
    Subs.cueFor('図書館で本を').start === 3);
  check('the bolded sentence from a card still matches',
    Subs.cueFor('<b>食べなかった</b>').start === 12);

  // A steps back a line, D forward. A goes to the line *before* the one
  // playing rather than to the start of it: hearing something and wanting it
  // again is much the commoner reason to reach for the key, and the start of
  // the line you are in is A and then D.
  check('A part-way through a line goes to the line before it',
    Subs.step(5, -1).start === 1, JSON.stringify(Subs.step(5, -1)));
  check('A inside the first line goes to its own start, having nowhere earlier',
    Subs.step(2.2, -1).start === 1, JSON.stringify(Subs.step(2.2, -1)));
  check('A at the start of a line goes to the one before',
    Subs.step(3.0, -1).start === 1, JSON.stringify(Subs.step(3.0, -1)));
  check('A while a line is still in progress goes to the last finished one',
    Subs.step(21, -1, { start: 20, text: 'still being said' }).start === 12,
    JSON.stringify(Subs.step(21, -1, { start: 20, text: 'still being said' })));

  // A line left marked as in progress from earlier in the video must not
  // drag A to the end of it. Taking the last line in the list as "the one
  // before" did exactly that, and with a whole transcript loaded the last
  // line in the list is the last line of the film.
  const stale = { start: 1.5, text: 'started long ago' };
  check('A does not jump forward when an old line is still marked as playing',
    Subs.step(5, -1, stale).start === 1, JSON.stringify(Subs.step(5, -1, stale)));
  check('A twice in a row keeps going backwards, never to the end',
    Subs.step(3.0, -1, stale).start === 1, JSON.stringify(Subs.step(3.0, -1, stale)));

  // Stepping back onto a copy of the line being left looks exactly like A
  // doing nothing, which is what it looked like when the same line was being
  // filed twice, once as written and once as seen.
  Subs._setCues([
    { start: 1, end: 3, text: 'いちばんめ' },
    { start: 3, end: 5, text: 'にばんめ' },
    { start: 5.2, end: 7, text: 'にばんめ' },
    { start: 7, end: 9, text: 'さんばんめ' }
  ]);
  check('A steps over a duplicate of the line it is leaving',
    Subs.step(5.5, -1).start === 1, JSON.stringify(Subs.step(5.5, -1)));
  // Back to the lines the rest of these checks are written against.
  Subs._setCues(parsed);
  check('D goes to the next line', Subs.step(2.2, 1).start === 3, JSON.stringify(Subs.step(2.2, 1)));
  check('D from a gap goes to the line after it', Subs.step(7, 1).start === 12);
  check('D past the last line has nowhere to go', Subs.step(99, 1) === null);
  check('A before the first line has nowhere to go', Subs.step(0.2, -1) === null);

  // The on-screen fallback only records a line once it ends, so the one
  // currently playing is not in `cues` yet, without also checking it, D
  // would work only up to the line before the one in progress, which in
  // practice meant D stopped working the moment you had used A even once.
  const inProgress = { start: 20, text: 'still being said' };
  check('D reaches the line still in progress when nothing later is known',
    Subs.step(15, 1, inProgress).start === 20, JSON.stringify(Subs.step(15, 1, inProgress)));
  check('D still prefers a fully-known line over the in-progress one if it is sooner',
    Subs.step(2.2, 1, inProgress).start === 3, JSON.stringify(Subs.step(2.2, 1, inProgress)));
  check('the in-progress line is ignored once it is in the past',
    Subs.step(25, 1, inProgress) === null);

  // --- merging a progressively-revealed caption ---------------------------
  // Auto-generated captions are very often drawn word by word as recognition
  // catches up, not all at once. Treating each partial reveal as a brand new
  // line meant a recorded cue could start wherever the LAST fragment began
  // rather than at the sentence's true start, 今回の動画では… coming out
  // starting at 動画 specifically because of this.
  check('a line growing forward is recognised as the same line',
    Subs.isContinuation('今回の', '今回の動画では'));
  check('a line growing further still is still the same line',
    Subs.isContinuation('今回の動画では', '今回の動画では、公園で'));
  check('a shorter revision of the same start is still the same line',
    Subs.isContinuation('今回の動画では、公園で', '今回の動画では'));
  check('an unrelated new line is not treated as a continuation',
    !Subs.isContinuation('今回の動画では', '図書館で本を読んでいました'));
  check('there is nothing to continue when no line was open',
    !Subs.isContinuation('', '今回の'));

  // --- searching a nested response for a key ------------------------------
  // The transcript panel's data is reached by digging for a specific key
  // rather than trusting one exact object path, because that path is
  // undocumented and has moved before. These are the digging functions.
  const nested = { a: { b: [{ c: 1 }, { wanted: 'first' }] }, d: { wanted: 'second' } };
  check('findKey finds a key buried inside nested objects and arrays',
    Subs.findKey(nested, 'wanted') === 'first', Subs.findKey(nested, 'wanted'));
  check('findKey returns null for a key that is not there',
    Subs.findKey(nested, 'missing') === null);
  check('findAllKey finds every occurrence, not just the first',
    JSON.stringify(Subs.findAllKey(nested, 'wanted')) === '["first","second"]',
    JSON.stringify(Subs.findAllKey(nested, 'wanted')));
  check('findAllKey on a key that never appears is empty, not an error',
    JSON.stringify(Subs.findAllKey(nested, 'missing')) === '[]');

  check('segment text reads a plain snippet',
    Subs.segmentText({ snippet: { simpleText: '  日本語  ' } }) === '日本語');
  check('segment text joins styled runs',
    Subs.segmentText({ snippet: { runs: [{ text: '日本' }, { text: '語' }] } }) === '日本語');
  check('a segment with neither is empty rather than throwing',
    Subs.segmentText({}) === '' && Subs.segmentText(null) === '');

  // --- picking which track to use -----------------------------------------
  // A video can carry both a manual and an auto-generated Japanese track;
  // nothing about their order says which is which, so the manual one is
  // preferred by property, not position.
  check('a manual track is preferred over an auto one that comes first',
    Subs.pickTrack([
      { languageCode: 'ja', baseUrl: 'auto', auto: true },
      { languageCode: 'ja', baseUrl: 'manual', auto: false }
    ]).baseUrl === 'manual');
  check('the auto track is used when it is the only Japanese one available',
    Subs.pickTrack([
      { languageCode: 'en', baseUrl: 'x', auto: false },
      { languageCode: 'ja', baseUrl: 'auto', auto: true }
    ]).baseUrl === 'auto');
  check('a non-Japanese track list has nothing to pick',
    Subs.pickTrack([{ languageCode: 'en', baseUrl: 'x', auto: false }]) === undefined ||
    Subs.pickTrack([{ languageCode: 'en', baseUrl: 'x', auto: false }]) === null);

  // --- asking the transcript panel for a language --------------------------
  // The panel answers in whichever language it happens to open on, which is
  // the caption track the viewer last switched on. Left unchecked it handed
  // back the English transcript of a Japanese video to anybody who had not
  // already picked Japanese by hand, which is exactly what made choosing the
  // language by hand feel compulsory.
  const menu = (items) => ({ anything: { deep: { sortFilterSubMenuRenderer: { subMenuItems: items } } } });
  const japanese = { languageCode: 'ja', baseUrl: 'x', name: 'Japanese', auto: false };

  check('the language menu is found however deeply it is buried',
    Subs.languageMenu(menu([
      { title: 'English', selected: true },
      { title: { simpleText: 'Japanese' } }
    ])).map((i) => i.title).join(',') === 'English,Japanese');

  const switched = Subs.wantedLanguage(menu([
    { title: 'English', selected: true },
    { title: 'Japanese',
      continuation: { reloadContinuationData: { continuation: 'token-ja' } } }
  ]), japanese, [japanese, { languageCode: 'en' }]);
  check('a panel open on the wrong language is asked again for the right one',
    switched && switched.params === 'token-ja', JSON.stringify(switched));

  check('a panel already open on the right language is used as it is',
    Subs.wantedLanguage(menu([
      { title: 'English' },
      { title: 'Japanese', selected: true,
        continuation: { reloadContinuationData: { continuation: 'token-ja' } } }
    ]), japanese, [japanese]) === null);

  // An auto-generated track is named "Japanese (auto-generated)" in one place
  // and sometimes just "Japanese" in the other.
  const auto = { languageCode: 'ja', baseUrl: 'x', name: 'Japanese (auto-generated)', auto: true };
  const near = Subs.wantedLanguage(menu([
    { title: 'English', selected: true },
    { title: 'Japanese', serviceEndpoint: { getTranscriptEndpoint: { params: 'p-ja' } } }
  ]), auto, [auto, { languageCode: 'en' }]);
  check('a track and a menu item that name the language slightly differently still match',
    near && near.params === 'p-ja', JSON.stringify(near));

  // The whole point: when the language cannot be shown to be the right one,
  // the transcript is refused and the caption file, which names its own
  // language, settles it instead.
  check('a panel offering nothing in the language being read is refused',
    Subs.wantedLanguage(menu([
      { title: 'English', selected: true },
      { title: 'German', continuation: { reloadContinuationData: { continuation: 't' } } }
    ]), japanese, [japanese, { languageCode: 'en' }]) === Subs.REJECT);
  check('a panel with no language menu on it is refused when the video has several tracks',
    Subs.wantedLanguage({}, japanese, [japanese, { languageCode: 'en' }]) === Subs.REJECT);
  check('but trusted when the video has only the one track it could be',
    Subs.wantedLanguage({}, japanese, [japanese]) === null);
  check('with no track list to check against, the panel is taken as it comes',
    Subs.wantedLanguage(menu([{ title: 'English', selected: true }]), null, null) === null);

  // --- the address the player itself asked for ----------------------------
  // It is for whichever track the viewer has on, which is very often not the
  // language being read: arriving unchecked, an English one overwrote a
  // correct Japanese transcript that had already been fetched.
  check('a caption address in the language being read is taken',
    Subs.wantedTimedtext('https://www.youtube.com/api/timedtext?v=abc&lang=ja&signature=x'));
  check('one in another language is left alone',
    !Subs.wantedTimedtext('https://www.youtube.com/api/timedtext?v=abc&lang=en&signature=x'));
  check('a track being translated into another language goes by what comes back',
    !Subs.wantedTimedtext('https://www.youtube.com/api/timedtext?v=abc&lang=ja&tlang=en'));
  check('and one that says no language at all is not vouched for',
    !Subs.wantedTimedtext('https://www.youtube.com/api/timedtext?v=abc&signature=x'));

  // --- video capture -----------------------------------------------------
  // Media filenames come from the sentence, so re-mining a line reuses its
  // files instead of filling the collection with copies.
  const name1 = Video.name('食べなかったので、お腹が空いた。', 'jpg');
  check('the same line gets the same filename',
    name1 === Video.name('食べなかったので、お腹が空いた。', 'jpg'));
  check('a different line gets a different one',
    Video.name('図書館で本を読んでいました。', 'jpg') !== name1);
  check('filenames survive any filesystem', /^torval-[a-z0-9]+\.jpg$/.test(name1), name1);
  check('the extension is kept', Video.name('x', 'webm').endsWith('.webm'));

  // --- how long a line actually lasts ---------------------------------------
  // An automatic caption revises itself as the recogniser hears more, and
  // every revision is filed as a cue of its own. What you read as one line is
  // several cues in a row, and any one of them can be under a second. Mining
  // recorded one of those and produced half a second of the line before it,
  // which is what "it only records the first half second" was.
  {
    const said = [];
    const words = ['\u304d\u3087\u3046', '\u306f', '\u3044\u3044', '\u3066\u3093\u304d',
      '\u3067\u3059\u306d', '\u307b\u3093\u3068\u3046\u306b', '\u305d\u3046', '\u304a\u3082\u3044\u307e\u3059'];
    let saying = '';
    for (let i = 0; i < words.length; i++) {
      saying += words[i];
      // Every third one, the recogniser changes its mind about the last
      // sound, which is what breaks the roll into separate cues.
      const shown = i % 3 === 2 ? saying.slice(0, -1) + '\u30fc' : saying;
      said.push({ tStartMs: i * 400, dDurationMs: 400, segs: [{ utf8: shown }] });
    }
    const revised = Subs.parse({ events: said });
    Subs._setCues(revised);

    check('a caption that revises itself is filed as several short cues',
      revised.length > 1 && revised.some((c) => c.end - c.start < 1.5),
      JSON.stringify(revised.map((c) => +(c.end - c.start).toFixed(2))));

    const spoken = revised[revised.length - 1].end - revised[0].start;
    const line = Subs.cueFor(revised[revised.length - 1].text);
    check('but mining one of them records the whole line, not the revision',
      line && Math.abs((line.end - line.start) - spoken) < 0.01,
      line && (line.end - line.start) + ' of ' + spoken);
    check('which starts where the line started, not where the revision did',
      line && line.start === revised[0].start, line && line.start);

    // A clean track, where every line is filed once, is left exactly alone.
    const clean = Subs.parse({ events: [0, 1, 2].map((i) => ({
      tStartMs: i * 3000, dDurationMs: 2800, segs: [{ utf8: '\u3053\u308c\u306f' + i + '\u884c\u76ee\u3002' }]
    })) });
    Subs._setCues(clean);
    const one = Subs.cueFor(clean[1].text);
    check('a line on a clean track is still just itself',
      one && one.start === clean[1].start && one.end === clean[1].end,
      JSON.stringify(one));

    // Two lines that merely begin the same way are two lines. Joining them
    // would put the next sentence on the end of every card.
    const alike = Subs.parse({ events: [
      { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: '\u305d\u3046\u3067\u3059\u306d\u3001\u79c1\u306f\u5143\u6c17\u3067\u3059' }] },
      { tStartMs: 1500, dDurationMs: 1500, segs: [{ utf8: '\u305d\u3046\u3067\u3059\u306d\u3001\u3067\u3082\u9055\u3044\u307e\u3059' }] }
    ] });
    Subs._setCues(alike);
    const apart = Subs.cueFor(alike[0].text);
    check('two lines that start alike are not recorded as one',
      apart && apart.end === alike[0].end, JSON.stringify(apart));
  }

  // --- the sound a card carries --------------------------------------------
  // A browser records Opus in a WebM container, which Anki on a computer
  // plays and Anki on a phone very often does not. So the clip is written
  // out again as a plain WAV, which everything plays. This is that file.
  {
    const rate = 24000;
    const samples = Float32Array.from([0, 1, -1, 0.5, 2, -2]);
    const file = Video._wavFile(samples, rate);
    const bytes = new DataView(await file.arrayBuffer());
    const text = (at, n) => Array.from({ length: n },
      (_, i) => String.fromCharCode(bytes.getUint8(at + i))).join("");

    check('it is a WAV file', text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE', text(0, 12));
    check('of plain samples, not compressed anything', bytes.getUint16(20, true) === 1);
    check('one channel, sixteen bits, at the rate asked for',
      bytes.getUint16(22, true) === 1 && bytes.getUint16(34, true) === 16 &&
      bytes.getUint32(24, true) === rate);
    check('the length in the header matches the samples in it',
      bytes.getUint32(40, true) === samples.length * 2 &&
      file.size === 44 + samples.length * 2, file.size);
    check('a sample is written where it belongs on the scale',
      bytes.getInt16(44, true) === 0 && bytes.getInt16(46, true) === 32767 &&
      bytes.getInt16(48, true) === -32767, bytes.getInt16(46, true));
    check('and one past the end of the scale is held at the end of it,',
      bytes.getInt16(52, true) === 32767 && bytes.getInt16(54, true) === -32767,
      bytes.getInt16(52, true));

    // Two channels averaged, not added: adding them would push a loud line
    // past the top of the scale and hold it there, which is a card that
    // crackles.
    const stereo = {
      numberOfChannels: 2, length: 3,
      getChannelData: (c) => c === 0 ? Float32Array.from([1, 0, -1])
                                     : Float32Array.from([0, 0, -1])
    };
    const mixed = Array.from(Video._toMono(stereo));
    check('two channels come down to one, averaged',
      mixed.length === 3 && mixed[0] === 0.5 && mixed[1] === 0 && mixed[2] === -1,
      JSON.stringify(mixed));
  }

  // --- putting a mark back on the page -----------------------------------
  // A page's text is gathered from many text nodes into one string; a word
  // found at some position in that string has to be traced back to the node it
  // came from. Getting this off by one puts the colour beside the word.
  //
  // Three nodes, as a page would give them: 「本を」「読んで」「いました」.
  const pieces = [
    { node: 'a', start: 0, end: 2 },
    { node: 'b', start: 2, end: 5 },
    { node: 'c', start: 6, end: 10 }   // a block boundary left a gap at 5
  ];
  const at = (i) => Highlight._locate(pieces, i);

  check('the first character of the first node',
    JSON.stringify(at(0)) === '{"node":"a","offset":0}', JSON.stringify(at(0)));
  check('the last character of a node belongs to that node, not the next',
    JSON.stringify(at(1)) === '{"node":"a","offset":1}', JSON.stringify(at(1)));
  check('the first character of the next node starts it over at nothing',
    JSON.stringify(at(2)) === '{"node":"b","offset":0}', JSON.stringify(at(2)));
  check('a position in the middle of a later node',
    JSON.stringify(at(8)) === '{"node":"c","offset":2}', JSON.stringify(at(8)));
  check('the joint between two blocks belongs to neither', at(5) === null, JSON.stringify(at(5)));
  check('a position past the end of everything is refused', at(10) === null, JSON.stringify(at(10)));
  check('every position inside a node is found, whichever it is',
    [0, 1, 2, 3, 4, 6, 7, 8, 9].every((i) => at(i) !== null));

  // --- every message has somewhere to go ---------------------------------
  // A message with no case in the background script never answers, and the
  // caller waits for ever. Nothing about that looks like a failure: the
  // feature is simply silent. This shipped once, so it is checked now.
  const sources = ['bar.js', 'content.js', 'highlight.js', 'known.js', 'options.js',
    'reader.js', 'subtitles.js']
    .map((f) => readFileSync(join(ROOT, 'extension', f), 'utf8')).join(' ');
  const backgroundSource = readFileSync(join(ROOT, 'extension', 'background.js'), 'utf8');

  const asked = new Set([...sources.matchAll(/type:\s*'([a-zA-Z]+)'/g)].map((m) => m[1]));
  const answered = new Set([...backgroundSource.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]));
  // Content scripts also talk to each other; the background is not asked about these.
  for (const own of ['timedtextSeen']) asked.delete(own);

  const unrouted = [...asked].filter((type) => !answered.has(type));
  check('every message a page sends has a handler in the background script',
    unrouted.length === 0, 'no handler for: ' + unrouted.join(', '));

  // The other direction is checked more loosely, against any quoted mention
  // rather than only `type: '...'`. The known and ignored panels are the same
  // code told which list it is looking at, so the name of the message travels
  // in a config object and never appears next to the word "type" at all.
  const mentioned = new Set([...sources.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]));
  const unused = [...answered].filter((type) => !mentioned.has(type) && type !== 'status');
  check('the background script answers nothing nobody asks for',
    unused.length === 0, 'never sent: ' + unused.join(', '));

  // --- saving and restoring the word lists --------------------------------
  // The real background script, loaded into a sandbox with a Map standing in
  // for browser storage, so the merge rules are the ones that ship rather than
  // a description of them. The dictionary cannot open in here and says so on
  // the way past; nothing below needs it.
  {
    const stored = {};
    let listener = null;
    const noop = { addListener() {} };
    const fakeApi = {
      webRequest: {},
      action: { onClicked: noop, setBadgeText: async () => {} },
      storage: {
        onChanged: noop,
        local: {
          async get(keys) {
            const names = typeof keys === 'string' ? [keys]
              : Array.isArray(keys) ? keys : Object.keys(keys || stored);
            const out = {};
            for (const name of names) if (name in stored) out[name] = stored[name];
            return out;
          },
          async set(values) { Object.assign(stored, values); }
        }
      },
      runtime: {
        onMessage: { addListener(fn) { listener = fn; } },
        getURL: (path) => path,
        openOptionsPage() {}
      }
    };
    const sandbox = {
      browser: fakeApi, console: { log() {}, warn() {}, error() {} },
      fetch: async () => { throw new Error('no dictionary in this test'); },
      setTimeout, clearTimeout, URL
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    // background.js now asks TorvalLang which language is active before it does
    // almost anything (which dictionary to open, which storage keys to use),
    // so the sandbox needs the same language-registry files the manifest
    // loads before background.js in the real extension.
    for (const f of ['japanese.js', 'scan.js', 'italian.js', 'italian-scan.js',
      'spanish.js', 'spanish-scan.js', 'lang.js']) {
      vm.runInContext(readFileSync(join(ROOT, 'extension', f), 'utf8'), sandbox, { filename: f });
    }
    vm.runInContext(backgroundSource, sandbox, { filename: 'background.js' });

    // --- the fingerprints -------------------------------------------------
    // Reading a page asks about far more words than it finds: some thirty
    // questions per character, nineteen in twenty of which are not words at
    // all. Each was a separate read of the database. A sorted list of one
    // number per word answers almost all of them in memory instead.
    //
    // The one thing that must be true of it is that it never says no about a
    // word that is really there, so that is checked against every single word
    // in the dictionary rather than a sample. The checking runs inside the
    // sandbox, in one go: crossing back and forth half a million times took
    // twenty seconds and proved exactly the same thing.
    {
      sandbox.allTerms = [...index.keys()];
      const report = vm.runInContext(`(function () {
        var marks = new Uint32Array(allTerms.length);
        for (var i = 0; i < allTerms.length; i++) marks[i] = fingerprint(allTerms[i]);
        marks.sort();

        var everything = !fingerprints;   // before the list exists, ask about all
        fingerprints = marks;

        var missed = null;
        for (var j = 0; j < allTerms.length; j++) {
          if (!mightKnow(allTerms[j])) { missed = allTerms[j]; break; }
        }

        // Things that are not words. Random kana, which is what most of the
        // questions a page asks actually look like.
        var kana = '\u3042\u3044\u3046\u3048\u304a\u304b\u304d\u304f\u3051\u3053' +
          '\u3055\u3057\u3059\u305b\u305d\u305f\u3061\u3064\u3066\u3068';
        var seed = 7, asked = 0, through = 0;
        var real = new Set(allTerms);
        for (var n = 0; n < 20000; n++) {
          var junk = '';
          var length = 3 + (n % 4);
          for (var c = 0; c < length; c++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            junk += kana[seed % kana.length];
          }
          if (real.has(junk)) continue;
          asked++;
          if (mightKnow(junk)) through++;
        }

        return { missed: missed, asked: asked, through: through, everything: everything };
      })()`, sandbox);

      check('every word the dictionary has gets past the fingerprints',
        report.missed === null, report.missed);
      check('and next to nothing that is not a word does',
        report.through / report.asked < 0.01,
        report.through + ' of ' + report.asked);
      check('until the list has been made, every word is asked about',
        report.everything === true);
    }

    const send = (message) => listener(message);
    const OLD = 1000, NEW = 9000;
    stored.knownWords = { '本': NEW };
    stored.ignoredWords = { 'ネカフェ': NEW };
    const file = {
      format: 'torval-words', version: 1, saved: '2026-01-01',
      known: { '本': OLD, '読む': OLD },
      ignored: { 'ＡＢＣ': OLD }
    };

    let reply = await send({ type: 'importWords', data: file });
    check('a saved word list loads back in', reply.ok, JSON.stringify(reply));
    check('only the words not already there count as added',
      reply.result.added.known === 1 && reply.result.added.ignored === 1,
      JSON.stringify(reply.result.added));
    check('the earlier of the two dates is the one kept',
      stored.knownWords['本'] === OLD, String(stored.knownWords['本']));
    check('a word only the file had arrives', '読む' in stored.knownWords);

    reply = await send({ type: 'importWords', data: file });
    check('loading the same file twice adds nothing the second time',
      reply.result.added.known === 0 && reply.result.added.ignored === 0,
      JSON.stringify(reply.result.added));

    await send({ type: 'importWords',
      data: { format: 'torval-words', known: {}, ignored: { '本': OLD } } });
    check('known beats ignored when a file disagrees',
      '本' in stored.knownWords && !('本' in stored.ignoredWords),
      JSON.stringify(stored.ignoredWords));

    const before = JSON.stringify(stored);
    const junk = await send({ type: 'importWords', data: { some: 'other tool' } });
    const nothing = await send({ type: 'importWords', data: null });
    check('a file from something else is refused', !junk.ok && !nothing.ok);
    check('a refused file leaves both lists exactly as they were',
      JSON.stringify(stored) === before);

    // --- and the two ways a list could be lost altogether -----------------

    // Every change is a read, an edit and a write of the whole list, so a
    // read that comes back empty when it should not writes one word over
    // months of reading. It has to refuse instead.
    stored.knownWords = { '本': 1, '人': 2, '車': 3 };
    stored.wordCounts = { knownWords: 3 };
    const realGet = fakeApi.storage.local.get;
    fakeApi.storage.local.get = async (keys) => {
      const out = await realGet(keys);
      if ('knownWords' in out) out.knownWords = {};   // storage having a bad day
      return out;
    };
    const refused = await send({ type: 'setKnown', word: '新しい', known: true });
    fakeApi.storage.local.get = realGet;
    check('a list that comes back empty is not written over', !refused.ok, JSON.stringify(refused));
    check('and the words are all still there afterwards',
      Object.keys(stored.knownWords).length === 3, JSON.stringify(stored.knownWords));

    // Two changes at once must not undo each other: both read the same list,
    // and without taking turns the second write loses the first word.
    stored.knownWords = { '本': 1 };
    stored.wordCounts = { knownWords: 1 };
    await Promise.all([
      send({ type: 'setKnown', word: 'あ', known: true }),
      send({ type: 'setKnown', word: 'い', known: true }),
      send({ type: 'setKnown', word: 'う', known: true })
    ]);
    check('changes made at the same time all survive',
      ['本', 'あ', 'い', 'う'].every((w) => w in stored.knownWords),
      JSON.stringify(Object.keys(stored.knownWords)));

    // A list that has gone missing on its own is put back from the copy
    // written beside it, which is what a browser restart used to take away
    // along with everything else.
    delete stored.knownWords;
    await sandbox.rescueLists();
    check('a list that has gone missing comes back from its copy',
      stored.knownWords && Object.keys(stored.knownWords).length === 4,
      JSON.stringify(stored.knownWords));

    // Emptying a list on purpose is left exactly as it is.
    await send({ type: 'forgetWords', words: Object.keys(stored.knownWords) });
    await sandbox.rescueLists();
    check('a list emptied on purpose is not filled back in',
      Object.keys(stored.knownWords).length === 0, JSON.stringify(stored.knownWords));

    // Back to the list the checks below are written against.
    await send({ type: 'addKnownWords', words: ['本'] });

    const saved = await send({ type: 'exportWords' });
    check('a saved file is marked as ours and carries both lists',
      saved.ok && saved.result.format === 'torval-words' &&
      '本' in saved.result.known && 'ネカフェ' in saved.result.ignored,
      JSON.stringify(saved.result && saved.result.format));
    const round = await send({ type: 'importWords', data: saved.result });
    check('saving and loading straight back changes nothing',
      round.result.added.known === 0 && round.result.added.ignored === 0,
      JSON.stringify(round.result.added));

    // A file saved before this was called Torval. The word list is the one
    // thing here that cannot be rebuilt, so a rename must not be able to
    // make last month's copy of it unreadable.
    const older = await send({ type: 'importWords', data: {
      format: 'lll-words', version: 1, saved: '2026-01-01',
      known: { '読む': Date.parse('2026-01-01') }, ignored: {}
    } });
    check('a word file saved under the old name still opens',
      older.ok && older.result.added.known === 1,
      JSON.stringify(older.result || older.error));
    const nonsense = await send({ type: 'importWords', data: { format: 'something-else' } });
    check('and a file that is not one of ours still does not',
      !nonsense.ok, JSON.stringify(nonsense));
  }

  // --- Spanish ----------------------------------------------------------
  // Spanish shares its lookup engine with Italian and brings three things of
  // its own: a character class, a deinflector and a stress rule. The first
  // two are checked here without a dictionary; the third needs none by
  // design, since Spanish spelling says where the stress is.

  // Where the stress falls. Not a guess in this language: the accent, then
  // the last letter, settle it outright, so these are answers rather than
  // approximations and a wrong one is a bug.
  const STRESS = [
    ['hablar', 4, 'no accent, ends in a consonant: the last syllable'],
    ['casa', 1, 'no accent, ends in a vowel: the next-to-last'],
    ['hablas', 1, 'a plural -s does not move the stress'],
    ['joven', 1, 'nor does a final -n'],
    ['canción', 5, 'a written accent wins outright'],
    ['árbol', 0, 'including on the first syllable'],
    ['feliz', 3, 'ends in z, so the last syllable'],
    ['ciudad', 4, 'iu is one syllable, not two'],
    ['caer', 2, 'ae is two syllables, not one'],
    ['reír', 2, 'an accent on a weak vowel breaks the diphthong'],
    ['veinte', 1, 'ei is one syllable and the e carries it'],
    ['bueno', 2, 'ue is one syllable and the e carries it'],
    ['guerra', 2, 'the u of gue is written but not said'],
    ['pingüino', 5, 'the ü of güi is said, which is what the mark is for'],
    ['agua', 0, 'gua is one syllable: a-gua, stressed on the a']
  ];
  for (const [word, at, why] of STRESS) {
    const got = stressEs(word);
    check('Spanish stress: ' + word + ' (' + why + ')', got === at,
      'got ' + got + ' (' + word[got] + '), wanted ' + at + ' (' + word[at] + ')');
  }
  check('a dictionary phrase gets no single stressed letter',
    stressEs('dar a luz') === null, String(stressEs('dar a luz')));

  // Deinflection. Everything here is a form the rule table has to reach on
  // its own, without the dictionary's own index of written-down forms.
  const UNDO = [
    ['hablábamos', 'hablar', 'regular imperfect'],
    ['comiste', 'comer', 'regular preterite, which Italian does not attempt'],
    ['vivimos', 'vivir', 'and the -ir class it shares its endings with'],
    ['hablaré', 'hablar', 'the future, built on the whole infinitive'],
    ['comeríamos', 'comer', 'and the conditional with it'],
    ['hables', 'hablar', 'present subjunctive'],
    ['hablara', 'hablar', 'past subjunctive, the -ra one'],
    ['hablase', 'hablar', 'and the -se one'],
    ['dijeron', 'decir', 'an irregular preterite'],
    ['fue', 'ser', 'a preterite that is two verbs at once'],
    ['fue', 'ir', 'and the other of them'],
    ['tendría', 'tener', 'an irregular conditional, off its own stem'],
    ['hubiera', 'haber', 'the subjunctive of the auxiliary'],
    ['dármelo', 'dar', 'two pronouns and the accent they add'],
    ['hablarme', 'hablar', 'one pronoun, which adds no accent'],
    ['diciéndoselo', 'decir', 'an irregular gerund wearing two pronouns'],
    ['hablándome', 'hablar', 'and a regular one wearing one'],
    ['altas', 'alto', 'feminine plural'],
    ['luces', 'luz', 'a plural that changes the letter before it'],
    ['canciones', 'canción', 'and one that drops a written accent'],
    ['rápidamente', 'rápido', 'an adverb built on the feminine']
  ];
  for (const [word, lemma, why] of UNDO) {
    const terms = DeinflectEs.deinflect(word).map((r) => r.term);
    check('Spanish: ' + word + ' -> ' + lemma + ' (' + why + ')',
      terms.includes(lemma), JSON.stringify(terms.slice(0, 10)));
  }
  check('Spanish deinflection returns the untouched word first',
    DeinflectEs.deinflect('hablar')[0].term === 'hablar');
  check('and terminates on pathological input',
    DeinflectEs.deinflect('aaaaaaaaaaaaaaaaaaaa').length < 400,
    String(DeinflectEs.deinflect('aaaaaaaaaaaaaaaaaaaa').length));

  // The two Romance tables share one solver now. Italian has to keep
  // answering exactly as it did before that was true.
  check('Italian still deinflects through the shared solver',
    DeinflectIt.deinflect('parlavamo').map((r) => r.term).includes('parlare'));
  check('and Italian and Spanish do not answer for each other',
    !DeinflectIt.deinflect('hablábamos').map((r) => r.term).includes('hablar') &&
    !DeinflectEs.deinflect('parlavamo').map((r) => r.term).includes('parlare'));

  // A possessive agrees in gender and number like an adjective, but
  // Wiktionary files it as a pronoun, so the agreement rules have to be
  // allowed to reach one. "sue" is the case that showed it: unlike sua,
  // mie and tue, Wiktionary never wrote it down as a page of its own, so
  // with the rules stopping at nouns and adjectives it was a word with no
  // answer at all.
  check('an Italian possessive is reached by the agreement rules',
    DeinflectIt.deinflect('sue').map((r) => r.term).includes('suo'));
  check('and a Spanish one is too',
    DeinflectEs.deinflect('suyas').map((r) => r.term).includes('suyo'));

  // The lookup engine reads whichever language is active, and has to change
  // its mind the moment that changes rather than at the next reload.
  Lang._setActive('it');
  check('the shared lookup engine takes its scan window from the language',
    LookupLatin.MAX_SCAN === Lang.profile().scanWindow);
  Lang._setActive('es');
  check('and its deinflector, so a switch is picked up by the next lookup',
    Lang.profile().deinflector() === DeinflectEs);
  Lang._setActive('ja');

  // The whole Spanish path, against the real built dictionary, when there is
  // one: it is gitignored like the others, so a fresh clone has none and
  // these are skipped rather than failed.
  const SPANISH = join(ROOT, 'extension', 'data-es');
  if (existsSync(join(SPANISH, 'meta.json'))) {
    const esDb = loadDictionary(SPANISH);
    Lang._setActive('es');
    const SENTENCES = [
      ['Hablábamos de la ciudad.', 0, 'hablar'],
      ['Las casas son bonitas.', 4, 'casa'],
      ['No quiero dármelo ahora.', 10, 'dar'],
      ['Estaba diciéndoselo a ella.', 7, 'decir'],
      ['Me gustan las canciones.', 15, 'canción']
    ];
    for (const [text, at, lemma] of SENTENCES) {
      const found = await LookupLatin.hover(text, at, esDb);
      const hit = found.groups[0] && found.groups[0].hits[0];
      check('Spanish lookup: ' + text, hit && hit.entry.k[0] === lemma,
        hit ? 'got ' + hit.entry.k[0] : 'nothing found');
    }
    const casa = await LookupLatin.hover('la casa', 3, esDb);
    check('and the stress mark comes with the entry',
      casa.groups[0].hits[0].entry.st === 1,
      JSON.stringify(casa.groups[0].hits[0].entry.st));
    Lang._setActive('ja');
  } else {
    console.log('  (no Spanish dictionary built; skipping its lookup checks. ' +
      'Run: node tools/build-dict-es.mjs)');
  }

  // --- the article a noun is learned with -------------------------------
  //
  // forWord rather than forEntry: the entry-shaped wrapper only reads the
  // gender and the stress off an entry and asks the active language, and
  // the grammar, which is all there is to get wrong, is here.
  const ARTICLES = [
    // Italian, masculine: il unless the word opens on something il cannot
    // be said in front of.
    ['it', 'cane', 'm', false, null, 'il cane'],
    ['it', 'studio', 'm', false, null, 'lo studio'],
    ['it', 'sbaglio', 'm', false, null, 'lo sbaglio'],
    ['it', 'sale', 'm', false, null, 'il sale'],          // s before a vowel is ordinary
    ['it', 'zio', 'm', false, null, 'lo zio'],
    ['it', 'gnocco', 'm', false, null, 'lo gnocco'],
    ['it', 'psicologo', 'm', false, null, 'lo psicologo'],
    ['it', 'yogurt', 'm', false, null, 'lo yogurt'],
    ['it', 'iato', 'm', false, null, 'lo iato'],          // i before a vowel is a consonant
    ['it', 'amico', 'm', false, null, 'l’amico'],
    ['it', 'hotel', 'm', false, null, 'l’hotel'],         // the h is not there
    // Italian, feminine and the plurals.
    ['it', 'casa', 'f', false, null, 'la casa'],
    ['it', 'ora', 'f', false, null, 'l’ora'],
    ['it', 'iena', 'f', false, null, 'la iena'],
    ['it', 'case', 'f', true, null, 'le case'],
    ['it', 'cani', 'm', true, null, 'i cani'],
    ['it', 'studi', 'm', true, null, 'gli studi'],
    ['it', 'amici', 'm', true, null, 'gli amici'],
    // Either gender, which is a fact about the word and so is written out.
    ['it', 'turista', 'mf', false, null, 'il/la turista'],
    ['it', 'insegnante', 'mf', false, null, 'l’insegnante'],
    // Spanish, where the only wrinkle is the stressed a.
    ['es', 'perro', 'm', false, 1, 'el perro'],
    ['es', 'perros', 'm', true, 1, 'los perros'],
    ['es', 'casa', 'f', false, 1, 'la casa'],
    ['es', 'abeja', 'f', false, 1, 'la abeja'],           // an a, but not a stressed one
    ['es', 'agua', 'f', false, 0, 'el agua'],
    ['es', 'hacha', 'f', false, 1, 'el hacha'],           // the h does not count
    ['es', 'área', 'f', false, 0, 'el área'],
    ['es', 'aguas', 'f', true, 0, 'las aguas'],           // and the plural is las again
    ['es', 'alma', 'f', false, null, 'la alma'],          // no stress known: the plain answer
    // A language with no articles at all gets nothing put in front of it.
    ['ja', '犬', 'm', false, null, '犬']
  ];
  for (const [code, word, gender, plural, stress, expected] of ARTICLES) {
    const got = Article.join(Article.forWord(code, word, gender, plural, stress), word);
    check('article: ' + expected, got === expected, 'got ' + got);
  }
  check('a word with no gender on it is left alone',
    Article.join(Article.forWord('it', 'parlare', '', false, null), 'parlare') === 'parlare');

  // The gender itself, as the dictionary build reads it off Wiktionary's
  // headword template.
  const GENDERS = [
    [{ pos: 'noun', head_templates: [{ args: { 1: 'm' } }] }, 'm', false],
    [{ pos: 'noun', head_templates: [{ args: { 1: 'f' } }] }, 'f', false],
    [{ pos: 'noun', head_templates: [{ args: { 1: 'mfbysense' } }] }, 'mf', false],
    [{ pos: 'noun', head_templates: [{ args: { 1: 'm,f<q:rare>' } }] }, 'mf', false],
    [{ pos: 'noun', head_templates: [{ args: { 1: 'm-p' } }] }, 'm', true],
    [{ pos: 'noun', head_templates: [{ args: { 1: 'f-p' } }] }, 'f', true],
    [{ pos: 'noun', head_templates: [{ args: { 1: 'it', 2: 'noun', g: 'm' } }] }, 'm', false],
    [{ pos: 'noun', head_templates: [{ args: { 1: 'it', 2: 'noun form' } }] }, null, false],
    [{ pos: 'noun', head_templates: [{ args: { 1: 'p' } }] }, null, false]
  ];
  for (const [row, gender, plural] of GENDERS) {
    const got = genderOf(row);
    check('gender: ' + JSON.stringify(row.head_templates[0].args) + ' -> ' + gender,
      (got ? got.g : null) === gender && (got ? got.plural : false) === plural,
      JSON.stringify(got));
  }

  // --- deinflector sanity ----------------------------------------------
  check('deinflect returns the untouched word first',
    Deinflect.deinflect('食べる')[0].term === '食べる');
  check('deinflect terminates on pathological input',
    Deinflect.deinflect('ってってってってってって').length < 400);

  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
};

run();
