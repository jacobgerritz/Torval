/*
 * LLL — the known words panel
 *
 * The list the comprehension percentage is measured against: every word you
 * have said you already know. Words arrive here two ways — one at a time, by
 * pressing ✓ on a word in the popup, or in bulk, by pasting in something you
 * have already read.
 *
 * Adding in bulk is done by the exact same code that answers a Shift-hover,
 * run across a whole passage instead of stopping at one word: each Japanese
 * span is deinflected and looked up, and whatever dictionary form it resolves
 * to is what gets remembered. たべました is recorded as 食べる, the same word a
 * hover on it would have shown — so reading a passage once teaches the word
 * regardless of which sentence it turned up conjugated in.
 *
 * Wrapped up in a function of its own because this shares a page with
 * options.js, and two scripts declaring `api` at the top level of the same
 * page is an error rather than two copies of the same harmless line.
 */

'use strict';

(function () {
  const api = globalThis.browser || globalThis.chrome;

  // How many rows to draw at once. A list of twenty thousand words is one the
  // browser will happily choke on, and nobody scrolls that far anyway — the
  // search box is how you find one word among that many.
  const PAGE = 200;

  const countEl = document.getElementById('count');
  const textEl = document.getElementById('text');
  const fileEl = document.getElementById('file');
  const addButton = document.getElementById('add');
  const resultEl = document.getElementById('result');
  const searchEl = document.getElementById('search');
  const listEl = document.getElementById('list');
  const moreEl = document.getElementById('more');

  let all = [];        // [{ word, added }], newest first
  let shown = PAGE;

  refresh();

  // -------------------------------------------------------------------------
  // Adding
  // -------------------------------------------------------------------------

  fileEl.addEventListener('change', async () => {
    const file = fileEl.files[0];
    if (!file) return;
    textEl.value = await file.text();
    fileEl.value = '';
  });

  addButton.addEventListener('click', async () => {
    const text = textEl.value.trim();
    if (!text) return;

    addButton.disabled = true;
    addButton.textContent = 'Reading…';
    resultEl.textContent = '';
    resultEl.className = 'note';

    try {
      const found = await api.runtime.sendMessage({ type: 'extractWords', text });
      if (!found.ok) throw new Error(found.error);

      const added = await api.runtime.sendMessage({ type: 'addKnownWords', words: found.result });
      if (!added.ok) throw new Error(added.error);

      const already = found.result.length - added.result.added;
      resultEl.textContent = `Found ${found.result.length} words — ` +
        `${added.result.added} new, ${already} already known.`;
      await refresh();
    } catch (err) {
      resultEl.textContent = err.message;
      resultEl.className = 'note error';
    } finally {
      addButton.disabled = false;
      addButton.textContent = 'Add words from this text';
    }
  });

  // -------------------------------------------------------------------------
  // Browsing
  // -------------------------------------------------------------------------

  searchEl.addEventListener('input', () => { shown = PAGE; draw(); });

  // More rows arrive by scrolling to them rather than by pressing a button.
  // A list of two thousand words is eleven presses of "show more", which is
  // ten more decisions than anybody wants to make about a word list.
  listEl.addEventListener('scroll', () => {
    if (listEl.scrollTop + listEl.clientHeight < listEl.scrollHeight - 200) return;
    if (shown >= matching().length) return;
    shown += PAGE;
    draw({ keepScroll: true });
  });

  async function refresh() {
    const reply = await api.runtime.sendMessage({ type: 'knownList' });
    all = reply.ok ? reply.result : [];
    setCount(all.length);
    shown = PAGE;
    draw();
  }

  function matching() {
    const query = searchEl.value.trim();
    if (!query) return all;
    return all.filter((row) => row.word.indexOf(query) !== -1);
  }

  function draw(options) {
    const rows = matching();
    const at = listEl.scrollTop;
    listEl.textContent = '';

    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'note';
      empty.textContent = all.length
        ? 'No known word matches that.'
        : 'Nothing here yet — press ✓ on a word in the popup, or paste a text above.';
      listEl.appendChild(empty);
      moreEl.hidden = true;
      return;
    }

    for (const row of rows.slice(0, shown)) listEl.appendChild(wordRow(row));
    if (options && options.keepScroll) listEl.scrollTop = at;

    const left = rows.length - shown;
    moreEl.hidden = left <= 0;
    if (left > 0) moreEl.textContent = `${left.toLocaleString('en-US')} more — keep scrolling.`;
  }

  function wordRow({ word, added }) {
    const row = document.createElement('div');
    row.className = 'word-row';

    const text = document.createElement('span');
    text.className = 'word';
    text.textContent = word;

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = added ? new Date(added).toLocaleDateString() : '';

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '×';
    remove.title = 'Forget this word';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      const reply = await api.runtime.sendMessage({ type: 'forgetWords', words: [word] });
      if (!reply || !reply.ok) { remove.disabled = false; return; }
      all = all.filter((r) => r.word !== word);
      setCount(all.length);
      draw();
    });

    row.append(text, when, remove);
    return row;
  }

  function setCount(n) {
    countEl.textContent = n.toLocaleString('en-US') + (n === 1 ? ' known word' : ' known words');
  }
})();
