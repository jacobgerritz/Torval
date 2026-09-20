/*
 * Torval, Spanish deinflection
 *
 * A Spanish dictionary lists the infinitive ("hablar") and the masculine
 * singular ("alto"). Before a conjugated or inflected word on a page can be
 * looked up, whatever was done to it has to be undone:
 *
 *     hablábamos   ->  hablar
 *     altas        ->  alto
 *     dármelo      ->  dar
 *
 * Same shape as deinflect-it.js: a table of small reversible suffix rules,
 * walked by the solver in deinflect-latin.js. What is here is rule content
 * only, and it is a longer table than Italian's, because Spanish uses more
 * of its verb system in ordinary speech.
 *
 * Three things Spanish needs that Italian's table does not:
 *
 *  - The preterite. Italian's passato remoto is literary and was left out;
 *    Spanish's pretérito is how anybody says what happened yesterday, so
 *    hablé/hablaste/habló are as necessary as the present tense.
 *
 *  - The subjunctive, both tenses of it. "Quiero que hables" and "si
 *    hablara" are everyday Spanish, not a register a reader can skip.
 *
 *  - Pronouns on the end of a verb: dármelo, diciéndoselo, hablarle. These
 *    are written as one word, so a reader hovering one is hovering
 *    something no dictionary lists. Italian has the same habit and
 *    deinflect-it.js does not attempt it; here it is attempted, because
 *    Spanish does it constantly. The rules undo the accent that attaching a
 *    pronoun adds (dar -> dármelo) at the same time as the pronoun itself,
 *    since the two always happen together.
 *
 * What is still not attempted: stem changes (pienso from pensar, duermo from
 * dormir), which no suffix rule can reach, and whose forms come instead from
 * the dictionary itself, which carries every form Wiktionary lists pointed
 * at the word it belongs to (see tools/wiktextract.mjs). The rules are for
 * the forms Wiktionary never wrote down; the index is for the rest, and
 * between them very little is missed.
 */

if (typeof TorvalDeinflectLatin === 'undefined' && typeof require !== 'undefined') {
  var TorvalDeinflectLatin = require('./deinflect-latin.js');
}

var TorvalDeinflectEs = TorvalDeinflectLatin.build(function (rule) {
  'use strict';

  var V = ['v'];
  // Pronouns are in here because a possessive is one. Wiktionary files
  // Italian suo, mio, tuo as pronouns, and they agree in gender and number
  // exactly as an adjective does: sua, suoi, sue. Left out, the rules below
  // could not reach them, and "sue" was a word Torval found nothing at all
  // for, since it is the one form Wiktionary never wrote down as a page of
  // its own. sua, mie and tue only ever worked by being listed.
  var NA = ['n', 'adj', 'pron'];

  // ---------------------------------------------------------------------
  // Regular conjugation, one ending table per class. The endings are listed
  // whole, from the end of the word backwards to where the stem stops, so
  // each is a straight swap for the infinitive: "ábamos" off, "ar" on.
  //
  // -er and -ir share almost everything (they differ in the present
  // indicative plural and nowhere else that matters here), but they are
  // written out separately rather than merged, because the class is the
  // answer being guessed at: comer and vivir have to be reachable as two
  // different words from the same ending, and whichever one turns out to be
  // in the dictionary is the right one. That is the same bargain the
  // Italian table strikes across -are/-ere/-ire.
  // ---------------------------------------------------------------------
  var REGULAR = {
    ar: {
      inf: 'ar',
      pres: ['o', 'as', 'ás', 'a', 'amos', 'áis', 'an'],
      impf: ['aba', 'abas', 'ábamos', 'abais', 'aban'],
      pret: ['é', 'aste', 'ó', 'amos', 'asteis', 'aron'],
      subj: ['e', 'es', 'emos', 'éis', 'en'],
      // Both imperfect subjunctives. -ra is the everyday one, -se is
      // commoner in writing and in Spain; neither is rare enough to leave
      // out.
      past: ['ara', 'aras', 'áramos', 'arais', 'aran',
             'ase', 'ases', 'ásemos', 'aseis', 'asen'],
      imp: ['ad'],
      pp: 'ado',
      ger: 'ando'
    },
    er: {
      inf: 'er',
      pres: ['o', 'es', 'és', 'e', 'emos', 'éis', 'en'],
      impf: ['ía', 'ías', 'íamos', 'íais', 'ían'],
      pret: ['í', 'iste', 'ió', 'imos', 'isteis', 'ieron'],
      subj: ['a', 'as', 'amos', 'áis', 'an'],
      past: ['iera', 'ieras', 'iéramos', 'ierais', 'ieran',
             'iese', 'ieses', 'iésemos', 'ieseis', 'iesen'],
      imp: ['ed'],
      pp: 'ido',
      ger: 'iendo'
    },
    ir: {
      inf: 'ir',
      pres: ['o', 'es', 'ís', 'e', 'imos', 'en'],
      impf: ['ía', 'ías', 'íamos', 'íais', 'ían'],
      pret: ['í', 'iste', 'ió', 'imos', 'isteis', 'ieron'],
      subj: ['a', 'as', 'amos', 'áis', 'an'],
      past: ['iera', 'ieras', 'iéramos', 'ierais', 'ieran',
             'iese', 'ieses', 'iésemos', 'ieseis', 'iesen'],
      imp: ['id'],
      pp: 'ido',
      ger: 'iendo'
    }
  };

  // The future and the conditional are built on the whole infinitive rather
  // than on a stem (hablar + é, hablar + ía), which is why they are the one
  // pair generated from the infinitive itself instead of listed per class.
  var FUTURE = ['é', 'ás', 'á', 'emos', 'éis', 'án'];
  var CONDITIONAL = ['ía', 'ías', 'íamos', 'íais', 'ían'];

  Object.keys(REGULAR).forEach(function (klass) {
    var c = REGULAR[klass];
    c.pres.forEach(function (e) { rule(e, c.inf, [], V, 'present'); });
    c.impf.forEach(function (e) { rule(e, c.inf, [], V, 'imperfect'); });
    c.pret.forEach(function (e) { rule(e, c.inf, [], V, 'preterite'); });
    c.subj.forEach(function (e) { rule(e, c.inf, [], V, 'subjunctive'); });
    c.past.forEach(function (e) { rule(e, c.inf, [], V, 'past subjunctive'); });
    c.imp.forEach(function (e) { rule(e, c.inf, [], V, 'imperative'); });
    rule(c.pp, c.inf, [], V, 'past participle');
    rule(c.ger, c.inf, [], V, 'gerund');
    FUTURE.forEach(function (e) { rule(c.inf + e, c.inf, [], V, 'future'); });
    CONDITIONAL.forEach(function (e) { rule(c.inf + e, c.inf, [], V, 'conditional'); });
  });

  // ---------------------------------------------------------------------
  // Pronouns stuck on the end of a verb.
  //
  // Spanish attaches them to three forms and nothing else: the infinitive
  // (dármelo), the gerund (diciéndoselo) and the affirmative imperative
  // (dímelo). The first two are done here, as rules; the third is left to
  // the dictionary's own index, because an imperative's own form is often
  // irregular before any pronoun is added to it.
  //
  // The written accent moves with the pronoun, and the rule has to undo
  // both at once. Spanish puts an accent on exactly when the stress would
  // otherwise land too far from the end: one pronoun on an infinitive needs
  // none (hablarme), two need one (hablármelo), and a gerund needs one for
  // even a single pronoun (hablándome), because a gerund already ends in a
  // syllable of its own. So the infinitive gets both an unaccented
  // single-pronoun rule and an accented two-pronoun one, and the gerund is
  // accented throughout.
  // ---------------------------------------------------------------------
  var ONE = ['me', 'te', 'se', 'lo', 'la', 'le', 'nos', 'os', 'los', 'las', 'les'];
  var TWO = [];
  ['me', 'te', 'se', 'nos', 'os'].forEach(function (indirect) {
    ['lo', 'la', 'los', 'las'].forEach(function (direct) {
      TWO.push(indirect + direct);
    });
  });

  // hablarme -> hablar, and hablármelo -> hablar. The accented infinitive
  // ending is spelled out per class rather than derived, since there are
  // only three of them.
  var ACCENTED_INF = { ar: 'ár', er: 'ér', ir: 'ír' };
  Object.keys(REGULAR).forEach(function (klass) {
    var inf = REGULAR[klass].inf;
    var accented = ACCENTED_INF[klass];
    ONE.forEach(function (p) {
      rule(inf + p, inf, [], V, 'with pronoun');
      rule(accented + p, inf, [], V, 'with pronoun');
    });
    TWO.forEach(function (p) {
      rule(accented + p, inf, [], V, 'with pronouns');
      rule(inf + p, inf, [], V, 'with pronouns');
    });
  });

  // hablándome -> hablar, comiéndoselo -> comer / vivir.
  var ACCENTED_GER = { ar: ['ándo', 'ar'], er: ['iéndo', 'er'], ir: ['iéndo', 'ir'] };
  Object.keys(ACCENTED_GER).forEach(function (klass) {
    var ger = ACCENTED_GER[klass][0];
    var inf = ACCENTED_GER[klass][1];
    ONE.concat(TWO).forEach(function (p) {
      rule(ger + p, inf, [], V, 'gerund with pronoun');
    });
  });

  // ---------------------------------------------------------------------
  // The irregular verbs, listed as whole forms rather than derived from a
  // stem, the same way deinflect-it.js lists Italian's and deinflect.js
  // lists する. These are the verbs whose stems change so much between
  // tenses that no suffix rule could connect them: ir is voy, fui, iba and
  // iré, which share nothing at all.
  //
  // The future and conditional are not listed, only the stem they are both
  // built on (tendr-, dir-, habr-), since those two tenses are perfectly
  // regular on top of it even for the most irregular verb in the language.
  // ---------------------------------------------------------------------
  var IRREGULAR = {
    ser: {
      pres: ['soy', 'eres', 'sos', 'es', 'somos', 'sois', 'son'],
      impf: ['era', 'eras', 'éramos', 'erais', 'eran'],
      pret: ['fui', 'fuiste', 'fue', 'fuimos', 'fuisteis', 'fueron'],
      subj: ['sea', 'seas', 'seamos', 'seáis', 'sean'],
      past: ['fuera', 'fueras', 'fuéramos', 'fuerais', 'fueran',
             'fuese', 'fueses', 'fuésemos', 'fueseis', 'fuesen'],
      futStem: 'ser', pp: 'sido', ger: 'siendo'
    },
    estar: {
      pres: ['estoy', 'estás', 'está', 'estamos', 'estáis', 'están'],
      impf: ['estaba', 'estabas', 'estábamos', 'estabais', 'estaban'],
      pret: ['estuve', 'estuviste', 'estuvo', 'estuvimos', 'estuvisteis', 'estuvieron'],
      subj: ['esté', 'estés', 'estemos', 'estéis', 'estén'],
      past: ['estuviera', 'estuvieras', 'estuviéramos', 'estuvierais', 'estuvieran',
             'estuviese', 'estuvieses', 'estuviésemos', 'estuvieseis', 'estuviesen'],
      futStem: 'estar', pp: 'estado', ger: 'estando'
    },
    haber: {
      pres: ['he', 'has', 'ha', 'hay', 'hemos', 'habéis', 'han'],
      impf: ['había', 'habías', 'habíamos', 'habíais', 'habían'],
      pret: ['hube', 'hubiste', 'hubo', 'hubimos', 'hubisteis', 'hubieron'],
      subj: ['haya', 'hayas', 'hayamos', 'hayáis', 'hayan'],
      past: ['hubiera', 'hubieras', 'hubiéramos', 'hubierais', 'hubieran',
             'hubiese', 'hubieses', 'hubiésemos', 'hubieseis', 'hubiesen'],
      futStem: 'habr', pp: 'habido', ger: 'habiendo'
    },
    ir: {
      pres: ['voy', 'vas', 'va', 'vamos', 'vais', 'van'],
      impf: ['iba', 'ibas', 'íbamos', 'ibais', 'iban'],
      // ir and ser share their whole preterite; both are offered and the
      // dictionary decides, exactly as it does between rival classes above.
      pret: ['fui', 'fuiste', 'fue', 'fuimos', 'fuisteis', 'fueron'],
      subj: ['vaya', 'vayas', 'vayamos', 'vayáis', 'vayan'],
      past: ['fuera', 'fueras', 'fuéramos', 'fuerais', 'fueran',
             'fuese', 'fueses', 'fuésemos', 'fueseis', 'fuesen'],
      futStem: 'ir', pp: 'ido', ger: 'yendo'
    },
    tener: {
      pres: ['tengo', 'tienes', 'tenés', 'tiene', 'tenemos', 'tenéis', 'tienen'],
      impf: ['tenía', 'tenías', 'teníamos', 'teníais', 'tenían'],
      pret: ['tuve', 'tuviste', 'tuvo', 'tuvimos', 'tuvisteis', 'tuvieron'],
      subj: ['tenga', 'tengas', 'tengamos', 'tengáis', 'tengan'],
      past: ['tuviera', 'tuvieras', 'tuviéramos', 'tuvierais', 'tuvieran',
             'tuviese', 'tuvieses', 'tuviésemos', 'tuvieseis', 'tuviesen'],
      futStem: 'tendr', pp: 'tenido', ger: 'teniendo'
    },
    hacer: {
      pres: ['hago', 'haces', 'hace', 'hacemos', 'hacéis', 'hacen'],
      impf: ['hacía', 'hacías', 'hacíamos', 'hacíais', 'hacían'],
      pret: ['hice', 'hiciste', 'hizo', 'hicimos', 'hicisteis', 'hicieron'],
      subj: ['haga', 'hagas', 'hagamos', 'hagáis', 'hagan'],
      past: ['hiciera', 'hicieras', 'hiciéramos', 'hicierais', 'hicieran',
             'hiciese', 'hicieses', 'hiciésemos', 'hicieseis', 'hiciesen'],
      futStem: 'har', pp: 'hecho', ger: 'haciendo'
    },
    poder: {
      pres: ['puedo', 'puedes', 'puede', 'podemos', 'podéis', 'pueden'],
      impf: ['podía', 'podías', 'podíamos', 'podíais', 'podían'],
      pret: ['pude', 'pudiste', 'pudo', 'pudimos', 'pudisteis', 'pudieron'],
      subj: ['pueda', 'puedas', 'podamos', 'podáis', 'puedan'],
      past: ['pudiera', 'pudieras', 'pudiéramos', 'pudierais', 'pudieran',
             'pudiese', 'pudieses', 'pudiésemos', 'pudieseis', 'pudiesen'],
      futStem: 'podr', pp: 'podido', ger: 'pudiendo'
    },
    poner: {
      pres: ['pongo', 'pones', 'pone', 'ponemos', 'ponéis', 'ponen'],
      impf: ['ponía', 'ponías', 'poníamos', 'poníais', 'ponían'],
      pret: ['puse', 'pusiste', 'puso', 'pusimos', 'pusisteis', 'pusieron'],
      subj: ['ponga', 'pongas', 'pongamos', 'pongáis', 'pongan'],
      past: ['pusiera', 'pusieras', 'pusiéramos', 'pusierais', 'pusieran',
             'pusiese', 'pusieses', 'pusiésemos', 'pusieseis', 'pusiesen'],
      futStem: 'pondr', pp: 'puesto', ger: 'poniendo'
    },
    decir: {
      pres: ['digo', 'dices', 'decís', 'dice', 'decimos', 'dicen'],
      impf: ['decía', 'decías', 'decíamos', 'decíais', 'decían'],
      pret: ['dije', 'dijiste', 'dijo', 'dijimos', 'dijisteis', 'dijeron'],
      subj: ['diga', 'digas', 'digamos', 'digáis', 'digan'],
      past: ['dijera', 'dijeras', 'dijéramos', 'dijerais', 'dijeran',
             'dijese', 'dijeses', 'dijésemos', 'dijeseis', 'dijesen'],
      futStem: 'dir', pp: 'dicho', ger: 'diciendo'
    },
    venir: {
      pres: ['vengo', 'vienes', 'venís', 'viene', 'venimos', 'vienen'],
      impf: ['venía', 'venías', 'veníamos', 'veníais', 'venían'],
      pret: ['vine', 'viniste', 'vino', 'vinimos', 'vinisteis', 'vinieron'],
      subj: ['venga', 'vengas', 'vengamos', 'vengáis', 'vengan'],
      past: ['viniera', 'vinieras', 'viniéramos', 'vinierais', 'vinieran',
             'viniese', 'vinieses', 'viniésemos', 'vinieseis', 'viniesen'],
      futStem: 'vendr', pp: 'venido', ger: 'viniendo'
    },
    ver: {
      pres: ['veo', 'ves', 've', 'vemos', 'veis', 'ven'],
      impf: ['veía', 'veías', 'veíamos', 'veíais', 'veían'],
      pret: ['vi', 'viste', 'vio', 'vimos', 'visteis', 'vieron'],
      subj: ['vea', 'veas', 'veamos', 'veáis', 'vean'],
      past: ['viera', 'vieras', 'viéramos', 'vierais', 'vieran',
             'viese', 'vieses', 'viésemos', 'vieseis', 'viesen'],
      futStem: 'ver', pp: 'visto', ger: 'viendo'
    },
    dar: {
      pres: ['doy', 'das', 'da', 'damos', 'dais', 'dan'],
      impf: ['daba', 'dabas', 'dábamos', 'dabais', 'daban'],
      pret: ['di', 'diste', 'dio', 'dimos', 'disteis', 'dieron'],
      subj: ['dé', 'des', 'demos', 'deis', 'den'],
      past: ['diera', 'dieras', 'diéramos', 'dierais', 'dieran',
             'diese', 'dieses', 'diésemos', 'dieseis', 'diesen'],
      futStem: 'dar', pp: 'dado', ger: 'dando'
    },
    saber: {
      pres: ['sé', 'sabes', 'sabe', 'sabemos', 'sabéis', 'saben'],
      impf: ['sabía', 'sabías', 'sabíamos', 'sabíais', 'sabían'],
      pret: ['supe', 'supiste', 'supo', 'supimos', 'supisteis', 'supieron'],
      subj: ['sepa', 'sepas', 'sepamos', 'sepáis', 'sepan'],
      past: ['supiera', 'supieras', 'supiéramos', 'supierais', 'supieran',
             'supiese', 'supieses', 'supiésemos', 'supieseis', 'supiesen'],
      futStem: 'sabr', pp: 'sabido', ger: 'sabiendo'
    },
    querer: {
      pres: ['quiero', 'quieres', 'quiere', 'queremos', 'queréis', 'quieren'],
      impf: ['quería', 'querías', 'queríamos', 'queríais', 'querían'],
      pret: ['quise', 'quisiste', 'quiso', 'quisimos', 'quisisteis', 'quisieron'],
      subj: ['quiera', 'quieras', 'queramos', 'queráis', 'quieran'],
      past: ['quisiera', 'quisieras', 'quisiéramos', 'quisierais', 'quisieran',
             'quisiese', 'quisieses', 'quisiésemos', 'quisieseis', 'quisiesen'],
      futStem: 'querr', pp: 'querido', ger: 'queriendo'
    },
    salir: {
      pres: ['salgo', 'sales', 'salís', 'sale', 'salimos', 'salen'],
      impf: ['salía', 'salías', 'salíamos', 'salíais', 'salían'],
      pret: ['salí', 'saliste', 'salió', 'salimos', 'salisteis', 'salieron'],
      subj: ['salga', 'salgas', 'salgamos', 'salgáis', 'salgan'],
      past: ['saliera', 'salieras', 'saliéramos', 'salierais', 'salieran',
             'saliese', 'salieses', 'saliésemos', 'salieseis', 'saliesen'],
      futStem: 'saldr', pp: 'salido', ger: 'saliendo'
    },
    traer: {
      pres: ['traigo', 'traes', 'trae', 'traemos', 'traéis', 'traen'],
      impf: ['traía', 'traías', 'traíamos', 'traíais', 'traían'],
      pret: ['traje', 'trajiste', 'trajo', 'trajimos', 'trajisteis', 'trajeron'],
      subj: ['traiga', 'traigas', 'traigamos', 'traigáis', 'traigan'],
      past: ['trajera', 'trajeras', 'trajéramos', 'trajerais', 'trajeran',
             'trajese', 'trajeses', 'trajésemos', 'trajeseis', 'trajesen'],
      futStem: 'traer', pp: 'traído', ger: 'trayendo'
    }
  };

  Object.keys(IRREGULAR).forEach(function (infinitive) {
    var v = IRREGULAR[infinitive];
    [['pres', 'present'], ['impf', 'imperfect'], ['pret', 'preterite'],
     ['subj', 'subjunctive'], ['past', 'past subjunctive']].forEach(function (pair) {
      v[pair[0]].forEach(function (form) {
        // The same form can serve more than one person (fue is both "he
        // went" and "he was"); the solver drops the repeat itself, but not
        // a form that is already the infinitive.
        if (form === infinitive) return;
        rule(form, infinitive, [], V, pair[1]);
      });
    });
    FUTURE.forEach(function (e) { rule(v.futStem + e, infinitive, [], V, 'future'); });
    CONDITIONAL.forEach(function (e) { rule(v.futStem + e, infinitive, [], V, 'conditional'); });
    if (v.pp !== infinitive) rule(v.pp, infinitive, [], V, 'past participle');
    rule(v.ger, infinitive, [], V, 'gerund');

    // A gerund with a pronoun on it, for the verbs whose gerund the regular
    // rules above cannot reach: diciéndoselo comes off diciendo, and no
    // ending on it leads back to decir.
    var accented = accentGerund(v.ger);
    if (accented) {
      ONE.concat(TWO).forEach(function (p) {
        rule(accented + p, infinitive, [], V, 'gerund with pronoun');
      });
    }
  });

  /**
   * A gerund as it is written once a pronoun is attached: the stress does
   * not move, but it now needs writing down, and it always falls on the
   * vowel before the -ndo. diciendo -> diciéndo(selo).
   */
  function accentGerund(gerund) {
    var ACCENT = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú' };
    var at = gerund.length - 4;   // the vowel of -Vndo
    if (at < 0 || gerund.slice(at + 1) !== 'ndo') return null;
    var vowel = ACCENT[gerund.charAt(at)];
    if (!vowel) return null;
    return gerund.slice(0, at) + vowel + 'ndo';
  }

  // ---------------------------------------------------------------------
  // Nouns and adjectives.
  //
  // Number first: -s after a vowel, -es after a consonant. Then gender,
  // which for an adjective is the other half of the same job: a dictionary
  // lists alto, and the text says alta, altos, altas depending on what it is
  // describing.
  //
  // Spanish moves its written accent when a syllable is added, and a suffix
  // rule cannot reach into a stem to undo that, so the few endings where it
  // happens often enough to matter are listed outright: canciones is
  // canción, ingleses is inglés. The rest (joven/jóvenes, where the accent
  // appears rather than disappears) come from the dictionary's own index of
  // written-down forms.
  // ---------------------------------------------------------------------
  rule('s', '', [], NA, 'plural');
  rule('es', '', [], NA, 'plural');
  rule('ces', 'z', [], NA, 'plural');       // luces -> luz, veces -> vez
  rule('ones', 'ón', [], NA, 'plural');     // canciones -> canción
  rule('anes', 'án', [], NA, 'plural');     // capitanes -> capitán
  rule('ines', 'ín', [], NA, 'plural');     // jardines -> jardín
  rule('eses', 'és', [], NA, 'plural');     // ingleses -> inglés
  rule('ases', 'ás', [], NA, 'plural');     // compases -> compás

  rule('a', 'o', [], NA, 'feminine');
  rule('as', 'o', [], NA, 'feminine plural');
  rule('as', 'a', [], NA, 'plural');
  rule('os', 'o', [], NA, 'plural');

  // -mente adverbs are built on the feminine of the adjective, and the
  // dictionary does list most of them; this reaches the ones it does not.
  rule('mente', '', [], ['adj'], 'adverb');
  rule('amente', 'o', [], ['adj'], 'adverb');

  // Every rule above uses an empty `tin`, meaning "only the word exactly as
  // it appeared in the text". Nothing here chains: each Spanish form is one
  // step from its dictionary word, pronouns and accent included, because
  // the rules that undo a pronoun undo the accent with it. See
  // deinflect-latin.js, which does the walking.
});

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalDeinflectEs;
