/*
 * Torval, English deinflection
 *
 * A dictionary lists "walk" and "happy". A page says "walked", "walking",
 * "happier". Before one can be looked up the other has to be undone:
 *
 *     walked    ->  walk
 *     stopping  ->  stop
 *     tried     ->  try
 *     happiest  ->  happy
 *     knives    ->  knife
 *
 * Same shape as deinflect-it.js and deinflect-es.js, walked by the solver
 * in deinflect-latin.js. English needs a much shorter table than either,
 * because its verbs have four forms rather than forty, and the few that
 * misbehave misbehave completely rather than by rule: "went" is not "go"
 * plus anything. Those come from the dictionary's own index of forms, not
 * from here, which is the same division of labour the other two use.
 *
 * The one thing English does that the Romance languages do not is double
 * the final consonant before a suffix: stop/stopping, big/bigger,
 * travel/travelled. A suffix rule cannot see that it happened, because
 * "pping" and "ping" are both real endings, so every doubled consonant
 * gets its own pair of rules. They are generated in a loop rather than
 * written out twenty times over, which is the only reason this file has
 * any code in it at all.
 *
 * Contractions are undone too. "don't", "we'll" and "she's" are written as
 * one word and are not dictionary entries, so hovering one finds nothing
 * unless the tail comes off first.
 */

if (typeof TorvalDeinflectLatin === 'undefined' && typeof require !== 'undefined') {
  var TorvalDeinflectLatin = require('./deinflect-latin.js');
}

var TorvalDeinflectEn = TorvalDeinflectLatin.build(function (rule) {
  'use strict';

  var V = ['v'];
  var N = ['n'];
  var ADJ = ['adj'];
  var NA = ['n', 'adj'];

  // --- plurals and third person, which share their endings ---------------
  // "walks" is a verb or a noun depending on the sentence, and nothing here
  // can tell which, so both readings are offered and the lookup picks.
  rule('s', '', [], ['n', 'v'], 'plural');
  rule('es', '', [], ['n', 'v'], 'plural');
  rule('ies', 'y', [], ['n', 'v'], 'plural');      // cities -> city
  rule('ves', 'f', [], N, 'plural');               // wolves -> wolf
  rule('ves', 'fe', [], N, 'plural');              // knives -> knife
  rule('sses', 'ss', [], ['n', 'v'], 'plural');    // glasses -> glass
  rule('ches', 'ch', [], ['n', 'v'], 'plural');    // watches -> watch
  rule('shes', 'sh', [], ['n', 'v'], 'plural');    // wishes -> wish
  rule('xes', 'x', [], ['n', 'v'], 'plural');      // boxes -> box
  rule('zes', 'z', [], ['n', 'v'], 'plural');      // quizzes handled below
  rule('oes', 'o', [], ['n', 'v'], 'plural');      // heroes -> hero

  // --- past and past participle ------------------------------------------
  rule('ed', '', [], V, 'past');                   // walked -> walk
  rule('ed', 'e', [], V, 'past');                  // liked -> like
  rule('ied', 'y', [], V, 'past');                 // tried -> try

  // --- continuous ---------------------------------------------------------
  rule('ing', '', [], V, 'continuous');            // walking -> walk
  rule('ing', 'e', [], V, 'continuous');           // making -> make

  // --- comparison ---------------------------------------------------------
  rule('er', '', [], ADJ, 'comparative');          // taller -> tall
  rule('er', 'e', [], ADJ, 'comparative');         // larger -> large
  rule('ier', 'y', [], ADJ, 'comparative');        // happier -> happy
  rule('est', '', [], ADJ, 'superlative');
  rule('est', 'e', [], ADJ, 'superlative');
  rule('iest', 'y', [], ADJ, 'superlative');       // happiest -> happy

  // --- adverbs ------------------------------------------------------------
  // Most -ly adverbs are listed in their own right, so these are for the
  // ones that are not, the same job the -mente rules do in Spanish.
  rule('ly', '', [], ADJ, 'adverb');               // quickly -> quick
  rule('ily', 'y', [], ADJ, 'adverb');             // easily -> easy
  rule('ly', 'le', [], ADJ, 'adverb');             // simply -> simple

  // --- agent nouns --------------------------------------------------------
  rule('er', '', [], V, 'agent');                  // teacher -> teach
  rule('or', '', [], V, 'agent');                  // actor -> act

  /*
   * The doubled final consonant.
   *
   * English doubles a single final consonant after a short vowel before a
   * suffix that starts with one: stop/stopped, big/bigger, run/running.
   * The suffix rules above cannot undo it, because they only ever see the
   * ending, and "hopped" and "looked" end the same way as far as a suffix
   * is concerned.
   *
   * So each consonant that actually doubles gets its own rules. c, q, v, w,
   * x and y are left out because they do not double in English spelling,
   * and h and j because nothing ends in them this way.
   */
  var DOUBLES = ['b', 'd', 'g', 'l', 'm', 'n', 'p', 'r', 't', 'z'];
  var AFTER = [
    ['ed', V, 'past'],
    ['ing', V, 'continuous'],
    ['er', ADJ, 'comparative'],
    ['est', ADJ, 'superlative'],
    ['er', V, 'agent'],
    ['es', ['n', 'v'], 'plural']
  ];
  DOUBLES.forEach(function (letter) {
    AFTER.forEach(function (suffix) {
      rule(letter + letter + suffix[0], letter, [], suffix[1], suffix[2]);
    });
  });

  /*
   * Contractions.
   *
   * These undo the tail and leave the head, which is the word somebody
   * hovering "don't" is asking about. "n't" comes off as a whole because
   * the apostrophe is part of it, and "can't" loses two letters rather
   * than one, so it gets a rule of its own.
   */
  rule("n't", '', [], V, 'negative');              // don't -> do
  rule("can't", 'can', [], V, 'negative');
  rule("won't", 'will', [], V, 'negative');
  rule("'re", '', [], [], 'contraction');          // we're -> we
  rule("'ll", '', [], [], 'contraction');          // we'll -> we
  rule("'ve", '', [], [], 'contraction');          // we've -> we
  rule("'d", '', [], [], 'contraction');           // we'd -> we
  rule("'m", '', [], [], 'contraction');           // I'm -> I
  rule("'s", '', [], NA, 'possessive');            // the dog's -> dog

  // The curly apostrophe, which is what most sites actually publish. Same
  // rules again rather than normalising the word first, because the word
  // has to keep its own spelling to be marked on the page.
  rule('n’t', '', [], V, 'negative');
  rule('’re', '', [], [], 'contraction');
  rule('’ll', '', [], [], 'contraction');
  rule('’ve', '', [], [], 'contraction');
  rule('’d', '', [], [], 'contraction');
  rule('’m', '', [], [], 'contraction');
  rule('’s', '', [], NA, 'possessive');
});

if (typeof module !== 'undefined' && module.exports) module.exports = TorvalDeinflectEn;
