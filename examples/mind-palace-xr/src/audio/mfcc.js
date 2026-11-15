// Minimal MFCC + pitch feature extraction. No deps, runs on the AnalyserNode's
// spectrum so we don't need to do our own FFT.

const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
const melToHz = (mel) => 700 * (10 ** (mel / 2595) - 1);

export function buildMelFilterbank(nBins, sampleRate, nBands, lowHz, highHz) {
  const fftSize = nBins * 2;
  const lowMel = hzToMel(lowHz);
  const highMel = hzToMel(Math.min(highHz, sampleRate / 2));
  const bins = [];
  for (let i = 0; i < nBands + 2; i++) {
    const hz = melToHz(lowMel + ((highMel - lowMel) * i) / (nBands + 1));
    bins.push(Math.min(nBins - 1, Math.floor(((fftSize + 1) * hz) / sampleRate)));
  }

  // store sparse filters: { start, weights } - much cheaper per frame
  const filters = [];
  for (let b = 0; b < nBands; b++) {
    const l = bins[b];
    const c = Math.max(bins[b + 1], l + 1);
    const r = Math.max(bins[b + 2], c + 1);
    const weights = new Float32Array(r - l);
    for (let k = l; k < r; k++) {
      weights[k - l] = k < c ? (k - l) / (c - l) : (r - k) / (r - c);
    }
    filters.push({ start: l, weights });
  }
  return filters;
}

export function dct(input, nCoeffs) {
  const N = input.length;
  const out = new Float32Array(nCoeffs);
  for (let k = 0; k < nCoeffs; k++) {
    let s = 0;
    for (let n = 0; n < N; n++) s += input[n] * Math.cos((Math.PI * k * (n + 0.5)) / N);
    out[k] = s;
  }
  return out;
}

export class MfccExtractor {
  constructor(nBins, sampleRate, { numCoeffs = 13, melBands = 26, melLowHz = 80, melHighHz = 7600 } = {}) {
    this.nBins = nBins;
    this.numCoeffs = numCoeffs;
    this.filters = buildMelFilterbank(nBins, sampleRate, melBands, melLowHz, melHighHz);
    this.energies = new Float32Array(melBands);
  }

  /** @param {Float32Array} freqDb spectrum in dB from AnalyserNode */
  compute(freqDb) {
    for (let b = 0; b < this.filters.length; b++) {
      const { start, weights } = this.filters[b];
      let sum = 0;
      for (let i = 0; i < weights.length; i++) {
        const db = freqDb[start + i];
        if (db > -160) sum += weights[i] * 10 ** (db / 10);
      }
      this.energies[b] = Math.log(sum + 1e-10);
    }
    return dct(this.energies, this.numCoeffs);
  }
}

export function spectralCentroid(freqDb, sampleRate) {
  const binHz = sampleRate / 2 / freqDb.length;
  let num = 0;
  let den = 0;
  for (let k = 1; k < freqDb.length; k++) {
    const mag = 10 ** (freqDb[k] / 20);
    num += k * binHz * mag;
    den += mag;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Autocorrelation pitch detector on a 2x decimated buffer (fast enough to run
 * every few frames). Returns 0 when there's no clear periodicity.
 */
export function detectPitch(buf, sampleRate, minHz = 70, maxHz = 400) {
  const half = Math.floor(buf.length / 2);
  const x = new Float32Array(half);
  for (let i = 0; i < half; i++) x[i] = (buf[2 * i] + buf[2 * i + 1]) * 0.5;
  const sr = sampleRate / 2;

  let energy = 0;
  for (let i = 0; i < half; i++) energy += x[i] * x[i];
  if (energy < 1e-4) return 0;

  const minLag = Math.floor(sr / maxHz);
  const maxLag = Math.min(half - 1, Math.floor(sr / minHz));
  let best = 0;
  let bestLag = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < half - lag; i++) s += x[i] * x[i + lag];
    const norm = s / energy;
    if (norm > best) {
      best = norm;
      bestLag = lag;
    }
  }
  return best > 0.35 && bestLag > 0 ? sr / bestLag : 0;
}
