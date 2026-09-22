/*
 * Torval, settings
 *
 * Two things live here and they have nothing to do with each other: where
 * cards go, and which words you already know. They are tabs rather than one
 * long page because scrolling past the whole of Anki's field mapping to reach
 * your word list is not a way to find anything.
 *
 * Deck and note type are read live from Anki rather than typed, so a name can
 * never be slightly wrong. The field mapping is offered pre-filled by guessing
 * from the field names; anything guessed wrongly is one dropdown away.
 *
 * The known words tab is known.js; only the switching between them is here.
 */

'use strict';

const api = globalThis.browser || globalThis.chrome;

// -------------------------------------------------------------------------
// Tabs
// -------------------------------------------------------------------------

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showPanel(tab.dataset.panel));
}

function showPanel(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('current', tab.dataset.panel === name);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.hidden = panel.id !== 'panel-' + name;
  }
}

// A name after the # opens that page, which is what makes the word list
// linkable rather than only reachable by clicking. #known still works, since
// that is what the page was called when anything started linking to it.
const asked = (location.hash || '').slice(1);
showPanel(asked === 'known' ? 'words'
  : document.getElementById('panel-' + asked) ? asked : 'anki');

/*
 * Opened to be shown one switch.
 *
 * Chrome will not let a permission be asked for anywhere but a click on one
 * of the add-on's own pages, so the popup cannot ask; the most it can do is
 * send somebody here. Landing them on a page of six tabs and leaving them
 * to find it would waste the trip, so the panel opens, the row is scrolled
 * to, and it is marked for a few seconds.
 *
 * Both ways in, because openOptionsPage does not always open anything: with
 * this page already sitting in a tab it focuses that tab and nothing
 * reloads, so nothing reads storage and the trip ends on whichever panel
 * was last open. That is what it did, and Words is where it starts.
 */
api.storage.local.get('showOnOpen')
  .then((stored) => pointAt(stored && stored.showOnOpen))
  .catch(() => {});

if (api.storage.onChanged) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.showOnOpen) return;
    pointAt(changes.showOnOpen.newValue);
  });
}

function pointAt(wanted) {
  if (!wanted) return;
  // Taken out as it is read: one trip's worth of instruction, not a
  // setting, and it must not fire again on the next visit.
  api.storage.local.remove('showOnOpen').catch(() => {});

  const row = document.getElementById(wanted);
  if (!row) return;
  const panel = row.closest('.panel');
  if (panel) showPanel(panel.id.replace(/^panel-/, ''));

  const marked = row.closest('label') || row;
  marked.scrollIntoView({ block: 'center' });
  marked.classList.add('pointed');
  setTimeout(() => marked.classList.remove('pointed'), 4000);
}

// -------------------------------------------------------------------------
// Anki
// -------------------------------------------------------------------------

// 'pitch' and 'stress' are the same idea answered differently (a diagram
// for Japanese, an inline mark for Italian and Spanish), so only whichever
// matches the active language is ever offered; a note type has no use for
// the other one. Which one a language wants is on its profile, so a new
// language says so once, in lang.js, rather than here as well.
const SOURCE_LABELS_BASE = [
  ['', ', '],
  ['word', 'Target word'],
  ['reading', 'Reading'],
  ['sentence', 'Sentence'],
  ['definition', 'Definition'],
  ['audio', 'Word audio'],
  ['image', 'Video frame'],
  ['sentenceAudio', 'Sentence audio'],
  ['sentenceBefore', 'Sentence before'],
  ['sentenceAfter', 'Sentence after']
];

function sourceLabels() {
  const profile = TorvalLang.profile();
  const extra = profile.accent === 'stress'
    ? [['stress', 'Word stress']]
    : [['pitch', 'Pitch accent']];
  // Word audio only where there is a recording to be had. See the note on
  // `audio` in lang.js.
  const base = profile.audio
    ? SOURCE_LABELS_BASE
    : SOURCE_LABELS_BASE.filter(([source]) => source !== 'audio');
  return base.concat(extra);
}

// -------------------------------------------------------------------------
// Language
// -------------------------------------------------------------------------

const languageSelect = document.getElementById('language');

function fillLanguages() {
  languageSelect.textContent = '';
  for (const { code, name } of TorvalLang.list()) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = name;
    if (code === TorvalLang.active()) option.selected = true;
    languageSelect.appendChild(option);
  }
}

/*
 * The placeholders on this page are words, and a word is in one language.
 * 日本語のテキストをここに貼り付けてください is not a prompt to somebody
 * reading Spanish, it is a line of a script they may well not read at all.
 * Each language brings its own, from its profile in lang.js, for the same
 * reason the Anki source list brings its own pitch/stress row.
 */
function fillExamples() {
  const example = TorvalLang.profile().examples;
  if (!example) return;
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.placeholder = value;
  };
  set('text', example.paste);
  set('search', example.known);
  set('search-ignored', example.ignored);
  const kinds = document.getElementById('ignored-kinds');
  if (kinds) kinds.textContent = example.ignoredKinds;
}

fillExamples();

if (languageSelect) {
  fillLanguages();
  languageSelect.addEventListener('change', () => { TorvalLang.set(languageSelect.value); });
  // Fires for this select's own change too (TorvalLang.set applies synchronously
  // before its storage write settles), as well as a switch made from the
  // toolbar popup or this same page in another tab, so there is exactly one
  // place that reloads the Anki panel rather than two racing each other.
  TorvalLang.onChange(() => { fillLanguages(); fillExamples(); load(); });
}

// The chosen file’s name, said in the page’s own type. The browser will not
// show it once its own control is out of the way, and a file picker that says
// nothing after you have picked something is a file picker you press twice.
for (const input of document.querySelectorAll('input[type="file"]')) {
  const beside = input.parentElement.querySelector('.picked');
  if (!beside) continue;
  const idle = beside.textContent;
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    beside.textContent = file ? file.name : idle;
    beside.classList.toggle('chosen', !!file);
  });
}

const deckSelect = document.getElementById('deck');
const modelSelect = document.getElementById('model');
const tagsInput = document.getElementById('tags');
const leadInput = document.getElementById('lead');

const mappingBox = document.getElementById('mapping');
const mappingSection = document.getElementById('mapping-section');
const statusText = document.getElementById('status');

let config = {};

// The deck/note-type/field-mapping listeners only ever need setting up once;
// load() itself is re-entrant now, called again on every language switch, so
// setting these up inside it would pile up a duplicate set per switch.
deckSelect.addEventListener('change', () => { config.deck = deckSelect.value; });
modelSelect.addEventListener('change', () => { config.fields = {}; showFields(); });
document.getElementById('save').addEventListener('click', save);

load();

/** The Anki config for whichever language is active right now. */
function ankiConfigKey() { return 'ankiConfig' + TorvalLang.profile().storageSuffix; }

async function load() {
  const stored = await api.storage.local.get(ankiConfigKey());
  config = stored[ankiConfigKey()] || { fields: {} };
  tagsInput.value = (config.tags || []).join(', ');
  leadInput.value = typeof config.lead === 'number' ? config.lead : '';

  const reply = await api.runtime.sendMessage({ type: 'ankiDescribe', url: config.url });
  if (!reply.ok) return fail(reply.error);

  fill(deckSelect, reply.result.decks, config.deck);
  fill(modelSelect, reply.result.models, config.model);
  await showFields();
}

function fill(select, values, chosen) {
  select.textContent = '';
  for (const value of values) {
    const option = document.createElement('option');
    option.value = option.textContent = value;
    if (value === chosen) option.selected = true;
    select.appendChild(option);
  }
}

async function showFields() {
  const model = modelSelect.value;
  if (!model) return;

  const reply = await api.runtime.sendMessage({ type: 'ankiFields', url: config.url, model });
  if (!reply.ok) return fail(reply.error);

  const names = reply.result;
  // Keep whatever was already chosen for this note type; guess the rest.
  const existing = config.fields || {};
  const known = names.some((n) => existing[n] !== undefined);
  const mapping = known ? existing : TorvalAnki.guessMapping(names);

  mappingBox.textContent = '';
  for (const name of names) {
    const row = document.createElement('label');
    const label = document.createElement('span');
    label.textContent = name;

    const select = document.createElement('select');
    select.dataset.field = name;
    for (const [value, text] of sourceLabels()) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      if (value === (mapping[name] || '')) option.selected = true;
      select.appendChild(option);
    }

    row.append(label, select);
    mappingBox.appendChild(row);
  }
  mappingSection.hidden = false;
}

async function save() {
  const fields = {};
  for (const select of mappingBox.querySelectorAll('select')) {
    fields[select.dataset.field] = select.value;
  }
  config = {
    url: config.url,
    deck: deckSelect.value,
    model: modelSelect.value,
    tags: tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean),
    // Left out entirely when the box is empty, so that "no answer" stays
    // the recorder's own default rather than becoming zero.
    lead: leadInput.value === '' ? undefined : Math.max(0, Math.min(3, Number(leadInput.value) || 0)),
    fields
  };
  await api.storage.local.set({ [ankiConfigKey()]: config });
  statusText.textContent = 'Saved.';
  statusText.className = '';
  setTimeout(() => { statusText.textContent = ''; }, 2000);
}

function fail(message) {
  statusText.textContent = message;
  statusText.className = 'error';
}

// The version on the About page comes from the manifest rather than being
// typed here as well, so there is one place it can be wrong.
const versionEl = document.getElementById('version');
if (versionEl && api.runtime.getManifest) {
  versionEl.textContent = api.runtime.getManifest().version;
}

// The reader is a page rather than a panel, since it is a place to be
// rather than a setting to change.
const reader = document.getElementById('open-reader');
if (reader) {
  reader.addEventListener('click', () => {
    const url = api.runtime.getURL('reader.html');
    if (api.tabs && api.tabs.create) api.tabs.create({ url });
    else window.open(url, '_blank');
  });
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

/*
 * Every key Torval answers to, listed from keys.js rather than written out
 * again here. Click one and it listens for the next key you press.
 *
 * One row is one label and one button, and every button is the same
 * button. The held key cycles through its three rather than being a
 * dropdown: holding a letter is not something a keyboard reports, so it
 * cannot be captured the way the others are, and a select box among six
 * buttons sat at a different height and broke the column.
 */
const shortcutList = document.getElementById('shortcuts');
const keysStatus = document.getElementById('keys-status');

// Which row is waiting for a key, if any.
let listening = null;

function sayAboutKeys(message, bad) {
  if (!keysStatus) return;
  keysStatus.textContent = message;
  keysStatus.className = bad ? 'error' : '';
  if (message && !bad) setTimeout(() => { keysStatus.textContent = ''; }, 2000);
}

function drawShortcuts() {
  if (!shortcutList) return;
  listening = null;
  shortcutList.textContent = '';

  for (const action of TorvalKeys.all()) {
    const row = document.createElement('div');
    row.className = 'shortcut';
    row.appendChild(Object.assign(document.createElement('span'), {
      className: 'shortcut-what', textContent: action.label
    }));
    row.appendChild(keyButton(action));
    shortcutList.appendChild(row);
  }
}

function keyButton(action) {
  const button = document.createElement('button');
  button.className = 'shortcut-key' + (action.isDefault ? '' : ' changed');
  button.textContent = TorvalKeys.label(action.key);
  button.title = action.hold ? 'Click to change it' : 'Click, then press a key';
  button.addEventListener('click', () => {
    if (action.hold) return cycleHeld(action);
    if (listening && listening.button === button) return stopListening();
    stopListening();
    listening = { action, button };
    button.textContent = 'press a key';
    button.classList.add('listening');
    sayAboutKeys('');
  });
  return button;
}

/** Shift, then Alt, then Control, then round again. */
async function cycleHeld(action) {
  const choices = action.choices;
  const next = choices[(choices.indexOf(action.key) + 1) % choices.length];
  const taken = TorvalKeys.clash(action.name, next);
  if (taken) return sayAboutKeys(next + ' is already ' + taken.toLowerCase() + '.', true);
  await TorvalKeys.set(action.name, next);
  drawShortcuts();
  sayAboutKeys('Saved.');
}

function stopListening() {
  if (!listening) return;
  const { action, button } = listening;
  listening = null;
  button.classList.remove('listening');
  button.textContent = TorvalKeys.label(action.key);
}

/*
 * Captured on the way down and taken away from the page, so that pressing
 * a key to set it does not also do whatever that key does on this page.
 */
document.addEventListener('keydown', async (e) => {
  if (!listening) return;
  e.preventDefault();
  e.stopPropagation();

  const { action } = listening;
  if (e.key === 'Escape') return stopListening();

  if (!TorvalKeys.usable(e.key, { name: action.name })) {
    stopListening();
    return sayAboutKeys('That one cannot be a shortcut. Try a letter or a number.', true);
  }

  const taken = TorvalKeys.clash(action.name, e.key);
  if (taken) {
    stopListening();
    return sayAboutKeys(TorvalKeys.label(e.key) + ' is already ' + taken.toLowerCase() + '.', true);
  }

  await TorvalKeys.set(action.name, e.key);
  drawShortcuts();
  sayAboutKeys('Saved.');
}, true);

const resetKeys = document.getElementById('reset-keys');
if (resetKeys) {
  resetKeys.addEventListener('click', async () => {
    await TorvalKeys.reset();
    drawShortcuts();
    sayAboutKeys('Back to the defaults.');
  });
}

// Drawn once storage has answered, so the page never shows a default for a
// moment and then replaces it with what was actually saved.
if (shortcutList) TorvalKeys.ready().then(drawShortcuts);


// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

/*
 * How fast the quiet parts go. One number, saved as it is typed, because a
 * Save button for a single field is a button you forget to press.
 */
const skipSpeed = document.getElementById('skip-speed');
if (skipSpeed) {
  api.storage.local.get('skipSpeed')
    .then((stored) => { if (typeof stored.skipSpeed === 'number') skipSpeed.value = stored.skipSpeed; })
    .catch(() => {});

  skipSpeed.addEventListener('change', () => {
    const asked = parseFloat(skipSpeed.value);
    if (!isFinite(asked)) return api.storage.local.remove('skipSpeed').catch(() => {});
    const speed = Math.max(1.25, Math.min(8, asked));
    skipSpeed.value = speed;
    api.storage.local.set({ skipSpeed: speed }).catch(() => {});
  });
}

// Which key it actually is, rather than the one it shipped as, since it can
// be changed on the Keys page next door.
const skipKey = document.getElementById('skip-key');
if (skipKey) TorvalKeys.ready().then(() => { skipKey.textContent = TorvalKeys.label(TorvalKeys.get('skip')); });


// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

/*
 * The four settings from look.js, grouped under the two things they are
 * about. Drawn from that table rather than written out again here, so a
 * setting that is added, renamed or given another choice cannot end up
 * described one way in the code and another way on this page.
 *
 * Saved the moment a choice is clicked, with no Save button: every one of
 * these is a single value with an immediate, visible effect on the video
 * or the popup you are about to go back to, and a Save button for that is
 * a button you forget to press.
 */
const appearance = document.getElementById('appearance');
const lookStatus = document.getElementById('look-status');

function sayAboutLook(message) {
  if (!lookStatus) return;
  lookStatus.textContent = message;
  if (message) setTimeout(() => { lookStatus.textContent = ''; }, 2000);
}

function drawAppearance() {
  if (!appearance) return;
  appearance.textContent = '';

  const settings = TorvalLook.all();
  for (const where of TorvalLook.groups()) {
    const section = document.createElement('section');
    section.appendChild(Object.assign(document.createElement('h2'), {
      textContent: where
    }));
    for (const setting of settings.filter((s) => s.where === where)) {
      section.appendChild(lookRow(setting));
    }
    appearance.appendChild(section);
  }
}

function lookRow(setting) {
  const row = document.createElement('div');
  row.className = 'look-row';
  row.appendChild(Object.assign(document.createElement('span'), {
    textContent: setting.label
  }));

  const choices = document.createElement('div');
  choices.className = 'look-choices';
  for (const choice of setting.choices) {
    const button = document.createElement('button');
    button.className = 'look-choice' + (choice.value === setting.value ? ' on' : '');
    button.textContent = choice.label;
    button.addEventListener('click', async () => {
      if (choice.value === setting.value) return;
      await TorvalLook.set(setting.name, choice.value);
      drawAppearance();
      sayAboutLook('Saved.');
    });
    choices.appendChild(button);
  }
  row.appendChild(choices);
  return row;
}

const resetLook = document.getElementById('reset-look');
if (resetLook) {
  resetLook.addEventListener('click', async () => {
    await TorvalLook.reset();
    drawAppearance();
    sayAboutLook('Back to the defaults.');
  });
}

// Drawn once storage has answered, so the page never shows a default for a
// moment and then replaces it with what was actually saved.
if (appearance) TorvalLook.ready().then(drawAppearance);


// ---------------------------------------------------------------------------
// The dictionary
// ---------------------------------------------------------------------------

/*
 * How far through opening the dictionary, where somebody can see it.
 *
 * The first choice of language copies 218,000 entries into the browser's own
 * database, and that takes about a minute. The only place that said so was
 * the handle in the corner of a web page, which is not where somebody who
 * has just answered the question on this page is looking; from here the
 * whole thing looked like nothing happening.
 */
const dictionaryNote = document.getElementById('dictionary');
if (dictionaryNote) watchDictionary();

async function watchDictionary() {
  for (;;) {
    let state = null;
    try {
      const reply = await api.runtime.sendMessage({ type: 'status' });
      state = reply && reply.status;
    } catch (err) { /* the background is asleep, or starting up */ }
    // Often while it is working, rarely once it is not. A language can be
    // changed from this very page, so the slow poll has to keep going.
    await pause(paintDictionary(state) ? 500 : 4000);
  }
}

/** Draws it, and answers whether there is still something to watch. */
function paintDictionary(state) {
  const how = state && state.state;
  const busy = how === 'starting' || how === 'loading';

  if (busy) {
    const percent = Math.round((state.progress || 0) * 100);
    dictionaryNote.textContent = percent
      ? 'Building the dictionary, ' + percent + '%'
      : 'Building the dictionary…';
  } else if (how === 'error') {
    dictionaryNote.textContent = state.message || 'The dictionary did not open.';
  } else {
    dictionaryNote.textContent = '';
  }

  dictionaryNote.className = 'sidebar-note' + (how === 'error' ? ' error' : '');
  dictionaryNote.hidden = !dictionaryNote.textContent;
  return busy;
}

function pause(ms) {
  return new Promise((done) => setTimeout(done, ms));
}


// ---------------------------------------------------------------------------
// Keeping score, or not
// ---------------------------------------------------------------------------

/*
 * The switch that decides whether Torval is a dictionary or a dictionary
 * that keeps a record of you. See track.js for why it is off until asked
 * for, and for why an install that already has words keeps it on.
 *
 * Everything else on this panel is about lists that only exist when it is
 * on, so it all goes away with it rather than sit there being about
 * nothing. The switch itself stays, because a tab that empties completely
 * would leave nowhere to turn it back on from.
 */
const track = document.getElementById('track');
const wordsRest = document.getElementById('words-rest');

if (track && wordsRest) {
  paintTrack(TorvalTrack.on());
  TorvalTrack.ready().then(paintTrack);
  TorvalTrack.onChange(paintTrack);
  track.addEventListener('change', () => TorvalTrack.set(track.checked));
}

function paintTrack(on) {
  track.checked = !!on;
  wordsRest.hidden = !on;
}


// ---------------------------------------------------------------------------
// Recording a copy-protected video's sound
// ---------------------------------------------------------------------------

/*
 * The one thing in Torval that works in one browser and not the other, so
 * it says which and why rather than looking broken.
 *
 * Chrome can hand an extension the sound coming out of a tab, which is the
 * only way to get a copy-protected video's audio: asking the video element
 * for a stream of it gets an empty one. Firefox cannot. It has no tabCapture
 * API, and its getDisplayMedia ignores `audio` without an error, which is
 * bug 1541425, filed in 2019 and still open. There is nothing to fall back
 * on and nothing to work around.
 *
 * Permission is asked for here and nowhere else, at the moment somebody
 * ticks the box. Nothing is requested on a fresh install, and nothing is
 * requested by watching a video: YouTube's sound comes off the element and
 * always has, which is the ordinary case and wants none of this.
 */
const tabAudio = document.getElementById('tab-audio');
const tabAudioNote = document.getElementById('tab-audio-note');

if (tabAudio && tabAudioNote) {
  paintTabAudio();

  tabAudio.addEventListener('change', async () => {
    const wanted = tabAudio.checked;
    try {
      if (wanted) await api.permissions.request({ permissions: ['tabCapture'] });
      else await api.permissions.remove({ permissions: ['tabCapture'] });
    } catch (err) { /* refused, or asked for from somewhere it may not be */ }
    // Never from what was clicked: a request can be declined, and a box
    // that stays ticked after a refusal is a promise the browser did not
    // make. What is actually held is the only thing worth showing.
    paintTabAudio();
  });
}

async function paintTabAudio() {
  let state = { can: false, granted: false };
  try {
    const reply = await api.runtime.sendMessage({ type: 'tabAudioReady' });
    if (reply && reply.ok) state = reply.result;
  } catch (err) { /* the background is still waking up */ }

  tabAudio.checked = !!state.granted;
  // A box that cannot be ticked is worse than no box: it invites somebody
  // to keep trying. Where the browser cannot do this at all, only the line
  // saying so is left.
  const row = document.getElementById('tab-audio-row');
  if (row) row.hidden = !state.can;
  tabAudioNote.textContent = state.can
    ? 'The line is played back as it is recorded, so you hear what you are getting.'
    : 'Recording a tab needs Chrome. Firefox has no way to do it, so cards ' +
      'from a copy-protected video are made here without their sound.';
}


// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

/*
 * Whether Torval narrates itself. Off by default, because the console
 * belongs to the page and most of what it would say is a step failing on
 * the way to a step succeeding. On, it is the first thing to ask for when
 * somebody reports that a video's subtitles never arrived. See log.js.
 */
const verbose = document.getElementById('verbose');
if (verbose) {
  api.storage.local.get('verboseLog')
    .then((stored) => { verbose.checked = !!stored.verboseLog; })
    .catch(() => {});
  verbose.addEventListener('change', () => TorvalLog.verbose(verbose.checked));
}


// ---------------------------------------------------------------------------
// A fresh install
// ---------------------------------------------------------------------------

/*
 * Until somebody says which language they are reading, that is the only
 * question this page asks. Everything else here is about a language, and
 * Torval itself does nothing at all in the meantime, so a settings page
 * offering to configure Anki for a language that does not exist yet is
 * offering to configure nothing.
 *
 * The background script opens this page on install for exactly this. Once
 * the choice is made the page turns into the ordinary settings page,
 * without a reload: TorvalLang tells everything that is listening, which
 * on this page means the panels come back and on every open tab means
 * Torval starts working.
 */
const firstPanel = document.getElementById('panel-first');
const firstChoices = document.getElementById('first-languages');
const layout = document.querySelector('.layout');

function askFirst() {
  const asking = !TorvalLang.picked();
  document.querySelector('.sidebar').hidden = asking;
  if (asking) drawFirstChoices();
  // showPanel hides every panel but the named one, this one included, so
  // it is the whole of both directions: into the question, and out of it
  // once the question has been answered. On an ordinary load the first
  // panel is already hidden and the panel the address asked for is left
  // exactly as it was.
  if (asking) showPanel('first');
  else if (!firstPanel.hidden) showPanel('anki');
  // Drawn only now, so a fresh install never shows a flash of the settings
  // it is not ready to have.
  layout.classList.add('settled');
}

function drawFirstChoices() {
  // Redrawn rather than built once, since which languages exist is
  // TorvalLang's to know and this page should not keep a copy.
  firstChoices.textContent = '';
  for (const { code, name } of TorvalLang.list()) {
    const button = document.createElement('button');
    button.className = 'first-choice';
    button.textContent = name;
    button.addEventListener('click', () => TorvalLang.set(code));
    firstChoices.appendChild(button);
  }
}

if (firstPanel) {
  TorvalLang.onChange(askFirst);
  TorvalLang.ready().then(askFirst);
}


// ---------------------------------------------------------------------------
// Dictionaries
// ---------------------------------------------------------------------------

/*
 * What Torval has to read with, and what it is costing.
 *
 * Every language ships a dictionary and none of them is in the browser until
 * it is put there, so there are two questions about each one: what it
 * contains, which is true of the package, and whether this machine is
 * carrying it, which is the only part anybody can do anything about.
 *
 * Hence one switch per dictionary. Off throws the database away; on reads it
 * back in there and then rather than waiting until the language is next
 * chosen, because a switch whose effect you cannot see is a switch nobody
 * believes. Nothing is lost either way: the dictionary itself is in the
 * package, and this is only about the copy unpacked into the browser.
 *
 * The language being read cannot be switched off. Deleting the database the
 * lookups are running against would take the page down, and choosing another
 * language first is the whole of the cure.
 */

const dictList = document.getElementById('dict-list');
const dictNote = document.getElementById('dict-note');
let dictBusy = false;

function countOf(n) {
  return typeof n === 'number' ? n.toLocaleString() : '';
}

/** A build date as a person would write it, or the raw string if it will not parse. */
function dayOf(text) {
  if (!text) return '';
  const when = new Date(text + 'T00:00:00');
  if (isNaN(when.getTime())) return text;
  return when.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function whereItStands(dict) {
  if (dict.building !== null && dict.building !== undefined) {
    return 'Reading it in, ' + Math.round(dict.building * 100) + '%…';
  }
  if (dict.active) return 'The language you are reading.';
  if (dict.stale) return 'An older copy, replaced next time you choose it.';
  if (dict.ready) return 'In this browser.';
  if (dict.here) return 'Half read in.';
  return 'Not in this browser.';
}

/** Italian and Spanish come from the same places, so they share a list. */
function sourcesFor(code) {
  return document.getElementById('sources-' + (code === 'es' ? 'it' : code));
}

function dictionaryCard(dict) {
  const section = document.createElement('section');

  const title = document.createElement('h2');
  title.textContent = dict.name;
  section.appendChild(title);

  const keep = document.createElement('label');
  keep.className = 'check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = dict.here;
  box.disabled = dictBusy || dict.active;
  const what = document.createElement('span');
  what.textContent = 'Keep in this browser';
  keep.appendChild(box);
  keep.appendChild(what);
  box.addEventListener('change', () => keepDictionary(dict.code, box.checked));
  section.appendChild(keep);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = whereItStands(dict) + (dict.entries
    ? ' ' + countOf(dict.entries) + ' entries, ' + countOf(dict.terms) +
      ' forms, built ' + dayOf(dict.built) + '.'
    : ' Not built into this copy of Torval.');
  section.appendChild(hint);

  const made = sourcesFor(dict.code);
  if (made) {
    const of = document.createElement('p');
    of.className = 'note';
    of.appendChild(made.content.cloneNode(true));
    section.appendChild(of);
  }

  return section;
}

async function keepDictionary(code, keep) {
  dictBusy = true;
  sayAboutDictionaries(keep ? 'Reading it in. This takes a minute.' : '');
  await paintDictionaries();
  try {
    const reply = await api.runtime.sendMessage({ type: 'keepDictionary', code, keep });
    if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'It would not budge.');
    sayAboutDictionaries('');
  } catch (err) {
    sayAboutDictionaries(err.message, true);
  }
  dictBusy = false;
  await paintDictionaries();
}

function sayAboutDictionaries(text, wrong) {
  if (!dictNote) return;
  dictNote.textContent = text || '';
  dictNote.className = 'note' + (wrong ? ' error' : '');
  dictNote.hidden = !text;
}

async function paintDictionaries() {
  if (!dictList) return;
  let dicts = null;
  try {
    const reply = await api.runtime.sendMessage({ type: 'dictionaries' });
    if (reply && reply.ok) dicts = reply.result;
  } catch (err) { /* the background is asleep; the list stands as it was */ }
  if (!dicts) return;

  dictList.textContent = '';
  for (const dict of dicts) dictList.appendChild(dictionaryCard(dict));
  return dicts.some((d) => d.building !== null && d.building !== undefined);
}

/** While one is being read in, often; the rest of the time, not at all. */
async function watchDictionaries() {
  for (;;) {
    const working = await paintDictionaries();
    if (!working && !dictBusy) return;
    await pause(600);
  }
}

if (dictList) {
  paintDictionaries().then((working) => { if (working) watchDictionaries(); });
  // The language can be changed from the sidebar of this very page, and it
  // moves which dictionary is the one in use.
  TorvalLang.onChange(() => { paintDictionaries(); });
  for (const tab of document.querySelectorAll('.tab[data-panel="about"]')) {
    tab.addEventListener('click', () => paintDictionaries());
  }
}
