"""
Torval, the way back out of Anki.

Torval learns which words you know from what you mark while reading, which
is fine from the day you install it and useless about the years before
that. Anki already knows: every card you have matured is a word you have
decided you know, and the whole point of having built that deck is not to
be asked about those words again.

So this walks the collection and hands the words back in the two shapes
Torval will take them in.

  Save a file          torval-words-<date>.json, which goes into
                       Settings -> Words -> Keeping a copy -> Load from a
                       file. It carries a date per word, taken from when
                       the card was made, and Torval merges rather than
                       replaces, so loading it twice changes nothing.

  Copy to clipboard    one word per line, for the "Add from a text" box on
                       the same page. Simpler, and loses the dates.

Mature cards are the obvious thing to export and, on their own, the wrong
thing. A word you are three days into learning is still a word you know
when you meet it in a subtitle, and counting it as unknown makes the
comprehension score say a page is harder than it is. So learning,
relearning and young cards come too, and each is a tick box in case you
disagree.

New cards are not offered. A card you have never seen is a word you have
never studied, and there is nothing to export about it.

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

MENU_ITEM = "Export words to Torval"

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

# The article Torval puts on an Italian or Spanish noun when it makes the
# card, which is not part of the word and would not be found in a text.
# Apostrophes are both kinds, because Anki holds whichever one was typed.
ARTICLE = re.compile(
    r"^(?:il|lo|la|i|gli|le|un|uno|una|el|los|las|un|unos|unas)\s+"
    r"|^(?:l|un|d|dell|all|nell)['’]",
    re.IGNORECASE,
)


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
    where = "(%s)" % wanted
    if deck_name:
        safe = deck_name.replace("\\", "\\\\").replace('"', '\\"')
        return 'deck:"%s" %s' % (safe, where)
    return where


def collect(deck_name, states, field_name, strip_article):
    """
    Every word found, as word -> when its earliest card was made.

    Anki's card ids are the millisecond the card was created, which is the
    closest thing in the collection to "when did you start knowing this"
    and is exactly the shape Torval stores. Where a word has several cards,
    the oldest wins, which is what Torval does with its own duplicates too.
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
    """Every field name in play, so the chooser offers real answers only."""
    names = []
    seen = set()
    query = 'deck:"%s"' % deck_name.replace("\\", "\\\\").replace('"', '\\"') \
        if deck_name else ""
    try:
        note_ids = mw.col.find_notes(query)
    except Exception:
        note_ids = []

    mids = set()
    for note_id in note_ids[:2000]:      # enough to see every note type in a deck
        mids.add(mw.col.get_note(note_id).mid)
    if not mids:
        mids = {m.id for m in mw.col.models.all_names_and_ids()}

    for mid in mids:
        model = mw.col.models.get(mid)
        if not model:
            continue
        for field in model["flds"]:
            if field["name"] not in seen:
                seen.add(field["name"])
                names.append(field["name"])
    return names


# Field names worth guessing at, best first, matched case-insensitively.
LIKELY = ["target word", "word", "expression", "vocabulary", "vocab",
          "front", "term", "headword"]


def best_guess(names):
    lowered = {name.lower(): name for name in names}
    for guess in LIKELY:
        if guess in lowered:
            return lowered[guess]
    return names[0] if names else ""


class ExportDialog(QDialog):
    def __init__(self, parent):
        QDialog.__init__(self, parent)
        self.setWindowTitle(MENU_ITEM)
        self.setMinimumWidth(460)

        layout = QVBoxLayout(self)

        blurb = QLabel(
            "Words you already know, for Torval's known-words list.\n"
            "Save a file and load it under Settings → Words → Keeping a copy,\n"
            "or copy the words and paste them into “Add from a text”."
        )
        blurb.setWordWrap(True)
        layout.addWidget(blurb)
        layout.addSpacing(8)

        form = QFormLayout()
        self.decks = QComboBox()
        self.decks.addItem("Whole collection", "")
        for deck in sorted(mw.col.decks.all_names_and_ids(), key=lambda d: d.name):
            self.decks.addItem(deck.name, deck.name)
        qconnect(self.decks.currentIndexChanged, self.fill_fields)
        form.addRow("Deck", self.decks)

        self.fields = QComboBox()
        form.addRow("Word field", self.fields)
        layout.addLayout(form)

        layout.addSpacing(8)
        layout.addWidget(QLabel("Include"))
        self.states = {}
        for key, label, _ in STATES:
            box = QCheckBox(label)
            box.setChecked(True)
            self.states[key] = box
            layout.addWidget(box)

        layout.addSpacing(8)
        self.tidy_article = QCheckBox(
            "Drop a leading article (il cane → cane)")
        self.tidy_article.setChecked(True)
        self.tidy_article.setToolTip(
            "Torval writes the article onto Italian and Spanish cards, "
            "because it is half of what there is to know about a noun. "
            "It is not part of the word, so it comes off again here.")
        layout.addWidget(self.tidy_article)

        self.note = QLabel("")
        self.note.setWordWrap(True)
        layout.addSpacing(6)
        layout.addWidget(self.note)

        buttons = QHBoxLayout()
        self.count_button = QPushButton("Count them")
        qconnect(self.count_button.clicked, self.count)
        buttons.addWidget(self.count_button)
        buttons.addStretch(1)
        copy_button = QPushButton("Copy to clipboard")
        qconnect(copy_button.clicked, self.to_clipboard)
        buttons.addWidget(copy_button)
        save_button = QPushButton("Save a file…")
        save_button.setDefault(True)
        qconnect(save_button.clicked, self.to_file)
        buttons.addWidget(save_button)
        layout.addLayout(buttons)

        self.fill_fields()

    def fill_fields(self):
        names = field_names(self.decks.currentData())
        self.fields.clear()
        self.fields.addItems(names)
        guess = best_guess(names)
        if guess:
            self.fields.setCurrentText(guess)

    def chosen_states(self):
        return {key for key, box in self.states.items() if box.isChecked()}

    def gather(self):
        states = self.chosen_states()
        if not states:
            showWarning("Tick at least one kind of card to export.")
            return None
        field = self.fields.currentText()
        if not field:
            showWarning("No field chosen. Is the deck empty?")
            return None
        mw.progress.start(label="Reading the collection…")
        try:
            words, looked_at = collect(
                self.decks.currentData(), states, field,
                self.tidy_article.isChecked())
        finally:
            mw.progress.finish()
        if not words:
            showInfo(
                "Nothing to export.\n\nNo cards matched, or the field "
                "“%s” is empty on the ones that did." % field)
            return None
        self.note.setText(
            "%d cards read, %d different words." % (looked_at, len(words)))
        return words

    def to_clipboard(self):
        words = self.gather()
        if not words:
            return
        # Oldest first, which is the order they were learned in and the
        # order that reads most sensibly if anybody opens the list.
        ordered = sorted(words, key=lambda word: words[word])
        QApplication.clipboard().setText("\n".join(ordered))
        showInfo(
            "%d words copied.\n\nIn Torval: Settings → Words → "
            "Add from a text, paste, then Add these words." % len(words))

    def to_file(self):
        words = self.gather()
        if not words:
            return
        day = time.strftime("%Y-%m-%d")
        path = getSaveFile(
            self, "Save the words for Torval", "torval-export",
            "JSON file", ".json", fname="torval-words-%s.json" % day)
        if not path:
            return
        payload = {
            "format": "torval-words",
            "version": 1,
            "saved": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "known": words,
            "ignored": {},
        }
        try:
            with open(path, "w", encoding="utf-8") as out:
                json.dump(payload, out, ensure_ascii=False, indent=2)
        except OSError as err:
            showWarning("Could not write that file:\n\n%s" % err)
            return
        showInfo(
            "%d words written to\n%s\n\nIn Torval: Settings → Words "
            "→ Keeping a copy → Load from a file."
            % (len(words), os.path.basename(path)))

    def count(self):
        words = self.gather()
        if words:
            showInfo("%d different words would be exported." % len(words))


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
