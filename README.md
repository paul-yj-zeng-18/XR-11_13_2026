# Picavoice: remember everyone you meet, from your smart glasses

At a crowded event you meet dozens of people and forget most of them by the next
morning. **Picavoice** listens through Mentra Live glasses, works out who is
speaking, and, with each person's spoken OK, keeps a **Mind Palace**: who they
are, where you met, and what they said. When they speak again, your phone shows
who it is and what they told you last time. **Voice Garden**, the example
project, turns the same people into trees that grow as they talk and stand beside
their heads in a webcam AR mirror.

```
Mentra Live glasses ─► phone miniapp ─► Mac server (bun run ingest)
  mics, speaker          raw PCM over      ├─ Deepgram nova-3: transcript + speaker labels (S0, S1, …)
                         HTTP              ├─ SQLite: sessions, utterances, people, consent
                                           ├─ /app     Picavoice: Live · Mind Palace · profiles · consent
                                           ├─ /garden  Voice Garden: a tree per person, grows as they talk
                                           └─ /dashboard  raw live transcript
XR-Voice-Profiles/ (Python): names speakers across conversations from saved voiceprints
```

| Piece | Where | State |
| --- | --- | --- |
| Glasses → phone → Mac audio, speaker-labelled transcript | `src/`, `server/ingest.ts`, `server/deepgram.ts` | Working |
| Picavoice app: Live, Mind Palace, profiles, consent, delete | `server/app/`, `server/people.ts` | Working |
| Voice Garden example (based on Voiceprint Garden AR by Ibrahim Kamran) | `examples/voice-garden/` | Working |
| Recognise a returning voice automatically | `XR-Voice-Profiles/` | Prototype |
| Spoken replies through the glasses' speaker | `session.speaker.speak` | Next |

**Demo without glasses:** `bun install`, `bun run ingest`, then `bun run seed --names` or
`bun run replay <recording.m4a>`. Open `http://<mac-ip>:3100/app` on a phone and
`http://localhost:3100/garden` on the Mac.

**Consent and privacy:** nothing is linked to a person until they say yes; "Name
only" people are never matched by voice; deleting someone removes their profile,
voice links, transcript lines and Voice Garden tree. Everything stays on the Mac.

---

## Capture pipeline (FieldAssist)

A MentraOS **miniapp** for Mentra Live glasses. The glasses talk to the phone over Bluetooth, the
Mentra App runs this miniapp's background code on the phone, and two things come back to your Mac:

- **Console lines** via the CLI's dev server (`mentra-miniapp dev`, run by `bun dev`): session events,
  transcripts, location. This is the "is the connection good" signal.
- **Raw microphone audio + transcripts** via HTTP POST from the phone to `server/ingest.ts` on the Mac,
  which prints what it receives and writes the audio to `recordings/`.
- **Live transcription with speaker labels** on the Mac: the same PCM is streamed to Deepgram (`nova-3`,
  diarization on) and every utterance is printed as `[S0 12.3-14.1s] text`, stored in
  `data/fieldassist.sqlite` and appended to `recordings/<run>.jsonl`. (WebSockets from this iPhone to the
  Mac fail, even from Safari; plain HTTP from the miniapp's background works, see Troubleshooting.)

```
Mentra Live ──BT──► Mentra App (phone) ──runs──► src/background/index.ts
                                         │              │
                   same Wi-Fi ◄──────────┘              └─ HTTP POST http://<mac>:3100/ingest/{hello,event,audio}
                   `bun dev` prints the phone's console       `bun run ingest` prints transcripts,
                   (QR, reload, [MentraJS] lines)             audio stats, writes recordings/*.wav
```

## Why this is not a cloud SDK + ngrok app

The cloud SDK (`@mentra/sdk`, `AppServer`, webhooks, dev console) is retired:

- npm marks `@mentra/sdk` **deprecated**: "retired cloud SDK ... not compatible with the current Mentra App".
- `@mentraos/sdk` is not on npm (404).
- Mentra's roadmap post (mentraglass.com/blogs/blog/mentra-roadmap-update-moving-to-miniapps-on-the-phone):
  MentraOS 3.0 shipped **2026-08-03** and removed cloud apps from the Mentra App; the "MentraOS Legacy"
  build that kept them alive ended support in **October 2026**.
- The current docs (https://docs.mentraglass.com) cover only the **Miniapp SDK** (`@mentra/miniapp`) and the
  **Bluetooth SDK**. The old cloud docs are at https://mentraglass.com/legacy.

There is no API key and no public URL. ngrok is installed but not needed: the phone and the Mac only have
to share a Wi-Fi network. The only configuration is the ingest server address, which `run.sh` derives from
the Mac's LAN IP (override in `.env`, see `.env.example`).

## Run it

```bash
./run.sh            # starts the ingest server, then the dev server (one terminal)
./run.sh --usb      # Android only: reach the phone over USB (adb reverse) instead of Wi-Fi
```

Or in two terminals: `bun run ingest`, and `MENTRA_PUBLIC_INGEST_URL=http://<lan-ip>:3100 bun dev`.

- **Package name:** edit `packageName` in `miniapp.json` (default `com.fieldassist.app`). The CLI and
  `run.sh` read it from there, and the phone keys dev installs by it.
- **Ingest URL is baked in at build time.** `build.ts` turns `MENTRA_PUBLIC_INGEST_URL` into a constant in
  the background bundle. `run.sh` sets it to `http://<your LAN IP>:3100` on every start, so after
  changing Wi-Fi networks, restart `run.sh` (it rebuilds and the phone reloads). Audio frames are batched
  (10 frames or 250 ms) into one POST each; transcripts and speech events are posted as they happen.
- `bun dev` validates `miniapp.json`, builds both layers, serves `http://<lan-ip>:3000/` (a `miniapp.json`
  that names `bundle.zip` and its SHA-256) plus a WebSocket "sidecar" on port 3001 for live reload **and the
  phone's console output back to this terminal**. It prints a QR code, the same URL as `Miniapp URL:`, and a
  `PNG QR:` path. If 3000/3001 are busy it picks the next free pair and prints
  `Port 3000 was unavailable; using 3002 instead.`

On the phone, in the Mentra App: **Settings → Miniapp Developer Settings → Scan Miniapp QR Code**.
If you do not see that menu, update the Mentra App. Scan once; every saved change rebuilds and reloads on
the phone. The miniapp's background starts right after the scan. The UI tile is optional: it only shows
status and the latest transcript.

## What you should see

Dev server and phone console (`[MentraJS]`):

```
Starting dev server for FieldAssist (com.fieldassist.app) on port 3000...
[__mentra_dev] sidecar listening on :3001
01:40:03.510 [ingest] listening on http://0.0.0.0:3100/ingest  (recordings -> /Users/you/.../fieldassist/recordings)
╔═ To test your miniapp on glasses: ... ═╗
<QR code>
Miniapp URL: http://192.168.1.23:3000/
PNG QR: /var/folders/.../T/mentra-dev-qr-com.fieldassist.app-3000.png

01:40:12 [MentraJS] log [fieldassist 3f9a1c2e] 2026-11-14T09:40:12.101Z SESSION STARTING run=3f9a1c2e
01:40:12 [MentraJS] log [fieldassist 3f9a1c2e] ... cloud disconnected audio=none
01:40:12 [MentraJS] log [fieldassist 3f9a1c2e] ... SESSION READY package=com.fieldassist.app userId=... display=none micDeclared=true locationDeclared=true
01:40:12 [MentraJS] log [fieldassist 3f9a1c2e] ... capabilities={...}
01:40:13 [MentraJS] log [fieldassist 3f9a1c2e] ... cloud connected audio=udp
01:40:13 [MentraJS] log [fieldassist 3f9a1c2e] ... glasses connected model=Mentra Live
01:40:14 [MentraJS] log [fieldassist 3f9a1c2e] ... audio first chunk format=... sampleRate=... bytes~640
01:40:19 [MentraJS] log [fieldassist 3f9a1c2e] ... audio 248 chunks 155 kB in 5s; uplink connected ok=20 failed=0
01:40:20 [MentraJS] log [fieldassist 3f9a1c2e] ... interim [cloud en-US] testing one two
01:40:21 [MentraJS] log [fieldassist 3f9a1c2e] ... FINAL   [cloud en-US] Testing, one, two, three.
```

Ingest server (`[ingest]`, what actually arrived over the uplink):

```
01:40:12.523 [ingest] run 3f9a1c2e started
01:40:12.529 [ingest] hello run=3f9a1c2e userId=... package=com.fieldassist.app via=http
01:40:14.534 [ingest] audio format=... sampleRate=... firstChunkBytes=640 -> /Users/you/.../fieldassist/recordings/2026-11-14T09-40-12-3f9a1c2e.wav
01:40:15.521 [ingest] audio 50 chunks/s 31.2 kB/s total=1.0s
01:40:19.900 [ingest] speech started
01:40:20.517 [ingest] interim [cloud en-US] testing one two
01:40:21.088 [ingest] FINAL   [cloud en-US] Testing, one, two, three.
01:40:22.300 [ingest] speech stopped (quiet for 400ms)
...
01:45:02.635 [ingest] phone session ended: ...; run 3f9a1c2e: 14890 chunks, 9306 kB in 1489 posts -> /Users/you/.../recordings/2026-11-14T09-40-12-3f9a1c2e.wav (298.0s, 9306 kB)
```

Notes on that output:

- The first `cloud disconnected audio=none` line is the SDK's default snapshot, delivered before the
  connect handshake. It is expected; `cloud connected` should follow within a few seconds.
- The leading HH:MM:SS is the phone's log timestamp, rendered in this Mac's local timezone by the dev
  sidecar (which also adds `[MentraJS] log`); the ISO timestamp inside the line is the same phone clock,
  written by the miniapp's logger. `[ingest]` lines carry this Mac's own clock, also local time; recording
  file names use UTC. `[fieldassist <id>]` identifies one background run; a new id means the context
  restarted (dev reload, crash recovery, or re-install).
- The order of the `cloud` and `glasses` lines varies. A run is finalized on the phone's `end` event or after
  30 s without any post (`no data for 30s`), whichever comes first; a new run id makes a new file.
- The audio format is only known at runtime. The SDK says frames are "PCM or LC3 depending on the phone's
  mic mode", with `sampleRate` and `format` present only "when reported". The ingest server writes 16-bit
  mono PCM to `.wav` (sample rate from the phone, or 16000 if it does not say) and LC3 frames raw to `.lc3`.
  Check the `audio format=` line.
- Audio is never written to the console; the phone logs counts every 5 s, the Mac logs rates every 1 s.
- `SESSION ENDED reason=... uptime=...s` is logged from the SDK's `beforeDisconnect` hook when the phone
  announces a teardown (disable, uninstall, dev respawn), while `bun dev` is still running. The docs do not
  say whether the host sends that notice before a dev `respawn-bg`, so a missing `SESSION ENDED` followed by
  a fresh `SESSION STARTING` with a new run id is not itself a failure.

## Transcription with speaker labels (Deepgram)

1. Create an API key at https://console.deepgram.com and put it in `fieldassist/.env`:

```
DEEPGRAM_API_KEY=your_key_here
```

2. `./run.sh` prints `speech : Deepgram nova-3 with speaker labels` and the ingest server logs
   `transcription: Deepgram nova-3 (en, diarize_model=latest)`. Without a key it says `transcription: off` and only records.

What happens per run: the first PCM audio frame opens one Deepgram stream (`wss://api.deepgram.com/v1/listen`,
`linear16` at the phone's sample rate, `diarize_model=latest`, `interim_results=true`, `smart_format=true`,
`utterance_end_ms=1000`), every POSTed batch is forwarded as binary frames, a `KeepAlive` goes out when idle,
and the run's `end` (or the idle timeout) sends `CloseStream`. LC3 runs are recorded raw only (the server logs
`live transcription is off for this run`). Segment times are seconds into that session's audio, so they index
straight into the WAV named in its `sessions.wav_path` (`sample = t * sampleRate`), which is what the later
speaker recognition milestone needs. If the socket drops, it reconnects with backoff and keeps the time base;
while Deepgram is unreachable at most 60 s of audio is queued, older audio is skipped (the WAV still has it).

Output:

```
[ingest] deepgram connected (nova-3, 16000 Hz, diarize_model=latest)
[ingest] ~ [S0] so this is a test of          <- interim, printed at most every 0.7 s
[ingest] [S0 3.1-5.0s] So this is a test of the glasses.
[ingest] [S1 5.4-6.2s] Sounds good. …          <- "…" = no end-of-speech pause yet
[ingest] utterance end at 6.9s
[ingest] mentra FINAL   [cloud en-US] So this is a test of the glasses.   <- Mentra's own transcript, for comparison
```

Labels (`S0`, `S1`, ...) are per run and anonymous: Deepgram's streaming diarization identifies voices
within a session, not people across sessions. `S?` means Deepgram returned words without a speaker.

Runs and segments: the phone sends a heartbeat every 5 s, and the server finalizes a run after 30 s without
any post (or on the phone's `end`). If data for the same phone run arrives later, or the audio format or sample
rate changes mid-run, the server continues under a derived id (`<runId>-2`, `-3`, ...) with its own WAV,
Deepgram stream, label space (times restart at 0) and `sessions` row, so every utterance row points at the WAV
it was measured against via `sessions.wav_path` (`sessions.phone_run_id` ties the segments together).

Storage (`server/store.ts`, `bun:sqlite`): `sessions` (run id, phone run id, start/end, WAV path, sample rate),
`utterances` (run id, `t_start`, `t_end`, `speaker_label`, `text`, `confidence`, `speech_final`,
`provider`), `events` (Mentra final transcripts, speech start/stop). Empty tables for the next milestone:
`people`, `voiceprints`, `speaker_assignments`. Query it with any SQLite client, e.g.
`sqlite3 data/fieldassist.sqlite "select speaker_label, text from utterances order by id"`.

Options in `.env` (read at start; restart `./run.sh` after changing them): `DEEPGRAM_MODEL` (default `nova-3`),
`DEEPGRAM_LANGUAGE` (default `en`; `multi` for code-switching), `DEEPGRAM_EXTRA_PARAMS` (extra query
parameters that override the defaults, e.g. `keyterm=Mentra`; `diarize_model=latest` is already sent),
`TRANSCRIBE=off` to record only (any value other than `deepgram` means off), `FIELDASSIST_DB` to move the
database. Mentra's own transcript lines (`mentra FINAL ...`) stay on as a comparison; remove the
`session.transcription.on` block in `src/background/index.ts` to drop them.

Far-field speech: the glasses can gate quiet audio from other people (on-glasses voice-activity detection
and the center-mic loudness gate). If other speakers are faint or missing in the recordings, build with
`MENTRA_PUBLIC_CONTINUOUS_AUDIO=1 ./run.sh`, which makes the miniapp call
`session.mic.setVoiceActivityDetectionEnabled(false)` and `setLoudnessGateEnabled(false)` after the session is
ready. Per the SDK types, disabling VAD keeps audio frames flowing and the loudness-gate override lasts until the
miniapp disconnects; whether the phone honoured each call shows in the log as `glasses VAD gating disabled` /
`loudness gate disabled` or `could not disable ...`.

## Picavoice phone app (Mind Palace) and live transcript

The ingest server also serves two pages for your phone. Open them in Safari on a
phone on the same Wi-Fi as the Mac:

- `http://<mac-ip>:3100/app`: **Picavoice**. Welcome and setup screens, the
  Mind Palace (everyone you met), a profile for each person, a form to save a
  new voice with their spoken consent, and a Live screen that shows who is
  speaking in the newest conversation, what they said, and what they said last
  time.
- `http://<mac-ip>:3100/dashboard`: the raw live transcript, coloured by speaker.

Both poll over plain HTTP every 2 s (WebSockets from the iPhone fail, see
Troubleshooting). Find the Mac's IP with `ipconfig getifaddr en0`.

Try them without the glasses:

```bash
bun run ingest                 # terminal 1
bun run seed --names           # terminal 2: a finished conversation, S1 saved as "Maya Chen"
bun run seed --live            # or: a new line every 2 s, to watch Live update
bun run replay ~/Downloads/conversation.m4a   # or: play a real recording in, like the phone does
```

`bun run replay <file> [more files] [--fast] [--url http://<mac-ip>:3100]` sends
any audio file ffmpeg can read (voice memos, WAV, MP3) through the full
pipeline: WAV recording, Deepgram speaker labels (when `DEEPGRAM_API_KEY` is
set), SQLite, `/dashboard` and `/app`. Each file becomes its own conversation.
Leave `--fast` off when Deepgram is on, so it streams at real-time speed.

How voices become people: on the Live screen an unknown voice shows as
"New voice · Speaker N". **Save** opens the form; if they say yes to a voice
profile, that speaker label is linked to them (`people` + `speaker_assignments`).
In a later conversation, pick them from "That's someone I've met…" to add to
their history. People who choose **Name only** are never linked to a voice.
Deleting a person removes their profile, voice links and the lines they said.

Not yet: recognising a voice automatically in a new conversation. Speaker labels
reset each session, so that needs voice embeddings in the `voiceprints` table.

**Voice Garden (example project).** Open `/garden` from the same server. Everyone
in the Mind Palace is planted as a tree and kept in sync; what they say through the
glasses grows their tree and floats their words up from it; deleting someone in
Picavoice removes their tree. Camera and mic (AR mirror) need a secure page, so use
`http://localhost:3100/garden` in Chrome on the Mac; on the phone the 3D garden
still grows live. Based on [Voiceprint Garden AR](https://github.com/ibrahimakamran/Memory-Garden)
by Ibrahim Kamran; the Picavoice bridge is the marked block at the end of its script.
`GET /api/garden.json` is also importable into the hosted original.

API: `GET /api/people`, `GET /api/people/:id`, `POST /api/people`,
`DELETE /api/people/:id`, `POST /api/assign`, `GET /api/live`, `GET /api/garden.json`,
`GET /api/sessions`, `GET /api/sessions/:runId/utterances?after=N`.

## Verification checklist

1. `./run.sh` prints `[ingest] listening on http://0.0.0.0:3100/ingest` and `sidecar listening on :3001` (or the
   pair it chose; the two servers start as separate processes, so either line can come first), the QR and
   `Miniapp URL:`.
2. Phone and Mac are on the same Wi-Fi; the glasses show as connected in the Mentra App.
3. Scan the QR: the terminal shows `[ingest] run <id> started` and `hello run=<id> ...` (and, if the console
   bridge works on your phone, `SESSION STARTING` / `SESSION READY` lines tagged `[MentraJS]`).
4. Accept the phone's microphone (and location) prompts if it asks.
5. `cloud connected` appears (transcription defaults to the cloud).
6. Speak: `interim` lines stream, then one `FINAL` line per utterance, under both `[MentraJS]` and `[ingest]`.
   The `[ingest]` copy proves the phone → Mac uplink carries data.
7. `audio first chunk format=... sampleRate=...` on the phone side, `[ingest] audio format=... -> recordings/...`
   on the Mac side, then `audio N chunks/s` lines once per second while audio flows.
7b. With a Deepgram key: `deepgram connected`, then `[S0 ...]` lines with your words; a second person
   speaking gets a second label. `sqlite3 data/fieldassist.sqlite "select count(*) from utterances"` grows.
8. `speech started` / `speech stopped` lines bracket what you say.
9. Open the tile on the phone: it shows `Background: ready (user ...)` and the latest transcript.
10. Move around (or toggle location on the phone): `location lat=... lng=...` lines appear.
11. Ctrl+C. The run is finalized by the phone's `end` event or, at the latest, 30 s without posts
    (`no data for 30s`): `[ingest] ... run <id>: N chunks, N kB in N posts -> .../recordings/<file>.wav (Ns, N kB)`.
    Then `afinfo recordings/<file>.wav` (format, duration) and `afplay recordings/<file>.wav` (listen).
12. Disable FieldAssist in the Mentra App (or save a file under `src/background/`): expect
    `SESSION ENDED reason=...`; after a save the dev server prints `respawn-bg` and a fresh
    `[fieldassist <new id>] SESSION STARTING` follows. (See the note above: the end line may be skipped on a
    dev respawn.) Each uplink connection writes its own recording file, so a respawn or a reconnect starts a
    new file; a mid-stream format or sample-rate change starts a `-part2` file.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| QR scan does nothing / install fails | Phone cannot reach `http://<lan-ip>:3000` (different Wi-Fi, guest network with client isolation, VPN on the Mac, macOS firewall) | Same Wi-Fi; disconnect the VPN; System Settings → Network → Firewall: allow `bun`; re-scan after the CLI prints `LAN IP changed`; on Android use `./run.sh --usb` |
| `Port 3000 was unavailable; using 3002 instead.` | Another dev server holds 3000/3001 (for example a second miniapp project) | Fine: scan the new QR. Or stop the other `bun dev` |
| `miniapp.json validation failed:` | Bad permission / hardware type, or a missing required field | Fix the listed field (valid types are in https://docs.mentraglass.com/app-devs/reference/cli). A typo in `packageName` passes validation but creates a second dev entry on the phone |
| `SESSION READY` but no transcript lines | Phone denied the microphone prompt; `cloud disconnected` persists (transcription defaults to `preferCloud`); glasses not connected (`glasses disconnected`); or `MICROPHONE` removed from `miniapp.json` (`PERMISSION_NOT_DECLARED`) | Re-grant the mic in the phone's settings; get the phone online; connect the glasses in the Mentra App; keep `MICROPHONE` declared |
| Phone tile shows uplink `connecting`/`stalled` with a `fetch:` error, and no `[ingest] run ... started` | The ingest server is not running, or the phone cannot reach port 3100 on the Mac (firewall, different network), or the baked URL points at an old IP | `./run.sh` starts the server; open `http://<lan-ip>:3100/health` in the phone's browser; restart `run.sh` after changing networks (the URL is baked at build time) |
| No `[MentraJS]` lines in the terminal although the tile says dev install = yes | The CLI's console bridge is a WebSocket to port 3001, and WebSockets from this iPhone to this Mac fail (Safari fails too, close code 1006; the Mentra App reports "bad response from the server"). Plain HTTP works, which is why the ingest path uses POST | Use the `[ingest]` lines as the terminal view. Hot reload also depends on that WebSocket: rescan the QR after edits. The app only opens that bridge when the miniapp is spawned, so after a scan also disable and re-enable FieldAssist in the Mentra App; forwarded logs are throttled (100/min) and lines containing key/token/auth/secret are redacted |
| `no ingest URL baked in` | `bun dev` was started without `MENTRA_PUBLIC_INGEST_URL` | Use `./run.sh`, or export the variable before `bun dev` |
| Transcripts arrive but no `audio` lines | OS mic prompt denied (subscription "succeeds but no chunks arrive"); or the phone's voice-activity gate / loudness gate ("Barrier") is suppressing quiet audio | Re-grant the mic; speak; for continuous capture the SDK exposes `session.mic.setVoiceActivityDetectionEnabled(false)` and `setLoudnessGateEnabled(false)` (subject to the user's phone settings) |
| `audio format=...lc3` and a `.lc3` file | The phone's mic mode is LC3 | Decode with an LC3 decoder (liblc3); no live Deepgram transcription for LC3 runs. Where the mic mode is set is not documented |
| `[ingest] cannot write audio: ...` | `recordings/` not writable, disk full, or a bad `INGEST_DIR` | Fix the path/disk; transcripts keep flowing, audio for that connection is discarded until you restart |
| `afplay` sounds wrong (pitch/speed) | The phone did not report `sampleRate`; the server assumed 16000 | Read the `audio format=` line; change `DEFAULT_SAMPLE_RATE` in `server/ingest.ts` |
| `audio ... dropped=N` on the phone, `missing=N` on the Mac | The phone keeps at most 30 pending posts; older ones are dropped when the Mac is unreachable | Expected after a Wi-Fi blip; persistent drops mean the link is bad |
| `[ingest] run <id>: data arrived after the run was finalized; continuing as <id>-2` | The Mac saw no post for 30 s (phone asleep, Wi-Fi blip) and then data resumed | Normal; see "Runs and segments" above |
| Port 3100 in use | Another process on the Mac | `INGEST_PORT=3101 ./run.sh` (run.sh bakes the matching URL) |
| `deepgram socket error ... check DEEPGRAM_API_KEY` and `closed (code 1006); reconnecting in Ns` | Wrong or missing key, or a rejected query parameter (for example `diarize=true` together with `diarize_model`) | Fix the key in `.env` and restart `./run.sh` (the key is read at startup; the WAV keeps recording meanwhile); leave `DEEPGRAM_EXTRA_PARAMS` empty; `TRANSCRIBE=off` to record only |
| Transcripts arrive but every label is `S0` | Only one voice reached the microphone clearly, or far-field speech was gated out | Have the other person speak closer; rebuild with `MENTRA_PUBLIC_CONTINUOUS_AUDIO=1 ./run.sh` |
| `[S? ...]` labels | Deepgram returned words without a speaker field | Harmless; `diarize_model=latest` is sent by default, so check `DEEPGRAM_EXTRA_PARAMS` did not replace it |
| Labels restart at `S0` and times at 0 in the middle of a conversation | The run was finalized (30 s without any post, or an audio format change) and continued as `<runId>-2` | Normal; each segment has its own WAV and session row. With the heartbeat this only happens when the phone really went away |
| Transcripts show on the phone tile but not in the terminal | Sidecar (port 3001) unreachable | Check `sidecar listening`; firewall; same Wi-Fi |
| No `location` lines | `LOCATION` not declared or the OS location prompt was denied; or the phone has not moved | Check manifest and phone permission; walk around |
| Miniapp stops or the Mentra App reports a missing entry right after an edit | The rebuild failed (error printed above the `reload` / `respawn-bg` line). `build.ts` wipes `dist/` first, so a failed build ships an empty bundle | Fix the error and save again; the next rebuild reinstalls |
| Phone shows a stale name or icon | The home screen caches them per package | Rescan the QR |
| Two FieldAssist entries on the phone | `packageName` was changed; dev entries are keyed by it | Remove the old entry in the Mentra App |
| `--usb could not establish an ADB tunnel` | `adb` missing or USB debugging off (USB mode is Android only) | `brew install --cask android-platform-tools`, enable USB debugging. If the Mac has a LAN IP the CLI falls back to it (phone must share the Wi-Fi); with no LAN IP it exits. In USB mode `run.sh` bakes `http://127.0.0.1:3100` and keeps `adb reverse tcp:3100 tcp:3100` asserted itself (the CLI only reverses its own two ports); if adb sees no phone it falls back to the Wi-Fi address before building |

## picavoice: remembering people automatically

`XR-Voice-Profiles/picavoice.py` turns the anonymous Deepgram speakers (`S0`, `S1`, ...) into people that are
remembered across conversations, and keeps what it learns about them in the same `data/fieldassist.sqlite`.
Run it next to `./run.sh`:

```
cd XR-Voice-Profiles
pip install -r requirements.txt     # first time (Python 3.10-3.12 recommended for torch)
python picavoice.py watch           # Ctrl+C to stop
```

What it does every 5 s, for each speaker in each session:

1. **Voice**: builds an ECAPA voiceprint from up to 15 s of that speaker's audio (sliced from the session WAV)
   and compares it with every known person. A confident match (≥ 0.65 and ≥ 0.05 ahead of the runner-up) is
   that person; audio that matches ≥ 0.70 is folded into their profile (running mean). A clearly different
   voice (< 0.45, with ≥ 6 s of speech) becomes a new person named `Unknown voice #N`. Anything in between waits
   for more speech. Profiles enrolled with `voice_profiles.py meet` (profiles.json) are imported automatically.
2. **Facts**: reads what they said and keeps their name ("my name is Sam", or "nice to meet you, Sam" heard twice
   from the one other person in the conversation), work, role, study, hometown, where they live, why they are here,
   and how you met ("we met at the hackathon"). A placeholder person is renamed once their name is known.
3. **Encounters**: one row per person per conversation: when, where (nearest GPS fix the phone sent), seconds of
   speech, and a snippet of what they said.
4. **Reminders**: when someone you have met before is recognised, it prints who they are, how many times and when
   you met, what you know about them and your last conversation.

Commands: `people` (list), `show <id>`, `rename <id> "Name"`, `me <id>` (mark the wearer's own voice so it is
never logged as an encounter: do this once after your first session), `merge <dup> <into>`, `forget <id>`
(deletes their voiceprints, facts and encounters). `once` processes the database a single time.

Tables it adds: `encounters`, `person_facts`, `picavoice_progress`, plus columns on `people` (`embedding`,
`embedding_count`, `is_placeholder`, `is_me`, `first_met_at`, `last_seen_at`, `times_met`,
`consent_recorded_at`, `profile_uuid`). Each voice observation is also stored in `voiceprints`, and speaker →
person decisions go to `speaker_assignments` (method `picavoice-match` / `picavoice-new`).
Tests: `python -m unittest test_picavoice` (no torch or audio needed).

Voiceprints are biometric data. Automatically created profiles have no consent recorded
(`consent_recorded_at` is NULL). Check the law where you use this (Illinois BIPA requires written consent before
collecting voiceprints) and use `forget` for anyone who asks.

## Project layout

```
fieldassist/
├── miniapp.json              # identity, permissions (MICROPHONE, LOCATION), hardware (MICROPHONE), port 3000
├── build.ts                  # scaffolder's Bun.build script + the __INGEST_URL__ constant + the CLI's background runtime guard
├── run.sh                    # starts server/ingest.ts, bakes the ingest URL, then `bun dev` (extra args go to the CLI)
├── .env.example              # DEEPGRAM_API_KEY (+ model/language/extra params, TRANSCRIBE), FIELDASSIST_DB, ingest URL/port/dir, MENTRA_PUBLIC_CONTINUOUS_AUDIO
├── icon.png                  # generated 512x512 PNG (the scaffolder's placeholder was a corrupt file)
├── src/background/index.ts   # runs on the phone: logging, transcripts, location, raw audio uplink
├── src/shared/channels.ts    # typed background → UI messages
├── src/ui/                   # tiny status page shown when the tile is opened
├── server/ingest.ts          # runs on the Mac: HTTP receiver, prints transcripts/stats, writes recordings, drives the transcriber
├── server/deepgram.ts        # Deepgram live stream + diarization (segments per speaker)
├── server/store.ts           # SQLite: sessions, utterances, events (+ people/voiceprints/speaker_assignments tables)
├── server/people.ts          # Mind Palace: people, consent, speaker-label links, live speakers
├── server/app-routes.ts      # GET /app (Picavoice phone app) + /api/people, /api/assign, /api/live, /api/garden.json
├── server/garden.ts          # people as Voice Garden trees (/api/garden.json)
├── examples/voice-garden/    # Voice Garden example, served at /garden (based on Voiceprint Garden AR, Ibrahim Kamran)
├── server/app/               # the Picavoice app page and its photo
├── server/dashboard.ts       # GET /dashboard (live transcript) + /api/sessions
├── scripts/seed-demo.ts      # `bun run seed [--live] [--names]`: fake conversations for testing without glasses
├── scripts/replay-audio.ts   # `bun run replay <file>`: play a recording into the server as if from the phone
├── data/fieldassist.sqlite   # created on first run (git-ignored)
├── server/wav.ts             # 16-bit PCM WAV writer (header patched on every write)
└── server/*.test.ts          # `bun test` (WAV writer, Deepgram segment parser, store, dashboard, people + app routes)
```

Versions: `@mentra/miniapp` 3.4.0 (npm `latest`), `@mentra/miniapp-cli` 0.1.0-dev.2 (npm `dev` tag; it
is the CLI the docs describe: served manifest with bundle SHA-256, `--usb`, `keys`, `--sign`. The
scaffolder still pins the older 0.1.0-dev.0 and an obsolete 0.3.0-dev.0 SDK), `@types/bun` for the server.

## Raw audio facts (from `@mentra/miniapp@3.4.0` types and docs)

- `session.mic.onAudioChunk(handler: (data: AudioChunkData) => void): UnsubscribeFn` with
  `AudioChunkData { data: string /* base64 PCM or LC3 */; sampleRate?: number; format?: string }`.
  Docs: https://docs.mentraglass.com/app-devs/core-concepts/microphone/audio-chunks
- Sample rate, bit depth, channels and chunk cadence are **not documented** for the Miniapp SDK; the
  16 kHz / 16-bit / mono figure in the docs belongs to the separate Bluetooth SDK. Read them off the
  `audio format=` line.
- VAD: `session.mic.onVoiceActivity` (`{status, silentForMs?, timestamp?}`). Glasses-side knobs in the types:
  `setVoiceActivityDetectionEnabled(boolean)` (GX8002 VAD) and `setLoudnessGateEnabled(boolean)` (the
  center-mic loudness gate "Barrier", which the docs describe for Mentra Live).
- Diarization: `session.transcription.configure({diarization: true})` exists, but `TranscriptionData` has no
  speaker id in 3.4.0 (only `TranslationData.speakerId`). Speaker identification needs the raw audio plus
  your own model.
- Whether raw audio keeps flowing with the phone offline is undocumented (only transcription, translation
  and cloud TTS are listed as cloud-dependent).

## Next milestones — exact APIs

- **Audio / TTS out**: `session.speaker.speak(text, options?): Promise<SpeakResult>`,
  `session.speaker.play({audioUrl})`, `session.speaker.createStream(options?): Promise<SpeakerStreamWriter>`
  (16-bit LE mono PCM at 16000|24000|48000 Hz; requires `minHostVersion` ≥ `2.13.0`). Routing: "Playback
  follows the phone's media route, including connected Bluetooth audio glasses"; no API picks the speaker.
  Docs: https://docs.mentraglass.com/app-devs/core-concepts/speakers/text-to-speech
- **Photo**: `session.camera.takePhoto(options?): Promise<PhotoTaken>` → `{requestId, photoUrl, mimeType, size}`
  (`photoUrl` is a signed URL, ~30 min); `session.camera.warmUp()`. Needs the `CAMERA` permission and a
  `CAMERA` hardware requirement. To get the bytes here: `fetch(photoUrl)` in the background, then POST the
  `arrayBuffer()` to the ingest server. Docs: https://docs.mentraglass.com/app-devs/core-concepts/camera/photos

The full verified research report (TTS, photos, lifecycle, dev loop, troubleshooting facts, open questions)
is in `../notes/mentraos-research-report.md`.
