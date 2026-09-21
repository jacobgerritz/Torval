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
works too. The file is named `anki-known-words-<date>.json`, which is not
what Torval calls its own backups, so the two never sit in a Downloads
folder looking like the same thing.

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

It is one Python file on purpose.
