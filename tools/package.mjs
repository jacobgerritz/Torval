/*
 * Torval, packaging it for release
 *
 *   node tools/package.mjs
 *
 * Writes dist/torval-<version>.zip: the extension directory exactly as it
 * will be installed, dictionaries included. That file is what gets uploaded
 * to addons.mozilla.org, which signs it and hands back an .xpi that installs
 * permanently in ordinary Firefox. An unsigned zip installs nowhere except
 * about:debugging, which is the state this has been in all along.
 *
 * The checks below are the ones a bad release actually fails: a dictionary
 * that was never built, a file named in the manifest that is not there, a
 * page asking for a script that does not exist. None of them is clever, and
 * each of them has a failure mode that looks, to somebody installing the
 * add-on, like the program being broken rather than the package being
 * short.
 *
 * Nothing here signs anything. Signing needs credentials, and credentials do
 * not belong in a repository; the README says where they go.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = join(ROOT, 'extension');
const DIST = join(ROOT, 'dist');

// Each language's built data, and the command that builds it. A package
// missing one of these installs and then tells its user, the first time they
// pick that language, that a file is missing.
const DICTIONARIES = [
  ['data', 'node tools/build-dict.mjs && node tools/build-pitch.mjs'],
  ['data-it', 'node tools/build-dict-it.mjs'],
  ['data-es', 'node tools/build-dict-es.mjs']
];

const manifest = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8'));
const problems = [];

// --- every file the manifest names ----------------------------------------
const named = [
  ...manifest.background.scripts,
  ...manifest.content_scripts.flatMap((c) => c.js),
  ...manifest.web_accessible_resources.flatMap((r) => r.resources),
  manifest.action.default_popup,
  manifest.action.default_icon,
  manifest.options_ui.page,
  ...Object.values(manifest.icons || {})
].filter(Boolean);

for (const file of new Set(named)) {
  if (!existsSync(join(EXTENSION, file))) problems.push(`manifest names ${file}, which is not there`);
}

// --- every script a page asks for -----------------------------------------
// The pages load their scripts by hand, in an order that matters, and adding
// a language has meant editing three of these lists at once more than once.
for (const page of readdirSync(EXTENSION).filter((f) => extname(f) === '.html')) {
  const html = readFileSync(join(EXTENSION, page), 'utf8');
  for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) {
    if (!existsSync(join(EXTENSION, src))) problems.push(`${page} asks for ${src}, which is not there`);
  }
  for (const [, href] of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
    if (!existsSync(join(EXTENSION, href))) problems.push(`${page} asks for ${href}, which is not there`);
  }
}

// --- the dictionaries ------------------------------------------------------
for (const [dir, how] of DICTIONARIES) {
  if (!existsSync(join(EXTENSION, dir, 'meta.json'))) {
    problems.push(`extension/${dir}/ has no dictionary in it. Run: ${how}`);
  }
}

// --- nothing the browser will complain about ------------------------------
// JSON has no comments, and every key Firefox does not recognise is reported
// to the reader as a warning on the add-on. Explanations belong in the
// README; this is here because they were once put in the manifest and the
// warning is the only thing that said so.
(function unknownKeys(obj, path) {
  for (const key of Object.keys(obj)) {
    if (key.startsWith('_')) problems.push(`manifest has ${path}${key}, which Firefox will warn about`);
    const value = obj[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) unknownKeys(value, path + key + '.');
  }
})(manifest, '');

// --- nothing left lying around --------------------------------------------
for (const f of readdirSync(EXTENSION)) {
  if (/^zz-|\.orig$|\.rej$|~$/.test(f)) problems.push(`extension/${f} looks like a leftover`);
}

if (problems.length) {
  console.error('Not packaging. ' + problems.length + ' thing' +
    (problems.length === 1 ? '' : 's') + ' wrong:\n');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

mkdirSync(DIST, { recursive: true });
const out = join(DIST, `torval-${manifest.version}.zip`);

// zip rather than a library, because every machine that can run Firefox has
// one, and an add-on package is a plain zip with no ceremony in it. -r is
// recursive, -q quiet, -X drops the platform's own metadata, which has no
// business in someone else's browser.
execFileSync('zip', ['-r', '-q', '-X', out, '.'], { cwd: EXTENSION });

const size = statSync(out).size;
console.log(`wrote ${out.replace(ROOT + '/', '')}, ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log('Upload it at https://addons.mozilla.org/developers/addon/submit/upload-unlisted');
if (size > 100 * 1024 * 1024) {
  console.log('Note: this is a large add-on. The store accepts it, but review takes longer.');
}
