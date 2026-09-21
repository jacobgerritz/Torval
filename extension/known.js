/*
 * Torval, the known and ignored word panels
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
    ids: { count: 'count', search: 'search', list: 'list', more: 'more' },
    empty: 'Nothing here yet. Press ✓ on a word in the popup, or paste a text above.'
  });

  browsePanel({
    list: 'ignoredList',
    forget: 'forgetIgnored',
    ids: {
      count: 'count-ignored', search: 'search-ignored',
      list: 'list-ignored', more: 'more-ignored'
    },
    empty: 'Nothing ignored yet. Press ⊘ on a word in the popup, or the 3 key.'
  });

  addFromText();
  backupPanel();
  clearPanel();

  // Every browse panel reads its list from background.js by message, and
  // background.js answers 'knownList'/'ignoredList' for whichever language
  // is active there; a switch made from options.js's own selector, or from
  // the toolbar popup, has to be followed by a fresh read here too, or the
  // words shown would keep belonging to the language just left.
  if (typeof TorvalLang !== 'undefined') {
    TorvalLang.onChange(() => { refreshers.forEach((r) => r()); });
  }

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
      // Just the number: it sits next to the heading that says which list it is.
      countEl.textContent = n.toLocaleString('en-US');
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
      download('torval-words-' + day + '.json', JSON.stringify(words, null, 2));
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
          throw new Error('That file is not one Torval saved.');
        }

        const reply = await api.runtime.sendMessage({ type: 'importWords', data });
        if (!reply.ok) throw new Error(reply.error);
        const { added, dropped, known, ignored } = reply.result;
        loadNote.textContent = added.known + ' known and ' + added.ignored +
          ' ignored words added; ' + known + ' and ' + ignored + ' now in all.' +
          // Words left out are said out loud. A file in the wrong language
          // adds nothing at all, and silence about that looks like a bug.
          (dropped ? ' ' + dropped + ' not in the dictionary, left out.' : '');
        refreshAll();
      } catch (err) {
        loadNote.className = 'note error';
        loadNote.textContent = err.message;
      } finally {
        loadInput.value = '';
      }
    });
  }

  // -------------------------------------------------------------------------
  // Emptying a list
  // -------------------------------------------------------------------------

  /**
   * Two buttons that each need pressing twice.
   *
   * A known list is months of reading, and a stray click on a button called
   * "forget everything" is the one mistake here nothing undoes. So the first
   * press only arms it, saying how many words are about to go, and the
   * second press is the one that counts. Arming times out, and arming one
   * button disarms the other, so a button is never left sitting loaded.
   */
  function clearPanel() {
    const noteEl = document.getElementById('clear-note');
    const buttons = [
      { el: document.getElementById('clear-known'), list: 'known', label: 'Forget every known word' },
      { el: document.getElementById('clear-ignored'), list: 'ignored', label: 'Forget every ignored word' }
    ];
    if (!buttons[0].el || !buttons[1].el) return;

    let armed = null;
    let timer = 0;

    function disarm() {
      clearTimeout(timer);
      armed = null;
      for (const button of buttons) {
        button.el.textContent = button.label;
        button.el.classList.remove('armed');
      }
    }

    for (const button of buttons) {
      button.el.addEventListener('click', async () => {
        if (armed !== button) {
          disarm();
          armed = button;
          button.el.textContent = 'Press again to forget them';
          button.el.classList.add('armed');
          noteEl.className = 'note';
          noteEl.textContent = '';
          timer = setTimeout(disarm, 8000);
          return;
        }

        disarm();
        button.el.disabled = true;
        const reply = await api.runtime.sendMessage({ type: 'clearWords', list: button.list });
        button.el.disabled = false;

        if (!reply || !reply.ok) {
          noteEl.className = 'note error';
          noteEl.textContent = (reply && reply.error) || 'Could not empty that list.';
          return;
        }
        const gone = reply.result.removed;
        noteEl.className = 'note';
        noteEl.textContent = gone.toLocaleString('en-US') +
          ' ' + button.list + ' word' + (gone === 1 ? '' : 's') + ' forgotten.';
        refreshAll();
      });
    }
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

    // The placeholder is written in whichever language is active, since a
    // Japanese one is just noise while reading Spanish. It comes from the
    // language's own profile in lang.js, which is also where the settings
    // page gets its placeholders: two lists of languages meant one of them
    // being forgotten, and it was this one.
    function paintHelp() {
      const example = TorvalLang.profile().examples;
      if (example) textEl.placeholder = example.paste;
    }
    if (typeof TorvalLang !== 'undefined') {
      paintHelp();
      TorvalLang.onChange(paintHelp);
    }

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

        const many = found.result.length;
        const already = many - added.result.added;
        resultEl.textContent = `Found ${many} word${many === 1 ? '' : 's'}, ` +
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
