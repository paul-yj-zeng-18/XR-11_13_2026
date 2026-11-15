/**
 * Picavoice phone app, served by the ingest server on the same port.
 *
 *   GET    /app                  the app (server/app/index.html), open it on the phone
 *   GET    /app/<file>           its static files (server/app/)
 *   GET    /garden               Voice Garden example (examples/voice-garden/)
 *   GET    /palace/              Mind Palace XR example, built (examples/mind-palace-xr/dist, bun run build:palace)
 *   GET    /api/people           everyone in the Mind Palace
 *   GET    /api/people/:id       one person, with quotes and conversations
 *   POST   /api/people           {name, role?, metAt?, notes?, voiceConsent, runId?, speakerLabel?}
 *   DELETE /api/people/:id       delete a person and their voice data
 *   POST   /api/assign           {runId, speakerLabel, personId}
 *   GET    /api/live             the newest session and who is speaking in it
 *   GET    /api/garden.json      everyone as a Memory Garden import file (server/garden.ts)
 */
import {join, normalize} from "node:path"
import {toGardenExport} from "./garden"
import {People, READY_SECONDS} from "./people"

const APP_DIR = join(import.meta.dir, "app")
const PALACE_DIR = join(import.meta.dir, "..", "examples", "mind-palace-xr", "dist")
const GARDEN_PAGE = join(import.meta.dir, "..", "examples", "voice-garden", "index.html")

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json", "cache-control": "no-store"}})

const TYPES: Record<string, string> = {html: "text/html; charset=utf-8", jpg: "image/jpeg", png: "image/png", svg: "image/svg+xml", css: "text/css", js: "text/javascript"}

export async function appRoute(req: Request, url: URL, people: People): Promise<Response | null> {
  const path = url.pathname.replace(/\/+$/, "") || "/"

  if (req.method === "GET" && (path === "/palace" || path.startsWith("/palace/"))) {
    // Keep the trailing slash so the build's relative asset paths resolve.
    if (url.pathname === "/palace") return Response.redirect(url.origin + "/palace/", 302)
    const rel = url.pathname === "/palace/" ? "index.html" : decodeURIComponent(url.pathname.slice("/palace/".length))
    const file = normalize(join(PALACE_DIR, rel))
    if (!file.startsWith(PALACE_DIR + "/")) return new Response("not found", {status: 404})
    const f = Bun.file(file)
    if (!(await f.exists())) {
      if (rel === "index.html") return new Response("Mind Palace XR isn't built yet. Run: bun run build:palace\n", {status: 503})
      return new Response("not found", {status: 404})
    }
    const ext = rel.split(".").pop() ?? ""
    return new Response(f, {headers: {"content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store"}})
  }
  if (req.method === "GET" && path === "/garden") {
    return new Response(Bun.file(GARDEN_PAGE), {headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"}})
  }
  if (req.method === "GET" && (path === "/app" || path.startsWith("/app/"))) {
    const rel = path === "/app" ? "index.html" : path.slice("/app/".length)
    const file = normalize(join(APP_DIR, rel))
    if (!file.startsWith(APP_DIR + "/")) return new Response("not found", {status: 404})
    const f = Bun.file(file)
    if (!(await f.exists())) return new Response("not found", {status: 404})
    const ext = rel.split(".").pop() ?? ""
    return new Response(f, {headers: {"content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store"}})
  }

  if (!path.startsWith("/api/people") && path !== "/api/assign" && path !== "/api/live" && path !== "/api/garden.json") return null

  try {
    if (req.method === "GET" && path === "/api/people") return json({people: people.list(), readySeconds: READY_SECONDS})
    if (req.method === "GET" && path === "/api/live") return json({live: people.live()})
    if (req.method === "GET" && path === "/api/garden.json") {
      const all = people.list().map((p) => people.get(p.id)).filter((p) => p !== null)
      const day = new Date().toISOString().slice(0, 10)
      return new Response(JSON.stringify(toGardenExport(all), null, 2), {
        headers: {"content-type": "application/json", "cache-control": "no-store", "content-disposition": `attachment; filename="picavoice-garden-${day}.json"`},
      })
    }

    const m = path.match(/^\/api\/people\/(\d+)$/)
    if (m && req.method === "GET") {
      const p = people.get(Number(m[1]))
      return p ? json({person: p, readySeconds: READY_SECONDS}) : json({error: "not found"}, 404)
    }
    if (m && req.method === "DELETE") return people.delete(Number(m[1])) ? json({ok: true}) : json({error: "not found"}, 404)

    if (req.method === "POST" && (path === "/api/people" || path === "/api/assign")) {
      let body: Record<string, unknown>
      try {
        body = (await req.json()) as Record<string, unknown>
      } catch {
        return json({error: "body must be JSON"}, 400)
      }
      const str = (k: string): string | undefined => (typeof body[k] === "string" ? (body[k] as string) : undefined)
      if (path === "/api/people") {
        const name = str("name")
        if (!name?.trim()) return json({error: "name is required"}, 400)
        const id = people.create({
          name,
          role: str("role"),
          metAt: str("metAt"),
          notes: str("notes"),
          voiceConsent: body.voiceConsent === true,
          runId: str("runId"),
          speakerLabel: str("speakerLabel"),
        })
        return json({id}, 201)
      }
      const runId = str("runId"), speakerLabel = str("speakerLabel"), personId = Number(body.personId)
      if (!runId || !speakerLabel || !Number.isInteger(personId)) return json({error: "runId, speakerLabel and personId are required"}, 400)
      people.assignSpeaker(runId, speakerLabel, personId)
      return json({ok: true})
    }
    return json({error: "not found"}, 404)
  } catch (err) {
    return json({error: (err as Error).message}, 400)
  }
}
