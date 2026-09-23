/*
 * Torval, packaging it for release
 *
 *   node tools/package.mjs                 both browsers
 *   node tools/package.mjs --firefox       one of them
 *
 * Writes dist/torval-<version>-<browser>.zip: the extension directory
 * exactly as it will be installed, dictionaries included, with a manifest
 * tailored to the browser it is for (see TARGETS, at the bottom). The
 * Firefox one goes to addons.mozilla.org, which signs it and hands back an
 * .xpi that installs permanently in ordinary Firefox; the Chrome one goes
 * to the Web Store developer console. An unsigned zip installs nowhere
 * except about:debugging, which is the state this has been in all along.
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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
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
  ['data-es', 'node tools/build-dict-es.mjs'],
  ['data-en', 'node tools/build-dict-en.mjs']
];

const manifest = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8'));
const problems = [];   // these stop the build
const warnings = [];   // these only say so

// --- every file the manifest names ----------------------------------------
const named = [
  ...manifest.background.scripts,
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((c) => c.js),
  ...manifest.web_accessible_resources.flatMap((r) => r.resources),
  ...(manifest.declarative_net_request?.rule_resources || []).map((r) => r.path),
  manifest.action.default_popup,
  ...Object.values(manifest.action.default_icon || {}),
  manifest.options_ui.page,
  ...Object.values(manifest.icons || {})
].filter(Boolean);

// --- the two background lists, which have to say the same thing -----------
// Firefox is handed manifest.background.scripts; Chrome is handed sw.js,
// which importScripts the same files in the same order. Two lists of the
// same eighteen names drift the first time a nineteenth is added, and the
// way that shows up is Chrome alone breaking, so it is checked here.
const worker = readFileSync(join(EXTENSION, manifest.background.service_worker), 'utf8');
const imported = [...worker.matchAll(/'([^']+\.js)'/g)].map((m) => m[1]);
if (imported.join() !== manifest.background.scripts.join()) {
  problems.push(`${manifest.background.service_worker} does not load the same scripts, ` +
    'in the same order, as the manifest\'s background.scripts');
}

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

// --- and one thing that is only wrong on the day it ships -----------------
// The settings page links to the Anki add-on on AnkiWeb, which hands out its
// id at the first upload. Until then the link is a placeholder. That must not
// stop a build, since the builds are how the add-on gets tested, but it must
// not go quietly into a store either.
if (readFileSync(join(EXTENSION, 'options.html'), 'utf8').includes('shared/info/000000000')) {
  warnings.push('the AnkiWeb link on the Words page is still the placeholder id');
}

if (warnings.length) {
  for (const w of warnings) console.warn('note: ' + w);
  console.warn('');
}

if (problems.length) {
  console.error('Not packaging. ' + problems.length + ' thing' +
    (problems.length === 1 ? '' : 's') + ' wrong:\n');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

mkdirSync(DIST, { recursive: true });

/*
 * One extension, two browsers, two manifests.
 *
 * Almost everything is shared, and what is not is not a matter of taste:
 * each browser refuses the other's answer to the same two questions. How
 * the background runs, an event page given a list of scripts in Firefox, a
 * service worker given one file in Chrome. And how YouTube's caption
 * response gets the CORS header it never carries, a blocking webRequest
 * listener in Firefox, a declarativeNetRequest rule in Chrome, which is the
 * only way left there.
 *
 * Both keys sit in extension/manifest.json together, because that is the
 * one place a reader should have to look, and each build takes out what its
 * browser has no use for. A key left in is not harmless: webRequestBlocking
 * gets a Chrome submission rejected outright, and a service_worker Firefox
 * cannot run is a warning on the listing.
 */
const TARGETS = {
  firefox: (m) => {
    delete m.background.service_worker;
    delete m.declarative_net_request;
    // Recording a copy-protected video's sound is a Chrome-only thing, and
    // not by choice: Firefox has no tabCapture API and its getDisplayMedia
    // ignores `audio` outright (bug 1541425, open since 2019). Both keys
    // would be warnings on the listing for an ability the build does not
    // have, and an offscreen document is Chrome's answer to a problem
    // Firefox's event page does not have in the first place.
    delete m.optional_permissions;
    m.permissions = m.permissions.filter(
      (p) => p !== 'declarativeNetRequest' && p !== 'offscreen');
  },
  chrome: (m) => {
    delete m.background.scripts;
    delete m.browser_specific_settings;   // Firefox's add-on id, meaningless here
    m.permissions = m.permissions.filter((p) => p !== 'webRequestBlocking');
  }
};

/*
 * Files that belong to one browser and not the other.
 *
 * Shipping Firefox an offscreen document, whose whole subject is a Chrome
 * API Firefox does not have, is shipping dead code to a reviewer who reads
 * every line of it and has to work out why it is there.
 */
const LEAVE_OUT = {
  firefox: ['offscreen.html', 'offscreen.js'],
  chrome: []
};

const asked = process.argv.slice(2).map((a) => a.replace(/^--/, ''));
const building = asked.length ? asked : Object.keys(TARGETS);
for (const target of building) {
  if (!TARGETS[target]) {
    console.error(`No such target: ${target}. Try ${Object.keys(TARGETS).join(' or ')}.`);
    process.exit(1);
  }
}

for (const target of building) {
  const tailored = JSON.parse(JSON.stringify(manifest));
  TARGETS[target](tailored);

  const out = join(DIST, `torval-${manifest.version}-${target}.zip`);
  if (existsSync(out)) unlinkSync(out);   // zip adds to an archive rather than replacing it

  // zip rather than a library, because every machine that can build this has
  // one, and an add-on package is a plain zip with no ceremony in it. -r is
  // recursive, -q quiet, -X drops the platform's own metadata, which has no
  // business in someone else's browser. The shared manifest is left out and
  // this target's written in over it, so neither browser ever sees a key
  // meant for the other, and 119 MB of dictionaries are not copied twice to
  // achieve it.
  execFileSync('zip',
    ['-r', '-q', '-X', out, '.', '-x', 'manifest.json'].concat(LEAVE_OUT[target] || []),
    { cwd: EXTENSION });
  const staged = join(DIST, `${target}-manifest.json`);
  writeFileSync(staged, JSON.stringify(tailored, null, 2) + '\n');
  execFileSync('cp', [staged, join(DIST, 'manifest.json')]);
  execFileSync('zip', ['-q', '-X', out, 'manifest.json'], { cwd: DIST });
  unlinkSync(join(DIST, 'manifest.json'));

  const size = statSync(out).size;
  console.log(`wrote ${out.replace(ROOT + '/', '')}, ${(size / 1024 / 1024).toFixed(1)} MB`);
  if (size > 100 * 1024 * 1024) {
    console.log('  (a large add-on: both stores accept it, but review takes longer)');
  }
}

if (building.includes('firefox')) {
  console.log('Firefox: https://addons.mozilla.org/developers/addon/submit/upload-listed');
  console.log('  (upload-unlisted instead to self-host it rather than list it on AMO.)');
}
if (building.includes('chrome')) {
  console.log('Chrome:  https://chrome.google.com/webstore/devconsole');
  console.log('  To load it unpacked for testing, unzip it: Chrome will not read');
  console.log('  extension/ directly, since that holds both browsers\' manifests at once.');
}
