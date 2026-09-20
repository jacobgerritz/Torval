# Privacy

Torval collects nothing.

There is no account, no telemetry, no analytics, no crash reporting and no
server belonging to this project. Nothing you read, look up, mark as known or
add to Anki leaves your computer, and none of it is visible to anybody but
you.

## What is stored, and where

All of it is in your own browser profile, and all of it is deleted when the
add-on is.

| What | Where |
|---|---|
| The dictionaries | IndexedDB, one database per language, built from files that ship inside the add-on |
| Your known and ignored word lists | The add-on's own storage |
| Anki deck, note type and field settings | The add-on's own storage |
| Which language you are reading, and whether Torval is on | The add-on's own storage |
| Where you dragged the subtitle line | The add-on's own storage |
| Any keyboard shortcut you have changed | The add-on's own storage |
| How fast to play the quiet parts of a video | The add-on's own storage |

Once a day, Torval also writes both word lists to **Downloads/Torval** as a
plain JSON file. That is a file on your disk like any other download; it is
there because an add-on loaded temporarily is thrown away when Firefox
restarts, and a word list is months of reading. Delete the folder if you
would rather it did not.

## What Torval connects to

Three things, each of them the direct consequence of something you asked
for. Nothing is contacted in the background.

**The video site you are watching.** On YouTube, Torval asks for the subtitle
track of the video you have open, the same request the player itself makes,
so it can know when each line starts and ends. On Netflix it takes a copy of
the subtitle file the player was already given. Only the page you are on,
only while you are on it.

**AnkiConnect, on your own machine.** `http://127.0.0.1:8765`, and only when
you press **+** on a word or open the Anki settings. This is Anki running on
your computer; it is not on the network.

**assets.languagepod101.com**, for a Japanese word's pronunciation, and only
when a card you are making asks for word audio. That request contains the word.

**upload.wikimedia.org**, for an Italian or Spanish word's pronunciation,
under the same condition. The recordings are Lingua Libre's, hosted on
Wikimedia Commons. Which words have one is settled when the dictionary is
built, so Torval only asks for a file it already knows is there, and the
request is for that file rather than a search for the word.

## What the permissions are for

Firefox asks you to trust a list of permissions, so here is what each one is
actually doing.

- **Access your data for all websites**: reading the text of a page is the
  whole program. Torval looks at the words under your cursor and draws a
  popup. It reads pages; it does not send them anywhere.
- **Storage** and **unlimited storage**: the dictionaries are large. That is
  all this is.
- **Downloads**: the daily copy of your word lists, described above.
- **webRequest**: two narrow uses, both on video sites. One notices the
  address YouTube's own player uses for subtitles, because that address
  cannot be reconstructed. The other adds a permission header to the reply
  so the extension is allowed to read it.
- **Scripting**: Netflix's subtitle file is only visible to code running as
  part of the page, so a small script is injected there to take a copy.

## Questions

Open an issue at <https://github.com/jacobgerritz/Torval/issues>.
