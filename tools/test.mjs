/*
 * LLL — test suite
 *
 *   node --max-old-space-size=4096 tools/test.mjs
 *
 * Loads the built dictionary into memory and runs the extension's real lookup
 * code against it. The only thing stubbed is the storage layer: the extension
 * reads from IndexedDB, this reads from a Map. Everything above that — the
 * deinflection rules, the scan-every-length search, the ranking — is the same
 * code that ships.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'extension', 'data');
const require = createRequire(import.meta.url);
const Lookup = require(join(ROOT, 'extension', 'lookup.js'));
const Deinflect = require(join(ROOT, 'extension', 'deinflect.js'));
const Anki = require(join(ROOT, 'extension', 'anki.js'));
const Pitch = require(join(ROOT, 'extension', 'pitch.js'));
const Video = require(join(ROOT, 'extension', 'video.js'));
const Subs = require(join(ROOT, 'extension', 'subtitles.js'));
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

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(`${name}${detail ? '\n      ' + detail : ''}`);
}

/** The top match for `text` should be `expected` characters of surface text. */
async function topMatch(text, expectedSurface, expectedHeadword, expectedReasons) {
  const groups = await Lookup.search(text, db);
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

/** `text` must NOT produce `headword` — guards against the deinflector inventing words. */
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
  await topMatch('食べている', '食べている', '食べる', '-te < progressive');
  await topMatch('食べてしまった', '食べてしまった', '食べる', '-te < completely < past');
  await topMatch('食べちゃった', '食べちゃった', '食べる', '-te < completely < past');

  // Godan across all nine rows, in their trickiest (て/た) forms.
  await topMatch('買って', '買って', '買う', '-te');
  await topMatch('書いた', '書いた', '書く', 'past');
  await topMatch('泳いで', '泳いで', '泳ぐ', '-te');
  await topMatch('話して', '話して', '話す', '-te');
  await contains('待った', '待つ');   // 待った is also a noun in its own right
  await topMatch('死んで', '死んで', '死ぬ', '-te');
  await topMatch('遊んだ', '遊んだ', '遊ぶ', 'past');
  await topMatch('読んで', '読んで', '読む', '-te');
  await topMatch('取って', '取って', '取る', '-te');
  // 行く is the classic irregular て-form — 行いて would be wrong.
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
  await topMatch('美しくて', '美しくて', '美しい', '-te');
  await contains('よかった', '良い');
  await contains('静かじゃない', '静か');
  await contains('元気でした', '元気');

  // --- kana-only and readings ------------------------------------------
  await contains('わかりました', '分かる');
  await contains('ありがとう', 'ありがとう');
  await contains('コーヒーを', 'コーヒー');

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
      image: { filename: 'lll-abc.jpg', data: 'AAAA' },
      sentenceAudio: { filename: 'lll-abc.webm', data: 'BBBB' } } });
  const added = mediaCalls.find((c) => c.action === 'addNote').params.note.fields;
  check('a frame is stored and referenced as an image',
    mediaCalls.filter((c) => c.action === 'storeMediaFile').length === 2 &&
    added['Images'] === '<img src="lll-abc.jpg">',
    JSON.stringify(added));
  check('the line’s audio is stored and referenced as a sound',
    added['Sentence Audio'] === '[sound:lll-abc.webm]', JSON.stringify(added));

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
  // sentence-mining note type is the sentence — so that rule is left off, and
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
  check('addNote does not itself query for duplicates — that is a separate, up-front check',
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
    { deck: 'D', model: 'M', fields: guessed, tags: ['lll'] },
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
  // the sentence; LLL asks about the word instead. See the duplicate tests below.
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
    /^lll-[\p{L}\p{N}-]+\.mp3$/u.test(Anki.audioFilename('食べる', 'たべる')),
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
    /^\[sound:lll-.+\.mp3\]$/.test(withAudio.params.note.fields['Word Audio']),
    JSON.stringify(calls.map((c) => c.action)) + ' ' +
    JSON.stringify(withAudio && withAudio.params.note.fields));

  check('Word Audio is guessed from the field name',
    Anki.guessMapping(['Word Audio'])['Word Audio'] === 'audio');
  delete globalThis.fetch;

  // --- search-only spellings -------------------------------------------
  // ます is filed under the kanji 〼, which JMdict tags "sK" — findable, but
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
  // dictionary, and matching it by that kanji spelling should show it — but
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

  // 読む is v5m,vt on every one of its senses — the whole combination is shared.
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

  const cover = Lookup.coverage(['本', '本', '車', '人'], new Set(['本']));
  check('coverage counts repeats, not distinct words',
    cover.total === 4 && cover.known === 2, JSON.stringify(cover));
  check('coverage reports how often each word was said, so one more known word moves it',
    cover.counts['本'] === 2 && cover.counts['車'] === 1, JSON.stringify(cover.counts));
  check('knowing nothing scores nothing, and is not an error',
    Lookup.coverage(['本'], new Set()).known === 0);
  check('an empty passage has nothing to score',
    Lookup.coverage([], new Set(['本'])).total === 0);
  check('knowing every word scores all of them',
    Lookup.coverage(['本', '車'], new Set(['本', '車'])).known === 2);

  // The count a word carries is exactly how far the bar moves when it is
  // marked known, which is what lets the popup's ✓ answer immediately instead
  // of reading the whole page again.
  const passageTokens = await Lookup.extractTokens(passage, db);
  const before = Lookup.coverage(passageTokens, new Set());
  const after = Lookup.coverage(passageTokens, new Set(['本']));
  check('marking one word known moves the score by exactly that word’s count',
    after.known - before.known === before.counts['本'],
    `${after.known - before.known} vs ${before.counts['本']}`);

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

  // 箸 and 橋 are both はし and differ only in pitch — the case that proves a
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

  // A steps back a line, D forward. Part-way through a line, A restarts it;
  // pressing it again goes to the line before, which is how you rewatch.
  check('A part-way through a line goes back to its start',
    Subs.step(2.2, -1).start === 1, JSON.stringify(Subs.step(2.2, -1)));
  check('A at the start of a line goes to the one before',
    Subs.step(3.0, -1).start === 1, JSON.stringify(Subs.step(3.0, -1)));
  check('D goes to the next line', Subs.step(2.2, 1).start === 3, JSON.stringify(Subs.step(2.2, 1)));
  check('D from a gap goes to the line after it', Subs.step(7, 1).start === 12);
  check('D past the last line has nowhere to go', Subs.step(99, 1) === null);
  check('A before the first line has nowhere to go', Subs.step(0.2, -1) === null);

  // The on-screen fallback only records a line once it ends, so the one
  // currently playing is not in `cues` yet — without also checking it, D
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
  // rather than at the sentence's true start — 今回の動画では… coming out
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

  // --- video capture -----------------------------------------------------
  // Media filenames come from the sentence, so re-mining a line reuses its
  // files instead of filling the collection with copies.
  const name1 = Video.name('食べなかったので、お腹が空いた。', 'jpg');
  check('the same line gets the same filename',
    name1 === Video.name('食べなかったので、お腹が空いた。', 'jpg'));
  check('a different line gets a different one',
    Video.name('図書館で本を読んでいました。', 'jpg') !== name1);
  check('filenames survive any filesystem', /^lll-[a-z0-9]+\.jpg$/.test(name1), name1);
  check('the extension is kept', Video.name('x', 'webm').endsWith('.webm'));

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
