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
  check('audio and pitch fields are recognised too',
    guessed['Word Audio'] === 'audio' && guessed['Pitch'] === 'pitch',
    JSON.stringify(guessed));
  check('fields it cannot place are left blank rather than guessed at',
    guessed['Sentence Audio'] === '' && guessed['Images'] === '' &&
    guessed['Source'] === '' && guessed['Sentence English'] === '',
    JSON.stringify(guessed));
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
  check('duplicates are refused by default',
    sent.params.note.options.allowDuplicate === false);

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
  check('no audio still makes the card, with the audio field left off',
    calls.length === 1 && calls[0].action === 'addNote' &&
    !('Word Audio' in calls[0].params.note.fields),
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
  check('audio is stored in Anki and referenced by a sound tag',
    calls.length === 2 && calls[0].action === 'storeMediaFile' &&
    /^\[sound:lll-.+\.mp3\]$/.test(calls[1].params.note.fields['Word Audio']),
    JSON.stringify(calls.map((c) => c.action)) + ' ' +
    JSON.stringify(calls[1] && calls[1].params.note.fields));

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
