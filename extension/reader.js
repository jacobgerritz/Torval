/*
 * Torval, the reader
 *
 * Opens epub and plain text files and shows them as ordinary pages, which is
 * the whole trick: this page loads Torval's own scripts, so hovering, the popup,
 * the marking and the comprehension bar all work on a book exactly as they do
 * on a website. Nothing here knows anything about dictionaries.
 *
 * Books are kept in the browser's storage, with the shelf as the front page:
 * what you have, and how much of each you would understand, before you decide
 * what to read. The estimate is taken from a sample spread through the book
 * rather than from the whole of it, since the whole of a novel is a minute of
 * reading and the answer would not change.
 *
 * Chapters are shown one at a time rather than as one long scroll. That is
 * what the spine of an epub says to do anyway, and it keeps the page short
 * enough that reading it end to end for a comprehension score takes a moment.
 */

'use strict';

(function () {
  const api = globalThis.browser || globalThis.chrome;
  const BOOKS = 'books';        // everything on the shelf
  const PLACE = 'bookPlace';    // where you were in each of them

  // Longest chapter shown in one go. Some epubs are a whole novel in a single
  // file, which is a page nobody wants to scroll and a lot to read through.
  const PART = 12000;

  // How much of a book is read to estimate how much of it you would follow.
  // Enough to be steady, little enough to be quick: the shelf should fill in
  // while you look at it, not after.
  const SAMPLE = 4000;

  const els = {
    back: document.getElementById('back'),
    title: document.getElementById('title'),
    chapters: document.getElementById('chapters'),
    prev: document.getElementById('prev'),
    next: document.getElementById('next'),
    file: document.getElementById('book'),
    shelf: document.getElementById('shelf'),
    list: document.getElementById('list'),
    page: document.getElementById('page'),
    empty: document.getElementById('empty'),
    trouble: document.getElementById('trouble')
  };

  // The bar belongs down on a page that exists only to be read in.
  if (typeof TorvalBar !== 'undefined') TorvalBar.alwaysDown();

  let books = [];
  let book = null;   // the one being read, or null on the shelf
  let places = {};   // book id -> { at, down }
  let showing = 0;
  let saving = null;
  const estimates = new Map();   // book id -> percent, for this visit

  start();

  async function start() {
    els.file.addEventListener('change', () => {
      if (els.file.files[0]) load(els.file.files[0]);
      els.file.value = '';
    });
    els.chapters.addEventListener('change', () => show(Number(els.chapters.value)));
    els.prev.addEventListener('click', () => show(showing - 1));
    els.next.addEventListener('click', () => show(showing + 1));
    els.back.addEventListener('click', () => shelf());

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

    // A chapter is a good few screens, so the chapter alone is not where you
    // were. Written down a moment after you stop moving rather than on every
    // scroll event, which fires all the way down the page.
    window.addEventListener('scroll', () => {
      if (!book) return;
      clearTimeout(saving);
      saving = setTimeout(() => savePlace(book.id, showing, window.scrollY), 400);
    });

    await gather();
    shelf();
  }

  /** Everything on the shelf, and where you were in each of them. */
  async function gather() {
    const stored = await api.storage.local.get([BOOKS, PLACE, 'book', 'bookAt', 'bookScroll']);
    books = (stored && stored[BOOKS]) || [];
    places = (stored && stored[PLACE]) || {};

    // The reader used to hold one book, under its own name. Carry it across
    // rather than lose somebody's place in it.
    if (stored && stored.book && !books.length) {
      const carried = { id: name(), title: stored.book.title, chapters: stored.book.chapters };
      books = [carried];
      places = { [carried.id]: { at: stored.bookAt || 0, down: stored.bookScroll || 0 } };
      await api.storage.local.set({ [BOOKS]: books, [PLACE]: places }).catch(() => {});
      if (api.storage.local.remove) {
        await api.storage.local.remove(['book', 'bookAt', 'bookScroll']).catch(() => {});
      }
    }
  }

  function name() {
    return 'b' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  }

  // -------------------------------------------------------------------------
  // The shelf
  // -------------------------------------------------------------------------

  function shelf() {
    book = null;
    clearTimeout(saving);
    els.page.textContent = '';
    els.page.hidden = true;
    els.shelf.hidden = false;
    els.back.hidden = true;
    els.chapters.hidden = true;
    els.prev.hidden = els.next.hidden = true;
    els.title.textContent = 'Your books';
    els.empty.hidden = books.length > 0;
    if (!books.length) say('');
    document.title = 'Torval reader';

    els.list.textContent = '';
    for (const shelved of books) els.list.appendChild(row(shelved));

    // The bar measures the page it is on, and the shelf is not Japanese.
    document.dispatchEvent(new CustomEvent('torval-reread'));
    fill();
  }

  /**
   * What a book on the shelf says under its title.
   *
   * "2 chapters, you are in 2" was what this said, which is not a sentence.
   * It also said nothing at all when you were in the first chapter, because
   * chapter one is chapter zero underneath and zero is not a number the old
   * test believed in.
   */
  function shelfNote(many, where) {
    if (many < 2) return 'one chapter';
    if (!where) return many + ' chapters';
    return 'chapter ' + (Math.min(where.at, many - 1) + 1) + ' of ' + many;
  }

  function row(shelved) {
    const line = document.createElement('div');
    line.className = 'book';

    const open = document.createElement('button');
    open.className = 'open-book';
    open.addEventListener('click', () => read(shelved.id));

    const title = document.createElement('span');
    title.className = 'book-title';
    title.textContent = shelved.title;

    const where = places[shelved.id];
    const many = shelved.chapters.length;
    const note = document.createElement('span');
    note.className = 'book-note';
    note.textContent = shelfNote(many, where);

    open.append(title, note);

    const score = document.createElement('span');
    score.className = 'book-score';
    score.dataset.id = shelved.id;
    score.textContent = '…';

    const drop = document.createElement('button');
    drop.className = 'remove';
    drop.textContent = '×';
    drop.title = 'Take this book off the shelf';
    drop.addEventListener('click', () => forget(shelved.id));

    line.append(open, score, drop);
    return line;
  }

  /**
   * Put a number against each book, one at a time.
   *
   * In order and not all at once: the background reads one text at a time
   * anyway, and asking for six at once only means waiting for all six before
   * seeing any of them.
   */
  async function fill() {
    for (const shelved of books) {
      const percent = await estimate(shelved);
      const cell = els.list.querySelector('.book-score[data-id="' + shelved.id + '"]');
      if (!cell) return;   // the shelf went away while this was being worked out
      if (percent === null) { cell.textContent = ''; continue; }
      cell.textContent = percent + '%';
      if (typeof TorvalBar !== 'undefined') cell.style.color = TorvalBar.colourFor(percent);
    }
  }

  async function estimate(shelved) {
    if (estimates.has(shelved.id)) return estimates.get(shelved.id);
    let percent = null;
    try {
      const reply = await api.runtime.sendMessage({ type: 'comprehension', text: sample(shelved) });
      if (reply && reply.ok && reply.result && reply.result.total) {
        percent = Math.round((reply.result.known / reply.result.total) * 100);
      }
    } catch (err) { /* the dictionary is not ready; the shelf still works */ }
    if (percent !== null) estimates.set(shelved.id, percent);
    return percent;
  }

  /**
   * A sample of a book, taken evenly from end to end.
   *
   * From the front would be the easy way and the wrong one: a novel opens with
   * names and scene setting and reads nothing like its middle.
   */
  function sample(shelved) {
    const all = [];
    for (const chapter of shelved.chapters) {
      for (const paragraph of chapter.paragraphs) all.push(paragraph);
    }
    if (!all.length) return '';
    const total = all.reduce((sum, p) => sum + p.length, 0);
    if (total <= SAMPLE) return all.join('\n');

    const average = total / all.length;
    const want = Math.max(1, Math.min(all.length, Math.ceil(SAMPLE / average)));
    const step = all.length / want;
    const out = [];
    for (let i = 0; i < want; i++) out.push(all[Math.floor(i * step)]);
    return out.join('\n');
  }

  async function forget(id) {
    books = books.filter((b) => b.id !== id);
    delete places[id];
    estimates.delete(id);
    await api.storage.local.set({ [BOOKS]: books, [PLACE]: places }).catch(() => {});
    shelf();
  }

  // -------------------------------------------------------------------------
  // Reading one of them
  // -------------------------------------------------------------------------

  function read(id) {
    book = books.find((b) => b.id === id) || null;
    if (!book) return;
    els.shelf.hidden = true;
    els.page.hidden = false;
    els.back.hidden = false;
    els.empty.hidden = true;
    document.title = book.title;
    const where = places[id] || {};
    show(where.at || 0, where.down || 0);
  }

  async function load(file) {
    say('Reading ' + file.name + '…');
    try {
      const isEpub = /\.epub$/i.test(file.name) || file.type === 'application/epub+zip';
      const read0 = isEpub ? await readEpub(file) : await readText(file);
      if (!read0.chapters.length) throw new Error('There is no text in that file.');
      const added = { id: name(), title: read0.title || file.name, chapters: read0.chapters };
      books = books.concat([added]);
      await api.storage.local.set({ [BOOKS]: books }).catch(tooBig);
      say('');
      read(added.id);
    } catch (err) {
      say(err.message, true);
    }
  }

  function show(index, down) {
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

    // Turning to a chapter starts at the top of it. Coming back to the book
    // starts where you stopped reading.
    window.scrollTo(0, down || 0);
    clearTimeout(saving);
    savePlace(book.id, at, down || 0);
    // The page has been replaced, so whatever was measured and marked on it
    // belongs to the last chapter. content.js listens for this.
    document.dispatchEvent(new CustomEvent('torval-reread'));
  }

  /**
   * Where you are in one book. Only the place, never the book: a novel is a
   * few megabytes, and writing all of it out again to record that you turned a
   * page is a lot of work to record one number.
   */
  function savePlace(id, at, down) {
    places[id] = { at: at, down: down };
    api.storage.local.set({ [PLACE]: places }).catch(() => {});
  }

  function say(text, bad) {
    els.empty.hidden = !text && books.length > 0;
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

    const named = await tableOfContents(files, opf, base);

    const chapters = [];
    for (const ref of opf.querySelectorAll('spine itemref')) {
      const href = hrefs.get(ref.getAttribute('idref'));
      if (!href) continue;
      const path = resolve(base, href);
      const page = await xml(files, path, 'text/html');
      if (!page) continue;
      const found = paragraphsOf(page);
      // Covers and blank pages have nothing to read and get no chapter.
      if (!found.paragraphs.length) continue;
      const name = named.get(path) || found.title;
      for (const part of split(found.paragraphs, name)) chapters.push(part);
    }
    return { title, chapters };
  }

  /**
   * Every kind of element a book keeps its text in.
   *
   * <div> is on the list because a great many books are built out of nothing
   * else, and leaving it off meant those came out as one paragraph the
   * length of the chapter.
   */
  const BLOCKS = 'p, div, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt, td, section, article, figcaption';

  /**
   * What the book calls its own chapters, as a path for each name.
   *
   * Worth the trouble because most books do not repeat the chapter name
   * inside the chapter: without this, a book opens as Section 1, Section 2,
   * Section 3, which is no way to find your place in it. EPUB 3 keeps the
   * list in a nav document and EPUB 2 in a toc.ncx, and books in the wild
   * are still mostly the second kind.
   */
  async function tableOfContents(files, opf, base) {
    const named = new Map();

    const items = [...opf.querySelectorAll('manifest item')];
    const nav = items.find((item) =>
      (item.getAttribute('properties') || '').split(/\s+/).indexOf('nav') !== -1);
    if (nav) {
      const path = resolve(base, nav.getAttribute('href'));
      const doc = await xml(files, path, 'text/html');
      const from = path.replace(/[^/]+$/, '');
      if (doc) {
        for (const link of doc.querySelectorAll('nav a[href]')) {
          keep(named, resolve(from, link.getAttribute('href')), link.textContent);
        }
      }
    }

    const spine = opf.querySelector('spine');
    const ncxId = spine && spine.getAttribute('toc');
    const ncxItem = ncxId && items.find((item) => item.getAttribute('id') === ncxId);
    if (ncxItem) {
      const path = resolve(base, ncxItem.getAttribute('href'));
      const doc = await xml(files, path);
      const from = path.replace(/[^/]+$/, '');
      if (doc) {
        for (const point of doc.querySelectorAll('navPoint')) {
          const label = point.querySelector('navLabel text');
          const src = point.querySelector('content');
          if (label && src) keep(named, resolve(from, src.getAttribute('src')), label.textContent);
        }
      }
    }
    return named;
  }

  /** The first name a file is given wins: later ones are its own sections. */
  function keep(named, path, text) {
    const name = tidy(text);
    if (name && !named.has(path)) named.set(path, name);
  }

  /** Pull the readable text out of one page of a book. */
  function paragraphsOf(doc) {
    // Ruby is furigana: the reading printed above the kanji. Left in, every
    // word would arrive with its own reading glued to it, so 食べる would
    // come out as 食た べる and match nothing at all.
    for (const el of doc.querySelectorAll('rt, rp, script, style')) el.remove();
    // A line break ends a paragraph as far as reading is concerned, and some
    // books use nothing else.
    for (const br of doc.querySelectorAll('br')) br.replaceWith('\n');

    const heading = doc.querySelector('h1, h2, h3');

    // Only the innermost blocks. A block holding another block is a wrapper,
    // and taking its text as well would repeat every word inside it: a
    // paragraph in a blockquote came out twice, once for each, which put it
    // on the page twice and counted it twice in the score.
    const blocks = [...doc.querySelectorAll(BLOCKS)].filter((el) => !el.querySelector(BLOCKS));
    const holders = blocks.length ? blocks : (doc.body ? [doc.body] : []);

    let paragraphs = [];
    for (const holder of holders) paragraphs = paragraphs.concat(linesOf(holder));

    const title = heading ? tidy(heading.textContent) : '';
    // The heading is shown separately, so it should not also be the first line.
    if (title && paragraphs[0] === title) paragraphs.shift();
    return { title, paragraphs };
  }

  /** The text of one element, as the lines it is written in. */
  function linesOf(el) {
    return el.textContent.split('\n').map(tidy).filter(Boolean);
  }

  function tidy(text) {
    return text.replace(/\s+/g, ' ').trim();
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
    if (entry.method !== 8) throw new Error('That epub is packed in a way Torval cannot open.');
    const stream = new Blob([entry.body]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
})();
