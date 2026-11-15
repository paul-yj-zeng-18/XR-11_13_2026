import { describe, it, expect } from 'vitest';
import { similarity, findBestMatch, blendVoiceprints, summarizeFrames } from '../src/audio/voiceprint.js';
import { buildMelFilterbank, MfccExtractor } from '../src/audio/mfcc.js';

const vp = (shift, pitch) => ({
  mfccMean: Array.from({ length: 13 }, (_, i) => (i === 0 ? -30 : Math.sin(i + shift) * 10)),
  mfccStd: Array.from({ length: 13 }, () => 3),
  pitch,
  pitchStd: 20,
  centroid: 1500,
  samples: 1,
});

describe('voiceprint similarity', () => {
  it('scores identical prints as 1', () => {
    expect(similarity(vp(0, 120), vp(0, 120))).toBeCloseTo(1, 5);
  });

  it('scores different voices lower', () => {
    const same = similarity(vp(0, 120), vp(0.1, 125));
    const diff = similarity(vp(0, 120), vp(2.5, 220));
    expect(same).toBeGreaterThan(diff);
    expect(diff).toBeLessThan(0.6);
  });

  it('finds the closest profile', () => {
    const profiles = [
      { id: 'a', name: 'A', voiceprint: vp(0, 120) },
      { id: 'b', name: 'B', voiceprint: vp(2.5, 220) },
    ];
    expect(findBestMatch(profiles, vp(2.4, 215)).profile.id).toBe('b');
  });

  it('blends towards the new sample', () => {
    const blended = blendVoiceprints(vp(0, 100), vp(0, 200), 0.5);
    expect(blended.pitch).toBeCloseTo(150);
    expect(blended.samples).toBe(2);
  });
});

describe('mfcc', () => {
  it('builds a filterbank with the requested number of bands', () => {
    expect(buildMelFilterbank(1024, 48000, 26, 80, 7600)).toHaveLength(26);
  });

  it('produces finite coefficients and summarises frames', () => {
    const ex = new MfccExtractor(1024, 48000);
    const spectrum = new Float32Array(1024).map((_, i) => -40 - i * 0.05);
    const frame = Array.from(ex.compute(spectrum));
    expect(frame).toHaveLength(13);
    expect(frame.every(Number.isFinite)).toBe(true);
    const s = summarizeFrames([frame, frame], [120, 130], [1500]);
    expect(s.pitch).toBe(125);
  });
});
