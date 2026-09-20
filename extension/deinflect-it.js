/*
 * Torval, Italian deinflection
 *
 * An Italian dictionary only lists the infinitive ("parlare") and the
 * singular ("libro"). Before a conjugated or inflected word on a page can be
 * looked up, whatever was done to it has to be undone:
 *
 *     parlavamo  ->  parlare
 *     libri      ->  libro
 *
 * This is a table of small reversible suffix rules, walked by the solver in
 * deinflect-latin.js, which is deinflect.js's own engine with the Japanese
 * taken out of it. What lives here is entirely rule *content*, because
 * Italian grammar is not Japanese grammar and is not Spanish grammar
 * either.
 *
 * Two things make the Italian table simpler than the Japanese one:
 *
 *  - Every regular tense here is one step from the infinitive (parlavamo is
 *    reached from parlare directly, there is no chain of endings stacked on
 *    endings the way て-form compounds work in Japanese), so most rules do
 *    not need to check an input type at all: `tin` is left empty, meaning
 *    "applies to the surface form as typed", and the resulting `tout` is
 *    checked against the dictionary the same way JMdict part-of-speech tags
 *    are, just with a much smaller tag set: 'v' (verb), 'n' (noun),
 *    'adj' (adjective).
 *
 *  - Suffix collisions across conjugation classes are rare (an -are ending
 *    essentially never doubles as an -ere or -ire one), so unlike Japanese's
 *    godan table, which has to be looked up by verb type because the same
 *    kana ending means different things for different stems, one flat table
 *    covers all three classes: whichever guess turns out to name a real
 *    dictionary entry is the right one, exactly the way JMdict's
 *    part-of-speech check is what actually decides between rival Japanese
 *    guesses rather than the rule table trying to know in advance.
 *
 * v1 covers regular -are/-ere/-ire conjugation (presente, imperfetto, futuro
 * semplice, condizionale presente, participio passato, gerundio) across the
 * dozen most common irregular verbs, and regular noun/adjective pluralization.
 * Reflexive verbs, clitic pronoun attachment (mandarglielo), passato remoto
 * and the subjunctive are not attempted: a word using them simply will not
 * match, the same as any word outside deinflect.js's own coverage.
 */

if (typeof TorvalDeinflectLatin === 'undefined' && typeof require !== 'undefined') {
  var TorvalDeinflectLatin = require('./deinflect-latin.js');
}

var TorvalDeinflectIt = TorvalDeinflectLatin.build(function (rule) {
  'use strict';

  // ---------------------------------------------------------------------
  // Regular conjugation, one stem-ending table per class. `stem` is dropped
  // from the tense endings below; empty string keeps the ending exactly as
  // written, since these tables list the ending on its own, not the whole verb.
  // ---------------------------------------------------------------------
  var REGULAR = {
    'v-are': {
      inf: 'are',
      pres: ['o', 'i', 'a', 'iamo', 'ate', 'ano'],
      impf: ['avo', 'avi', 'ava', 'avamo', 'avate', 'avano'],
      fut: ['erò', 'erai', 'erà', 'eremo', 'erete', 'eranno'],
      cond: ['erei', 'eresti', 'erebbe', 'eremmo', 'ereste', 'erebbero'],
      pp: 'ato',
      ger: 'ando'
    },
    'v-ere': {
      inf: 'ere',
      pres: ['o', 'i', 'e', 'iamo', 'ete', 'ono'],
      impf: ['evo', 'evi', 'eva', 'evamo', 'evate', 'evano'],
      fut: ['erò', 'erai', 'erà', 'eremo', 'erete', 'eranno'],
      cond: ['erei', 'eresti', 'erebbe', 'eremmo', 'ereste', 'erebbero'],
      pp: 'uto',
      ger: 'endo'
    },
    'v-ire': {
      inf: 'ire',
      // Plain (dormire) and -isc- (capire) both included; whichever guess
      // names a real dictionary entry is the right one, see the note above.
      pres: ['o', 'i', 'e', 'iamo', 'ite', 'ono', 'isco', 'isci', 'isce', 'iscono'],
      impf: ['ivo', 'ivi', 'iva', 'ivamo', 'ivate', 'ivano'],
      fut: ['irò', 'irai', 'irà', 'iremo', 'irete', 'iranno'],
      cond: ['irei', 'iresti', 'irebbe', 'iremmo', 'ireste', 'irebbero'],
      pp: 'ito',
      ger: 'endo'
    }
  };

  Object.keys(REGULAR).forEach(function (type) {
    var c = REGULAR[type];
    var T = ['v'];
    c.pres.forEach(function (e) { rule(e, c.inf, [], T, 'present'); });
    c.impf.forEach(function (e) { rule(e, c.inf, [], T, 'imperfect'); });
    c.fut.forEach(function (e) { rule(e, c.inf, [], T, 'future'); });
    c.cond.forEach(function (e) { rule(e, c.inf, [], T, 'conditional'); });
    rule(c.pp, c.inf, [], T, 'past participle');
    rule(c.ger, c.inf, [], T, 'gerund');
  });

  // ---------------------------------------------------------------------
  // The dozen most common irregular verbs, listed as complete forms rather
  // than derived from a stem: their stems change too much between tenses
  // for suffix substitution to be worth the complexity (avere -> ho, avrò,
  // avevo share no stem at all). Each is a direct, whole-word rule, the same
  // technique deinflect.js uses for します / して / した and the rest of する.
  // ---------------------------------------------------------------------
  var IRREGULAR = {
    essere: {
      pres: ['sono', 'sei', 'è', 'siamo', 'siete', 'sono'],
      impf: ['ero', 'eri', 'era', 'eravamo', 'eravate', 'erano'],
      fut: ['sarò', 'sarai', 'sarà', 'saremo', 'sarete', 'saranno'],
      cond: ['sarei', 'saresti', 'sarebbe', 'saremmo', 'sareste', 'sarebbero'],
      pp: 'stato', ger: 'essendo'
    },
    avere: {
      pres: ['ho', 'hai', 'ha', 'abbiamo', 'avete', 'hanno'],
      impf: ['avevo', 'avevi', 'aveva', 'avevamo', 'avevate', 'avevano'],
      fut: ['avrò', 'avrai', 'avrà', 'avremo', 'avrete', 'avranno'],
      cond: ['avrei', 'avresti', 'avrebbe', 'avremmo', 'avreste', 'avrebbero'],
      pp: 'avuto', ger: 'avendo'
    },
    andare: {
      pres: ['vado', 'vai', 'va', 'andiamo', 'andate', 'vanno'],
      impf: ['andavo', 'andavi', 'andava', 'andavamo', 'andavate', 'andavano'],
      fut: ['andrò', 'andrai', 'andrà', 'andremo', 'andrete', 'andranno'],
      cond: ['andrei', 'andresti', 'andrebbe', 'andremmo', 'andreste', 'andrebbero'],
      pp: 'andato', ger: 'andando'
    },
    fare: {
      pres: ['faccio', 'fai', 'fa', 'facciamo', 'fate', 'fanno'],
      impf: ['facevo', 'facevi', 'faceva', 'facevamo', 'facevate', 'facevano'],
      fut: ['farò', 'farai', 'farà', 'faremo', 'farete', 'faranno'],
      cond: ['farei', 'faresti', 'farebbe', 'faremmo', 'fareste', 'farebbero'],
      pp: 'fatto', ger: 'facendo'
    },
    stare: {
      pres: ['sto', 'stai', 'sta', 'stiamo', 'state', 'stanno'],
      impf: ['stavo', 'stavi', 'stava', 'stavamo', 'stavate', 'stavano'],
      fut: ['starò', 'starai', 'starà', 'staremo', 'starete', 'staranno'],
      cond: ['starei', 'staresti', 'starebbe', 'staremmo', 'stareste', 'starebbero'],
      pp: 'stato', ger: 'stando'
    },
    dare: {
      pres: ['do', 'dai', 'dà', 'diamo', 'date', 'danno'],
      impf: ['davo', 'davi', 'dava', 'davamo', 'davate', 'davano'],
      fut: ['darò', 'darai', 'darà', 'daremo', 'darete', 'daranno'],
      cond: ['darei', 'daresti', 'darebbe', 'daremmo', 'dareste', 'darebbero'],
      pp: 'dato', ger: 'dando'
    },
    dire: {
      pres: ['dico', 'dici', 'dice', 'diciamo', 'dite', 'dicono'],
      impf: ['dicevo', 'dicevi', 'diceva', 'dicevamo', 'dicevate', 'dicevano'],
      fut: ['dirò', 'dirai', 'dirà', 'diremo', 'direte', 'diranno'],
      cond: ['direi', 'diresti', 'direbbe', 'diremmo', 'direste', 'direbbero'],
      pp: 'detto', ger: 'dicendo'
    },
    potere: {
      pres: ['posso', 'puoi', 'può', 'possiamo', 'potete', 'possono'],
      impf: ['potevo', 'potevi', 'poteva', 'potevamo', 'potevate', 'potevano'],
      fut: ['potrò', 'potrai', 'potrà', 'potremo', 'potrete', 'potranno'],
      cond: ['potrei', 'potresti', 'potrebbe', 'potremmo', 'potreste', 'potrebbero'],
      pp: 'potuto', ger: 'potendo'
    },
    volere: {
      pres: ['voglio', 'vuoi', 'vuole', 'vogliamo', 'volete', 'vogliono'],
      impf: ['volevo', 'volevi', 'voleva', 'volevamo', 'volevate', 'volevano'],
      fut: ['vorrò', 'vorrai', 'vorrà', 'vorremo', 'vorrete', 'vorranno'],
      cond: ['vorrei', 'vorresti', 'vorrebbe', 'vorremmo', 'vorreste', 'vorrebbero'],
      pp: 'voluto', ger: 'volendo'
    },
    dovere: {
      pres: ['devo', 'devi', 'deve', 'dobbiamo', 'dovete', 'devono'],
      impf: ['dovevo', 'dovevi', 'doveva', 'dovevamo', 'dovevate', 'dovevano'],
      fut: ['dovrò', 'dovrai', 'dovrà', 'dovremo', 'dovrete', 'dovranno'],
      cond: ['dovrei', 'dovresti', 'dovrebbe', 'dovremmo', 'dovreste', 'dovrebbero'],
      pp: 'dovuto', ger: 'dovendo'
    },
    venire: {
      pres: ['vengo', 'vieni', 'viene', 'veniamo', 'venite', 'vengono'],
      impf: ['venivo', 'venivi', 'veniva', 'venivamo', 'venivate', 'venivano'],
      fut: ['verrò', 'verrai', 'verrà', 'verremo', 'verrete', 'verranno'],
      cond: ['verrei', 'verresti', 'verrebbe', 'verremmo', 'verreste', 'verrebbero'],
      pp: 'venuto', ger: 'venendo'
    },
    sapere: {
      pres: ['so', 'sai', 'sa', 'sappiamo', 'sapete', 'sanno'],
      impf: ['sapevo', 'sapevi', 'sapeva', 'sapevamo', 'sapevate', 'sapevano'],
      fut: ['saprò', 'saprai', 'saprà', 'sapremo', 'saprete', 'sapranno'],
      cond: ['saprei', 'sapresti', 'saprebbe', 'sapremmo', 'sapreste', 'saprebbero'],
      pp: 'saputo', ger: 'sapendo'
    }
  };

  Object.keys(IRREGULAR).forEach(function (infinitive) {
    var v = IRREGULAR[infinitive];
    var T = ['v'];
    ['pres', 'impf', 'fut', 'cond'].forEach(function (tense) {
      v[tense].forEach(function (form) {
        // The same form can serve more than one person (sono is both "I am"
        // and "they are"); only add it once.
        if (form === infinitive) return;
        rule(form, infinitive, [], T, tense);
      });
    });
    rule(v.pp, infinitive, [], T, 'past participle');
    rule(v.ger, infinitive, [], T, 'gerund');
  });

  // ---------------------------------------------------------------------
  // Regular noun/adjective plurals. Both "-i could be an -o plural or an -e
  // plural" guesses are proposed for the same reason the verb table above
  // proposes rival conjugation classes: whichever one turns out to be a real
  // dictionary entry is the answer, and this table does not have to know
  // which in advance.
  // ---------------------------------------------------------------------
  // Pronouns are in here because a possessive is one. Wiktionary files
  // Italian suo, mio, tuo as pronouns, and they agree in gender and number
  // exactly as an adjective does: sua, suoi, sue. Left out, the rules below
  // could not reach them, and "sue" was a word Torval found nothing at all
  // for, since it is the one form Wiktionary never wrote down as a page of
  // its own. sua, mie and tue only ever worked by being listed.
  var NA = ['n', 'adj', 'pron'];
  rule('i', 'o', [], NA, 'plural');
  rule('i', 'e', [], NA, 'plural');
  rule('e', 'a', [], NA, 'plural');

  // Agreement, which is the other half of what happens to an Italian
  // adjective and was missing entirely: a dictionary lists intero, and the
  // text says intera, intere, interi depending on what it is describing.
  // The plural rules above reached interi and nothing else, so stessa and
  // intere were words Torval could not find at all.
  //
  // These are a fallback rather than the main route: the dictionary itself
  // now carries every inflected form Wiktionary lists, pointed at the word
  // it belongs to (see build-dict-it.mjs), and an exact match always beats a
  // guess, because it takes no steps to reach. What the rules are for is the
  // word whose form Wiktionary never wrote down.
  rule('a', 'o', [], NA, 'feminine');
  rule('e', 'o', [], NA, 'feminine plural');

  // An empty `tin`, like deinflect.js's, means "only applies to the word
  // exactly as it appeared" — never as a second step chained onto an
  // already-typed intermediate result. Every rule in this file uses one on
  // purpose: Italian's core tenses are each one step from the surface form,
  // so nothing here needs to chain. See deinflect-latin.js, which does the
  // walking.
});

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalDeinflectIt;
