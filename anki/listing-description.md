**Anki already knows which words you know.** Every card you've matured is a
word you decided on, and the whole point of building the deck was to stop
being asked about them. This gets that list back out.

**Tools → Export Known Words…**

### Three ways out

* **Save as text**: one word per line, which is what most things read.
* **Copy**: the same, on the clipboard.
* **Save for Torval**: JSON, with the date each word was first studied.

### What Torval is

[Torval](https://github.com/jacobgerritz/Torval) is a free, open-source pop-up
dictionary for Japanese, Italian and Spanish. Hold Shift over a word on any
page and it tells you what the word means. It also works out how much of a
page or a video is built from words you already know, and sends words to
Anki.

That last part starts from an empty list, which is where this add-on comes
in. Torval only knows what you've marked while reading, so on day one it
knows nothing about the years you've already put in. Your deck does. Load the
file under **Settings → Words → Keeping a copy → Load from a file**.

Only one of the three buttons is about Torval, though. A plain list of words,
one per line, is read by plenty of other things, and the JSON is only there
because a text file can't carry a date.

### What it exports

Four kinds of card, each a tick box, all on by default:

* **Mature**: a review card at 21 days or more, Anki's own definition.
* **Young**: a review card under 21 days.
* **Learning**: a card you're part way through learning.
* **Relearning**: one you forgot and are learning again.

Exporting only mature cards looks like the right call, but it isn't. A word
you're three days into learning is still a word you recognise in a subtitle,
and leaving it out makes any estimate say a text is harder than it is. New
cards are never included: a card you've never seen is a word you've never
studied.

**One deck at a time**, and there's no whole-collection option. A collection
is usually more than one language, and mixing two of them into one list makes
it useless. It opens on whichever deck is open in Anki.

Words come out oldest first, roughly the order you learned them in.
Alphabetical would tell you nothing.

### What it does to the text

The field is cleaned before the word comes out: HTML, Anki's `漢字[かんじ]`
furigana, `[sound:…]` tags, cloze markers and HTML entities all go.

One tick box for the rest. **Drop a leading article** turns *il cane* into
*cane*. Plenty of decks put the article on the card, since for a Romance noun
the gender is half of what there is to know, but it isn't part of the word
and no text would ever be searched for it.

### The file it writes

Named for the deck and the day, so exporting three decks in one afternoon
gives you three files you can tell apart. The JSON is called
`anki-known-words-…` rather than the name Torval uses for its own backups, so
the two can't be confused.

Free and open source, GPL-3.0.
Source and issues: <https://github.com/jacobgerritz/Torval>
