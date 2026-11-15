// Tunables live here so we can tweak them during the demo without hunting
// through the codebase. Some of these are overridden by the Settings panel.

export const CONFIG = {
  audio: {
    fftSize: 2048,
    sampleIntervalMs: 20, // ~50 feature frames / second
    voiceRmsThreshold: 0.012, // below this we treat the frame as silence
    minPitchHz: 70,
    maxPitchHz: 400,
  },
  voiceprint: {
    captureSeconds: 5,
    minVoicedFrames: 40, // ~0.8s of actual speech
    numCoeffs: 13,
    melBands: 26,
    melLowHz: 80,
    melHighHz: 7600,
  },
  matching: {
    threshold: 0.8,
    adaptRate: 0.25, // how much a confirmed new sample updates the stored print
  },
  player: {
    eyeHeight: 1.6,
    walkSpeed: 2.2,
    sprintMultiplier: 2.0,
    lookSensitivity: 0.0028,
    turnSpeed: 1.8,
  },
  storageKey: 'mindpalace.v1',
  settingsKey: 'mindpalace.settings.v1',
};

export function loadSettings() {
  try {
    const raw = globalThis.localStorage?.getItem(CONFIG.settingsKey);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (typeof s.threshold === 'number') CONFIG.matching.threshold = s.threshold;
    if (typeof s.captureSeconds === 'number') CONFIG.voiceprint.captureSeconds = s.captureSeconds;
  } catch {
    /* ignore corrupt settings */
  }
}

export function saveSettings() {
  globalThis.localStorage?.setItem(
    CONFIG.settingsKey,
    JSON.stringify({
      threshold: CONFIG.matching.threshold,
      captureSeconds: CONFIG.voiceprint.captureSeconds,
    }),
  );
}
