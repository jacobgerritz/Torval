# Export Known Words

An Anki add-on that gets your known words back out of your collection.

Anki already knows which words you know. Every card you have matured is a
word you decided on, and the whole point of having built the deck is never
to be asked about those words again. This hands that list to whatever you
want to feed it to.

**Tools → Export Known Words…**

## Three ways out

| | |
|---|---|
| **Save as text** | one word per line, which is what most things read |
| **Copy** | the same, on the clipboard |
| **Save for Torval** | JSON in [Torval](https://github.com/jacobgerritz/Torval)'s own format |

Torval is a pop-up dictionary for Japanese, Italian and Spanish that keeps
a list of the words you already know and uses it to say how much of a page
you will understand. Its format is the plain list plus a date per word,
taken from when the card was made, which is what a text file cannot carry.
It also makes loading the same export twice harmless: Torval keeps the
earlier of the two dates, so nothing is overwritten and nothing is counted
again. Load it under **Settings → Words → Keeping a copy → Load from a
file**.

If the field you pick holds sentences rather than single words, Torval
breaks each one into the words inside it as it loads, so a sentence deck
works too. It keeps only the words the dictionary has for the language
you are reading, and says how many it left out.

Both files are named for the deck and the day: `known-words-Spanish-
Verbs-2026-09-21.txt` and `anki-known-words-Spanish-Verbs-2026-09-21.json`.
The deck is in the name because exporting three decks in one afternoon
otherwise writes one filename three times, and the JSON does not use
Torval's own `torval-words-<date>.json`, so the two never sit in a
Downloads folder looking like the same file.

Nothing here is specific to Torval except that one button. The text file
and the clipboard are the general case.

## One deck at a time

There is no "whole collection" option. A collection is usually more than
one language, and a known-words list with two languages in it is not a
known-words list, it is a mess that something downstream will quietly
believe. It opens on whichever deck is open in Anki.

## What it exports

Four kinds of card, each a tick box, all on by default:

| | |
|---|---|
| **Mature** | a review card at 21 days or more, Anki's own definition |
| **Young** | a review card under 21 days |
| **Learning** | a card you are part way through learning |
| **Relearning** | one you forgot and are learning again |

Mature cards on their own are the obvious thing to export and the wrong
thing. A word you are three days into learning is still a word you know
when you meet it in a subtitle, and counting it as unknown makes any
comprehension estimate say a text is harder than it is.

New cards are not offered. A card you have never seen is a word you have
never studied.

Words come out oldest first, which is the order you learned them in.
Alphabetical would be an order nobody learned anything in.

## What it does to the text

The field is cleaned before the word comes out of it: HTML, Anki's
`漢字[かんじ]` furigana, `[sound:…]` tags, cloze markers and HTML entities
all go.

There is one tick box for the rest. **Drop a leading article** turns
*il cane* into *cane*. Plenty of decks put the article on the card,
because for a Romance noun the gender is half of what there is to know,
but it is not part of the word and would never be found in a text.

## Installing

Copy this folder into Anki's `addons21` directory and restart Anki. On
Linux with the Flatpak build that is

```
~/.var/app/net.ankiweb.Anki/data/Anki2/addons21/
```

Anki takes an add-on's name from a `meta.json` it writes itself at
install time, so a folder copied in by hand is listed under **Tools →
Add-ons** by its folder name instead. One file fixes that:

```
echo '{"name": "Export Known Words", "disabled": false}' \
  > ~/.var/app/net.ankiweb.Anki/data/Anki2/addons21/known_words_export/meta.json
```

It is not in this repository because Anki owns that file, rewrites it,
and keeps the add-on's settings in it. Installing from AnkiWeb writes it
for you and none of this applies.

## Packaging it for AnkiWeb

A `.ankiaddon` file is a plain zip of this folder's *contents*, without the
folder itself and without the two things Anki writes into an installed copy:

```
cd anki/known_words_export
zip -qXr ../known-words-export.ankiaddon . -x "meta.json" "__pycache__/*"
```

AnkiWeb rejects an archive containing `__pycache__`, and `meta.json` is the
file it writes for itself at install time. Upload with the button on
<https://ankiweb.net/shared/addons/>. The name and description shown to
people come from that page, not from `manifest.json`: Anki only reads the
`conflicts` key out of a manifest it downloaded.

It is one Python file on purpose.
