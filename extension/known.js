/*
 * LLL, the known and ignored word panels
 *
 * Two lists of words, browsed exactly the same way, so they are one piece of
 * code told which list it is looking at.
 *
 *   known    what the comprehension percentage is measured against. Words
 *            arrive by pressing ✓ on one in the popup, by the 2 key, or in
 *            bulk by pasting in something already read.
 *   ignored  words never to be mentioned again: names, pieces of English,
 *            things the dictionary read wrongly. They leave the comprehension
 *            question rather than counting either way.
 *
 * Adding in bulk is done by the exact same code that answers a Shift-hover,
 * run across a whole passage instead of stopping at one word: each Japanese
 * span is deinflected and looked up, and whatever dictionary form it resolves
 * to is what gets remembered. たべました is recorded as 食べる, the same word a
 * hover on it would have shown, so reading a passage once teaches the word
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
  // browser will happily choke on, and nobody scrolls that far anyway, the
  // search box is how you find one word among that many.
  const PAGE = 200;

  const refreshers = [];   // one per browse panel
  let refreshKnown = null;

  browsePanel({
    list: 'knownList',
    forget: 'forgetWords',
    noun: 'known word',
    ids: { count: 'count', search: 'search', list: 'list', more: 'more' },
    empty: 'Nothing here yet. Press ✓ on a word in the popup, or paste a text above.'
  });

  browsePanel({
    list: 'ignoredList',
    forget: 'forgetIgnored',
    noun: 'ignored word',
    ids: {
      count: 'count-ignored', search: 'search-ignored',
      list: 'list-ignored', more: 'more-ignored'
    },
    empty: 'Nothing ignored yet. Press ⊘ on a word in the popup, or the 3 key.'
  });

  addFromText();
  backupPanel();

  // -------------------------------------------------------------------------
  // Browsing one of the lists
  // -------------------------------------------------------------------------

  function browsePanel(config) {
    const countEl = document.getElementById(config.ids.count);
    const searchEl = document.getElementById(config.ids.search);
    const listEl = document.getElementById(config.ids.list);
    const moreEl = document.getElementById(config.ids.more);
    if (!countEl || !listEl) return;

    let all = [];        // [{ word, added }], newest first
    let shown = PAGE;

    refresh();
    // The bulk-add form and a restored backup both need the lists they
    // changed redrawn, and neither of them knows which panel is which.
    refreshers.push(refresh);
    if (config.list === 'knownList') refreshKnown = refresh;

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
      const reply = await api.runtime.sendMessage({ type: config.list });
      all = reply && reply.ok ? reply.result : [];
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
        empty.textContent = all.length ? 'Nothing here matches that.' : config.empty;
        listEl.appendChild(empty);
        moreEl.hidden = true;
        return;
      }

      for (const row of rows.slice(0, shown)) listEl.appendChild(wordRow(row));
      if (options && options.keepScroll) listEl.scrollTop = at;

      const left = rows.length - shown;
      moreEl.hidden = left <= 0;
      if (left > 0) moreEl.textContent = `${left.toLocaleString('en-US')} more, keep scrolling.`;
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
      remove.title = 'Take this word off the list';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        const reply = await api.runtime.sendMessage({ type: config.forget, words: [word] });
        if (!reply || !reply.ok) { remove.disabled = false; return; }
        all = all.filter((r) => r.word !== word);
        setCount(all.length);
        draw();
      });

      row.append(text, when, remove);
      return row;
    }

    function setCount(n) {
      countEl.textContent = n.toLocaleString('en-US') + ' ' + config.noun + (n === 1 ? '' : 's');
    }
  }

  // -------------------------------------------------------------------------
  // Keeping a copy of both lists somewhere else
  // -------------------------------------------------------------------------

  function backupPanel() {
    const saveButton = document.getElementById('save-words');
    const saveNote = document.getElementById('save-note');
    const loadInput = document.getElementById('load-words');
    const loadNote = document.getElementById('load-note');
    if (!saveButton || !loadInput) return;

    saveButton.addEventListener('click', async () => {
      saveNote.className = 'note';
      saveNote.textContent = '';
      const reply = await api.runtime.sendMessage({ type: 'exportWords' });
      if (!reply || !reply.ok) {
        saveNote.className = 'note error';
        saveNote.textContent = (reply && reply.error) || 'Could not read the lists.';
        return;
      }

      const words = reply.result;
      const day = new Date().toISOString().slice(0, 10);
      download('lll-words-' + day + '.json', JSON.stringify(words, null, 2));
      saveNote.textContent = count(words.known) + ' known, ' +
        count(words.ignored) + ' ignored.';
    });

    loadInput.addEventListener('change', async () => {
      const file = loadInput.files[0];
      if (!file) return;
      loadNote.className = 'note';
      loadNote.textContent = 'Reading…';

      try {
        let data;
        try {
          data = JSON.parse(await file.text());
        } catch (bad) {
          // Whatever the parser complains about, the answer is the same one:
          // this is not the file they meant to pick.
          throw new Error('That file is not one LLL saved.');
        }

        const reply = await api.runtime.sendMessage({ type: 'importWords', data });
        if (!reply.ok) throw new Error(reply.error);
        const { added, known, ignored } = reply.result;
        loadNote.textContent = added.known + ' known and ' + added.ignored +
          ' ignored words added; ' + known + ' and ' + ignored + ' now in all.';
        refreshAll();
      } catch (err) {
        loadNote.className = 'note error';
        loadNote.textContent = err.message;
      } finally {
        loadInput.value = '';
      }
    });
  }

  function refreshAll() { for (const again of refreshers) again(); }

  function count(map) {
    return Object.keys(map || {}).length.toLocaleString('en-US');
  }

  /**
   * Hand the file to the browser. An object URL rather than a data: one so
   * that a list of tens of thousands of words is not squeezed through an
   * address, and revoked straight after so it is not left holding the whole
   * thing in memory.
   */
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // -------------------------------------------------------------------------
  // Adding a whole text at once, which only the known list takes
  // -------------------------------------------------------------------------

  function addFromText() {
    const textEl = document.getElementById('text');
    const fileEl = document.getElementById('file');
    const addButton = document.getElementById('add');
    const resultEl = document.getElementById('result');
    if (!textEl || !addButton) return;

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
        resultEl.textContent = `Found ${found.result.length} words, ` +
          `${added.result.added} new, ${already} already known.`;
        if (refreshKnown) await refreshKnown();
      } catch (err) {
        resultEl.textContent = err.message;
        resultEl.className = 'note error';
      } finally {
        addButton.disabled = false;
        addButton.textContent = 'Add words from this text';
      }
    });
  }
})();
