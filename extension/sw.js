/*
 * Torval, the Chrome way in
 *
 * Firefox runs the background as an event page and is handed the list of
 * scripts in the manifest, in order. Chrome runs it as a service worker and
 * wants one file, so this is that file: the same list, in the same order,
 * loaded the one way a service worker can load anything.
 *
 * Nothing else belongs in here. Everything this pulls in is written to be
 * loaded by either browser, and none of it touches the DOM, which is what
 * makes running it in a worker possible at all; the one real difference
 * between the two, that Chrome stops a worker mid-import, is answered in
 * background.js by keepAwake.
 *
 * The order matters and is the same order as manifest.json's background
 * scripts: a language profile cannot register itself before lang.js exists,
 * and background.js asks for all of them.
 */

importScripts(
  'log.js',
  'track.js',
  'japanese.js',
  'scan.js',
  'italian.js',
  'italian-scan.js',
  'spanish.js',
  'spanish-scan.js',
  'english.js',
  'english-scan.js',
  'lang.js',
  'deinflect.js',
  'deinflect-latin.js',
  'deinflect-it.js',
  'deinflect-es.js',
  'deinflect-en.js',
  'lookup-common.js',
  'lookup.js',
  'lookup-latin.js',
  'anki.js',
  'pitch.js',
  'stress.js',
  'background.js'
);
