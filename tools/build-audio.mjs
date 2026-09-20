/*
 * Torval, word recordings
 *
 * Japanese gets its pronunciations from JapanesePod101, one request per
 * card. Italian and Spanish have no equivalent: there is no free endpoint
 * you can hand a word to and get a recording back. What there is instead is
 * Lingua Libre, a Wikimedia project where volunteers record their own
 * language a word at a time, and whose output sits on Wikimedia Commons
 * under CC BY-SA. Tens of thousands of words, already recorded, already
 * free to pass on.
 *
 * The catch is that Commons is organised by filename, not by word, so there
 * is no way to ask "is there a recording of nuvola" at the moment somebody
 * hovers it. So the question is answered here, once, at build time: this
 * walks the category, reads the word out of each filename, and leaves
 * behind a small table the dictionary build can fold into its entries.
 *
 * A Commons file lives at a path derived from the MD5 of its own name, so
 * the table stores those two hex characters alongside the speaker, and the
 * whole URL is rebuilt from the word itself at the moment it is needed.
 * Twelve bytes an entry rather than two hundred.
 *
 *   node tools/build-audio.mjs
 *
 * Writes data/audio-it.json and data/audio-es.json. Run by the dictionary
 * builds when the file is not already there; Commons throttles hard, so it
 * asks slowly and takes a few minutes.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const API = 'https://commons.wikimedia.org/w/api.php';

// Wikimedia asks that a script identify itself and say where to complain.
const AGENT = 'Torval/0.1 (https://github.com/jacobgerritz/Torval) dictionary build';

// Commons hands out 429s freely. One request every second and a half keeps
// it happy for the fifty or so pages this takes; the backoff below is for
// when it does not.
const PAUSE_MS = 1500;

/*
 * LL-Q652 (ita)-LangPao-aquila.wav
 *   ^ the language's Wikidata id, and its ISO code
 *                    ^ who recorded it
 *                            ^ the word, which is the part we are after
 *
 * The speaker is matched lazily and the word greedily, because a word may
 * well contain a hyphen (2-metilpropano) and a speaker's name rarely does.
 * A name that does simply fails to line up with any headword later, which
 * costs that one recording and nothing else.
 */
const FILENAME = /^File:LL-Q\d+ \([a-z]{3}\)-(.+?)-(.+)\.wav$/;

async function ask(params) {
  const url = API + '?' + new URLSearchParams({ format: 'json', ...params });
  for (let attempt = 0; attempt < 8; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': AGENT } });
    } catch (err) {
      if (attempt === 7) throw err;
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after')) || 10 * (attempt + 1);
      process.stderr.write(` [Commons asked for ${after}s] `);
      await sleep(after * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Commons answered ${res.status}`);
    const body = await res.json();
    await sleep(PAUSE_MS);
    return body;
  }
  throw new Error('Commons kept refusing');
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Where Commons keeps a file, which is the first two hex of its name's MD5. */
function shard(filename) {
  return createHash('md5').update(filename.replace(/ /g, '_')).digest('hex').slice(0, 2);
}

/**
 * Every word in one Lingua Libre category, as word -> "<shard>|<speaker>".
 *
 * Where a word has been recorded more than once, whichever reading Commons
 * lists first is kept. They are all one person saying one word; there is
 * nothing to choose between them and no reason to store two.
 */
async function harvest(category) {
  const found = new Map();
  let files = 0;
  let cont = {};
  for (;;) {
    const body = await ask({
      action: 'query', list: 'categorymembers', cmtype: 'file', cmlimit: '500',
      cmtitle: 'Category:' + category, ...cont
    });
    for (const member of body.query.categorymembers) {
      files++;
      const parts = FILENAME.exec(member.title);
      if (!parts) continue;
      const [, speaker, word] = parts;
      if (found.has(word)) continue;
      found.set(word, shard(member.title.slice('File:'.length)) + '|' + speaker);
    }
    process.stderr.write(`\r  ${category}: ${files} files, ${found.size} words`);
    if (!body.continue) break;
    cont = body.continue;
  }
  process.stderr.write('\n');
  return found;
}

/**
 * The recordings for one language, harvesting them first if they are not
 * already on disk. Returns a Map, or an empty one if Commons cannot be
 * reached: a dictionary without recordings is worth building, and a build
 * that fails because a website is down is not.
 */
export async function ensureAudio(root, lang) {
  if (!lang.voice) return new Map();
  const file = join(root, 'data', `audio-${lang.code}.json`);
  if (existsSync(file)) {
    return new Map(Object.entries(JSON.parse(await readFile(file, 'utf8'))));
  }
  console.log(`Asking Commons for ${lang.name} recordings (this takes a few minutes)`);
  let found;
  try {
    found = await harvest(lang.voice.category);
  } catch (err) {
    console.warn(`  could not reach Commons (${err.message}); building without recordings`);
    return new Map();
  }
  await writeFile(file, JSON.stringify(Object.fromEntries(found)));
  console.log(`  ${found.size} recorded words -> data/audio-${lang.code}.json`);
  return found;
}
