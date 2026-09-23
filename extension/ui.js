/*
 * Torval, the language the reader already has
 *
 * Separate from the language being studied, and deliberately so. A Spanish
 * speaker learning English wants the buttons in Spanish and the dictionary
 * in English, which is the opposite pairing to an English speaker learning
 * Spanish, and neither is derivable from the other.
 *
 * It is not read from the browser either. A browser set to Spanish says
 * where somebody lives, not which language they would rather read a
 * settings page in, and guessing wrong on first run is worse than asking.
 * English is the default and the picker is in the sidebar.
 *
 * Pages mark their text with data-t="key" and call paint() once the stored
 * choice has loaded. Strings built in script ask for t('key') instead.
 * Anything with no translation falls back to the English, so a half
 * translated page reads oddly rather than emptying itself.
 */
var TorvalUI = (function () {
  'use strict';

  var api = globalThis.browser || globalThis.chrome;

  var LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Español' }
  ];

  var STRINGS = {
    // English is the language the pages are written in, so it needs no
    // table: t() falls back to what the markup already says. It is listed
    // so that code asking "is this a language Torval speaks" gets a yes.
    en: {},
    es: {
      // --- the frame ---------------------------------------------------
      'settings.title': 'Ajustes de Torval',
      'sidebar.mine': 'Tu idioma',
      'sidebar.language': 'Aprendiendo',
      'sidebar.books': 'Abrir tus libros',
      'tab.words': 'Palabras',
      'tab.anki': 'Anki',
      'tab.video': 'Vídeo',
      'tab.keys': 'Teclas',
      'tab.look': 'Apariencia',
      'tab.about': 'Acerca de',

      // The languages Torval reads, named in the interface language. The
      // interface picker names itself in its own language instead, the way
      // every language picker does.
      'lang.ja': 'Japonés',
      'lang.it': 'Italiano',
      'lang.es': 'Español',
      'lang.en': 'Inglés',

      // --- first run ---------------------------------------------------
      'first.question': '¿Qué idioma estás leyendo?',
      'first.one': 'Un idioma a la vez. Cambiarlo después no pierde nada: cada uno guarda sus propias palabras y ajustes de Anki.',
      'first.minute': 'Cargar el diccionario tarda un minuto, una sola vez.',

      // --- words -------------------------------------------------------
      'words.score': 'Llevar la cuenta',
      'words.score.note': 'Colorea lo que no has marcado y dice qué parte de una página conoces. Desactivado, Torval es un diccionario que hace tarjetas de Anki.',
      'words.score.check': 'Llevar la cuenta de las palabras que sé',
      'words.known': 'Palabras conocidas',
      'words.known.note': 'Pulsa ✓ en la ventana, o 2.',
      'words.add': 'Añadir desde un texto',
      'words.file': 'Elegir un archivo',
      'words.file.none': 'o pega el texto arriba',
      'words.add.button': 'Añadir estas palabras',
      'words.search': 'Buscar',
      'words.ignored': 'Palabras ignoradas',
      'words.ignored.note': '. Pulsa ⊘ en la ventana, o 3.',
      'words.copy': 'Guardar una copia',
      'words.load': 'Cargar desde un archivo',
      'words.save': 'Guardar en un archivo',
      'words.anki.from': 'Desde Anki:',
      'words.anki.link': 'Export Known Words',
      'words.restart': 'Empezar de nuevo',
      'words.forget.known': 'Olvidar todas las palabras conocidas',
      'words.forget.ignored': 'Olvidar todas las palabras ignoradas',

      // --- anki --------------------------------------------------------
      'anki.where': 'A dónde van las tarjetas',
      'anki.open': 'Anki tiene que estar abierto, con AnkiConnect instalado.',
      'anki.deck': 'Mazo',
      'anki.model': 'Tipo de nota',
      'anki.tags': 'Etiquetas',
      'anki.fields': 'Qué va en cada campo',
      'anki.none': '¿No tienes un tipo de nota que te guste? Usa',
      'anki.ours': 'el de Torval',
      'anki.save': 'Guardar',

      // --- video -------------------------------------------------------
      'video.speed': 'Acelerar lo que no es diálogo',
      'video.speed.label': 'Velocidad',
      'video.speed.hint.before': 'Actívalo con',
      'video.speed.hint.after': 'en la barra, o pulsa',
      'video.recording': 'Grabar del vídeo',
      'video.lead': 'Margen de audio',
      'video.lead.hint': 'Segundos que se guardan antes de la línea.',
      'video.tab.check': 'Grabar el sonido de vídeo protegido',
      'video.invoke': 'En vídeo protegido, pulsa el botón de Torval en la barra del navegador una vez por pestaña. El navegador no permite imagen ni sonido hasta que lo hagas.',
      'video.netflix': 'Las líneas de Netflix se leen de la pantalla, así que sus subtítulos tienen que estar visibles. Torval le pide al reproductor que los active; si no funciona, elige el idioma en el menú del propio reproductor.',

      // --- keys --------------------------------------------------------
      'keys.title': 'Atajos de teclado',
      'keys.note': 'Pulsa una tecla y luego la que quieras. Escape cancela.',
      'keys.reset': 'Volver a los valores por defecto',

      // --- about -------------------------------------------------------
      'about.what': 'Un diccionario emergente que funciona entero en este ordenador. Sin cuenta, sin telemetría, sin servidor; nada de lo que lees o consultas se envía a ningún sitio.',
      'about.licence.before': 'GPL-3.0, en',
      'about.licence.after': '. Los diccionarios conservan sus propias licencias, abajo.',
      'about.free': 'Gratis, y no hay una versión de pago detrás.',
      'about.support': 'Apoya el proyecto',
      'about.support.after': 'si te apetece.',
      'about.dictionaries': 'Diccionarios',
      'about.dictionaries.note': 'Uno por idioma, cargado la primera vez que eliges ese idioma. La frecuencia y el acento tonal van dentro de cada uno, no en archivos aparte.',
      'about.wrong': 'Cuando algo va mal',
      'about.wrong.note': 'Narra cómo encuentra y lee los subtítulos. Envíalo con el informe de error.',
      'about.verbose': 'Decir lo que hace en la consola',

      // --- the toolbar popup --------------------------------------------
      'popup.language': 'Idioma',
      'popup.choose': 'Elige un idioma…',
      'popup.on': 'Activado',
      'popup.settings': 'Ajustes',
      'popup.books': 'Libros',
      'popup.pick': 'Elige un idioma arriba para empezar.',

      // --- the word popup ------------------------------------------------
      'word.also': 'también en la tarjeta:',
      'word.add': 'Añadir a Anki',
      'word.only': 'pulsa para poner solo esto en la tarjeta',
      'word.lookup': 'Buscar {word}',
      'word.duplicate': 'Ya está en tu colección; se añadirá otra vez.',
      'word.ranked': 'puesto n.º {rank} en un corpus de medios en {language}',
      'word.flat': 'plano, el tono no baja nunca',
      'word.drop': 'el tono baja después de la mora {at}',
      'band.rare': 'rara',

      // --- on the page -------------------------------------------------
      'page.reading': 'Leyendo esta página…',
      'page.subtitles': 'Leyendo los subtítulos…',
      'page.building': 'Cargando el diccionario, una sola vez…',
      'page.known': 'de {total} palabras conocidas',
      'page.record': 'Grabar esta pestaña',
      'page.added': 'Añadido a Anki.',
      'page.nosubs': 'No se han encontrado subtítulos en {language} en este vídeo'
    }
  };

  var current = 'en';

  /**
   * The stored choice, or English. Pages await this before painting.
   *
   * Written to survive anything storage does, because this is called at
   * the top level of the content script: a throw here takes the whole of
   * Torval off the page, bar and popup and all, on every site. It threw
   * once, when `get` answered through a callback rather than with a
   * promise and there was nothing to call `.then` on.
   */
  function load() {
    return new Promise(function (done) {
      if (!api || !api.storage || !api.storage.local) return done(current);
      var answer;
      try {
        answer = api.storage.local.get('uiLanguage', function (stored) {
          done(keep(stored));
        });
      } catch (err) {
        return done(current);
      }
      // Firefox, and Chrome when no callback is taken: the same call hands
      // back a promise instead of answering the callback.
      if (answer && typeof answer.then === 'function') {
        answer.then(function (stored) { done(keep(stored)); },
          function () { done(current); });
      }
    });
  }

  function keep(stored) {
    var next = stored && stored.uiLanguage;
    if (next && STRINGS[next]) current = next;
    return current;
  }

  function code() { return current; }

  // A background page lives for hours and would otherwise answer with
  // whatever was stored when it woke. The settings page writes this key
  // and the popup reads it back a moment later.
  try {
    if (api && api.storage && api.storage.onChanged) {
      api.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes.uiLanguage) return;
        var next = changes.uiLanguage.newValue;
        if (STRINGS[next]) current = next;
      });
    }
  } catch (err) { /* no listener; the stored value is read at load anyway */ }

  function set(next) {
    current = STRINGS[next] ? next : 'en';
    try {
      if (api && api.storage && api.storage.local) {
        api.storage.local.set({ uiLanguage: current });
      }
    } catch (err) { /* the choice still holds for this page */ }
    return current;
  }

  /**
   * One string. Untranslated keys fall back to whatever the page already
   * says, which for English is the right answer and for a missing Spanish
   * line is better than a blank.
   */
  function t(key, fallback, fill) {
    var table = STRINGS[current];
    var text = (table && table[key]) || fallback || '';
    if (fill) {
      Object.keys(fill).forEach(function (name) {
        text = text.split('{' + name + '}').join(fill[name]);
      });
    }
    return text;
  }

  /**
   * Fill every marked element. data-t sets the text, data-t-title the
   * tooltip, data-t-placeholder the placeholder, so one attribute per thing
   * that can be worded rather than a parallel markup scheme.
   */
  function paint(root) {
    var where = root || document;
    if (current === 'en') return;   // the page is already written in it
    where.querySelectorAll('[data-t]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-t'), el.textContent);
    });
    where.querySelectorAll('[data-t-title]').forEach(function (el) {
      el.title = t(el.getAttribute('data-t-title'), el.title);
    });
    where.querySelectorAll('[data-t-placeholder]').forEach(function (el) {
      el.placeholder = t(el.getAttribute('data-t-placeholder'), el.placeholder);
    });
  }

  return {
    languages: LANGUAGES,
    load: load,
    code: code,
    set: set,
    t: t,
    paint: paint,
    _strings: STRINGS
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalUI;
