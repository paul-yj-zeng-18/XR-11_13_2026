# Architecture

## Modules

### `audio/`
- **micStream.js**: `getUserMedia` → `AnalyserNode` (FFT 2048, no smoothing). Exposes `read()` for spectrum + waveform.
- **mfcc.js**: 26-band mel filterbank (80–7600 Hz) → log → DCT-II → 13 MFCCs. Also spectral centroid and an autocorrelation pitch detector (decimated 2x for speed).
- **voiceprint.js**: `VoiceprintRecorder.capture(seconds)` collects features only from frames above an RMS threshold (crude VAD), then summarises to `{ mfccMean, mfccStd, pitch, pitchStd, centroid }`.
  `similarity(a, b) = 0.6 · cos(MFCC₁₋₁₂ mean ⊕ ½·std) + 0.4 · exp(-|ln(p₁/p₂)| / 0.18)`. c0 (loudness) is ignored.
  `blendVoiceprints` does a running average on confirmed matches.
- **speechTranscriber.js**: Web Speech API wrapper with auto-restart (Chrome ends sessions after silence).

### `profiles/`
- **profileStore.js**: localStorage-backed store. `create()` throws without consent. Facts are de-duplicated by type + normalised text.
- **consent.js**: classifies spoken replies ("I don't mind" → yes, "rather not" → no).
- **factExtractor.js**: regex patterns for name / work / study / place / likes / family / project, plus an extractive summariser for timeline cards.

### `scene/`
- **sceneSetup.js**: renderer with `xr.enabled`, a camera inside a **dolly** group (locomotion moves the dolly, so it works identically in desktop and XR), VR + AR buttons.
- **roomGenerator.js**: `deriveRoomStyle(voiceprint, overrides)` → deterministic style; `buildRoom(style)` → floor, walls (canvas wallpaper drawn from MFCC waves), ceiling ribbon (tube along an MFCC-shaped curve), lights, dust, exit door, name banner.
- **factObjects.js**: one distinct mesh per fact type + billboard label + selection ring. Transforms are serialised back to the store.
- **timelineWall.js**: conversation cards (canvas textures) on the back wall, oldest → newest, wrapping rows.
- **palace.js**: switches between the lobby (doors in an arc) and a room, keeps the `interactables` list for raycasting, AR fade, animations.
- **passthrough.js**: webcam → `VideoTexture` background + translucent walls.

### `controls/`
- **desktopControls.js**: WASD/drag "headset sim" with head-bob, crouch and bounds clamping.
- **manipulator.js**: mouse raycasting: select, drag on a floor-parallel plane, wheel height, key shortcuts.
- **xrControls.js**: controller rays, grab-by-attach, left-stick locomotion, right-stick snap turn around the head.

### `ui/`
- **encounterFlow.js**: the state machine (below).
- **hud.js / dom.js**: overlay rendering. All user text goes through `textContent`.

## Encounter state machine

```
          start()
 idle ───────────► identify ──(score ≥ threshold)──► recognized ──yes──► context
  ▲                    │                                 │no                │submit
  │                    └──(no match)──► consent ◄────────┘                  ▼
  │                                      │yes ───────────────────────► conversation
  │                                      │no                                │end()
  │                                      ▼                                  │
  └──────────────── cancel() ◄─────── ephemeral                             │
  └──────────────────────────────────────────────────────────────────────────┘
```

Speech heard during `identify` / `consent` is buffered in memory and only ingested after consent. On decline it's dropped.

## Ideas / next steps
- Swap the MFCC matcher for a real speaker-embedding model (e.g. ECAPA-TDNN via ONNX Runtime Web).
- LLM-based fact extraction and summaries (keep it opt-in, it sends transcripts off-device).
- Spatial anchors on Quest so a person's room appears where you actually met them.
- Hand-tracking pinch to grab objects.
