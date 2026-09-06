/*
 * LLL, the reader
 *
 * Opens an epub or a plain text file and shows it as an ordinary page, which
 * is the whole trick: this page loads LLL's own scripts, so hovering, the
 * popup, the marking and the comprehension bar all work on a book exactly as
 * they do on a website. Nothing here knows anything about dictionaries.
 *
 * A book is kept in the browser's storage so that closing the tab does not
 * lose your place. One book at a time, since a library is a different feature
 * from a reader and only one of them was asked for.
 *
 * Chapters are shown one at a time rather than as one long scroll. That is
 * what the spine of an epub says to do anyway, and it keeps the page short
 * enough that reading it end to end for a comprehension score takes a moment
 * rather than a minute.
 */

'use strict';

(function () {
  const api = globalThis.browser || globalThis.chrome;
  const KEY = 'book';
  const PLACE = 'bookAt';

  // Longest chapter shown in one go. Some epubs are a whole novel in a single
  // file, which is a page nobody wants to scroll and a lot to read through.
  const PART = 12000;

  const els = {
    title: document.getElementById('title'),
    chapters: document.getElementById('chapters'),
    prev: document.getElementById('prev'),
    next: document.getElementById('next'),
    file: document.getElementById('book'),
    page: document.getElementById('page'),
    empty: document.getElementById('empty'),
    trouble: document.getElementById('trouble')
  };

  let book = null;
  let showing = 0;   // which chapter, kept here rather than in the book

  start();

  async function start() {
    els.file.addEventListener('change', () => {
      if (els.file.files[0]) load(els.file.files[0]);
      els.file.value = '';
    });
    els.chapters.addEventListener('change', () => show(Number(els.chapters.value)));
    els.prev.addEventListener('click', () => show(showing - 1));
    els.next.addEventListener('click', () => show(showing + 1));

    document.addEventListener('dragover', (e) => {
      e.preventDefault();
      document.body.classList.add('dropping');
    });
    document.addEventListener('dragleave', () => document.body.classList.remove('dropping'));
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('dropping');
      const file = e.dataTransfer.files[0];
      if (file) load(file);
    });

    const stored = await api.storage.local.get([KEY, PLACE]);
    if (stored && stored[KEY]) {
      book = stored[KEY];
      show(stored[PLACE] || 0);
    }
  }

  async function load(file) {
    say('Reading ' + file.name + '…');
    try {
      const isEpub = /\.epub$/i.test(file.name) || file.type === 'application/epub+zip';
      const read = isEpub ? await readEpub(file) : await readText(file);
      if (!read.chapters.length) throw new Error('There is no text in that file.');
      book = { title: read.title || file.name, chapters: read.chapters };
      await api.storage.local.set({ [KEY]: book, [PLACE]: 0 }).catch(tooBig);
      show(0);
    } catch (err) {
      say(err.message, true);
    }
  }

  // -------------------------------------------------------------------------
  // Showing it
  // -------------------------------------------------------------------------

  function show(index) {
    if (!book) return;
    const at = Math.max(0, Math.min(book.chapters.length - 1, index));
    const chapter = book.chapters[at];
    showing = at;

    els.page.textContent = '';
    if (chapter.title) {
      const heading = document.createElement('h2');
      heading.textContent = chapter.title;
      els.page.appendChild(heading);
    }
    for (const paragraph of chapter.paragraphs) {
      const p = document.createElement('p');
      p.textContent = paragraph;
      els.page.appendChild(p);
    }

    els.title.textContent = book.title;
    els.empty.hidden = true;
    els.chapters.hidden = book.chapters.length < 2;
    els.prev.hidden = els.next.hidden = book.chapters.length < 2;
    els.prev.disabled = at === 0;
    els.next.disabled = at === book.chapters.length - 1;

    if (els.chapters.childElementCount !== book.chapters.length) {
      els.chapters.textContent = '';
      book.chapters.forEach((c, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = (i + 1) + '. ' + (c.title || 'Section ' + (i + 1));
        els.chapters.appendChild(option);
      });
    }
    els.chapters.value = String(at);

    window.scrollTo(0, 0);
    // Only the place, not the book. A novel is a few megabytes, and writing
    // all of it out again to record that you turned a page is a lot of work
    // to record one number.
    api.storage.local.set({ [PLACE]: at }).catch(() => {});
    // The page has been replaced, so whatever was measured and marked on it
    // belongs to the last chapter. content.js listens for this.
    document.dispatchEvent(new CustomEvent('lll-reread'));
  }

  function say(text, bad) {
    els.empty.hidden = false;
    els.trouble.className = bad ? 'note error' : 'note';
    els.trouble.textContent = text;
  }

  // A long book is a few megabytes, which is what unlimitedStorage is for.
  // If it will not fit anyway, the book still reads; it just will not be
  // there tomorrow.
  function tooBig() {
    say('That book is too big to remember, but it will read fine now.', true);
  }

  // -------------------------------------------------------------------------
  // Plain text
  // -------------------------------------------------------------------------

  async function readText(file) {
    const text = await file.text();
    const paragraphs = text.split(/\n\s*\n|\r\n\s*\r\n/)
      .map((p) => p.replace(/\s*\n\s*/g, '').trim())
      .filter(Boolean);
    return { title: file.name.replace(/\.[^.]+$/, ''), chapters: split(paragraphs, '') };
  }

  // -------------------------------------------------------------------------
  // Epub
  // -------------------------------------------------------------------------

  /**
   * An epub is a zip of XHTML files plus a list saying what order to read them
   * in. Read that list, take the text out of each file in turn, and there is
   * the book. Everything else in there, the styling, the fonts, the pictures,
   * is not what this page is for.
   */
  async function readEpub(file) {
    const files = await unzip(await file.arrayBuffer());

    const container = await xml(files, 'META-INF/container.xml');
    const rootPath = container && container.querySelector('rootfile');
    const opfPath = rootPath && rootPath.getAttribute('full-path');
    if (!opfPath) throw new Error('That epub has no table of contents in it.');

    const opf = await xml(files, opfPath);
    const base = opfPath.replace(/[^/]+$/, '');

    const titleEl = opf.querySelector('metadata title, title');
    const title = titleEl ? titleEl.textContent.trim() : '';

    const hrefs = new Map();
    for (const item of opf.querySelectorAll('manifest item')) {
      hrefs.set(item.getAttribute('id'), item.getAttribute('href'));
    }

    const chapters = [];
    for (const ref of opf.querySelectorAll('spine itemref')) {
      const href = hrefs.get(ref.getAttribute('idref'));
      if (!href) continue;
      const page = await xml(files, resolve(base, href), 'text/html');
      if (!page) continue;
      const found = paragraphsOf(page);
      if (!found.paragraphs.length) continue;
      for (const part of split(found.paragraphs, found.title)) chapters.push(part);
    }
    return { title, chapters };
  }

  /** Pull the readable text out of one page of a book. */
  function paragraphsOf(doc) {
    // Ruby is furigana: the reading printed above the kanji. Left in, every
    // word would arrive with its own reading glued to it, so 食べる would
    // come out as 食た べる and match nothing at all.
    for (const el of doc.querySelectorAll('rt, rp, script, style')) el.remove();

    const heading = doc.querySelector('h1, h2, h3');
    const blocks = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, dd');
    let paragraphs = [...blocks]
      .map((el) => el.textContent.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    // A page built entirely out of bare <div>s or <br>s has no blocks to find.
    if (!paragraphs.length && doc.body) {
      paragraphs = doc.body.textContent.split('\n').map((line) => line.trim()).filter(Boolean);
    }

    const title = heading ? heading.textContent.replace(/\s+/g, ' ').trim() : '';
    // The heading is shown separately, so it should not also be the first line.
    if (title && paragraphs[0] === title) paragraphs.shift();
    return { title, paragraphs };
  }

  /** One chapter, cut into parts short enough to read and to measure. */
  function split(paragraphs, title) {
    const parts = [];
    let current = [];
    let length = 0;
    for (const paragraph of paragraphs) {
      current.push(paragraph);
      length += paragraph.length;
      if (length >= PART) { parts.push(current); current = []; length = 0; }
    }
    if (current.length) parts.push(current);
    return parts.map((group, i) => ({
      title: parts.length > 1 ? (title ? title + ' (' + (i + 1) + ')' : '') : title,
      paragraphs: group
    }));
  }

  function resolve(base, href) {
    const path = base + decodeURIComponent(href).replace(/[#?].*$/, '');
    const out = [];
    for (const piece of path.split('/')) {
      if (piece === '.' || piece === '') continue;
      if (piece === '..') out.pop();
      else out.push(piece);
    }
    return out.join('/');
  }

  async function xml(files, path, as) {
    const entry = files.get(path);
    if (!entry) return null;
    const text = new TextDecoder().decode(await inflate(entry));
    return new DOMParser().parseFromString(text, as || 'application/xml');
  }

  // -------------------------------------------------------------------------
  // Zip
  // -------------------------------------------------------------------------

  /**
   * Just enough of the zip format to find the files and their bytes: walk the
   * central directory at the end, and note where each file's data starts.
   * The browser does the actual decompressing.
   */
  async function unzip(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    let end = buffer.byteLength - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
    if (end < 0) throw new Error('That file is not an epub.');

    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const files = new Map();

    for (let i = 0; i < count && at + 46 <= buffer.byteLength; i++) {
      const method = view.getUint16(at + 10, true);
      const size = view.getUint32(at + 20, true);
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const localAt = view.getUint32(at + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));

      // The local header repeats the name and its extra fields at its own
      // lengths, which are not always the ones the directory gives.
      const start = localAt + 30 +
        view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
      files.set(name, { method, body: bytes.subarray(start, start + size) });

      at += 46 + nameLength + extraLength + commentLength;
    }
    return files;
  }

  async function inflate(entry) {
    if (entry.method === 0) return entry.body;
    if (entry.method !== 8) throw new Error('That epub is packed in a way LLL cannot open.');
    const stream = new Blob([entry.body]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
})();
