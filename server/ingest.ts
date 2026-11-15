/**
 * FieldAssist ingest server (runs on the Mac).
 *
 * The miniapp's background layer on the phone sends JSON over plain HTTP POST
 * (the transport that works from the Mentra App's background runtime on iOS):
 *   POST /ingest/hello   {runId, userId, packageName}
 *   POST /ingest/event   {runId, type: "transcript", text, isFinal, language?, source?, t}
 *                        {runId, type: "vad", speaking, silentForMs?, t}
 *                        {runId, type: "location", lat, lng, accuracy?, t}
 *                        {runId, type: "ping", t}      (heartbeat every few seconds)
 *                        {runId, type: "end", reason}
 *   POST /ingest/audio   {runId, chunks: [{seq, data (base64), sampleRate?, format?, t}, ...]}
 * It also serves a read-only dashboard (server/dashboard.ts): GET /dashboard,
 * GET /api/sessions, GET /api/sessions/:runId/utterances?after=N, and the
 * Picavoice phone app (server/app-routes.ts) at GET /app with /api/people and /api/live.
 * A WebSocket on any path carrying the same objects as text frames is also
 * accepted, for clients where WebSockets work.
 *
 * Per run it: writes recordings/<utc-time>-<runId>.wav (16-bit PCM; raw .lc3 if
 * the phone's mic mode is LC3), streams the same PCM to Deepgram for live
 * transcription with speaker labels (server/deepgram.ts, enabled when
 * DEEPGRAM_API_KEY is set), prints every result, and stores sessions,
 * utterances and events in data/fieldassist.sqlite (server/store.ts) plus a
 * per-run recordings/<stem>.jsonl.
 *
 * Run lifecycle: a run is finalized on the phone's "end" event or after IDLE_MS
 * without any post (the phone sends a heartbeat while alive). Data that arrives
 * for a finalized run id, or an audio format/sample-rate change, continues
 * under a derived id (<runId>-2, -3, ...) with its own WAV, transcriber and
 * session row, so utterance times always index the WAV of their own session.
 *
 * Start with: bun run ingest   (or INGEST_PORT=3100 bun run server/ingest.ts)
 */
import {appendFileSync, closeSync, mkdirSync, openSync, writeSync} from "node:fs"
import {join} from "node:path"
import {appRoute} from "./app-routes"
import {dashboardRoute} from "./dashboard"
import {People} from "./people"
import {createDeepgramTranscriber, type Segment} from "./deepgram"
import {Store} from "./store"
import {WavFile} from "./wav"

const PORT = Number(process.env.INGEST_PORT ?? 3100)
const RECORDINGS_DIR = process.env.INGEST_DIR ?? join(import.meta.dir, "..", "recordings")
const DB_PATH = process.env.FIELDASSIST_DB ?? join(import.meta.dir, "..", "data", "fieldassist.sqlite")
const DEFAULT_SAMPLE_RATE = 16000
const STATS_INTERVAL_MS = 1000
const IDLE_MS = Number(process.env.INGEST_IDLE_MS ?? 30_000)
const INTERIM_PRINT_MS = 700

const DEEPGRAM_API_KEY = (process.env.DEEPGRAM_API_KEY ?? "").trim().replace(/^["']|["']$/g, "")
const requestedTranscribe = (process.env.TRANSCRIBE ?? "").trim().toLowerCase()
const TRANSCRIBE: "deepgram" | "off" = requestedTranscribe ? (requestedTranscribe === "deepgram" ? "deepgram" : "off") : DEEPGRAM_API_KEY ? "deepgram" : "off"
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL ?? "nova-3"
const DEEPGRAM_LANGUAGE = process.env.DEEPGRAM_LANGUAGE ?? "en"
const DEEPGRAM_URL = process.env.DEEPGRAM_URL
const DEEPGRAM_EXTRA_PARAMS = process.env.DEEPGRAM_EXTRA_PARAMS ?? ""

interface AudioFrame {
  seq: number
  data: string
  sampleRate?: number
  format?: string
  t: number
}
type Event =
  | {type: "transcript"; text: string; isFinal: boolean; language?: string; source?: string; t: number}
  | {type: "vad"; speaking: boolean; silentForMs?: number; t: number}
  | {type: "location"; lat: number; lng: number; accuracy?: number | null; t: number}
  | {type: "ping"; t: number}
  | {type: "end"; reason: string}

interface Run {
  runId: string // effective id: the phone's run id, or <phone id>-N after a rotation
  phoneRunId: string
  startedAt: number
  lastSeen: number
  wav: WavFile | null
  rawFd: number | null
  rawPath: string | null
  rawBytes: number
  sinkFailed: boolean
  format: string | null
  sampleRate: number | null
  chunks: number
  bytes: number
  lastSeq: number
  missing: number
  windowChunks: number
  windowBytes: number
  windowStart: number
  posts: number
  jsonlPath: string | null
  dg: ReturnType<typeof createDeepgramTranscriber> | null
  lastInterim: string
  lastInterimAt: number
  utterances: number
  finishing: Promise<void> | null
}

// Local time with milliseconds, so these lines align with the dev sidecar's
// [MentraJS] lines (also local time). Recording file names use UTC.
const stamp = (): string => {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}
const log = (line: string): void => console.log(`${stamp()} [ingest] ${line}`)

const store = new Store(DB_PATH)
const people = new People(store.db)
const runs = new Map<string, Run>() // effective id -> live run
const aliases = new Map<string, string>() // phone run id -> current effective id
const rotations = new Map<string, number>() // phone run id -> how many segments so far
const finished = new Set<string>() // effective ids that are done
const inFlightFinishes = new Set<Promise<void>>()

function newRun(runId: string, phoneRunId: string): Run {
  const run: Run = {
    runId,
    phoneRunId,
    startedAt: Date.now(),
    lastSeen: Date.now(),
    wav: null,
    rawFd: null,
    rawPath: null,
    rawBytes: 0,
    sinkFailed: false,
    format: null,
    sampleRate: null,
    chunks: 0,
    bytes: 0,
    lastSeq: 0,
    missing: 0,
    windowChunks: 0,
    windowBytes: 0,
    windowStart: Date.now(),
    posts: 0,
    jsonlPath: null,
    dg: null,
    lastInterim: "",
    lastInterimAt: 0,
    utterances: 0,
    finishing: null,
  }
  runs.set(runId, run)
  store.startSession({runId, phoneRunId, startedAt: run.startedAt, provider: TRANSCRIBE})
  log(`run ${runId} started`)
  return run
}

/** Next derived id for a phone run whose current segment is finished. */
function rotate(phoneRunId: string, why: string): string {
  const n = (rotations.get(phoneRunId) ?? 1) + 1
  rotations.set(phoneRunId, n)
  const eff = `${phoneRunId}-${n}`
  aliases.set(phoneRunId, eff)
  log(`run ${phoneRunId}: ${why}; continuing as ${eff}`)
  return eff
}

/** The live run for a phone run id, rotating when its current segment is finished. */
function runFor(phoneRunId: string): Run {
  let eff = aliases.get(phoneRunId) ?? phoneRunId
  if (finished.has(eff)) eff = rotate(phoneRunId, "data arrived after the run was finalized")
  const run = runs.get(eff) ?? newRun(eff, phoneRunId)
  run.lastSeen = Date.now()
  return run
}

function fileStem(run: Run): string {
  const t = new Date(run.startedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19)
  return join(RECORDINGS_DIR, `${t}-${run.runId}`)
}

function jsonl(run: Run, obj: Record<string, unknown>): void {
  try {
    if (!run.jsonlPath) {
      mkdirSync(RECORDINGS_DIR, {recursive: true})
      run.jsonlPath = `${fileStem(run)}.jsonl`
    }
    appendFileSync(run.jsonlPath, `${JSON.stringify({t: Date.now(), ...obj})}\n`)
  } catch (err) {
    log(`cannot append to ${run.jsonlPath ?? "jsonl"}: ${(err as Error).message}`)
  }
}

function startTranscriber(run: Run, sampleRate: number): void {
  if (TRANSCRIBE !== "deepgram" || run.dg) return
  const label = (s: Segment): string => (s.speaker == null ? "S?" : `S${s.speaker}`)
  run.dg = createDeepgramTranscriber({
    apiKey: DEEPGRAM_API_KEY,
    sampleRate,
    url: DEEPGRAM_URL,
    model: DEEPGRAM_MODEL,
    language: DEEPGRAM_LANGUAGE,
    extraParams: DEEPGRAM_EXTRA_PARAMS,
    onFinal: (seg, speechFinal) => {
      run.utterances++
      log(`[${label(seg)} ${seg.tStart.toFixed(1)}-${seg.tEnd.toFixed(1)}s] ${seg.text}${speechFinal ? "" : " …"}`)
      try {
        store.insertUtterance({
          runId: run.runId,
          tStart: seg.tStart,
          tEnd: seg.tEnd,
          speakerLabel: label(seg),
          text: seg.text,
          confidence: seg.confidence,
          speechFinal,
          provider: "deepgram",
        })
      } catch (err) {
        log(`cannot store utterance: ${(err as Error).message}`)
      }
      jsonl(run, {type: "utterance", provider: "deepgram", speaker: label(seg), tStart: seg.tStart, tEnd: seg.tEnd, text: seg.text, confidence: seg.confidence, speechFinal})
    },
    onInterim: (seg) => {
      const now = Date.now()
      if (seg.text === run.lastInterim || now - run.lastInterimAt < INTERIM_PRINT_MS) return
      run.lastInterim = seg.text
      run.lastInterimAt = now
      log(`~ [${label(seg)}] ${seg.text}`)
    },
    onEvent: (line) => log(line),
  })
}

function openSink(run: Run, frame: AudioFrame, firstBytes: number): void {
  run.format = frame.format ?? null
  run.sampleRate = frame.sampleRate ?? null
  const isLc3 = (frame.format ?? "").toLowerCase().includes("lc3")
  if (isLc3) {
    run.rawPath = `${fileStem(run)}.lc3`
    mkdirSync(RECORDINGS_DIR, {recursive: true})
    run.rawFd = openSync(run.rawPath, "w")
    log(`audio format=${frame.format} sampleRate=${frame.sampleRate ?? "unknown"} firstChunkBytes=${firstBytes}`)
    log(`LC3 frames are saved raw to ${run.rawPath}; they need an LC3 decoder (liblc3), and live transcription is off for this run`)
  } else {
    const sampleRate = frame.sampleRate ?? DEFAULT_SAMPLE_RATE
    run.wav = new WavFile(`${fileStem(run)}.wav`, {sampleRate, channels: 1, bitsPerSample: 16})
    store.setSessionAudio(run.runId, run.wav.path, sampleRate)
    log(
      `audio format=${frame.format ?? "unknown (assuming 16-bit mono PCM)"} ` +
        `sampleRate=${frame.sampleRate ?? `unknown (assuming ${DEFAULT_SAMPLE_RATE})`} firstChunkBytes=${firstBytes} -> ${run.wav.path}`,
    )
    startTranscriber(run, sampleRate)
  }
}

function closeSinks(run: Run): string {
  if (run.wav) {
    const summary = `${run.wav.path} (${run.wav.seconds.toFixed(1)}s, ${(run.wav.bytes / 1024).toFixed(0)} kB)`
    run.wav.close()
    run.wav = null
    return summary
  }
  if (run.rawFd !== null) {
    closeSync(run.rawFd)
    run.rawFd = null
    const summary = `${run.rawPath} (${(run.rawBytes / 1024).toFixed(0)} kB raw LC3)`
    run.rawBytes = 0
    return summary
  }
  return run.sinkFailed ? "recording failed (see error above)" : "no audio received"
}

/** True when this frame's (reported) format or sample rate differs from the run's. */
function formatChanged(run: Run, frame: AudioFrame): boolean {
  if (run.wav === null && run.rawFd === null) return false
  const sr = frame.sampleRate ?? run.sampleRate
  const fmt = frame.format ?? run.format
  return sr !== run.sampleRate || fmt !== run.format
}

/** Decode and write one frame; returns the PCM bytes for the transcriber (or null). */
function onFrame(run: Run, frame: AudioFrame): Uint8Array | null {
  const pcm = Buffer.from(frame.data, "base64")
  run.chunks++
  run.bytes += pcm.byteLength
  if (run.lastSeq > 0 && frame.seq > run.lastSeq + 1) run.missing += frame.seq - run.lastSeq - 1
  run.lastSeq = Math.max(run.lastSeq, frame.seq)
  if (run.sinkFailed) return null
  try {
    if (run.wav === null && run.rawFd === null) openSink(run, frame, pcm.byteLength)
    if (run.wav) run.wav.append(pcm)
    else if (run.rawFd !== null) {
      writeSync(run.rawFd, pcm)
      run.rawBytes += pcm.byteLength
    }
  } catch (err) {
    // Disk problem (permissions, full disk, bad INGEST_DIR). Log once, keep the
    // transcript check alive, stop trying to write audio for this run.
    run.sinkFailed = true
    log(`cannot write audio: ${(err as Error).message}. Audio from run ${run.runId} is discarded; fix INGEST_DIR/disk and restart`)
    try {
      closeSinks(run)
    } catch {
      /* ignore */
    }
    return null
  }
  run.windowChunks++
  run.windowBytes += pcm.byteLength
  return run.wav ? pcm : null
}

function maybeStats(run: Run): void {
  const now = Date.now()
  if (now - run.windowStart < STATS_INTERVAL_MS || run.windowChunks === 0) return
  const secs = (now - run.windowStart) / 1000
  const total = run.wav ? `${run.wav.seconds.toFixed(1)}s` : `${(run.rawBytes / 1024).toFixed(0)} kB`
  log(
    `audio ${(run.windowChunks / secs).toFixed(0)} chunks/s ${(run.windowBytes / secs / 1024).toFixed(1)} kB/s total=${total}` +
      `${run.missing ? ` missing=${run.missing}` : ""}${run.dg ? ` deepgram=${run.dg.state}` : ""}`,
  )
  run.windowChunks = 0
  run.windowBytes = 0
  run.windowStart = now
}

function onEvent(run: Run, ev: Event): void {
  switch (ev.type) {
    case "transcript": {
      const kind = ev.isFinal ? "FINAL  " : "interim"
      const src = `${ev.source ?? "?"}${ev.language ? ` ${ev.language}` : ""}`
      log(`mentra ${kind} [${src}] ${ev.text}`)
      if (ev.isFinal) {
        try {
          store.insertEvent(run.runId, "mentra_transcript", ev)
        } catch (err) {
          log(`cannot store event: ${(err as Error).message}`)
        }
        jsonl(run, {type: "mentra_transcript", text: ev.text, language: ev.language, source: ev.source, phoneT: ev.t})
      }
      return
    }
    case "vad":
      log(ev.speaking ? "speech started" : `speech stopped${ev.silentForMs != null ? ` (quiet for ${ev.silentForMs}ms)` : ""}`)
      try {
        store.insertEvent(run.runId, "vad", ev)
      } catch (err) {
        log(`cannot store event: ${(err as Error).message}`)
      }
      jsonl(run, {type: "vad", speaking: ev.speaking, silentForMs: ev.silentForMs, phoneT: ev.t})
      return
    case "location":
      try {
        store.insertEvent(run.runId, "location", ev)
      } catch (err) {
        log(`cannot store event: ${(err as Error).message}`)
      }
      jsonl(run, {type: "location", lat: ev.lat, lng: ev.lng, accuracy: ev.accuracy, phoneT: ev.t})
      return
    case "ping":
      return // lastSeen was refreshed by runFor()
    default:
      log(`run ${run.runId}: unknown event type ${(ev as {type?: string}).type}`)
  }
}

/** Finalize a run exactly once; safe to call concurrently. */
function finishRun(run: Run, why: string): Promise<void> {
  if (run.finishing) return run.finishing
  finished.add(run.runId)
  runs.delete(run.runId)
  const p = (async () => {
    try {
      if (run.dg) {
        await run.dg.close()
        run.dg = null
      }
      const summary = closeSinks(run)
      store.endSession(run.runId, why)
      log(
        `${why}; run ${run.runId}: ${run.chunks} chunks, ${(run.bytes / 1024).toFixed(0)} kB in ${run.posts} posts` +
          `${run.utterances ? `, ${run.utterances} utterances in ${DB_PATH}` : ""} -> ${summary}`,
      )
    } catch (err) {
      log(`finishing run ${run.runId} failed: ${(err as Error).message}`)
    }
  })()
  run.finishing = p
  inFlightFinishes.add(p)
  void p.finally(() => inFlightFinishes.delete(p))
  return p
}

setInterval(() => {
  const now = Date.now()
  for (const run of [...runs.values()]) {
    if (now - run.lastSeen > IDLE_MS) void finishRun(run, `no data for ${Math.round(IDLE_MS / 1000)}s`)
  }
}, 5000)

/** Handle one JSON object from either transport. Returns a short reply. */
async function handle(obj: unknown, via: string): Promise<string> {
  if (!obj || typeof obj !== "object") return "ignored: not an object"
  const o = obj as Record<string, unknown>
  const phoneRunId = typeof o.runId === "string" && o.runId ? o.runId : "unknown"
  if (typeof o.userId === "string" && typeof o.packageName === "string") {
    const run = runFor(phoneRunId)
    store.startSession({runId: run.runId, phoneRunId, startedAt: run.startedAt, userId: o.userId, packageName: o.packageName, provider: TRANSCRIBE})
    log(`hello run=${run.runId} userId=${o.userId} package=${o.packageName} via=${via}`)
    run.posts++
    return "ok"
  }
  if (Array.isArray(o.chunks)) {
    let run = runFor(phoneRunId)
    run.posts++
    const pcmParts: Uint8Array[] = []
    const flushToDeepgram = (): void => {
      if (run.dg && pcmParts.length) run.dg.send(pcmParts.length === 1 ? pcmParts[0] : Buffer.concat(pcmParts))
      pcmParts.length = 0
    }
    for (const f of o.chunks as AudioFrame[]) {
      if (!f || typeof f.data !== "string") continue
      if (formatChanged(run, f)) {
        // New sample rate or encoding: finish this segment and continue under a
        // new run id so the WAV header, the transcriber and the times stay true.
        flushToDeepgram()
        await finishRun(run, `audio format changed ${run.format}/${run.sampleRate} -> ${f.format ?? run.format}/${f.sampleRate ?? run.sampleRate}`)
        run = runFor(phoneRunId)
      }
      const pcm = onFrame(run, f)
      if (pcm) pcmParts.push(pcm)
    }
    flushToDeepgram()
    maybeStats(run)
    return `ok ${o.chunks.length}`
  }
  if (typeof o.type === "string") {
    if (o.type === "end") {
      const eff = aliases.get(phoneRunId) ?? phoneRunId
      const run = runs.get(eff)
      if (!run) return "ignored: run already finished"
      run.posts++
      await finishRun(run, `phone session ended: ${String(o.reason ?? "")}`)
      return "ok"
    }
    const run = runFor(phoneRunId)
    run.posts++
    onEvent(run, o as Event)
    return "ok"
  }
  return "ignored: unknown shape"
}

const server = Bun.serve<{id: number}>({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url)
    if (url.pathname === "/health") return Response.json({ok: true, service: "fieldassist-ingest", transcribe: TRANSCRIBE, runs: [...runs.keys()]})
    if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      const protocol = (req.headers.get("sec-websocket-protocol") ?? "").split(",")[0].trim()
      const headers: Record<string, string> = protocol ? {"Sec-WebSocket-Protocol": protocol} : {}
      if (srv.upgrade(req, {data: {id: Date.now()}, headers})) return undefined
      log(`WebSocket upgrade rejected for ${url.pathname}`)
      return new Response("WebSocket upgrade failed", {status: 400})
    }
    if (req.method === "POST" && url.pathname.startsWith("/ingest")) {
      let obj: unknown
      try {
        obj = await req.json()
      } catch {
        log(`POST ${url.pathname}: body is not JSON`)
        return new Response("not JSON", {status: 400})
      }
      try {
        return new Response(await handle(obj, "http"), {headers: {"content-type": "text/plain"}})
      } catch (err) {
        log(`POST ${url.pathname} failed: ${(err as Error).message}`)
        return new Response("error", {status: 500})
      }
    }
    const app = await appRoute(req, url, people)
    if (app) return app
    const page = await dashboardRoute(req, url, store)
    if (page) return page
    return new Response("fieldassist ingest: POST JSON to /ingest/{hello,event,audio}; app at /app, dashboard at /dashboard\n")
  },
  websocket: {
    open(ws) {
      log(`WebSocket client connected from ${ws.remoteAddress}`)
    },
    message(ws, raw) {
      let obj: unknown
      try {
        obj = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw))
      } catch {
        log(`WebSocket: ignoring non-JSON frame`)
        return
      }
      handle(obj, "ws").catch((err) => log(`WebSocket message failed: ${(err as Error).message}`))
    },
    close() {
      log(`WebSocket client disconnected`)
    },
    // Without this, an exception in a handler is uncaught and ends the process.
    error(err) {
      log(`WebSocket handler error: ${(err as Error).message}`)
    },
  },
})

// Create the folder up front so it is visible before the first chunk arrives.
mkdirSync(RECORDINGS_DIR, {recursive: true})
log(`listening on http://0.0.0.0:${server.port}/ingest  (recordings -> ${RECORDINGS_DIR}, db -> ${DB_PATH})`)
if (TRANSCRIBE === "deepgram") {
  if (!DEEPGRAM_API_KEY) log(`transcription: TRANSCRIBE=deepgram but DEEPGRAM_API_KEY is empty; connections will fail (set the key in .env and restart)`)
  else log(`transcription: Deepgram ${DEEPGRAM_MODEL} (${DEEPGRAM_LANGUAGE}, diarize_model=latest)${DEEPGRAM_URL ? ` at ${DEEPGRAM_URL}` : ""}`)
} else {
  log(`transcription: off (set DEEPGRAM_API_KEY in .env to enable Deepgram with speaker labels)`)
}
log(`Picavoice app: http://<this-mac-ip>:${server.port}/app · transcript: /dashboard (open on the phone)`)
log(`waiting for the phone; transcript lines and audio stats will appear here`)

let shuttingDown = false
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  await Promise.all([...runs.values()].map((run) => finishRun(run, "server stopping")))
  await Promise.all([...inFlightFinishes])
  store.close()
  process.exit(0)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
