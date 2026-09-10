# LLL

A pop-up Japanese dictionary for Firefox. Hold **Shift** and point at a word;
its meaning appears next to the cursor. Everything is on your own machine, the
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
dictionary into the browser's own storage, 218,000 entries and 465,000
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

Just hovering a Japanese word gives it a quiet highlight, so a page shows at a
glance what LLL can help with. Click that word, or hold Shift and point at it,
to actually open the dictionary.

Wherever the cursor lands inside a word finds the whole word, not just
whatever happens to start under it. Point at フェ in the middle of ネカフェ
and the dictionary still shows ネカフェ, not フェ on its own: LLL tries every
plausible starting point behind the cursor and keeps the longest real word
that actually reaches it.

| | |
|---|---|
| point at a word | a quiet highlight, no popup yet |
| **click** a word, or **Shift** + point at it | open the dictionary |
| **click** it again | close it |
| **Shift** with text selected | look up the selection |
| **Esc**, a click outside, a scroll | close |
| **other matches** | other words that start at the same place |
| **A** / **D** | the line before, and the line after |
| **1** | mark the word under the cursor as one you do not know |
| **2** | mark it as one you do, popup or not |
| **3** | ignore it instead: never mention this one again |
| **B** | look this word up in Anki |
| **click a sense** | put only that meaning on the card |
| **+** | add the word to Anki |
| **✓** | mark as known, or unmark it |
| **⊘** | ignore, or stop ignoring |

**B** looks the word up in Anki itself: it opens the card browser searching for
that word, in every deck and every field, and brings Anki to the front. It acts
on what you have selected if you have selected something, otherwise on whatever
the cursor is over. Unlike the numbers it leaves the key alone when there is
nothing to look up, since a letter is a letter and plenty of sites have their
own use for it.

**1**, **2** and **3** are taken from the page whether or not a word is under
the cursor, since YouTube reads them as "jump to 30% of the video" and a key
that sometimes marks a word and sometimes throws away your place is worse than
either on its own.

While Shift is held the popup follows whatever you point at, and closes if you
point at something that is not a word. Let go of Shift, or click a word
instead, and it stays put, so you can move across and read it. A click never
takes over a link, a button, a form field, or text you were dragging to
select, so nothing about ordinary browsing changes.

Tags that hold for the whole word, `uk`, "usually written in kana", sit beside
it rather than against every definition. JMdict files them per sense, but a tag
on *every* sense is describing the word, and 事 carrying "usually kana" ten times
over says nothing ten times. Where a tag really is on only some senses it stays
with them: 綺麗 is usually kana when it means "clean", not when it means "pretty",
and that is worth knowing. Part of speech works the same way: 勉強 is a
transitive する verb for one sense and intransitive for another and just a plain
noun for a third, so only "noun", what every sense actually agrees on, sits
beside the word; each sense's own line carries whatever it adds beyond that.

Two small numbers follow the reading. The one in brackets is the **pitch
accent**: 0 means the pitch never drops, otherwise it is the mora it drops
after; the diagram of it goes on the card rather than in the popup. The other
is how **common** the word is: 読む is *top 1k*, 図書館 is *top 10k*.

That is a band rather than a rank on purpose. A bare number asks you to know the
scale already, #7,261 means nothing unless you have a feel for what #3,000 is
like, and it claims a precision the data does not have. The gap between #100
and #400 is real; the gap between #7,261 and #7,800 is noise. A round band says
both of those at once and needs no legend. The exact rank is on hover for when
it matters. A word with no band at all is one neither corpus ever saw, which
tells you something in itself.

The rank itself is blended from two corpora that read nothing alike: JPDB,
built from anime, manga and visual novels, and BCCWJ, a government-run sample
of newspapers, books and the web. A word common in casual speech but rare in
print, or the other way round, still comes out ordinary once both are asked,
rather than looking rare just because one of the two happens not to cover it.

Point at the *first* character of a word. Japanese has no spaces, so the
extension reads forward from wherever you are pointing and finds the longest
thing that is a word, point at 日 in 日本語 and you get 日本語, not 日.

Longest is not always right, and there is one well-known trap for it: a common
word followed by a single particle can spell the same characters as a real,
much rarer dictionary entry. 今日 ("today") plus は spells 今日は, a dated way
to write こんにちは ("hello"), and JMdict really does list it. Rather than
always trusting length, LLL checks whether trimming off a trailing particle
lands on a dramatically more common word, and if so shows that instead. The
rare reading has not gone anywhere. It sits right there under "other matches"
for the rare case that is genuinely what was meant. That list is labelled
"other" rather than "shorter" for exactly this reason: what shows up there is
not always shorter, just not the best guess.

It undoes conjugation on the way. 食べなかった is not in any dictionary, so it is
walked back to 食べる and the steps taken are shown underneath, small and grey:
*negative → past*.

Only a real na-adjective takes な or に as part of its own grammar, 元気な
and 元気に are 元気 behaving adjectivally, since 元気 is tagged as one. A plain
noun is not, so ネカフェに ("to the net cafe") is the word ネカフェ plus the
ordinary particle に after it, not one long word ending in に; this used to be
read as the latter, for any noun at all.

---

## Anki

Cards go straight into Anki through **AnkiConnect**, the Anki add-on that opens
a small server on your own machine. Anki has to be open; nothing leaves your
computer.

Open the settings from LLL's toolbar button and choose a deck and a note type.
Both lists are read from Anki itself, so a name can never be slightly wrong.
LLL then fills in the field mapping by guessing from the field names, a note
type with fields called *Target Word*, *Reading*, *Sentence* and *Definitions*
needs no setting up at all. Anything it guesses wrongly is one dropdown away,
and anything left blank stays empty on the card.

Four things can be put on a card:

| | |
|---|---|
| **Target word** | the dictionary form, so 食べなかった files under 食べる |
| **Reading** | the kana |
| **Sentence** | the whole sentence, with the word in bold. On a video this is the whole subtitle line, not the clause the word sits in: the line was written as one thing said, and half of it on a card is half of what was said |
| **Definition** | every sense, numbered |
| **Word audio** | a recording of the word, if one can be found |
| **Pitch accent** | the accent diagram, drawn as an SVG |
| **Video frame** | the frame on screen when you pressed + |
| **Sentence before** | what was said just before, for a note type that has somewhere to put it. Off unless a field asks for it |
| **Sentence after** | and what was said just after |
| **Sentence audio** | the subtitle line, spoken. **Audio lead-in** in the settings says roughly how much sound to keep from before the line, a tenth of a second by default, so the first word is not clipped by a subtitle that appears exactly as it is said. Roughly, because a recorder swallows an unpredictable moment when it starts, measured at anything from 0.05 to 0.4 seconds, so LLL starts it early and lets it |

Audio comes from JapanesePod101's dictionary. It answers every request with an
mp3 and a 200 even when it has nothing, handing back a fixed "audio unavailable"
recording instead, so LLL hashes what comes back and discards that one, leaving
the field empty rather than filling your collection with identical clips. Anki
downloads and stores nothing itself; LLL passes it the file.

Pitch accents come from **Kanjium**, which derives from the NHK accent
dictionary and 大辞林, the same data Yomitan and AJT Pitch Accent use. A word's
whole pattern follows from one number, where the pitch drops, and the diagram is
drawn from that: a dot per mora, high or low. The hollow dot on the end is the
particle that would follow, which is the only thing distinguishing 橋 (pitch
drops after it) from 日本語 (it does not). It is drawn in `currentColor`, so it
takes the colour of whatever card it lands on, night mode included.

A reading alone is not enough to place an accent, 箸, 橋 and 端 are all はし with
three different accents, so where the word cannot be identified the field is
left empty rather than guessed at.

The bold marks the word **as the page wrote it**, so a conjugated form is
highlighted in full, 「<b>食べなかった</b>ので、お腹が空いた。」, while the Target
Word field still says 食べる.

Duplicates are allowed. A repeated word gets a small note the moment **+** is
pressed, before the slower work of capturing the sentence even starts, but the
card is made either way. One sentence often teaches several words, and mining
the same word again later is not a mistake either.

By default a card carries every sense of the word. Clicking a sense before
pressing **+** narrows it to the meanings you actually met, 語 is both "word;
term" and "language", and you rarely want both. Clicking nothing means all of
them, so the ordinary case needs no clicks. Picking several senses of the same
word is fine, but a card is one word: choosing a sense in a different entry
lets go of whatever was chosen before, rather than quietly mixing meanings
from two different words onto one card.

---

### Putting the line before or after on one card

The two fields above are all or nothing: map them and every card gets them.
Usually that is not what you want, because usually a line on its own is the
right amount to put on a card and more is noise you have to read every time it
comes up.

So the popup offers them one card at a time. Where there is a line either side,
a row appears under the entry reading **also on the card:** followed by the
neighbouring text itself, dimmed. Click one and it is folded into the sentence
for that card. Click nothing and nothing changes, which is the ordinary case.
Nothing is remembered: the next word starts clean.

You can see what you are adding before you add it, which is the point. Whether
a line needs its neighbour is not a rule, これはちょっと… means nothing without
the question it answers and 猫です。 means everything on its own, and the only
way to tell is to look.

The word stays bold in the right place, and on a caption cut in half the bold
grows to the whole word once the next line completes it: 嬉しかっ becomes
嬉しかった.

---

### Asking about a word without asking the database

Reading a page asks about far more words than it finds. Every stretch of text
from every position is deinflected every way it could have been inflected,
which is around thirty questions per character: on a page of thirty thousand
characters, nearly nine hundred thousand of them. Nineteen in twenty are not
words at all. They are the shapes a word might have taken, and the dictionary
has never heard of them.

Each of those used to be a separate read of the database. Now the background
script keeps a sorted list of one number per word it knows, a plain FNV hash,
about two megabytes, taken once at startup. A number not in the list belongs to
a word that certainly is not there, and the question is answered in memory.

Measured on that same thirty thousand characters: **883,534 reads become
14,468**, one and a half percent of what it was. Ninety-four of those find
nothing, because two words shared a number; there are 32 such pairs in the
whole dictionary of 465,350 forms.

It can only ever be wrong in the harmless direction. A shared number costs one
wasted read that finds nothing, which is exactly what used to happen every time
anyway. It can never say no about a word that is really there, because the
number is taken from the word itself, and the tests check that against every
single word in the dictionary rather than a sample.

---

### How much of a page is read

Reading a page means segmenting every stretch of Japanese on it, which is
real work: roughly a second for a long article. An article is worth it, since
the number at the top is about the whole article.

A video page is not an article. Its number comes from the transcript, which
LLL fetches separately, and the page around the player is comments and menus
running to tens of thousands of characters, all of it read, almost none of it
visible. So where the number comes from somewhere else, only what is on
screen gets read, and a screen either side of it. Scrolling reads what you
scrolled to, once you stop. Nothing is lost: the only reason to read a page
whose score is already known is to mark the words on it, and a mark you
cannot see is not doing anything.

More of a transcript arriving is likewise a reason to work out the number
again and not a reason to read the page again, which used to happen every
twenty seconds for the whole length of a video.

While a page is being read, the handle counts up. It is the background
script saying how far through the text it has got, each time it stops to ask
the dictionary something. Several seconds of “Reading this page…” with
nothing moving is indistinguishable from nothing happening.

---

## Subtitles, and mining from video

LLL times YouTube's Japanese subtitles so it knows exactly when each line
starts and ends, that timing is what lets a line be replayed and recorded
precisely, and what lets **A** and **D** jump between lines. What you see is
drawn by LLL itself, in the same look as the popup.

LLL never touches YouTube's own captions. The CC button is YouTube's and means
what it says, LLL's line comes from the Japanese track it fetched itself, and
either can be on without the other. Both at once is then a choice rather than
an accident. The one exception is the last of the four ways of getting the
timing below, which works by reading YouTube's captions off the screen, and so
needs them running.

### Netflix

Netflix hands over its whole subtitle file before the episode has played a
second, which sounds unlikely and turns out to be a matter of asking.

When the player starts a title it posts a request listing the formats it is
prepared to accept, and the answer only ever offers what was asked for. The
player never asks for WebVTT, so the answer never offers it, and there is
nothing to find afterwards however hard you look. Add that one format to the
request on its way out and the very same answer comes back with a plain,
unencrypted address for every subtitle track in it, Japanese included.

So LLL adds it. `JSON.stringify` is where the request becomes text, which is
the last moment before it is sent, so that is where the format goes in.

Reading the answer took longer to place. `JSON.parse` is the obvious spot and
it is the wrong one: nothing carrying a track list ever went through it,
because `response.json()` does not call `JSON.parse` at all, the browser parses
the body itself. So the answer is watched at all three places a reply can
become an object, `JSON.parse`, `Response.prototype.json` and an
`XMLHttpRequest`’s `responseText`, and at the last two only for a reply to the
manifest request, so nothing else on the site is touched.

Netflix’s player is not affected by any of it: the extra format is one more
line in a list it ignores, and every answer is handed straight back, the same
object and the same promise the real one produced.

#### Getting the hooks onto the page took four goes

They have to run as page code. Netflix’s `JSON` is not an extension’s `JSON`,
and every part of that site parses JSON for everything it does, so anything
less than being page code shows up as the site not working. Three ways failed
first, and they are worth writing down:

1. A `"world": "MAIN"` entry in the manifest’s `content_scripts` never ran at
   all, on a Firefox new enough to support the property. Most likely Firefox
   rejects the whole entry over it rather than ignoring it.
2. A `<script>` tag added by a content script never ran either, near certainly
   stopped by Netflix’s content security policy.
3. Reaching the page’s own `JSON` from the content script, through
   `wrappedJSObject` and `exportFunction`, did run, and broke Netflix: the
   home page came up with its header and nothing else. Passing every parsed
   answer on the site across the wall between two worlds is not free.

What works is registering the file from the background script through the
`scripting` API, with the same `world: "MAIN"` the manifest would not take.
It follows the switch on the toolbar button, so turning LLL off takes it off
Netflix altogether: after the third attempt above, a way out that is not
"uninstall the extension" seemed worth having.

#### When there is no file

For a title with no Japanese subtitles, or an extension loaded halfway through
an episode, LLL reads the lines off the screen as it does on YouTube, and
Japanese has to be the subtitle language turned on in the player. It is a poor
second: the percentage can only describe the lines already watched, and **D**
has nowhere to go, because the next line has not been said yet. The console
says which of the two is in use.

**A** and **D** ask Netflix’s own player to move rather than setting
`currentTime` on the video element. Netflix streams in pieces chosen in
advance, and moving the element under it ends the session with error F7375 and
an error page.

One thing is different from YouTube either way: the audio on a mined card may
not record, because Netflix video is encrypted and the browser will not hand
its sound to an extension. The card is still made, with the sentence and the
word on it.

There are four ways it gets the timing, tried in the order below, each a
fallback for the one before it, not a choice between them. The first three all
build a caption web address themselves, out of data YouTube's own page
publishes; none of them ever produced anything, on any video tried, no matter
how the request was made, a background-script fetch, a content-script fetch,
a rewritten request header, an injected response header. What finally worked
was not sending a better-formed request at all: it was not building the
address in the first place.

1. **Catch the address YouTube's own player already uses.** The address
   published in the page's own data is not, evidently, the one YouTube's own
   player actually requests when it genuinely fetches a caption track, so no
   amount of asking more carefully for *that* address was ever going to work.
   LLL watches the page's own network traffic for the real request instead,
   which happens the moment a caption track is genuinely active in the native
   player, and reuses that exact address. This needs a real caption track
   active at least once, which is exactly why YouTube's own captions should
   stay on.

   Catching the right address turned out not to be enough on its own. Even
   that address, provably the one YouTube's own player had just used
   successfully, still came back with a 200 and nothing in it when refetched
   from the content script, the same "blocked by OpaqueResponseBlocking"
   symptom from the very first attempt, which meant it was never really about
   which address was being asked for. Both fixes are needed together: LLL
   also adds the CORS permission the response never carries, using the same
   `webRequest` technique CORS-unblocking extensions use generally, scoped
   only to this one address.
2. **Ask for the transcript the way "Show transcript" does.** Not the
   closed-caption file, the separate panel YouTube's own player offers,
   reached through a one-time token buried in the page's own data.
3. **Ask YouTube for the closed-caption file directly.** The address LLL
   builds itself from the page's published data, tried as a fallback in case
   a future change makes it work again.
4. **Read the captions off the screen as they play**, timing each line by
   watching it appear and disappear. This is what the simplest subtitle tools
   do, and it always works, because it is only reading what is already there.
   The real cost: a line is known only once it has actually been shown, so
   nothing about the video is known ahead of watching it, **D** cannot jump
   ahead into an unseen line, and nothing here can answer "how much of this
   video will I understand" before you have already watched it. Rewatching a
   line does not duplicate it; seeing the same text again near where it was
   last seen just refreshes its timing.

Method 1 can arrive at any moment and supersede whichever of the others is
currently in charge, including the on-screen fallback, since a genuine
transcript beats one assembled a line at a time regardless of when it turns
up.

Whichever way found the timing, **A** steps back a line and **D** forward.
Part-way through a line, A restarts it; pressing it again goes to the line
before, which is how you rewatch something you did not catch.

**A small panel appears once per video**, listing every subtitle track it
offers with a button to try each one directly. Automatic fetching has too many
ways to land on an empty response, or to pick an auto-generated track over a
manual one that would have worked better, for that choice to always be made
silently, this is the same request the automatic pass makes, just handed to
you instead of guessed at. Closing it does not bring it back until the next
video loads. Whichever track LLL picked automatically is reported at the
bottom of the list, so you can see at a glance whether it is worth trying
another. A **manually authored track is always preferred automatically** when
one exists, since auto-generated captions are also where the word-by-word
reveal mentioned below comes from.

In the on-screen fallback specifically, auto-generated captions are often
revealed a few words at a time as recognition catches up rather than appearing
whole. LLL treats a growing or slightly revised line as the same line still
being written, not a new one each time, otherwise both the audio and the
timing would start wherever the last fragment happened to begin, not at the
sentence's true start.

Pressing **+** on a word in a subtitle also puts on the card the frame you were
looking at and the audio of that line. The frame is taken the instant you press
it, before anything moves. The audio is taken by replaying the line: the video
is sent back to the start of it, recorded to the end of it, and put back
exactly as it was, same moment, same speed, same paused or playing.

The line plays out loud while this happens, so you hear what is being put on
the card rather than mining blind. It takes as long as the line does, a
couple of seconds, and what comes out is exactly the line.

When it finishes, the video is left where the recording ended rather than
dragged back to where **+** was pressed: you have just heard the line played
out, and the place to carry on from is the end of it. Never earlier than
where you were, though, so pressing **+** on a line that has already finished
does not rewind you into it.

A second **+** pressed while one recording is running waits for it rather
than being turned away. Both cards get their sound; the second takes a few
seconds longer.

#### Only a subtitle brings the video with it

A frame and a line of audio belong to a word read off a subtitle. Mining one
out of a comment under the video used to put whatever happened to be playing on
the card, for two reasons at once: the frame was grabbed whenever there was a
video anywhere on the page, and the line to record is found by matching the
sentence against the subtitles, which falls back to the line playing now when
nothing matches. That is a fair guess about a subtitle and nonsense about a
comment.

The sentence now remembers whether it came off a subtitle, and nothing reaches
for the video unless it did.

#### A line is not always one cue

An automatic caption revises itself as the recogniser hears more, and every
revision is filed as a cue of its own. What you read as one line is several
cues in a row, each a rewrite of the one before, and any single one of them
can be well under a second long.

Mining used to pick one of those and record exactly it, which produced a clip
of the lead-in and nothing else: half a second of the previous line, stopping
at the moment the line you wanted began. A line now runs from the first of
those cues to the last, and a clip is never shorter than 1.2 seconds whatever
the timings say. On a clean subtitle track, where each line is filed once,
neither rule changes anything.

Playback speed is forced to normal while it records, since a line captured at
1.5× is a line spoken at 1.5×.

The clip goes on the card as a plain WAV, mono and 24 kHz, not as what the
browser recorded. A browser records Opus in a WebM container, and Anki on a
computer plays that happily because it hands the file to mpv, which plays
anything. Anki on a phone does not: AnkiMobile cannot read WebM at all, and
AnkiDroid depends on what the phone underneath it supports. A card that plays
at the desk and is silent on the train is worse than useless, because the
train is where you find out.

The cost is the file: a couple of hundred kilobytes for a line where the Opus
was twenty or thirty. There is no honest way around that without shipping an
MP3 encoder, which is a large piece of somebody else’s code for a problem
that only exists on a phone. 24 kHz carries everything a voice does and keeps
it in proportion.

**Content-protected video cannot be captured.** Netflix, Prime Video and Disney+
hand their video to the browser's DRM layer, and both the frame and the audio
come back empty, that is what the protection is for, not a limitation to be
worked around. Where capture is refused the card is still made, without media.

Subtitles are YouTube-only for now.

---

## Known words

The list of words you already know, kept under **Words** in LLL's settings,
alongside the ignored list: they are the same decision with different answers,
and a word moves between them, so they sit on one page. Words get on the known
list two ways.

**One at a time.** Every word in the popup has a **✓** beside its **+**. They
are different questions: **+** means *teach me this*, **✓** means *I already
have this*. The tick toggles, because the commonest mistake to make with it is
pressing it on the wrong word.

Or press **2** while pointing at the word, without reaching for the tick. Most
of what you meet while reading is something you already know, and saying so is
the one thing done often enough that it should not cost a mouse movement.

The three keys run in the order the answers themselves run: **1** for a word
you do not know, **2** for one you do, **3** for one to stop mentioning. They
set rather than toggle, so leaning on one is harmless, and every state can be
reached from every other: **1** on a word already marked known puts it back to
unknown, which used to mean a trip to the popup.

**In bulk.** Paste in something you have already read, or load a plain text
file, and press **Add words from this text**.

Nothing new is built to read that text: it runs through `extractWords`, the
exact longest-match search a Shift-hover already uses, moved forward across a
whole passage instead of stopping at the first word. 走っていました is recorded
as 走る, the same dictionary form a hover on it would show, so reading a
passage once teaches the word regardless of which sentence it turned up
conjugated in, and running the same text through a second time adds nothing,
since it is already known.

The same page browses the list, newest first, with a search box and an **×**
per word for the ones added by mistake.

---

## Reading a book

**Open your books**, at the foot of LLL's settings, opens a page that takes an **epub** or a **txt**
file and shows it as an ordinary web page. That is the whole trick: the reader
loads the same scripts LLL puts on any website, so hovering, the popup, the
marking and the comprehension bar work on a book exactly as they do on a page,
with no second copy of anything.

An epub is a zip of XHTML files plus a list saying what order to read them in.
LLL reads that list, takes the text out of each file, and shows one chapter at
a time, named by the book's own table of contents. Most books do not repeat
the chapter name inside the chapter, so without reading the contents a book
opens as Section 1, Section 2, Section 3, which is no way to find your place.
EPUB 3 keeps that list in a nav document and EPUB 2 in a `toc.ncx`, and books
in the wild are still mostly the second kind.

Furigana is thrown away rather than kept: left in, every word would arrive with
its reading glued to it and 食べる would come out as 食た べる, matching
nothing. Text is taken from the innermost blocks only, since a paragraph inside
a blockquote sits in two of them and would otherwise be read, shown and counted
twice. Books built out of bare `<div>`s or nothing but line breaks are common
enough to be handled the same way as ordinary paragraphs. A chapter longer than
about twelve thousand characters is cut into parts, both because that is a long
way to scroll and because reading a page end to end for a score should take a
moment rather than a minute.

The reader opens on a shelf: every book you have added, with how much of each
one you would understand beside it, coloured the same way the bar is. That
estimate comes from a sample taken evenly through the book rather than from the
whole of it, because the whole of a novel is a minute of reading and the answer
would not move. Books fill in one at a time as they are worked out.

The bar stays down inside the reader instead of tucking itself away, since a
page that exists only to be read in has room for it, and hiding the one number
you are there for would be strange.

Books and your place in each are kept in the browser's storage, so closing the
tab loses neither. Your place is the chapter and how far down it you had read,
since a chapter is several screens.

---

## Comprehension

A slim bar across the top of any page says how much of what is in front of you
is made of words you already know. By default it stays out of the way: a
small "LLL" handle sits in the top right corner, and clicking it slides the
bar down.

```
LLL   87%   1,204 of 1,383 words known                    ⟳  ⚙  📌  ×
```

Left unpinned, it is a hover panel: moving the mouse away tucks it back up
after a moment, so it never sits permanently across the top of a page you
did not ask it to. Press **📌** to keep it down instead, the way it used to
work; that choice is remembered.

On a video that is measured against the **whole transcript**, not the part
already watched, which is the entire point of the fight to get the transcript
up front. Knowing a video is 87% words you know *before* starting it is what
decides whether it is worth watching; reading it afterwards answers nothing.
Everywhere else it is the page's own text.

It counts every word said, not every distinct word. A page that says 私 forty
times and one word you have never met is not as hard as one with forty
different unknown words in it, and a score that could not tell those apart
would not be worth reading.

Pressing **✓** in the popup moves the number immediately. A word's count is
exactly how far the bar shifts, so nothing has to be read a second time.
**⟳** reads the page again, **⚙** opens the settings, **📌** pins it open. It
hides itself while a video is full screen, and never appears at all on a page
with no Japanese on it.

While the dictionary is still being built, or a page is still being read, the
handle says so rather than sitting there silently: "LLL 42%" the first time,
when 218,000 entries are being copied into the browser's own database, and
"LLL ·" for the moment a page takes to read.

A grammatical pattern JMdict happens to file as one entry, お元気ですか
("how are you") is nothing more than the honorific お, 元気, the copula です
and the particle か, counts as known once every piece of it is, even though
that exact four-word entry was never separately marked known itself. The same
goes for ことがある. A true idiom, where the meaning genuinely is not the sum
of its words, gets none of this: JMdict's own "id" tag is what tells the two
apart, so 猫の手も借りたい stays unknown no matter how well you know 猫 and 手.

Any reading of what is actually written counts, not only the best one. 来た is
the past tense of 来る and also, on paper, a rare interjection; 読み is the stem
of 読む and also a noun in its own right. Knowing either reading of what is on
the page means nothing is missing, so an i-stem never counts as a new word
just because the dictionary also lists it separately.

### Ignored words

Some words are never going to be learned and should not be counted either
way: names, pieces of English, things the dictionary read wrongly. Press **⊘**
in the popup, or the **3** key, and the word leaves the question entirely, 
not marked on the page, and out of the comprehension total rather than
counting for or against it. Counting them unknown would say a page is harder
than it is; counting them known would say the opposite; neither is true.

Known and ignored are the same kind of decision with different answers, so a
word is one or the other or neither, never both: putting it on one list takes
it off the other. Both are browsable under LLL's settings, and either can be
taken back.

### Does counting words this way actually make sense?

It is the standard approach every tool like this uses: percentage of running
words already known, counted once per time a word is actually said rather than
once per distinct word, so a page that says 私 forty times reads differently
from one with forty different unknown words in it. That much is sound.

Two honest limits are worth knowing about. First, this is a vocabulary score,
not a comprehension score in the full sense: understanding a sentence also
takes grammar, and two sentences with the same known-word percentage are not
always equally easy to follow. Second, a word the dictionary does not
recognize at all, a name, a coined word, a typo, is left out of the count
entirely rather than counted as unknown, since there is no dictionary entry it
could be. On a video full of character names this reads a little higher than
it should. Ignoring a word does the same thing deliberately, and for the same
reason; the difference is that this happens without being asked.

---

## Keeping a copy of your words

At the end of the **Words** page in LLL's settings, **Save to a file** writes both
lists, known and ignored, into a single JSON file with the date in its name.

This is the one part of LLL that cannot be rebuilt. The dictionary downloads
again in a minute and the Anki settings are a minute of typing, but a known
list is however many months of reading. LLL keeps a copy for you as well, once
a day, described below; this is the button for when you want one now, or want
it somewhere of your own choosing.

Loading a file back **adds** to what is already there. Nothing is removed and
nothing is overwritten, and where the same word is in both, the earlier of the
two dates is the one kept. That makes an old backup safe to restore: it can
only ever give words back, never take away ones learned since, so carrying one
file between two machines works in either direction. If a word is known on one
side and ignored on the other, known wins, since the two lists still cannot
both hold it.

A file that is not one LLL wrote is refused rather than half-read.

### A copy is kept for you as well

Once a day, the first time LLL starts, it writes both lists to
**Downloads/LLL** with the date in the name. Nothing is asked and nothing is
shown; the newest file is always the one to load back.

This is not caution for its own sake. Everything LLL keeps lives inside the
extension: the word lists, the deck settings, the dictionary. When that goes,
it goes all at once, and an add-on loaded from `about:debugging` is removed by
Firefox every time the browser closes. Reload it and you have a fresh
extension: the dictionary rebuilds, the deck settings are blank, and the word
lists are empty. Nothing LLL can do from inside will save it, which is why the
copy goes outside.

**The real fix is not to install it that way.** Either run it in Firefox
Developer Edition with `xpinstall.signatures.required` set to false in
`about:config` and install the folder as an add-on, or sign it through
addons.mozilla.org as an unlisted add-on, which gives back an .xpi that
installs permanently in ordinary Firefox. Until then, expect a restart to cost
you everything except the copy in Downloads.

### Losing words a few at a time

Two smaller ways the lists could shrink are closed off.

Every change is a read of the whole list, an edit, and a write of the whole
list back. Two of those at once, marking a word while the settings page
removes another, meant both read the same list and the second write undid the
first. Changes now wait their turn. Left alone, three words marked at the same
moment came out as one.

And a read that comes back empty when it should not looks exactly like an
empty list, so the write that follows replaces months of reading with one
word. The number of words in each list is now kept beside it, and a read that
disagrees with it is treated as the failure it is: nothing is written, and you
are told to try again. A copy of each list is kept under its own name too, so
a list going missing on its own is put back at the next start.

---

## Where one word stops and the next begins

Japanese is written without spaces, so before a single word can be counted,
looked up or coloured, something has to decide where the words are. This is the
hard part, and it is worth saying how it is done, because the obvious way is
wrong in a way that takes a while to notice.

The obvious way is to start at the left, take the longest thing in the
dictionary, move past it and repeat. Every step is sensible. The sentence still
comes out as nonsense: 種がある ("there is a seed") was read as 種, があ, る,
because があ really is an entry, and taking it left る stranded with nothing to
be. すごいですね came out as ご, いです, ね. The wreckage always lands at the end
of the sentence, where there is nothing left to complain.

So the sentence is read as a whole. Every run of Japanese between two pieces of
punctuation is laid out as every way it could possibly be cut up, each way is
priced, and the cheapest wins. A word costs a flat amount for being a word, plus
more the rarer it is, on a log scale from two frequency lists. Backing があ now
costs what る costs three characters later, which is what makes it lose.

Two things follow from pricing it this way rather than by length:

**Nothing wins on length alone.** "Longest match wins" falls out on its own,
because one word costs one word and two cost two, so 日本語 still beats 日本
plus 語. But 今日は, a spelling of こんにちは nobody uses, no longer beats 今日
followed by は, and 来た is read as the past of 来る rather than as the
interjection spelled the same way. Both of those used to need a rule of their
own. Neither has one now.

**A word nobody has written costs the same as no word at all.** Text the
dictionary cannot account for is priced as a stretch of unknown, and a
dictionary entry with no frequency behind it is priced exactly the same, never
less. Otherwise an entry nobody has ever used beats honest ignorance and names
get assembled out of the wreckage: 僕もちえこさんも was read as 僕, もち, えこ,
さん, も, because えこ, a reading of 長子 that has surely never been written
down, was going cheaper than three characters of nothing. A stretch of nothing
also may not run across a change from kanji to kana, which is the one word
boundary that is visible without knowing any Japanese.

The same reading answers both questions the extension asks, which is why a hover
and the colouring under it can never disagree: pointing at a character asks
which word of the sentence it fell inside, and the popup leads with that word
rather than with whatever happens to be longest.

### The copula is a word

です, だ, である and their negatives are words in their own right, not endings a
noun grows, and LLL now reads them that way: 猫です is 猫 and です, 静かである is
静か and である. Treating them as endings meant any noun could swallow whatever
followed it, which produced 科である read as 科, さです as 差 and とです as と,
two of which are not things anyone would say. The copula does still conjugate as
itself, so でした is read as the past of です.

### Looking up the second half of a word

A hover is read from where the *word* starts, which is the right answer to
"what is this word": every character of だからこそ answers with だからこそ,
だから, だか and だ. It also means the second half of a long word can never be
looked up at all. こそ was offered from nowhere, including from itself.

Offering every word beginning at every character would be a wall of matches
nobody asked for. But the cursor is already the input, so the words beginning
at the character you are actually pointing at are added to the list. Point at
こ and こそ is there; point at だ and nothing is added, because だ is where the
word begins anyway. Bounded by the word rather than the sentence, since these
are other ways of reading this word and 頑張る is not one of them.

---

### たり and たら

A deinflection rule says what kind of word it applies to, which is what stops
少ない becoming the verb 少る. たり and たら complicate that: they take a word
and hand it on as a *past* form, so by the time the past rule is reached the
word is no longer typed as an adjective or a copula, and a past rule that only
accepted its own kind never fired.

Verbs never had the gap, because their past rules take a た-form to begin with.
The copula and the adjectives did, so the chain stopped one step short and the
り or the ら was left stranded as a word of its own: 元気だったり was read as
元気, だった, り. Every past rule now accepts a た-form as well as its own kind.

---

### Lines cut in half

Automatic captions break wherever the speaker draws breath, which is regularly
in the middle of a word: one line ends 見に行っ and the next begins たので. Read
on its own, the end of that line is fragments that are not words, and every one
of them looks unknown.

So a subtitle line is never read on its own. It is read with the line before
and the line after it, for the popup as well as for the marking: hovering the
ない at the start of a line answers わけじゃない, because the わけじゃ that ended
the line before it is there to be seen. What gets marked is the words as they
fall across the line on screen, and a word lying across a join is marked on both
lines, cut to the part of it on each.

The whole video is one continuous text for the same reason, with no breaks put
between the lines at all, the way a book is one text. Sentences still stop the
reading on their own, since 。 and 、 are not Japanese characters and end a run
wherever they appear.

There is a second way a line gets cut, inside a single line rather than between
two. A caption that is too long to fit is wrapped by the player, and the break
arrives in the text as an ordinary space. Japanese does not put spaces between
words, so a space between two Japanese characters is not a boundary and is
removed: with it left in, 繋がるわけじゃないのかも was read as 繋がる, 別, じゃ
and ない, three of which are not what is written there. A space between anything
else, Latin words included, is left exactly as it is.

When the transcript could not be fetched and LLL is reading captions off the
screen, a line is only known once it has ended, so the line showing has no
line after it yet: only what came before it can be used. The last word of a
line stays cut until the next line arrives, and is whole from then on.


### What it still gets wrong

Names. ちえこ is not in any dictionary, and neither ちえ nor こさん being real
words is something the pricing can see through. A person's name in the middle of
a kana run is the case where a human uses さん as the clue and LLL does not. The
ignore list, and the **3** key, exist partly for this.

---

## Marking the words you do not know

The bar says how much of a page you know. The page itself says which parts you
do not: every word not in your list gets a soft underline where it stands, and
a video's subtitle line is re-marked as each line arrives.

Two words sitting right next to each other with nothing between them, which is
ordinary in Japanese, alternate between a solid and a dashed underline rather
than sharing one unbroken line, so 関東沿岸部 reads as 関東 next to 沿岸部 rather
than looking like one long unknown word. Both use the exact same colour: colour
already means something here, known against unknown, and giving two unknown
words two different colours would read as a second, unrelated distinction
rather than the same one drawn twice.

**Nothing on the page is altered to do it.** The obvious way to colour a word
is to wrap it in a `<span>`, and that is how this has always been done. A
page's own scripts own that DOM though, and quietly inserting thousands of
elements into it breaks sites in ways that are miserable to track down: React
re-renders, `:first-child` rules start matching something else, and a click
handler bound to a node that no longer exists silently stops working.

The browser has a way to paint text without owning it. A `Range` describes a
stretch of characters without being part of the document, a `Highlight` is a
set of them, and `::highlight()` styles the lot. One `<style>` element is
added and that is the whole of LLL's footprint on the page, so there is
nothing for a site to trip over.

Firefox has had this since **version 140**. On anything older, the marking is
simply skipped and everything else works as before, since rewriting a page's
DOM is not something to fall back on quietly.

Pressing **✓** on a word clears its mark everywhere on the page at once, which
is why the reading keeps *where* each word was rather than only how many there
were.

---

## How it is put together

A handful of files do the work. None of them is long.

**`extension/deinflect.js`**: the grammar. A table of about 470 small rules,
each saying "a word ending in X might really be a word ending in Y". Applied
over and over, they turn any conjugated form back into the dictionary form.
Every rule is tagged with the kind of word it applies to, so the nonsense
answers get thrown away: 少ない could "become" the verb 少る, but no such verb
exists, so it is dropped.

**`extension/lookup.js`**: the search, and the reading of a sentence into
words. Takes a piece of text, tries every length from sixteen characters down
to one at every position, deinflects each and keeps whatever is really in the
dictionary. Which of those matches to believe is settled for the sentence as a
whole rather than one word at a time; see "Where one word stops" below.

**`extension/reader.js`**: the reader. Unpacks an epub, finds the chapters and
puts their text on the page. Knows nothing about dictionaries; the page it
builds is read by the same scripts as any other.

**`extension/background.js`**: the dictionary itself. Runs once for the whole
browser and owns the database. Pages ask it questions by message.

**`extension/content.js`**: the part on the page. Works out which character is
under the mouse, and draws the popup. The popup is built inside a *shadow root*,
a sealed-off document of its own, so no website's styling can reach it and it
looks the same everywhere.

**`extension/anki.js`**: the Anki side. One HTTP request to your own machine.

**`extension/pitch.js`**: pitch accents, and drawing them.

**`extension/subtitles.js`**: timing YouTube's subtitles, direct or off the screen.

**`extension/video.js`**: replaying a line to record it, and grabbing the frame.

**`extension/bar.js`**: the comprehension bar across the top of the page.

**`extension/highlight.js`**: marking the unknown words, without touching the
page's own DOM.

**`extension/japanese.js`**: what counts as a Japanese character. One line, in
a file of its own, because four separate parts of LLL have to agree on it.

**`extension/options.js`**: the settings page, and switching between its
sections, listed down the left rather than across the top so which section you
are in and how to get to the other one live in the same place.

**`extension/known.js`**: the known-words tab: adding, browsing, forgetting.

**`extension/popup.css`**: how it looks. The only file that decides that.

### Working on the appearance

Reloading the extension to see a colour change is tedious, so there are preview
pages that run the real code against a handful of sample words:

```bash
node tools/serve.mjs
```

- <http://localhost:8137/tools/preview.html>, the popup and the bar.
- <http://localhost:8137/tools/options-preview.html>, the settings page. It
  fetches `extension/options.html` rather than copying it, so it cannot drift
  out of step with what ships.
- <http://localhost:8137/tools/switch-preview.html>, the panel behind the
  toolbar button.
- <http://localhost:8137/tools/fixed-header-preview.html>, a page shaped like
  YouTube, with a header pinned to the top, for checking that a pinned bar
  pushes both the page and the header out of its way.
- <http://localhost:8137/tools/app-shell-preview.html>, the other shape a site
  comes in: the whole application in a container pinned over the viewport,
  which a margin on the root element cannot move at all.
- <http://localhost:8137/tools/reader-preview.html>, the book reader. It comes
  with two sample books and a button that checks the reader against both.
  `sample.epub` is what an epub looks like when everything goes right;
  `sample-awkward.epub` is what they look like in the wild, with the chapter
  names only in a `toc.ncx`, no headings in the text, paragraphs wrapped in a
  blockquote, a chapter of bare divs, a chapter of line breaks, a space in a
  filename, an uncompressed entry and a wordless cover. Rebuild them with
  `node tools/make-epub.mjs tools/sample.epub plain` and
  `node tools/make-epub.mjs tools/sample-awkward.epub awkward`.
- <http://localhost:8137/tools/video-preview.html>, subtitles and recording.

Edit the CSS, refresh.

### Tests

```bash
node --max-old-space-size=4096 tools/test.mjs
```

Runs the real search code against the real dictionary, every godan verb ending,
the irregular verbs, adjectives, the copula, and the cases where the deinflector
would otherwise invent words that do not exist.

---

## Not yet

In rough order of intent:

- **Reaching words the dictionary does not know at all.** Ignoring covers the
  case where JMdict has an entry LLL read wrongly, but a name or coined word
  with no entry at all never becomes a word in the first place, so there is
  nothing to press ⊘ on. It is silently left out of the count either way,
  which is the right answer often enough not to be urgent.
- **Packaging.** Sign it, so it survives a Firefox restart.

---

## Dictionary data

Frequency ranks are blended from two corpora when the dictionary is built, so
there is no separate file and no second lookup at read time. **JPDB** comes
from anime, manga, light novels and visual novels: media Japanese rather than
newspaper Japanese. **BCCWJ**, the Balanced Corpus of Contemporary Written
Japanese, comes from newspapers, books, magazines and the web instead. Where
both have a rank for a word, the two are combined by their harmonic mean,
which rewards a word for doing well in either list while still favoring one
both lists agree is common over one only a single list has heard of. They also
decide which of two equally good matches goes first, which JMdict's own
priority markers did poorly: those are coarse bands covering only the
commonest 24,000 words.

The dictionary is **JMdict**, from the [Electronic Dictionary Research and
Development Group](https://www.edrdg.org/), used under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). It is the same
data Jisho.org is built on. It is downloaded by the build script and is not
stored in this repository; if you ever distribute a packaged copy of this
extension, that copy carries the dictionary's licence with it.

The code is MIT, see [LICENSE](LICENSE).
