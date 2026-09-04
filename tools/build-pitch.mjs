/*
 * LLL, pitch accent build step
 *
 *   node tools/build-pitch.mjs
 *
 * Downloads the Kanjium accent database and turns it into one lookup file.
 * Kanjium's data derives from the NHK accent dictionary and 大辞林, which is the
 * most authoritative source available for standard Tokyo accent, and is the same
 * data Yomitan and AJT Pitch Accent use.
 *
 * Each row is a word, a reading, and where the pitch drops, 0 meaning it never
 * does. A word can honestly have more than one accent (１ is both いち and ひと),
 * so they are kept as a list and the first is treated as the usual one.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'data', 'accents.txt');
const OUT = join(ROOT, 'extension', 'data', 'pitch.json');
const SOURCE_URL =
  'https://raw.githubusercontent.com/mifunetoshiro/kanjium/master/data/source_files/raw/accents.txt';

async function main() {
  if (!existsSync(SOURCE)) {
    mkdirSync(dirname(SOURCE), { recursive: true });
    console.log('Downloading Kanjium accent data from', SOURCE_URL);
    const res = await fetch(SOURCE_URL);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    writeFileSync(SOURCE, Buffer.from(await res.arrayBuffer()));
  }

  const byWord = {};              // "word\treading" -> [accent, ...]
  const readings = new Map();     // reading -> Set of accents seen

  let rows = 0;
  for (const line of readFileSync(SOURCE, 'utf8').split('\n')) {
    const [word, reading, raw] = line.replace(/\r$/, '').split('\t');
    if (!word || !reading || !raw) continue;

    const accents = parseAccents(raw);
    if (!accents.length) continue;

    rows++;
    byWord[`${word}\t${reading}`] = accents;

    let seen = readings.get(reading);
    if (!seen) { seen = new Set(); readings.set(reading, seen); }
    accents.forEach((a) => seen.add(a));
  }

  // A reading on its own is only usable when nothing disagrees about it. はし is
  // 箸 (1), 橋 (2) and 端 (0) at once, so a bare はし tells you nothing and is
  // better left out than guessed at.
  const byReading = {};
  let ambiguous = 0;
  readings.forEach((accents, reading) => {
    if (accents.size === 1) byReading[reading] = [...accents];
    else ambiguous++;
  });

  writeFileSync(OUT, JSON.stringify({
    source: 'Kanjium (NHK 日本語発音アクセント辞典 / 大辞林), CC BY-SA 4.0',
    built: new Date().toISOString().slice(0, 10),
    byWord,
    byReading
  }));

  const size = (readFileSync(OUT).length / 1048576).toFixed(1);
  console.log(`  ${rows} words, ${Object.keys(byReading).length} unambiguous readings ` +
    `(${ambiguous} readings left out as ambiguous)`);
  console.log(`  wrote extension/data/pitch.json (${size} MB)`);
}

/**
 * "2" -> [2].  "0,3" -> [0, 3].  "(副)1" -> [1].
 * Some rows qualify the accent with a part of speech in brackets; the number is
 * the part we want either way.
 */
function parseAccents(raw) {
  const out = [];
  for (const part of raw.split(',')) {
    const m = part.trim().match(/(\d+)\s*$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

main().catch((err) => { console.error(err); process.exit(1); });
