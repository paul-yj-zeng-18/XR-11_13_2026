"""picavoice: automatically remember the people you talk to.

FieldAssist (server/ingest.ts) records each conversation from the Mentra Live
glasses into data/fieldassist.sqlite: a WAV per session plus Deepgram
utterances labelled with anonymous, per-session speakers (S0, S1, ...).
picavoice watches that database and turns those anonymous speakers into people
it remembers across conversations:

  1. Voice: for every speaker in a session it builds an ECAPA voiceprint (the
     model from voice_profiles.py) and compares it with every known person.
       - confident match   -> that person; their profile is refined with the
                              new audio when the score is high enough
       - clearly new voice -> a new placeholder person ("Unknown voice #7")
       - unsure            -> wait for more audio before deciding
  2. Names and context: it reads what each person said and keeps facts such as
     their name ("my name is Sam"), where they work, what they study, where they
     are from, why they are here, and how you met ("we met at the career fair").
  3. Encounters: one row per person per conversation with when it happened,
     where (GPS from the phone, if it was sent), how long they spoke and a
     snippet of what they said.

When someone you have met before starts talking, picavoice prints a reminder:
who they are, when and where you met, and what you know about them.

Commands (run from this folder, with the same venv as voice_profiles.py):
  python picavoice.py watch            # default: run alongside ./run.sh
  python picavoice.py once             # process what is in the database, then exit
  python picavoice.py people           # everyone it knows
  python picavoice.py show 3           # one person's profile, facts and encounters
  python picavoice.py rename 3 "Sam Lee"
  python picavoice.py me 1             # mark the wearer's own voice (never "met")
  python picavoice.py merge 5 3        # person 5 was really person 3
  python picavoice.py forget 5         # delete a person, their voiceprints and facts

Profiles created with `voice_profiles.py meet` (profiles.json) are imported
automatically, so people you enrolled by hand are recognised too.

Voiceprints are biometric data. Profiles created automatically are marked as
having no recorded consent (people.consent_recorded_at is NULL); use `forget`
to delete anyone who asks, and check the rules where you use this (e.g. Illinois
BIPA) before recording people who have not agreed to it.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np

from voice_profiles import MIN_LEAD, MIN_SIMILARITY, PROFILES_FILE, PROJECT_DIR

DEFAULT_DB = Path(os.environ.get("FIELDASSIST_DB") or PROJECT_DIR.parent / "data" / "fieldassist.sqlite")
MODEL_NAME = "speechbrain/spkrec-ecapa-voxceleb"

MIN_SECONDS = 2.0          # speech needed from a speaker before trying to identify them
MAX_SECONDS = 15.0         # more than this per embedding adds little
NEW_VOICE_SECONDS = 6.0    # only create a new person once we have this much of their speech
NEW_VOICE_BELOW = 0.45     # best score under this is "clearly a different voice"
UPDATE_SIMILARITY = 0.70   # only refine a profile with audio that matches it this well
MISMATCH_BELOW = 0.35      # new audio this far from the assigned person: diarization mix-up, ignore
CENTROID_MEMORY = 20       # profile = running mean of at most this many recent observations
POLL_SECONDS = 5.0

FACT_KINDS = ("name", "work", "role", "study", "from", "lives", "why", "how_met")


# --------------------------------------------------------------------------- schema

def connect(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        raise SystemExit(f"No database at {db_path}. Run FieldAssist (./run.sh) first.")
    db = sqlite3.connect(db_path, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    ensure_schema(db)
    return db


def ensure_schema(db: sqlite3.Connection) -> None:
    """Add picavoice's tables/columns next to the ones server/store.ts creates."""
    db.execute("""CREATE TABLE IF NOT EXISTS people (
        id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT NOT NULL, created_at INTEGER NOT NULL, notes TEXT)""")
    db.execute("""CREATE TABLE IF NOT EXISTS voiceprints (
        id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL REFERENCES people(id), embedding BLOB NOT NULL,
        dims INTEGER NOT NULL, model TEXT NOT NULL, source_run_id TEXT, source_t_start REAL, source_t_end REAL,
        created_at INTEGER NOT NULL)""")
    db.execute("""CREATE TABLE IF NOT EXISTS speaker_assignments (
        run_id TEXT NOT NULL, speaker_label TEXT NOT NULL, person_id INTEGER NOT NULL REFERENCES people(id),
        confidence REAL, method TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (run_id, speaker_label))""")
    have = {r["name"] for r in db.execute("PRAGMA table_info(people)")}
    for col, decl in [
        ("embedding", "BLOB"),                       # current voice profile (float32, unit length)
        ("embedding_count", "INTEGER NOT NULL DEFAULT 0"),
        ("is_placeholder", "INTEGER NOT NULL DEFAULT 0"),  # 1 until we learn a real name
        ("is_me", "INTEGER NOT NULL DEFAULT 0"),
        ("first_met_at", "INTEGER"),
        ("last_seen_at", "INTEGER"),
        ("times_met", "INTEGER NOT NULL DEFAULT 0"),
        ("consent_recorded_at", "TEXT"),
        ("profile_uuid", "TEXT"),                    # id from profiles.json, for enrolled people
    ]:
        if col not in have:
            db.execute(f"ALTER TABLE people ADD COLUMN {col} {decl}")
    db.execute("""CREATE TABLE IF NOT EXISTS encounters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL, speaker_label TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, speech_seconds REAL NOT NULL DEFAULT 0,
        lat REAL, lng REAL, snippet TEXT,
        UNIQUE (person_id, run_id))""")
    db.execute("""CREATE TABLE IF NOT EXISTS person_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, value TEXT NOT NULL, confidence REAL NOT NULL,
        source TEXT NOT NULL,              -- 'self' (they said it) or 'other' (someone said it about them)
        run_id TEXT, utterance_id INTEGER, times_heard INTEGER NOT NULL DEFAULT 1,
        first_heard_at INTEGER NOT NULL, last_heard_at INTEGER NOT NULL,
        UNIQUE (person_id, kind, value))""")
    db.execute("""CREATE TABLE IF NOT EXISTS picavoice_progress (
        run_id TEXT NOT NULL, speaker_label TEXT NOT NULL,
        person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
        last_utterance_id INTEGER NOT NULL DEFAULT 0,   -- utterances up to here are learned from
        last_embedded_id INTEGER NOT NULL DEFAULT 0,    -- utterances up to here are in the voice profile
        status TEXT NOT NULL DEFAULT 'pending',          -- pending | assigned | ambiguous
        PRIMARY KEY (run_id, speaker_label))""")
    db.commit()


# --------------------------------------------------------------------------- vectors

def to_blob(v: np.ndarray) -> bytes:
    return np.asarray(v, dtype=np.float32).tobytes()


def from_blob(b: bytes) -> np.ndarray:
    return np.frombuffer(b, dtype=np.float32).copy()


def unit(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return v / n if n else v


def rank(voice: np.ndarray, people: list[sqlite3.Row]) -> list[tuple[float, sqlite3.Row]]:
    scored = [(float(np.dot(voice, from_blob(p["embedding"]))), p) for p in people if p["embedding"]]
    return sorted(scored, key=lambda s: s[0], reverse=True)


def blend(profile: np.ndarray, count: int, voice: np.ndarray) -> np.ndarray:
    """Running mean that forgets slowly: old profile weighs at most CENTROID_MEMORY observations."""
    w = min(count, CENTROID_MEMORY)
    return unit(profile * w + voice)


# --------------------------------------------------------------------------- facts from speech

_NAME = r"([A-Z][a-z'\-]+(?: [A-Z][a-z'\-]+)?)"
_END = r"(?=[.,!?;]| and | but | so |$)"
_NOT_NAMES = {
    "Sorry", "Good", "Fine", "Okay", "Ok", "Just", "Not", "Here", "There", "So", "Going", "From", "Really",
    "Sure", "Glad", "Happy", "Great", "Well", "Back", "Done", "Ready", "Sorry", "Excited", "Doing", "Gonna",
    "The", "A", "An", "And", "But", "Yes", "Yeah", "No", "Actually", "Also", "Still", "Always", "Very",
    "Like", "Kind", "Pretty", "Trying", "Looking", "Working", "Studying", "Thinking", "Hungry", "Tired",
    "Mentra", "Deepgram", "I", "It", "This", "That", "What", "Who", "Me", "You", "We", "They",
}
_SELF_NAME = [
    re.compile(r"\bmy name(?:'s| is)\s+" + _NAME),
    re.compile(r"\b(?:I'm|I am|call me|it's|this is)\s+" + _NAME + r"(?=[.,!?]|$| here| by the way| and)"),
]
_ADDRESSED_NAME = [
    re.compile(r"\b(?:[Nn]ice|[Gg]ood|[Gg]reat|[Pp]leased|[Hh]appy) to meet you,?\s+" + _NAME),
    re.compile(r"^(?:[Hh]i|[Hh]ey|[Hh]ello|[Tt]hanks|[Tt]hank you),?\s+" + _NAME + r"[.,!?]"),
]
_SELF_FACTS = [
    ("work", re.compile(r"\bI (?:work|intern|am interning|'m interning) (?:at|for|with) (.+?)" + _END)),
    ("role", re.compile(r"\bI(?:'m| am) (?:a|an) ((?:[a-z]+ ){0,3}(?:engineer|developer|student|designer|manager|"
                        r"researcher|professor|teacher|doctor|nurse|founder|analyst|scientist|intern|lawyer|"
                        r"recruiter|consultant|artist|writer|freshman|sophomore|junior|senior|grad student|"
                        r"PhD student|postdoc|TA))\b")),
    ("study", re.compile(r"\bI(?:'m| am) (?:studying|majoring in|doing a PhD in|a [a-z]+ major in) (.+?)" + _END)),
    ("study", re.compile(r"\bI study (.+?)" + _END)),
    ("from", re.compile(r"\bI(?:'m| am) (?:originally )?from (.+?)" + _END)),
    ("lives", re.compile(r"\bI live (?:in|near|by) (.+?)" + _END)),
    ("why", re.compile(r"\bI(?:'m| am) here (?:for|to|because) (.+?)" + _END)),
]
_SHARED_FACTS = [
    ("how_met", re.compile(r"\b[Ww]e (?:first )?met (?:at|in|during|through|on) (.+?)" + _END)),
]


def _clean(value: str, max_words: int = 7) -> str | None:
    value = value.strip(" .,!?;:'\"")
    words = value.split()
    if not words or len(words) > max_words:
        return None
    return " ".join(words)


def _clean_name(raw: str) -> str | None:
    parts = [p for p in raw.split() if p not in _NOT_NAMES]
    if not parts or raw.split()[0] in _NOT_NAMES:
        return None
    return " ".join(parts)


def facts_from_own_words(text: str) -> list[tuple[str, str, float]]:
    """Facts a speaker states about themself: [(kind, value, confidence)]."""
    out = []
    for pat in _SELF_NAME:
        for m in pat.finditer(text):
            name = _clean_name(m.group(1))
            if name:
                out.append(("name", name, 0.9))
    for kind, pat in _SELF_FACTS:
        for m in pat.finditer(text):
            v = _clean(m.group(1))
            if v:
                out.append((kind, v, 0.8))
    return out


def names_addressed(text: str) -> list[str]:
    """Names a speaker calls someone else ("nice to meet you, Sam")."""
    out = []
    for pat in _ADDRESSED_NAME:
        for m in pat.finditer(text):
            name = _clean_name(m.group(1))
            if name:
                out.append(name)
    return out


def shared_facts(text: str) -> list[tuple[str, str, float]]:
    """Facts about the conversation itself, true for everyone in it ("we met at ...")."""
    out = []
    for kind, pat in _SHARED_FACTS:
        for m in pat.finditer(text):
            v = _clean(m.group(1))
            if v:
                out.append((kind, v, 0.7))
    return out


# --------------------------------------------------------------------------- audio

def read_clip(wav_path: str, sample_rate: int, t_start: float, t_end: float) -> np.ndarray:
    import soundfile as sf

    piece, _ = sf.read(wav_path, start=int(t_start * sample_rate), stop=int(t_end * sample_rate),
                       dtype="float32", always_2d=True)
    return piece


class EcapaEmbedder:
    """Loads the SpeechBrain model on first use (it takes a few seconds)."""

    def __init__(self) -> None:
        self._model = None

    def __call__(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        from voice_profiles import embed_waveform, load_model

        if self._model is None:
            print("loading voice model...", flush=True)
            self._model = load_model()
        return embed_waveform(self._model, samples, sample_rate).numpy().astype(np.float32)


# --------------------------------------------------------------------------- the engine

def now_ms() -> int:
    return int(time.time() * 1000)


def fmt_day(ms: int | None) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M") if ms else "?"


class Picavoice:
    def __init__(self, db: sqlite3.Connection, embed=None, read=read_clip, profiles_file: Path = PROFILES_FILE,
                 out=print) -> None:
        self.db = db
        self.embed = embed or EcapaEmbedder()
        self.read = read
        self.profiles_file = profiles_file
        self.out = out

    # ---- enrolled profiles (voice_profiles.py meet) -> people rows
    def import_enrolled(self) -> None:
        if not self.profiles_file.exists():
            return
        for p in json.loads(self.profiles_file.read_text(encoding="utf-8")):
            row = self.db.execute("SELECT id FROM people WHERE profile_uuid = ?", (p["id"],)).fetchone()
            if row:
                continue
            emb = unit(np.asarray(p["embedding"], dtype=np.float32))
            byname = self.db.execute(
                "SELECT id FROM people WHERE display_name = ? AND profile_uuid IS NULL", (p["name"],)).fetchone()
            if byname:  # created earlier by bridge.py
                self.db.execute(
                    """UPDATE people SET profile_uuid = ?, embedding = COALESCE(embedding, ?),
                       embedding_count = MAX(embedding_count, 3), consent_recorded_at = ?, is_placeholder = 0
                       WHERE id = ?""", (p["id"], to_blob(emb), p.get("consent_recorded_at"), byname["id"]))
            else:
                self.db.execute(
                    """INSERT INTO people (display_name, created_at, notes, embedding, embedding_count,
                       consent_recorded_at, profile_uuid) VALUES (?, ?, ?, ?, 3, ?, ?)""",
                    (p["name"], now_ms(), p.get("note"), to_blob(emb), p.get("consent_recorded_at"), p["id"]))
                self.out(f"imported enrolled profile: {p['name']}")
        self.db.commit()

    # ---- one pass over everything new
    def process(self) -> None:
        self.import_enrolled()
        sessions = self.db.execute(
            """SELECT run_id, started_at, wav_path, sample_rate FROM sessions
               WHERE wav_path IS NOT NULL AND sample_rate IS NOT NULL ORDER BY started_at""").fetchall()
        for s in sessions:
            labels = self.db.execute(
                """SELECT u.speaker_label, MAX(u.id) AS max_id FROM utterances u
                   LEFT JOIN picavoice_progress p ON p.run_id = u.run_id AND p.speaker_label = u.speaker_label
                   WHERE u.run_id = ? AND u.speaker_label != 'S?'
                   GROUP BY u.speaker_label HAVING MAX(u.id) > COALESCE(MAX(p.last_utterance_id), 0)""",
                (s["run_id"],)).fetchall()
            for lab in labels:
                self.process_speaker(s, lab["speaker_label"])
        self.db.commit()

    def progress(self, run_id: str, label: str) -> sqlite3.Row:
        self.db.execute("INSERT OR IGNORE INTO picavoice_progress (run_id, speaker_label) VALUES (?, ?)",
                        (run_id, label))
        return self.db.execute("SELECT * FROM picavoice_progress WHERE run_id = ? AND speaker_label = ?",
                               (run_id, label)).fetchone()

    def clip_for(self, session: sqlite3.Row, utts: list[sqlite3.Row]) -> tuple[np.ndarray | None, float]:
        """Concatenate the longest utterances (up to MAX_SECONDS) into one clip."""
        sr = session["sample_rate"]
        pieces, total = [], 0.0
        for u in sorted(utts, key=lambda u: u["t_end"] - u["t_start"], reverse=True):
            if total >= MAX_SECONDS:
                break
            try:
                piece = self.read(session["wav_path"], sr, u["t_start"], u["t_end"])
            except Exception as e:  # file still being written, moved, unreadable
                self.out(f"  cannot read audio {session['wav_path']}: {e}")
                return None, 0.0
            if len(piece):
                pieces.append(piece)
                total += len(piece) / sr
        if not pieces:
            return None, 0.0
        return np.concatenate(pieces), total

    def process_speaker(self, session: sqlite3.Row, label: str) -> None:
        run_id = session["run_id"]
        prog = self.progress(run_id, label)
        utts = self.db.execute(
            "SELECT * FROM utterances WHERE run_id = ? AND speaker_label = ? ORDER BY id", (run_id, label)).fetchall()
        person_id = prog["person_id"]

        if prog["status"] == "forgotten":  # `forget` was used: never learn from this speaker again
            self.db.execute(
                "UPDATE picavoice_progress SET last_utterance_id = ? WHERE run_id = ? AND speaker_label = ?",
                (utts[-1]["id"], run_id, label))
            return
        if person_id is None:
            if utts[-1]["id"] <= prog["last_embedded_id"]:
                return  # already tried with exactly this audio; wait for more speech
            person_id = self.identify(session, label, utts, prog)
            if person_id is None:
                return  # not enough audio yet, or unsure; try again when more arrives
        else:
            self.refine(session, label, person_id, [u for u in utts if u["id"] > prog["last_embedded_id"]])

        new = [u for u in utts if u["id"] > prog["last_utterance_id"]]
        self.learn(session, label, person_id, new)
        self.record_encounter(session, label, person_id, utts)
        self.db.execute(
            "UPDATE picavoice_progress SET last_utterance_id = ? WHERE run_id = ? AND speaker_label = ?",
            (utts[-1]["id"], run_id, label))
        self.db.commit()

    def identify(self, session, label, utts, prog) -> int | None:
        run_id = session["run_id"]
        clip, seconds = self.clip_for(session, utts)
        if clip is None or seconds < MIN_SECONDS:
            return None
        voice = self.embed(clip, session["sample_rate"])
        people = self.db.execute("SELECT * FROM people WHERE embedding IS NOT NULL").fetchall()
        ranked = rank(voice, people)
        best_score, best = ranked[0] if ranked else (-1.0, None)
        close_second = len(ranked) > 1 and best_score - ranked[1][0] < MIN_LEAD
        last_id = utts[-1]["id"]

        if best is not None and best_score >= MIN_SIMILARITY and not close_second:
            person_id, method, score = best["id"], "picavoice-match", best_score
            if best_score >= UPDATE_SIMILARITY:
                self.add_voiceprint(person_id, voice, run_id, utts)
            self.out(f"[{run_id} {label}] recognised {best['display_name']} ({best_score:.2f})")
        elif best_score < NEW_VOICE_BELOW and seconds >= NEW_VOICE_SECONDS:
            person_id, method, score = self.create_person(voice, run_id, utts), "picavoice-new", best_score
            self.out(f"[{run_id} {label}] new voice -> person #{person_id} (closest known {best_score:.2f})")
        else:
            if prog["status"] != "ambiguous" or seconds >= MAX_SECONDS:
                why = "too close to two people" if close_second else f"best {best_score:.2f}"
                self.out(f"[{run_id} {label}] not sure yet ({why}, {seconds:.1f}s of speech); waiting for more")
            self.db.execute(
                """UPDATE picavoice_progress SET status = 'ambiguous', last_embedded_id = ?
                   WHERE run_id = ? AND speaker_label = ?""", (last_id, run_id, label))
            self.db.commit()
            return None

        self.db.execute(
            """INSERT INTO speaker_assignments (run_id, speaker_label, person_id, confidence, method, created_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(run_id, speaker_label) DO UPDATE SET person_id = excluded.person_id,
                 confidence = excluded.confidence, method = excluded.method, created_at = excluded.created_at""",
            (run_id, label, person_id, score, method, now_ms()))
        self.db.execute(
            """UPDATE picavoice_progress SET person_id = ?, status = 'assigned', last_embedded_id = ?
               WHERE run_id = ? AND speaker_label = ?""", (person_id, last_id, run_id, label))
        if method == "picavoice-match":
            self.remind(person_id, label)
        return person_id

    def refine(self, session, label, person_id, new_utts) -> None:
        """More speech from an already identified speaker: fold it into their profile."""
        if not new_utts:
            return
        clip, seconds = self.clip_for(session, new_utts)
        if clip is None or seconds < MIN_SECONDS:
            return  # keep last_embedded_id so these utterances are used once enough accumulates
        voice = self.embed(clip, session["sample_rate"])
        person = self.db.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
        score = float(np.dot(voice, from_blob(person["embedding"]))) if person["embedding"] else 1.0
        if score >= UPDATE_SIMILARITY:
            self.add_voiceprint(person_id, voice, session["run_id"], new_utts)
        elif score < MISMATCH_BELOW:
            self.out(f"[{session['run_id']} {label}] new audio does not sound like {person['display_name']} "
                     f"({score:.2f}); not adding it to their profile")
        self.db.execute(
            "UPDATE picavoice_progress SET last_embedded_id = ? WHERE run_id = ? AND speaker_label = ?",
            (new_utts[-1]["id"], session["run_id"], label))

    def create_person(self, voice, run_id, utts) -> int:
        cur = self.db.execute(
            """INSERT INTO people (display_name, created_at, notes, embedding, embedding_count, is_placeholder)
               VALUES ('Unknown voice', ?, NULL, ?, 0, 1)""", (now_ms(), to_blob(voice)))
        pid = cur.lastrowid
        self.db.execute("UPDATE people SET display_name = ? WHERE id = ?", (f"Unknown voice #{pid}", pid))
        self.add_voiceprint(pid, voice, run_id, utts)
        return pid

    def add_voiceprint(self, person_id, voice, run_id, utts) -> None:
        p = self.db.execute("SELECT embedding, embedding_count FROM people WHERE id = ?", (person_id,)).fetchone()
        count = p["embedding_count"]
        profile = blend(from_blob(p["embedding"]), count, voice) if p["embedding"] and count else unit(voice)
        self.db.execute("UPDATE people SET embedding = ?, embedding_count = ? WHERE id = ?",
                        (to_blob(profile), count + 1, person_id))
        self.db.execute(
            """INSERT INTO voiceprints (person_id, embedding, dims, model, source_run_id, source_t_start,
               source_t_end, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (person_id, to_blob(voice), int(voice.shape[0]), MODEL_NAME, run_id,
             min(u["t_start"] for u in utts), max(u["t_end"] for u in utts), now_ms()))

    # ---- what they said
    def learn(self, session, label, person_id, new_utts) -> None:
        if not new_utts or self.is_me(person_id):
            return
        run_id = session["run_id"]
        for u in new_utts:
            for kind, value, conf in facts_from_own_words(u["text"]):
                self.add_fact(person_id, kind, value, conf, "self", run_id, u["id"])
            for kind, value, conf in shared_facts(u["text"]):
                for other in self.people_in_run(run_id):
                    self.add_fact(other, kind, value, conf, "self" if other == person_id else "other", run_id, u["id"])
        # Names this person used for someone else: only usable when the conversation has exactly one other person.
        others = [p for p in self.people_in_run(run_id) if p != person_id]
        if len(others) == 1:
            for u in new_utts:
                for name in names_addressed(u["text"]):
                    self.add_fact(others[0], "name", name, 0.5, "other", run_id, u["id"])
        for pid in {person_id, *others}:
            self.maybe_name(pid)

    def people_in_run(self, run_id: str) -> list[int]:
        rows = self.db.execute(
            """SELECT DISTINCT a.person_id FROM speaker_assignments a JOIN people p ON p.id = a.person_id
               WHERE a.run_id = ? AND p.is_me = 0""", (run_id,)).fetchall()
        return [r[0] for r in rows]

    def is_me(self, person_id: int) -> bool:
        r = self.db.execute("SELECT is_me FROM people WHERE id = ?", (person_id,)).fetchone()
        return bool(r and r[0])

    def add_fact(self, person_id, kind, value, conf, source, run_id, utterance_id) -> None:
        t = now_ms()
        self.db.execute(
            """INSERT INTO person_facts (person_id, kind, value, confidence, source, run_id, utterance_id,
               first_heard_at, last_heard_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(person_id, kind, value) DO UPDATE SET times_heard = times_heard + 1,
                 confidence = MAX(confidence, excluded.confidence), last_heard_at = excluded.last_heard_at""",
            (person_id, kind, value, conf, source, run_id, utterance_id, t, t))
        self.out(f"  learned about #{person_id}: {kind} = {value}")

    def maybe_name(self, person_id: int) -> None:
        """Give a placeholder person a real name once we are fairly sure of it."""
        p = self.db.execute("SELECT display_name, is_placeholder FROM people WHERE id = ?", (person_id,)).fetchone()
        if not p or not p["is_placeholder"]:
            return
        best = self.db.execute(
            """SELECT value, confidence, times_heard FROM person_facts WHERE person_id = ? AND kind = 'name'
               ORDER BY (confidence * times_heard) DESC LIMIT 1""", (person_id,)).fetchone()
        if best and (best["confidence"] >= 0.9 or best["times_heard"] >= 2):
            self.db.execute("UPDATE people SET display_name = ?, is_placeholder = 0 WHERE id = ?",
                            (best["value"], person_id))
            self.out(f"  {p['display_name']} is {best['value']}")

    # ---- when / where
    def record_encounter(self, session, label, person_id, utts) -> None:
        if self.is_me(person_id) or not utts:
            return
        run_id = session["run_id"]
        t0, t1 = min(u["t_start"] for u in utts), max(u["t_end"] for u in utts)
        started = session["started_at"] + int(t0 * 1000)
        ended = session["started_at"] + int(t1 * 1000)
        speech = sum(u["t_end"] - u["t_start"] for u in utts)
        snippet = " ".join(u["text"] for u in utts)[:400]
        lat, lng = self.location_near(run_id, started)
        self.db.execute(
            """INSERT INTO encounters (person_id, run_id, speaker_label, started_at, ended_at, speech_seconds,
               lat, lng, snippet) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(person_id, run_id) DO UPDATE SET started_at = MIN(started_at, excluded.started_at),
                 ended_at = MAX(ended_at, excluded.ended_at), speech_seconds = excluded.speech_seconds,
                 lat = COALESCE(lat, excluded.lat), lng = COALESCE(lng, excluded.lng), snippet = excluded.snippet""",
            (person_id, run_id, label, started, ended, speech, lat, lng, snippet))
        self.db.execute(
            """UPDATE people SET
                 first_met_at = (SELECT MIN(started_at) FROM encounters WHERE person_id = people.id),
                 last_seen_at = (SELECT MAX(ended_at) FROM encounters WHERE person_id = people.id),
                 times_met = (SELECT COUNT(*) FROM encounters WHERE person_id = people.id)
               WHERE id = ?""", (person_id,))

    def location_near(self, run_id: str, at_ms: int) -> tuple[float | None, float | None]:
        """Closest GPS fix the phone sent during this session (needs the location uplink event)."""
        row = self.db.execute(
            "SELECT payload FROM events WHERE run_id = ? AND type = 'location' ORDER BY ABS(t - ?) LIMIT 1",
            (run_id, at_ms)).fetchone()
        if not row:
            return None, None
        try:
            p = json.loads(row[0])
            return float(p["lat"]), float(p["lng"])
        except (ValueError, KeyError, TypeError):
            return None, None

    # ---- the point of it all
    def remind(self, person_id: int, label: str) -> None:
        for line in profile_card(self.db, person_id, brief=True):
            self.out(f"  >> {line}")


# --------------------------------------------------------------------------- views

def profile_card(db: sqlite3.Connection, person_id: int, brief: bool = False) -> list[str]:
    p = db.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
    if not p:
        return [f"no person #{person_id}"]
    lines = [f"#{p['id']} {p['display_name']}" + (" (you)" if p["is_me"] else "")]
    if p["times_met"]:
        lines.append(f"met {p['times_met']} time(s); first {fmt_day(p['first_met_at'])}, last {fmt_day(p['last_seen_at'])}")
    if p["notes"]:
        lines.append(f"note: {p['notes']}")
    facts = db.execute(
        """SELECT kind, value, times_heard, source FROM person_facts WHERE person_id = ?
           ORDER BY kind, confidence * times_heard DESC""", (person_id,)).fetchall()
    shown = set()
    for f in facts:
        if brief and f["kind"] in shown:
            continue
        shown.add(f["kind"])
        heard = f" (x{f['times_heard']})" if f["times_heard"] > 1 else ""
        lines.append(f"{f['kind']}: {f['value']}{heard}")
    encs = db.execute("SELECT * FROM encounters WHERE person_id = ? ORDER BY started_at DESC", (person_id,)).fetchall()
    for e in encs[:1] if brief else encs:
        where = f" at {e['lat']:.5f},{e['lng']:.5f}" if e["lat"] is not None else ""
        lines.append(f"{'last talk' if brief else 'talk'} {fmt_day(e['started_at'])}{where} "
                     f"({e['speech_seconds']:.0f}s): \"{(e['snippet'] or '')[:160]}\"")
    if not brief:
        lines.append(f"voice samples: {p['embedding_count']}; consent recorded: {p['consent_recorded_at'] or 'no'}")
    return lines


def cmd_people(db, _args) -> None:
    rows = db.execute("SELECT * FROM people ORDER BY COALESCE(last_seen_at, created_at) DESC").fetchall()
    if not rows:
        print("Nobody yet.")
    for p in rows:
        facts = db.execute(
            """SELECT kind, value FROM person_facts WHERE person_id = ? AND kind != 'name'
               ORDER BY confidence * times_heard DESC LIMIT 3""", (p["id"],)).fetchall()
        extra = "; ".join(f"{f['kind']}: {f['value']}" for f in facts)
        me = " (you)" if p["is_me"] else ""
        print(f"#{p['id']:<4} {p['display_name']}{me:<6} met {p['times_met']}x, last {fmt_day(p['last_seen_at'])}"
              f"{'  | ' + extra if extra else ''}")


def cmd_show(db, args) -> None:
    print("\n".join(profile_card(db, args.person)))


def cmd_rename(db, args) -> None:
    db.execute("UPDATE people SET display_name = ?, is_placeholder = 0 WHERE id = ?", (args.name, args.person))
    db.commit()
    print(f"#{args.person} is now {args.name}")


def cmd_me(db, args) -> None:
    db.execute("UPDATE people SET is_me = (id = ?)", (args.person,))
    db.execute("DELETE FROM encounters WHERE person_id = ?", (args.person,))
    db.execute("DELETE FROM person_facts WHERE person_id = ?", (args.person,))
    db.execute("UPDATE people SET times_met = 0, first_met_at = NULL, last_seen_at = NULL WHERE id = ?", (args.person,))
    db.commit()
    print(f"#{args.person} is marked as you; your own voice is no longer logged as an encounter.")


def cmd_merge(db, args) -> None:
    src, dst = args.source, args.into
    a = db.execute("SELECT * FROM people WHERE id = ?", (src,)).fetchone()
    b = db.execute("SELECT * FROM people WHERE id = ?", (dst,)).fetchone()
    if not a or not b:
        raise SystemExit("unknown person id")
    if a["embedding"] and b["embedding"]:
        na, nb = max(a["embedding_count"], 1), max(b["embedding_count"], 1)
        merged = unit(from_blob(a["embedding"]) * na + from_blob(b["embedding"]) * nb)
        db.execute("UPDATE people SET embedding = ?, embedding_count = ? WHERE id = ?",
                   (to_blob(merged), na + nb, dst))
    db.execute("UPDATE voiceprints SET person_id = ? WHERE person_id = ?", (dst, src))
    db.execute("UPDATE speaker_assignments SET person_id = ? WHERE person_id = ?", (dst, src))
    db.execute("UPDATE picavoice_progress SET person_id = ? WHERE person_id = ?", (dst, src))
    db.execute("UPDATE OR IGNORE encounters SET person_id = ? WHERE person_id = ?", (dst, src))
    for f in db.execute("SELECT * FROM person_facts WHERE person_id = ?", (src,)).fetchall():
        db.execute(
            """INSERT INTO person_facts (person_id, kind, value, confidence, source, run_id, utterance_id, times_heard,
               first_heard_at, last_heard_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(person_id, kind, value) DO UPDATE SET times_heard = times_heard + excluded.times_heard""",
            (dst, f["kind"], f["value"], f["confidence"], f["source"], f["run_id"], f["utterance_id"],
             f["times_heard"], f["first_heard_at"], f["last_heard_at"]))
    if b["is_placeholder"] and not a["is_placeholder"]:
        db.execute("UPDATE people SET display_name = ?, is_placeholder = 0 WHERE id = ?", (a["display_name"], dst))
    db.execute("DELETE FROM people WHERE id = ?", (src,))
    db.execute(
        """UPDATE people SET first_met_at = (SELECT MIN(started_at) FROM encounters WHERE person_id = people.id),
             last_seen_at = (SELECT MAX(ended_at) FROM encounters WHERE person_id = people.id),
             times_met = (SELECT COUNT(*) FROM encounters WHERE person_id = people.id) WHERE id = ?""", (dst,))
    db.commit()
    print(f"merged #{src} into #{dst}")


def cmd_forget(db, args) -> None:
    pid = args.person
    db.execute("DELETE FROM voiceprints WHERE person_id = ?", (pid,))
    db.execute("DELETE FROM speaker_assignments WHERE person_id = ?", (pid,))
    db.execute("UPDATE picavoice_progress SET person_id = NULL, status = 'forgotten' WHERE person_id = ?", (pid,))
    db.execute("DELETE FROM encounters WHERE person_id = ?", (pid,))
    db.execute("DELETE FROM person_facts WHERE person_id = ?", (pid,))
    db.execute("DELETE FROM people WHERE id = ?", (pid,))
    db.commit()
    print(f"forgot #{pid} (voiceprints, facts and encounters deleted). Their WAV recordings are untouched.")


def run_engine(db, args) -> None:
    engine = Picavoice(db, out=lambda s: print(s, flush=True))
    if args.command == "once":
        engine.process()
        return
    print(f"picavoice watching {args.db} every {POLL_SECONDS:.0f}s (Ctrl+C to stop)", flush=True)
    try:
        while True:
            try:
                engine.process()
            except sqlite3.OperationalError as e:  # database briefly locked by the ingest server
                print(f"database busy ({e}); retrying", flush=True)
            time.sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        pass


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Automatically remember the people you talk to.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("watch", help="keep processing new conversations (default)")
    sub.add_parser("once", help="process the database once and exit")
    sub.add_parser("people", help="list everyone picavoice knows").set_defaults(run=cmd_people)
    p = sub.add_parser("show", help="one person's profile")
    p.add_argument("person", type=int)
    p.set_defaults(run=cmd_show)
    p = sub.add_parser("rename", help="set a person's name")
    p.add_argument("person", type=int)
    p.add_argument("name")
    p.set_defaults(run=cmd_rename)
    p = sub.add_parser("me", help="mark a person as the wearer")
    p.add_argument("person", type=int)
    p.set_defaults(run=cmd_me)
    p = sub.add_parser("merge", help="merge a duplicate person into another")
    p.add_argument("source", type=int)
    p.add_argument("into", type=int)
    p.set_defaults(run=cmd_merge)
    p = sub.add_parser("forget", help="delete a person and everything learned about them")
    p.add_argument("person", type=int)
    p.set_defaults(run=cmd_forget)
    args = parser.parse_args(argv)
    args.command = args.command or "watch"

    db = connect(args.db)
    getattr(args, "run", run_engine)(db, args)


if __name__ == "__main__":
    sys.exit(main())
