/*
 * LLL — known words
 *
 * A running total of words you already know, so that a later feature —
 * "how much of this video will I understand" — has something to compare
 * against. This page is only how words get *into* that list.
 *
 * Adding a word is done by the exact same code that answers a Shift-hover,
 * run across a whole passage of text instead of stopping at one word: each
 * Japanese span is deinflected and looked up, and whatever dictionary form it
 * resolves to is what gets remembered. That means たべました is recorded as
 * 食べる, the same word a hover on it would have shown you — reading a
 * paragraph once teaches the same word regardless of which sentence it turns
 * up conjugated in.
 */

'use strict';

const api = globalThis.browser || globalThis.chrome;

const countEl = document.getElementById('count');
const textEl = document.getElementById('text');
const fileEl = document.getElementById('file');
const addButton = document.getElementById('add');
const resultEl = document.getElementById('result');

refreshCount();

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
    setCount(added.result.total);
  } catch (err) {
    resultEl.textContent = err.message;
    resultEl.className = 'note error';
  } finally {
    addButton.disabled = false;
    addButton.textContent = 'Add words from this text';
  }
});

async function refreshCount() {
  const reply = await api.runtime.sendMessage({ type: 'knownWords' });
  setCount(reply.ok ? reply.result.count : 0);
}

function setCount(n) {
  countEl.textContent = n.toLocaleString('en-US') + (n === 1 ? ' known word' : ' known words');
}
