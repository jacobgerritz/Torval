/*
 * LLL, the panel behind the toolbar button.
 *
 * Turning LLL off leaves it installed and stops it doing anything: no
 * hovering, no marking, no bar, and YouTube gets its own subtitles back. The
 * setting is one value in storage, and every page watches it, so pages already
 * open follow along without being reloaded.
 */

'use strict';

(function () {
  const api = globalThis.browser || globalThis.chrome;

  const box = document.getElementById('on');
  const state = document.getElementById('state');
  const note = document.getElementById('note');

  api.storage.local.get('off').then((stored) => paint(!stored.off)).catch(() => {});

  box.addEventListener('change', async () => {
    paint(box.checked);
    await api.storage.local.set({ off: !box.checked }).catch(() => {});
  });

  document.getElementById('settings').addEventListener('click', () => {
    api.runtime.openOptionsPage();
    window.close();
  });

  document.getElementById('books').addEventListener('click', () => {
    const url = api.runtime.getURL('reader.html');
    if (api.tabs && api.tabs.create) api.tabs.create({ url });
    else window.open(url, '_blank');
    window.close();
  });

  function paint(on) {
    box.checked = on;
    state.textContent = on ? 'On' : 'Off';
    note.textContent = on
      ? 'Hovering, marking and the bar are working.'
      : 'Installed and out of the way. Pages already open follow along.';
  }
})();
