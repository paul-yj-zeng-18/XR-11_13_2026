import { CONFIG } from '../config.js';

/**
 * Thin wrapper around getUserMedia + an AnalyserNode.
 * We only ever read features from the analyser - raw audio is never stored.
 */
export class MicStream {
  constructor() {
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.freqBuf = null;
    this.timeBuf = null;
  }

  get active() {
    return !!this.stream;
  }

  get sampleRate() {
    return this.ctx?.sampleRate ?? 48000;
  }

  async start() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        // gain only shifts MFCC c0, which we ignore for matching, so AGC is fine
        autoGainControl: true,
      },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = CONFIG.audio.fftSize;
    this.analyser.smoothingTimeConstant = 0;
    source.connect(this.analyser);

    this.freqBuf = new Float32Array(this.analyser.frequencyBinCount);
    this.timeBuf = new Float32Array(this.analyser.fftSize);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
  }

  /** Snapshot of the current spectrum (dB) and waveform. */
  read() {
    if (!this.analyser) return null;
    this.analyser.getFloatFrequencyData(this.freqBuf);
    this.analyser.getFloatTimeDomainData(this.timeBuf);
    return { freq: this.freqBuf, time: this.timeBuf, sampleRate: this.sampleRate };
  }
}

export function rms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}
