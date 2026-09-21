"""
Export Known Words.

Your collection already knows which words you know. Every card you have
matured is a word you decided on, and the whole point of having built the
deck is never to be asked about those words again. This gets that list
back out, in whatever shape the thing you are feeding it wants.

Three ways out, and none of them is more official than the others:

  Text file     one word per line. What most things read.
  Clipboard     the same, for pasting straight into something.
  Torval JSON   for Torval, a pop-up dictionary that keeps a list of the
                words you already know and uses it to say how much of a
                page you will understand. Its format is the plain list
                plus a date per word, which a text file cannot carry.
                https://github.com/jacobgerritz/Torval

One deck at a time, and no option to do the whole collection. A
collection is usually more than one language, and a known-words list with
two languages in it is not a known-words list, it is a mess that
something downstream will quietly believe.

Mature cards are the obvious thing to export and, on their own, the wrong
thing. A word you are three days into learning is still a word you know
when you meet it in a subtitle, and counting it as unknown makes any
comprehension estimate say a text is harder than it is. So learning,
relearning and young cards come too, and each is a tick box in case you
disagree. New cards are not offered: a card you have never seen is a word
you have never studied.

Install by copying this folder into Anki's addons21 directory. It is one
file on purpose.
"""

import json
import os
import re
import time

from anki.hooks import addHook
from aqt import mw
from aqt.qt import *
from aqt.utils import getSaveFile, qconnect, showInfo, showWarning

MENU_ITEM = "Export Known Words…"

# Anki's own definition, and the one the scheduler uses: a review card is
# mature once its interval reaches three weeks.
MATURE_DAYS = 21

# Each state, and the search that finds it. Written out rather than
# assembled, because these are exactly the four searches somebody would
# check by hand in the browser, and they should be the same strings.
STATES = [
    ("mature", "Mature (%d days or more)" % MATURE_DAYS,
     "(is:review -is:learn prop:ivl>=%d)" % MATURE_DAYS),
    ("young", "Young (a review card, under %d days)" % MATURE_DAYS,
     "(is:review -is:learn prop:ivl<%d)" % MATURE_DAYS),
    ("learning", "Learning", "(is:learn -is:review)"),
    ("relearning", "Relearning", "(is:learn is:review)"),
]

# Anki writes a reading as 漢字[かんじ], sound as [sound:file.mp3], and
# anything a card ever showed in bold as HTML. None of that is the word.
FURIGANA = re.compile(r"([^\s\[\]]+)\[[^\]]*\]")
SOUND = re.compile(r"\[sound:[^\]]*\]")
TAG = re.compile(r"<[^>]+>")
CLOZE = re.compile(r"\{\{c\d+::(.*?)(?:::.*?)?\}\}")
SPACES = re.compile(r"\s+")

# The article many decks put on a Romance noun, because the gender is half
# of what there is to know about one. It is not part of the word, and no
# text would ever be searched for it. Both apostrophes, because Anki holds
# whichever one was typed.
ARTICLE = re.compile(
    r"^(?:il|lo|la|i|gli|le|un|uno|una|el|los|las|unos|unas)\s+"
    r"|^(?:l|un|d|dell|all|nell)['’]",
    re.IGNORECASE,
)

# Field names worth guessing at, best first, matched without regard to case.
LIKELY = ["target word", "word", "expression", "vocabulary", "vocab",
          "front", "term", "headword"]


# A deck name fit to sit in a filename. Subdecks are Spanish::Verbs, and a
# colon is not a filename on Windows or a path on anything.
UNFIT = re.compile(r"[^\w\- ]", re.UNICODE)


def quoted(deck_name):
    return deck_name.replace("\\", "\\\\").replace('"', '\\"')


def file_slug(deck_name):
    """
    A deck's name, as part of a filename.

    Exporting three decks on the same day used to write the same name
    three times, which means either three overwrites or three files
    telling you nothing about which deck each holds. Non-Latin names are
    kept as they are: a deck called 日本語 is called that in the filename
    too, since every system this runs on writes those perfectly well.
    """
    name = deck_name.replace("::", "-").replace("/", "-").replace("\\", "-")
    name = UNFIT.sub("", name)
    name = SPACES.sub("-", name.strip())
    return name[:40].strip("-") or "deck"


def tidy(text, strip_article):
    """One field, as the word it is about."""
    out = SOUND.sub(" ", text)
    out = CLOZE.sub(r"\1", out)
    out = TAG.sub(" ", out)
    out = out.replace("&nbsp;", " ").replace("&amp;", "&")
    out = out.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
    # Furigana last, so a reading that was wrapped in a tag is gone first.
    out = FURIGANA.sub(r"\1", out)
    out = SPACES.sub(" ", out).strip()
    if strip_article:
        out = ARTICLE.sub("", out).strip()
    return out


def search_for(deck_name, states):
    """The Anki search that finds every card being exported."""
    wanted = " OR ".join(query for key, _, query in STATES if key in states)
    if not wanted:
        return None
    return 'deck:"%s" (%s)' % (quoted(deck_name), wanted)


def collect(deck_name, states, field_name, strip_article):
    """
    Every word found, as word -> when its earliest card was made.

    Anki's card ids are the millisecond the card was created, which is the
    closest thing in the collection to "when did you start knowing this".
    Where a word has several cards the oldest wins.
    """
    query = search_for(deck_name, states)
    if query is None:
        return {}, 0

    words = {}
    looked_at = 0
    field_index = {}      # note type id -> index of the chosen field

    for card_id in mw.col.find_cards(query):
        card = mw.col.get_card(card_id)
        note = card.note()
        if note is None:
            continue
        looked_at += 1

        note_type = note.note_type()
        if note_type is None:
            continue
        mid = note_type["id"]
        if mid not in field_index:
            found = None
            for i, field in enumerate(note_type["flds"]):
                if field["name"] == field_name:
                    found = i
                    break
            field_index[mid] = found
        where = field_index[mid]
        if where is None or where >= len(note.fields):
            continue

        word = tidy(note.fields[where], strip_article)
        if not word:
            continue
        when = int(card.id)
        if word not in words or when < words[word]:
            words[word] = when

    return words, looked_at


def field_names(deck_name):
    """Every field name in this deck, so the chooser offers real answers."""
    names = []
    seen = set()
    try:
        note_ids = mw.col.find_notes('deck:"%s"' % quoted(deck_name))
    except Exception:
        return names

    mids = set()
    for note_id in note_ids[:2000]:   # enough to meet every note type in a deck
        mids.add(mw.col.get_note(note_id).mid)

    for mid in mids:
        model = mw.col.models.get(mid)
        if not model:
            continue
        for field in model["flds"]:
            if field["name"] not in seen:
                seen.add(field["name"])
                names.append(field["name"])
    return names


def best_guess(names):
    lowered = {name.lower(): name for name in names}
    for guess in LIKELY:
        if guess in lowered:
            return lowered[guess]
    return names[0] if names else ""


class ExportDialog(QDialog):
    def __init__(self, parent):
        QDialog.__init__(self, parent)
        self.setWindowTitle("Export Known Words")
        self.setMinimumWidth(440)

        layout = QVBoxLayout(self)

        form = QFormLayout()
        self.decks = QComboBox()
        for deck in sorted(mw.col.decks.all_names_and_ids(), key=lambda d: d.name):
            self.decks.addItem(deck.name, deck.name)
        # Whichever deck is open in Anki, which is nearly always the one
        # somebody came here about.
        current = (mw.col.decks.current() or {}).get("name")
        if current:
            at = self.decks.findData(current)
            if at >= 0:
                self.decks.setCurrentIndex(at)
        qconnect(self.decks.currentIndexChanged, self.fill_fields)
        form.addRow("Deck", self.decks)

        self.fields = QComboBox()
        form.addRow("Word field", self.fields)
        layout.addLayout(form)

        layout.addSpacing(10)
        layout.addWidget(QLabel("Include"))
        self.states = {}
        for key, label, _ in STATES:
            box = QCheckBox(label)
            box.setChecked(True)
            self.states[key] = box
            layout.addWidget(box)

        layout.addSpacing(10)
        self.tidy_article = QCheckBox("Drop a leading article (il cane → cane)")
        self.tidy_article.setChecked(True)
        layout.addWidget(self.tidy_article)

        layout.addSpacing(12)
        buttons = QHBoxLayout()
        buttons.addStretch(1)
        for label, tip, slot, default in [
            ("Copy", "One word per line, on the clipboard.", self.to_clipboard, False),
            ("Save as text…", "One word per line. What most things read.",
             self.to_text, True),
            ("Save for Torval…",
             "Torval’s own format, which also carries the date each word "
             "was first studied.", self.to_torval, False),
        ]:
            button = QPushButton(label)
            button.setToolTip(tip)
            button.setDefault(default)
            qconnect(button.clicked, slot)
            buttons.addWidget(button)
        layout.addLayout(buttons)

        self.fill_fields()

    def fill_fields(self):
        names = field_names(self.decks.currentData())
        self.fields.clear()
        self.fields.addItems(names)
        guess = best_guess(names)
        if guess:
            self.fields.setCurrentText(guess)

    def gather(self):
        states = {key for key, box in self.states.items() if box.isChecked()}
        if not states:
            showWarning("Tick at least one kind of card to export.")
            return None
        field = self.fields.currentText()
        if not field:
            showWarning("No field chosen. Is that deck empty?")
            return None
        mw.progress.start(label="Reading the deck…")
        try:
            words, _ = collect(self.decks.currentData(), states, field,
                               self.tidy_article.isChecked())
        finally:
            mw.progress.finish()
        if not words:
            showInfo("Nothing to export.\n\nNo cards matched, or the field "
                     "“%s” is empty on the ones that did." % field)
            return None
        return words

    @staticmethod
    def in_order(words):
        """
        Oldest first, which is the order they were learned in. Not
        alphabetical, which is an order nobody learned anything in.
        """
        return sorted(words, key=lambda word: words[word])

    def to_clipboard(self):
        words = self.gather()
        if not words:
            return
        QApplication.clipboard().setText("\n".join(self.in_order(words)))
        showInfo("%d words copied, one per line." % len(words))

    def to_text(self):
        words = self.gather()
        if not words:
            return
        path = self.ask_where("known-words-%s-%s.txt"
                              % (file_slug(self.decks.currentData()),
                                 time.strftime("%Y-%m-%d")),
                              "Text file", ".txt")
        if path and self.write(path, "\n".join(self.in_order(words)) + "\n"):
            showInfo("%d words written to\n%s" % (len(words), os.path.basename(path)))

    def to_torval(self):
        """
        Torval's own format: the same list, plus the date each word was
        first studied.

        The date is what makes loading the same export twice harmless.
        Torval merges rather than replaces and keeps the earlier of the two
        dates, so nothing is overwritten and nothing counted again.

        The file is named for Anki and for the deck, not for Torval. Torval
        writes its own backups as torval-words-<date>.json, and two files
        with one name in one Downloads folder is how somebody ends up
        loading last week's Anki deck back over a list they meant to
        restore.
        """
        words = self.gather()
        if not words:
            return
        path = self.ask_where("anki-known-words-%s-%s.json"
                              % (file_slug(self.decks.currentData()),
                                 time.strftime("%Y-%m-%d")),
                              "JSON file", ".json")
        if not path:
            return
        payload = {
            "format": "torval-words",
            "version": 1,
            "saved": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "known": words,
            "ignored": {},
        }
        if self.write(path, json.dumps(payload, ensure_ascii=False, indent=2)):
            showInfo("%d words written to\n%s\n\nIn Torval: Settings → Words "
                     "→ Keeping a copy → Load from a file."
                     % (len(words), os.path.basename(path)))

    def ask_where(self, suggested, description, ext):
        return getSaveFile(self, "Save the words", "known-words-export",
                           description, ext, fname=suggested)

    @staticmethod
    def write(path, body):
        try:
            with open(path, "w", encoding="utf-8") as out:
                out.write(body)
        except OSError as err:
            showWarning("Could not write that file:\n\n%s" % err)
            return False
        return True


def run():
    if mw.col is None:
        showWarning("Open a collection first.")
        return
    ExportDialog(mw).exec()


def setup_menu():
    for action in mw.form.menuTools.actions():
        if action.text() == MENU_ITEM:
            mw.form.menuTools.removeAction(action)
    action = QAction(MENU_ITEM, mw)
    qconnect(action.triggered, run)
    mw.form.menuTools.addAction(action)


addHook("profileLoaded", setup_menu)
