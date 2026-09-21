# Export words to Torval

An Anki add-on that hands your known words to
[Torval](https://github.com/jacobgerritz/Torval), a pop-up dictionary for
Japanese, Italian and Spanish.

Torval learns which words you know from what you mark while reading, which
is fine from the day you install it and useless about the years before
that. Anki already knows.

## Using it

**Tools → Export words to Torval.** Pick a deck, or the whole collection,
and the field the word is in. Then either:

- **Save a file**, and load it in Torval under **Settings → Words →
  Keeping a copy → Load from a file**. The file carries a date per word,
  taken from when the card was made, and Torval merges rather than
  replaces, so loading it twice changes nothing.
- **Copy to clipboard**, and paste into **Settings → Words → Add from a
  text**. Simpler, and loses the dates.

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
when you meet it in a subtitle, and counting it as unknown makes Torval
say a page is harder than it is.

New cards are not offered. A card you have never seen is a word you have
never studied.

## What it does to the text

The field is cleaned up before the word comes out of it: HTML, Anki's
`漢字[かんじ]` furigana, `[sound:…]` tags and cloze markers all go.

There is one tick box for the rest. **Drop a leading article** turns
*il cane* into *cane*. Torval writes the article onto Italian and Spanish
cards, because the gender is half of what there is to know about a noun,
but it is not part of the word and would never be found in a text.

## Installing

Copy this folder into Anki's `addons21` directory and restart Anki. On
Linux with the Flatpak build that is

```
~/.var/app/net.ankiweb.Anki/data/Anki2/addons21/
```

It is one Python file on purpose.
