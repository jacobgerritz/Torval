# LLL

A pop-up Japanese dictionary for Firefox. Hold **Shift** and point at a word;
its meaning appears next to the cursor. Everything is on your own machine — the
whole of JMdict, the dictionary Jisho is built from, lives in the browser. It
works with the network off.

---

## Setup

Two steps, once.

**1. Build the dictionary.** This downloads JMdict (about 10 MB) and converts it
into a form the extension can read quickly.

```bash
node tools/build-dict.mjs
```

Then the pitch accent data, which is separate and much smaller:

```bash
node tools/build-pitch.mjs
```

**2. Load it into Firefox.** Go to `about:debugging` → *This Firefox* → *Load
Temporary Add-on…* and pick `extension/manifest.json`.

The first time it runs, the extension spends a minute or so copying the
dictionary into the browser's own storage — 218,000 entries and 465,000
searchable forms. A percentage shows on the toolbar button while it does, and
until it reaches the end, hovering a word says so rather than answering.

This happens once, not once per session. It happens again only when the
dictionary format changes, which the version number in `meta.json` decides.
Progress is written down as it goes, so if it is interrupted it carries on from
where it stopped rather than starting over.

Temporary add-ons are removed when Firefox restarts, so you will need to load it
again each time until it is packaged and signed. That is a step for later.

---

## Using it

| | |
|---|---|
| **Shift** + point at a word | look it up |
| **Shift** with text selected | look up the selection |
| **Esc**, a click, a scroll | close |
| **shorter matches** | other words that start at the same place |

Two small numbers follow the reading. The one in brackets is the **pitch
accent**: 0 means the pitch never drops, otherwise it is the mora it drops
after; the diagram of it goes on the card rather than in the popup. The one
after the hash is how **common** the word is — its rank in a corpus of Japanese
media, so 読む is #414 and 図書館 is #7,261. A word with no number is one the
corpus never saw, which tells you something in itself.
| **+** | add the word to Anki |

While Shift is held the popup follows whatever you point at, and closes if you
point at something that is not a word. Let go of Shift and it stays put, so you
can move across and read it.

Point at the *first* character of a word. Japanese has no spaces, so the
extension reads forward from wherever you are pointing and finds the longest
thing that is a word — point at 日 in 日本語 and you get 日本語, not 日.

It undoes conjugation on the way. 食べなかった is not in any dictionary, so it is
walked back to 食べる and the steps taken are shown underneath, small and grey:
*negative → past*.

---

## Anki

Cards go straight into Anki through **AnkiConnect**, the Anki add-on that opens
a small server on your own machine. Anki has to be open; nothing leaves your
computer.

Open the settings from LLL's toolbar button and choose a deck and a note type.
Both lists are read from Anki itself, so a name can never be slightly wrong.
LLL then fills in the field mapping by guessing from the field names — a note
type with fields called *Target Word*, *Reading*, *Sentence* and *Definitions*
needs no setting up at all. Anything it guesses wrongly is one dropdown away,
and anything left blank stays empty on the card.

Four things can be put on a card:

| | |
|---|---|
| **Target word** | the dictionary form, so 食べなかった files under 食べる |
| **Reading** | the kana |
| **Sentence** | the whole sentence, with the word in bold |
| **Definition** | every sense, numbered |
| **Word audio** | a recording of the word, if one can be found |
| **Pitch accent** | the accent diagram, drawn as an SVG |

Audio comes from JapanesePod101's dictionary. It answers every request with an
mp3 and a 200 even when it has nothing, handing back a fixed "audio unavailable"
recording instead — so LLL hashes what comes back and discards that one, leaving
the field empty rather than filling your collection with identical clips. Anki
downloads and stores nothing itself; LLL passes it the file.

Pitch accents come from **Kanjium**, which derives from the NHK accent
dictionary and 大辞林 — the same data Yomitan and AJT Pitch Accent use. A word's
whole pattern follows from one number, where the pitch drops, and the diagram is
drawn from that: a dot per mora, high or low. The hollow dot on the end is the
particle that would follow, which is the only thing distinguishing 橋 (pitch
drops after it) from 日本語 (it does not). It is drawn in `currentColor`, so it
takes the colour of whatever card it lands on, night mode included.

A reading alone is not enough to place an accent — 箸, 橋 and 端 are all はし with
three different accents — so where the word cannot be identified the field is
left empty rather than guessed at.

The bold marks the word **as the page wrote it**, so a conjugated form is
highlighted in full — 「<b>食べなかった</b>ので、お腹が空いた。」 — while the Target
Word field still says 食べる.

Duplicates are refused, so pressing **+** on a word you already have tells you so
rather than making a second card.

---

## How it is put together

Five files do the work. None of them is long.

**`extension/deinflect.js`** — the grammar. A table of about 470 small rules,
each saying "a word ending in X might really be a word ending in Y". Applied
over and over, they turn any conjugated form back into the dictionary form.
Every rule is tagged with the kind of word it applies to, so the nonsense
answers get thrown away: 少ない could "become" the verb 少る, but no such verb
exists, so it is dropped.

**`extension/lookup.js`** — the search. Takes the text from the cursor, tries
every length from sixteen characters down to one, deinflects each, and keeps
whatever is really in the dictionary. Longest match wins; the shorter ones are
offered below it.

**`extension/background.js`** — the dictionary itself. Runs once for the whole
browser and owns the database. Pages ask it questions by message.

**`extension/content.js`** — the part on the page. Works out which character is
under the mouse, and draws the popup. The popup is built inside a *shadow root*,
a sealed-off document of its own, so no website's styling can reach it and it
looks the same everywhere.

**`extension/anki.js`** — the Anki side. One HTTP request to your own machine.

**`extension/pitch.js`** — pitch accents, and drawing them.

**`extension/options.js`** — the settings page.

**`extension/popup.css`** — how it looks. The only file that decides that.

### Working on the appearance

Reloading the extension to see a colour change is tedious, so there is a preview
page that runs the real popup code against a dozen sample words:

```bash
node tools/serve.mjs
```

Then open <http://localhost:8137/tools/preview.html>. Edit `popup.css`, refresh.

### Tests

```bash
node --max-old-space-size=4096 tools/test.mjs
```

Runs the real search code against the real dictionary — every godan verb ending,
the irregular verbs, adjectives, the copula, and the cases where the deinflector
would otherwise invent words that do not exist.

---

## Not yet

In rough order of intent:

- **Known and unknown words.** Colour every word on the page by whether you have
  met it, the way Migaku does.
- **Subtitle mining.** Cards that carry the audio and the frame they came from.
  The note type already has fields waiting for them.
- **Packaging.** Sign it, so it survives a Firefox restart.

---

## Dictionary data

Frequency ranks come from **JPDB**, scraped from a corpus of anime, manga, light
novels and visual novels — media Japanese rather than newspaper Japanese, which
is the point. They are attached to the entries when the dictionary is built, so
there is no separate file and no second lookup. They also decide which of two
equally good matches goes first, which JMdict's own priority markers did poorly:
those are coarse bands covering only the commonest 24,000 words.

The dictionary is **JMdict**, from the [Electronic Dictionary Research and
Development Group](https://www.edrdg.org/), used under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). It is the same
data Jisho.org is built on. It is downloaded by the build script and is not
stored in this repository; if you ever distribute a packaged copy of this
extension, that copy carries the dictionary's licence with it.

The code is MIT — see [LICENSE](LICENSE).
