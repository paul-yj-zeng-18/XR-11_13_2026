/**
 * FieldAssist background layer: live transcripts to the laptop terminal
 * (milestone 1) plus raw microphone audio streamed to a server on the Mac
 * (milestone 2), with a diagnostics snapshot pushed to the phone tile.
 *
 * This file runs on the PHONE, inside the Mentra App's per-miniapp JS context
 * (JavaScriptCore on iOS, QuickJS on Android). Every `console.log` here is
 * forwarded by `mentra-miniapp dev` to the terminal that runs `bun dev`,
 * prefixed with a timestamp and `[MentraJS]` (when the app's console bridge
 * connects; on iOS it has not, so the ingest server is the reliable channel).
 *
 * Transport to the Mac is plain HTTP POST: WebSockets from this phone to the
 * Mac fail (also from Safari), while fetch works. Audio frames are batched
 * (10 frames or 250 ms) and posted as JSON; the Mac decodes and writes files.
 * Raw audio never goes through console.log (it would flood the dev bridge).
 *
 * API names come from @mentra/miniapp 3.4.0 (dist/*.d.ts) and
 * https://docs.mentraglass.com/app-devs/core-concepts/{session,location,
 * microphone/speech-to-text,microphone/audio-chunks}. No secrets are needed.
 */

import {registerMiniapp} from "@mentra/miniapp/background"
import type {AudioChunkData, LocationData, TranscriptionData, VadData} from "@mentra/miniapp/background"
import type {Channels, Diag} from "../shared/channels"

// Replaced with string literals by build.ts (Bun.build `define`). Bare constants
// are used instead of process.env.X so the bundle never contains `process`,
// which the phone's JS engine does not have.
declare const __INGEST_URL__: string
declare const __BUILD_ID__: string
declare const __CONTINUOUS_AUDIO__: boolean
// Accepts http://host:port[/anything] or the older ws://host:port/ingest form.
const INGEST_BASE: string = __INGEST_URL__.replace(/^ws(s?):\/\//, "http$1://").replace(/\/ingest\/?$/, "").replace(/\/$/, "")
const BUILD_ID: string = __BUILD_ID__

// The SDK does not expose the host's session id, so tag this background spawn
// ourselves. A new id means the context was (re)started: install, dev reload,
// or crash recovery.
const runId = crypto.randomUUID().slice(0, 8)
const startedAt = Date.now()

const ts = (): string => new Date().toISOString()
const log = (line: string): void => console.log(`[fieldassist ${runId}] ${ts()} ${line}`)
const errText = (e: unknown): string => {
  const m = (e as {message?: string} | null)?.message
  return m ? String(m) : String(e)
}

/** Audio frame as posted to server/ingest.ts (keep in sync with its AudioFrame). */
interface AudioFrame {
  seq: number
  data: string
  sampleRate?: number
  format?: string
  t: number
}
type UplinkEvent =
  | {type: "transcript"; text: string; isFinal: boolean; language?: string; source?: string; t: number}
  | {type: "vad"; speaking: boolean; silentForMs?: number; t: number}
  | {type: "location"; lat: number; lng: number; accuracy?: number | null; t: number}
  | {type: "ping"; t: number}
  | {type: "end"; reason: string}

const HEARTBEAT_MS = 5000

const AUDIO_BATCH_FRAMES = 10
const AUDIO_BATCH_MS = 250
const MAX_QUEUE = 30

/**
 * HTTP POST uplink to the Mac. One request in flight at a time; everything
 * else waits in a bounded queue (oldest dropped when full, since audio is live
 * and buffering it on the phone would only grow). Audio frames are batched.
 */
function createHttpUplink(base: string, id: string) {
  const queue: Array<{path: string; body: string}> = []
  let inFlight = false
  let posts = 0
  let sent = 0
  let failed = 0
  let dropped = 0
  let lastError = ""
  let lastOkAt = 0
  let batch: AudioFrame[] = []
  let batchTimer: ReturnType<typeof setTimeout> | null = null

  const pump = async (): Promise<void> => {
    if (inFlight) return
    const item = queue.shift()
    if (!item) return
    inFlight = true
    posts++
    try {
      const res = await fetch(`${base}${item.path}`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: item.body,
      })
      if (res.ok) {
        sent++
        lastError = ""
        lastOkAt = Date.now()
      } else {
        failed++
        lastError = `HTTP ${res.status}`
      }
    } catch (e) {
      failed++
      lastError = `fetch: ${errText(e)}`
    }
    inFlight = false
    if (queue.length) void pump()
  }
  const post = (path: string, obj: object): void => {
    if (queue.length >= MAX_QUEUE) {
      queue.shift()
      dropped++
    }
    queue.push({path, body: JSON.stringify(obj)})
    void pump()
  }
  const flushAudio = (): void => {
    if (batchTimer) {
      clearTimeout(batchTimer)
      batchTimer = null
    }
    if (!batch.length) return
    const chunks = batch
    batch = []
    post("/ingest/audio", {runId: id, chunks})
  }
  return {
    hello(userId: string, packageName: string): void {
      post("/ingest/hello", {runId: id, userId, packageName})
    },
    event(ev: UplinkEvent): void {
      post("/ingest/event", {runId: id, ...ev})
    },
    audio(frame: AudioFrame): void {
      batch.push(frame)
      if (batch.length >= AUDIO_BATCH_FRAMES) flushAudio()
      else if (!batchTimer) batchTimer = setTimeout(flushAudio, AUDIO_BATCH_MS)
    },
    end(reason: string): void {
      flushAudio()
      post("/ingest/event", {runId: id, type: "end", reason})
    },
    snapshot(): Pick<Diag, "uplinkState" | "uplinkPosts" | "uplinkSent" | "uplinkFailed" | "uplinkDropped" | "uplinkLastError"> {
      const fresh = lastOkAt > 0 && Date.now() - lastOkAt < 5000
      const state: Diag["uplinkState"] = fresh ? "connected" : sent > 0 ? "stalled" : "connecting"
      return {uplinkState: state, uplinkPosts: posts, uplinkSent: sent, uplinkFailed: failed, uplinkDropped: dropped, uplinkLastError: lastError}
    },
  }
}

registerMiniapp<Channels>((session) => {
  // packageName, userId and capabilities are empty until the connect handshake
  // ("ready" event), so the start line only carries our own run id.
  log(`SESSION STARTING run=${runId} build=${BUILD_ID}`)
  const uplink = INGEST_BASE ? createHttpUplink(INGEST_BASE, runId) : null
  if (!uplink) log("no ingest URL baked in (MENTRA_PUBLIC_INGEST_URL unset at build time): audio stays on the phone")

  // Diagnostics for the phone tile (the terminal may be unreachable).
  let cloudState = "unknown"
  let audioChunks = 0
  let audioFormat = "-"
  let audioSampleRate = "-"
  let transcripts = 0
  const diag = (): Diag => ({
    buildId: BUILD_ID,
    runId,
    userId: session.userId,
    cloud: cloudState,
    ingestUrl: INGEST_BASE || "(none baked in)",
    uplinkState: "disabled",
    uplinkPosts: 0,
    uplinkSent: 0,
    uplinkFailed: 0,
    uplinkDropped: 0,
    uplinkLastError: "",
    ...(uplink ? uplink.snapshot() : {}),
    audioChunks,
    audioFormat,
    audioSampleRate,
    transcripts,
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
  })
  const pushDiag = (): void => session.ui.send("diag", diag())
  // send() drops silently when no WebView is open, so this is cheap.
  const diagTimer = setInterval(pushDiag, 2000)
  // Heartbeat so the Mac can tell "quiet" from "gone" (it finalizes a run
  // after 30 s without any post). Tiny, and only while this context lives.
  const heartbeat = uplink ? setInterval(() => uplink.event({type: "ping", t: Date.now()}), HEARTBEAT_MS) : null

  // The SDK fires onOpen only once the session is ready (CONNECT_ACK received),
  // so userId is populated here.
  session.ui.onOpen(() => {
    session.ui.send("status", {state: "ready", detail: `user ${session.userId}`})
    pushDiag()
  })

  // CONNECT_ACK landed: identity, capabilities and declared permissions are set.
  session.on("ready", () => {
    const caps = session.capabilities
    const display = caps?.display ? `${caps.display.width ?? "?"}x${caps.display.height ?? "?"}` : "none"
    log(
      `SESSION READY package=${session.packageName} userId=${session.userId} display=${display} ` +
        `micDeclared=${session.transcription.hasPermission} locationDeclared=${session.location.hasPermission}`,
    )
    log(`capabilities=${JSON.stringify(caps ?? null).slice(0, 500)}`)
    uplink?.hello(session.userId, session.packageName)
    if (__CONTINUOUS_AUDIO__) {
      // Other people are far from the glasses mic; the on-glasses voice-activity
      // detection and the center-mic loudness gate ("Barrier") can drop their
      // quiet speech. Both calls are documented in mic.d.ts and honored subject
      // to the user's phone settings.
      session.mic
        .setVoiceActivityDetectionEnabled(false)
        .then(() => log("glasses VAD gating disabled"))
        .catch((e: unknown) => log(`could not disable VAD gating: ${errText(e)}`))
      session.mic
        .setLoudnessGateEnabled(false)
        .then(() => log("loudness gate disabled"))
        .catch((e: unknown) => log(`could not disable loudness gate: ${errText(e)}`))
    }
  })

  // Fires once right away with the current snapshot (expect "disconnected
  // audio=none" until the phone's cloud client reports in), then on every
  // change. Transcription defaults to "preferCloud", so no cloud usually
  // means no transcripts.
  session.cloud.onStatusChanged(({status, audioTransport}) => {
    cloudState = `${status} (audio ${audioTransport})`
    log(`cloud ${status} audio=${audioTransport}`)
  })

  session.glasses.onConnection(({connected, modelName}) =>
    log(`glasses ${connected ? "connected" : "disconnected"}${modelName ? ` model=${modelName}` : ""}`),
  )

  // Live speech-to-text. Interim results stream and get replaced; `isFinal`
  // marks the settled utterance. Needs MICROPHONE in miniapp.json.
  session.transcription.on((t: TranscriptionData) => {
    transcripts++
    const kind = t.isFinal ? "FINAL  " : "interim"
    const lang = t.language ? ` ${t.language}` : ""
    log(`${kind} [${t.source}${lang}] ${t.text}`)
    session.ui.send("transcript", {text: t.text, isFinal: t.isFinal, at: Date.now()})
    uplink?.event({type: "transcript", text: t.text, isFinal: t.isFinal, language: t.language, source: t.source, t: Date.now()})
  })

  if (uplink) {
    // Raw microphone frames: base64 PCM or LC3 depending on the phone's mic
    // mode; sampleRate/format are only present "when reported". Forwarded as
    // received; the Mac decodes and writes the file. Logged as counts only.
    let seq = 0
    let windowChunks = 0
    let windowBytes = 0
    let windowStart = Date.now()
    session.mic.onAudioChunk((c: AudioChunkData) => {
      seq++
      audioChunks = seq
      const approxBytes = Math.floor((c.data.length * 3) / 4)
      if (seq === 1) {
        audioFormat = c.format ?? "not reported"
        audioSampleRate = c.sampleRate != null ? String(c.sampleRate) : "not reported"
        log(`audio first chunk format=${audioFormat} sampleRate=${audioSampleRate} bytes~${approxBytes}`)
      }
      uplink.audio({seq, data: c.data, sampleRate: c.sampleRate, format: c.format, t: Date.now()})
      windowChunks++
      windowBytes += approxBytes
      const now = Date.now()
      if (now - windowStart >= 5000) {
        const secs = ((now - windowStart) / 1000).toFixed(0)
        const u = uplink.snapshot()
        log(
          `audio ${windowChunks} chunks ${(windowBytes / 1024).toFixed(0)} kB in ${secs}s; uplink ${u.uplinkState} ok=${u.uplinkSent} failed=${u.uplinkFailed}` +
            `${u.uplinkDropped ? ` dropped=${u.uplinkDropped}` : ""}${u.uplinkLastError ? ` last=${u.uplinkLastError}` : ""}`,
        )
        windowChunks = 0
        windowBytes = 0
        windowStart = now
      }
    })

    // On-device voice activity: one event when speech starts and one when it
    // stops. Cheap, and it shows whether audio should be flowing right now.
    session.mic.onVoiceActivity((v: VadData) => {
      log(v.status ? "speech started" : `speech stopped${v.silentForMs != null ? ` (quiet for ${v.silentForMs}ms)` : ""}`)
      uplink.event({type: "vad", speaking: v.status, silentForMs: v.silentForMs, t: Date.now()})
    })
  }

  // Continuous GPS from the phone. Needs LOCATION in miniapp.json.
  session.location.onUpdate((l: LocationData) => {
    const acc = l.accuracy != null ? ` ±${Math.round(l.accuracy)}m` : ""
    log(`location lat=${l.lat.toFixed(5)} lng=${l.lng.toFixed(5)}${acc}`)
    // Forwarded so picavoice can remember where a conversation happened.
    uplink?.event({type: "location", lat: l.lat, lng: l.lng, accuracy: l.accuracy ?? null, t: Date.now()})
  })

  session.on("visibility", (v) => log(`visibility ${v}`))
  session.on("error", (err) => console.error(`[fieldassist ${runId}] ${ts()} error ${err.message}`))

  // The phone announces a teardown (disable, uninstall, dev respawn) with a
  // WILL_DISCONNECT that the SDK surfaces as "beforeDisconnect" while the
  // transport is still open. "disconnect" only fires on a local disconnect()
  // or when the bridge vanishes mid-send, so log the end from beforeDisconnect
  // and keep "disconnect" as a fallback that never double-logs.
  let endedLogged = false
  const logEnded = (reason: string): void => {
    endedLogged = true
    clearInterval(diagTimer)
    if (heartbeat) clearInterval(heartbeat)
    const uptimeS = Math.round((Date.now() - startedAt) / 1000)
    log(`SESSION ENDED reason=${reason} uptime=${uptimeS}s`)
  }
  session.on("beforeDisconnect", (reason) => {
    logEnded(reason)
    uplink?.end(reason)
    session.ui.send("status", {state: "disconnected", detail: reason})
  })
  session.on("disconnect", (reason) => {
    if (!endedLogged) logEnded(reason)
    uplink?.end(reason)
  })
})
