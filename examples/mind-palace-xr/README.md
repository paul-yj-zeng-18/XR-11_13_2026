> **In the Picavoice repo:** this is the Mind Palace XR example. Served by the Picavoice
> server at `/palace/` (`bun run build:palace`), `src/picavoice/bridge.js` gives everyone
> from Picavoice a room and adds what they say through the glasses. Everything below is
> the original project's README.

# Mind Palace XR

**Every person you meet becomes a room.**
Mind Palace XR listens to someone's voice, recognises them next time you meet, and builds them a room in a WebXR memory palace. Facts they tell you float as objects in the room, past conversations line the back wall as a timeline, and the room's colours, size, wallpaper and ceiling ribbon are all generated from **their voiceprint**.

currently we did not have a quest headset, so it will run in browser and simulate using it in VR 
---

## Features

| | |
|---|---|
|  **Voice identification** | MFCC + pitch voiceprint captured in ~5s, matched against everyone you've met (cosine timbre + pitch similarity). Confirmed matches refine the stored print. |
|  **Profiles** | Created on first meeting, updated on every encounter. |
|  **Consent first** | New voices trigger a consent script. Answer out loud ("yes" / "no") or with buttons. Nothing about a new person is saved until they agree|
| **Live transcription → facts** | Web Speech API transcribes; a rule-based extractor pulls out name, work, studies, places, likes, family and projects, and they **pop into the room as 3D objects** while you talk. |
| **Timeline wall** | Each conversation (date, where, how you met, summary, keywords) becomes a card on the back wall. Click one to read the transcript. |
| **Voice-generated rooms** | Pitch → hue, pitch variation → saturation, spectral brightness → room size/height, MFCC curve → wallpaper waves + ceiling ribbon. Same voice, same room. |
| **Customise your palace** | Drag, raise, rotate, resize and recolour memory objects; tweak hue, size, brightness and wallpaper per room. Layout is saved. |
| **XR** | Enter VR / Enter AR (WebXR), controller grab, smooth locomotion, snap turn, in-headset status panel. Laptop passthrough uses the webcam as the "real world". |
| **Local-only** | Everything is stored in `localStorage`. No audio is ever recorded or stored, only numeric voice features. Export/import JSON, revoke and delete per person. |

## Quick start

```bash
git clone https://github.com/<you>/mind-palace-xr.git
cd mind-palace-xr
npm install
npm run dev
```

Open **http://localhost:5173** in **Chrome or Edge** (needed for live speech-to-text), allow the microphone, and you're in.


### Controls (laptop "headset sim")

| Action | Keys |
|---|---|
| Walk / strafe | `W A S D` (or `↑ ↓`) |
| Turn | `← →` or drag the mouse |
| Look up/down | drag the mouse |
| Sprint | `Shift` |
| Crouch / tiptoe | `Q` / `E` |
| Recenter view | `Space` |
| Select / move object | click / drag |
| Raise / lower | scroll wheel |
| Rotate / resize / recolour | `R` · `[` `]` · `C` |
| Delete fact | `Delete` |
| Help / hide panel | `H` / `P` |

Click a **door** in the lobby to enter that person's room, and the **↩ Lobby** door to leave.

### Headset-style testing on a laptop

1. Install the **Immersive Web Emulator** extension (Meta) for Chrome.
2. Open DevTools → **WebXR** tab, choose a Quest 3 device.
3. Click **Enter VR**. You can now move the virtual headset and controllers from DevTools (trigger to grab objects and click doors, sticks to walk and turn).

### On a real Quest

```bash
npm run dev:https
```

Open `https://<your-laptop-ip>:5173` in the Quest Browser (same Wi-Fi), accept the self-signed certificate warning, then **Enter VR** or **Enter AR** (Quest 3 passthrough).

## How it works

```
mic ──► AnalyserNode ──► MFCC + pitch + centroid (50 fps) ──► voiceprint
  │                                                         │
  │                                       findBestMatch() vs stored profiles
  │                                                         │
  └─► Web Speech API ──► transcript ──► factExtractor ──► ProfileStore (localStorage)
                                                            │
                         roomGenerator(voiceprint) ◄────────┘
                         factObjects / timelineWall ──► Three.js + WebXR
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for module details and [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) for a 3-minute pitch walkthrough.

## Project layout

```
src/
  main.js                 app wiring + render loop
  config.js               tunables (thresholds, speeds…)
  audio/                  mic, MFCC, voiceprint matching, speech-to-text
  profiles/               storage, consent, fact extraction, demo data
  scene/                  renderer/XR setup, palace (lobby+rooms), room generator, objects, timeline
  controls/               desktop headset-sim, mouse manipulation, XR controllers
  ui/                     HUD overlay + encounter state machine
tests/                    vitest unit tests (npm test)
```

## Tuning voice matching

Voice ID is lightweight (no ML model), so it's good enough for a demo but not for security. If it mis-identifies people:

- Watch the **"closest: … %"** scores shown after each capture.
- Adjust **Palace → Match threshold** (default 80%) until teammates separate cleanly.
- Use a longer **voiceprint length** (7–8s) in noisy halls, and have people speak 10–20 cm from the mic.
- Every confirmed "Yes, that's them" blends in a new sample, so recognition improves with use.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Live transcription needs Chrome" | Use Chrome/Edge. Firefox/Safari lack the Web Speech API, but you can still type notes. |
| "Didn't hear enough speech" | Speak continuously for the capture window, move closer, or lengthen it in Settings. |
| Mic/camera blocked | Click the lock icon in the address bar → allow. Must be `localhost` or HTTPS. |
| VR/AR "not supported" | Expected on a plain laptop. Use the emulator or a headset. |
| Start fresh | Palace → **Erase everything**. |

## Privacy

- Consent is requested and logged (time + method) before any profile is created.
- Raw audio never leaves the Web Audio graph. A voiceprint is about 30 numbers and can't be turned back into speech.
- Speech transcription uses the browser's Web Speech API (in Chrome this is processed by Google's speech service).
- **Revoke consent & delete** removes a person's room, voiceprint, facts and transcripts.

## License

MIT
