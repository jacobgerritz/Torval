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
| **A** / **D** | step back and forward a subtitle line |
| **click a sense** | put only that meaning on the card |
| **+** | add the word to Anki |

While Shift is held the popup follows whatever you point at, and closes if you
point at something that is not a word. Let go of Shift and it stays put, so you
can move across and read it.

Tags that hold for the whole word — `uk`, "usually written in kana" — sit beside
it rather than against every definition. JMdict files them per sense, but a tag
on *every* sense is describing the word, and 事 carrying "usually kana" ten times
over says nothing ten times. Where a tag really is on only some senses it stays
with them: 綺麗 is usually kana when it means "clean", not when it means "pretty",
and that is worth knowing. Part of speech works the same way: 勉強 is a
transitive suru-verb for one sense and intransitive for another and just a plain
noun for a third, so only "noun" — what every sense actually agrees on — sits
beside the word; each sense's own line carries whatever it adds beyond that.

Two small numbers follow the reading. The one in brackets is the **pitch
accent**: 0 means the pitch never drops, otherwise it is the mora it drops
after; the diagram of it goes on the card rather than in the popup. The other
is how **common** the word is: 読む is *top 1k*, 図書館 is *top 10k*.

That is a band rather than a rank on purpose. A bare number asks you to know the
scale already — #7,261 means nothing unless you have a feel for what #3,000 is
like — and it claims a precision the data does not have. The gap between #100
and #400 is real; the gap between #7,261 and #7,800 is noise. A round band says
both of those at once and needs no legend. The exact rank is on hover for when
it matters. A word with no band at all is one the corpus never saw, which tells
you something in itself.

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
| **Video frame** | the frame on screen when you pressed + |
| **Sentence audio** | the subtitle line, spoken |

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

Duplicates are allowed. A repeated word gets a small note the moment **+** is
pressed, before the slower work of capturing the sentence even starts — but the
card is made either way. One sentence often teaches several words, and mining
the same word again later is not a mistake either.

By default a card carries every sense of the word. Clicking a sense before
pressing **+** narrows it to the meanings you actually met — 語 is both "word;
term" and "language", and you rarely want both. Clicking nothing means all of
them, so the ordinary case needs no clicks.

---

## Subtitles, and mining from video

LLL times YouTube's Japanese subtitles so it knows exactly when each line
starts and ends — that timing is what lets a line be replayed and recorded
precisely, and what lets **A** and **D** jump between lines. **Keep YouTube's
own captions turned on**; LLL needs a genuine one active to work at its best,
for reasons covered below, and as a source of text to read either way. What
you actually see is drawn by LLL itself, in the same look as the popup —
YouTube's own caption box is hidden underneath it, so a line always reads as
LLL's.

There are four ways it gets the timing, tried in the order below — each a
fallback for the one before it, not a choice between them. The first three all
build a caption web address themselves, out of data YouTube's own page
publishes; none of them ever produced anything, on any video tried, no matter
how the request was made — a background-script fetch, a content-script fetch,
a rewritten request header, an injected response header. What finally worked
was not sending a better-formed request at all: it was not building the
address in the first place.

1. **Catch the address YouTube's own player already uses.** The address
   published in the page's own data is not, evidently, the one YouTube's own
   player actually requests when it genuinely fetches a caption track — so no
   amount of asking more carefully for *that* address was ever going to work.
   LLL watches the page's own network traffic for the real request instead,
   which happens the moment a caption track is genuinely active in the native
   player, and reuses that exact address. This needs a real caption track
   active at least once, which is exactly why YouTube's own captions should
   stay on.

   Catching the right address turned out not to be enough on its own. Even
   that address, provably the one YouTube's own player had just used
   successfully, still came back with a 200 and nothing in it when refetched
   from the content script — the same "blocked by OpaqueResponseBlocking"
   symptom from the very first attempt, which meant it was never really about
   which address was being asked for. Both fixes are needed together: LLL
   also adds the CORS permission the response never carries, using the same
   `webRequest` technique CORS-unblocking extensions use generally, scoped
   only to this one address.
2. **Ask for the transcript the way "Show transcript" does.** Not the
   closed-caption file — the separate panel YouTube's own player offers,
   reached through a one-time token buried in the page's own data.
3. **Ask YouTube for the closed-caption file directly.** The address LLL
   builds itself from the page's published data, tried as a fallback in case
   a future change makes it work again.
4. **Read the captions off the screen as they play**, timing each line by
   watching it appear and disappear. This is what the simplest subtitle tools
   do, and it always works, because it is only reading what is already there.
   The real cost: a line is known only once it has actually been shown, so
   nothing about the video is known ahead of watching it — **D** cannot jump
   ahead into an unseen line, and nothing here can answer "how much of this
   video will I understand" before you have already watched it. Rewatching a
   line does not duplicate it; seeing the same text again near where it was
   last seen just refreshes its timing.

Method 1 can arrive at any moment and supersede whichever of the others is
currently in charge — including the on-screen fallback — since a genuine
transcript beats one assembled a line at a time regardless of when it turns
up.

Whichever way found the timing, **A** steps back a line and **D** forward.
Part-way through a line, A restarts it; pressing it again goes to the line
before, which is how you rewatch something you did not catch.

**A small panel appears once per video**, listing every subtitle track it
offers with a button to try each one directly. Automatic fetching has too many
ways to land on an empty response, or to pick an auto-generated track over a
manual one that would have worked better, for that choice to always be made
silently — this is the same request the automatic pass makes, just handed to
you instead of guessed at. Closing it does not bring it back until the next
video loads. Whichever track LLL picked automatically is reported at the
bottom of the list, so you can see at a glance whether it is worth trying
another. A **manually authored track is always preferred automatically** when
one exists, since auto-generated captions are also where the word-by-word
reveal mentioned below comes from.

In the on-screen fallback specifically, auto-generated captions are often
revealed a few words at a time as recognition catches up rather than appearing
whole. LLL treats a growing or slightly revised line as the same line still
being written, not a new one each time — otherwise both the audio and the
timing would start wherever the last fragment happened to begin, not at the
sentence's true start.

Pressing **+** on a word in a subtitle also puts on the card the frame you were
looking at and the audio of that line. The frame is taken the instant you press
it, before anything moves. The audio is taken by replaying the line: the video
is sent back to the start of it, recorded to the end of it, and put back
exactly as it was — same moment, same speed, same paused or playing.

The line plays out loud while this happens, so you hear what is being put on
the card rather than mining blind. It takes as long as the line does — a
couple of seconds — and what comes out is exactly the line.

Playback speed is forced to normal while it records, since a line captured at
1.5× is a line spoken at 1.5×.

**Content-protected video cannot be captured.** Netflix, Prime Video and Disney+
hand their video to the browser's DRM layer, and both the frame and the audio
come back empty — that is what the protection is for, not a limitation to be
worked around. Where capture is refused the card is still made, without media.

Subtitles are YouTube-only for now.

---

## Known words

The list of words you already know, kept under **Known words** in LLL's
settings. Words get there two ways.

**One at a time.** Every word in the popup has a **✓** beside its **+**. They
are different questions: **+** means *teach me this*, **✓** means *I already
have this*. The tick toggles, because the commonest mistake to make with it is
pressing it on the wrong word.

**In bulk.** Paste in something you have already read, or load a plain text
file, and press **Add words from this text**.

Nothing new is built to read that text: it runs through `extractWords`, the
exact longest-match search a Shift-hover already uses, moved forward across a
whole passage instead of stopping at the first word. 走っていました is recorded
as 走る — the same dictionary form a hover on it would show — so reading a
passage once teaches the word regardless of which sentence it turned up
conjugated in, and running the same text through a second time adds nothing,
since it is already known.

The same page browses the list, newest first, with a search box and an **×**
per word for the ones added by mistake.

---

## Comprehension

A slim bar across the top of any page says how much of what is in front of you
is made of words you already know.

```
LLL   87%   1,204 of 1,383 words known                        ⟳  ⚙  ×
```

On a video that is measured against the **whole transcript**, not the part
already watched — which is the entire point of the fight to get the transcript
up front. Knowing a video is 87% words you know *before* starting it is what
decides whether it is worth watching; reading it afterwards answers nothing.
Everywhere else it is the page's own text.

It counts every word said, not every distinct word. A page that says 私 forty
times and one word you have never met is not as hard as one with forty
different unknown words in it, and a score that could not tell those apart
would not be worth reading.

Pressing **✓** in the popup moves the number immediately — a word's count is
exactly how far the bar shifts, so nothing has to be read a second time. **⟳**
reads the page again, **⚙** opens the settings, **×** hides the bar until the
page is reloaded. It hides itself while a video is full screen, and never
appears at all on a page with no Japanese on it.

---

## How it is put together

A handful of files do the work. None of them is long.

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

**`extension/subtitles.js`** — timing YouTube's subtitles, direct or off the screen.

**`extension/video.js`** — replaying a line to record it, and grabbing the frame.

**`extension/bar.js`** — the comprehension bar across the top of the page.

**`extension/options.js`** — the settings page, and switching between its tabs.

**`extension/known.js`** — the known-words tab: adding, browsing, forgetting.

**`extension/popup.css`** — how it looks. The only file that decides that.

### Working on the appearance

Reloading the extension to see a colour change is tedious, so there are preview
pages that run the real code against a handful of sample words:

```bash
node tools/serve.mjs
```

- <http://localhost:8137/tools/preview.html> — the popup and the bar.
- <http://localhost:8137/tools/options-preview.html> — the settings page. It
  fetches `extension/options.html` rather than copying it, so it cannot drift
  out of step with what ships.
- <http://localhost:8137/tools/video-preview.html> — subtitles and recording.

Edit the CSS, refresh.

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

- **Colouring the words themselves.** The bar says how much of a page you know;
  it does not say *which* words. Marking the unknown ones on the page, the way
  Migaku does, is the obvious next step from here.
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
