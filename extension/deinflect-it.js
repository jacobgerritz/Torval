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
 * dozen most common irregular verbs, regular noun/adjective pluralization,
 * and pronouns stuck on the end of an infinitive or a gerund (approcciarmi,
 * approcciandomi, andarsene). Passato remoto and the subjunctive are not
 * attempted: a word using them simply will not match, the same as any word
 * outside deinflect.js's own coverage.
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
  // Pronouns stuck on the end of the verb.
  //
  // This was the largest hole left in Italian, and it did not look like a
  // hole, because the commonest examples all worked: lavandomi, alzandosi
  // and parlandogli were in the dictionary as forms of their own, listed
  // by Wiktionary, and an exact match needs no rule. So the rules were
  // never missed until a verb Wiktionary had not enumerated came along.
  // "approcciandomi" is one, and there is no shortage of others: the
  // enclitic is productive, every verb in the language takes one, and no
  // dictionary can list them all.
  //
  // Italian sticks them onto the infinitive with its final e dropped
  // (approcciare -> approcciarmi), onto the gerund as it stands
  // (approcciandomi), and onto the affirmative imperative (dimmi). The
  // first two are rules; the third is left to the dictionary's index, the
  // same decision Spanish made in deinflect-es.js and for the same reason,
  // that an imperative is often irregular before any pronoun reaches it.
  //
  // A reflexive infinitive falls out of this for free: approcciarsi is
  // approcciare with si on the end, and Wiktionary has no page for it.
  // ---------------------------------------------------------------------
  var ONE = ['mi', 'ti', 'si', 'ci', 'vi', 'gli', 'le', 'ne', 'lo', 'la', 'li'];

  // Two of them together, and the first one changes its vowel when it
  // does: mi lo is melo, gli lo is glielo. Both pronouns always come in
  // this order, indirect before direct, so there is no second list.
  var TWO = [];
  ['me', 'te', 'se', 'ce', 've', 'glie'].forEach(function (indirect) {
    ['lo', 'la', 'li', 'le', 'ne'].forEach(function (direct) {
      TWO.push(indirect + direct);
    });
  });

  var CLITICS = ONE.concat(TWO);

  Object.keys(REGULAR).forEach(function (type) {
    var c = REGULAR[type];
    var T = ['v'];
    // The infinitive drops its final e before a pronoun: are -> ar.
    var shortened = c.inf.slice(0, -1);
    CLITICS.forEach(function (p) {
      rule(shortened + p, c.inf, [], T, 'with pronoun');
      rule(c.ger + p, c.inf, [], T, 'gerund with pronoun');
    });
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
    // The irregular gerunds need the pronoun rules spelled out, unlike the
    // irregular infinitives: farmi and dirlo already come out right,
    // because fare and dire end in -are and -ire and the regular rules
    // above reach them, while facendomi under the regular rule would give
    // "facere".
    CLITICS.forEach(function (p) {
      rule(v.ger + p, infinitive, [], T, 'gerund with pronoun');
    });
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

  // ---------------------------------------------------------------------
  // The accent somebody did not type.
  //
  // Italian only writes an accent on a final stressed vowel, and that is
  // exactly the accent people leave off: subtitles in particular are full
  // of "piu", "puo", "sara", "perche", "cioe" and "verita", and every one
  // of those was a word Torval found nothing at all for. They are not
  // obscure. In the five thousand commonest forms in the language, the
  // unaccented spellings were the largest group of misses that were
  // actually Italian rather than somebody's name.
  //
  // So a final vowel may also be that vowel with its accent. One extra
  // candidate per word, since only the vowel actually on the end can
  // match, and a wrong guess costs nothing: "casà" is not in any
  // dictionary and quietly finds nothing. The apostrophe forms are here
  // for the same reason, since a keyboard without accents writes "piu'".
  //
  // e gets both, because Italian uses both and the writer who left the
  // accent off was not choosing between them: perché takes é, cioè takes
  // è. This does mean "e" now also offers "è", and "da" offers "dà",
  // which is right: in text written without accents they really are
  // ambiguous, and the untouched word is still ranked first.
  //
  // Every part of speech, because this is a spelling, not a grammar.
  var ANY = ['v', 'n', 'adj', 'adv', 'prep', 'conj', 'intj', 'pron', 'num',
    'art', 'prt', 'pref', 'suf', 'abbr', 'contr', 'det', 'phrase'];
  var ACCENTS = {
    a: ['à'], e: ['è', 'é'], i: ['ì'], o: ['ò'], u: ['ù']
  };
  Object.keys(ACCENTS).forEach(function (plain) {
    ACCENTS[plain].forEach(function (accented) {
      rule(plain, accented, [], ANY, 'accent');
      rule(plain + "'", accented, [], ANY, 'accent');
      rule(plain + '\u2019', accented, [], ANY, 'accent');
    });
  });
  // And the one that is written with an accent, just the wrong one.
  rule('é', 'è', [], ANY, 'accent');
  rule('è', 'é', [], ANY, 'accent');

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
