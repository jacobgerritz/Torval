# The AnkiWeb listing

Everything the upload form at <https://ankiweb.net/shared/addons/> asks for,
written out once so submitting is copying rather than composing. Kept out of
`known_words_export/` on purpose: that folder is what gets zipped into the
`.ankiaddon`, and this is not something to ship to people who install it.

The title here is the one users see. Anki reads only the `conflicts` key out
of a manifest it downloaded, so `manifest.json` has no say in the name once
the add-on comes from AnkiWeb.

---

**Title**

    Export Known Words

**Tags**

    export vocabulary known-words language-learning immersion subtitles torval json

**Support page**

    https://github.com/jacobgerritz/Torval/issues

**Branches.** One branch, because there is one file. Supports `2.1.50` to
`26.09`, with no `-` in front of the second number.

The floor is where `aqt.qt` and the modern add-on API settled, and the one
line that knew which Qt it was talking to has been made to work either way,
so the claim is true rather than hopeful. The ceiling is simply the newest
Anki this has been run on: without a `-` prefix it is not a cap, and AnkiWeb
keeps offering the add-on to versions above it. Writing `-26.09` would stop
that, which is for an add-on known to break on the next release, not for one
that merely has not met it yet. Raise the number when a newer Anki has been
tried.

---

## Description

Markdown and basic HTML both work in this field, but not all of markdown:
**tables do not render**, and a table pasted in comes out as a row of pipes
and dashes in the middle of a paragraph. Lists, headings, bold, italics,
`code` and links are all fine. Everything below the line is the description,
ready to paste.

---

**Anki already knows which words you know.** Every card you have matured is a
word you decided on, and the point of building the deck was never to be asked
about those words again. This gets that list back out.

**Tools → Export Known Words…**

### Three ways out

* **Save as text**: one word per line, which is what most things read.
* **Copy**: the same, on the clipboard.
* **Save for Torval**: JSON, with the date each word was first studied.

### What Torval is

[Torval](https://github.com/jacobgerritz/Torval) is a free, open-source pop-up
dictionary for Japanese, Italian and Spanish. Hold Shift over a word on any
page and it says what the word means; it also works out how much of a page or
a video is built from words you already know, and sends words to Anki.

That last part starts from an empty list, which is what this add-on is for.
Torval learns what you know from what you mark while reading, which is fine
from the day you install it and useless about the years before that. Your
deck is those years. Load the file under **Settings → Words → Keeping a copy
→ Load from a file**.

Only one of the three buttons is about Torval, though. A plain list of words,
one per line, is read by plenty of other things, and that is the general
case; the JSON exists because a text file cannot carry a date.

### What it exports

Four kinds of card, each a tick box, all on by default:

* **Mature**: a review card at 21 days or more, Anki's own definition.
* **Young**: a review card under 21 days.
* **Learning**: a card you are part way through learning.
* **Relearning**: one you forgot and are learning again.

Mature cards on their own are the obvious thing to export and the wrong
thing. A word you are three days into learning is still a word you know when
you meet it in a subtitle, and counting it as unknown makes any estimate say
a text is harder than it is. New cards are never included: a card you have
never seen is a word you have never studied.

**One deck at a time**, and no whole-collection option. A collection is
usually more than one language, and a known-words list with two languages in
it is not a known-words list. It opens on whichever deck is open in Anki.

Words come out oldest first, which is the order you learned them in.
Alphabetical is an order nobody learned anything in.

### What it does to the text

The field is cleaned before the word comes out of it: HTML, Anki's
`漢字[かんじ]` furigana, `[sound:…]` tags, cloze markers and HTML entities all
go.

One tick box for the rest. **Drop a leading article** turns *il cane* into
*cane*. Plenty of decks put the article on the card, because for a Romance
noun the gender is half of what there is to know, but it is not part of the
word and no text would ever be searched for it.

### The file it writes

Named for the deck and the day, so exporting three decks in one afternoon
gives you three files you can tell apart, and the JSON is
`anki-known-words-…` rather than the name Torval gives its own backups.

Free and open source, GPL-3.0.
Source and issues: <https://github.com/jacobgerritz/Torval>
