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

In `listing-description.md`, beside this file, so it can be pasted whole
without picking it out of anything.

Markdown and basic HTML both work in that field, but not all of markdown:
**tables do not render**, and one pasted in comes out as a row of pipes and
dashes in the middle of a paragraph. Lists, headings, bold, italics, `code`
and links are all fine.
