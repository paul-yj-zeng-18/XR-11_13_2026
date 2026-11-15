import {describe, expect, test} from "bun:test"
import {appRoute} from "./app-routes"
import {People, READY_SECONDS} from "./people"
import {Store} from "./store"

function setup(): {store: Store; people: People} {
  const store = new Store(":memory:")
  const people = new People(store.db)
  store.startSession({runId: "r1", startedAt: 1000, provider: "deepgram"})
  const say = (runId: string, label: string, t: number, dur: number, text: string): void => {
    store.insertUtterance({runId, tStart: t, tEnd: t + dur, speakerLabel: label, text, confidence: 0.9, speechFinal: true, provider: "deepgram"})
  }
  say("r1", "S0", 0, 2, "Nice to meet you, what do you work on?")
  say("r1", "S1", 2, 20, "I design onboarding for a voice app, mostly tutorials.")
  say("r1", "S1", 22, 15, "Onboarding should start with a short voice tutorial.")
  store.startSession({runId: "r2", startedAt: 5000, provider: "deepgram"})
  say("r2", "S0", 0, 2, "Hey again!")
  say("r2", "S2", 2, 4, "Good to see you, I tried the tutorial idea.")
  return {store, people}
}

const call = async (people: People, method: string, path: string, body?: unknown): Promise<{status: number; json: any}> => {
  const req = new Request(`http://localhost${path}`, {method, body: body === undefined ? undefined : JSON.stringify(body)})
  const res = await appRoute(req, new URL(req.url), people)
  if (!res) return {status: 0, json: null}
  return {status: res.status, json: res.headers.get("content-type")?.includes("json") ? await res.json() : null}
}

describe("people", () => {
  test("adds the new columns to an existing people table", () => {
    const {store} = setup()
    const cols = (store.db.query(`PRAGMA table_info(people)`).all() as Array<{name: string}>).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(["role", "met_at", "voice_consent", "consent_at"]))
    new People(store.db) // running the migration twice is harmless
  })

  test("create with consent links the speaker and counts speech", () => {
    const {people} = setup()
    const id = people.create({name: " Maya Chen ", metAt: "Demo booth", voiceConsent: true, runId: "r1", speakerLabel: "S1"})
    const p = people.get(id)!
    expect(p.display_name).toBe("Maya Chen")
    expect(p.talks).toBe(1)
    expect(p.speech_seconds).toBe(35)
    expect(p.voice_status).toBe(35 >= READY_SECONDS ? "ready" : "collecting")
    expect(p.quotes[0].text).toBe("Onboarding should start with a short voice tutorial.")
    expect(p.conversations.map((c) => c.run_id)).toEqual(["r1"])
  })

  test("name-only people are never linked to a voice", () => {
    const {people} = setup()
    const id = people.create({name: "Priya", voiceConsent: false, runId: "r1", speakerLabel: "S1"})
    const p = people.get(id)!
    expect(p.talks).toBe(0)
    expect(p.voice_status).toBe("none")
    expect(() => people.assignSpeaker("r1", "S1", id)).toThrow()
  })

  test("a second conversation adds to the same person", () => {
    const {people} = setup()
    const id = people.create({name: "Maya", voiceConsent: true, runId: "r1", speakerLabel: "S1"})
    people.assignSpeaker("r2", "S2", id)
    const p = people.get(id)!
    expect(p.talks).toBe(2)
    expect(p.conversations.map((c) => c.run_id)).toEqual(["r2", "r1"])
  })

  test("live lists the newest session's speakers, with names where known", () => {
    const {people} = setup()
    const id = people.create({name: "Maya", voiceConsent: true})
    people.assignSpeaker("r2", "S2", id)
    const live = people.live()!
    expect(live.run_id).toBe("r2")
    expect(live.speakers.map((s) => [s.speaker_label, s.display_name])).toEqual([["S2", "Maya"], ["S0", null]])
  })

  test("delete removes the person, their links and their lines", () => {
    const {store, people} = setup()
    const id = people.create({name: "Maya", voiceConsent: true, runId: "r1", speakerLabel: "S1"})
    expect(people.delete(id)).toBe(true)
    expect(people.get(id)).toBeNull()
    expect(store.db.query(`SELECT COUNT(*) AS n FROM utterances WHERE run_id = 'r1' AND speaker_label = 'S1'`).get()).toEqual({n: 0})
    expect(store.db.query(`SELECT COUNT(*) AS n FROM utterances WHERE run_id = 'r1' AND speaker_label = 'S0'`).get()).toEqual({n: 1})
    expect(people.delete(id)).toBe(false)
  })
})

describe("app routes", () => {
  test("serves the app and its photo, and refuses paths outside it", async () => {
    const {people} = setup()
    for (const [path, type] of [["/app", "text/html"], ["/app/", "text/html"], ["/app/glasses.jpg", "image/jpeg"]]) {
      const req = new Request(`http://localhost${path}`)
      const res = (await appRoute(req, new URL(req.url), people))!
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain(type)
    }
    const bad = new Request("http://localhost/app/..%2fpeople.ts")
    expect((await appRoute(bad, new URL(bad.url), people))!.status).toBe(404)
  })

  test("create, list, get, assign and delete over HTTP", async () => {
    const {people} = setup()
    const created = await call(people, "POST", "/api/people", {name: "Maya", voiceConsent: true, runId: "r1", speakerLabel: "S1"})
    expect(created.status).toBe(201)
    const id = created.json.id
    expect((await call(people, "GET", "/api/people")).json.people.map((p: any) => p.display_name)).toEqual(["Maya"])
    expect((await call(people, "GET", `/api/people/${id}`)).json.person.talks).toBe(1)
    expect((await call(people, "POST", "/api/assign", {runId: "r2", speakerLabel: "S2", personId: id})).status).toBe(200)
    expect((await call(people, "GET", "/api/live")).json.live.speakers[0].display_name).toBe("Maya")
    expect((await call(people, "DELETE", `/api/people/${id}`)).status).toBe(200)
    expect((await call(people, "GET", `/api/people/${id}`)).status).toBe(404)
  })

  test("rejects bad input and ignores unrelated paths", async () => {
    const {people} = setup()
    expect((await call(people, "POST", "/api/people", {name: "  "})).status).toBe(400)
    expect((await call(people, "POST", "/api/assign", {runId: "r1"})).status).toBe(400)
    const nameOnly = (await call(people, "POST", "/api/people", {name: "Priya", voiceConsent: false})).json.id
    expect((await call(people, "POST", "/api/assign", {runId: "r1", speakerLabel: "S1", personId: nameOnly})).status).toBe(400)
    expect((await call(people, "GET", "/api/sessions")).status).toBe(0)
    expect((await call(people, "GET", "/dashboard")).status).toBe(0)
  })
})

describe("memory garden export", () => {
  test("exports everyone as importable trees, stable across calls", async () => {
    const {people} = setup()
    people.create({name: "Maya Chen", role: "Product designer", metAt: "Demo booth", voiceConsent: true, runId: "r1", speakerLabel: "S1"})
    people.create({name: "Priya", notes: "Met in the coffee line", voiceConsent: false})
    const get = async () => {
      const req = new Request("http://localhost/api/garden.json")
      const res = (await appRoute(req, new URL(req.url), people))!
      expect(res.headers.get("content-disposition")).toContain("picavoice-garden-")
      return (await res.json()) as {v: number; profiles: any[]}
    }
    const a = await get()
    expect(a.v).toBe(1)
    const maya = a.profiles.find((p) => p.name === "Maya Chen")
    expect(maya.id).toMatch(/^picavoice-\d+$/)
    expect(maya.genome).toHaveLength(10)
    expect(maya.u).toHaveLength(14)
    expect(maya.genome.every((g: number) => g >= 0 && g <= 1)).toBe(true)
    expect(maya.genomeEdited).toBe(true)
    expect(maya.facts).toEqual({role: ["Product designer"], other: ["met: Demo booth"]})
    expect(maya.quotes.map((q: any) => q.text)).toContain("Onboarding should start with a short voice tutorial.")
    expect(maya.talkSec).toBe(60)
    const priya = a.profiles.find((p) => p.name === "Priya")
    expect(priya.notes).toBe("Met in the coffee line")
    expect(priya.facts.other).toContain("name only, no voice saved")
    const b = await get()
    expect(b.profiles.map((p) => [p.id, p.seed, p.genome])).toEqual(a.profiles.map((p) => [p.id, p.seed, p.genome]))
    expect(maya.seed).not.toBe(priya.seed)
  })
})

describe("voice garden example", () => {
  test("is served at /garden with the Picavoice bridge", async () => {
    const {people} = setup()
    const req = new Request("http://localhost/garden")
    const res = (await appRoute(req, new URL(req.url), people))!
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("<title>Voice Garden")
    expect(html).toContain("/api/garden.json")
    expect(html).toContain("Ibrahim Kamran")
  })

  test("transcript lines carry the person id once a voice is linked", () => {
    const {store, people} = setup()
    const id = people.create({name: "Maya", voiceConsent: true, runId: "r1", speakerLabel: "S1"})
    const rows = store.utterancesSince("r1")
    expect(rows.filter((u) => u.speaker_label === "S1").every((u) => u.person_id === id)).toBe(true)
    expect(rows.find((u) => u.speaker_label === "S0")!.person_id).toBeNull()
  })
})

describe("mind palace xr example", () => {
  test("serves the built app under /palace/ and refuses paths outside it", async () => {
    const {people} = setup()
    const go = async (path: string) => {
      const req = new Request(`http://localhost${path}`)
      return (await appRoute(req, new URL(req.url), people))!
    }
    expect((await go("/palace")).status).toBe(302)
    const page = await go("/palace/")
    expect([200, 503]).toContain(page.status) // 503 until `bun run build:palace`
    if (page.status === 200) expect(await page.text()).toContain("Mind Palace")
    expect((await go("/palace/..%2f..%2fserver%2fpeople.ts")).status).toBe(404)
  })

  test("conversations carry that person's transcript", () => {
    const {people} = setup()
    const id = people.create({name: "Maya", voiceConsent: true, runId: "r1", speakerLabel: "S1"})
    expect(people.get(id)!.conversations[0].transcript).toBe(
      "I design onboarding for a voice app, mostly tutorials. Onboarding should start with a short voice tutorial.",
    )
  })
})
