Gets the words you already know out of your collection, as a text file, on
the clipboard, or as JSON.

**Tools → Export Known Words…**

### Three ways out

* **Save as text**: one word per line.
* **Copy**: the same, on the clipboard.
* **Save for Torval**: JSON, with the date each word was first studied.

### What it exports

You pick a deck and a field, and it reads that field off every card in the
states you tick. Four of them, all on by default:

* **Mature**: a review card at 21 days or more, Anki's own definition.
* **Young**: a review card under 21 days.
* **Learning**: a card you're part way through learning.
* **Relearning**: one you forgot and are learning again.

Exporting only mature cards looks like the right call, but it isn't. A word
you're three days into learning is still a word you recognise when you meet
it, and leaving it out makes any estimate of what you know come out low. New
cards are never included: a card you've never seen is a word you've never
studied.

One deck at a time, and there's no whole-collection option. A collection is
usually more than one language, and mixing them into one list makes it
useless. It opens on whichever deck is open in Anki.

Words come out oldest first, roughly the order you learned them in.

### What it does to the text

A field usually holds more than the word. HTML, sound tags, cloze markers
and HTML entities are all stripped out, and Japanese furigana written the way
Anki writes it (`漢字[かんじ]`) is reduced to the kanji.

One tick box for the rest: **Drop a leading article** takes *il*, *la*,
*el*, *un* and the rest off the front, for decks that store a noun with its
article.

### The file it writes

Named for the deck and the day, so exporting several decks in a row doesn't
overwrite anything.

### If you use Torval

[Torval](https://github.com/jacobgerritz/Torval) is a free, open-source
pop-up dictionary for Japanese, Italian and Spanish. Hold Shift over a word
on any page and it tells you what the word means. It can also keep track of
the words you know, and that list starts empty, which is what the third
button is for. Load the file under **Settings → Words → Keeping a copy →
Load from a file**.

The other two buttons have nothing to do with it. A plain list of words, one
per line, is read by plenty of things; the JSON is only there because a text
file can't carry a date.

Free and open source, GPL-3.0.
Source and issues: <https://github.com/jacobgerritz/Torval>
