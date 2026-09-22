# Submitting Torval

Everything a store asks for, written out once so a submission is copying
rather than composing. Two stores ask for much the same things under
different names; where an answer differs it says so.

Nothing here is marketing that the add-on does not do. A listing that
oversells gets one bad review per unmet promise, and a permission
justification that is vague gets a rejection and another fortnight.

---

## The short fields

**Name.** Torval

**Summary** (Chrome: 132 characters; Firefox: 250)

> Hold Shift and hover any Japanese, Italian or Spanish word to see what it
> means. Free, private, and it never leaves your machine.

That is 129 characters, so it fits both.

**Category.** Chrome: *Education*. Firefox: *Language support* (secondary:
*Other*).

**Tags** (Firefox). japanese, italian, spanish, dictionary, anki, language
learning, subtitles, immersion

---

## The description

Both stores take the same text. Chrome renders no formatting; Firefox takes
a little HTML. This is written to read correctly as plain text.

> Torval is a pop-up dictionary for Japanese, Italian and Spanish. Hold
> Shift, hover a word, and it tells you what the word means, handling
> conjugation and inflection on the way, so 食べなかった finds 食べる and
> hablábamos finds hablar.
>
> It does three more things that a dictionary usually leaves to you.
>
> IT SAYS HOW MUCH YOU ALREADY KNOW, IF YOU WANT IT TO. One number across
> the top of the page:
> the share of what is in front of you that is built from words you have
> marked as known. On a video, that is measured against the whole
> transcript before you start watching, which is what actually decides
> whether a video is worth your evening. This half is optional and starts
> switched off, because a word list begins empty and a percentage built on
> an empty list is no use to anybody for the first fortnight. Left off,
> Torval is a pop-up dictionary that makes Anki cards, with nothing to set
> up at all.
>
> IT TIMES SUBTITLES. On YouTube and Netflix, Torval works out where every
> line begins and ends. Step between lines with A and D, replay the one you
> are on, and hover the words in it like any other text.
>
> IT MAKES ANKI CARDS. One click sends a word to your own collection
> through AnkiConnect, into whatever note type you already use: the
> dictionary form, the sentence with the word in bold, the definitions, the
> frame on screen, and the line as it was spoken. A copy-protected service
> such as Netflix asks two things of you: one click on the Torval button
> when you open a video, which is how a browser is told an add-on may
> photograph and record that tab, and Chrome for the sound, which is the
> only browser that will hand a tab's audio to an add-on. Torval says which
> is missing and why rather than leaving you to notice. Japanese cards can carry
> a pitch-accent diagram; Italian and Spanish mark the stressed vowel, and
> nouns come with their article, because "il cane" is the thing to learn
> and "cane" is only half of it.
>
> WHAT IT DOES NOT DO. There is no account, no subscription, no telemetry,
> no analytics and no server. The dictionaries were downloaded once, when
> they were built, and ship inside the add-on; everything else lives in
> your own browser. Nothing you read, look up or save leaves your computer.
>
> Torval is free and open source, under the GPL. The Japanese dictionary is
> JMdict from the EDRDG; Italian and Spanish come from Wiktextract's
> extraction of English Wiktionary; all under CC BY-SA 4.0. Pitch accent
> from Kanjium, word frequency from JPDB, hermitdave/FrequencyWords and
> Wikipedia word counts.
>
> Source and issues: https://github.com/jacobgerritz/Torval

---

## Single purpose (Chrome requires this in one sentence)

> Torval looks up the words on the page you are reading, in the language
> you are learning, and helps you save them for study.

Everything the add-on does is part of that one job: the lookup itself, the
count of how much of a page is made of words you know, the subtitle timing
that makes a line on a video into text you can look up, and sending a word
to Anki. Keep this sentence handy. A reviewer who cannot find the single
purpose is the most common reason an education extension is bounced.

---

## Permission justifications

Chrome wants one per permission, in its own box. Firefox does not ask, but
the same answers belong in the reviewer notes. Each of these says what the
permission does and where in the source it is used, which is what turns a
justification from a claim into something checkable.

**`storage`**
> Your known and ignored word lists, where you have asked for those, your Anki deck and field settings,
> which language you are reading, any keyboard shortcut you have changed,
> how fast to play the quiet parts of a video, and where you dragged the
> subtitle overlay. All of it local to the browser profile; none of it is sent
> anywhere.

**`unlimitedStorage`**
> The dictionaries are large, around 120 MB across three languages once
> imported into IndexedDB. Without this, the import is refused partway
> through on most profiles.

**`downloads`**
> Once a day, Torval writes a copy of your known and ignored word lists to
> Downloads/Torval as plain JSON. A word list is months of reading, and an
> add-on's storage can be cleared by the browser without warning; this is
> the backup. It is a file on the user's own disk and is never uploaded.

**`webRequest`** (Firefox; observational only on Chrome)
> Two narrow uses, both scoped to
> `https://www.youtube.com/api/timedtext*` and nothing else. First, Torval
> observes the address YouTube's own player uses to fetch a subtitle
> track: that address is signed and cannot be reconstructed from the page
> data, so it has to be seen to be used. Second, on Firefox, it adds an
> Access-Control-Allow-Origin header to that one response, which YouTube
> does not send, so the extension is permitted to read the track it just
> asked for. No other request on any site is touched, and nothing is
> blocked, redirected or logged.

**`declarativeNetRequest`** (Chrome only)
> The same header rewrite as above, declared as a static rule in
> rules.json rather than decided per request, because Manifest V3 does not
> allow a blocking listener. One rule, one URL pattern:
> `||youtube.com/api/timedtext`.

**`activeTab`**
> The screenshot and the sound for a card, on a copy-protected video. Such a
> video refuses to draw into a canvas, so the frame has to be taken by
> photographing the tab, and the sound has to be taken off the tab too. The
> browser allows neither until the user has clicked Torval's toolbar button
> on that tab, which is the point of this permission: nothing is read from a
> page the user has not just asked Torval to work on. The photograph is
> cropped to the video, used for the card the user asked for, and never
> leaves their machine.

**`tabCapture`** (Chrome only, and optional: never requested until asked for)
> The sound of a line on a copy-protected video, for a card. A video the
> browser is decrypting hands over no audio when its element is asked for a
> stream, and a tab's own output is the only place left. This is requested
> at the moment the user ticks "Record its sound from the tab" on the
> settings page, never on install and never by visiting a site, and it is
> used on a copy-protected video and nowhere else. The recording is made in
> an offscreen document, is a few seconds of the line the user just asked to
> mine, and goes straight onto their own card in their own Anki. Nothing is
> uploaded. Firefox has no equivalent API, so the Firefox package contains
> none of this code.

**`offscreen`** (Chrome only)
> A Manifest V3 service worker has no MediaRecorder, so the recording above
> has nowhere to happen. offscreen.html is a document with no window and no
> content, holding that one recorder and nothing else. It is created the
> first time a line is recorded from a tab and not before.

**`scripting`**
> Netflix hands its subtitle file to its own player, where only code
> running as part of the page can see it. A small script (netflix-page.js)
> is injected on netflix.com to take a copy of that file as it arrives, so
> Torval can time the lines. Netflix only; nothing is injected anywhere
> else.

**Host permission: `<all_urls>` (content scripts)**
> Reading the text of the page is the entire program. Torval has to be
> present on whatever page the user is reading, whether a news article, a
> blog, a forum or a video, to see the word under the cursor and draw the
> popup. It reads the page locally and sends nothing from it anywhere.
> There is no list of sites that would work, because the whole point is
> that it works on the page the learner happens to be on.

**Host permission: `http://127.0.0.1:8765/*` and `http://localhost:8765/*`**
> AnkiConnect, the add-on that lets Anki accept a card from outside,
> listens on this port on the user's own machine. This is how a card is
> created. It is contacted only when the user presses + on a word or opens
> the Anki settings page, and it is not on the network.

**Host permission: `https://assets.languagepod101.com/*`**
> A word's pronunciation for a Japanese card, and only when the user's
> note type has a field mapped to word audio. The request contains the
> word being looked up and nothing else.

**Host permission: `https://upload.wikimedia.org/*`**
> The same thing for an Italian or Spanish card: a Lingua Libre recording
> hosted on Wikimedia Commons, CC BY-SA. Which words have a recording is
> decided when the dictionary is built, so this fetches a known file
> rather than searching for the word.

**Host permissions: `https://www.youtube.com/*` and `*://*.netflix.com/*`**
> Fetching the subtitle track of the video the user has open, so each line
> can be timed. The same request the player itself makes, for the video
> already on screen.

**Remote code.** No. Every line of JavaScript that runs is in the package.
Nothing is fetched and evaluated; nothing is loaded from a CDN. Answer
Chrome's "Are you using remote code?" with *No, I am not using remote code*.

---

## Data usage disclosure (Chrome) / data collection (Firefox)

The honest answer is the short one: **none of the categories apply.** Do
not tick a single box. The manifest already says so formally, in
`browser_specific_settings.gecko.data_collection_permissions`, which is set
to `["none"]`, and PRIVACY.md says it in prose.

Then tick all three of Chrome's certifications, which are true:

- the data is not sold to third parties
- it is not used or transferred for any purpose unrelated to the single purpose
- it is not used or transferred to determine creditworthiness or for lending

**Privacy policy URL.** https://jacobgerritz.github.io/Torval/privacy.html
(both stores require this, and both will reject a link to a raw Markdown
file on GitHub as insufficiently a policy).

---

## Notes for the Firefox reviewer

AMO reviews source, and this add-on ships large generated JSON files, which
looks like obfuscation if it is not explained. Say this:

> The add-on contains no minified, obfuscated or generated JavaScript.
> Every .js file is the original source, commented.
>
> It does contain generated data: extension/data/, extension/data-it/ and
> extension/data-es/ hold the dictionaries as chunked JSON. These are built
> from public dumps by the scripts in tools/, and are not written by hand.
> To reproduce them from a clean checkout of
> https://github.com/jacobgerritz/Torval :
>
>     node tools/build-dict.mjs      # Japanese, from JMdict (EDRDG)
>     node tools/build-pitch.mjs     # pitch accent, from Kanjium
>     node tools/build-dict-it.mjs   # Italian, from Wiktextract
>     node tools/build-dict-es.mjs   # Spanish, from Wiktextract
>     node tools/package.mjs --firefox
>
> Each build script downloads its own source data on first run; the URLs
> are at the top of each file. Node 18 or later and no npm dependencies.
> The two Latin builds also call `xz` to unpack one of their frequency
> lists; it is present on every Linux and on macOS. tools/test.mjs runs the test suite against the built
> dictionaries.
>
> The add-on is GPL-3.0. Its data keeps the licences of its sources, listed
> in the add-on's own About panel and in README.md.
>
> The Firefox package deliberately differs from the Chrome one in two
> places, both built by tools/package.mjs from the single
> extension/manifest.json: webRequestBlocking against declarativeNetRequest,
> and the absence here of tabCapture, the offscreen permission and
> offscreen.html/offscreen.js. Those last are Chrome's only way to record a
> copy-protected video's sound, which Firefox has no API for at all, so
> shipping them here would be dead code in a review that reads every line.

---

## Before you press submit

- [ ] The manifests match what is written above. `activeTab`, `tabCapture`
      and `offscreen` all arrived late, and a justification that does not
      list a permission the package asks for is a rejection.
- [ ] Screenshots. Both stores want real captures, not mockups. The site's
      drawn popup will not do. Five is plenty: the popup over a real page,
      the comprehension bar on a YouTube video, a subtitle line with the
      popup open over it, the Anki field mapping, the known-words page.
      Chrome wants 1280×800 or 640×400.
- [x] Version is 1.0.0. A store version number cannot be reused, so if
      anything changes before the first upload, bump it again.
- [ ] Privacy policy is actually live at the URL above (GitHub Pages must
      be switched on first, Settings → Pages → main /docs).
- [ ] The two builds install and run: `node tools/package.mjs`, then load
      each zip in its own browser. The Chrome service worker and the
      declarativeNetRequest rule have no Firefox equivalent and are the two
      things most likely to be wrong.
- [x] The AnkiWeb link on the Words page is a real one: `596526198`, handed
      out at the first upload. `node tools/package.mjs` still watches for the
      placeholder coming back.
- [x] Chrome's one-time $5 developer registration is paid.
- [ ] Nothing in the console. Torval says nothing on an ordinary page now,
      and narrates itself only when the box on the About panel is ticked.
      Worth confirming on a YouTube video, since that is the one path that
      used to talk the whole way through.
