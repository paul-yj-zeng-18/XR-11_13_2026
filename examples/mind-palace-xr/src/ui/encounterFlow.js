import { CONFIG } from '../config.js';
import { VoiceprintRecorder, findBestMatch, blendVoiceprints } from '../audio/voiceprint.js';
import { SpeechTranscriber } from '../audio/speechTranscriber.js';
import { extractFacts, extractName, summarizeConversation } from '../profiles/factExtractor.js';
import { classifyConsent } from '../profiles/consent.js';
import { uid } from '../profiles/profileStore.js';

/**
 * The core loop of the app:
 *
 *   idle -> identify -> recognized? --yes--> context -> conversation -> idle
 *                    \-> consent --yes-> context ...
 *                               \--no--> ephemeral (nothing saved)
 *
 * Privacy rules enforced here:
 *  - A new person's voiceprint stays in memory until they consent.
 *  - Speech heard before consent is buffered in memory and only turned into
 *    facts once consent is given; it's discarded on decline.
 */
export class EncounterFlow {
  constructor({ mic, transcriber, store, palace, hud, onProfileActive }) {
    Object.assign(this, { mic, transcriber, store, palace, hud, onProfileActive });
    this.recorder = new VoiceprintRecorder(mic);
    this.state = 'idle';
    this._reset();

    transcriber.addEventListener('final', (e) => this._onFinal(e.detail.text));
    transcriber.addEventListener('interim', (e) => {
      if (this.state !== 'idle') hud.setTranscript(this.tail, e.detail.text);
    });
    transcriber.addEventListener('error', (e) => hud.toast(`Speech recognition: ${e.detail.error}`, 'warn'));
  }

  _reset() {
    this.pendingVp = null;
    this.match = null;
    this.profile = null;
    this.convo = null;
    this.preConsentText = '';
    this.tail = '';
  }

  get busy() {
    return this.state !== 'idle';
  }

  _set(state, status, tone) {
    this.state = state;
    this.hud.showStep(state);
    if (status) this.hud.setStatus(status, tone);
  }

  async start() {
    if (this.busy) return;
    this._reset();
    try {
      await this.mic.start();
    } catch (err) {
      this.hud.toast('Microphone permission was denied. Allow it in the address bar and try again.', 'error');
      return;
    }
    this.hud.setTab('encounter');
    this.hud.clearLiveFacts();
    this.hud.levels = [];
    if (SpeechTranscriber.supported) this.transcriber.start();
    this._set('identify', 'Listening for a voiceprint…', 'live');

    const vp = await this.recorder.capture(CONFIG.voiceprint.captureSeconds, (p, level) => {
      this.hud.progress(p);
      this.hud.drawMeter(level);
    });
    if (this.state !== 'identify') return; // cancelled meanwhile
    if (!vp) {
      this.hud.toast("Didn't hear enough speech. Get a little closer to the mic and try again.", 'warn');
      this.cancel();
      return;
    }

    this.pendingVp = vp;
    this.match = findBestMatch(this.store.all(), vp);
    const m = this.match;
    if (m && m.score >= CONFIG.matching.threshold) {
      this.hud.showMatch(m.profile.name, m.score, m.ranking);
      this.palace.enterRoom(m.profile); // preview their room right away
      this.onProfileActive?.(m.profile);
      this._set('recognized', `Recognised ${m.profile.name}?`, 'ok');
    } else {
      this.hud.showMatchDebug(m?.ranking ?? []);
      this._set('consent', 'New voice — ask for consent first', 'warn');
    }
  }

  confirmMatch(isMatch) {
    if (this.state !== 'recognized') return;
    if (isMatch) {
      const p = this.match.profile;
      this.store.updateVoiceprint(p.id, blendVoiceprints(p.voiceprint, this.pendingVp));
      this.profile = this.store.get(p.id);
      this.pendingVp = null;
      this._goContext();
    } else {
      this.palace.showLobby(this.store.all());
      this.onProfileActive?.(null);
      this._set('consent', 'New voice — ask for consent first', 'warn');
    }
  }

  giveConsent(method = 'button') {
    if (this.state !== 'consent') return;
    const name = extractName(this.preConsentText) || `Guest ${this.store.all().length + 1}`;
    this.profile = this.store.create({
      name,
      voiceprint: this.pendingVp,
      consent: { given: true, at: new Date().toISOString(), method },
    });
    this.pendingVp = null;
    this.palace.enterRoom(this.profile);
    this.onProfileActive?.(this.profile);
    this.hud.toast(`Consent recorded (${method}). Room created for ${name}.`, 'ok');
    this._goContext();
  }

  declineConsent() {
    if (this.state !== 'consent') return;
    this.pendingVp = null;
    this.preConsentText = '';
    this._set('ephemeral', 'Ephemeral mode — nothing is being saved', 'warn');
  }

  _goContext() {
    const last = this.profile.conversations.at(-1);
    this.hud.fillContext({
      name: this.profile.name.startsWith('Guest ') ? '' : this.profile.name,
      where: last?.where ?? '',
      howMet: last ? 'Follow-up chat' : '',
    });
    this._set('context', `Where & how did you meet ${this.profile.name}?`);
  }

  submitContext({ name, where, howMet }) {
    if (this.state !== 'context') return;
    const id = this.profile.id;
    if (name && name !== this.profile.name) {
      this.store.update(id, { name });
      this.profile = this.store.get(id);
      this.palace.refreshRoom(this.profile);
    }
    this.convo = { id: uid('c'), date: new Date().toISOString(), where, howMet, transcript: '' };
    this._set('conversation', `Taking notes with ${this.profile.name}`, 'live');
    if (this.preConsentText.trim()) {
      this._ingest(this.preConsentText);
      this.preConsentText = '';
    }
  }

  addTypedNote(text) {
    if (this.state === 'conversation' && text.trim()) this._ingest(text);
  }

  _onFinal(text) {
    this.tail = `${this.tail} ${text}`.trim().slice(-240);
    if (this.state !== 'idle') this.hud.setTranscript(this.tail, '');

    switch (this.state) {
      case 'identify':
      case 'recognized':
      case 'context':
        this.preConsentText += ` ${text}.`;
        break;
      case 'consent': {
        const answer = classifyConsent(text);
        if (answer === 'yes') this.giveConsent('verbal');
        else if (answer === 'no') this.declineConsent();
        else this.preConsentText += ` ${text}.`;
        break;
      }
      case 'conversation':
        this._ingest(text);
        break;
      default:
        break; // ephemeral / idle: shown live, never stored
    }
  }

  _ingest(text) {
    const chunk = text.trim();
    const punctuated = /[.!?]$/.test(chunk) ? chunk : `${chunk}.`;
    this.convo.transcript = `${this.convo.transcript} ${punctuated}`.trim();
    const id = this.profile.id;

    for (const f of extractFacts(chunk)) {
      if (f.type === 'name' && /^Guest \d+$/.test(this.store.get(id).name)) {
        this.store.update(id, { name: f.text });
        this.palace.refreshRoom(this.store.get(id));
      }
      const saved = this.store.addFact(id, { ...f, source: 'speech', convoId: this.convo.id });
      if (saved) {
        this.palace.addFact(saved, { animate: true, profileId: id });
        this.hud.addLiveFact(saved);
      }
    }
    this.profile = this.store.get(id);
  }

  end() {
    if (this.state === 'conversation' && this.convo) {
      const { summary, keywords } = summarizeConversation(this.convo.transcript);
      this.store.addConversation(this.profile.id, { ...this.convo, summary, keywords });
      this.profile = this.store.get(this.profile.id);
      this.palace.refreshTimeline(this.profile);
      this.hud.toast('Conversation pinned to the timeline wall.', 'ok');
    }
    this.cancel();
  }

  cancel() {
    this.transcriber.stop();
    this.recorder.abort();
    this.mic.stop();
    this.state = 'idle';
    this.hud.showStep('idle');
    this.hud.setStatus(this.palace.profile ? `In ${this.palace.profile.name}'s room` : 'Lobby');
    this.hud.setTranscript('', '');
    this._reset();
  }
}
