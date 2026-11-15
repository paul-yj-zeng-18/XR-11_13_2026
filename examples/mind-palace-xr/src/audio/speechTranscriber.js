/**
 * Wrapper around the Web Speech API (Chrome / Edge). Emits:
 *   'interim' -> { text }   partial hypothesis, changes as you talk
 *   'final'   -> { text }   committed chunk
 *   'error'   -> { error }
 * Chrome stops recognition after a pause, so we auto-restart while active.
 */
export class SpeechTranscriber extends EventTarget {
  static get supported() {
    return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  constructor(lang = 'en-US') {
    super();
    this.lang = lang;
    this.rec = null;
    this.wanted = false;
  }

  start() {
    if (!SpeechTranscriber.supported || this.wanted) return;
    this.wanted = true;
    this._spawn();
  }

  stop() {
    this.wanted = false;
    try {
      this.rec?.stop();
    } catch {
      /* already stopped */
    }
    this.rec = null;
  }

  _spawn() {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new Rec();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0].transcript.trim();
        if (!text) continue;
        if (res.isFinal) this._emit('final', { text });
        else interim += `${text} `;
      }
      this._emit('interim', { text: interim.trim() });
    };

    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.wanted = false;
      this._emit('error', { error: e.error });
    };

    rec.onend = () => {
      if (this.wanted && this.rec === rec) setTimeout(() => this.wanted && this._spawn(), 150);
    };

    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      this._emit('error', { error: err.message });
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
