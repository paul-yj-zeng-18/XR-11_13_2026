/**
 * People ("Mind Palace") on top of the SQLite store: who you met, whether they
 * agreed to a voice profile, and which speaker labels in which runs are them.
 *
 * Voice profiles here are speaker-label assignments plus the amount of their
 * speech collected so far. Matching a voice across sessions (the voiceprints
 * table) is a later step; until then a person is linked to a run's speaker
 * label by hand from the app ("Save" on an unknown voice) or by assignSpeaker.
 */
import type {Database} from "bun:sqlite"

/** Seconds of clear speech after which a voice profile counts as ready. */
export const READY_SECONDS = 30

export interface PersonSummary {
  id: number
  display_name: string
  role: string | null
  met_at: string | null
  notes: string | null
  voice_consent: number
  consent_at: number | null
  created_at: number
  talks: number
  speech_seconds: number
  last_quote: string | null
  voice_status: "ready" | "collecting" | "none"
}

export interface PersonDetail extends PersonSummary {
  quotes: Array<{text: string; run_id: string; t_start: number}>
  conversations: Array<{run_id: string; started_at: number; lines: number; transcript: string | null}>
}

export interface LiveSpeaker {
  speaker_label: string
  person_id: number | null
  display_name: string | null
  role: string | null
  met_at: string | null
  last_text: string
  speech_seconds: number
  last_t: number
}

export interface NewPerson {
  name: string
  role?: string
  metAt?: string
  notes?: string
  voiceConsent: boolean
  runId?: string
  speakerLabel?: string
}

const voiceStatus = (consent: number, seconds: number): PersonSummary["voice_status"] =>
  !consent ? "none" : seconds >= READY_SECONDS ? "ready" : "collecting"

export class People {
  constructor(private readonly db: Database) {
    const cols = new Set((db.query(`PRAGMA table_info(people)`).all() as Array<{name: string}>).map((c) => c.name))
    const add = (name: string, type: string): void => {
      if (!cols.has(name)) db.run(`ALTER TABLE people ADD COLUMN ${name} ${type}`)
    }
    add("role", "TEXT")
    add("met_at", "TEXT")
    add("voice_consent", "INTEGER NOT NULL DEFAULT 0")
    add("consent_at", "INTEGER")
  }

  private summarySql(where: string): string {
    return `SELECT p.id, p.display_name, p.role, p.met_at, p.notes, p.voice_consent, p.consent_at, p.created_at,
        (SELECT COUNT(DISTINCT a.run_id) FROM speaker_assignments a WHERE a.person_id = p.id) AS talks,
        COALESCE((SELECT SUM(u.t_end - u.t_start) FROM utterances u JOIN speaker_assignments a
                  ON a.run_id = u.run_id AND a.speaker_label = u.speaker_label WHERE a.person_id = p.id), 0) AS speech_seconds,
        (SELECT u.text FROM utterances u JOIN speaker_assignments a
                  ON a.run_id = u.run_id AND a.speaker_label = u.speaker_label
                  WHERE a.person_id = p.id AND length(u.text) > 20 ORDER BY u.id DESC LIMIT 1) AS last_quote
      FROM people p ${where}`
  }

  private withStatus<T extends {voice_consent: number; speech_seconds: number}>(row: T): T & {voice_status: PersonSummary["voice_status"]} {
    return {...row, speech_seconds: Math.round(row.speech_seconds * 10) / 10, voice_status: voiceStatus(row.voice_consent, row.speech_seconds)}
  }

  list(): PersonSummary[] {
    const rows = this.db.query(this.summarySql("ORDER BY p.created_at DESC")).all() as Omit<PersonSummary, "voice_status">[]
    return rows.map((r) => this.withStatus(r))
  }

  get(id: number): PersonDetail | null {
    const row = this.db.query(this.summarySql("WHERE p.id = ?")).get(id) as Omit<PersonSummary, "voice_status"> | null
    if (!row) return null
    const quotes = this.db
      .query(
        `SELECT u.text, u.run_id, u.t_start FROM utterances u JOIN speaker_assignments a
           ON a.run_id = u.run_id AND a.speaker_label = u.speaker_label
         WHERE a.person_id = ? AND length(u.text) > 20 ORDER BY u.id DESC LIMIT 5`,
      )
      .all(id) as PersonDetail["quotes"]
    const conversations = this.db
      .query(
        `SELECT s.run_id, s.started_at,
           (SELECT COUNT(*) FROM utterances u WHERE u.run_id = s.run_id AND u.speaker_label = a.speaker_label) AS lines,
           (SELECT group_concat(text, ' ') FROM (SELECT u.text FROM utterances u
              WHERE u.run_id = s.run_id AND u.speaker_label = a.speaker_label ORDER BY u.id)) AS transcript
         FROM speaker_assignments a JOIN sessions s ON s.run_id = a.run_id
         WHERE a.person_id = ? ORDER BY s.started_at DESC`,
      )
      .all(id) as PersonDetail["conversations"]
    return {...this.withStatus(row), quotes, conversations}
  }

  create(p: NewPerson, now = Date.now()): number {
    const name = p.name.trim()
    if (!name) throw new Error("name is required")
    const res = this.db.run(
      `INSERT INTO people (display_name, role, met_at, notes, voice_consent, consent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, p.role?.trim() || null, p.metAt?.trim() || null, p.notes?.trim() || null, p.voiceConsent ? 1 : 0, p.voiceConsent ? now : null, now],
    )
    const id = Number(res.lastInsertRowid)
    if (p.voiceConsent && p.runId && p.speakerLabel) this.assignSpeaker(p.runId, p.speakerLabel, id, "app", now)
    return id
  }

  /** Link a run's speaker label to a person. Refused for people who did not agree to a voice profile. */
  assignSpeaker(runId: string, speakerLabel: string, personId: number, method = "app", now = Date.now()): void {
    const p = this.db.query(`SELECT voice_consent FROM people WHERE id = ?`).get(personId) as {voice_consent: number} | null
    if (!p) throw new Error("no such person")
    if (!p.voice_consent) throw new Error("this person did not agree to a voice profile")
    this.db.run(
      `INSERT INTO speaker_assignments (run_id, speaker_label, person_id, confidence, method, created_at) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(run_id, speaker_label) DO UPDATE SET person_id = excluded.person_id, method = excluded.method, created_at = excluded.created_at`,
      [runId, speakerLabel, personId, method, now],
    )
  }

  /** Delete a person, their voice links and voiceprints, and the transcript lines that were theirs. */
  delete(id: number): boolean {
    const exists = this.db.query(`SELECT 1 FROM people WHERE id = ?`).get(id)
    if (!exists) return false
    this.db.transaction(() => {
      this.db.run(
        `DELETE FROM utterances WHERE EXISTS (SELECT 1 FROM speaker_assignments a
           WHERE a.person_id = ? AND a.run_id = utterances.run_id AND a.speaker_label = utterances.speaker_label)`,
        [id],
      )
      this.db.run(`DELETE FROM speaker_assignments WHERE person_id = ?`, [id])
      this.db.run(`DELETE FROM voiceprints WHERE person_id = ?`, [id])
      this.db.run(`DELETE FROM people WHERE id = ?`, [id])
    })()
    return true
  }

  /** The newest session and who is speaking in it, most recent speaker first. */
  live(): {run_id: string; started_at: number; ended_at: number | null; speakers: LiveSpeaker[]} | null {
    const s = this.db.query(`SELECT run_id, started_at, ended_at FROM sessions ORDER BY started_at DESC LIMIT 1`).get() as
      | {run_id: string; started_at: number; ended_at: number | null}
      | null
    if (!s) return null
    const speakers = this.db
      .query(
        `SELECT u.speaker_label, a.person_id, p.display_name, p.role, p.met_at,
           (SELECT u2.text FROM utterances u2 WHERE u2.run_id = u.run_id AND u2.speaker_label = u.speaker_label ORDER BY u2.id DESC LIMIT 1) AS last_text,
           SUM(u.t_end - u.t_start) AS speech_seconds, MAX(u.t_end) AS last_t
         FROM utterances u
         LEFT JOIN speaker_assignments a ON a.run_id = u.run_id AND a.speaker_label = u.speaker_label
         LEFT JOIN people p ON p.id = a.person_id
         WHERE u.run_id = ? AND u.speaker_label <> 'S?'
         GROUP BY u.speaker_label ORDER BY last_t DESC`,
      )
      .all(s.run_id) as LiveSpeaker[]
    return {...s, speakers}
  }
}
