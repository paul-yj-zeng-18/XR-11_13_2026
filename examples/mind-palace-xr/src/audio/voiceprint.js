import { CONFIG } from '../config.js';
import { MfccExtractor, spectralCentroid, detectPitch } from './mfcc.js';
import { rms } from './micStream.js';

/**
 * A "voiceprint" here is a compact numeric summary of how someone sounds:
 * mean/std of MFCCs (timbre / vocal tract shape), median pitch and spectral
 * centroid (brightness). It is NOT audio and can't be played back.
 */

const mean = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const std = (arr) => {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((v) => (v - m) ** 2)));
};

export function summarizeFrames(frames, pitches = [], centroids = []) {
  if (!frames.length) return null;
  const n = frames[0].length;
  const mfccMean = new Array(n).fill(0);
  const mfccStd = new Array(n).fill(0);
  for (const f of frames) for (let k = 0; k < n; k++) mfccMean[k] += f[k] / frames.length;
  for (const f of frames) for (let k = 0; k < n; k++) mfccStd[k] += (f[k] - mfccMean[k]) ** 2 / frames.length;
  for (let k = 0; k < n; k++) mfccStd[k] = Math.sqrt(mfccStd[k]);

  return {
    version: 1,
    mfccMean,
    mfccStd,
    pitch: median(pitches),
    pitchStd: pitches.length > 2 ? std(pitches) : 0,
    centroid: median(centroids),
    frames: frames.length,
    samples: 1,
  };
}

function featureVector(vp) {
  // skip c0 (loudness); include a bit of the std so speaking style counts too
  const v = [];
  for (let k = 1; k < vp.mfccMean.length; k++) v.push(vp.mfccMean[k]);
  for (let k = 1; k < vp.mfccStd.length; k++) v.push(vp.mfccStd[k] * 0.5);
  return v;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** 0..1 similarity score between two voiceprints. */
export function similarity(a, b) {
  if (!a?.mfccMean || !b?.mfccMean) return 0;
  const timbre = Math.max(0, cosine(featureVector(a), featureVector(b)));
  let pitchSim = 0.5; // unknown pitch -> neutral
  if (a.pitch > 0 && b.pitch > 0) {
    pitchSim = Math.exp(-Math.abs(Math.log(a.pitch / b.pitch)) / 0.18);
  }
  return 0.6 * timbre + 0.4 * pitchSim;
}

export function findBestMatch(profiles, vp) {
  let best = null;
  const ranking = [];
  for (const p of profiles) {
    if (!p.voiceprint) continue;
    const score = similarity(p.voiceprint, vp);
    ranking.push({ profile: p, score });
    if (!best || score > best.score) best = { profile: p, score };
  }
  ranking.sort((x, y) => y.score - x.score);
  return best ? { ...best, ranking } : null;
}

/** Running average so the stored print gets better every time we confirm a match. */
export function blendVoiceprints(stored, fresh, minRate = CONFIG.matching.adaptRate) {
  if (!stored) return fresh;
  const r = Math.max(minRate, 1 / ((stored.samples || 1) + 1));
  const lerpArr = (a, b) => a.map((v, i) => v * (1 - r) + (b[i] ?? v) * r);
  const lerp = (a, b) => (a && b ? a * (1 - r) + b * r : a || b);
  return {
    ...stored,
    mfccMean: lerpArr(stored.mfccMean, fresh.mfccMean),
    mfccStd: lerpArr(stored.mfccStd, fresh.mfccStd),
    pitch: lerp(stored.pitch, fresh.pitch),
    pitchStd: lerp(stored.pitchStd, fresh.pitchStd),
    centroid: lerp(stored.centroid, fresh.centroid),
    frames: (stored.frames || 0) + (fresh.frames || 0),
    samples: (stored.samples || 1) + 1,
  };
}

/** Records N seconds of features from a running MicStream. */
export class VoiceprintRecorder {
  constructor(mic) {
    this.mic = mic;
    this._timer = null;
    this._resolve = null;
  }

  capture(seconds, onProgress) {
    this.abort();
    const { mic } = this;
    const cfg = CONFIG.voiceprint;
    const extractor = new MfccExtractor(mic.analyser.frequencyBinCount, mic.sampleRate, cfg);
    const frames = [];
    const pitches = [];
    const centroids = [];
    const start = performance.now();
    let tick = 0;

    return new Promise((resolve) => {
      this._resolve = resolve;
      this._timer = setInterval(() => {
        const snap = mic.read();
        if (!snap) return this._finish(null);
        const level = rms(snap.time);
        if (level > CONFIG.audio.voiceRmsThreshold) {
          frames.push(Array.from(extractor.compute(snap.freq)));
          centroids.push(spectralCentroid(snap.freq, snap.sampleRate));
          if (tick % 3 === 0) {
            const p = detectPitch(snap.time, snap.sampleRate, CONFIG.audio.minPitchHz, CONFIG.audio.maxPitchHz);
            if (p) pitches.push(p);
          }
        }
        tick++;
        const progress = Math.min(1, (performance.now() - start) / (seconds * 1000));
        onProgress?.(progress, level, frames.length);
        if (progress >= 1) {
          this._finish(frames.length >= cfg.minVoicedFrames ? summarizeFrames(frames, pitches, centroids) : null);
        }
      }, CONFIG.audio.sampleIntervalMs);
    });
  }

  _finish(result) {
    clearInterval(this._timer);
    this._timer = null;
    const r = this._resolve;
    this._resolve = null;
    r?.(result);
  }

  abort() {
    if (this._timer) this._finish(null);
  }
}
