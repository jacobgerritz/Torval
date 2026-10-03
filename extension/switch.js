/*
 * Torval, the panel behind the toolbar button.
 *
 * Turning Torval off leaves it installed and stops it doing anything: no
 * hovering, no marking, no bar, and YouTube gets its own subtitles back. The
 * setting is one value in storage, and every page watches it, so pages already
 * open follow along without being reloaded.
 *
 * This is also the first thing anybody sees, so it is where a language gets
 * picked, before anything else. The switch itself is always there, language
 * or no language: the likeliest reason to open this panel on a fresh
 * install is to put Torval down again. What waits for a language is the two
 * doors below it, since neither the settings nor the reader has anything to
 * say until there is one.
 */

'use strict';

(function () {
  const api = globalThis.browser || globalThis.chrome;

  const box = document.getElementById('on');
  const state = document.getElementById('state');
  const doors = document.getElementById('doors');
  const pickHint = document.getElementById('pick-hint');
  const languageSelect = document.getElementById('language');

  // The list depends on which language the interface is in, so it waits
  // for that rather than being drawn twice. See TorvalLang.offered.
  TorvalUI.load().then(function () { fillLanguages(); TorvalUI.paint(); });
  paintLanguage();
  TorvalLang.onChange(paintLanguage);

  languageSelect.addEventListener('change', () => {
    if (!languageSelect.value) return;
    TorvalLang.set(languageSelect.value);
  });

  function fillLanguages() {
    for (const { code, name } of TorvalLang.offered(TorvalUI.code())) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = TorvalUI.t('lang.' + code, name);
      languageSelect.appendChild(option);
    }
  }

  async function paintLanguage() {
    const chosen = await TorvalLang.chosen();
    // The switch is always there; only the two doors wait for a language,
    // since neither settings nor the reader has anything to say until there
    // is one.
    doors.hidden = !chosen;
    pickHint.hidden = chosen;
    if (chosen) languageSelect.value = TorvalLang.active();
  }

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

  // The switch says On or Off and that is the whole of it. There used to be
  // a sentence under it explaining what On means, which is a sentence you
  // read once and then read past forever.
  function paint(on) {
    box.checked = on;
    state.textContent = on ? 'On' : 'Off';
  }
})();
