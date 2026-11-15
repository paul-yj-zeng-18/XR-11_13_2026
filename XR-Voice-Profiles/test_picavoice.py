"""Tests for picavoice without torch or real audio: a fake reader returns samples that
encode which voice is speaking, and a fake embedder maps that to a fixed vector."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import numpy as np

import picavoice as pv

SR = 16000
rng = np.random.default_rng(0)
VOICES = {v: pv.unit(rng.normal(size=192).astype(np.float32)) for v in (1, 2, 3, 4)}


def fake_embed(samples, sr):
    voice = int(round(float(samples.mean())))
    noise = np.random.default_rng(len(samples)).normal(scale=0.05, size=192).astype(np.float32)
    return pv.unit(VOICES[voice] + noise)


class World:
    """An in-memory FieldAssist database plus a script of who spoke when."""

    def __init__(self, profiles_file=None):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            CREATE TABLE sessions (run_id TEXT PRIMARY KEY, phone_run_id TEXT, started_at INTEGER NOT NULL,
              user_id TEXT, package_name TEXT, wav_path TEXT, sample_rate INTEGER, provider TEXT,
              ended_at INTEGER, end_reason TEXT);
            CREATE TABLE utterances (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, t_start REAL NOT NULL,
              t_end REAL NOT NULL, speaker_label TEXT NOT NULL, text TEXT NOT NULL, confidence REAL,
              speech_final INTEGER NOT NULL DEFAULT 0, provider TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, t INTEGER NOT NULL,
              type TEXT NOT NULL, payload TEXT NOT NULL);
        """)
        pv.ensure_schema(self.db)
        self.voice_at = {}  # (wav, t_start) -> voice id
        self.log = []
        self.t = {}
        self.engine = pv.Picavoice(self.db, embed=fake_embed, read=self.read,
                                   profiles_file=profiles_file or Path("/nonexistent/profiles.json"),
                                   out=self.log.append)

    def read(self, wav, sr, t0, t1):
        return np.full((int((t1 - t0) * sr), 1), float(self.voice_at[(wav, t0)]), dtype=np.float32)

    def session(self, run_id, started_at=1_700_000_000_000):
        self.db.execute("INSERT INTO sessions (run_id, started_at, wav_path, sample_rate) VALUES (?, ?, ?, ?)",
                        (run_id, started_at, f"{run_id}.wav", SR))
        self.t[run_id] = 0.0

    def say(self, run_id, label, voice, text, seconds=4.0):
        t0 = self.t[run_id]
        self.t[run_id] = t0 + seconds
        self.voice_at[(f"{run_id}.wav", t0)] = voice
        self.db.execute(
            """INSERT INTO utterances (run_id, t_start, t_end, speaker_label, text, confidence, provider, created_at)
               VALUES (?, ?, ?, ?, ?, 0.9, 'deepgram', 0)""", (run_id, t0, t0 + seconds, label, text))

    def person_for(self, run_id, label):
        r = self.db.execute("SELECT person_id FROM speaker_assignments WHERE run_id = ? AND speaker_label = ?",
                            (run_id, label)).fetchone()
        return r[0] if r else None

    def person(self, pid):
        return self.db.execute("SELECT * FROM people WHERE id = ?", (pid,)).fetchone()

    def facts(self, pid):
        return {(r["kind"], r["value"]) for r in
                self.db.execute("SELECT kind, value FROM person_facts WHERE person_id = ?", (pid,))}


class FactExtraction(unittest.TestCase):
    def test_self_introductions(self):
        self.assertIn(("name", "Sam Lee", 0.9), pv.facts_from_own_words("Hi, my name is Sam Lee."))
        self.assertIn(("name", "Priya", 0.9), pv.facts_from_own_words("I'm Priya, by the way."))
        self.assertEqual([], [f for f in pv.facts_from_own_words("I'm Sorry, I'm Good.") if f[0] == "name"])

    def test_context(self):
        facts = {(k, v) for k, v, _ in pv.facts_from_own_words(
            "I work at Caterpillar, and I'm studying mechanical engineering. I'm from Chicago. "
            "I'm here for the career fair.")}
        self.assertTrue({("work", "Caterpillar"), ("study", "mechanical engineering"), ("from", "Chicago"),
                         ("why", "the career fair")} <= facts)
        self.assertIn(("role", "software engineer", 0.8), pv.facts_from_own_words("I'm a software engineer at Google."))

    def test_addressed_and_shared(self):
        self.assertEqual(["Sam"], pv.names_addressed("Nice to meet you, Sam."))
        self.assertEqual([("how_met", "the hackathon", 0.7)], pv.shared_facts("We met at the hackathon, right?"))


class Engine(unittest.TestCase):
    def test_new_voice_then_recognised_in_later_session(self):
        w = World()
        w.session("r1")
        w.say("r1", "S0", 1, "Hey, my name is Sam Lee.")
        w.say("r1", "S0", 1, "I work at Caterpillar.")
        w.db.execute("INSERT INTO events (run_id, t, type, payload) VALUES ('r1', ?, 'location', ?)",
                     (1_700_000_000_500, json.dumps({"lat": 40.1106, "lng": -88.2272})))
        w.engine.process()
        sam = w.person_for("r1", "S0")
        self.assertIsNotNone(sam)
        p = w.person(sam)
        self.assertEqual("Sam Lee", p["display_name"])
        self.assertEqual(0, p["is_placeholder"])
        self.assertEqual(1, p["times_met"])
        self.assertIn(("work", "Caterpillar"), w.facts(sam))
        enc = w.db.execute("SELECT * FROM encounters WHERE person_id = ?", (sam,)).fetchone()
        self.assertAlmostEqual(40.1106, enc["lat"])
        self.assertEqual(1, w.db.execute("SELECT COUNT(*) FROM voiceprints WHERE person_id = ?", (sam,)).fetchone()[0])

        w.session("r2", started_at=1_700_100_000_000)
        w.say("r2", "S1", 1, "Good to see you again.", seconds=5)
        w.engine.process()
        self.assertEqual(sam, w.person_for("r2", "S1"))
        self.assertEqual(2, w.person(sam)["times_met"])
        self.assertEqual(2, w.person(sam)["embedding_count"])  # profile refined with the new audio
        self.assertTrue(any(">> #" in line and "Sam Lee" in line for line in w.log))  # reminder printed

    def test_waits_for_enough_speech_before_creating_a_person(self):
        w = World()
        w.session("r1")
        w.say("r1", "S0", 2, "Hello there.", seconds=3)
        w.engine.process()
        self.assertIsNone(w.person_for("r1", "S0"))
        w.say("r1", "S0", 2, "Sorry I'm late.", seconds=4)
        w.engine.process()
        self.assertIsNotNone(w.person_for("r1", "S0"))
        self.assertTrue(w.person(w.person_for("r1", "S0"))["display_name"].startswith("Unknown voice #"))

    def test_two_speakers_and_name_from_the_other_person(self):
        w = World()
        w.session("r1")
        w.say("r1", "S0", 3, "I'm here to recruit for the robotics team, honestly.", seconds=7)
        w.say("r1", "S1", 4, "Nice to meet you, Jordan.", seconds=7)
        w.engine.process()
        a, b = w.person_for("r1", "S0"), w.person_for("r1", "S1")
        self.assertNotEqual(a, b)
        self.assertIn(("name", "Jordan"), w.facts(a))
        self.assertIn(("why", "recruit for the robotics team"), w.facts(a))
        self.assertEqual(1, w.person(a)["is_placeholder"])  # one "other" mention is not enough to rename
        w.say("r1", "S1", 4, "Thanks, Jordan.", seconds=3)
        w.engine.process()
        self.assertEqual("Jordan", w.person(a)["display_name"])

    def test_me_is_not_logged_as_an_encounter(self):
        w = World()
        w.session("r1")
        w.say("r1", "S0", 1, "Testing my glasses.", seconds=7)
        w.engine.process()
        me = w.person_for("r1", "S0")
        pv.cmd_me(w.db, type("A", (), {"person": me}))
        w.session("r2", started_at=1_700_100_000_000)
        w.say("r2", "S0", 1, "My name is Ibrahim.", seconds=7)
        w.engine.process()
        self.assertEqual(me, w.person_for("r2", "S0"))
        self.assertEqual(0, w.person(me)["times_met"])
        self.assertEqual(set(), w.facts(me))

    def test_forget_and_merge(self):
        w = World()
        w.session("r1")
        w.say("r1", "S0", 1, "My name is Sam.", seconds=7)
        w.session("r2")
        w.say("r2", "S0", 2, "I'm from Peoria.", seconds=7)
        w.engine.process()
        sam, other = w.person_for("r1", "S0"), w.person_for("r2", "S0")
        pv.cmd_merge(w.db, type("A", (), {"source": other, "into": sam}))
        self.assertIsNone(w.person(other))
        self.assertIn(("from", "Peoria"), w.facts(sam))
        self.assertEqual(2, w.person(sam)["times_met"])
        pv.cmd_forget(w.db, type("A", (), {"person": sam}))
        self.assertIsNone(w.person(sam))
        w.say("r1", "S0", 1, "Still talking.", seconds=3)
        w.engine.process()
        self.assertEqual(0, w.db.execute("SELECT COUNT(*) FROM people").fetchone()[0])  # stays forgotten

    def test_imports_enrolled_profiles(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "profiles.json"
            f.write_text(json.dumps([{"id": "u1", "name": "Ava", "note": "lab partner",
                                      "consent_recorded_at": "2026-11-15T00:00:00+00:00",
                                      "embedding": VOICES[3].tolist()}]))
            w = World(profiles_file=f)
            w.session("r1")
            w.say("r1", "S0", 3, "Did you finish the lab?", seconds=5)
            w.engine.process()
            ava = w.person_for("r1", "S0")
            self.assertEqual("Ava", w.person(ava)["display_name"])
            w.engine.process()  # importing twice does not duplicate
            self.assertEqual(1, w.db.execute("SELECT COUNT(*) FROM people").fetchone()[0])


if __name__ == "__main__":
    unittest.main()
