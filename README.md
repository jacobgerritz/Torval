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

**2. Load it into Firefox.** Go to `about:debugging` → *This Firefox* → *Load
Temporary Add-on…* and pick `extension/manifest.json`.

The first time it runs, the extension spends a minute copying the dictionary
into the browser's own storage. A percentage shows on the toolbar button while
it does. That happens once, not once per session.

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

- **Anki cards.** One key to turn the word on screen into a card, with the
  sentence it came from.
- **Known and unknown words.** Colour every word on the page by whether you have
  met it, the way Migaku does.
- **Subtitle mining.** Cards that carry the audio and the frame they came from.

The lookup result already carries everything a card needs, so the first of these
does not require anything here to be rewritten.

---

## Dictionary data

The dictionary is **JMdict**, from the [Electronic Dictionary Research and
Development Group](https://www.edrdg.org/), used under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). It is the same
data Jisho.org is built on. It is downloaded by the build script and is not
stored in this repository; if you ever distribute a packaged copy of this
extension, that copy carries the dictionary's licence with it.

The code is MIT — see [LICENSE](LICENSE).
